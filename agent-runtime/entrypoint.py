"""NemoClaw-supervised entrypoint for a LighterClaw trading agent.

This is the process NemoClaw's OpenShell supervisor launches inside the
EigenCompute TEE sandbox. It boots the stdlib healthcheck server first, then
runs one of two execution paths:

  * SHELL_MODE (default ON) — the nested **NemoClaw Shell wraps a mutable
    Agent** model. The measured Shell (`shell/`) loads + hash-verifies the
    Agent's skills against the on-chain SkillRegistry (fail-closed), runs the
    Agent's `propose()` intents through the policy engine + sole Lighter
    gateway, accrues fees via the vault client, and produces per-order +
    heartbeat attestations. The Agent defaults to `ReferenceAgent`
    (funding-carry as a registered exec skill) or `$AGENT_MODULE`.

  * Legacy simple path (SHELL_MODE=0) — the original behavior: resolve a
    strategy from `$STRATEGY_MODULE` (default `funding_carry`) and hand off to
    `eigenstrategies_sdk.run_agent(...)`, which loops
    decide() -> guardrails -> submit -> accrueTxFee. UNCHANGED and
    backward-compatible.

Both paths share the healthcheck/liveness wiring: every tick beats the health
server so probes reflect real loop progress.

Env contract (see agent-runtime/README.md for the full list): MNEMONIC,
TEE_PRIVATE_KEY, IMAGE_HASH, ATTESTATION_TOKEN_PATH, VAULT_ADDRESS, RPC_URL,
ATTESTATION_REGISTRY, LIGHTER_API_KEY, LIGHTER_ACCOUNT_INDEX, GUARD_* caps,
USE_TESTNET, and (shell path) SKILL_REGISTRY, SHELL_MODE, AGENT_MODULE,
HEARTBEAT_EVERY_TICKS.
"""

from __future__ import annotations

import importlib
import logging
import os
import sys

import healthcheck
from eigenstrategies_sdk import Guardrails, Strategy, run_agent


log = logging.getLogger("agent-runtime.entrypoint")

# Default strategy = the reference funding-carry agent. Configurable so the same
# runtime image can wrap any strategy module that follows the contract below.
DEFAULT_STRATEGY_MODULE = "funding_carry"

# Default Agent module/factory for the shell path. A module exposing
# `build_agent() -> (Agent, markets)` or `AGENT` + `MARKETS`, else we use the
# built-in ReferenceAgent.
DEFAULT_AGENT_MODULE = ""  # empty => built-in ReferenceAgent


def _shell_mode_enabled() -> bool:
    """SHELL_MODE defaults ON; SHELL_MODE=0/false/off disables (legacy path)."""
    raw = os.environ.get("SHELL_MODE", "1").strip().lower()
    return raw not in ("0", "false", "off", "no")


def _resolve_strategy(module_name: str) -> tuple[Strategy, list[str], Guardrails | None]:
    """Load (strategy, markets, guardrails) from a strategy module.

    A strategy module may expose any one of, in priority order:

      1. `build() -> (Strategy, markets, guardrails|None)` — preferred; lets the
         module own its guardrail config exactly like the reference agent's
         __main__ block does.
      2. `STRATEGY`, `MARKETS`, optional `GUARDRAILS` module-level globals.
      3. A `Strategy` subclass + `MARKETS` list (guardrails fall back to
         Guardrails.from_env(), i.e. the vault's published caps).

    The reference `agents/funding-carry/strategy.py` runs `run_agent(...)` under
    `if __name__ == "__main__"`, so importing it does NOT start trading — we add
    a tiny `funding_carry.py` shim in this image exposing `build()`.
    """
    mod = importlib.import_module(module_name)

    if hasattr(mod, "build"):
        result = mod.build()
        if isinstance(result, tuple):
            strat, markets, *rest = result
            guard = rest[0] if rest else None
            return strat, list(markets), guard
        raise TypeError(f"{module_name}.build() must return (strategy, markets[, guardrails])")

    if hasattr(mod, "STRATEGY") and hasattr(mod, "MARKETS"):
        return mod.STRATEGY, list(mod.MARKETS), getattr(mod, "GUARDRAILS", None)

    raise RuntimeError(
        f"strategy module '{module_name}' exposes neither build() nor "
        "(STRATEGY, MARKETS); cannot resolve a strategy to run."
    )


def _instrument_liveness(strategy: Strategy) -> Strategy:
    """Wrap decide() so each tick heartbeats the healthcheck server.

    Done by monkey-patching the bound method rather than subclassing, so it
    works for any Strategy instance the module hands us.
    """
    original_decide = strategy.decide
    original_on_error = strategy.on_error

    def decide(state):
        healthcheck.STATE.beat()
        return original_decide(state)

    def on_error(exc):
        healthcheck.STATE.beat(error=repr(exc))
        # Reference agents may re-raise; keep the SDK's default behavior but
        # don't let a swallowed error look like a healthy tick.
        return original_on_error(exc)

    strategy.decide = decide  # type: ignore[method-assign]
    strategy.on_error = on_error  # type: ignore[method-assign]
    return strategy


def _resolve_agent(module_name: str):
    """Load (agent, markets) for the shell path.

    Resolution order:
      1. empty `$AGENT_MODULE` (default) -> built-in `ReferenceAgent`.
      2. a module exposing `build_agent() -> (Agent, markets)`.
      3. a module exposing `AGENT` + `MARKETS` globals.

    Returns (agent, markets). Keeps the same "import doesn't auto-run" contract
    as the strategy resolver.
    """
    from shell import ReferenceAgent

    if not module_name:
        agent = ReferenceAgent()
        return agent, ReferenceAgent.markets()

    mod = importlib.import_module(module_name)
    if hasattr(mod, "build_agent"):
        agent, markets = mod.build_agent()
        return agent, list(markets)
    if hasattr(mod, "AGENT") and hasattr(mod, "MARKETS"):
        return mod.AGENT, list(mod.MARKETS)
    raise RuntimeError(
        f"agent module '{module_name}' exposes neither build_agent() nor "
        "(AGENT, MARKETS); cannot resolve an agent to run."
    )


def _run_shell_path() -> int:
    """The nested Shell-wraps-Agent execution path (SHELL_MODE on)."""
    from shell.shell import run_shell

    module_name = os.environ.get("AGENT_MODULE", DEFAULT_AGENT_MODULE)
    log.info("SHELL_MODE: loading agent module=%r", module_name or "<ReferenceAgent>")
    agent, markets = _resolve_agent(module_name)
    log.info("agent=%s markets=%s skills=%d", agent.name(), markets, len(agent.skills))

    # Liveness: beat the health server each tick (and on errors). The Shell loop
    # accepts an `on_tick(error=None)` hook with the same shape as the SDK path.
    def on_tick(error: str | None = None) -> None:
        healthcheck.STATE.beat(error=error)

    try:
        run_shell(agent, markets, on_tick=on_tick)
    except Exception:
        log.exception("shell loop crashed")
        return 1
    return 0


def _run_legacy_path() -> int:
    """The original SDK simple path (SHELL_MODE=0). UNCHANGED behavior."""
    module_name = os.environ.get("STRATEGY_MODULE", DEFAULT_STRATEGY_MODULE)
    log.info("legacy mode: loading strategy module: %s", module_name)
    strategy, markets, guardrails = _resolve_strategy(module_name)
    log.info("strategy=%s markets=%s", strategy.name(), markets)

    # Liveness instrumentation, then hand off the blocking trade loop to the
    # SDK. run_agent reads KMS/attestation env, binds attestation, connects to
    # Lighter, and loops until SIGINT/SIGTERM.
    _instrument_liveness(strategy)
    try:
        run_agent(strategy, markets=markets, guardrails=guardrails)
    except Exception:
        log.exception("agent loop crashed")
        return 1
    return 0


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # 1. Health server first so probes pass during the (potentially slow) boot:
    #    attestation bind + Lighter API-key handshake happen inside the loop.
    port = int(os.environ.get("PORT", "8080"))
    healthcheck.serve(port)
    healthcheck.STATE.set_identity(
        tee_wallet=None,  # filled in after the TEE wallet is derived; vault known now
        vault_address=os.environ.get("VAULT_ADDRESS"),
    )
    log.info("healthcheck listening on :%d", port)

    # 2. Select the execution path. SHELL_MODE defaults ON; set SHELL_MODE=0 to
    #    fall back to the legacy run_agent simple path (backward-compatible).
    if _shell_mode_enabled():
        log.info("execution path: NemoClaw Shell (wraps mutable Agent)")
        return _run_shell_path()
    log.info("execution path: legacy run_agent (SHELL_MODE=0)")
    return _run_legacy_path()


if __name__ == "__main__":
    sys.exit(main())
