-- 0028_phone_meta_hubspot.sql — statut Meta enrichi (page Accueil) + drapeau de synchro HubSpot PAR numéro.
-- Additive, idempotente (add column if not exists). Nullable = INCONNU (jamais un faux « vérifié »/« sain »).

-- Champs Meta additionnels (alimentés par le pull Graph au chargement de /accueil, coalesce à l'écriture).
-- verified_name existe déjà (0001) : le add if not exists est un no-op sûr.
alter table phone_numbers
  add column if not exists name_status text,                    -- APPROVED / PENDING / DECLINED / ... (name_status Graph)
  add column if not exists code_verification_status text,       -- VERIFIED / NOT_VERIFIED / EXPIRED
  add column if not exists throughput_level text,               -- STANDARD / HIGH / ... (throughput.level)
  add column if not exists verified_name text,                  -- nom d'affichage vérifié
  add column if not exists waba_health_status text,             -- AVAILABLE / LIMITED / BLOCKED (health_status.can_send_message)
  add column if not exists account_review_status text,          -- APPROVED / PENDING / REJECTED
  add column if not exists business_verification_status text;   -- verified / not_verified / pending

-- Drapeau de synchro HubSpot PAR numéro : le push d'analyse vers le connecteur mm-hubspot ne part que si true.
-- Défaut false pour les futurs numéros (opt-in explicite).
alter table phone_numbers
  add column if not exists hubspot_connected boolean not null default false;

-- BACKFILL CRITIQUE : les numéros EXISTANTS synchronisent aujourd'hui via le push global (Pièce 2 live).
-- On les passe à true pour NE PAS couper la synchro en production au déploiement de cette migration.
update phone_numbers set hubspot_connected = true;
