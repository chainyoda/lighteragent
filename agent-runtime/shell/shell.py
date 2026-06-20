"""The NemoClaw Shell run loop — wraps a mutable Agent, enforces everything.

This is the outer object in the nested model. It owns the five responsibilities
and the loop that ties them together:

    load + verify skills (fail-closed)        [skill_loader + skill_registry]
        │
    agent.on_start()
        │
    loop every tick:
        state   = gateway.fetch_state(markets)         [gateway-mediated read]
        intents = agent.propose(state)                 [Agent proposes only]
        fills   = gateway.submit_all(intents, state)   [policy engine + sole gateway + vault accrual]
        for each fill: attestation.attest_order(...)   [per-order attestation]
        every N ticks: attestation.heartbeat(...)      [heartbeat attestation, on-chain]
        │
    graceful shutdown on SIGINT/SIGTERM

It reuses the SDK's ``from_env()`` constructors for the Lighter/vault/guardrails
clients, so the env contract for the execution path is unchanged. The only new
env it reads is ``SKILL_REGISTRY`` (registry address) and
``HEARTBEAT_EVERY_TICKS`` (cadence). Liveness is wired exactly like the legacy
entrypoint: each tick beats the healthcheck server.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from decimal import Decimal
from pathlib import Path

from eigenstrategies_sdk import Guardrails

from .agent import Agent
from .attestation import AttestationProducer, OrderAttestation
from . import attestation as attestation_mod
from .order_gateway import OrderGateway
from . import order_gateway as order_gateway_mod
from .skill_loader import load_and_verify_skills
from .skill_registry_client import SkillRegistryClient
from . import skill_registry_client as skill_registry_mod


log = logging.getLogger("shell.shell")


class Shell:
    """Wraps a mutable Agent and is the only thing that can act on its behalf."""

    def __init__(
        self,
        agent: Agent,
        markets: list[str],
        gateway: OrderGateway,
        registry: SkillRegistryClient,
        attestation: AttestationProducer,
        vault_address: str,
        *,
        heartbeat_every_ticks: int = 10,
        on_tick=None,
    ):
        self.agent = agent
        self.markets = markets
        self.gateway = gateway
        self.registry = registry
        self.attestation = attestation
        self.vault_address = vault_address
        self.heartbeat_every_ticks = max(1, heartbeat_every_ticks)
        # Optional liveness hook (entrypoint passes healthcheck.STATE.beat).
        self._on_tick = on_tick
        # Per-period accumulator of order attestations for the next heartbeat.
        self._pending: list[OrderAttestation] = []
        self._last_nav: Decimal = Decimal(0)

    # ---- lifecycle ----------------------------------------------------------
    async def run(self) -> None:
        """Load+verify skills (fail-closed), then loop until signalled."""
        # 1. Skill loader + registry check — FAIL CLOSED. If this raises, the
        #    Shell never trades. This is the gate that contains the Agent's
        #    mutability: only on-chain-registered skill hashes are admitted.
        verified = load_and_verify_skills(self.agent, self.vault_address, self.registry, log_=log)
        log.info("shell admitted %d verified skill(s) for agent %s", len(verified), self.agent.name())

        # 2. Agent boot (bind models / open MCP sessions / warm data — secret).
        self.agent.on_start()

        # 3. The loop.
        stopping = asyncio.Event()
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stopping.set)
            except (NotImplementedError, RuntimeError):
                # Signal handlers may be unavailable (e.g. non-main thread/tests).
                pass

        tick = 0
        try:
            while not stopping.is_set():
                tick += 1
                if self._on_tick is not None:
                    self._on_tick()
                try:
                    await self._tick(tick)
                except Exception as exc:  # one bad tick must not kill the Shell
                    self.agent.on_error(exc)
                    if self._on_tick is not None:
                        # Surface the error to liveness without faking a healthy beat.
                        try:
                            self._on_tick(error=repr(exc))
                        except TypeError:
                            pass

                try:
                    await asyncio.wait_for(stopping.wait(), timeout=self.agent.tick_seconds)
                except asyncio.TimeoutError:
                    pass
        finally:
            await self._shutdown()

    async def _tick(self, tick: int) -> None:
        """One iteration: read -> propose -> gate+submit -> attest -> maybe beat."""
        state = await self.gateway.fetch_state(self.markets)
        self._last_nav = state.account_value if state.account_value > 0 else state.free_collateral

        # Agent proposes INTENTS only. It has no gateway/exchange handle.
        intents = self.agent.propose(state)

        # Policy engine + sole gateway + vault accrual all happen inside submit_all.
        fills = await self.gateway.submit_all(intents, state)

        # Per-order attestation for each fill the gateway executed.
        for fill in fills:
            att = self.attestation.attest_order(fill.order, fill)
            self._pending.append(att)
            if fill.filled and fill.fill_price is not None and fill.fill_size is not None:
                self.agent.on_fill(fill.order, fill.fill_price, fill.fill_size)

        # Heartbeat every N ticks: post the period's ordersRoot + navRoot on-chain.
        if tick % self.heartbeat_every_ticks == 0:
            await self._post_heartbeat(tick)

    async def _post_heartbeat(self, period_index: int) -> None:
        try:
            # Web3 calls are blocking; keep them off the event loop's critical path.
            tx = await asyncio.to_thread(
                self.attestation.heartbeat,
                list(self._pending),
                self._last_nav,
                period_index=period_index,
            )
            log.info("heartbeat posted: tx=%s (orders=%d)", tx, len(self._pending))
        except Exception as e:
            # A failed heartbeat must not stop trading; the next one will retry
            # with the still-pending attestations.
            log.error("heartbeat post failed: %s", e)
            return
        # Only clear the accumulator once the heartbeat is posted.
        self._pending.clear()

    async def _shutdown(self) -> None:
        # Best-effort final heartbeat so the last period is committed on-chain.
        if self._pending:
            try:
                await asyncio.to_thread(
                    self.attestation.heartbeat, list(self._pending), self._last_nav
                )
                log.info("final heartbeat posted on shutdown (orders=%d)", len(self._pending))
            except Exception as e:
                log.error("final heartbeat failed: %s", e)
        await self.gateway.close()
        log.info("shell stopped")


# ---------------------------------------------------------------------------
# Wiring from the (mostly unchanged) env contract.
# ---------------------------------------------------------------------------
def build_from_env(
    agent: Agent,
    markets: list[str],
    *,
    guardrails: Guardrails | None = None,
    on_tick=None,
) -> Shell:
    """Construct a fully wired Shell from the EigenCompute-injected env.

    Reuses the SDK's lighter/vault/guardrails ``from_env`` constructors (env
    contract unchanged) and adds the SkillRegistry client + attestation producer,
    which read ``SKILL_REGISTRY`` (new) plus the existing ``RPC_URL`` /
    ``TEE_PRIVATE_KEY`` / ``VAULT_ADDRESS``.
    """
    vault_address = os.environ["VAULT_ADDRESS"]
    heartbeat_every = int(os.environ.get("HEARTBEAT_EVERY_TICKS", "10"))

    gateway = order_gateway_mod.from_env(guardrails=guardrails)
    registry = skill_registry_mod.from_env()
    producer = attestation_mod.from_env(registry)

    # Optional: bind the attestation registry once, mirroring the SDK's one-time
    # AttestationRegistry.bind. The SkillRegistry doesn't require a bind; the
    # heartbeat itself is the attributable on-chain action. We log identity here.
    log.info(
        "shell wiring: vault=%s tee=%s registry=%s heartbeat_every=%d markets=%s",
        vault_address, producer.signer, os.environ.get("SKILL_REGISTRY"),
        heartbeat_every, markets,
    )

    return Shell(
        agent=agent,
        markets=markets,
        gateway=gateway,
        registry=registry,
        attestation=producer,
        vault_address=vault_address,
        heartbeat_every_ticks=heartbeat_every,
        on_tick=on_tick,
    )


def run_shell(
    agent: Agent,
    markets: list[str],
    *,
    guardrails: Guardrails | None = None,
    on_tick=None,
) -> None:
    """Blocking entrypoint for the Shell loop (mirrors SDK ``run_agent`` shape).

    Optionally also binds the attestation token to the AttestationRegistry the
    same way the SDK runtime does (the Shell wraps, it does not remove, that
    one-time bind), reusing ``VaultClient`` so the env contract is unchanged.
    """
    shell = build_from_env(agent, markets, guardrails=guardrails, on_tick=on_tick)

    # One-time attestation bind, identical to the SDK runtime's behavior, so the
    # Shell path keeps the same image-hash -> vault binding. Best-effort.
    _bind_attestation_once()

    asyncio.run(shell.run())


def _bind_attestation_once() -> None:
    """Mirror eigenstrategies_sdk.runtime's one-time AttestationRegistry.bind.

    Kept here so the Shell path is feature-equivalent to the legacy run_agent
    path on attestation binding. Failures are non-fatal (likely already bound).
    """
    attestation_path = os.environ.get("ATTESTATION_TOKEN_PATH")
    if not attestation_path:
        return
    try:
        from eigenstrategies_sdk.vault_client import from_env as vault_from_env

        vault = vault_from_env()
        token = Path(attestation_path).read_bytes()
        image_hash = bytes.fromhex(os.environ["IMAGE_HASH"].removeprefix("0x"))
        tx = vault.bind_attestation(image_hash, vault.address, token)
        log.info("attestation bound: tx=%s", tx)
    except Exception as e:
        log.warning("attestation bind skipped/failed (may already be bound): %s", e)
