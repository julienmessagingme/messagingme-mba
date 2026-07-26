-- Panneau statut WABA (item F2 du cluster Dashboard). Deux champs Meta supplémentaires, lus dans le MÊME
-- appel GET /{waba_id} que la santé WABA (aucun appel réseau en plus). Nullable, pas de backfill : l'absence
-- vaut "non communiqué par Meta", jamais un faux "Non" silencieux. Additif, compatible migrate.ts (begin/commit).
-- marketing_messages_lite_api_status : statut d'onboarding de l'API MM Lite (mesuré "ONBOARDED" en live).
-- owner_business_name : business propriétaire du WABA (contexte du bloc paiement honnête, le moyen de paiement
--   lui-même n'étant pas lisible avec notre token, erreur #10 réservée aux Business Solution Providers).
alter table phone_numbers add column if not exists marketing_messages_lite_api_status text;
alter table phone_numbers add column if not exists owner_business_name text;
