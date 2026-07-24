-- Signal de vie du worker (item 4.9). Ligne unique id='worker' : le worker upsert beat_at à intervalle court
-- (HEARTBEAT_INTERVAL_MS). /ops/overview lit l'âge du dernier battement pour détecter un worker mort — un
-- crash-loop au boot était jusqu'ici invisible (mba-api répond 200 pendant que le worker redémarre en boucle).
-- Table en schéma public (le pool worker n'a pas de search_path custom -> résolution nue). Simple create table,
-- compatible migrate.ts (begin/commit). PAS de CREATE INDEX CONCURRENTLY ici (cf. avertissement 0042).
create table if not exists worker_heartbeat (
  id text primary key,
  beat_at timestamptz not null default now(),
  booted_at timestamptz,
  instance text
);
