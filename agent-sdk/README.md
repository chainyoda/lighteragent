# eigenstrategies-sdk

Python SDK for building EigenStrategies trading agents. Implement one method, ship.

## Install

```bash
pip install eigenstrategies-sdk
```

## Quickstart

```python
from decimal import Decimal
from eigenstrategies_sdk import Strategy, MarketState, Order, run_agent

class HelloStrategy(Strategy):
    tick_seconds = 30

    def decide(self, state: MarketState):
        if not state.positions and state.free_collateral > Decimal(100):
            yield Order(market="BTC-PERP", side="long", size=Decimal("0.001"))

if __name__ == "__main__":
    run_agent(HelloStrategy(), markets=["BTC-PERP"])
```

That's the whole agent. The SDK handles attestation binding, Lighter API
signing, fee accrual, NAV reporting, and graceful shutdown.

## Guardrails (enforced in the TEE)

Risk limits are enforced by the **runtime**, between `decide()` and order
submission — so a buggy or malicious strategy *cannot* exceed them. They run in
the same attested image that trades, and their values come from the vault's
published parameters, so the enforced caps are exactly what investors were
shown. Strategy-level checks (stops, sizing in `decide()`) are still good
practice, but they are now backstopped rather than load-bearing.

```python
from eigenstrategies_sdk import Strategy, Guardrails, run_agent

run_agent(
    HelloStrategy(),
    markets=["BTC-PERP", "ETH-PERP"],
    guardrails=Guardrails(
        allowed_markets=frozenset({"BTC-PERP", "ETH-PERP"}),
        max_leverage=Decimal("3"),            # gross notional / account equity
        max_notional_per_order=Decimal("25000"),
        max_notional_per_market=Decimal("100000"),
        min_free_collateral=Decimal("500"),
        max_drawdown_pct=Decimal("0.25"),     # circuit breaker → flatten + halt new risk
    ),
)
```

Each tick the runtime: drops orders on non-whitelisted markets, **clamps** order
size to the per-order / per-market / gross / leverage caps (vault config *and*
Lighter's venue max — BTC/ETH 50×, SOL 25×), blocks new risk below
`min_free_collateral`, caps orders per tick, and trips a drawdown circuit
breaker that allows only reduce-only/flatten orders. `reduce_only` orders are
always allowed through. Omit the `guardrails=` argument and they load from env
via `Guardrails.from_env()`.

## Environment (injected by EigenCompute)

| Var | What |
|---|---|
| `MNEMONIC` | KMS-provided seed for the TEE wallet (auto-injected by EigenCompute). |
| `TEE_PRIVATE_KEY` | Derived from `MNEMONIC` at boot if unset. |
| `RPC_URL` | L2 RPC endpoint where the vault lives. |
| `VAULT_ADDRESS` | The `EigenVault` contract this agent trades for. |
| `ATTESTATION_REGISTRY` | `AttestationRegistry` address. |
| `IMAGE_HASH` | The attested image hash (matches what was pinned in the vault). |
| `ATTESTATION_TOKEN_PATH` | Path to the attestation token file. |
| `LIGHTER_API_KEY` | Pre-registered on the vault's Lighter sub-account. |
| `LIGHTER_ACCOUNT_INDEX` | The vault's Lighter account index. |
| `USE_TESTNET` | `1` for Lighter testnet, otherwise mainnet. |
| `GUARD_MAX_LEVERAGE` · `GUARD_MAX_GROSS_NOTIONAL` · `GUARD_MAX_NOTIONAL_PER_ORDER` · `GUARD_MAX_NOTIONAL_PER_MARKET` · `GUARD_MIN_FREE_COLLATERAL` · `GUARD_MAX_DRAWDOWN_PCT` · `GUARD_ALLOWED_MARKETS` · `GUARD_MAX_ORDERS_PER_TICK` · `GUARD_FLATTEN_ON_HALT` | Vault-published guardrail limits, read by `Guardrails.from_env()`. |

## What `Strategy` sees

```python
@dataclass(frozen=True)
class MarketState:
    timestamp: int
    free_collateral: Decimal              # USDC available to deploy
    positions: dict[str, Position]        # by market symbol
    mid_prices: dict[str, Decimal]
    funding_rates: dict[str, Decimal]
    open_orders: dict[str, list]
    account_value: Decimal                # total equity (collateral + uPnL)
```

Returned `Order` objects flow through the runtime to Lighter, fees are
charged onchain, and `on_fill` is invoked once each fill confirms.

## See also

- [EigenStrategies architecture](../README.md)
- [Reference agent: funding-carry](../agents/funding-carry/)
