-- 0077_rcs_messages.sql : bibliothèque de messages RCS réutilisables.
--
-- Le pendant RCS des modèles d'email (0062) et des templates WhatsApp, à une différence près qui change tout :
-- un message RCS n'a AUCUNE validation à obtenir. Il n'est pas soumis à Meta ni à l'opérateur, il part tel
-- qu'il est écrit sous l'agent de la marque. La bibliothèque sert donc à RÉUTILISER, pas à faire approuver.
--
-- `content` porte le message dans notre modèle interne (texte + suggestions, carte, ou carrousel), validé par
-- zod À L'ÉCRITURE (src/rcs/schema.ts). On stocke la forme déjà validée, jamais un payload brut.

create table if not exists rcs_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  content     jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists rcs_messages_tenant_name
  on rcs_messages (tenant_id, name) where deleted_at is null;
create index if not exists rcs_messages_tenant
  on rcs_messages (tenant_id) where deleted_at is null;
