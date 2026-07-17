-- 0035_api_public_v1.sql — Palier 3 : API publique v1.
-- ADD-only (nouvelles tables + colonne nullable) : migrer AVANT le déploiement du code neuf.

-- Clés d'API par tenant. On ne stocke JAMAIS la clé en clair, seulement son hash sha256 (comme auth_tokens).
create table if not exists api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  key_hash      text not null,
  name          text not null,
  scopes        text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create unique index if not exists api_keys_key_hash_key on api_keys (key_hash);
create index if not exists api_keys_tenant_idx on api_keys (tenant_id);

-- Idempotence des envois API (Idempotency-Key obligatoire sur POST /v1/sends). Claim atomique par la PK :
-- send_id null = calcul en cours (retry -> 409) ; renseigné = rejeu du rapport caché. Purgé après 24h.
create table if not exists api_idempotency (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  idempotency_key  text not null,
  send_id          uuid,
  response         jsonb,
  created_at       timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);
create index if not exists api_idempotency_created_idx on api_idempotency (created_at);

-- Campagne « node » (D-1) : démarre le workflow À un bloc précis au lieu de l'entrée. NULL = comportement
-- inchangé (démarrage à l'entrée). Pas de FK (le node vit dans workflows.graph jsonb, pas une ligne dédiée).
alter table campaigns add column if not exists start_node_id text;
