// Discover page: hero stats, filterable + sortable vault table with
// sparklines, and a side-by-side compare drawer.
(function () {
  "use strict";
  function start() {
    if (!window.ES || !window.UI) return setTimeout(start, 30);
    const { ARCHETYPES, fmt } = ES;
    // sample vaults + builder-created vaults (local cache, synced from the
    // shared store). Kept mutable so we can re-render when the store updates.
    const VAULTS = [];
    function refreshVaults() {
      VAULTS.length = 0;
      VAULTS.push(...ES.VAULTS, ...ES.loadCustomVaults());
    }
    refreshVaults();

    // ---- hero stats -----------------------------------------------------
    function refreshHero() {
      document.getElementById("stat-tvl").textContent = fmt.usd(VAULTS.reduce((s, v) => s + v.tvl, 0));
      document.getElementById("stat-vaults").textContent = String(VAULTS.length);
      document.getElementById("stat-investors").textContent = VAULTS.reduce((s, v) => s + v.investors, 0).toLocaleString();
    }
    refreshHero();

    // ---- filter state ---------------------------------------------------
    const filters = { type: new Set(), market: new Set(), lev: new Set(), search: "", attested: false };
    const compare = new Set();

    // build filter chips
    const types = [...new Set(VAULTS.map((v) => v.archetype))];
    const markets = [...new Set(VAULTS.flatMap((v) => v.markets))];
    const levBuckets = [["1x", (v) => v.maxLev <= 1], ["2-3x", (v) => v.maxLev >= 2 && v.maxLev <= 3], ["4x+", (v) => v.maxLev >= 4]];

    function chip(group, label, key) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = label;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        const set = filters[group];
        if (set.has(key)) set.delete(key); else set.add(key);
        b.setAttribute("aria-pressed", set.has(key));
        api.refresh();
      });
      return b;
    }
    const typeGroup = document.querySelector('[data-filtergroup="type"]');
    types.forEach((t) => typeGroup.appendChild(chip("type", ARCHETYPES[t].label, t)));
    const marketGroup = document.querySelector('[data-filtergroup="market"]');
    markets.forEach((m) => marketGroup.appendChild(chip("market", m.replace("-PERP", ""), m)));
    const levGroup = document.querySelector('[data-filtergroup="lev"]');
    levBuckets.forEach(([label]) => levGroup.appendChild(chip("lev", label, label)));

    document.getElementById("search").addEventListener("input", (e) => { filters.search = e.target.value.toLowerCase(); api.refresh(); });
    document.getElementById("filter-attested").addEventListener("change", (e) => { filters.attested = e.target.checked; api.refresh(); });

    function passes(v) {
      if (filters.attested && !v.attested) return false;
      if (filters.type.size && !filters.type.has(v.archetype)) return false;
      if (filters.market.size && !v.markets.some((m) => filters.market.has(m))) return false;
      if (filters.lev.size) {
        const ok = levBuckets.some(([label, fn]) => filters.lev.has(label) && fn(v));
        if (!ok) return false;
      }
      if (filters.search) {
        const hay = (v.name + " " + v.builder + " " + v.archetypeLabel + " " + v.markets.join(" ")).toLowerCase();
        if (!hay.includes(filters.search)) return false;
      }
      return true;
    }

    // ---- row rendering --------------------------------------------------
    const tbody = document.getElementById("vault-rows");
    const emptyState = document.getElementById("empty-state");

    function aprColor(n) { return n >= 0 ? "text-primary" : "text-destructive"; }

    function render(rows) {
      const visible = rows.filter(passes);
      tbody.innerHTML = "";
      emptyState.classList.toggle("hidden", visible.length > 0);
      for (const v of visible) {
        const tr = document.createElement("tr");
        tr.className = "border-t border-default row-hover transition";
        const tile = v.attested ? "icon-tile-primary" : "icon-tile-accent";
        const badge = v.attested
          ? '<span class="badge badge-attested">TEE attested</span>'
          : '<span class="badge badge-pending">attestation pending</span>';
        const capPct = Math.min(100, Math.round((v.tvl / v.capacity) * 100));
        tr.innerHTML = `
          <td class="px-4 py-4 text-center"><input type="checkbox" class="cmp-checkbox" data-cmp="${v.id}" ${compare.has(v.id) ? "checked" : ""}></td>
          <td class="px-4 py-4">
            <a href="./vault.html?id=${v.id}" class="flex items-center gap-3.5">
              <div class="h-9 w-9 rounded-md flex items-center justify-center display font-semibold ${tile}">${v.letter}</div>
              <div>
                <div class="font-medium flex items-center gap-2">${v.name} ${badge}</div>
                <div class="text-xs text-muted mono">${v.archetypeLabel} · by ${v.builder}</div>
              </div>
            </a>
          </td>
          <td class="px-2 py-4" data-spark></td>
          <td class="px-4 py-4 text-right mono">${fmt.usd(v.tvl)}</td>
          <td class="px-4 py-4 text-right mono font-semibold ${aprColor(v.apr30)}">${fmt.pct(v.apr30)}</td>
          <td class="px-4 py-4 text-right mono ${v.stats.sharpe >= 1 ? "text-primary" : "text-muted"}">${v.stats.sharpe.toFixed(2)}</td>
          <td class="px-4 py-4 text-right mono text-destructive">${fmt.pct(v.stats.mdd)}</td>
          <td class="px-4 py-4 text-right mono">${v.skin.toFixed(1)}%</td>
          <td class="px-4 py-4 text-right">
            <div class="mono text-xs">${capPct}% full</div>
            ${UI.gaugeBar(capPct, capPct > 85 ? UI.ACCENT : UI.PRIMARY)}
          </td>
          <td class="px-4 py-4 text-right mono text-muted text-xs">${fmt.bps(v.perfBps)} / ${fmt.bps(v.txBps)}</td>
          <td class="px-4 py-4 text-right"><a href="./vault.html?id=${v.id}" class="text-accent text-xs font-medium mono">VIEW →</a></td>`;
        tr.querySelector("[data-spark]").appendChild(UI.sparkline(v.series60.live));
        tr.querySelector("[data-cmp]").addEventListener("change", (e) => {
          if (e.target.checked) { if (compare.size >= 3) { e.target.checked = false; UI.toast("Compare up to 3 vaults at a time.", "accent"); return; } compare.add(v.id); }
          else compare.delete(v.id);
          renderCompareBar();
        });
        tbody.appendChild(tr);
      }
    }

    const api = UI.makeSortable(document.getElementById("vault-table"), VAULTS, render, {
      defaultKey: "apr", defaultDir: -1,
      value: (v, k) => ({
        name: v.name, tvl: v.tvl, apr: v.apr30, sharpe: v.stats.sharpe,
        mdd: v.stats.mdd, skin: v.skin, capacity: v.capacity,
      }[k]),
    });

    // re-render when the shared store syncs in newly-created vaults
    window.addEventListener("vaults:updated", () => {
      refreshVaults();
      refreshHero();
      api.refresh();
    });

    // ---- compare drawer + modal ----------------------------------------
    const bar = document.getElementById("compare-bar");
    const chipsEl = document.getElementById("compare-chips");
    function renderCompareBar() {
      bar.classList.toggle("hidden", compare.size === 0);
      chipsEl.innerHTML = "";
      compare.forEach((id) => {
        const v = ES.byId(id);
        const c = document.createElement("span");
        c.className = "badge";
        c.innerHTML = `${v.name} <button data-x="${id}" style="margin-left:4px">&times;</button>`;
        c.querySelector("[data-x]").addEventListener("click", () => {
          compare.delete(id);
          const cb = document.querySelector(`[data-cmp="${id}"]`);
          if (cb) cb.checked = false;
          renderCompareBar();
        });
        chipsEl.appendChild(c);
      });
    }
    document.getElementById("compare-clear").addEventListener("click", () => {
      compare.clear();
      document.querySelectorAll("[data-cmp]").forEach((cb) => (cb.checked = false));
      renderCompareBar();
    });
    document.getElementById("compare-open").addEventListener("click", openCompare);
    document.getElementById("compare-close").addEventListener("click", () => document.getElementById("compare-modal").classList.add("hidden"));

    function openCompare() {
      if (compare.size < 2) { UI.toast("Pick at least 2 vaults to compare.", "accent"); return; }
      const vs = [...compare].map((id) => ES.byId(id));
      const rows = [
        ["Builder", (v) => v.builder],
        ["Type", (v) => v.archetypeLabel],
        ["Markets", (v) => v.markets.map((m) => m.replace("-PERP", "")).join(", ")],
        ["Max leverage", (v) => v.maxLev + "x"],
        ["TVL", (v) => fmt.usd(v.tvl)],
        ["APR", (v) => fmt.pct(v.apr30)],
        ["Sharpe", (v) => v.stats.sharpe.toFixed(2)],
        ["Sortino", (v) => v.stats.sortino.toFixed(2)],
        ["Max drawdown", (v) => fmt.pct(v.stats.mdd)],
        ["Win rate", (v) => (v.stats.winRate * 100).toFixed(0) + "%"],
        ["Skin in game", (v) => v.skin.toFixed(1) + "%"],
        ["Capacity used", (v) => Math.round((v.tvl / v.capacity) * 100) + "%"],
        ["Perf / Tx fee", (v) => fmt.bps(v.perfBps) + " / " + fmt.bps(v.txBps)],
        ["BTC correlation", (v) => v.risk.corrBtc.toFixed(2)],
        ["Age", (v) => v.ageDays + "d"],
      ];
      const body = document.getElementById("compare-body");
      let html = '<table class="w-full text-sm"><thead><tr><th></th>';
      vs.forEach((v) => { html += `<th class="text-left px-3 py-2"><div class="display font-semibold">${v.name}</div><div class="mono text-xs text-muted" data-cmpspark="${v.id}"></div></th>`; });
      html += "</tr></thead><tbody>";
      rows.forEach(([label, fn]) => {
        html += `<tr class="border-t border-default"><td class="px-3 py-2 mono text-xs uppercase tracking-wider text-muted">${label}</td>`;
        vs.forEach((v) => { html += `<td class="px-3 py-2 mono">${fn(v)}</td>`; });
        html += "</tr>";
      });
      html += "</tbody></table>";
      body.innerHTML = html;
      vs.forEach((v) => body.querySelector(`[data-cmpspark="${v.id}"]`).appendChild(UI.sparkline(v.series60.live, { w: 120, h: 26 })));
      document.getElementById("compare-modal").classList.remove("hidden");
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
