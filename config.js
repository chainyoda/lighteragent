// Runtime config for the EigenStrategies prototype.
//
// To make builder-created vaults shared across all devices/visitors, point
// this at a free Supabase project. Leave the placeholders as-is and the app
// falls back to per-browser localStorage (still fully functional).
//
// Setup (≈5 min):
//   1. Create a free project at https://supabase.com
//   2. In the SQL editor, run:
//
//        create table if not exists vaults (
//          addr text primary key,
//          data jsonb not null,
//          created_at timestamptz default now()
//        );
//        alter table vaults enable row level security;
//        create policy "public read"   on vaults for select using (true);
//        create policy "public insert" on vaults for insert with check (true);
//        create policy "public update" on vaults for update using (true);
//
//   3. Settings → API: copy the Project URL and the anon/public key below.
//      (The anon key is safe to ship in client code — access is governed by
//      the row-level-security policies above.)
//
window.ES_CONFIG = {
  SUPABASE_URL: "YOUR_SUPABASE_URL",       // e.g. https://abcd1234.supabase.co
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",
};
