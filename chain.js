// chain.js — live-deployment config loader for the EigenStrategies frontend.
//
// The prototype runs fully offline against deterministic mock data. This module
// is the *only* seam that makes it talk to a real deployment: it best-effort
// fetches `deployments.json` (a map of chainId -> contract addresses, shaped
// like `deployments.example.json`) and, if found, exposes the addresses for
// the active chain. If the file is missing, unreachable, or malformed — which
// is the normal case for the GitHub Pages prototype — it falls back silently
// to "prototype/simulated mode" and the app keeps working exactly as before.
//
// Nothing here is wired into the HTML yet (by design — non-breaking). To go
// live, include this script and read `window.CHAIN` after the `chain:ready`
// event. See BUILD.md ("Pointing the frontend at a live deployment").
//
// No build step, no dependencies — same plain-ES, "use strict" IIFE style as
// wallet.js / ui.js.

(function () {
  "use strict";

  // Which chain the UI should treat as active. Override before this script
  // loads via `window.CHAIN_ID = 42161`, or with `?chainId=` in the URL.
  function configuredChainId() {
    var fromUrl = new URLSearchParams(location.search).get("chainId");
    if (fromUrl && /^\d+$/.test(fromUrl)) return fromUrl;
    if (window.CHAIN_ID != null) return String(window.CHAIN_ID);
    return null; // no preference — pick the sole entry if there's exactly one
  }

  // Shape we hand the rest of the app. `live` flips true only when we have a
  // real, non-placeholder factory address for the active chain.
  var CHAIN = {
    ready: false, // becomes true once load() settles (success or fallback)
    live: false, // true => addresses are configured; false => simulated mode
    chainId: null, // decimal string of the active chain, or null
    rpcUrl: null,
    addresses: {}, // { vaultFactory, attestationRegistry, feeAccountant, lighterAdapter, usdc }
    isLive: function () {
      return this.live === true;
    },
  };

  var ZERO = "0x0000000000000000000000000000000000000000";

  // An address counts as configured only if it's present and not the zero
  // placeholder used throughout deployments.example.json.
  function isRealAddr(a) {
    return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
  }

  function pickEntry(deployments) {
    var wanted = configuredChainId();
    if (wanted && deployments[wanted]) return { chainId: wanted, entry: deployments[wanted] };

    // No explicit chainId: if exactly one real (non `_`-prefixed) chain entry
    // exists, use it. Otherwise we can't disambiguate — stay simulated.
    var keys = Object.keys(deployments).filter(function (k) {
      return k[0] !== "_";
    });
    if (keys.length === 1) return { chainId: keys[0], entry: deployments[keys[0]] };
    return null;
  }

  function applyEntry(chainId, entry) {
    CHAIN.chainId = chainId;
    CHAIN.rpcUrl = entry.rpcUrl || null;
    CHAIN.addresses = {
      vaultFactory: entry.vaultFactory || null,
      attestationRegistry: entry.attestationRegistry || null,
      feeAccountant: entry.feeAccountant || null,
      lighterAdapter: entry.lighterAdapter || null,
      usdc: entry.usdc || null,
    };
    // We consider the deployment "live" once the factory — the entry point the
    // frontend actually calls (createVault) — is a real address.
    CHAIN.live = isRealAddr(entry.vaultFactory);
  }

  function finish(reason) {
    CHAIN.ready = true;
    window.CHAIN = CHAIN;
    try {
      document.dispatchEvent(
        new CustomEvent("chain:ready", {
          detail: { live: CHAIN.live, chainId: CHAIN.chainId, reason: reason },
        })
      );
    } catch (_) {
      /* CustomEvent unsupported — config is still on window.CHAIN */
    }
    var mode = CHAIN.live ? "live (chainId " + CHAIN.chainId + ")" : "prototype/simulated";
    console.info("[chain] mode:", mode, reason ? "(" + reason + ")" : "");
  }

  function load() {
    // `fetch` may be unavailable (e.g. file:// in some browsers); degrade
    // gracefully to simulated mode rather than throwing.
    if (typeof fetch !== "function") {
      finish("no fetch — simulated");
      return;
    }
    fetch("deployments.json", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (deployments) {
        var picked = pickEntry(deployments || {});
        if (!picked) {
          finish("no matching chain in deployments.json — simulated");
          return;
        }
        applyEntry(picked.chainId, picked.entry);
        finish(CHAIN.live ? "loaded deployments.json" : "placeholder addresses — simulated");
      })
      .catch(function () {
        // Missing/unreachable/malformed deployments.json is the expected
        // offline case — fall back without surfacing an error to the user.
        finish("deployments.json not found — simulated");
      });
  }

  // Expose immediately (not-yet-ready) so callers can reference window.CHAIN
  // before the fetch resolves; they should still gate real work on chain:ready.
  window.CHAIN = CHAIN;
  load();
})();
