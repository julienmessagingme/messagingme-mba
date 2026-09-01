-- migrate: no-transaction
--
-- 0097_index_retention.sql — les index des quatre balayages de rétention (programme II, lot 4).
--
-- 🔴 HORS TRANSACTION comme 0096, et pour la même raison : `CREATE INDEX CONCURRENTLY` est interdit dans un
-- bloc de transaction. Chaque instruction est idempotente, parce qu'un échec à mi-parcours n'annule rien et
-- que la migration sera rejouée depuis le début (cf. `db/migrate.ts`).
--
-- ⚠️ Les index de lecture EXISTANTS ne servent à aucun de ces balayages : ils commencent tous par
-- `tenant_id`, alors qu'une purge balaye la table ENTIÈRE par date, tous espaces confondus. C'est exactement
-- le cas où un index « il y en a déjà un » n'en est pas un.
--
-- ⚠️ Comme en 0096, ces index ne changeront rien sur la production d'aujourd'hui (quelques dizaines de lignes
-- par table). Ils sont posés en même temps que le code qui les utilisera, pour ne pas laisser un balayage
-- horaire faire un seq scan complet le jour où la table pèse.

-- 1) Anonymisation des événements de blocs. PARTIEL sur « pas encore anonymisé » : l'index rétrécit à mesure
-- que le balayage avance, et il devient vide quand tout est à jour, ce qui est l'état normal.
create index concurrently if not exists wf_node_events_anonymisation_idx
  on workflow_node_events (at) where wa_id <> 'anonyme';

-- 2) Purge des parcours TERMINÉS. PARTIEL sur les statuts terminaux : les parcours vivants (`waiting`,
-- `sleeping`) n'entrent jamais dans l'index, donc jamais dans le balayage. La garde est ici, en base, autant
-- que dans la requête.
create index concurrently if not exists workflow_runs_termines_idx
  on workflow_runs (updated_at) where status in ('done', 'inbox');

-- 3) Purge des clics tracés. L'index de lecture est `(tenant_id, code, at)` : inutilisable pour un balayage
-- global par date.
create index concurrently if not exists tracked_link_clicks_purge_idx
  on tracked_link_clicks (at);

-- 4) Purge du journal d'audit. Même raison : son index de lecture est `(tenant_id, at desc)`.
create index concurrently if not exists audit_log_purge_idx
  on audit_log (at);
