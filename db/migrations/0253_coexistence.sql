-- 0253 : la coexistence (plan docs/superpowers/plans/2026-10-24-coexistence.md, tache 1 ; conception
-- docs/superpowers/specs/2026-10-24-coexistence-design.md). Le meme numero vit dans l application WhatsApp Business ET
-- sur l API Cloud.
--
-- phone_numbers.coexistence : le numero est relie en coexistence. Pose au rattachement (linkTenant), quand la fenetre
--   de Meta annonce la fin du parcours de coexistence ou que Meta dit le numero dans l application (is_on_biz_app). Lu
--   par l ecran, par Claude et par les courriels. Jamais de /register sur un tel numero : l application l a deja
--   enregistre. Faux pour chaque numero d avant : aucun n est en coexistence.
-- phone_numbers.coexistence_coupee_le : Meta a coupe la coexistence (webhook account_update) ; nulle tant qu elle
--   tient. Servie au lot 2 (les coupures), posee ici pour une seule migration.
--
-- A appliquer SEULE et AVANT le code : le rattachement ecrit coexistence, et la lecture du numero de l espace
-- (getPhoneNumber) la nomme ; l ancien code ignore les deux colonnes et survit. Le defaut est une constante : l ajout
-- est instantane, sans reecriture de la table. phone_numbers est lue par le chemin chaud (rattachement des webhooks,
-- garde des envois) : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

alter table phone_numbers add column if not exists coexistence boolean not null default false;

alter table phone_numbers add column if not exists coexistence_coupee_le timestamptz;
