// Wallet connection via EIP-6963 multi-injected provider discovery.
// Discovers MetaMask, Rabby, Coinbase Wallet, Phantom, OKX, Brave, etc. automatically.

const PROVIDERS = new Map();
let connected = null;

function shorten(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

window.addEventListener("eip6963:announceProvider", (e) => {
  const { info, provider } = e.detail;
  PROVIDERS.set(info.uuid, { info, provider });
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function loadStored() {
  try {
    const raw = localStorage.getItem("eigenvaults:wallet");
    if (raw) connected = JSON.parse(raw);
  } catch {}
}
function persist() {
  if (connected) localStorage.setItem("eigenvaults:wallet", JSON.stringify(connected));
  else localStorage.removeItem("eigenvaults:wallet");
}

function renderButton() {
  document.querySelectorAll("[data-wallet-btn]").forEach((btn) => {
    if (connected) {
      btn.innerHTML = `<span class="mono">${shorten(connected.address)}</span>`;
      btn.title = `Connected with ${connected.walletName}\nClick to disconnect`;
    } else {
      btn.innerHTML = "Connect wallet";
      btn.title = "";
    }
  });
}

function openModal() {
  const existing = document.getElementById("wallet-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "wallet-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:oklch(0.255 0.012 122 / 0.45);backdrop-filter:blur(4px);z-index:50;display:flex;align-items:center;justify-content:center;padding:1rem;";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:oklch(var(--card));border:1px solid oklch(var(--border));border-radius:0.75rem;width:100%;max-width:420px;overflow:hidden;font-family:Geist,system-ui,sans-serif;color:oklch(var(--foreground));";

  const header = document.createElement("div");
  header.style.cssText = "padding:1.25rem 1.5rem;border-bottom:1px solid oklch(var(--border));display:flex;align-items:center;justify-content:space-between;";
  header.innerHTML = `
    <div>
      <div style="font-family:'Geist Mono',monospace;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.12em;color:oklch(var(--muted-foreground));">Connect</div>
      <div style="font-family:Syne,Geist,sans-serif;font-size:1.25rem;font-weight:600;letter-spacing:-0.02em;margin-top:0.125rem;">Choose a wallet</div>
    </div>
    <button id="wallet-close" style="background:transparent;border:0;color:oklch(var(--muted-foreground));font-size:1.5rem;line-height:1;cursor:pointer;padding:0 0.25rem;">×</button>
  `;
  modal.appendChild(header);

  const list = document.createElement("div");
  list.style.cssText = "padding:0.75rem;display:flex;flex-direction:column;gap:0.375rem;max-height:60vh;overflow:auto;";

  const providers = Array.from(PROVIDERS.values());
  if (providers.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:1.5rem;text-align:center;color:oklch(var(--muted-foreground));font-size:0.875rem;line-height:1.6;";
    empty.innerHTML = `
      No wallet detected.<br/>
      <a href="https://metamask.io/download/" target="_blank" rel="noopener" style="color:oklch(var(--accent));text-decoration:underline;">Install MetaMask</a>,
      <a href="https://rabby.io" target="_blank" rel="noopener" style="color:oklch(var(--accent));text-decoration:underline;">Rabby</a>, or
      <a href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noopener" style="color:oklch(var(--accent));text-decoration:underline;">Coinbase Wallet</a>.
    `;
    list.appendChild(empty);
  } else {
    providers.forEach(({ info, provider }) => {
      const row = document.createElement("button");
      row.style.cssText =
        "display:flex;align-items:center;gap:0.875rem;padding:0.75rem 1rem;border:1px solid oklch(var(--border));border-radius:0.625rem;background:transparent;cursor:pointer;width:100%;text-align:left;color:inherit;font:inherit;transition:border-color 0.15s,background 0.15s;";
      row.onmouseenter = () => { row.style.borderColor = "oklch(var(--foreground))"; row.style.background = "oklch(var(--well) / 0.5)"; };
      row.onmouseleave = () => { row.style.borderColor = "oklch(var(--border))"; row.style.background = "transparent"; };
      row.innerHTML = `
        <img src="${info.icon}" alt="" style="width:32px;height:32px;border-radius:0.5rem;flex-shrink:0;" onerror="this.style.display='none'"/>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;">${info.name}</div>
          <div style="font-family:'Geist Mono',monospace;font-size:0.7rem;color:oklch(var(--muted-foreground));margin-top:0.125rem;">${info.rdns}</div>
        </div>
        <span style="color:oklch(var(--muted-foreground));font-size:0.875rem;">→</span>
      `;
      row.addEventListener("click", () => connect(provider, info, overlay));
      list.appendChild(row);
    });
  }
  modal.appendChild(list);

  const footer = document.createElement("div");
  footer.style.cssText = "padding:0.875rem 1.5rem;border-top:1px solid oklch(var(--border));font-size:0.75rem;color:oklch(var(--muted-foreground));line-height:1.5;";
  footer.innerHTML = `EigenStrategies will request your address only. No transactions are signed in this prototype.`;
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.getElementById("wallet-close").addEventListener("click", () => overlay.remove());
}

async function connect(provider, info, overlay) {
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts[0]) throw new Error("No account returned");

    let chainId = null;
    try { chainId = await provider.request({ method: "eth_chainId" }); } catch {}

    connected = {
      address: accounts[0],
      walletName: info.name,
      walletRdns: info.rdns,
      chainId,
    };
    persist();
    renderButton();
    overlay.remove();

    provider.on?.("accountsChanged", (accs) => {
      if (!accs.length) disconnect();
      else { connected.address = accs[0]; persist(); renderButton(); }
    });
    provider.on?.("chainChanged", (cid) => {
      if (connected) { connected.chainId = cid; persist(); }
    });
  } catch (err) {
    console.error("[wallet] connect failed:", err);
    alert(err?.message || "Connection rejected.");
  }
}

function disconnect() {
  connected = null;
  persist();
  renderButton();
}

function init() {
  loadStored();
  renderButton();
  document.querySelectorAll("[data-wallet-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (connected) {
        if (confirm(`Disconnect ${connected.walletName} (${shorten(connected.address)})?`)) disconnect();
      } else {
        openModal();
      }
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
