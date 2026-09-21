-- 0162_outils_maison_mba.sql : les outils maison de l'agent de Meta, et l'accusé de nos envois.
-- Spec : docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md (§ 5.1 et § 6).
--
-- AVANT le déploiement : le code neuf écrit `pour_agent_meta` et `accuse_le`. L'ancien code y survit : un CHECK
-- relâché, une colonne à défaut `false` qu'il n'écrit pas, une colonne nullable qu'il ne lit pas.

-- Un outil qui appartient à l'agent de Meta de l'espace, et à lui seul (il n'a pas de fiche d'agent).
alter table agent_tools add column if not exists pour_agent_meta boolean not null default false;

-- 0159 exigeait un agent propriétaire pour toute action maison. L'agent de Meta n'a pas de ligne `agents` :
-- son drapeau tient lieu de propriétaire.
alter table agent_tools drop constraint if exists agent_tools_action_par_agent_chk;
alter table agent_tools add constraint agent_tools_action_par_agent_chk
  check (origin <> 'mba' or agent_id is not null or pour_agent_meta);

-- Le drapeau n'est pas une échappatoire : il ne vaut que pour un outil maison sans agent.
alter table agent_tools drop constraint if exists agent_tools_pour_agent_meta_chk;
alter table agent_tools add constraint agent_tools_pour_agent_meta_chk
  check (not pour_agent_meta or (origin = 'mba' and agent_id is null));

-- Le premier accusé reçu de Meta pour un message sortant. Il dit que Meta a fini de traiter l'envoi, donc
-- qu'un release n'a plus rien à attendre (0149). Aucun index : la lecture passe par `meta_message_id`.
alter table conversation_messages add column if not exists accuse_le timestamptz;
