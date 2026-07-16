-- 0029 : Embedded Signup (Tech Provider).
-- Token business (BISU, scopé au client onboardé) obtenu par l'échange du code ES. `pin` = PIN 2FA posé au
-- register d'un numéro NEUF (un numéro déjà CONNECTED se re-sélectionne sans register), conservé pour les
-- re-régistrations futures. Token ET pin sont chiffrés au repos (AES-256-GCM, clé ENCRYPTION_KEY env) ->
-- `pin_enc` (jamais le PIN en clair).
create table if not exists waba_credentials (
  waba_id            text primary key references waba(id) on delete cascade,
  tenant_id          uuid not null references tenants(id) on delete cascade,
  business_token_enc text not null,
  pin_enc            text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
