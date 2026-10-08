-- 0224 : « mon application repond », le cinquieme mode du repondeur (lot 12, livraison B, spec
-- docs/superpowers/specs/2026-10-08-webhooks-sortants-design.md).
--
-- Le mode application remet chaque message entrant a l'application du client (evenement conversation.needs_reply vers
-- une adresse designee de webhooks sortants), qui repond par l'API. Aucun repli (decision de Julien du 2026-10-08).
--
--  - tenant_settings_repondeur_mode_chk : reposee sous son nom, a cinq valeurs.
--  - repondeur_adresse_id : l'adresse designee, en on delete set null (une cascade supprimerait le reglage de l'espace
--    avec l'adresse). Le mode se lit alors equipe (modeEffectif), comme un agent ou un scenario supprime.
--  - tenant_settings_repondeur_adresse_chk : a sens unique, comme ceux de l'agent et du scenario (0217) ; l'inverse,
--    application sans adresse, est un etat atteignable (adresse supprimee apres coup).
--
-- 🔴 ORDRE : un ancien worker lit un mode inconnu comme agent, ou mba si l'agent de Meta est allume. Rien n'ecrit
-- application avant le code neuf : la migration passe avant le up de l'API et des DEUX workers, dans le meme up, et
-- la console (seule a proposer le mode) apres.
--
-- RETOUR ARRIERE vers une image anterieure : l'ancien setRepondeur ne remet pas repondeur_adresse_id a nul (tout
-- changement de mode violerait le CHECK) et l'ancien worker lirait application comme mba si l'agent de Meta est allume.
-- D'abord : update tenant_settings set repondeur_mode = 'equipe', repondeur_adresse_id = null
--           where repondeur_mode = 'application';
set local lock_timeout = '5s';

alter table tenant_settings drop constraint if exists tenant_settings_repondeur_mode_chk;
alter table tenant_settings add constraint tenant_settings_repondeur_mode_chk
  check (repondeur_mode in ('mba', 'agent', 'scenario', 'equipe', 'application'));

alter table tenant_settings add column if not exists repondeur_adresse_id uuid
  constraint tenant_settings_repondeur_adresse_fk references adresses_evenements (id) on delete set null;

alter table tenant_settings drop constraint if exists tenant_settings_repondeur_adresse_chk;
alter table tenant_settings add constraint tenant_settings_repondeur_adresse_chk
  check (repondeur_adresse_id is null or repondeur_mode = 'application');
