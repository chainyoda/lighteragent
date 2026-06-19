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

let deployMode = "paper";
let codeDirty = false;

function readParams() {
  return {
    lev: parseFloat(document.getElementById("p-lev")?.value || 2),
    size: parseFloat(document.getElementById("p-size")?.value || 5),
    stop: parseFloat(document.getElementById("p-stop")?.value || 2),
  };
}

// Generate a plausible Strategy.decide() from the prose + params. Not a
// real compiler — but it reflects the knobs so editing feels truthful.
function generateCode(prose, params) {
  const arch = detectArchetype(prose.toLowerCase());
  const markets = /sol/i.test(prose) ? '["BTC-PERP", "ETH-PERP", "SOL-PERP"]'
    : /eth/i.test(prose) && !/btc/i.test(prose) ? '["ETH-PERP"]'
    : '["BTC-PERP", "ETH-PERP"]';
  const body = {
    funding: `        # delta-neutral funding carry
        spread = state.funding["ETH-PERP"] - state.funding["BTC-PERP"]
        if abs(spread) > self.entry_bps / 1e4 and not state.positions:
            lo, hi = ("ETH-PERP", "BTC-PERP") if spread < 0 else ("BTC-PERP", "ETH-PERP")
            n = min(self.max_notional, state.free_collateral * self.max_leverage / 2)
            yield Order(market=lo, side="long",  size=n / state.mid[lo])
            yield Order(market=hi, side="short", size=n / state.mid[hi])
        elif abs(spread) < self.exit_bps / 1e4:
            yield from self.flatten(state)`,
    momentum: `        # cross-asset momentum
        for m in self.markets:
            r4, r24 = state.ret(m, "4h"), state.ret(m, "24h")
            if r4 > self.thresh and r24 > 0:
                yield self.target(state, m, +1)
            elif r4 < -self.thresh and r24 < 0:
                yield self.target(state, m, -1)`,
    meanrev: `        # bollinger mean reversion
        m = self.markets[0]
        bb = state.bollinger(m, 20, 2)
        rsi = state.rsi(m, 14)
        if state.mid[m] <= bb.lower and rsi < 30:
            yield self.target(state, m, +1)
        elif state.mid[m] >= bb.upper and rsi > 70:
            yield self.target(state, m, -1)
        elif state.crossed(m, bb.mid):
            yield from self.flatten(state)`,
    mm: `        # two-sided passive quoting
        for m in self.markets:
            skew = self.inventory_skew(state, m)
            yield Order(market=m, side="long",  size=self.clip, price=state.bid(m) - self.half_spread + skew, post_only=True)
            yield Order(market=m, side="short", size=self.clip, price=state.ask(m) + self.half_spread + skew, post_only=True)`,
    generic: `        # entry/exit derived from your description
        for m in self.markets:
            if self.signal(state, m) > 0 and not state.position(m):
                yield self.target(state, m, +1)
            elif self.signal(state, m) < 0 and state.position(m).is_long:
                yield from self.flatten(state, m)`,
  }[arch];

  return `from decimal import Decimal
from eigenstrategies_sdk import Strategy, MarketState, Order

class CompiledStrategy(Strategy):
    """Compiled from natural language. Edit freely — the edited source
    is what gets hashed and attested in the TEE."""
    tick_seconds   = 30
    markets        = ${markets}
    max_leverage   = Decimal("${params.lev.toFixed(1)}")
    max_notional   = Decimal("${(params.size * 1000).toFixed(0)}")   # per trade, USDC
    stop_loss      = Decimal("${(params.stop / 100).toFixed(4)}")    # ${params.stop.toFixed(1)}%
    entry_bps, exit_bps, thresh = 12, 4, Decimal("0.015")

    def decide(self, state: MarketState):
${body}

    def target(self, state, market, sign):
        n = min(self.max_notional, state.free_collateral * self.max_leverage)
        return Order(market=market, side="long" if sign > 0 else "short",
                     size=Decimal(n) / state.mid[market], stop_loss=self.stop_loss)
`;
}

function markCodeDirty(on) {
  codeDirty = on;
  const b = document.getElementById("code-dirty");
  if (b) b.classList.toggle("hidden", !on);
}

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

function seedFrom(s) {
  return Array.from(s).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
}
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function detectArchetype(proseLower) {
  if (/funding|carry|delta-neutral|delta neutral|basis/.test(proseLower)) return "funding";
  if (/momentum|breakout|trend/.test(proseLower)) return "momentum";
  if (/mean[- ]?revert|bollinger|rsi/.test(proseLower)) return "meanrev";
  if (/quote|spread|market.?mak/.test(proseLower)) return "mm";
  return "generic";
}

function simulateEquity(prose, days, params = {}) {
  const lev = params.lev ?? 2, stop = params.stop ?? 2, size = params.size ?? 5;
  const seed = seedFrom(prose + ":" + days + ":" + lev + ":" + stop + ":" + size);
  const rand = mulberry32(seed);
  const arch = detectArchetype(prose.toLowerCase());

  // Tilt parameters by detected strategy archetype
  let drift = 0.0006, vol = 0.012, turnPerDay = 0.45;
  if (arch === "funding") { drift = 0.0008; vol = 0.0045; turnPerDay = 0.25; }
  else if (arch === "momentum") { drift = 0.0012; vol = 0.018; turnPerDay = 0.5; }
  else if (arch === "meanrev") { drift = 0.0007; vol = 0.014; turnPerDay = 0.85; }
  else if (arch === "mm") { drift = 0.0006; vol = 0.009; turnPerDay = 1.0; }

  // Parameters reshape the curve: leverage scales both edge & risk;
  // a tighter stop clips vol but shaves a little drift.
  drift *= (0.6 + rand() * 0.9) * (0.7 + lev * 0.18);
  vol *= (0.7 + rand() * 0.8) * (0.6 + lev * 0.22) * (0.7 + stop * 0.1);

  const equity = [1.0];
  let trades = 0, wins = 0, grossNotional = 0;
  for (let i = 1; i < days; i++) {
    const z = (rand() + rand() + rand() + rand() + rand() + rand() - 3) / 1.7; // ~normal
    let ret = drift + vol * z;
    if (ret < -stop / 100) ret = -stop / 100; // stop-loss clip
    equity.push(Math.max(0.05, equity[i - 1] * (1 + ret)));
    if (rand() < turnPerDay) { trades += 1; grossNotional += size * 1000 * (0.5 + rand()); if (ret > 0) wins += 1; }
  }

  const totalReturn = equity[equity.length - 1] - 1;
  const dailyRets = equity.slice(1).map((v, i) => v / equity[i] - 1);
  const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
  const stdev = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRets.length);
  const sharpe = (mean / (stdev || 1)) * Math.sqrt(365);
  let peak = equity[0], mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  const winRate = trades ? wins / trades : 0;
  const turnover = trades / days; // round-trips per day
  return { equity, dailyRets, totalReturn, sharpe, mdd, winRate, trades, turnover, arch };
}

// Split the run into market regimes (trending up / chop / down) by the
// rolling slope of equity, and report return contribution in each.
function regimeBreakdown(equity) {
  const buckets = { up: 0, chop: 0, down: 0 };
  const win = 5;
  for (let i = win; i < equity.length; i++) {
    const slope = (equity[i] - equity[i - win]) / equity[i - win];
    const ret = equity[i] / equity[i - 1] - 1;
    if (slope > 0.01) buckets.up += ret;
    else if (slope < -0.01) buckets.down += ret;
    else buckets.chop += ret;
  }
  return buckets;
}

function drawEquity(equity) {
  const w = 760, h = 160;
  const min = Math.min(...equity), max = Math.max(...equity);
  const span = max - min || 1;
  const path = equity.map((v, i) => {
    const x = (i / (equity.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 16) - 8;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = path + ` L${w},${h} L0,${h} Z`;
  document.getElementById("bt-line").setAttribute("d", path);
  document.getElementById("bt-area").setAttribute("d", area);
}

let lastBacktestSeed = null;
let lastBacktestResult = null;
let earnProjectionUpdate = null;

async function runBacktest() {
  const prose = proseEl().value.trim();
  if (prose.length < 20) {
    setStatus("describe the strategy first", "destructive");
    return;
  }
  const days = parseInt(document.getElementById("bt-window").value, 10);
  const card = document.getElementById("backtest-card");
  card.classList.remove("hidden");

  // Show "running" feel
  const btn = document.getElementById("backtest-btn");
  btn.disabled = true;
  btn.textContent = "Running…";
  setStatus(`backtesting against ${days}d of Lighter history…`, "primary");
  document.getElementById("bt-attest").classList.add("hidden");
  await sleep(900);

  const params = readParams();
  const r = simulateEquity(prose, days, params);
  drawEquity(r.equity);

  const today = new Date(2026, 5, 19); // June 19 2026 to match session date
  const start = new Date(today.getTime() - days * 86400000);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  document.getElementById("bt-period").textContent = `${fmt(start)} → ${fmt(today)}`;

  const pct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  const ret = document.getElementById("bt-return");
  ret.textContent = pct(r.totalReturn);
  ret.style.color = r.totalReturn >= 0 ? "oklch(var(--primary))" : "oklch(var(--destructive))";
  document.getElementById("bt-sharpe").textContent = r.sharpe.toFixed(2);
  document.getElementById("bt-mdd").textContent = pct(r.mdd);
  document.getElementById("bt-winrate").textContent = `${(r.winRate * 100).toFixed(0)}%`;
  document.getElementById("bt-trades").textContent = String(r.trades);

  // turnover + fee drag (uses a representative 8 bps tx fee)
  document.getElementById("bt-turnover").textContent = r.turnover.toFixed(2) + "×/d";
  const feeDrag = r.turnover * 365 * (8 / 10000);
  document.getElementById("bt-feedrag").textContent = "-" + (feeDrag * 100).toFixed(1) + "%";

  // regime breakdown bars
  const reg = regimeBreakdown(r.equity);
  const maxReg = Math.max(0.0001, ...Object.values(reg).map(Math.abs));
  const regLabels = { up: "Trending", chop: "Chop", down: "Down" };
  document.getElementById("bt-regime").innerHTML = Object.entries(reg).map(([k, val]) => {
    const w = Math.round((Math.abs(val) / maxReg) * 100);
    const col = val >= 0 ? "oklch(var(--primary))" : "oklch(var(--destructive))";
    return `<div class="flex items-center gap-2 text-xs"><span class="text-muted w-16">${regLabels[k]}</span>
      <div style="flex:1;height:8px;background:oklch(var(--well));border-radius:999px;overflow:hidden"><div style="height:100%;width:${w}%;background:${col};border-radius:999px"></div></div>
      <span class="mono w-12 text-right">${pct(val)}</span></div>`;
  }).join("");

  // walk-forward: in-sample (first 70%) vs out-of-sample (last 30%)
  const splitIdx = Math.floor(r.equity.length * 0.7);
  const isRet = r.equity[splitIdx] / r.equity[0] - 1;
  const oosRet = r.equity[r.equity.length - 1] / r.equity[splitIdx] - 1;
  // annualize both for comparability
  const isApr = isRet * (365 / splitIdx);
  const oosApr = oosRet * (365 / (r.equity.length - splitIdx));
  document.getElementById("bt-is").textContent = pct(isApr) + " apr";
  document.getElementById("bt-oos").textContent = pct(oosApr) + " apr";
  const decay = isApr !== 0 ? oosApr / isApr : 1;
  const over = document.getElementById("bt-overfit");
  if (decay > 0.6) { over.textContent = "✓ holds up out-of-sample"; over.style.color = "oklch(var(--primary))"; }
  else if (decay > 0.2) { over.textContent = "~ some decay out-of-sample"; over.style.color = "oklch(var(--accent))"; }
  else { over.textContent = "⚠ likely overfit — weak out-of-sample"; over.style.color = "oklch(var(--destructive))"; }

  // sensitivity: perturb stop-loss ±, plot resulting total returns
  drawSensitivity(prose, days, params);

  document.getElementById("bt-attest").classList.remove("hidden");

  // generated code panel
  if (!codeDirty) {
    document.getElementById("code-editor").value = generateCode(prose, params);
    document.getElementById("code-card").classList.remove("hidden");
  }

  lastBacktestSeed = seedFrom(prose + JSON.stringify(params));
  lastBacktestResult = r;
  if (earnProjectionUpdate) earnProjectionUpdate();
  setStatus(`backtest complete · sharpe ${r.sharpe.toFixed(2)} · oos ${pct(oosApr)}`, "primary");

  btn.disabled = false;
  btn.textContent = "Re-run backtest";
}

function drawSensitivity(prose, days, params) {
  const host = document.getElementById("bt-sens");
  const stops = [-0.6, -0.3, 0, 0.3, 0.6].map((d) => Math.max(0.5, params.stop + d));
  const rets = stops.map((s) => simulateEquity(prose, days, { ...params, stop: s }).totalReturn);
  const w = 200, h = 56, min = Math.min(...rets, 0), max = Math.max(...rets, 0.001), span = max - min || 1;
  const pts = rets.map((v, i) => {
    const x = (i / (rets.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 8) - 4;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="w-full" style="height:${h}px">
    <path d="${pts}" fill="none" stroke="oklch(0.475 0.095 158)" stroke-width="2"/>
    ${rets.map((v, i) => `<circle cx="${(i / (rets.length - 1)) * w}" cy="${h - ((v - min) / span) * (h - 8) - 4}" r="2.5" fill="oklch(0.475 0.095 158)"/>`).join("")}
  </svg>`;
}

async function deploy() {
  const prose = proseEl().value.trim();
  if (prose.length < 40) {
    setStatus("describe the strategy in more detail (40+ chars)", "destructive");
    return;
  }

  if (lastBacktestSeed !== seedFrom(prose)) {
    const ok = confirm("You haven't backtested this strategy. Deploy anyway?");
    if (!ok) return;
  }

  document.getElementById("deploy-btn").disabled = true;
  attCard().classList.add("hidden");
  clearLog();
  await appendLog(deployMode === "paper"
    ? "$ deploy mode: PAPER — simulated Lighter sub-account, no real funds"
    : "$ deploy mode: LIVE — mainnet funds via TEE wallet");
  if (codeDirty) await appendLog("$ using edited strategy.py from the code panel");

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

  setStatus(`agent live on EigenCompute · ${deployMode} mode`, "primary");
  editorStatus().textContent = "deployed";
  if (earnProjectionUpdate) earnProjectionUpdate();

  const vaultSection = document.getElementById("vault-section");
  if (vaultSection) {
    vaultSection.classList.remove("hidden");
    vaultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.getElementById("deploy-btn").disabled = false;
  document.getElementById("deploy-btn").textContent = "Re-deploy agent";
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
    markCodeDirty(false); // prose drives a fresh compile on next backtest
  });

  document.getElementById("deploy-btn").addEventListener("click", deploy);
  document.getElementById("backtest-btn").addEventListener("click", () => runBacktest());
  document.getElementById("bt-rerun").addEventListener("click", () => runBacktest());
  document.getElementById("bt-window").addEventListener("change", () => runBacktest());

  // parameter sliders: live labels, recompile code on change
  const sliders = [
    ["p-lev", "p-lev-val", (v) => v.toFixed(1) + "x"],
    ["p-size", "p-size-val", (v) => "$" + v + "k"],
    ["p-stop", "p-stop-val", (v) => v.toFixed(1) + "%"],
  ];
  sliders.forEach(([id, labelId, fmt]) => {
    const s = document.getElementById(id);
    if (!s) return;
    s.addEventListener("input", () => {
      document.getElementById(labelId).textContent = fmt(parseFloat(s.value));
      markCodeDirty(false);
      if (!document.getElementById("code-card").classList.contains("hidden")) {
        document.getElementById("code-editor").value = generateCode(proseEl().value.trim(), readParams());
      }
    });
  });

  // deploy mode toggle
  const setDeployMode = (m) => {
    deployMode = m;
    document.getElementById("mode-paper").setAttribute("aria-pressed", m === "paper");
    document.getElementById("mode-live").setAttribute("aria-pressed", m === "live");
  };
  document.getElementById("mode-paper")?.addEventListener("click", () => setDeployMode("paper"));
  document.getElementById("mode-live")?.addEventListener("click", () => setDeployMode("live"));

  // editable code panel
  document.getElementById("code-editor")?.addEventListener("input", () => markCodeDirty(true));
  document.getElementById("code-recompile")?.addEventListener("click", () => { markCodeDirty(false); runBacktest(); });

  // builder earnings projection
  const earnTvl = document.getElementById("earn-tvl");
  if (earnTvl) {
    const updateEarn = () => {
      const tvl = parseFloat(earnTvl.value);
      const usd = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : "$" + Math.round(n / 1e3) + "k";
      document.getElementById("earn-tvl-val").textContent = usd(tvl);
      const perfBps = parseFloat(document.querySelectorAll('#vault-section input[type="number"]')[0]?.value || 2000);
      const txBps = parseFloat(document.querySelectorAll('#vault-section input[type="number"]')[1]?.value || 8);
      const r = lastBacktestResult || { totalReturn: 0.2, turnover: 0.4 };
      const perfEarn = Math.max(0, tvl * r.totalReturn) * (perfBps / 10000);
      const txEarn = tvl * r.turnover * 365 * (txBps / 10000);
      document.getElementById("earn-perf").textContent = usd(perfEarn) + "/yr";
      document.getElementById("earn-tx").textContent = usd(txEarn) + "/yr";
    };
    earnTvl.addEventListener("input", updateEarn);
    document.querySelectorAll('#vault-section input[type="number"]').forEach((i) => i.addEventListener("input", updateEarn));
    earnProjectionUpdate = updateEarn;
  }

  // fork prefill (?fork=<vault id>)
  const forkId = new URLSearchParams(location.search).get("fork");
  if (forkId && window.ES) {
    const v = ES.byId(forkId);
    if (v) {
      proseEl().value = v.prose;
      editorStatus().textContent = "forked from " + v.name;
      const banner = document.getElementById("fork-banner");
      banner.classList.remove("hidden");
      document.getElementById("fork-text").textContent = `Prefilled from ${v.name} by ${v.builder}. Tweak the description or parameters and re-backtest to make it your own.`;
      if (document.getElementById("p-lev")) {
        const lev = Math.min(v.maxLevVenue || 50, v.maxLev);
        document.getElementById("p-lev").value = lev;
        document.getElementById("p-lev-val").textContent = lev.toFixed(1) + "x";
      }
    }
  }

  const cv = createBtn();
  if (cv) cv.addEventListener("click", createVault);

  const skip = document.getElementById("skip-vault-btn");
  if (skip) {
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      const section = document.getElementById("vault-section");
      const card = document.createElement("div");
      card.className = "rounded-md p-5 mt-4";
      card.style.cssText = "background: oklch(var(--well)); border: 1px solid oklch(var(--border));";
      card.innerHTML = `
        <div class="text-xs mono uppercase tracking-wider text-muted mb-1">Running privately</div>
        <div class="text-sm text-muted">Your agent is live on EigenCompute and traded only by your TEE wallet. List a vault any time to open it to investors.</div>
        <div class="mt-3"><a href="./index.html" class="mono text-xs text-accent hover:underline">← BACK TO DISCOVER</a></div>
      `;
      section.replaceChildren(card);
    });
  }
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
        "EigenStrategies — Create Vault",
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
      btn.textContent = "List vault";
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
