-- 0036_hubspot_lists_toggle.sql — Palier 4 : toggle self-serve « Campagnes via données HubSpot » (par tenant).
-- OFF par défaut : tant qu'il n'est pas activé, aucun appel au connecteur mm-hubspot, aucun scope HubSpot demandé.
-- ADD-only. Migrer AVANT de déployer le code neuf (le store lit cette colonne).
alter table tenant_settings add column if not exists hubspot_lists_enabled boolean not null default false;
