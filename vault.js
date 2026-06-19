// Vault detail page renderer. Reads ?id= (or ?addr=) and hydrates every
// panel from the shared ES data layer: equity overlay, risk, positions,
// fills, attestation history, builder record, deposit calculator.
(function () {
  "use strict";
  function start() {
    if (!window.ES || !window.UI) return setTimeout(start, 30);
    const { fmt } = ES;
    const params = new URLSearchParams(location.search);
    const v = ES.byId(params.get("id")) || ES.VAULTS[0];
    const a = ES.ARCHETYPES[v.archetype];
    document.title = `${v.name} — EigenStrategies`;

    // ---- hero -----------------------------------------------------------
    const tile = document.getElementById("v-tile");
    tile.textContent = v.letter;
    tile.className = "h-14 w-14 rounded-lg flex items-center justify-center display text-2xl font-semibold " + (v.attested ? "icon-tile-primary" : "icon-tile-accent");
    document.getElementById("v-name").innerHTML = `${v.name} <span class="badge ${v.attested ? "badge-attested" : "badge-pending"}">${v.attested ? "TEE attested" : "attestation pending"}</span>`;
    document.getElementById("v-sub").textContent = `${shortAddr(v.builderAddr)} · ${v.archetypeLabel} · by ${v.builder}`;
    document.getElementById("v-desc").textContent = v.desc;
    const fork = document.getElementById("v-fork");
    fork.href = `./create.html?fork=${v.id}`;
    fork.classList.remove("hidden");

    // ---- equity chart (live vs backtest) --------------------------------
    let win = 60, showBT = true, showDD = false;
    function navOf(series) { return (series.live[series.live.length - 1] * 100); }
    function drawEquity() {
      const s = ES.buildSeries(v, win);
      const st = ES.stats(s);
      UI.equityChart(document.getElementById("eq-chart"), { live: s.live, backtest: s.backtest, showBacktest: showBT, showDrawdown: showDD });
      document.getElementById("eq-window-label").textContent = win + "d";
      document.getElementById("eq-nav").textContent = navOf(s).toFixed(2);
      document.getElementById("eq-apr").textContent = fmt.pct(st.apr) + " APR";
      document.getElementById("eq-apr").className = "mono font-semibold " + (st.apr >= 0 ? "text-primary" : "text-destructive");
      document.getElementById("eq-te").textContent = (st.te * 100).toFixed(2) + "%";
    }
    document.querySelectorAll("#eq-windows [data-win]").forEach((b) => b.addEventListener("click", () => {
      win = +b.dataset.win;
      document.querySelectorAll("#eq-windows [data-win]").forEach((x) => x.setAttribute("aria-pressed", x === b));
      drawEquity();
    }));
    document.getElementById("tg-backtest").addEventListener("click", (e) => { showBT = !showBT; e.target.setAttribute("aria-pressed", showBT); drawEquity(); });
    document.getElementById("tg-drawdown").addEventListener("click", (e) => { showDD = !showDD; e.target.setAttribute("aria-pressed", showDD); drawEquity(); });
    drawEquity();

    // ---- metrics --------------------------------------------------------
    const st = v.stats;
    setText("m-return", fmt.pct(st.totalReturn), st.totalReturn >= 0 ? "text-primary" : "text-destructive");
    document.getElementById("m-sharpe").textContent = st.sharpe.toFixed(2);
    document.getElementById("m-sortino").textContent = st.sortino.toFixed(2);
    document.getElementById("m-mdd").textContent = fmt.pct(st.mdd);
    document.getElementById("m-win").textContent = (st.winRate * 100).toFixed(0) + "%";
    document.getElementById("m-inv").textContent = v.investors;

    // ---- risk panel -----------------------------------------------------
    const r = v.risk;
    document.getElementById("r-lev").textContent = r.curLev + "x / " + v.maxLev + "x max";
    document.getElementById("r-lev-bar").innerHTML = UI.gaugeBar((r.curLev / v.maxLev) * 100, r.curLev / v.maxLev > 0.8 ? UI.ACCENT : UI.PRIMARY);
    document.getElementById("r-gross").textContent = r.grossExposure + "% of NAV";
    document.getElementById("r-gross-bar").innerHTML = UI.gaugeBar(Math.min(100, r.grossExposure / 4));
    document.getElementById("r-net").textContent = (r.netExposure >= 0 ? "+" : "") + r.netExposure + "% " + (Math.abs(r.netExposure) < 10 ? "(≈ delta-neutral)" : r.netExposure > 0 ? "long" : "short");
    document.getElementById("r-net-bar").innerHTML = UI.gaugeBar(Math.min(100, Math.abs(r.netExposure)), Math.abs(r.netExposure) < 10 ? UI.PRIMARY : UI.ACCENT);
    document.getElementById("r-largest").textContent = r.largestPos + "% of book";
    document.getElementById("r-largest-bar").innerHTML = UI.gaugeBar(r.largestPos, r.largestPos > 60 ? UI.ACCENT : UI.PRIMARY);
    document.getElementById("r-var").textContent = "-" + r.var95 + "%";
    document.getElementById("r-worst").textContent = r.worstDay + "%";
    document.getElementById("r-liq").textContent = r.liqDist + "%";
    document.getElementById("r-corr").textContent = r.corrBtc.toFixed(2);
    UI.histogram(document.getElementById("r-hist"), v.series60.dailyLive, { h: 80 });

    // ---- positions (with live marks) ------------------------------------
    const positions = v.positions.map((p) => ({ ...p }));
    const posBody = document.getElementById("pos-rows");
    function renderPositions() {
      posBody.innerHTML = "";
      for (const p of positions) {
        const sign = p.side === "long" ? 1 : -1;
        const uPnl = sign * (p.mark - p.entry) * p.size;
        const tr = document.createElement("tr");
        tr.className = "border-t border-default";
        tr.innerHTML = `
          <td class="px-6 py-3 mono">${p.market}</td>
          <td class="px-3 py-3"><span class="mono text-xs ${p.side === "long" ? "text-primary" : "text-destructive"}">${p.side.toUpperCase()} ${p.lev}x</span></td>
          <td class="px-3 py-3 text-right mono">${fmt.num(p.size, 3)}</td>
          <td class="px-3 py-3 text-right mono text-muted">${fmt.usd2(p.entry)}</td>
          <td class="px-3 py-3 text-right mono">${fmt.usd2(p.mark)}</td>
          <td class="px-3 py-3 text-right mono ${uPnl >= 0 ? "text-primary" : "text-destructive"}">${uPnl >= 0 ? "+" : ""}${fmt.usd(uPnl)}</td>
          <td class="px-6 py-3 text-right mono text-muted">${fmt.usd2(p.liqPx)}</td>`;
        posBody.appendChild(tr);
      }
    }
    renderPositions();
    // jitter marks to feel live
    setInterval(() => {
      const rand = Math.random;
      for (const p of positions) p.mark = p.mark * (1 + (rand() - 0.5) * 0.0009);
      renderPositions();
    }, 1800);

    // ---- fills tape -----------------------------------------------------
    const fillBody = document.getElementById("fill-rows");
    function renderFills() {
      const list = ES.fills(v, 18);
      fillBody.innerHTML = "";
      for (const f of list) {
        const tr = document.createElement("tr");
        tr.className = "border-t border-default";
        tr.innerHTML = `
          <td class="px-6 py-2.5 mono text-xs text-muted">${fmt.ago(f.t)}</td>
          <td class="px-3 py-2.5 mono">${f.market}</td>
          <td class="px-3 py-2.5 mono text-xs ${f.side === "buy" ? "text-primary" : "text-destructive"}">${f.side.toUpperCase()}</td>
          <td class="px-3 py-2.5 text-right mono">${fmt.usd2(f.price)}</td>
          <td class="px-3 py-2.5 text-right mono">${fmt.usd(f.notional)}</td>
          <td class="px-6 py-2.5 text-right mono text-muted">${fmt.usd2(f.fee)}</td>`;
        fillBody.appendChild(tr);
      }
    }
    renderFills();

    // ---- trust + versions ----------------------------------------------
    const vers = ES.versions(v);
    const active = vers[0];
    document.getElementById("t-hash").textContent = active.hash;
    document.getElementById("t-wallet").textContent = shortAddr(v.builderAddr.replace(/^0x.{4}/, "0x9B1c"));
    document.getElementById("t-sub").textContent = "vault-" + (ES.seedFrom(v.id) % 9999).toString().padStart(4, "0");
    if (!v.attested) { const reg = document.getElementById("t-reg"); reg.textContent = "PENDING"; reg.className = "text-accent mono"; }
    const vlist = document.getElementById("version-list");
    vers.forEach((ver) => {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between text-sm border border-default rounded-md px-3 py-2";
      row.innerHTML = `
        <div class="flex items-center gap-3">
          <span class="mono text-xs ${ver.status === "active" ? "text-primary" : "text-muted"}">${ver.hash}</span>
          <span class="text-muted text-xs">${ver.note}</span>
        </div>
        <div class="flex items-center gap-2">
          ${ver.redemptionWindow ? `<span class="badge badge-pending">${ver.redemptionWindow}</span>` : ""}
          <span class="badge ${ver.status === "active" ? "badge-attested" : ""}">${ver.status === "active" ? "active" : ver.ageDays + "d ago"}</span>
        </div>`;
      vlist.appendChild(row);
    });

    // ---- Lighter market parameters (official venue specs) ---------------
    const specBody = document.getElementById("spec-rows");
    if (specBody) {
      v.markets.forEach((m) => {
        const s = ES.LIGHTER.markets[m];
        const tr = document.createElement("tr");
        tr.className = "border-t border-default";
        tr.innerHTML = `
          <td class="py-1.5 mono">${m}</td>
          <td class="py-1.5 text-right mono">${s.maxLev}×</td>
          <td class="py-1.5 text-right mono text-muted">${s.tick}</td>
          <td class="py-1.5 text-right mono text-muted">${s.amountStep}</td>
          <td class="py-1.5 text-right mono text-muted">${(s.imr * 100).toFixed(1)}% / ${(s.mmr * 100).toFixed(1)}%</td>`;
        specBody.appendChild(tr);
      });
    }

    // ---- builder track record ------------------------------------------
    const b = ES.builderProfile(v.builder);
    document.getElementById("b-avatar").textContent = v.builder[0].toUpperCase();
    document.getElementById("b-ens").textContent = v.builder;
    document.getElementById("b-addr").textContent = shortAddr(b.addr);
    document.getElementById("b-joined").textContent = (b.joinedDays / 30).toFixed(0) + " mo";
    document.getElementById("b-vaults").textContent = b.vaultCount;
    document.getElementById("b-aum").textContent = fmt.usd(b.totalAum);
    document.getElementById("b-apr").textContent = fmt.pct(b.avgApr);
    const others = b.vaults.filter((id) => id !== v.id);
    const otherEl = document.getElementById("b-other");
    if (others.length) {
      otherEl.innerHTML = `<div class="mono text-xs uppercase tracking-wider text-muted mb-2">Other vaults by this builder</div>` +
        others.map((id) => { const ov = ES.byId(id); return `<a href="./vault.html?id=${id}" class="flex items-center justify-between py-1.5 text-sm hover:text-[color:oklch(var(--accent))]"><span>${ov.name}</span><span class="mono text-xs ${ov.apr30 >= 0 ? "text-primary" : "text-destructive"}">${fmt.pct(ov.apr30)}</span></a>`; }).join("");
    } else {
      otherEl.innerHTML = `<div class="text-xs text-muted">This is ${v.builder}'s only vault.</div>`;
    }

    // ---- fees & builder card -------------------------------------------
    document.getElementById("f-perf").textContent = fmt.bps(v.perfBps) + " of profits";
    document.getElementById("f-tx").textContent = fmt.bps(v.txBps) + " of notional";
    const feesPaid = v.tvl * (v.txBps / 10000) * 22 + v.tvl * Math.max(0, st.totalReturn) * (v.perfBps / 10000) * 0.5;
    document.getElementById("f-paid").textContent = fmt.usd(feesPaid);
    document.getElementById("f-skin").textContent = v.skin.toFixed(1) + "%";

    // ---- capacity -------------------------------------------------------
    const capPct = Math.min(100, Math.round((v.tvl / v.capacity) * 100));
    document.getElementById("cap-text").textContent = `${fmt.usd(v.tvl)} / ${fmt.usd(v.capacity)} (${capPct}%)`;
    document.getElementById("cap-bar").innerHTML = UI.gaugeBar(capPct, capPct > 85 ? UI.ACCENT : UI.PRIMARY);
    document.getElementById("cap-note").textContent = capPct > 90
      ? "Near builder-declared capacity — deposits may be throttled to protect strategy edge."
      : `Room for ${fmt.usd(v.capacity - v.tvl)} more before the builder's declared capacity.`;

    // ---- deposit / redeem + calculator ----------------------------------
    let mode = "deposit";
    const nav = navOf(v.series60); // USDC per share
    const wallet = UI.getWallet();
    const port = ES.portfolio(wallet?.address);
    const myPos = port.positions.find((p) => p.id === v.id);

    const turnsPerYear = a.turn === "high" ? 140 : a.turn === "med" ? 45 : 10;
    function recalc() {
      const amt = parseFloat(document.getElementById("amt-input").value) || 0;
      if (mode === "deposit") {
        const shares = amt / nav;
        const fv = amt * (1 + st.apr);
        const gains = Math.max(0, fv - amt);
        const perfFee = gains * (v.perfBps / 10000);
        const txDrag = amt * (v.txBps / 10000) * turnsPerYear;
        const net = fv - perfFee - txDrag;
        document.getElementById("calc-shares").textContent = fmt.num(shares, 4) + " shares";
        document.getElementById("calc-nav").textContent = nav.toFixed(2) + " USDC";
        document.getElementById("calc-perf").textContent = "−" + fmt.usd2(perfFee);
        document.getElementById("calc-tx").textContent = "−" + fmt.usd2(txDrag);
        const netEl = document.getElementById("calc-net");
        netEl.textContent = fmt.usd2(net) + "  (" + fmt.pct(net / amt - 1) + ")";
        netEl.className = "mono font-semibold " + (net >= amt ? "text-primary" : "text-destructive");
      } else {
        const shares = amt;
        const usdc = shares * nav;
        document.getElementById("calc-shares").textContent = fmt.usd2(usdc) + " USDC";
        document.getElementById("calc-nav").textContent = nav.toFixed(2) + " USDC";
        document.getElementById("calc-perf").textContent = "settled on exit";
        document.getElementById("calc-tx").textContent = "—";
        document.getElementById("calc-net").textContent = fmt.usd2(usdc);
        document.getElementById("calc-net").className = "mono font-semibold";
      }
    }
    function setMode(m) {
      mode = m;
      const dep = m === "deposit";
      document.getElementById("tab-deposit").classList.toggle("tab-active", dep);
      document.getElementById("tab-deposit").classList.toggle("text-muted", !dep);
      document.getElementById("tab-redeem").classList.toggle("tab-active", !dep);
      document.getElementById("tab-redeem").classList.toggle("text-muted", dep);
      document.getElementById("amt-label").textContent = dep ? "Amount (USDC)" : "Shares to redeem";
      document.getElementById("amt-unit").textContent = dep ? "USDC" : "shares";
      document.getElementById("action-btn").textContent = dep ? "Deposit USDC" : "Redeem shares";
      document.getElementById("amt-input").value = dep ? "1000" : (myPos ? (myPos.shares).toFixed(2) : "10");
      const bal = document.getElementById("amt-balance");
      bal.textContent = !dep && myPos ? `balance: ${fmt.num(myPos.shares, 2)} shares` : "";
      recalc();
    }
    document.getElementById("tab-deposit").addEventListener("click", () => setMode("deposit"));
    document.getElementById("tab-redeem").addEventListener("click", () => setMode("redeem"));
    document.getElementById("amt-input").addEventListener("input", recalc);
    document.getElementById("action-btn").addEventListener("click", () => {
      if (!wallet) { UI.toast("Connect a wallet to " + mode + ".", "accent"); return; }
      UI.toast(`<b>${mode === "deposit" ? "Deposit" : "Redemption"} simulated.</b><br>This prototype runs on testnet with simulated data — no funds move.`, "primary");
    });
    setMode("deposit");

    // ---- your position --------------------------------------------------
    if (myPos) {
      document.getElementById("your-pos").classList.remove("hidden");
      document.getElementById("yp-value").textContent = fmt.usd2(myPos.value);
      document.getElementById("yp-cost").textContent = fmt.usd2(myPos.cost);
      const pnlEl = document.getElementById("yp-pnl");
      pnlEl.textContent = (myPos.pnl >= 0 ? "+" : "") + fmt.usd2(myPos.pnl) + " (" + fmt.pct(myPos.ret) + ")";
      pnlEl.className = "mono " + (myPos.pnl >= 0 ? "text-primary" : "text-destructive");
      document.getElementById("yp-fees").textContent = fmt.usd2(myPos.fees);
    }

    // ---- alerts ---------------------------------------------------------
    document.getElementById("alert-btn").addEventListener("click", () => {
      const on = [...document.querySelectorAll("[data-alert]:checked")].map((c) => c.dataset.alert);
      if (!on.length) { UI.toast("Pick at least one alert.", "accent"); return; }
      UI.toast(`<b>Alerts on for ${v.name}.</b><br>Watching: ${on.join(", ")}. (Demo — wire to Telegram/email in production.)`, "primary");
    });

    function setText(id, t, cls) { const e = document.getElementById(id); e.textContent = t; if (cls) e.className = "display text-2xl font-semibold mt-1 " + cls; }
    function shortAddr(x) { return x.slice(0, 6) + "…" + x.slice(-4); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
