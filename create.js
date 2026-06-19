// Mock compile + deploy flow for the Create page.
// In prod this would: POST prose to a compiler service (LLM-backed,
// runs in TEE), receive Strategy.py + Dockerfile, push to EigenCompute,
// return image hash + TEE wallet. Here we simulate the flow with
// deterministic hashes so the UI feels real.

const EXAMPLES = {
  funding: `When BTC and ETH funding rates diverge by more than 12 bps over an 8-hour window, go long the lower-funding side and short the higher-funding side, sized in equal notional. Close the pair when the spread compresses below 4 bps. Cap each pair at $5,000 notional. Stay delta-neutral; no leverage.`,
  momentum: `Run a 1-hour momentum signal on BTC, ETH, and SOL perps. Long markets where the 4-hour return is above +1.5% AND the 24-hour return is positive. Short markets where the 4-hour return is below -1.5% AND the 24-hour return is negative. Risk-parity sizing across positions. Hard stop at -3% per position. Max leverage 2x.`,
  meanrev: `Watch ETH-PERP on a 5-minute timeframe. Compute Bollinger Bands with a 20-period moving average and 2 standard deviations. When price touches the lower band and RSI is below 30, go long. When price touches the upper band and RSI is above 70, go short. Exit on a return to the moving average. Hard stop at -1.2%.`,
};

const proseEl = () => document.getElementById("strategy-prose");
const statusEl = () => document.getElementById("deploy-status");
const logEl = () => document.getElementById("deploy-log");
const attCard = () => document.getElementById("attestation-card");
const createBtn = () => document.getElementById("create-vault-btn");
const editorStatus = () => document.getElementById("editor-status");

function setStatus(text, color = "muted") {
  const el = statusEl();
  el.textContent = text;
  el.style.color = color === "primary" ? "oklch(var(--primary))"
    : color === "destructive" ? "oklch(var(--destructive))"
    : "oklch(var(--muted-foreground))";
}

async function appendLog(line) {
  const el = logEl();
  el.classList.remove("hidden");
  el.textContent += (el.textContent ? "\n" : "") + line;
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  const el = logEl();
  el.textContent = "";
  el.classList.add("hidden");
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function deploy() {
  const prose = proseEl().value.trim();
  if (prose.length < 40) {
    setStatus("describe the strategy in more detail (40+ chars)", "destructive");
    return;
  }

  document.getElementById("deploy-btn").disabled = true;
  attCard().classList.add("hidden");
  clearLog();

  const steps = [
    ["Compiling natural language to Strategy.decide()", 800],
    ["Generated strategy.py (137 lines)", 400],
    ["Generated Dockerfile (linux/amd64, python:3.12-slim)", 300],
    ["Pushing image to EigenCompute registry", 1100],
    ["Building inside TEE", 1400],
    ["Provisioning KMS wallet", 700],
    ["Issuing attestation token", 600],
    ["Binding attestation onchain", 900],
  ];

  for (const [label, ms] of steps) {
    setStatus(label + "…", "primary");
    await appendLog(`$ ${label.toLowerCase()}`);
    await sleep(ms);
  }

  // Deterministic-ish mock outputs derived from the prose.
  const seed = Array.from(prose).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hex = (n, len) => n.toString(16).padStart(len, "0");
  const imageHash = "0x" + hex(seed, 8) + "9b18e4a2cd771f3c0e88d10b".slice(0, 56);
  const teeWallet = "0x" + hex(seed ^ 0xdeadbeef, 8) + "1c5704d29bb8".slice(0, 32);
  const appId = "ev-" + hex(seed, 8).slice(0, 6);

  document.getElementById("out-image-hash").textContent = imageHash.slice(0, 14) + "…" + imageHash.slice(-6);
  document.getElementById("out-tee-wallet").textContent = teeWallet.slice(0, 10) + "…" + teeWallet.slice(-6);
  document.getElementById("out-app-id").textContent = appId;
  attCard().classList.remove("hidden");

  await appendLog(`✓ image hash: ${imageHash}`);
  await appendLog(`✓ tee wallet: ${teeWallet}`);
  await appendLog(`✓ ecloud app id: ${appId}`);
  await appendLog(`✓ attestation registry bind: confirmed`);

  setStatus("agent live on EigenCompute", "primary");
  editorStatus().textContent = "deployed";

  const btn = createBtn();
  btn.disabled = false;
  btn.classList.remove("opacity-50", "cursor-not-allowed");
  btn.textContent = "Create vault for this agent";

  document.getElementById("deploy-btn").disabled = false;
  document.getElementById("deploy-btn").textContent = "Re-deploy";
}

function init() {
  document.querySelectorAll(".example-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.example;
      proseEl().value = EXAMPLES[k] || "";
      editorStatus().textContent = "loaded example";
    });
  });

  proseEl().addEventListener("input", () => {
    editorStatus().textContent = "unsaved";
  });

  document.getElementById("deploy-btn").addEventListener("click", deploy);

  createBtn().addEventListener("click", createVault);
}

async function createVault() {
  const btn = createBtn();
  if (btn.disabled) return;

  const name = document.querySelector('input[placeholder="Momentum Macro"]')?.value?.trim() || "Untitled Vault";
  const perfFee = document.querySelectorAll('input[type="number"]')[0]?.value || "2000";
  const txFee = document.querySelectorAll('input[type="number"]')[1]?.value || "8";
  const imageHash = document.getElementById("out-image-hash").textContent;
  const teeWallet = document.getElementById("out-tee-wallet").textContent;

  btn.disabled = true;
  btn.classList.add("opacity-50");
  btn.textContent = "Confirming…";

  await appendLog("");
  await appendLog("$ vaultfactory.createvault");
  await appendLog(`  name: ${name}`);
  await appendLog(`  imageHash: ${imageHash}`);
  await appendLog(`  teeWallet: ${teeWallet}`);
  await appendLog(`  perfFeeBps: ${perfFee}, txFeeBps: ${txFee}`);

  const stored = (() => { try { return JSON.parse(localStorage.getItem("eigenvaults:wallet")); } catch { return null; }})();
  const provider = window.ethereum;

  if (stored?.address && provider) {
    try {
      btn.textContent = "Awaiting wallet signature…";
      const message = [
        "EigenVaults — Create Vault",
        "",
        `Name: ${name}`,
        `Image hash: ${imageHash}`,
        `TEE wallet: ${teeWallet}`,
        `Performance fee: ${perfFee} bps`,
        `Per-trade fee: ${txFee} bps`,
        `Builder: ${stored.address}`,
        `Nonce: ${Date.now()}`,
      ].join("\n");

      await provider.request({
        method: "personal_sign",
        params: [message, stored.address],
      });
      await appendLog(`✓ signed by ${stored.address.slice(0, 6)}…${stored.address.slice(-4)}`);
    } catch (err) {
      await appendLog(`✗ user rejected signature`);
      btn.disabled = false;
      btn.classList.remove("opacity-50");
      btn.textContent = "Create vault for this agent";
      return;
    }
  } else {
    await appendLog("⚠ no wallet connected — running mock flow");
  }

  for (const [label, ms] of [
    ["Submitting tx to L2", 1000],
    ["Block confirmation", 1400],
    ["Binding to AttestationRegistry", 700],
    ["Funding Lighter sub-account allocation", 600],
  ]) {
    btn.textContent = label + "…";
    await appendLog(`$ ${label.toLowerCase()}`);
    await sleep(ms);
  }

  const seed = Array.from(name + imageHash).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11);
  const hex = (n, len) => n.toString(16).padStart(len, "0");
  const vaultAddr = "0x" + hex(seed, 8) + "f3e4Ac9d217B4E50f2C18".slice(0, 32);
  const txHash = "0x" + hex(seed ^ 0x5eed, 8) + hex(seed * 13 >>> 0, 8) + "a0b1c2d3e4f50617".slice(0, 48);

  await appendLog("");
  await appendLog(`✓ vault deployed: ${vaultAddr}`);
  await appendLog(`✓ tx: ${txHash.slice(0, 22)}…`);
  await appendLog(`✓ attestation bound · valid`);

  showSuccessCard({ name, vaultAddr, txHash });
}

function showSuccessCard({ name, vaultAddr, txHash }) {
  const btn = createBtn();
  const parent = btn.parentElement;
  btn.remove();

  const card = document.createElement("div");
  card.className = "rounded-md p-5";
  card.style.cssText = "background: oklch(var(--primary) / 0.08); border: 1px solid oklch(var(--primary) / 0.3);";
  card.innerHTML = `
    <div class="flex items-start justify-between gap-4 mb-3">
      <div>
        <div class="text-xs mono uppercase tracking-wider text-primary mb-1">Vault deployed</div>
        <div class="display text-lg font-semibold">${name}</div>
      </div>
      <span class="badge badge-attested">TEE attested</span>
    </div>
    <dl class="text-sm space-y-1.5 mb-4">
      <div class="flex justify-between gap-4"><span class="text-muted">Vault address</span><span class="mono">${vaultAddr.slice(0,10)}…${vaultAddr.slice(-6)}</span></div>
      <div class="flex justify-between gap-4"><span class="text-muted">Transaction</span><span class="mono">${txHash.slice(0,10)}…${txHash.slice(-6)}</span></div>
    </dl>
    <div class="flex gap-3">
      <a href="./vault.html?addr=${vaultAddr}" class="btn-primary flex-1 text-center px-5 py-2.5 rounded-md text-sm font-medium">View vault →</a>
      <a href="./index.html" class="px-5 py-2.5 rounded-md border border-default hover:border-[color:oklch(var(--foreground))] text-sm font-medium text-center">Back to discover</a>
    </div>
  `;
  parent.appendChild(card);

  // ensure the badge style is available even if surface CSS varies
  const style = document.createElement("style");
  style.textContent = `
    .badge { display: inline-flex; align-items: center; gap: 0.25rem;
      font-family: "Geist Mono", monospace; font-size: 0.6875rem;
      padding: 0.125rem 0.5rem; border-radius: 9999px;
      border: 1px solid oklch(var(--border)); background: oklch(var(--card));
      text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-attested { color: oklch(var(--primary));
      border-color: oklch(var(--primary) / 0.3);
      background: oklch(var(--primary) / 0.08); }
  `;
  document.head.appendChild(style);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
