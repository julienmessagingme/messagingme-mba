-- 0161 : le relais du Meta Business Agent (spec docs/superpowers/specs/2026-09-21-relais-mba-design.md,
-- plan docs/superpowers/plans/2026-09-21-relais-mba.md).
--
-- Meta appelait le système du client EN DIRECT et ne lit pas notre mini-CRM : un outil qui envoie un champ du
-- contact était impossible. Meta appelle désormais Engage Me, qui fait l'appel déclaré dans Tools >
-- Connecteurs API. Deux changements de schéma, appliqués AVANT le déploiement.
--
-- 1) Le journal des appels de connecteur accepte un QUATRIÈME appelant, `mba` : l'agent de Meta. On RELÂCHE
-- un CHECK, donc l'ancien code y survit. Le nom de la contrainte est celui que 0142 a posé explicitement
-- (relu en base avant d'écrire cette ligne), sans quoi `drop constraint if exists` laisserait l'ancienne en
-- place et refuserait `mba` en silence.
alter table agent_tool_calls drop constraint if exists agent_tool_calls_source_check;
alter table agent_tool_calls add constraint agent_tool_calls_source_check
  check (source in ('agent', 'scenario', 'optout', 'mba'));

-- 2) La clé d'API actuellement posée chez Meta pour le connecteur `EngageMe` de l'espace.
--
-- 🔴 UN SECRET NE SE COMPARE PAS, IL SE SOUVIENT (même principe que 0129). Meta ne rend jamais la clé, et
-- nous n'en gardons que l'empreinte : sans cette colonne, on ne saurait pas qu'une clé révoquée par le client
-- doit être remplacée chez Meta. `on delete set null` : une clé supprimée redevient « aucune clé posée », et
-- la publication suivante en pose une neuve. Nullable, sans défaut : aucun espace n'a encore de relais.
alter table tenant_settings add column if not exists mba_relais_cle_id uuid
  references api_keys(id) on delete set null;
