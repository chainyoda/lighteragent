#!/usr/bin/env bash
# =============================================================================
# LighterClaw end-to-end deploy pipeline.
#
#   build (linux/amd64)  ->  ecloud compute app deploy (NemoClaw-sandboxed)
#                        ->  parse IMAGE_HASH + teeWallet + attestation
#                        ->  VaultFactory.createVault (cast send)
#                        ->  print vault address + live URL
#
# Idempotent and guarded. If `ecloud` is absent (or MOCK_ECLOUD=1), a clearly
# labelled MOCK emits deterministic placeholder values so the whole pipeline is
# runnable end-to-end in dev. If `cast` is absent, the createVault step is also
# mocked and the exact command you'd run is printed.
#
# Usage:
#   cp deploy/.env.example deploy/.env   # then edit
#   ./deploy/deploy.sh
# =============================================================================
set -euo pipefail

# --- locate repo root (build context) ---------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
APP_MANIFEST="${SCRIPT_DIR}/eigencompute.app.yaml"
OUT_JSON="${SCRIPT_DIR}/deploy.out.json"

step()  { echo -e "\n\033[1;36m==>\033[0m \033[1m$*\033[0m"; }
info()  { echo -e "    $*"; }
warn()  { echo -e "\033[1;33m[warn]\033[0m $*" >&2; }
die()   { echo -e "\033[1;31m[fail]\033[0m $*" >&2; exit 1; }
mock()  { echo -e "\033[1;35m[MOCK]\033[0m $*" >&2; }

# --- load env ----------------------------------------------------------------
[[ -f "${ENV_FILE}" ]] || die "missing ${ENV_FILE} — copy deploy/.env.example to deploy/.env first"
step "Loading ${ENV_FILE}"
set -a; # shellcheck disable=SC1090
source "${ENV_FILE}"; set +a

# Required vars (the pipeline can't proceed without these).
: "${IMAGE_REF:?set IMAGE_REF in deploy/.env}"
: "${IMAGE_TAG:?set IMAGE_TAG in deploy/.env}"
: "${RPC_URL:?set RPC_URL in deploy/.env}"
: "${FACTORY_ADDRESS:?set FACTORY_ADDRESS in deploy/.env}"
: "${ECLOUD_APP_NAME:?set ECLOUD_APP_NAME in deploy/.env}"
: "${NEMOCLAW_POLICY:?set NEMOCLAW_POLICY in deploy/.env}"

# Derived: the RPC host the NemoClaw policy allowlists.
RPC_HOST="$(printf '%s' "${RPC_URL}" | sed -E 's#^[a-zA-Z]+://##; s#[:/].*$##')"
export RPC_HOST
BUILDER_ADDRESS="${BUILDER_ADDRESS:-}"
PERF_FEE_BPS="${PERF_FEE_BPS:-2000}"
TX_FEE_BPS="${TX_FEE_BPS:-8}"
METADATA_URI="${METADATA_URI:-ipfs://placeholder}"
info "repo root:   ${REPO_ROOT}"
info "image:       ${IMAGE_REF}:${IMAGE_TAG}  (linux/amd64)"
info "rpc host:    ${RPC_HOST}  (NemoClaw egress allowlist)"
info "factory:     ${FACTORY_ADDRESS}"

# Decide mock-or-real for each external tool up front.
USE_MOCK_ECLOUD=0
if [[ "${MOCK_ECLOUD:-}" == "1" ]] || ! command -v ecloud >/dev/null 2>&1; then
  USE_MOCK_ECLOUD=1
fi
USE_MOCK_CAST=0
if ! command -v cast >/dev/null 2>&1; then
  USE_MOCK_CAST=1
fi

# =============================================================================
# (a) docker build (linux/amd64), context = repo root
# =============================================================================
step "(a) docker build  ${IMAGE_REF}:${IMAGE_TAG}"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker build \
    --platform linux/amd64 \
    -f "${REPO_ROOT}/agent-runtime/Dockerfile" \
    -t "${IMAGE_REF}:${IMAGE_TAG}" \
    "${REPO_ROOT}"
  # Push so EigenCompute can pull + attest. Skipped automatically if no registry
  # creds; deploy will still work against a locally-loaded image in dev.
  if [[ "${SKIP_PUSH:-0}" != "1" ]]; then
    info "pushing ${IMAGE_REF}:${IMAGE_TAG}"
    docker push "${IMAGE_REF}:${IMAGE_TAG}" || warn "docker push failed (continuing; set SKIP_PUSH=1 to silence)"
  fi
elif command -v docker >/dev/null 2>&1; then
  mock "docker daemon unreachable — skipping build. Image assumed present: ${IMAGE_REF}:${IMAGE_TAG}"
else
  mock "docker not found — skipping build. Image assumed present: ${IMAGE_REF}:${IMAGE_TAG}"
fi

# =============================================================================
# (b) ecloud compute app deploy  ->  IMAGE_HASH + attestation + teeWallet
# =============================================================================
step "(b) Deploy to EigenCompute under NemoClaw"

render_manifest() {
  # Substitute ${VARS} in the app manifest from the now-exported env. VAULT_ADDRESS
  # is empty on first pass (patched after createVault in step d).
  if command -v envsubst >/dev/null 2>&1; then
    envsubst < "${APP_MANIFEST}"
  else
    # Minimal fallback substitution if envsubst is unavailable.
    sed -e "s#\${ECLOUD_APP_NAME}#${ECLOUD_APP_NAME}#g" \
        -e "s#\${STRATEGY_MODULE}#${STRATEGY_MODULE:-funding_carry}#g" \
        -e "s#\${IMAGE_REF}#${IMAGE_REF}#g" \
        -e "s#\${IMAGE_TAG}#${IMAGE_TAG}#g" \
        -e "s#\${NEMOCLAW_POLICY}#${NEMOCLAW_POLICY}#g" \
        -e "s#\${HEALTHCHECK_PORT}#${HEALTHCHECK_PORT:-8080}#g" \
        -e "s#\${RPC_URL}#${RPC_URL}#g" \
        -e "s#\${ATTESTATION_REGISTRY}#${ATTESTATION_REGISTRY:-}#g" \
        -e "s#\${VAULT_ADDRESS}#${VAULT_ADDRESS:-}#g" \
        "${APP_MANIFEST}"
  fi
}

if [[ "${USE_MOCK_ECLOUD}" == "1" ]]; then
  mock "ecloud not found (or MOCK_ECLOUD=1) — emitting deterministic placeholders."
  # Deterministic: derive stable hex from the image ref so reruns are stable.
  HASHSEED="$(printf '%s' "${IMAGE_REF}:${IMAGE_TAG}" | (command -v sha256sum >/dev/null && sha256sum || shasum -a 256) | cut -c1-64)"
  IMAGE_HASH="0x${HASHSEED}"
  TEE_WALLET="0x$(printf '%s' "${HASHSEED}" | cut -c1-40)"
  ATTESTATION_TOKEN="MOCK_ATTESTATION_$(printf '%s' "${HASHSEED}" | cut -c1-16)"
  APP_URL="https://mock.eigencompute.local/apps/${ECLOUD_APP_NAME}"
  render_manifest > "${SCRIPT_DIR}/.rendered.app.yaml"
  info "rendered manifest -> ${SCRIPT_DIR}/.rendered.app.yaml"
else
  render_manifest > "${SCRIPT_DIR}/.rendered.app.yaml"
  info "rendered manifest -> ${SCRIPT_DIR}/.rendered.app.yaml"
  # `--output json` so we can parse the attestation result deterministically.
  # Idempotent: `deploy` updates the app in place if it already exists.
  DEPLOY_JSON="$(ecloud compute app deploy \
      --file "${SCRIPT_DIR}/.rendered.app.yaml" \
      --name "${ECLOUD_APP_NAME}" \
      --output json)"
  command -v jq >/dev/null 2>&1 || die "jq required to parse ecloud JSON output"
  # Field paths follow ecloud's documented deploy result; adjust if the CLI
  # version differs. We try a couple of common shapes.
  IMAGE_HASH="$(echo "${DEPLOY_JSON}"   | jq -r '.imageHash // .attestation.imageHash // empty')"
  TEE_WALLET="$(echo "${DEPLOY_JSON}"   | jq -r '.teeWallet // .kms.wallet // .attestation.teeWallet // empty')"
  ATTESTATION_TOKEN="$(echo "${DEPLOY_JSON}" | jq -r '.attestationToken // .attestation.token // empty')"
  APP_URL="$(echo "${DEPLOY_JSON}"      | jq -r '.url // .app.url // empty')"
  [[ -n "${IMAGE_HASH}" && -n "${TEE_WALLET}" ]] || die "could not parse imageHash/teeWallet from ecloud output:\n${DEPLOY_JSON}"
fi

info "IMAGE_HASH = ${IMAGE_HASH}"
info "teeWallet  = ${TEE_WALLET}"
info "attestation= ${ATTESTATION_TOKEN:0:24}..."
info "app URL    = ${APP_URL:-<pending>}"

# =============================================================================
# (c) VaultFactory.createVault(imageHash, teeWallet, fees, builder, metadata)
#     via cast send (Foundry). Matches IVaultFactory.createVault(VaultParams)
#     from README §1: struct VaultParams {bytes32 imageHash; address teeWallet;
#     uint16 perfFeeBps; uint16 txFeeBps; address builder; string metadataURI;}
# =============================================================================
step "(c) VaultFactory.createVault on ${RPC_HOST}"

# Default builder = deployer address if not pinned in .env.
if [[ -z "${BUILDER_ADDRESS}" ]]; then
  if [[ "${USE_MOCK_CAST}" == "0" && -n "${PRIVATE_KEY:-}" ]]; then
    BUILDER_ADDRESS="$(cast wallet address --private-key "${PRIVATE_KEY}")"
  else
    BUILDER_ADDRESS="${TEE_WALLET}"  # placeholder in mock mode
  fi
fi
info "builder    = ${BUILDER_ADDRESS}"
info "perfFeeBps = ${PERF_FEE_BPS}   txFeeBps = ${TX_FEE_BPS}"
info "metadata   = ${METADATA_URI}"

# Solidity tuple signature for the struct arg.
CREATE_SIG='createVault((bytes32,address,uint16,uint16,address,string))'
TUPLE="(${IMAGE_HASH},${TEE_WALLET},${PERF_FEE_BPS},${TX_FEE_BPS},${BUILDER_ADDRESS},${METADATA_URI})"

if [[ "${USE_MOCK_CAST}" == "1" ]]; then
  mock "cast (foundry) not found — not sending the tx. Exact command to run:"
  cat >&2 <<EOF
    cast send ${FACTORY_ADDRESS} \\
      "${CREATE_SIG}" \\
      "${TUPLE}" \\
      --rpc-url "${RPC_URL}" \\
      --private-key "\$PRIVATE_KEY" \\
      --json
EOF
  # Deterministic mock vault address derived from factory + image hash.
  VAULT_ADDRESS="0x$(printf '%s%s' "${FACTORY_ADDRESS}" "${IMAGE_HASH}" | (command -v sha256sum >/dev/null && sha256sum || shasum -a 256) | cut -c1-40)"
  mock "mock vault address = ${VAULT_ADDRESS}"
else
  : "${PRIVATE_KEY:?set PRIVATE_KEY in deploy/.env to send createVault}"
  info "sending createVault..."
  SEND_JSON="$(cast send "${FACTORY_ADDRESS}" \
      "${CREATE_SIG}" \
      "${TUPLE}" \
      --rpc-url "${RPC_URL}" \
      --private-key "${PRIVATE_KEY}" \
      --json)"
  TX_HASH="$(echo "${SEND_JSON}" | jq -r '.transactionHash')"
  info "tx: ${TX_HASH}"
  # Recover the new vault address from the VaultCreated(address,address,bytes32)
  # event. topic0 = keccak("VaultCreated(address,address,bytes32)"); the vault
  # is the first (non-indexed) arg in data, or indexed depending on the ABI.
  # We parse logs from the receipt; adjust the selector if your event differs.
  VAULT_CREATED_SIG='VaultCreated(address,address,bytes32)'
  TOPIC0="$(cast keccak "${VAULT_CREATED_SIG}")"
  VAULT_ADDRESS="$(echo "${SEND_JSON}" \
    | jq -r --arg t "${TOPIC0}" '.logs[] | select(.topics[0]==$t) | .data' \
    | head -n1 \
    | sed -E 's/^0x0{24}([0-9a-fA-F]{40}).*/0x\1/')"
  [[ -n "${VAULT_ADDRESS}" && "${VAULT_ADDRESS}" != "null" ]] \
    || warn "could not auto-parse vault address from logs; inspect tx ${TX_HASH}"
fi

# =============================================================================
# (c.2) Patch VAULT_ADDRESS back into the EigenCompute app so the agent knows
# which vault it trades for (the agent reads VAULT_ADDRESS from env).
# =============================================================================
step "(c.2) Patch VAULT_ADDRESS into the EigenCompute app"
export VAULT_ADDRESS
if [[ "${USE_MOCK_ECLOUD}" == "1" ]]; then
  mock "would run: ecloud compute app set-env ${ECLOUD_APP_NAME} VAULT_ADDRESS=${VAULT_ADDRESS}"
else
  ecloud compute app set-env "${ECLOUD_APP_NAME}" "VAULT_ADDRESS=${VAULT_ADDRESS}" \
    || warn "set-env failed; set VAULT_ADDRESS=${VAULT_ADDRESS} on the app manually"
fi

# =============================================================================
# (d) Print results + persist a machine-readable artifact.
# =============================================================================
step "(d) Done"
cat > "${OUT_JSON}" <<EOF
{
  "app": "${ECLOUD_APP_NAME}",
  "image": "${IMAGE_REF}:${IMAGE_TAG}",
  "imageHash": "${IMAGE_HASH}",
  "teeWallet": "${TEE_WALLET}",
  "vault": "${VAULT_ADDRESS}",
  "factory": "${FACTORY_ADDRESS}",
  "builder": "${BUILDER_ADDRESS}",
  "perfFeeBps": ${PERF_FEE_BPS},
  "txFeeBps": ${TX_FEE_BPS},
  "rpcHost": "${RPC_HOST}",
  "appUrl": "${APP_URL:-}",
  "mock": { "ecloud": ${USE_MOCK_ECLOUD}, "cast": ${USE_MOCK_CAST} }
}
EOF

echo
echo -e "\033[1;32m  VAULT  \033[0m ${VAULT_ADDRESS}"
echo -e "\033[1;32m  IMAGE  \033[0m ${IMAGE_HASH}"
echo -e "\033[1;32m  WALLET \033[0m ${TEE_WALLET}  (teeWallet)"
echo -e "\033[1;32m  LIVE   \033[0m ${APP_URL:-<pending>}"
echo -e "    artifact written to ${OUT_JSON}"
if [[ "${USE_MOCK_ECLOUD}" == "1" || "${USE_MOCK_CAST}" == "1" ]]; then
  echo
  warn "MOCK values were used (ecloud_mock=${USE_MOCK_ECLOUD}, cast_mock=${USE_MOCK_CAST}). Install ecloud + foundry and re-run for a real deploy."
fi
echo
info "Next: fund the vault with USDC (deposit) and it begins trading."
