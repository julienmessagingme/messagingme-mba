-- 0120_conversations_archivees.sql : ranger une conversation finie, sans rien effacer.
--
-- 🔴 CE QUE L'ARCHIVAGE FAIT, ET CE QU'IL NE FAIT PAS. Il sort la conversation des dossiers Tout, A traiter
-- et Signale, et la range dans Archive. Rien n'est efface, aucun chiffre d'analytics ne bouge, les messages
-- restent lisibles et le contact reste joignable. C'est un rangement, pas une suppression.
--
-- 🔴 UN MESSAGE DU CONTACT LA DESARCHIVE (decision de Julien, 2026-09-08). Une conversation archivee puis
-- relancee par le client est exactement le cas ou l'oublier coute cher : l'archivage range ce qui est fini,
-- il ne reduit personne au silence. ⚠️ Le desarchivage est gouverne par le CHEMIN appelant et non par
-- l'ecriture partagee : `recordInbound` et `recordOutboundByWaId` passent par le MEME upsert, et decider
-- dans la dependance commune ferait remonter dans l'inbox de tout le monde chaque contact archive qu'une
-- campagne touche.
--
-- Un HORODATAGE et pas un booleen : « depuis quand » se posera (trier le dossier, purger un jour), et une
-- colonne booleenne ne pourra plus repondre. Il n'y a pas d'auteur (`archived_by`) : ce serait une colonne
-- de plus pour une question que personne ne s'est encore posee, et elle s'ajoutera le jour ou elle se pose.
--
-- IDEMPOTENTE : `if not exists` sur la colonne comme sur l'index.

alter table conversations
  add column if not exists archived_at timestamptz;

-- Le dossier Archive lit « les archivees de cet espace, les plus recentes d'abord ». Les QUATRE autres
-- dossiers lisent l'inverse (`archived_at is null`), qui est le cas de l'immense majorite des lignes : un
-- index PARTIEL sur les seules archivees sert le premier sans alourdir les seconds ni gonfler l'index.
create index if not exists conversations_archivees_idx
  on conversations (tenant_id, archived_at desc)
  where archived_at is not null;
