"""The Agent abstraction — deployer-owned, mutable, secret.

In the nested model, the **Agent** is the inner object the NemoClaw Shell wraps.
Unlike the measured Shell (open-source, attested, on-chain-bound), the Agent is:

  * **deployer-owned** — the vault builder writes/owns it,
  * **secret** — its mandate prompt, models, MCP servers and data sources are
    NOT part of the attested-and-published surface,
  * **mutable** — skills can be hot-swapped at runtime (Hermes-style updates).

The crucial constraint that makes this safe: the Agent only ever *proposes*
intents (``propose(state) -> list[Order]``). It has no handle to the exchange,
no vault key, and no network egress of its own. Every order it proposes flows
through the Shell's policy engine + sole Lighter gateway, and every skill it
loads must be hash-registered on-chain in the ``SkillRegistry`` (verified by
``shell.skill_loader``, fail-closed) before the Shell will run it.

So: the Agent's mutability never escapes the Shell's enforcement.

------------------------------------------------------------------------------
Where the LLM / Hermes-style pieces plug in
------------------------------------------------------------------------------
``ReferenceAgent`` below is deterministic (it wraps the funding-carry logic) to
show the *shape* without requiring a model. A real, LLM-driven agent subclasses
``Agent`` and, inside ``propose()`` (or inside individual ``Skill`` callables):

  * **models**       — call into your inference provider (Anthropic Claude,
                       etc.) to turn ``MarketState`` + the ``mandate`` prompt
                       into reasoning. Bind the model handle in ``on_start()``.
  * **MCP servers**  — attach MCP tool servers (research/data tools) the model
                       may call; hold their sessions on the Agent instance.
  * **data sources** — research/analysis skills fetch from your data providers.

NOTE on the sandbox: ``nemoclaw.policy.yaml`` currently sets
``inference.enabled: false`` and a deny-all egress allowlist (Lighter + RPC
only). An LLM-driven agent requires that policy to additionally allowlist the
model/MCP/data hosts (or use NemoClaw managed inference). That is a *deploy-time
policy change for the vault*, deliberately out of scope here — the Shell code is
model-agnostic and does not assume any egress beyond what the SDK already uses.

------------------------------------------------------------------------------
Skill hashing & the on-chain registry
------------------------------------------------------------------------------
Each ``Skill`` has a canonical ``source``/spec string and a ``.hash`` =
``"0x" + sha256(canonical-spec)`` rendered as a 32-byte (bytes32) hex string.
That hash is exactly what the builder registers on-chain via
``SkillRegistry.allowSkill(vault, skillHash, uri)``. When the Agent hot-swaps a
skill at runtime, the *new* skill's hash must already be registered, or the
Shell's loader refuses to load it (fail-closed). This is the "every skill it
loads is hash-checked against the on-chain SkillRegistry" guarantee.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from decimal import Decimal
from itertools import combinations
from typing import Callable, Iterable, Literal

from eigenstrategies_sdk import MarketState, Order


log = logging.getLogger("shell.agent")

# The four skill kinds the product diagram names. A typical agent composes one
# of each into a pipeline: research -> analysis -> sizing -> exec.
SkillKind = Literal["research", "analysis", "sizing", "exec"]


@dataclass(frozen=True)
class Skill:
    """A single, individually hash-registered unit of agent capability.

    ``call`` is the runnable behavior. ``source`` is the *canonical spec string*
    that uniquely and reproducibly identifies this skill's logic/version — it is
    what gets hashed and registered on-chain. Two deployments that ship the same
    ``source`` produce the same ``.hash`` and so resolve to the same on-chain
    registration; change the logic, bump ``version`` / change ``source``, and
    the hash changes (and must be re-registered before the Shell will load it).

    The callable signature is intentionally permissive so the same dataclass can
    carry research/analysis/sizing/exec skills. ``exec`` skills take a
    ``MarketState`` and yield ``Order`` intents; other kinds may transform an
    intermediate context. The Shell only *runs* the exec pipeline via
    ``Agent.propose``; non-exec skills are composed by the Agent itself.
    """

    name: str
    version: str
    kind: SkillKind
    call: Callable[..., object]
    source: str  # canonical spec string — the pre-image of the on-chain hash

    @property
    def canonical_spec(self) -> str:
        """The exact bytes hashed for on-chain registration.

        Includes name/version/kind so two skills that happen to share a body but
        differ in identity/role get distinct hashes. Stable ordering, no
        whitespace ambiguity — this string is the registry pre-image and must be
        reproducible across builders.
        """
        return f"skill:v1\nname={self.name}\nversion={self.version}\nkind={self.kind}\nsource={self.source}"

    @property
    def hash(self) -> str:
        """``0x``-prefixed sha256 of the canonical spec, as a bytes32 hex.

        sha256 is 32 bytes, which is exactly ``bytes32`` on-chain. This is the
        value passed to ``SkillRegistry.allowSkill`` / ``isAllowedSkill``.
        """
        digest = hashlib.sha256(self.canonical_spec.encode("utf-8")).hexdigest()
        return "0x" + digest

    @property
    def hash_bytes(self) -> bytes:
        """Raw 32-byte digest, for web3 ``bytes32`` arguments."""
        return hashlib.sha256(self.canonical_spec.encode("utf-8")).digest()

    def __str__(self) -> str:  # pragma: no cover - logging convenience
        return f"{self.name}@{self.version}[{self.kind}] {self.hash}"


class Agent:
    """Base class for the inner, mutable, secret agent.

    Subclass this. Set a thematic ``mandate`` and a list of ``skills`` (each
    pre-registered on-chain), and implement ``propose``. The Shell will:

      * hash every skill and verify it against the on-chain ``SkillRegistry``
        (fail-closed) before running anything (``skill_loader``),
      * call ``on_start`` once,
      * each tick call ``propose(state)`` and route the returned *intents*
        through the policy engine + sole Lighter gateway,
      * never give this object a handle to the exchange or the vault key.

    Mutability / hot-swap: replace entries in ``self.skills`` at runtime (e.g.
    from a Hermes-style update channel). Call ``register_skill`` to add one; the
    Shell re-verifies hashes against the registry on its next load/verify pass,
    so an unregistered swapped-in skill is refused rather than silently run.
    """

    #: Thematic mandate prompt. For an LLM agent this is the system/strategy
    #: prompt; for a deterministic agent it is documentation. SECRET — not part
    #: of the attested surface.
    mandate: str = ""

    def __init__(self, mandate: str | None = None, skills: list[Skill] | None = None):
        if mandate is not None:
            self.mandate = mandate
        self.skills: list[Skill] = list(skills) if skills else []
        # Cadence the Shell loop uses; mirrors Strategy.tick_seconds semantics.
        self.tick_seconds: int = 30

    # ---- skill management (mutable surface) ----------------------------------
    def register_skill(self, skill: Skill) -> None:
        """Add or hot-swap a skill (replacing any same-name skill).

        The new skill's ``.hash`` must already be registered on-chain by the
        builder; the Shell's loader is what enforces that on the next pass. This
        method does not itself touch the chain — the Agent is keyless.
        """
        self.skills = [s for s in self.skills if s.name != skill.name] + [skill]
        log.info("agent registered/swapped skill %s", skill)

    def skill(self, name: str) -> Skill | None:
        return next((s for s in self.skills if s.name == name), None)

    def exec_skills(self) -> list[Skill]:
        return [s for s in self.skills if s.kind == "exec"]

    # ---- lifecycle -----------------------------------------------------------
    def name(self) -> str:
        return self.__class__.__name__

    def on_start(self) -> None:
        """Called once before the first tick.

        For an LLM agent, bind model clients / open MCP sessions / warm data
        sources here.
        """

    def on_fill(self, order: Order, fill_price: Decimal, fill_size: Decimal) -> None:
        """Optional bookkeeping after a fill the Shell executed."""

    def on_error(self, exc: BaseException) -> None:
        """Called if a tick raises inside the Shell loop. Default: swallow.

        The Shell keeps looping; override to re-raise or to record.
        """
        log.error("agent tick error: %r", exc)

    # ---- the core contract: propose intents, never submit --------------------
    def propose(self, state: MarketState) -> list[Order]:
        """Return the order *intents* for this tick. MUST NOT submit.

        Default implementation runs the agent's ``exec`` skills in order and
        concatenates the orders they yield. An LLM agent typically overrides
        this to run research -> analysis -> sizing first, then call an exec
        skill — but it still only returns intents.
        """
        out: list[Order] = []
        for skill in self.exec_skills():
            result = skill.call(state)
            if result is not None:
                out.extend(result)
        return out


# ---------------------------------------------------------------------------
# Reference agent — deterministic, to show the shape end to end.
# ---------------------------------------------------------------------------
# These constants mirror agents/funding-carry/strategy.py exactly so the exec
# skill below is the same attested logic, now expressed as a registered Skill.
_MARKETS = ["BTC-PERP", "ETH-PERP", "SOL-PERP"]
_ENTRY_SPREAD_BPS = Decimal("12")
_EXIT_SPREAD_BPS = Decimal("4")
_MAX_NOTIONAL_PER_PAIR = Decimal("5000")
_MIN_FREE_COLLATERAL = Decimal("500")
_LEVERAGE = Decimal("1")

# Canonical spec for the exec skill. Bump this string (and re-register on-chain)
# whenever the decide logic changes. Kept verbose + stable on purpose: it is the
# on-chain hash pre-image.
_FUNDING_CARRY_EXEC_SPEC = (
    "funding-carry-exec; markets=BTC-PERP,ETH-PERP,SOL-PERP; "
    "entry_spread_bps=12; exit_spread_bps=4; max_notional_per_pair=5000; "
    "min_free_collateral=500; leverage=1; "
    "logic=pick max |Δfunding| pair, open delta-neutral long/short if spread>=entry, "
    "flatten reduce-only if paired and spread<=exit"
)


def _funding_carry_decide(state: MarketState) -> Iterable[Order]:
    """The reference funding-carry decide() logic, verbatim in behavior.

    This is the exec skill body. It is identical in semantics to
    ``agents/funding-carry/strategy.py``'s ``FundingCarry.decide`` and the
    ``funding_carry.py`` runtime shim — wrapped here as a hash-registered skill.
    """
    funding = {m: state.funding_rates.get(m, Decimal(0)) for m in _MARKETS if m in state.mid_prices}
    if len(funding) < 2 or state.free_collateral < _MIN_FREE_COLLATERAL:
        return

    best_pair, best_spread = None, Decimal(0)
    for a, b in combinations(funding, 2):
        spread = funding[a] - funding[b]
        if abs(spread) > abs(best_spread):
            best_pair, best_spread = (a, b), spread

    if best_pair is None:
        return

    a, b = best_pair
    spread_bps = abs(best_spread) * Decimal(10_000)
    long_market, short_market = (b, a) if best_spread > 0 else (a, b)

    already_paired = long_market in state.positions and short_market in state.positions
    if already_paired:
        if spread_bps <= _EXIT_SPREAD_BPS:
            log.info("closing pair %s/%s (spread %.1f bps)", long_market, short_market, spread_bps)
            for m in (long_market, short_market):
                pos = state.positions.get(m)
                if not pos:
                    continue
                yield Order(
                    market=m,
                    side="short" if pos.side == "long" else "long",
                    size=pos.size,
                    reduce_only=True,
                )
        return

    if spread_bps < _ENTRY_SPREAD_BPS:
        return

    notional = min(_MAX_NOTIONAL_PER_PAIR, state.free_collateral * _LEVERAGE / 2)
    long_size = (notional / state.mid_prices[long_market]).quantize(Decimal("0.0001"))
    short_size = (notional / state.mid_prices[short_market]).quantize(Decimal("0.0001"))

    if long_size <= 0 or short_size <= 0:
        return

    log.info(
        "opening pair long=%s short=%s spread=%.1f bps notional=%s",
        long_market, short_market, spread_bps, notional,
    )
    yield Order(market=long_market, side="long", size=long_size, client_id=f"carry-l-{state.timestamp}")
    yield Order(market=short_market, side="short", size=short_size, client_id=f"carry-s-{state.timestamp}")


# Stub non-exec skills, to show the research -> analysis -> sizing -> exec shape.
# They are pass-through/no-op here but are still real, hash-registered Skills:
# the builder must register all four hashes on-chain for the ReferenceAgent to
# load (fail-closed). A real agent fills these in with model/MCP/data calls.
def _research_stub(state: MarketState) -> dict:
    """Gather signals. Stub: surfaces the funding rates already in state."""
    return {"funding_rates": dict(state.funding_rates)}


def _analysis_stub(context: dict) -> dict:
    """Turn signals into a view. Stub: identity pass-through."""
    return context


def _sizing_stub(context: dict) -> dict:
    """Position sizing. Stub: defers to the exec skill's own sizing."""
    return context


class ReferenceAgent(Agent):
    """A complete, deterministic reference agent.

    Thematic mandate + a full research/analysis/sizing/exec skill set. The exec
    skill wraps the funding-carry ``decide()`` logic; the other three are stubs
    that show where research/analysis/sizing plug in. All four skills carry
    canonical specs and hashes, so this agent exercises the Shell's load-and-
    verify path end to end (the builder must register all four hashes on-chain).
    """

    mandate = (
        "Mandate: delta-neutral funding-rate carry across the BTC/ETH/SOL perp "
        "basket. Earn the funding differential by holding offsetting long/short "
        "legs whenever |Δfunding| exceeds entry threshold; stay market-neutral "
        "(no directional exposure, leverage 1x); flatten when the spread "
        "compresses. Capital preservation first: never breach the vault's "
        "published caps (the Shell enforces them regardless)."
    )

    def __init__(self) -> None:
        skills = [
            Skill(
                name="funding-carry-research",
                version="1.0.0",
                kind="research",
                call=_research_stub,
                source="funding-carry-research; reads state.funding_rates for BTC/ETH/SOL-PERP",
            ),
            Skill(
                name="funding-carry-analysis",
                version="1.0.0",
                kind="analysis",
                call=_analysis_stub,
                source="funding-carry-analysis; identity view over research signals (stub)",
            ),
            Skill(
                name="funding-carry-sizing",
                version="1.0.0",
                kind="sizing",
                call=_sizing_stub,
                source="funding-carry-sizing; defers sizing to exec skill (stub)",
            ),
            Skill(
                name="funding-carry-exec",
                version="1.0.0",
                kind="exec",
                call=lambda state: list(_funding_carry_decide(state)),
                source=_FUNDING_CARRY_EXEC_SPEC,
            ),
        ]
        super().__init__(skills=skills)
        # Match the reference strategy's 60s cadence.
        self.tick_seconds = 60

    @staticmethod
    def markets() -> list[str]:
        return list(_MARKETS)

    def propose(self, state: MarketState) -> list[Order]:
        """Run the pipeline. Non-exec stubs run for shape; exec yields intents.

        A real agent would feed the research/analysis/sizing outputs into the
        exec skill. Here the exec skill is self-contained, so we run the stubs
        for demonstration and return the exec skill's intents.
        """
        ctx = self.skill("funding-carry-research").call(state)  # type: ignore[union-attr]
        ctx = self.skill("funding-carry-analysis").call(ctx)  # type: ignore[union-attr]
        ctx = self.skill("funding-carry-sizing").call(ctx)  # type: ignore[union-attr]
        return list(self.skill("funding-carry-exec").call(state))  # type: ignore[union-attr]
