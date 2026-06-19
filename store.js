// Shared vault store with a Supabase backend and a localStorage fallback.
//
// - When window.ES_CONFIG has a real Supabase URL + anon key, created vaults
//   are read from / written to a shared `vaults` table, so they're visible on
//   every device and to every visitor.
// - Otherwise (or if the network call fails), everything falls back to
//   per-browser localStorage, so the app keeps working with no setup.
//
// localStorage and Supabase share one record shape (the vault "spec" the
// create flow builds). data.js reads the same localStorage key, so a synced
// remote vault transparently shows up in byId()/loadCustomVaults().
//
// Exposes window.VaultStore and dispatches a "vaults:updated" window event
// whenever the local cache changes (initial sync, save).

(function () {
  "use strict";
  const KEY = "eigenstrategies:vaults";
  const cfg = window.ES_CONFIG || {};
  const URL = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
  const ANON = cfg.SUPABASE_ANON_KEY || "";
  const REMOTE = !!URL && !!ANON && !/^YOUR_/.test(URL) && !/^YOUR_/.test(ANON);

  function localAll() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } }
  function localSet(obj) { try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch {} }
  function dispatch() { try { window.dispatchEvent(new Event("vaults:updated")); } catch {} }

  function headers(extra) {
    return Object.assign({ apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, extra || {});
  }

  async function remoteList() {
    const r = await fetch(URL + "/rest/v1/vaults?select=addr,data", { headers: headers() });
    if (!r.ok) throw new Error("supabase list " + r.status);
    const rows = await r.json();
    // each row: { addr, data: <spec> } -> spec (ensure addr present)
    return rows.map((x) => Object.assign({ addr: x.addr }, x.data || {}));
  }

  async function remoteSave(rec) {
    // upsert on addr (merge-duplicates) so re-listing the same vault is idempotent
    const r = await fetch(URL + "/rest/v1/vaults", {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ addr: rec.addr, data: rec }),
    });
    if (!r.ok) throw new Error("supabase save " + r.status);
    return true;
  }

  const Store = {
    configured: REMOTE,

    // synchronous: the local cache (which includes the most recent remote sync)
    list() { return Object.values(localAll()); },

    // pull shared vaults into the local cache, then notify listeners
    async sync() {
      if (!REMOTE) return false;
      try {
        const remote = await remoteList();
        const all = localAll();
        for (const rec of remote) if (rec.addr) all[rec.addr] = Object.assign(all[rec.addr] || {}, rec);
        localSet(all);
        dispatch();
        return true;
      } catch (e) {
        console.warn("[store] sync failed, using local cache:", e.message || e);
        return false;
      }
    },

    // write locally (immediate) and to the shared store (best-effort)
    async save(rec) {
      const all = localAll();
      all[rec.addr] = rec;
      localSet(all);
      dispatch();
      let remote = false;
      if (REMOTE) {
        try { remote = await remoteSave(rec); }
        catch (e) { console.warn("[store] remote save failed, kept locally:", e.message || e); }
      }
      return { local: true, remote };
    },
  };

  window.VaultStore = Store;
  // background sync on load; the "vaults:updated" event re-renders the UI
  if (REMOTE) Store.sync();
})();
