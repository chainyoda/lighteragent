// Shared UI helpers: SVG charts, sparklines, sortable tables, toasts.
// Depends on window.ES (data.js). Exposes window.UI.

(function () {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  const PRIMARY = "oklch(0.475 0.095 158)";
  const ACCENT = "oklch(0.75 0.185 45)";
  const MUTED = "oklch(0.485 0.008 286)";
  const DESTRUCTIVE = "oklch(0.53 0.19 28)";

  function el(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function pathFor(series, w, h, pad) {
    const min = Math.min(...series), max = Math.max(...series);
    const span = max - min || 1;
    return series.map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - pad * 2) - pad;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }

  // small inline sparkline for table rows
  function sparkline(series, opts = {}) {
    const w = opts.w || 96, h = opts.h || 28;
    const up = series[series.length - 1] >= series[0];
    const color = opts.color || (up ? PRIMARY : DESTRUCTIVE);
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: "spark" });
    const min = Math.min(...series), max = Math.max(...series), span = max - min || 1;
    const d = pathFor(series, w, h, 3);
    svg.appendChild(el("path", { d, fill: "none", stroke: color, "stroke-width": "1.5" }));
    return svg;
  }

  // big equity chart with optional backtest overlay + drawdown shading
  function equityChart(container, { live, backtest, showBacktest = true, showDrawdown = false, w = 760, h = 180 }) {
    container.innerHTML = "";
    const pad = 12;
    const all = backtest && showBacktest ? live.concat(backtest) : live.slice();
    const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
    const yOf = (v) => h - ((v - min) / span) * (h - pad * 2) - pad;
    const xOf = (i, len) => (i / (len - 1)) * w;

    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, class: "w-full", style: `height:${h}px` });
    const defs = el("defs", {});
    defs.innerHTML = `<linearGradient id="eq-grad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${PRIMARY}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${PRIMARY}" stop-opacity="0"/></linearGradient>`;
    svg.appendChild(defs);

    // baseline at starting NAV
    const y0 = yOf(live[0]);
    svg.appendChild(el("line", { x1: 0, y1: y0, x2: w, y2: y0, stroke: "oklch(var(--border))", "stroke-dasharray": "3 4", "stroke-width": 1 }));

    // drawdown shading (under-water regions vs running peak)
    if (showDrawdown) {
      let peak = live[0];
      let seg = [];
      const flush = () => {
        if (seg.length > 1) {
          let d = "";
          seg.forEach((p, i) => { d += `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)} `; });
          // close along the peak line
          for (let i = seg.length - 1; i >= 0; i--) d += `L${seg[i].x.toFixed(1)},${seg[i].py.toFixed(1)} `;
          svg.appendChild(el("path", { d: d + "Z", fill: DESTRUCTIVE, "fill-opacity": "0.10", stroke: "none" }));
        }
        seg = [];
      };
      live.forEach((v, i) => {
        if (v >= peak) { peak = v; flush(); }
        else seg.push({ x: xOf(i, live.length), y: yOf(v), py: yOf(peak) });
      });
      flush();
    }

    // backtest line (dashed, muted)
    if (backtest && showBacktest) {
      const db = backtest.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i, backtest.length).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
      svg.appendChild(el("path", { d: db, fill: "none", stroke: MUTED, "stroke-width": 1.5, "stroke-dasharray": "4 4", opacity: 0.75 }));
    }

    // live area + line
    const dl = live.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i, live.length).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
    svg.appendChild(el("path", { d: dl + ` L${w},${h} L0,${h} Z`, fill: "url(#eq-grad)" }));
    svg.appendChild(el("path", { d: dl, fill: "none", stroke: PRIMARY, "stroke-width": 2 }));

    container.appendChild(svg);
  }

  // tiny histogram of daily returns
  function histogram(container, rets, { w = 340, h = 90 } = {}) {
    container.innerHTML = "";
    const bins = 21;
    const max = Math.max(...rets.map(Math.abs)) || 0.01;
    const counts = new Array(bins).fill(0);
    rets.forEach((r) => {
      let idx = Math.floor(((r + max) / (2 * max)) * bins);
      idx = Math.max(0, Math.min(bins - 1, idx));
      counts[idx]++;
    });
    const cmax = Math.max(...counts) || 1;
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, class: "w-full", style: `height:${h}px` });
    const bw = w / bins;
    counts.forEach((c, i) => {
      const bh = (c / cmax) * (h - 4);
      const center = i < bins / 2;
      svg.appendChild(el("rect", {
        x: (i * bw + 1).toFixed(1), y: (h - bh).toFixed(1),
        width: (bw - 2).toFixed(1), height: bh.toFixed(1), rx: 1,
        fill: center ? DESTRUCTIVE : PRIMARY, "fill-opacity": "0.55",
      }));
    });
    svg.appendChild(el("line", { x1: w / 2, y1: 0, x2: w / 2, y2: h, stroke: "oklch(var(--border))", "stroke-width": 1 }));
    container.appendChild(svg);
  }

  // horizontal labelled bar (0..100) used for risk gauges
  function gaugeBar(pct, color = PRIMARY) {
    const clamped = Math.max(0, Math.min(100, pct));
    return `<div style="height:6px;border-radius:999px;background:oklch(var(--well));overflow:hidden;margin-top:6px">
      <div style="height:100%;width:${clamped}%;background:${color};border-radius:999px"></div></div>`;
  }

  // make a table sortable by clicking its <th data-key>
  function makeSortable(table, rows, render, opts = {}) {
    let key = opts.defaultKey, dir = opts.defaultDir || -1;
    const ths = table.querySelectorAll("th[data-key]");
    function apply() {
      const sorted = rows.slice().sort((a, b) => {
        const av = opts.value(a, key), bv = opts.value(b, key);
        if (typeof av === "string") return dir * av.localeCompare(bv);
        return dir * (av - bv);
      });
      render(sorted);
      ths.forEach((th) => {
        const arrow = th.querySelector(".sort-arrow");
        if (arrow) arrow.textContent = th.dataset.key === key ? (dir < 0 ? "↓" : "↑") : "";
        th.classList.toggle("text-[color:oklch(var(--foreground))]", th.dataset.key === key);
      });
    }
    ths.forEach((th) => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        if (key === th.dataset.key) dir = -dir;
        else { key = th.dataset.key; dir = -1; }
        apply();
      });
    });
    apply();
    return { refresh: apply };
  }

  // lightweight toast for alert-subscription confirmations etc.
  function toast(msg, kind = "primary") {
    let host = document.getElementById("toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast-host";
      host.style.cssText = "position:fixed;right:1rem;bottom:1rem;z-index:80;display:flex;flex-direction:column;gap:0.5rem;";
      document.body.appendChild(host);
    }
    const t = document.createElement("div");
    const color = kind === "destructive" ? DESTRUCTIVE : kind === "accent" ? ACCENT : PRIMARY;
    t.style.cssText = `background:oklch(var(--card));border:1px solid ${color};border-left:3px solid ${color};border-radius:0.5rem;padding:0.75rem 1rem;font-size:0.8rem;max-width:320px;box-shadow:0 8px 24px oklch(0.2 0 0 / 0.12);color:oklch(var(--foreground));`;
    t.innerHTML = msg;
    host.appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 3600);
  }

  function getWallet() {
    try { return JSON.parse(localStorage.getItem("eigenvaults:wallet")); } catch { return null; }
  }

  window.UI = { sparkline, equityChart, histogram, gaugeBar, makeSortable, toast, getWallet, PRIMARY, ACCENT, MUTED, DESTRUCTIVE };
})();
