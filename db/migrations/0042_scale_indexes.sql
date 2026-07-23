-- 0042_scale_indexes.sql — index de montée en charge (AUDIT-SCALE item 3.1 / B8c).
--
-- ADD-only, aucune colonne touchée. Migrer AVANT le deploy (convention repo pour un ADD ; ici l'ordre
-- reste tolérant, aucun code neuf ne dépend de ces index, le planner s'en sert seul).
--
-- ⚠️ PAS de CREATE INDEX CONCURRENTLY : db/migrate.ts enveloppe chaque fichier dans begin/commit
-- (migrate.ts:47-50), or CONCURRENTLY est interdit en transaction (SQLSTATE 25001) -> tout le fichier
-- rollbackerait. Un CREATE INDEX classique prend un verrou SHARE bloquant les écritures pendant le build.
-- Sur les tables ACTUELLES (pilote, quelques dizaines/centaines de lignes) c'est instantané. Sur une grosse
-- table (contacts 600k, conversation_messages en millions), NE PAS passer par ce runner : jouer ces
-- CREATE INDEX en CONCURRENTLY via psql hors transaction, puis insérer 0042 à la main dans schema_migrations.
-- Même mise en garde que 0032 et 0039.

-- 1) contacts : la page Contacts et le build d'audience font `where tenant_id = $1 order by created_at desc`
--    (contact-store.pg.ts query()/list()/idsForFilters()/count()). Les 2 index btree tenant_id (0001:58-61)
--    sont PARTIELS (where phone_e164 is not null / where bsuid is not null) -> un `where tenant_id` seul ne
--    les implique pas et seq-scanne tous les tenants confondus.
create index if not exists contacts_tenant_created_idx
  on contacts (tenant_id, created_at desc);

-- 2) conversation_messages : ops.getGlobalDaily() (ops/store.pg.ts:96-99) fait `where created_at >= now()-N`.
--    conversation_messages_conv_idx (0009:28) mène par conversation_id -> inutilisable pour created_at seul.
create index if not exists conversation_messages_created_idx
  on conversation_messages (created_at);

-- 3) phone_numbers : getTenantPhoneNumberId() (campaign/store.pg.ts:382, plusieurs chemins d'envoi) +
--    account/ops font `where tenant_id = $1 order by created_at limit 1`. La table n'a que la PK sur id.
create index if not exists phone_numbers_tenant_created_idx
  on phone_numbers (tenant_id, created_at);

-- 4) waba : getTenantWabaId() (campaign/store.pg.ts:373) fait `where tenant_id = $1 order by created_at limit 1`.
create index if not exists waba_tenant_created_idx
  on waba (tenant_id, created_at);

-- 5) conversation_messages.sender_user_id : FK users on delete set null (0017). deleteUser()
--    (user/store.pg.ts:240-247) supprime réellement un compte -> set null à retrouver sur la plus grosse table.
--    Partiel : la quasi-totalité des messages ont sender_user_id null (seul l'outbound humain le renseigne).
create index if not exists conversation_messages_sender_idx
  on conversation_messages (sender_user_id) where sender_user_id is not null;

-- 6) workflow_runs.workflow_id : FK workflows on delete cascade (0023). deleteWorkflow()
--    (workflow/store.pg.ts:66, méthode remove()) supprime réellement un workflow -> cascade.
--    workflow_runs_waiting_idx (0023) est partiel (where status='waiting') et ne couvre pas la cascade.
create index if not exists workflow_runs_workflow_idx
  on workflow_runs (workflow_id);
