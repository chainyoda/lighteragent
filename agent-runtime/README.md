# agent-runtime — LighterClaw execution plane

This directory is the **execution plane** of LighterClaw: the deterministic
trading agent that runs inside an **NVIDIA NemoClaw** OpenShell sandbox on an
**EigenCompute** TEE, deployed via the `ecloud` CLI. It wraps the
`eigenstrategies_sdk` runtime and the chosen strategy (default: the
delta-neutral funding-carry reference agent) into a single attested image.

```
agent-runtime/
├── Dockerfile              # linux/amd64 image (EigenCompute attests its digest = IMAGE_HASH)
├── nemoclaw.policy.yaml    # OpenShell sandbox policy: deny-all egress except Lighter + RPC
├── entrypoint.py           # boots healthcheck, resolves strategy, calls run_agent(...)
├── healthcheck.py          # stdlib HTTP liveness/health probe server ($PORT, default 8080)
├── funding_carry.py        # default strategy shim exposing build() (mirrors agents/funding-carry)
├── requirements.txt        # deps note (the SDK is pip-installed from ./agent-sdk in the Dockerfile)
└── README.md               # this file
```

The on-chain side (VaultFactory / EigenVault / AttestationRegistry) lives in
`contracts/`; the deployment pipeline that ties image → vault lives in
`deploy/`.

---

## Architecture

```
        ┌─────────────────────── EigenCompute TEE ───────────────────────┐
        │                                                                 │
        │   ┌──────────── NemoClaw OpenShell sandbox ────────────┐        │
        │   │  nemoclaw.policy.yaml: deny-all egress + RO rootfs  │        │
        │   │                                                     │        │
        │   │   entrypoint.py                                     │        │
        │   │     ├─ healthcheck.py  ── :8080 /healthz ───────────┼──► EigenCompute / NemoClaw probe
        │   │     └─ eigenstrategies_sdk.run_agent(strategy)      │        │
        │   │           ├─ VaultClient (web3) ──┐                 │        │
        │   │           └─ LighterClient (httpx)│                 │        │
        │   └───────────────────────────────────┼─────────────────┘        │
        │   KMS-injected secret (mnemonic, RO) ──┘                 │        │
        └──────────────────────────┬──────────────┬───────────────┘
                                   │ (a) 443       │ (b) 443
                                   ▼               ▼
                    mainnet.zklighter.elliot.ai   L2 RPC host
                    (Lighter API + signer)        (vault txs)
```

`run_agent` (in `agent-sdk/eigenstrategies_sdk/runtime.py`) owns the trade loop.
This package only:

1. starts the healthcheck server so probes pass during boot,
2. resolves which strategy to run (`$STRATEGY_MODULE`, default `funding_carry`),
3. instruments the strategy's `decide()` to heartbeat the health server, then
4. hands off to `run_agent(strategy, markets, guardrails)`.

The SDK then, inside the TEE: reads the KMS mnemonic, derives the TEE wallet,
binds the attestation to the vault via `AttestationRegistry.bind`, connects to
Lighter with the pre-registered API key, and loops
`fetch_state → decide → guardrails → submit → accrueTxFee`.

---

## NemoClaw threat model (defense-in-depth with the contract gating)

LighterClaw has **two independent walls**, and a compromise has to beat both:

| Wall | Enforced by | Guarantees |
|---|---|---|
| **On-chain custody** | `EigenVault` (teeWallet-gated `bridgeToLighter`/`bridgeFromLighter`) | Funds can only move `vault ↔ Lighter sub-account ↔ vault`. Even with the TEE key, you can't drain to an arbitrary address. |
| **Sandbox isolation** | NemoClaw OpenShell policy (`nemoclaw.policy.yaml`) | The process can reach **only** the Lighter host(s) and the RPC host. A compromised strategy can't exfiltrate the KMS mnemonic / TEE key, beacon to a C2, hit the cloud metadata service, or call a model endpoint. |
| **In-TEE risk** | `Guardrails.apply()` between `decide()` and submit | No order the strategy emits can exceed the vault's published caps (leverage, notional, drawdown circuit-breaker). |

The contract wall stops fund theft; the sandbox wall stops **key/secret
exfiltration and arbitrary network use**. Each closes a gap the other can't:
the contract can't stop a beacon that leaks the mnemonic out-of-band, and the
sandbox can't stop an on-chain call that's nominally "allowed" — together they
do.

### What the sandbox policy enforces (see `nemoclaw.policy.yaml` for per-rule comments)

- **Egress:** `defaultEgress: deny`. Allowlist = exactly the Lighter API host(s)
  (`mainnet`/`testnet.zklighter.elliot.ai`) and `${RPC_HOST}` (extracted from
  `RPC_URL` at deploy time), port 443 only. DNS is allowlist-only (no
  DNS-tunnel exfil). Cloud metadata (169.254.169.254), package mirrors, and any
  model/inference endpoint are explicitly denied.
- **Inference:** `enabled: false`, `denyModelEgress: true`. This is a
  deterministic trading agent — no LLM, so the managed-inference egress path is
  off and can't become an exfil channel.
- **Filesystem:** read-only rootfs; one 64Mi `noexec` tmpfs at `/tmp`; the KMS
  mnemonic mounted **read-only** at `/run/secrets/kms`; attestation token
  read-only at `/run/attestation`.
- **Process/syscalls:** non-root (UID 10001), `noNewPrivileges`, **drop ALL**
  capabilities, default-deny seccomp with `ptrace`/`bpf`/`process_vm_*`/`mount`
  etc. blocked.
- **Env scrubbing:** only the env-contract variables below are forwarded;
  anything else is dropped before exec.

---

## Env var contract

These are injected by EigenCompute KMS / `deploy/eigencompute.app.yaml`, not
baked into the image. Names match the SDK exactly
(`runtime.py`, `lighter_client.py`, `vault_client.py`, `guardrails.py`).

### Identity / attestation (read by the SDK runtime + VaultClient)
| Var | Source | Meaning |
|---|---|---|
| `MNEMONIC` | KMS | TEE wallet seed (the KMS secret). Mounted read-only. |
| `TEE_PRIVATE_KEY` | KMS / derived | Private key that signs vault txs (`VaultClient`). |
| `IMAGE_HASH` | EigenCompute | Attested digest of this image; bound on-chain. |
| `ATTESTATION_TOKEN_PATH` | EigenCompute | Path to the attestation token (`/run/attestation/token`). |
| `VAULT_ADDRESS` | deploy | The `EigenVault` this agent trades for. |
| `RPC_URL` | deploy | L2 RPC; its host is the only RPC egress allowed. |
| `ATTESTATION_REGISTRY` | deploy | `AttestationRegistry` address for `bind`. |

### Lighter (read by `LighterClient.from_env`)
| Var | Meaning |
|---|---|
| `LIGHTER_API_KEY` | Private key of the API key the builder pre-registered for the TEE wallet. **Never logged.** |
| `LIGHTER_ACCOUNT_INDEX` | The vault's Lighter account index. |
| `LIGHTER_SUBACCOUNT_INDEX` | Sub-account index (default 0). |
| `USE_TESTNET` | `1` → testnet host, else mainnet. |

### Strategy + guardrails (read by entrypoint + `Guardrails.from_env`)
| Var | Meaning |
|---|---|
| `STRATEGY_MODULE` | Module to load (default `funding_carry`). |
| `PORT` | Healthcheck port (default 8080). |
| `LIVENESS_TIMEOUT_S` | Max seconds between ticks before `/healthz` is 503 (default 180). |
| `GUARD_ALLOWED_MARKETS`, `GUARD_MAX_LEVERAGE`, `GUARD_MAX_GROSS_NOTIONAL`, `GUARD_MAX_NOTIONAL_PER_ORDER`, `GUARD_MAX_NOTIONAL_PER_MARKET`, `GUARD_MIN_FREE_COLLATERAL`, `GUARD_MAX_ORDERS_PER_TICK`, `GUARD_MAX_DRAWDOWN_PCT`, `GUARD_FLATTEN_ON_HALT` | The vault's published risk caps, enforced in-TEE. Used only when the strategy doesn't supply its own `Guardrails` (the funding-carry default does). |

> Note: the default `funding_carry` strategy supplies its **own** `Guardrails`
> via `build()`, so the `GUARD_*` env is the fallback path for strategies that
> defer to the vault's published caps (`Guardrails.from_env()`).

---

## Attestation → teeWallet → Lighter API-key registration flow

```
1. docker build  ─────────────►  image digest D
2. ecloud compute app deploy  ─►  EigenCompute attests D
                                   ├─ IMAGE_HASH        = D
                                   ├─ attestation token (→ ATTESTATION_TOKEN_PATH)
                                   └─ teeWallet W = KMS-derived(D)   (MNEMONIC injected)
3. VaultFactory.createVault(imageHash=D, teeWallet=W, fees, metadata)
       └─ deploys EigenVault, AttestationRegistry pins (vault → D, W)
4. Agent boots in-TEE:
       a. run_agent reads MNEMONIC/IMAGE_HASH, derives W (eth_account)
       b. VaultClient.bind_attestation(D, vault, token) → AttestationRegistry.bind  (one-time)
       c. The API key registered against W on the vault's Lighter sub-account
          (LIGHTER_API_KEY) signs every order via LighterClient's SignerClient.
5. Loop: bridgeToLighter → fetch_state → decide → guardrails → submit → accrueTxFee.
```

The chain of trust: **image digest → KMS wallet → on-chain pin → Lighter
signing authority**. Because `teeWallet = f(imageHash)`, an investor reading the
pinned `imageHash` can verify exactly which code holds the only key allowed to
trade and (per the vault contract) move funds.

---

## Build / run

```bash
# Build context MUST be the repo root (to COPY ./agent-sdk).
docker build --platform linux/amd64 -f agent-runtime/Dockerfile -t lighterclaw-agent:latest .

# Local smoke test of the health server only (no KMS/attestation needed):
docker run --rm -p 8080:8080 -e STRATEGY_MODULE=funding_carry lighterclaw-agent:latest &
curl -s localhost:8080/healthz | jq .
```

Full deploy (build → EigenCompute → createVault) is automated in
[`deploy/deploy.sh`](../deploy/deploy.sh); see [`deploy/README.md`](../deploy/README.md).

---

## Assumptions / TODOs

- **OpenShell manifest schema:** field names in `nemoclaw.policy.yaml`
  (`spec.network.egress.allow[].host`, `spec.inference.denyModelEgress`, etc.)
  follow the documented NemoClaw allowlist model; confirm exact keys against
  the pinned NemoClaw release before production.
- **`${RPC_HOST}` substitution:** `deploy.sh` extracts the host from `RPC_URL`
  and substitutes it into both the DNS allowlist and the egress rule. If your
  RPC provider load-balances across multiple hosts, widen the allowlist
  accordingly (still no wildcards).
- **Lighter host:** both mainnet and testnet hosts are allowlisted so flipping
  `USE_TESTNET` needs no policy change; tighten to one if you want strict
  parity with the deployed network.
- **API-key registration:** this runtime assumes `LIGHTER_API_KEY` is
  **pre-registered** by the builder (per the SDK). If you want the agent to
  self-register the API key on boot, that handshake also goes to the Lighter
  host (already allowlisted).
