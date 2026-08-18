-- 0060 : journal d'audit des actions sur les contacts, et marqueur d'anonymisation.
--
-- DEUX besoins liés. Effacer réellement les données d'une personne (droit à l'effacement), et garder une trace
-- AUDITABLE de qui a fait quoi. Les deux ensemble, parce qu'une purge est irréversible : sans journal, elle ne
-- laisse aucune preuve qu'elle a eu lieu, ni de qui l'a demandée, ce qui est le pire des deux mondes.
--
-- ⚠️ LE JOURNAL NE PORTE JAMAIS DE DONNÉE PERSONNELLE. Il enregistre l'IDENTIFIANT INTERNE du contact, jamais
-- son numéro ni son nom. Y écrire le numéro au moment de la purge annulerait la purge elle-même : on effacerait
-- la personne d'un côté pour la réinscrire de l'autre, dans une table conçue pour ne jamais être modifiée.
--
-- `actor_email` est DÉNORMALISÉ à dessein : un journal doit rester lisible même quand le compte qui a agi a été
-- supprimé depuis. Une jointure sur `users` rendrait l'historique illisible au premier départ d'un collaborateur.

create table if not exists audit_log (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  at           timestamptz not null default now(),
  -- null = action du système (sweeper, worker, webhook), pas d'un humain.
  actor_user_id uuid,
  actor_email  text,
  action       text not null,
  target_kind  text not null,
  target_id    text not null,
  -- Détail NON identifiant : compteurs, ancienne et nouvelle valeur d'un drapeau, motif. Jamais de numéro.
  detail       jsonb not null default '{}'::jsonb
);

-- Lecture type : « l'historique de cet espace, du plus récent au plus ancien », et « tout ce qui concerne ce
-- contact ». Deux index, pas plus : cette table s'écrit beaucoup et se lit peu.
create index if not exists idx_audit_log_tenant_at on audit_log (tenant_id, at desc);
create index if not exists idx_audit_log_cible on audit_log (tenant_id, target_kind, target_id, at desc);

-- Marqueur d'anonymisation sur le contact. Distinct de `deleted_at` (migration 0049) et ce n'est pas un doublon :
-- `deleted_at` masque le contact du CRM et reste RÉVERSIBLE ; `anonymized_at` dit que les données identifiantes
-- ont été DÉTRUITES, ce qui ne se défait pas. Les deux coexistent sur une ligne purgée.
alter table contacts add column if not exists anonymized_at timestamptz;
