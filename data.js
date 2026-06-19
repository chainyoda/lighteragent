// Shared mock data layer for the EigenStrategies prototype.
// Everything is deterministic (seeded) so curves, positions, fills and
// risk numbers stay stable across reloads and agree between the discover
// table, the vault page and the portfolio. In production this module is
// replaced by an indexer + Lighter sub-account reads + the NAV oracle.
//
// Exposes a single global: window.ES

(function () {
  "use strict";

  // ---- deterministic RNG ------------------------------------------------
  function seedFrom(s) {
    return Array.from(String(s)).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  }
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) {
    // approx N(0,1): sum of 6 uniforms has sd sqrt(0.5), so divide by it
    return (rand() + rand() + rand() + rand() + rand() + rand() - 3) / Math.SQRT1_2;
  }

  // ---- Lighter venue parameters (official) ------------------------------
  // Source: Lighter docs → Perpetual Futures → Contract Specifications & Fees.
  //   docs.lighter.xyz/perpetual-futures/contract-specifications
  //   docs.lighter.xyz/trading/trading-fees
  // tick = price step, amountStep = min size increment, maxLev = max leverage,
  // imr/mmr/cmr = initial / maintenance / close-out margin requirements.
  const LIGHTER = {
    fundingIntervalHours: 1,                       // funding settles hourly
    fees: {                                         // venue maker/taker fees
      standard: { makerBps: 0, takerBps: 0 },       // 0% / 0% (default account)
      premium:  { makerBps: 0.2, takerBps: 2 },     // 0.002% / 0.02% (opt-in HFT)
    },
    markets: {
      "BTC-PERP": { symbol: "BTC", tick: 0.1,   amountStep: 0.00001, maxLev: 50, imr: 0.02, mmr: 0.012, cmr: 0.008, mark: 64200 },
      "ETH-PERP": { symbol: "ETH", tick: 0.01,  amountStep: 0.0001,  maxLev: 50, imr: 0.02, mmr: 0.012, cmr: 0.008, mark: 3380 },
      "SOL-PERP": { symbol: "SOL", tick: 0.001, amountStep: 0.001,   maxLev: 25, imr: 0.04, mmr: 0.024, cmr: 0.016, mark: 148 },
    },
  };
  const roundTick = (px, m) => {
    const t = LIGHTER.markets[m]?.tick || 0.01;
    return Math.round(px / t) * t;
  };
  const roundStep = (sz, m) => {
    const s = LIGHTER.markets[m]?.amountStep || 0.001;
    return Math.round(sz / s) * s;
  };

  // ---- archetype tuning -------------------------------------------------
  // annRet / annVol are realistic annualized targets; the path is generated
  // to approximately hit them so Sharpe ≈ annRet/annVol stays believable.
  const ARCHETYPES = {
    funding:  { annRet: 0.16, annVol: 0.07, corr: 0.08, turn: "low",   label: "Funding carry" },
    basis:    { annRet: 0.12, annVol: 0.055, corr: 0.05, turn: "low",  label: "Funding basis" },
    momentum: { annRet: 0.32, annVol: 0.27, corr: 0.62, turn: "med",   label: "Momentum" },
    trend:    { annRet: 0.24, annVol: 0.23, corr: 0.55, turn: "med",   label: "Trend" },
    meanrev:  { annRet: 0.17, annVol: 0.16, corr: -0.18, turn: "high", label: "Mean reversion" },
    breakout: { annRet: -0.10, annVol: 0.34, corr: 0.70, turn: "high", label: "Breakout" },
    market_making: { annRet: 0.13, annVol: 0.09, corr: 0.12, turn: "high", label: "Market making" },
  };

  // ---- vault registry ---------------------------------------------------
  // Static "facts" per vault; everything else is derived deterministically.
  const VAULTS = [
    {
      id: "momentum", name: "Momentum Macro", letter: "M", builder: "alpha-lab.eth",
      builderAddr: "0x9bF1c4D0e2A7b8C36F90a1B2c3D4e5F60711a2c0a",
      archetype: "momentum", markets: ["BTC-PERP", "ETH-PERP", "SOL-PERP"], maxLev: 3,
      tvl: 2_840_000, investors: 124, perfBps: 2000, txBps: 8, ageDays: 71,
      capacity: 6_000_000, skin: 12.4, attested: true,
      desc: "Cross-asset perp momentum on BTC/ETH/SOL with a 1h/4h/1d signal stack. Risk-parity sizing, 3x max leverage.",
      prose: "Run a 1-hour momentum signal on BTC, ETH and SOL perps. Long markets where the 4-hour return is above +1.5% AND the 24-hour return is positive; short the mirror. Risk-parity sizing across positions. Hard stop at -3% per position. Max leverage 2x.",
    },
    {
      id: "funding", name: "Funding Harvester", letter: "F", builder: "fundingcat.eth",
      builderAddr: "0x3A2bDe91Cc77F1340e8841b2C18a9d0e7715fF2b1",
      archetype: "funding", markets: ["BTC-PERP", "ETH-PERP"], maxLev: 1,
      tvl: 1_210_000, investors: 88, perfBps: 1500, txBps: 5, ageDays: 42,
      capacity: 3_000_000, skin: 22.7, attested: true,
      desc: "Delta-neutral funding-rate carry. Longs the lower-funding side, shorts the higher, harvests the spread. No directional risk.",
      prose: "When BTC and ETH funding rates diverge by more than 12 bps over an 8-hour window, go long the lower-funding side and short the higher-funding side in equal notional. Close when the spread compresses below 4 bps. Stay delta-neutral; no leverage.",
    },
    {
      id: "meanrev", name: "Mean Reversion 5m", letter: "R", builder: "meanrev.eth",
      builderAddr: "0x77c1Ee4a0B92f3340Dd8412bc18A9d0e7c5704d29",
      archetype: "meanrev", markets: ["ETH-PERP"], maxLev: 2,
      tvl: 412_000, investors: 51, perfBps: 1000, txBps: 12, ageDays: 19,
      capacity: 1_000_000, skin: 8.1, attested: true,
      desc: "Bollinger-band mean reversion on ETH 5m. Fades band touches with RSI confirmation, exits to the moving average.",
      prose: "Watch ETH-PERP on a 5-minute timeframe. Bollinger Bands, 20-period MA, 2 stdev. Long the lower band when RSI < 30; short the upper band when RSI > 70. Exit on return to the MA. Hard stop at -1.2%.",
    },
    {
      id: "stable", name: "Yield-Stable Carry", letter: "Y", builder: "stable.eth",
      builderAddr: "0x12cD0a9d217B4E50f2C18Ee4a0B92f3340Dd8412b",
      archetype: "basis", markets: ["BTC-PERP", "ETH-PERP"], maxLev: 1,
      tvl: 5_120_000, investors: 203, perfBps: 1000, txBps: 4, ageDays: 118,
      capacity: 8_000_000, skin: 31.2, attested: true,
      desc: "Conservative perp funding capture aiming for steady single-digit-to-teens APR with shallow drawdowns.",
      prose: "Capture perp funding on BTC and ETH, kept delta-neutral via offsetting long/short perp legs. Target low volatility; cap drawdown at 3%. No leverage.",
    },
    {
      id: "breakout", name: "Breakout Hunter", letter: "B", builder: "breakout.eth",
      builderAddr: "0x5Eed0a9d217B4E50f2C18Ee4a0B92f3340Dd8a0b1",
      archetype: "breakout", markets: ["BTC-PERP", "ETH-PERP", "SOL-PERP"], maxLev: 4,
      tvl: 198_000, investors: 27, perfBps: 2500, txBps: 10, ageDays: 11,
      capacity: 1_500_000, skin: 5.0, attested: false,
      desc: "Donchian-channel breakout with volatility-scaled sizing. Higher risk, higher leverage, newest of the bunch.",
      prose: "Enter long on a 20-bar high breakout, short on a 20-bar low breakout, on BTC/ETH/SOL 1h. Size inversely to ATR. Trailing stop at 2 ATR. Max leverage 4x.",
    },
    {
      id: "basis", name: "Perp Funding Basis", letter: "C", builder: "carrytrade.eth",
      builderAddr: "0xa1B2c3D4e5F6071109bF1c4D0e2A7b8C36F90a1B2",
      archetype: "basis", markets: ["BTC-PERP"], maxLev: 1,
      tvl: 3_640_000, investors: 142, perfBps: 1200, txBps: 3, ageDays: 96,
      capacity: 5_000_000, skin: 18.9, attested: true,
      desc: "Single-market BTC perp funding harvest. Captures the perp-funding premium with tight risk and minimal turnover.",
      prose: "Harvest BTC perp funding: hold a short perp position while annualized funding exceeds 6%, flatten when it falls under 2%. Inventory-capped; no leverage; rebalance hourly.",
    },
    {
      id: "trend", name: "Trend Following CTA", letter: "T", builder: "dunn-capital.eth",
      builderAddr: "0xDd8412bc18A9d0e7c5704d2977c1Ee4a0B92f3340",
      archetype: "trend", markets: ["BTC-PERP", "ETH-PERP", "SOL-PERP"], maxLev: 3,
      tvl: 1_870_000, investors: 96, perfBps: 1800, txBps: 6, ageDays: 58,
      capacity: 4_000_000, skin: 14.2, attested: true,
      desc: "Classic medium-term trend following across the three majors. Long/short, volatility-targeted, slow to flip.",
      prose: "Trade 50/200 EMA crossovers on BTC/ETH/SOL daily. Long above, short below. Volatility-target 12% annualized. Max leverage 3x.",
    },
    {
      id: "mm", name: "Spread Maker", letter: "S", builder: "tightbook.eth",
      builderAddr: "0xc3D4e5F6071109bF1c4D0e2A7b8C36F90a1B2c3D4",
      archetype: "market_making", markets: ["ETH-PERP", "SOL-PERP"], maxLev: 2,
      tvl: 920_000, investors: 64, perfBps: 1500, txBps: 2, ageDays: 34,
      capacity: 2_000_000, skin: 16.5, attested: true,
      desc: "Passive two-sided quoting on ETH/SOL perps. Earns the spread and rebates, inventory-bounded and delta-capped.",
      prose: "Quote both sides of ETH and SOL perps at a 1.5 bps half-spread. Skew quotes against inventory. Cap net delta at $20k. Cancel-and-replace each second.",
    },
  ];

  // ---- derived series ---------------------------------------------------
  // Build a backtest curve and a live curve that mostly tracks it but
  // diverges slightly (slippage, regime drift) — this powers the
  // live-vs-backtest overlay that is the platform's headline differentiator.
  function buildSeries(v, days) {
    const a = ARCHETYPES[v.archetype];
    const rand = mulberry32(seedFrom(v.id + ":" + days));
    // per-vault idiosyncratic tilt (deterministic) around the archetype target
    const tilt = mulberry32(seedFrom(v.id));
    const annRet = a.annRet * (0.8 + tilt() * 0.5);
    const annVol = a.annVol * (0.85 + tilt() * 0.35);
    const muD = annRet / 365;
    const muLiveD = muD - Math.abs(annVol) / 365 * 0.18 - 0.0001; // real-world drag
    const sigD = annVol / Math.sqrt(365);

    // generate raw daily returns first, then mean-correct each path so the
    // realized return lands near its target (kills single-path luck) while
    // preserving the organic shape and volatility.
    const retsB = [], retsL = [];
    for (let i = 1; i < days; i++) {
      const zb = gauss(rand);
      retsB.push(sigD * zb);
      const idio = sigD * 0.22 * gauss(rand);
      const slip = -Math.abs(gauss(rand)) * sigD * 0.05;
      retsL.push(sigD * zb + idio + slip);
    }
    const meanB = retsB.reduce((s, r) => s + r, 0) / retsB.length;
    const meanL = retsL.reduce((s, r) => s + r, 0) / retsL.length;

    const backtest = [1.0], live = [1.0], dailyLive = [];
    let trades = 0, wins = 0;
    for (let i = 0; i < retsB.length; i++) {
      const retB = retsB[i] - meanB + muD;
      const retL = retsL[i] - meanL + muLiveD;
      backtest.push(Math.max(0.2, backtest[backtest.length - 1] * (1 + retB)));
      live.push(Math.max(0.2, live[live.length - 1] * (1 + retL)));
      dailyLive.push(retL);
      if (rand() < (a.turn === "high" ? 0.8 : a.turn === "med" ? 0.45 : 0.2)) {
        trades += 1;
        if (retL > 0) wins += 1;
      }
    }
    return { backtest, live, dailyLive, trades, wins };
  }

  function stats(series) {
    const eq = series.live;
    const totalReturn = eq[eq.length - 1] - 1;
    const rets = series.dailyLive;
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) || 1e-9;
    const downside = Math.sqrt(
      rets.filter((r) => r < 0).reduce((s, r) => s + r * r, 0) / Math.max(1, rets.length)
    ) || 1e-9;
    const sharpe = (mean / sd) * Math.sqrt(365);
    const sortino = (mean / downside) * Math.sqrt(365);
    let peak = eq[0], mdd = 0, curDD = 0;
    for (const x of eq) {
      if (x > peak) peak = x;
      const dd = (x - peak) / peak;
      if (dd < mdd) mdd = dd;
      curDD = dd;
    }
    // geometric annualization of the realized window return
    const apr = Math.pow(eq[eq.length - 1] / eq[0], 365 / (eq.length - 1)) - 1;
    const winRate = series.trades ? series.wins / series.trades : 0;
    // tracking error vs backtest
    const te = Math.sqrt(
      series.live.reduce((s, x, i) => s + ((x - series.backtest[i]) / series.backtest[i]) ** 2, 0) /
      series.live.length
    );
    return { totalReturn, sharpe, sortino, mdd, curDD, apr, winRate, trades: series.trades, te };
  }

  // ---- risk snapshot ----------------------------------------------------
  function risk(v) {
    const rand = mulberry32(seedFrom(v.id + ":risk"));
    const a = ARCHETYPES[v.archetype];
    const curLev = +(v.maxLev * (0.35 + rand() * 0.5)).toFixed(2);
    const netExposure = a.corr === 0 ? 0 : +((a.corr) * (40 + rand() * 50)).toFixed(0);
    const grossExposure = +(curLev * 100).toFixed(0);
    const largestPos = +(25 + rand() * 45).toFixed(0);
    const dailyVol = a.annVol / Math.sqrt(365);
    const var95 = +(dailyVol * 1.65 * 100 * (1 + curLev * 0.3)).toFixed(2);
    const worstDay = -+(var95 * (1.3 + rand() * 0.6)).toFixed(2);
    return {
      curLev, netExposure, grossExposure, largestPos, var95, worstDay,
      liqDist: 0, corrBtc: a.corr, // liqDist filled from positions in hydrate
    };
  }

  // ---- open positions ---------------------------------------------------
  // Prices snap to each market's Lighter tick, sizes to its amountStep, and
  // the liquidation price follows from position leverage and the market's
  // maintenance-margin requirement (MMR): move ≈ 1/lev − MMR.
  function positions(v) {
    const rand = mulberry32(seedFrom(v.id + ":pos"));
    const out = [];
    for (const m of v.markets) {
      const spec = LIGHTER.markets[m];
      if (rand() < 0.12 && v.markets.length > 1) continue; // sometimes flat
      const dir = v.archetype === "funding" || v.archetype === "basis"
        ? (out.length % 2 === 0 ? "long" : "short")
        : rand() < 0.55 ? "long" : "short";
      const mark = roundTick(spec.mark * (1 + (rand() - 0.5) * 0.01), m);
      const entry = roundTick(mark * (1 + (rand() - 0.5) * 0.03), m);
      // per-position leverage tracks the vault's current leverage, capped at
      // the market's Lighter max; notional follows from the margin slice.
      const lev = +Math.min(spec.maxLev, Math.max(0.5, v.risk.curLev * (0.6 + rand() * 0.9))).toFixed(1);
      const margin = v.tvl / Math.max(1, v.markets.length);
      const notional = margin * lev;
      const size = roundStep(notional / mark, m);
      const sign = dir === "long" ? 1 : -1;
      const uPnl = sign * (mark - entry) * size;
      const move = Math.max(spec.mmr + 0.004, 1 / Math.max(1, lev) - spec.mmr); // dist to liquidation
      const liqPx = roundTick(dir === "long" ? mark * (1 - move) : mark * (1 + move), m);
      out.push({ market: m, side: dir, size, entry, mark, notional, uPnl, liqPx, lev, liqDistPct: move * 100 });
    }
    if (out.length === 0) {
      const m = v.markets[0], spec = LIGHTER.markets[m];
      out.push({ market: m, side: "long", size: roundStep(0.5, m), entry: spec.mark, mark: spec.mark, notional: spec.mark * 0.5, uPnl: 0, liqPx: roundTick(spec.mark * 0.6, m), lev: 1, liqDistPct: 40 });
    }
    return out;
  }

  // ---- recent fills (a rolling tape) ------------------------------------
  function fills(v, n) {
    const rand = mulberry32(seedFrom(v.id + ":fills"));
    const out = [];
    let t = Date.now();
    for (let i = 0; i < n; i++) {
      const m = v.markets[Math.floor(rand() * v.markets.length)];
      const spec = LIGHTER.markets[m];
      const side = rand() < 0.5 ? "buy" : "sell";
      const price = roundTick(spec.mark * (1 + (rand() - 0.5) * 0.004), m);
      const notional = 2000 + rand() * 28000;
      const size = roundStep(notional / price, m);
      // venue fee is 0% on Lighter Standard accounts; the only charge is the
      // vault builder's per-trade fee (txBps).
      const fee = notional * (v.txBps / 10000);
      t -= (8000 + rand() * 90000);
      out.push({ t, market: m, side, price, size, notional, fee });
    }
    return out;
  }

  // ---- builders ---------------------------------------------------------
  function builderProfile(ens) {
    const mine = VAULTS.concat(loadCustomVaults()).filter((v) => v.builder === ens);
    const rand = mulberry32(seedFrom(ens + ":bld"));
    if (mine.length === 0) {
      // unknown builder (e.g. a freshly created vault's wallet): safe defaults
      return { ens, addr: "0x" + "0".repeat(40), vaults: [], vaultCount: 1, totalAum: 0, avgApr: 0, joinedDays: 1, verified: true };
    }
    const totalAum = mine.reduce((s, v) => s + v.tvl, 0);
    const avgApr = mine.reduce((s, v) => s + v.stats.apr, 0) / mine.length;
    const oldest = Math.max(...mine.map((v) => v.ageDays));
    return {
      ens,
      addr: mine[0].builderAddr,
      vaults: mine.map((v) => v.id),
      vaultCount: mine.length,
      totalAum,
      avgApr,
      joinedDays: oldest + Math.floor(rand() * 40),
      verified: mine.every((v) => v.attested),
    };
  }

  // ---- version history (image-hash rotations) ---------------------------
  function versions(v) {
    const rand = mulberry32(seedFrom(v.id + ":ver"));
    const n = 1 + Math.floor(rand() * 3);
    const out = [];
    const notes = [
      "Initial deployment",
      "Tighter stop-loss; reduced max leverage",
      "Added SOL leg; re-tuned signal thresholds",
      "Lowered per-trade size near capacity",
    ];
    let age = v.ageDays;
    for (let i = 0; i <= n; i++) {
      const h = (seedFrom(v.id + ":h" + i) >>> 0).toString(16).padStart(8, "0");
      out.push({
        hash: "0x" + h + "…" + (seedFrom(v.id + i) % 65536).toString(16).padStart(4, "0"),
        note: notes[Math.min(i, notes.length - 1)],
        ageDays: Math.max(0, age),
        status: i === n ? "active" : "rotated",
        redemptionWindow: i === n && rand() < 0.25 ? "open · 18h left" : null,
      });
      age -= Math.floor(rand() * 25) + 6;
    }
    return out.reverse();
  }

  // ---- portfolio (per connected wallet, deterministic by address) -------
  function portfolio(address) {
    if (!address) return { positions: [], totalValue: 0, totalCost: 0, totalPnl: 0, feesPaid: 0 };
    const rand = mulberry32(seedFrom(address.toLowerCase()));
    const picks = VAULTS.filter(() => rand() < 0.45).slice(0, 4);
    if (picks.length === 0) picks.push(VAULTS[0], VAULTS[1]);
    let totalValue = 0, totalCost = 0, feesPaid = 0;
    const positions = picks.map((v) => {
      const cost = 500 + Math.floor(rand() * 9500);
      const ret = v.stats.totalReturn * (0.4 + rand() * 0.8);
      const value = cost * (1 + ret);
      const shares = cost / (1 + v.stats.totalReturn * 0.5);
      const fees = Math.max(0, value - cost) * (v.perfBps / 10000) + cost * (v.txBps / 10000) * 6;
      totalValue += value; totalCost += cost; feesPaid += fees;
      const v0 = versions(v).find((x) => x.redemptionWindow);
      return {
        id: v.id, name: v.name, letter: v.letter, attested: v.attested,
        cost, value, shares, pnl: value - cost, ret, fees,
        redemption: v0 ? v0.redemptionWindow : null,
      };
    });
    return { positions, totalValue, totalCost, totalPnl: totalValue - totalCost, feesPaid };
  }

  // ---- hydrate (derive all series/stats/risk/guardrails for one vault) --
  function hydrate(v) {
    v.series60 = buildSeries(v, 60);          // short window for sparkline + histogram
    v.seriesStat = buildSeries(v, 365);       // long window for stable headline stats
    v.stats = stats(v.seriesStat);
    v.apr30 = v.stats.apr; // headline annualized return
    v.risk = risk(v);
    v.positions = positions(v);
    // liquidation distance = the closest position to its liq price (worst case)
    v.risk.liqDist = +Math.min(...v.positions.map((p) => p.liqDistPct)).toFixed(1);
    v.maxLevVenue = Math.min(...v.markets.map((m) => (LIGHTER.markets[m] || { maxLev: 50 }).maxLev));
    v.archetypeLabel = ARCHETYPES[v.archetype].label;
    // Published guardrails — enforced in the TEE runtime (see guardrails.py).
    const grossCap = v.tvl * v.maxLev;
    const ddBase = Math.abs(v.stats.mdd) + 0.05;
    v.guardrails = {
      allowedMarkets: v.markets,
      maxLeverage: v.maxLev,
      venueMaxLeverage: v.maxLevVenue,
      maxGrossNotional: grossCap,
      maxNotionalPerMarket: grossCap / v.markets.length,
      maxNotionalPerOrder: Math.max(5000, Math.round((grossCap / v.markets.length) * 0.25 / 1000) * 1000),
      minFreeCollateral: Math.round((v.tvl * 0.02) / 1000) * 1000,
      maxDrawdownPct: Math.min(0.5, Math.max(0.08, Math.ceil((ddBase * 100) / 5) * 5 / 100)),
      maxOrdersPerTick: ARCHETYPES[v.archetype].turn === "high" ? 40 : 20,
    };
    return v;
  }
  VAULTS.forEach(hydrate);

  // Build a fully-hydrated vault from a partial spec (used for builder-created
  // vaults persisted in localStorage). Fills sane defaults for anything the
  // create flow didn't capture.
  const ARCHETYPE_ALIAS = { mm: "market_making", generic: "momentum", trend: "trend" };
  function makeVault(spec) {
    spec = spec || {};
    let archetype = spec.archetype || "momentum";
    archetype = ARCHETYPE_ALIAS[archetype] || archetype;
    if (!ARCHETYPES[archetype]) archetype = "momentum";
    const markets = (spec.markets && spec.markets.length ? spec.markets : ["BTC-PERP", "ETH-PERP"])
      .filter((m) => LIGHTER.markets[m]);
    const id = spec.id || spec.addr || ("custom-" + (seedFrom(spec.name || "vault") % 99999));
    const name = spec.name || "New Vault";
    const tvl = spec.tvl || 25000;
    const v = {
      id, addr: spec.addr || id, custom: true,
      name, letter: (name.trim()[0] || "V").toUpperCase(),
      builder: spec.builder || "you.eth",
      builderAddr: spec.builderAddr || ("0x" + (seedFrom(id) >>> 0).toString(16).padStart(40, "0")).slice(0, 42),
      archetype, markets: markets.length ? markets : ["BTC-PERP", "ETH-PERP"],
      maxLev: spec.maxLev || 2,
      tvl, investors: spec.investors || 1,
      perfBps: spec.perfBps || 2000, txBps: spec.txBps || 8,
      ageDays: spec.ageDays || 1,
      capacity: spec.capacity || Math.max(tvl * 20, 1_000_000),
      skin: spec.skin != null ? spec.skin : 100,
      attested: spec.attested !== false,
      desc: spec.desc || (spec.prose ? spec.prose.slice(0, 160) : "Builder-created agent."),
      prose: spec.prose || "",
      imageHash: spec.imageHash, teeWallet: spec.teeWallet, createdAt: spec.createdAt,
    };
    return hydrate(v);
  }

  // Builder-created vaults persisted by the create flow.
  function loadCustomVaults() {
    try {
      if (typeof localStorage === "undefined") return [];
      const raw = localStorage.getItem("eigenstrategies:vaults");
      if (!raw) return [];
      return Object.values(JSON.parse(raw)).map(makeVault);
    } catch { return []; }
  }

  function byId(id) {
    if (!id) return undefined;
    return VAULTS.find((v) => v.id === id)
      || loadCustomVaults().find((v) => v.id === id || v.addr === id);
  }

  // ---- formatting helpers (shared by all pages) -------------------------
  const fmt = {
    usd(n) {
      const abs = Math.abs(n);
      if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
      if (abs >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k";
      return "$" + n.toFixed(0);
    },
    usd2(n) { return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }); },
    pct(n, dp = 1) { return (n >= 0 ? "+" : "") + (n * 100).toFixed(dp) + "%"; },
    pctRaw(n, dp = 1) { return (n >= 0 ? "" : "") + n.toFixed(dp) + "%"; },
    bps(n) { return (n / 100).toFixed(2) + "%"; },
    ago(t) {
      const s = Math.floor((Date.now() - t) / 1000);
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.floor(s / 60) + "m ago";
      if (s < 86400) return Math.floor(s / 3600) + "h ago";
      return Math.floor(s / 86400) + "d ago";
    },
    num(n, dp = 4) { return n.toLocaleString("en-US", { maximumFractionDigits: dp }); },
  };

  window.ES = {
    VAULTS, ARCHETYPES, LIGHTER, byId, roundTick, roundStep,
    buildSeries, stats, risk, positions, fills, builderProfile, versions, portfolio,
    hydrate, makeVault, loadCustomVaults,
    seedFrom, mulberry32, fmt,
  };
})();
