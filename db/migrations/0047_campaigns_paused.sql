-- Pause reversible des campagnes via listes HubSpot (cluster HubSpot F3-b). Flag PAR TENANT, additif, default false.
-- Deuxieme etat orthogonal, pilote ENSEMBLE avec hubspot_paused_at (F3-a) par l'unique action Pause du toggle
-- Synchronisation : setHubspotConnected ecrit les DEUX dans la MEME transaction (pause -> campaigns_paused=true,
-- reprise/activation -> false), donc pas de drift possible entre les deux flags. Le gate effectif des routes listes
-- devient (hubspot_lists_enabled AND NOT campaigns_paused). N'ECRASE PAS hubspot_lists_enabled (le reglage d'origine
-- de l'utilisateur) : la reprise le restaure tel quel.
alter table tenant_settings add column if not exists campaigns_paused boolean not null default false;
