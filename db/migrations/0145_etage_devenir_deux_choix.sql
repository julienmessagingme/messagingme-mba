-- LE DEVENIR D'UN ÉTAGE N'A QUE DEUX VALEURS : l'agent de Meta, ou l'Inbox.
--
-- 🔴 ELLE CORRIGE 0144, APPLIQUÉE QUELQUES MINUTES PLUS TÔT, ET LA RAISON VAUT D'ÊTRE ÉCRITE. 0144 câblait
-- les TROIS réponses de l'écran, dont « un agent IA prend la main ». En allant la brancher, un fait
-- d'architecture a été mesuré : `agent_sessions.run_id` est `NOT NULL` et référence `workflow_runs`, donc
-- **un agent IA de ce produit ne sait pas exister hors d'un scénario**. Il n'y a ni run, ni session, ni bloc
-- où accrocher un agent sur une campagne « modèle seul ».
--
-- 🔴 ET LA SORTIE N'EST PAS DE RENDRE `run_id` NULLABLE, c'est de retirer le choix (tranché par Julien le
-- 2026-09-14) : « il ne faut faire que 2 choix, soit ça tombe dans l'Inbox soit c'est le MBA ; si le user
-- veut que ça aille vers son autre agent IA, il faut qu'il fasse un scénario et qu'il utilise l'option
-- modèle + scénario ». Le chemin existe déjà et il est éprouvé ; en ouvrir un second, plus fragile, pour la
-- même intention aurait été le vrai coût.
--
-- ⚠️ ELLE RETIRE UNE COLONNE QUE RIEN N'A JAMAIS ÉCRITE. 0144 n'a été appliquée que sur la base, jamais
-- déployée avec du code qui s'en sert : il n'existe donc aucune ligne à reprendre et aucun lecteur à
-- prévenir. C'est la seule situation où un `drop column` peut passer AVANT un déploiement.
alter table campaign_etages
  drop constraint if exists campaign_etages_agent_sans_devenir_chk;
alter table campaign_etages
  drop column if exists agent_id;

-- Deux valeurs, et rien d'autre. `null` reste « campagne d'avant le câblage », qui garde son comportement.
alter table campaign_etages
  drop constraint if exists campaign_etages_devenir_chk;
alter table campaign_etages
  add constraint campaign_etages_devenir_chk
  check (devenir is null or devenir in ('mba', 'inbox'));
