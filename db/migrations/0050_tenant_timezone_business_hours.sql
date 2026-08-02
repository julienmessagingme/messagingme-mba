-- Fuseau horaire + heures d'ouverture par tenant (pour NOW, les conditions « jour de semaine » / « heures
-- d'ouverture » du node condition, et l'horodatage). Colonnes additives nullables, compatibles migrate.ts.
-- timezone : identifiant IANA (ex. 'Europe/Paris'), null = défaut serveur. business_hours : jsonb indexé par
-- jour '0'..'6' (0 = dimanche) -> { closed, open 'HH:MM', close 'HH:MM' }, null = défaut serveur (Lun-Ven 9-18).
alter table tenant_settings add column if not exists timezone text;
alter table tenant_settings add column if not exists business_hours jsonb;
