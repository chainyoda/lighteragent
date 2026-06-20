# EigenStrategies — Onchain Contracts

The custody + accounting layer for [LighterClaw / EigenStrategies](../README.md):
per-agent **ERC-4626 USDC vaults** that trade Lighter perps, with trade authority
bound to a **TEE wallet attested on EigenCompute**.

This package is self-contained Foundry. Function signatures match the Python
runtime in [`agent-sdk/eigenstrategies_sdk/vault_client.py`](../agent-sdk/eigenstrategies_sdk/vault_client.py)
exactly, so the in-TEE client can call these contracts without changes.

---

## Contracts

| Contract | Responsibility |
|---|---|
| `src/VaultFactory.sol` | Permissionless entry point. Deploys an `EigenVault`, binds it in the registry, emits `VaultCreated`. |
| `src/EigenVault.sol` | ERC-4626 USDC vault. Trade authority (`teeWallet`-gated bridge), per-trade + HWM performance fees, image rotation with a redemption window. |
| `src/AttestationRegistry.sol` | Onchain pin of `(vault → imageHash, teeWallet)`. Verifies attestations via a **pluggable verifier**. |
| `src/FeeAccountant.sol` | Stateless fee math + protocol-cut config; routes the protocol's slice of every fee to the treasury. |
| `src/adapters/LighterAdapter.sol` | Wraps the Lighter deposit/withdraw bridge for the vault's sub-account **and** serves as the v1 NAV oracle read by `EigenVault.totalAssets()`. |
| `src/SkillRegistry.sol` | **NemoClaw Shell custody plane.** Per-vault public skill-hash allowlist (builder-gated) + per-order/NAV heartbeat anchor (teeWallet-gated). Realizes the "Shell wraps a mutable Agent" trust model. |
| `interfaces/*` | Clean NatSpec interfaces (`IVaultFactory`, `IEigenVault`, `IAttestationRegistry` + `IAttestationVerifier`, `IFeeAccountant`, `adapters/ILighterAdapter`, `ISkillRegistry`). |

The custody plane is **five core contracts + one** (`SkillRegistry`). The
SkillRegistry is permissionless and **decoupled** — no constructor deps, no factory
wiring — so it implements the Shell/Agent transparency model independently of the
vault accounting stack.

Test doubles live in `test/mocks/`: `MockUSDC` (6dp), `MockLighterBridge`
(custodies bridged collateral, lets a NAV be simulated), `MockAttestationVerifier`
(trivial onchain-stub verifier).

---

## Install

forge-std and OpenZeppelin v5 are vendored under `lib/` via `forge install`
(the `lib/` directory is git-ignored — reinstall after a fresh clone). Pin OZ to a
**v5.x** tag so the ERC-4626 / `Ownable(owner_)` surface matches the code:

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0
```

Remappings (`remappings.txt` / `foundry.toml`):

```
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
forge-std/=lib/forge-std/src/
```

> The code targets **OpenZeppelin v5** ERC-4626. `via_ir = true` is enabled in
> `foundry.toml` because the factory's wide `EigenVault` constructor otherwise
> hits "stack too deep".

## Build & Test

```bash
forge build
forge test -vvv
```

13 tests across three suites:

- `test/VaultLifecycle.t.sol` — `createVault → deposit → bridgeToLighter → NAV up
  (simulated profit) → accrueTxFee → realizePerfFee → investor redeem → builder/
  treasury redeem fee shares`. Asserts USDC accounting closes to dust and the fee
  split matches `protocolCutBps`.
- `test/ImageRotation.t.sol` — the **evil-builder** case: `proposeImage` opens the
  window; `acceptImage` reverts before it elapses; bridge authority does **not**
  change until `acceptImage`; investors redeem at the last HWM during the window.
- `test/Access.t.sol` — non-`teeWallet` callers cannot bridge, accrue fees, or
  push NAV.

---

## Deploy

`script/Deploy.s.sol` deploys `FeeAccountant`, an attestation verifier (onchain
stub unless one is supplied), `AttestationRegistry`, `LighterAdapter`,
`VaultFactory`, and `SkillRegistry`, then wires the factory as the registry's
first-binder. The `SkillRegistry` takes no constructor args and needs no wiring.

### Address-wiring env vars

| Var | Required | Meaning |
|---|---|---|
| `GOVERNANCE` | ✅ | Owner of `FeeAccountant` / `AttestationRegistry` / `VaultFactory`. |
| `TREASURY` | ✅ | Recipient of the protocol cut of all fees. |
| `USDC` | ✅ | USDC token address on the target chain. |
| `LIGHTER_BRIDGE` | ✅ | Lighter deposit/withdraw bridge address. |
| `ATTESTATION_VERIFIER` | optional | Verifier address. If unset, a `MockAttestationVerifier` (onchain stub) is deployed. |
| `PROTOCOL_CUT_BPS` | optional | Protocol cut of each fee, in bps. Default `1000` (10%). |
| `ROTATION_WINDOW` | optional | Image-rotation redemption window, seconds. Default `86400` (24h). |

```bash
export GOVERNANCE=0x...
export TREASURY=0x...
export USDC=0x...
export LIGHTER_BRIDGE=0x...
# optional: ATTESTATION_VERIFIER, PROTOCOL_CUT_BPS, ROTATION_WINDOW

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

The script logs every deployed address. If the deployer is **not** `GOVERNANCE`,
it skips `registry.setFactory(...)` and prints the call to make from governance.

---

## Design notes

### The Shell wraps a mutable Agent (`SkillRegistry`)

Each vault runs inside an EigenCompute TEE. The attested, on-chain-pinned artifact
is the **NemoClaw Shell** — open-source and *measured* — which is exactly what
`AttestationRegistry.imageOf(vault)` pins. Inside the shell runs a deployer-owned,
**secret, mutable Agent**: its mandate prompt, skills, models, and MCP wiring. The
agent is the builder's edge and is intentionally not published.

The measured **shell is the trust boundary** that makes a secret, mutable agent
safe for investors:

1. **Policy enforcement.** The shell enforces the vault's published
   policy/leverage/concentration limits regardless of agent content, and the agent
   can only reach Lighter through the shell's gateway (mirrored on-chain by the
   `teeWallet`-gated bridge moves). A mutated agent still cannot exceed the vault's
   limits.
2. **Skill allowlisting (transparency without disclosure).** The shell
   hash-checks every skill the agent loads against `SkillRegistry`'s **public**
   per-vault allowlist. Investors can therefore see *when* the skill set changes —
   the hashes and `SkillAllowed`/`SkillRevoked` events are public — but **not** the
   skill content, which stays sealed inside the TEE. The agent is mutable
   *precisely because* the shell refuses to load any skill whose hash is not
   allowlisted here.
3. **Heartbeat / attestation anchor.** The live shell posts `heartbeat(vault,
   ordersRoot, navRoot, attestation)`, anchoring its off-chain per-order
   attestation stream (committed as a periodic `ordersRoot`) and the NAV reading
   (`navRoot`) on-chain.

**Authority** is read live from the vault, so the registry needs no wiring:

- `allowSkill` / `revokeSkill` are gated to `IEigenVault(vault).builder()` (the
  deployer who owns and curates the secret agent).
- `heartbeat` is gated to `IEigenVault(vault).teeWallet()` (only the live, attested
  shell). Because authority is read live, an **image rotation** that swaps
  `teeWallet` automatically rotates who may heartbeat.

API (mirrored ABI-for-ABI by the off-chain Python client, see `ISkillRegistry`):

```
allowSkill(address vault, bytes32 skillHash, string uri)   // builder-only
revokeSkill(address vault, bytes32 skillHash)              // builder-only, reverts if absent
isAllowedSkill(address vault, bytes32 skillHash) -> bool
skillHashes(address vault) -> bytes32[]                    // enumerate allowlist
heartbeat(address vault, bytes32 ordersRoot, bytes32 navRoot, bytes attestation)  // teeWallet-only
```

The skill set is held as a per-vault enumerable set (membership mapping +
swap-and-pop array) so `skillHashes` enumerates and `revokeSkill` is O(1). Custom
errors: `NotBuilder`, `NotTeeWallet`, `SkillNotFound`.

### ERC-4626 override surface (OZ v5)

- `totalAssets()` = `USDC.balanceOf(vault)` + `adapter.navOf(vault)`. The Lighter
  sub-account value is reported by the NAV oracle, so share price reflects both
  on-chain idle USDC and capital deployed at the venue.
- `_decimalsOffset()` returns **6**, so shares carry 6 extra decimals over USDC
  (`decimals() == 12`). This is the standard OZ inflation/donation-attack defense.
- The high-water mark is stored as **assets-per-share scaled by `1e18`**
  (`highWaterMarkPps`), computed through the same virtual-offset math as ERC-4626
  so it is well-defined at zero supply and donation-resistant.

### Fees

- **Per-trade** (`txFeeBps`): on `accrueTxFee(notional)` (teeWallet-only), the fee
  in USDC = `notional * txFeeBps / 1e4` is converted to shares at the current
  price and minted to the builder, with `protocolCutBps` routed to the treasury.
  Because no new assets arrive, the mint dilutes existing holders by the fee — the
  intended "fee is a claim on the vault" semantics.
- **Performance** (`perfFeeBps`): HWM-based. `realizePerfFee()` charges
  `perfFeeBps` of the profit earned **above** the stored HWM (in share-price
  terms), mints the corresponding shares to builder + treasury, and advances the
  HWM. It is also crystallized inside `_withdraw`, so exiting investors pay their
  share of accrued performance before their payout is computed. Re-realizing
  without new gains mints nothing (no double-charge). `realizePerfFee` is
  permissionless: it can only ever mint the builder's own fee, so anyone may poke
  it.

### Trade-authority invariants

- Only `teeWallet` can `bridgeToLighter` / `bridgeFromLighter` / `accrueTxFee`.
- Funds can only ever move **vault ↔ this vault's own Lighter sub-account**, never
  to an arbitrary address — so a leaked TEE key cannot drain the vault, only move
  capital between the two legs. Bridge calls are `nonReentrant`.
- `imageHash` / `teeWallet` are immutable per epoch. `proposeImage` (builder-only)
  opens the `rotationWindow`; `acceptImage` reverts until the window elapses, and
  authority does **not** change in the meantime — investors get a full window to
  redeem at the last HWM before the new strategy takes over.

### AttestationRegistry verifier: two paths

The design doc (§3, threat model) leaves the attestation-verifier choice open:

- **Path A — AVS-backed light verifier.** Trust an EigenLayer AVS that posts
  attestation results onchain. Cheap gas; adds a trust hop on AVS availability.
- **Path B — fully-onchain verifier.** Verify the EigenCompute KMS signature over
  `(imageHash, teeWallet)` directly against a known KMS root. Heavier gas; no
  extra trust hop.

**This package implements the onchain-stub of Path B**: `AttestationRegistry`
delegates to a pluggable `IAttestationVerifier`. The shipped
`MockAttestationVerifier` accepts all bindings (suitable for v1 / testing); a
production deployment swaps in a verifier that checks the real KMS signature (Path
B) — or one that consults an AVS result (Path A) — via `registry.setVerifier(...)`
**without touching the registry's binding/storage logic**. Binding authority is
gated: the factory performs a vault's first bind; only the vault itself may re-bind
on rotation.

### NAV oracle

v1 NAV is **TEE-pushed**: `LighterAdapter.pushNav(vault, nav)` is gated to the
vault's current `teeWallet` (same trust root as the attestation). v2 would replace
`navOf` with a Lighter-native ZK proof of sub-account balance — only the adapter
changes, not the vault.

---

## TODOs / assumptions

- **Verifier is a stub.** `MockAttestationVerifier` accepts everything; the real
  KMS-signature (or AVS) verifier is not implemented. `VaultFactory.createVault`
  passes an empty attestation token — production must thread a genuine token
  through `VaultParams` and a real verifier.
- **Synchronous bridge.** `MockLighterBridge` settles deposits/withdrawals
  instantly. Real Lighter withdrawals are async (queue); the off-chain runtime
  drives `bridgeFromLighter` ahead of redemptions (see the deposit→trade→exit
  webhook step in the root README).
- **No redemption queue.** Investors redeem synchronously against idle vault USDC;
  if idle USDC is insufficient the runtime must `bridgeFromLighter` first. A
  NAV-snapshot redemption queue (threat-model mitigation for deposit/withdraw
  front-running) is left for a later iteration.
- **Fees are uncapped** by design (builder-set); only the protocol's *cut* of fees
  is bounded (`MAX_PROTOCOL_CUT_BPS = 50%`).
- **Sub-account id = vault address** in this v1 adapter model.
