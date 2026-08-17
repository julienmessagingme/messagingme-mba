-- 0056_channel.sql : le CANAL devient une dimension de premier ordre (WhatsApp / RCS).
--
-- `default 'whatsapp'` : tout l'existant reste WhatsApp sans réécriture, la migration est rétrocompatible.
-- L'unique de `conversations` passe à (tenant_id, channel, wa_id) : un même numéro a DEUX fils distincts,
-- un par canal. C'est voulu, ce sont deux conversations différentes pour le contact comme pour l'opérateur.
-- `workflow_runs` ne bouge PAS : un run est attaché à un CONTACT, pas à un canal. C'est ce qui permet à un
-- bloc RCS de retomber sur un bloc template WhatsApp dans le MÊME scénario (sortie « non joignable »).

alter table conversations add column if not exists channel text not null default 'whatsapp';
alter table conversation_messages add column if not exists channel text not null default 'whatsapp';
alter table campaigns add column if not exists channel text not null default 'whatsapp';

-- L'unique historique (tenant_id, wa_id) est posé par 0009 comme CONTRAINTE de table. On la retire pour la
-- remplacer par un index unique à trois colonnes. `if exists` : le nom généré par Postgres est stable
-- (<table>_<colonnes>_key), mais on ne casse pas la migration si une base l'a déjà perdu.
alter table conversations drop constraint if exists conversations_tenant_id_wa_id_key;
create unique index if not exists conversations_tenant_channel_wa_idx
  on conversations (tenant_id, channel, wa_id);

-- Une campagne RCS n'a PAS de numéro Meta : `phone_number_id` était `not null` depuis 0003.
alter table campaigns alter column phone_number_id drop not null;
