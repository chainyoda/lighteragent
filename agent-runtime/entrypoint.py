"""NemoClaw-supervised entrypoint for a LighterClaw trading agent.

This is the process NemoClaw's OpenShell supervisor launches inside the
EigenCompute TEE sandbox. It:

  1. Boots the stdlib healthcheck server on $PORT (default 8080) so
     EigenCompute / NemoClaw liveness probes pass while the agent boots.
  2. Resolves the strategy to run from $STRATEGY_MODULE (default
     `funding_carry`), importing a `build()` factory or a module-level
     `STRATEGY` / `run()` entrypoint.
  3. Hands off to `eigenstrategies_sdk.run_agent(...)`, which (inside the TEE):
       - reads the KMS-injected MNEMONIC + attestation env,
       - derives the TEE wallet and binds the attestation to the vault via
         AttestationRegistry (one-time),
       - connects to Lighter with the pre-registered API key,
       - loops decide() -> guardrails -> submit -> accrueTxFee.

We do NOT re-implement the trade loop here; the SDK owns it. Our only addition
is liveness instrumentation: we wrap the strategy so every `decide()` call
heartbeats the healthcheck server, giving probes real loop progress.

Env contract (consumed by the SDK; see agent-runtime/README.md for the full
list): MNEMONIC, TEE_PRIVATE_KEY, IMAGE_HASH, ATTESTATION_TOKEN_PATH,
VAULT_ADDRESS, RPC_URL, ATTESTATION_REGISTRY, LIGHTER_API_KEY,
LIGHTER_ACCOUNT_INDEX, GUARD_* caps, USE_TESTNET.
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


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # 1. Health server first so probes pass during the (potentially slow) boot:
    #    attestation bind + Lighter API-key handshake happen inside run_agent.
    port = int(os.environ.get("PORT", "8080"))
    healthcheck.serve(port)
    healthcheck.STATE.set_identity(
        tee_wallet=None,  # filled in after the SDK derives it; vault is known now
        vault_address=os.environ.get("VAULT_ADDRESS"),
    )
    log.info("healthcheck listening on :%d", port)

    # 2. Resolve the strategy (default funding-carry).
    module_name = os.environ.get("STRATEGY_MODULE", DEFAULT_STRATEGY_MODULE)
    log.info("loading strategy module: %s", module_name)
    strategy, markets, guardrails = _resolve_strategy(module_name)
    log.info("strategy=%s markets=%s", strategy.name(), markets)

    # 3. Liveness instrumentation, then hand off the blocking trade loop to the
    #    SDK. run_agent reads KMS/attestation env, binds attestation, connects
    #    to Lighter, and loops until SIGINT/SIGTERM.
    _instrument_liveness(strategy)
    try:
        run_agent(strategy, markets=markets, guardrails=guardrails)
    except Exception:
        log.exception("agent loop crashed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
