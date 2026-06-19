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
```

Returned `Order` objects flow through the runtime to Lighter, fees are
charged onchain, and `on_fill` is invoked once each fill confirms.

## See also

- [EigenStrategies architecture](../README.md)
- [Reference agent: funding-carry](../agents/funding-carry/)
