-- 0026 : refonte auth. (1) Tokens à usage unique (invitations, reset mot de passe) — on ne stocke QUE le
-- hash (sha256) du token, jamais le token en clair ; consommation atomique via `used_at is null`. (2) Statut
-- d'espace (crochet pour un futur barrage de paiement) — défaut 'active' donc aucun tenant existant n'est bloqué.
create table if not exists auth_tokens (
  id          uuid primary key default gen_random_uuid(),
  purpose     text not null check (purpose in ('invite', 'reset')),
  token_hash  text not null unique,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table tenants add column if not exists status text not null default 'active'
  check (status in ('trial', 'active', 'locked'));
