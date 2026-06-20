// Builder dashboard ("My agents"): aggregates the vaults you've deployed —
// AUM, investors, fees earned, current attested image — and lets you propose
// an image rotation (which opens an investor redemption window).
(function () {
  "use strict";

  // Proposed rotations are persisted locally so a "redemption window open"
  // state survives reloads, like the create flow persists created vaults.
  const ROT_KEY = "eigenstrategies:rotations";
  function loadRotations() {
    try { return JSON.parse(localStorage.getItem(ROT_KEY) || "{}"); } catch { return {}; }
  }
  function saveRotation(id, rec) {
    const all = loadRotations();
    all[id] = rec;
    try { localStorage.setItem(ROT_KEY, JSON.stringify(all)); } catch {}
  }

  function start() {
    if (!window.ES || !window.UI) return setTimeout(start, 30);
    const { fmt } = ES;
    const wallet = UI.getWallet();
    const agents = ES.myAgents(wallet?.address);

    const empty = document.getElementById("empty");
    const dash = document.getElementById("dash");

    if (!agents.length) {
      empty.classList.remove("hidden");
      document.getElementById("connect-cta").addEventListener("click", () => {
        document.querySelector("[data-wallet-btn]")?.click();
      });
      return;
    }
    dash.classList.remove("hidden");

    // ---- builder identity ----------------------------------------------
    const display = wallet?.address
      ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
      : "you.eth";
    const allAttested = agents.every((v) => v.attested);
    document.getElementById("b-tile").textContent = display[0]?.toUpperCase() || "B";
    document.getElementById("b-name").innerHTML =
      `<span class="mono">${display}</span> ${allAttested
        ? '<span class="badge badge-attested">verified builder</span>'
        : '<span class="badge badge-pending">attestation pending</span>'}`;
    const oldest = Math.max(...agents.map((v) => v.ageDays));
    document.getElementById("b-sub").textContent =
      `${agents.length} agent${agents.length > 1 ? "s" : ""} · building for ${oldest}d`;
    if (!wallet?.address) document.getElementById("b-connect-hint").classList.remove("hidden");

    // ---- summary --------------------------------------------------------
    const earnings = new Map(agents.map((v) => [v.id, ES.builderEarnings(v)]));
    const totalAum = agents.reduce((s, v) => s + v.tvl, 0);
    const totalInv = agents.reduce((s, v) => s + v.investors, 0);
    const totalFees = agents.reduce((s, v) => s + earnings.get(v.id).total, 0);
    const avgApr = agents.reduce((s, v) => s + v.stats.apr, 0) / agents.length;
    document.getElementById("s-count").textContent = String(agents.length);
    document.getElementById("s-aum").textContent = fmt.usd(totalAum);
    document.getElementById("s-inv").textContent = totalInv.toLocaleString();
    document.getElementById("s-fees").textContent = fmt.usd(totalFees);
    const aprEl = document.getElementById("s-apr");
    aprEl.textContent = fmt.pct(avgApr);
    aprEl.className = "display text-2xl font-semibold mt-1 " + (avgApr >= 0 ? "text-primary" : "text-destructive");

    // ---- agent rows -----------------------------------------------------
    const rotations = loadRotations();
    const rows = document.getElementById("a-rows");

    function imageOf(v) {
      // current active image hash from the rotation history
      const active = ES.versions(v).find((x) => x.status === "active");
      return active ? active.hash : (v.imageHash || "0x…");
    }

    function render() {
      rows.innerHTML = "";
      for (const v of agents) {
        const e = earnings.get(v.id);
        const pending = rotations[v.id];
        const apr = v.stats.apr;
        const tr = document.createElement("tr");
        tr.className = "border-t border-default row-hover transition align-middle";
        tr.innerHTML = `
          <td class="px-5 py-4">
            <a href="./vault.html?id=${v.id}" class="flex items-center gap-3">
              <div class="h-9 w-9 rounded-md flex items-center justify-center display font-semibold ${v.attested ? "icon-tile-primary" : "icon-tile-accent"}">${v.letter}</div>
              <div>
                <div class="font-medium flex items-center gap-2">${v.name}
                  ${v.attested ? '<span class="badge badge-attested">attested</span>' : '<span class="badge badge-pending">pending</span>'}
                  ${pending ? '<span class="badge badge-pending">redeem · 24h</span>' : ""}
                </div>
                <div class="mono text-xs text-muted">${v.archetypeLabel} · ${v.markets.map((m) => m.replace("-PERP", "")).join("/")}</div>
              </div>
            </a>
          </td>
          <td class="px-5 py-4" data-spark></td>
          <td class="px-5 py-4 text-right mono">${fmt.usd(v.tvl)}</td>
          <td class="px-5 py-4 text-right mono">${v.investors.toLocaleString()}</td>
          <td class="px-5 py-4 text-right mono ${apr >= 0 ? "text-primary" : "text-destructive"}">${fmt.pct(apr)}</td>
          <td class="px-5 py-4 text-right mono" title="Performance: ${fmt.usd2(e.perfFees)}&#10;Per-trade: ${fmt.usd2(e.txFees)}&#10;on ${fmt.usd(e.volume)} traded">${fmt.usd(e.total)}</td>
          <td class="px-5 py-4 mono text-xs text-muted">${imageOf(v)}</td>
          <td class="px-5 py-4 text-right whitespace-nowrap">
            <a href="./vault.html?id=${v.id}" class="btn-ghost inline-block mr-1">View</a>
            <button class="btn-ghost" data-rotate="${v.id}">Rotate</button>
          </td>`;
        rows.appendChild(tr);
        const cell = tr.querySelector("[data-spark]");
        cell.appendChild(UI.sparkline(v.series60.live, { w: 80, h: 26 }));
      }
      rows.querySelectorAll("[data-rotate]").forEach((b) =>
        b.addEventListener("click", () => openRotate(b.dataset.rotate)));
    }

    // ---- rotation modal -------------------------------------------------
    const modal = document.getElementById("rotate-modal");
    let activeId = null;
    function closeRotate() { modal.classList.add("hidden"); activeId = null; }
    function openRotate(id) {
      const v = agents.find((x) => x.id === id);
      if (!v) return;
      activeId = id;
      document.getElementById("rm-name").textContent = v.name;
      document.getElementById("rm-current").textContent = imageOf(v);
      const hash = document.getElementById("rm-hash");
      const note = document.getElementById("rm-note");
      hash.value = "";
      note.value = "";
      modal.classList.remove("hidden");
      hash.focus();
    }
    document.getElementById("rm-close").addEventListener("click", closeRotate);
    document.getElementById("rm-cancel").addEventListener("click", closeRotate);
    modal.addEventListener("click", (ev) => { if (ev.target === modal) closeRotate(); });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeRotate(); });

    document.getElementById("rm-submit").addEventListener("click", () => {
      if (!activeId) return;
      const v = agents.find((x) => x.id === activeId);
      let hash = document.getElementById("rm-hash").value.trim();
      const note = document.getElementById("rm-note").value.trim() || "Strategy image rotation";
      if (!hash) {
        // generate a plausible attested digest if the builder didn't paste one
        const seed = ES.seedFrom(v.id + ":" + Date.now());
        hash = "0x" + (seed >>> 0).toString(16).padStart(8, "0") + "…" + (seed % 65536).toString(16).padStart(4, "0");
      }
      saveRotation(v.id, { newHash: hash, note, proposedAt: Date.now() });
      rotations[v.id] = { newHash: hash, note, proposedAt: Date.now() };
      closeRotate();
      render();
      UI.toast(`<b>Rotation proposed for ${v.name}.</b><br>New image <span class="mono">${hash}</span>. A 24h redemption window is now open; accept after it closes to take authority. <span class="text-muted">(Prototype — no on-chain tx sent.)</span>`, "accent");
    });

    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
