// Portfolio page: aggregates the connected wallet's vault positions.
(function () {
  "use strict";
  function start() {
    if (!window.ES || !window.UI) return setTimeout(start, 30);
    const { fmt } = ES;
    const wallet = UI.getWallet();

    const disc = document.getElementById("disconnected");
    const conn = document.getElementById("connected");

    if (!wallet?.address) {
      disc.classList.remove("hidden");
      document.getElementById("connect-cta").addEventListener("click", () => {
        const btn = document.querySelector("[data-wallet-btn]");
        if (btn) btn.click();
      });
      return;
    }

    conn.classList.remove("hidden");
    const port = ES.portfolio(wallet.address);

    document.getElementById("p-value").textContent = fmt.usd2(port.totalValue);
    document.getElementById("p-cost").textContent = fmt.usd2(port.totalCost);
    const pnlEl = document.getElementById("p-pnl");
    pnlEl.textContent = (port.totalPnl >= 0 ? "+" : "") + fmt.usd2(port.totalPnl);
    pnlEl.className = "display text-2xl font-semibold mt-1 " + (port.totalPnl >= 0 ? "text-primary" : "text-destructive");
    document.getElementById("p-fees").textContent = fmt.usd2(port.feesPaid);

    const rows = document.getElementById("p-rows");
    const empty = document.getElementById("p-empty");
    if (!port.positions.length) { empty.classList.remove("hidden"); return; }

    // redemption-window banner
    const redeeming = port.positions.filter((p) => p.redemption);
    if (redeeming.length) {
      const banner = document.getElementById("redemption-banner");
      banner.classList.remove("hidden");
      banner.innerHTML = `<span class="badge badge-pending">Action</span>
        <span class="ml-2">${redeeming.map((p) => p.name).join(", ")} ${redeeming.length > 1 ? "have" : "has"} an open redemption window — review the new strategy image or redeem at the last high-water mark.</span>`;
    }

    for (const p of port.positions) {
      const tr = document.createElement("tr");
      tr.className = "border-t border-default row-hover transition";
      tr.innerHTML = `
        <td class="px-5 py-4">
          <a href="./vault.html?id=${p.id}" class="flex items-center gap-3">
            <div class="h-9 w-9 rounded-md flex items-center justify-center display font-semibold ${p.attested ? "icon-tile-primary" : "icon-tile-accent"}">${p.letter}</div>
            <div class="font-medium flex items-center gap-2">${p.name} ${p.redemption ? `<span class="badge badge-pending">${p.redemption}</span>` : ""}</div>
          </a>
        </td>
        <td class="px-5 py-4 text-right mono">${fmt.num(p.shares, 3)}</td>
        <td class="px-5 py-4 text-right mono">${fmt.usd2(p.value)}</td>
        <td class="px-5 py-4 text-right mono ${p.pnl >= 0 ? "text-primary" : "text-destructive"}">${p.pnl >= 0 ? "+" : ""}${fmt.usd2(p.pnl)} <span class="text-xs">(${fmt.pct(p.ret)})</span></td>
        <td class="px-5 py-4 text-right mono text-muted">${fmt.usd2(p.fees)}</td>
        <td class="px-5 py-4 text-right"><a href="./vault.html?id=${p.id}" class="text-accent text-xs font-medium mono">MANAGE →</a></td>`;
      rows.appendChild(tr);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
