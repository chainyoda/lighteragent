# Funding-rate carry — reference EigenVault agent

Delta-neutral funding-rate carry across BTC/ETH/SOL perps on Lighter.
Picks the asset pair with the widest funding-rate spread, longs the
side that's paying funding to longs, shorts the other. Unwinds when
the spread compresses below `EXIT_SPREAD_BPS`.

## Run locally (paper mode)

```bash
pip install -e ../../agent-sdk
USE_TESTNET=1 \
RPC_URL=... VAULT_ADDRESS=0x... ATTESTATION_REGISTRY=0x... \
TEE_PRIVATE_KEY=0x... LIGHTER_API_KEY=0x... LIGHTER_ACCOUNT_INDEX=0 \
python strategy.py
```

## Deploy to EigenCompute

```bash
ecloud auth login
ecloud compute app create --name funding-carry --language python --template-repo minimal
ecloud compute app deploy        # builds Dockerfile, returns image hash + TEE wallet
```

Take the returned `imageHash` and `teeWallet` to the
[Create vault](https://chainyoda.github.io/lighteragent/create.html)
page. Once the vault is live, the same image starts trading the
pooled USDC.

## Tunables

| Constant | Default | What |
|---|---|---|
| `ENTRY_SPREAD_BPS` | 12 | Minimum funding spread to open a pair (per 8h) |
| `EXIT_SPREAD_BPS` | 4 | Spread at which an open pair is unwound |
| `MAX_NOTIONAL_PER_PAIR` | 5000 USDC | Per-pair sizing cap |
| `MIN_FREE_COLLATERAL` | 500 USDC | Skip ticks if vault is under-funded |
| `LEVERAGE` | 1× | The whole strategy is delta-neutral by construction |
| `tick_seconds` | 60 | How often `decide()` runs |
