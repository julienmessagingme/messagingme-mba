-- Pause reversible de la synchro HubSpot (cluster HubSpot F3-a). Deux colonnes additives, nullable/default,
-- compatible migrate.ts (begin/commit), pas de backfill (les numeros deja hubspot_connected=true restent
-- paused_at=null = actifs, correct ; un numero deja false sera lu "jamais active" a sa prochaine activation,
-- choix delibere : on ne pousse jamais un backlog surprise).
--
-- hubspot_paused_at : distingue OFF-jamais (null) de PAUSE (renseigne). Le push lit UN seul snapshot via
--   getHubspotGateStatus (connected + pausedAt) : connected pilote le gate, pausedAt decide (sur ce meme
--   snapshot) s'il faut marquer un rattrapage. Sert aussi au libelle UI.
alter table phone_numbers add column if not exists hubspot_paused_at timestamptz;

-- pending_catchup : marqueur DURABLE du rattrapage. Pose par le job push-analysis quand il saute une analyse
--   POUR CAUSE DE PAUSE ; le job de rattrapage rejoue les marques ; le push efface la marque au succes. C'est
--   ce marqueur (pas paused_at) qui garantit qu'aucune analyse faite pendant la pause n'est perdue, y compris
--   celle d'un push deja enfile au moment ou l'admin clique Pause (race a l'entree en pause).
alter table conversation_analysis add column if not exists pending_catchup boolean not null default false;
