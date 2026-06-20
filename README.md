# EigenStrategies

A permissionless, attested agent-vault platform where anyone can build, deploy, and run a trading agent on EigenCloud. Investors deposit USDC into a per-agent ERC-4626 vault and are traded by the same algorithm under shared accounting. The vault builder earns configurable transaction-fee and performance-fee shares.

**Live prototype:** https://chainyoda.github.io/lighteragent/

---

## What this actually is, in trader terms

> Imagine a CTA where you can read the source code, prove the manager can't change strategy mid-flight, and pay no AUM fee — only performance.

Three audiences, three plain-English answers:

### If you're a strategy builder

You write your strategy in **plain English** ("when BTC and ETH funding diverge by more than 12 bps, long the lower side, short the higher side, close at 4 bps"). The platform compiles that into Python, runs a backtest against historical Lighter data, and lets you deploy the same code into a Trusted Execution Environment on EigenCompute. The TEE gets its own wallet — that wallet is the only key allowed to place trades for the strategy.

You can run it three ways:

1. **Trade your own funds.** The TEE wallet trades a Lighter sub-account you fund yourself. Free until you ask outside capital to join.
2. **List a vault.** Wrap the same agent in an ERC-4626 vault, set your performance fee (e.g. 20% of profits) and per-trade fee (e.g. 0.08% of notional), and anyone can deposit USDC. Their deposits get traded by the same algorithm under shared accounting.
3. **Iterate.** Edit the prompt, re-backtest, redeploy. Each version produces a new attested image hash — investors in your old version get a 24h window to redeem before the rotation takes effect.

You earn fees on outside capital, not on your own. There's no protocol cap on what you charge — investors see the fee schedule before depositing.

### If you're an investor

You're depositing USDC into what's effectively a **fully-transparent algorithmic hedge fund**, with three properties traditional funds don't give you:

- **You can read the strategy.** The English description is published. The compiled Python is published. The image hash that's actually running is pinned onchain.
- **The manager can't silently rug you.** The vault contract enforces that only the TEE wallet derived from the published image hash can move funds. If the builder wants to switch strategy, it's a public action that opens a redemption window.
- **You hold a composable share token.** The vault is ERC-4626 — your shares are an ERC-20 you can transfer, lend against, or pull out at any time. No lockup, no LP-token mystery.

What you're not protected from: market risk, the strategy being bad, Lighter halting, or the builder writing a strategy that loses money inside the rules. Backtests are not promises. Read them, look at max drawdown, check skin in the game.

### If you're a quant looking at how to build on this

The interface is one method:

```python
class Strategy:
    def decide(self, state: MarketState) -> Iterable[Order]: ...
```

`MarketState` gives you free collateral, open positions, mid prices, funding rates. You return any orders you want submitted this tick. The runtime handles signing, fee accrual on each fill, NAV reporting, and graceful shutdown. The Python SDK ships with a Lighter client and a vault contract client; you don't write either.

A reference agent (delta-neutral funding-rate carry across BTC/ETH/SOL) is in [`agents/funding-carry/`](./agents/funding-carry/) — fork it, change `decide()`, deploy.

## How it's different from what's already out there

| | **EigenStrategies** | Hyperliquid Vaults | Lighter Public Pools | Discretionary CTA |
|---|---|---|---|---|
| Anyone can be a builder | ✅ permissionless | ✅ | ❌ whitelisted operators | ❌ |
| Strategy is verifiable / readable | ✅ TEE-attested | ❌ opaque | ❌ opaque | ❌ |
| Manager can't swap logic mid-flight | ✅ image hash pinned onchain | ❌ | ❌ | ❌ |
| Investor shares are composable ERC-20 | ✅ ERC-4626 | ❌ internal accounting | ❌ internal accounting | ❌ |
| Fee structure | builder-set, no caps | fixed 10% perf | builder-set perf only | management + perf |
| Where it trades | Lighter perps (v1) | Hyperliquid | Lighter | anywhere |

---

## Repo layout

| Path | What |
|---|---|
| [`agent-sdk/`](./agent-sdk/) | Python SDK — implement one `Strategy.decide` method, ship. Handles attestation, Lighter signing, fee accrual. |
| [`agents/funding-carry/`](./agents/funding-carry/) | Reference agent: delta-neutral funding-rate carry across BTC/ETH/SOL perps. |
| `index.html` `vault.html` `create.html` `portfolio.html` `builder.html` | Frontend prototype (also on GitHub Pages): sortable/filterable discover leaderboard with compare, a trader-grade vault page (live-vs-backtest equity overlay, risk panel, live positions & fills, fee calculator, image-rotation history, builder track record), an investor portfolio, a builder studio (param sliders, walk-forward/regime backtest, editable compiled code, paper/live deploy), and a **builder dashboard** ("My agents") aggregating the vaults you've deployed — AUM, investors, fees earned, current attested image, and a one-click image-rotation flow that opens an investor redemption window. |
| `data.js` `ui.js` | Shared mock data layer (deterministic vault metrics, positions, fills, portfolios, builder earnings) + chart/sparkline/sort/toast helpers. |
| `discover.js` `vault.js` `portfolio.js` `create.js` `builder.js` | Per-page logic. |
| `wallet.js` | EIP-6963 wallet connection (MetaMask, Rabby, Coinbase, etc.). |

## Build an agent in 30 lines

```python
from decimal import Decimal
from eigenstrategies_sdk import Strategy, MarketState, Order, run_agent

class MyStrategy(Strategy):
    tick_seconds = 30
    def decide(self, state: MarketState):
        if not state.positions and state.free_collateral > Decimal(100):
            yield Order(market="BTC-PERP", side="long", size=Decimal("0.001"))

if __name__ == "__main__":
    run_agent(MyStrategy(), markets=["BTC-PERP"])
```

Then `ecloud compute app deploy` and paste the returned image hash into the
[Create vault](https://chainyoda.github.io/lighteragent/create.html) form. See
the [SDK README](./agent-sdk/) and [reference agent](./agents/funding-carry/)
for the full picture.

### Lighter venue parameters (v1)

The prototype's market specs, leverage caps, margin requirements and fees match
Lighter's official [contract specifications](https://docs.lighter.xyz/perpetual-futures/contract-specifications)
and [trading fees](https://docs.lighter.xyz/trading/trading-fees):

| Market | Max leverage | Price step | Amount step | IMR / MMR / CMR |
|---|---|---|---|---|
| BTC-PERP | 50× | 0.1 | 0.00001 | 2.0% / 1.2% / 0.8% |
| ETH-PERP | 50× | 0.01 | 0.0001 | 2.0% / 1.2% / 0.8% |
| SOL-PERP | 25× | 0.001 | 0.001 | 4.0% / 2.4% / 1.6% |

Funding settles **hourly**. Trading fees are **0% maker / 0% taker** on Standard
accounts (Premium/HFT: 0.002% / 0.02%), so the only per-trade cost an investor
pays is the vault builder's own `txFeeBps`. These values live in `LIGHTER` in
[`data.js`](./data.js) and drive price/size tick rounding and liquidation-price
math across the UI.

---

## Context

An Eigen reference app for the "anyone-builds-and-anyone-invests" pattern: pooled capital traded by a single algorithm with a creator-share. The closest existing primitives are Hyperliquid Vaults and **Lighter Public Pools**.

Lighter Public Pools today are:
- **Permissioned** (operators must be whitelisted).
- **Off-chain accounting** — shares live inside an operator sub-account, not as ERC-20s.
- **Strategy-opaque** — depositors trust the operator, with no cryptographic guarantee that the running code matches what was advertised.

EigenStrategies closes all three gaps and turns each into an Eigen primitive:

| Gap in Lighter Public Pools  | EigenStrategies answer                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Permissioned operators       | Permissionless `VaultFactory` — anyone deploys a vault.                            |
| Off-chain shares             | ERC-4626 share token, composable in DeFi.                                          |
| "Trust the operator"         | Vault pins an **EigenCompute attested image hash**; trade authority bound to KMS wallet derived from that attestation. Builder cannot silently swap strategy. |

Output of this round, per user direction: **architecture doc + contract interfaces only**. No implementation breakdown, no frontend plan.

Locked-in design choices (from clarifying questions):
- **Venue:** Lighter perps (ZK-rollup orderbook, sub-account model, API-key signing).
- **Custody:** ERC-4626 vault per agent; trading key held inside the EigenCompute TEE.
- **Trust model:** Onchain pinning of EigenCompute image hash; trade-authority wallet derived via EigenCompute KMS bound to that attestation.
- **Fees:** Builder picks freely at vault creation (no protocol caps). Frontend filters spam.

---

## System Overview

```mermaid
flowchart LR
    Builder([Builder])
    Investor([Investor])

    subgraph EC["EigenCompute (TEE)"]
        Image["Docker image<br/>strategy code"]
        Hash["Attested image hash H"]
        KMS["KMS wallet W = f(H)"]
        Image --> Hash --> KMS
    end

    subgraph Onchain["Onchain (L1/L2)"]
        Factory["VaultFactory"]
        Vault["EigenVault<br/>ERC-4626 shares<br/>HWM, fees<br/>pinned (H, W)"]
        Registry["AttestationRegistry"]
        Fees["FeeAccountant"]
        Factory --> Vault
        Factory --> Registry
        Vault --> Fees
        Registry -. verifies .-> Vault
    end

    subgraph Lighter["Lighter (ZK perps)"]
        Sub["Vault-owned<br/>sub-account"]
    end

    Builder -- "1. publish image" --> EC
    Builder -- "2. createVault(H, W, fees)" --> Factory
    Investor -- "3. deposit USDC" --> Vault
    KMS -- "signs trades & bridge calls" --> Vault
    Vault -- "bridgeTo / bridgeFrom USDC" --> Sub
    KMS -- "API key on" --> Sub
    Sub -- "PnL" --> Vault
    Vault -- "fee shares" --> Builder
```

Three planes:

1. **Custody plane (onchain).** USDC sits in `EigenVault`. Investors mint/burn shares. Only the registered TEE wallet `W` can move funds to/from the Lighter bridge contract on behalf of the vault.
2. **Execution plane (EigenCompute).** The strategy container runs in a TEE. KMS-provisioned mnemonic gives it `W`'s key. It calls Lighter's API to register `W` as an API key on the vault's Lighter sub-account, then submits orders.
3. **Settlement plane (Lighter).** Each vault owns one Lighter sub-account, derived deterministically from the vault address. PnL realized there flows back through Lighter's withdrawal contract into `EigenVault` whenever the strategy chooses (or on investor exit).

---

## Components & Contract Interfaces

All contracts live in `contracts/` of a future monorepo. Solidity interface sketches; implementation details deferred.

### 1. `VaultFactory`

Permissionless entry point. Deploys a vault, registers it in `AttestationRegistry`, and emits the publish event the indexer/frontend consume.

```solidity
interface IVaultFactory {
    struct VaultParams {
        bytes32 imageHash;          // EigenCompute attested image digest
        address teeWallet;          // KMS-derived wallet bound to imageHash
        uint16  perfFeeBps;         // builder-chosen, no protocol cap
        uint16  txFeeBps;           // applied per-trade on notional
        address builder;            // recipient of fees
        string  metadataURI;        // IPFS: name, desc, risk profile
    }

    event VaultCreated(address vault, address builder, bytes32 imageHash);

    function createVault(VaultParams calldata p) external returns (address vault);
}
```

### 2. `EigenVault` (ERC-4626)

Per-agent vault. USDC-denominated. Standard 4626 deposit/redeem; fees and trade-authority on top.

```solidity
interface IEigenVault is IERC4626 {
    // Trade authority -----------------------------------------------------
    function teeWallet() external view returns (address);
    function imageHash() external view returns (bytes32);

    // Lighter bridge moves -----------------------------------------------
    // Only callable by teeWallet. Pulls/pushes USDC between this vault
    // and Lighter's deposit contract for this vault's sub-account.
    function bridgeToLighter(uint256 assets) external;
    function bridgeFromLighter(uint256 assets) external;

    // Fee accrual (called by FeeAccountant, see §4) -----------------------
    function accrueTxFee(uint256 notional) external;
    function realizePerfFee() external returns (uint256 sharesMinted);

    // Governance: rotate to a new attested image (emits event; investors
    // get a window to redeem at last HWM before the new image takes over).
    function proposeImage(bytes32 newHash, address newWallet) external;
    function acceptImage() external;
}
```

Key invariants:

- `teeWallet` is the **only** address allowed to call `bridgeToLighter` / `bridgeFromLighter`.
- `imageHash` is **immutable per epoch**. `proposeImage` opens a redemption window (e.g., 24h) before `acceptImage` rotates `(imageHash, teeWallet)`.
- Share price = `(USDC in vault + USDC in linked Lighter sub-account) / totalSupply`. The Lighter side is read via an oracle/adapter (see §5).

### 3. `AttestationRegistry`

Onchain pin of `(vault → imageHash, teeWallet)`. Verifies an EigenCompute attestation token before accepting a binding. Two implementation paths to evaluate later:

- **A. Light verifier:** trust an EigenLayer AVS that posts attestation results (cheap, depends on AVS availability).
- **B. Onchain verifier:** verify the attestation signature directly against a known KMS root (heavier gas, no extra trust hop).

```solidity
interface IAttestationRegistry {
    function bind(address vault, bytes32 imageHash, address teeWallet, bytes calldata attestation) external;
    function isValid(address vault) external view returns (bool);
    function imageOf(address vault) external view returns (bytes32);
}
```

### 4. `FeeAccountant`

Splits fees between builder and protocol. Two streams:

- **Per-trade fee (`txFeeBps`)** — applied on notional reported by the strategy when it calls `accrueTxFee`. Charged in shares, minted to builder.
- **Performance fee (`perfFeeBps`)** — high-water-mark style. On `realizePerfFee` (typically called on investor exit, or periodically by the strategy), compute `pnlAboveHWM`, mint shares worth `pnlAboveHWM * perfFeeBps / 1e4` to the builder, advance HWM.

Protocol cut is a fixed slice of both, configurable by governance, paid to a treasury address.

```solidity
interface IFeeAccountant {
    function quoteTxFee(uint256 notional, uint16 bps) external view returns (uint256 shares);
    function quotePerfFee(uint256 pnlAboveHWM, uint16 bps) external view returns (uint256 shares);
    function protocolCutBps() external view returns (uint16);
}
```

### 5. `LighterAdapter`

Off-chain library + thin onchain helper. Two responsibilities:

1. **Vault → Lighter bridge.** Wraps Lighter's deposit/withdraw smart contracts. Each vault owns one Lighter sub-account whose ETH-wallet is the vault contract itself; the API-key signer is `teeWallet`.
2. **NAV oracle.** Reads (open positions + free collateral) for the vault's sub-account from Lighter and exposes it to `EigenVault.totalAssets()`. For v1, an off-chain pusher signed by the TEE is acceptable; for v2, a Lighter-native ZK proof of sub-account balance.

Off-chain SDK side (lives in `agent-runtime/`, not in `contracts/`):

```ts
// Strategy authors implement this interface.
interface Strategy {
  decide(state: MarketState): Promise<Order[]>;
}
```

The runtime wraps `Strategy.decide`, signs orders with the KMS-provided mnemonic, calls `accrueTxFee` after each fill, and pushes NAV updates.

### 6. `EigenCompute Image` (off-chain artifact, not a contract)

Reference Docker image (`linux/amd64`, root, EXPOSE port for healthcheck) that:

- Reads `MNEMONIC` from KMS-injected env at runtime.
- Loads the strategy module.
- On boot: registers itself as an API key on its Lighter sub-account, posts an attestation token to `AttestationRegistry.bind` (one-time).
- Main loop: fetch market state → `Strategy.decide` → sign + submit → on fill, call `EigenVault.accrueTxFee`.

Three template flavors at MVP: TS, Python, Rust. (Picked from EigenCompute's official template list.)

---

## Sequence: Investor deposit → trade → exit

```mermaid
sequenceDiagram
    autonumber
    actor B as Builder
    actor I as Investor
    participant EC as EigenCompute (TEE)
    participant F as VaultFactory
    participant V as EigenVault
    participant R as AttestationRegistry
    participant L as Lighter sub-account

    B->>EC: ecloud deploy (image)
    EC-->>B: imageHash H, attestation, teeWallet W
    B->>F: createVault(H, W, fees, metadata)
    F->>V: deploy
    F->>R: bind(vault, H, W, attestation)
    I->>V: deposit(USDC)
    V-->>I: shares (at NAV)
    EC->>V: bridgeToLighter(amount)  [signed by W]
    V->>L: USDC into sub-account
    EC->>L: place order  [API key = W]
    L-->>EC: fill
    EC->>V: accrueTxFee(notional)
    I->>V: redeem(shares)
    V->>V: realizePerfFee() [HWM]
    alt insufficient free USDC
        V-->>EC: webhook: pull from Lighter
        EC->>V: bridgeFromLighter(amount)
        V->>L: withdraw
        L-->>V: USDC
    end
    V-->>I: USDC payout
    B->>V: redeem fee shares
    V-->>B: USDC
```

1. **Builder deploys image** via `ecloud compute app deploy`, gets back `(imageHash, attestationToken, teeWallet)`.
2. **Builder calls `VaultFactory.createVault`**, passing the above + fee params + metadataURI. Factory deploys vault, calls `AttestationRegistry.bind`.
3. **Investor calls `EigenVault.deposit(usdc, receiver)`**. Mints shares at current NAV.
4. **Strategy** (running in TEE): pulls a tranche to Lighter via `bridgeToLighter`, places orders, on each fill calls `accrueTxFee`.
5. **Investor exits** via `redeem(shares)`. Vault checks free USDC; if insufficient, the strategy is asked (off-chain via webhook) to `bridgeFromLighter` enough to cover. `realizePerfFee` runs first, then the investor receives `(remaining USDC * shares / totalSupply)`.
6. **Builder withdraws fees** by redeeming the shares minted to them by `FeeAccountant`.

---

## Threat Model (high-level)

| Threat                                                   | Mitigation                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Builder swaps strategy after attracting deposits         | `imageHash` immutable per epoch; `proposeImage` opens redemption window before rotation.    |
| TEE wallet key leaks                                     | Bridge functions are `teeWallet`-gated, but funds can only move between vault ↔ Lighter sub-account ↔ vault. They cannot be drained to an arbitrary address. |
| Builder front-runs investor deposits/withdrawals         | Use redemption queue + NAV snapshot at request time, not at execution time.                 |
| NAV oracle lies about Lighter sub-account state          | v1: TEE-signed NAV (trust the attestation). v2: ZK proof from Lighter directly.             |
| Lighter halts or sub-account is frozen                   | Out of scope for v1; investors bear venue risk, surfaced in metadata.                       |
| Attestation registry accepts forged attestation          | Choice between AVS-backed and onchain verifier (§3). Pick before contracts are written.     |

---

## Open Questions (to resolve before implementation phase)

1. **Attestation verifier path** — AVS-backed vs. fully onchain. Affects both gas and trust assumptions.
2. **Fee cap policy** — confirmed as "no caps." Surface fees prominently in vault metadata so frontend can warn.
3. **Lighter Public Pools coexistence** — should EigenStrategies *also* register as Lighter Public Pools (if/when Lighter opens permissionless creation), or stay sub-account-only? Affects discoverability inside Lighter's UI.
4. **NAV update cadence** — per-fill, per-block, or pull-only on deposit/redeem? Trade-off between gas and stale-NAV arbitrage windows.
5. **Cross-vault rebalancing** — explicitly out of scope for v1; each vault is isolated.

---

## Critical Files (when implementation begins)

This plan does not yet implement, but the eventual layout under `contracts/`:

- `contracts/VaultFactory.sol`
- `contracts/EigenVault.sol`
- `contracts/AttestationRegistry.sol`
- `contracts/FeeAccountant.sol`
- `contracts/adapters/LighterAdapter.sol`
- `contracts/interfaces/I*.sol`

And under `agent-runtime/`:

- `agent-runtime/Dockerfile`
- `agent-runtime/src/index.ts` (boot, KMS, attestation post, main loop)
- `agent-runtime/src/lighter.ts` (signing, order submission, NAV)
- `agent-runtime/src/strategy.ts` (the user-supplied module)

---

## Verification (for the design itself, before any code is written)

- Walk a deposit → trade → redeem cycle on paper using the interfaces above; confirm USDC accounting closes to zero.
- Walk an "evil builder" cycle: builder publishes image A, attracts deposits, then tries to swap to image B mid-flight. Confirm `proposeImage`/`acceptImage` window prevents silent swap.
- Confirm Lighter's API-key model maps cleanly: `teeWallet` is registered as an API key on the vault-owned sub-account; vault contract is the L1 owner of that sub-account.
- Independent review of attestation-registry verifier choice (§3) before locking it in.
