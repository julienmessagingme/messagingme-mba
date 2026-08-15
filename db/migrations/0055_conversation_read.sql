-- 0055_conversation_read.sql : « non lu » dans l'inbox.
--
-- La notion n'existait nulle part : aucune colonne, aucune table, rien à dériver. On la pose au seul endroit
-- qui a un sens côté opérateur : le moment où quelqu'un OUVRE le fil dans l'inbox.
--
-- Définition retenue : une conversation est NON LUE s'il existe un message ENTRANT plus récent que
-- `last_read_at`. `null` = jamais ouverte, donc non lue dès qu'un message entrant existe. On ne compte que
-- l'ENTRANT : nos propres envois (campagne, scénario) ne rendent pas un fil « non lu », sinon le compteur
-- s'allumerait tout seul à chaque campagne.

alter table conversations add column if not exists last_read_at timestamptz;
