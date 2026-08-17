-- 0056_channel.sql : le CANAL devient une dimension de premier ordre (WhatsApp / RCS).
--
-- Le canal est porté par le MESSAGE, pas par le fil. UN contact = UNE conversation, quels que soient les
-- tuyaux empruntés, et chaque bulle dit par où elle est passée.
--
-- Pourquoi pas un fil par canal (première intention, abandonnée) : la reprise de main par un opérateur
-- (`control_owner`), le comportement de retour et le marquage de test sont attachés à une PERSONNE, pas à un
-- tuyau. Un opérateur qui prend la main sur un client la prend sur le client. Scinder les fils rendait
-- ambiguës quatre requêtes de `inbox/store.pg.ts` qui lisent ou écrivent par (tenant_id, wa_id) : le SELECT
-- aurait pris une ligne au hasard, l'UPDATE aurait touché les deux. C'est aussi cohérent avec
-- `workflow_runs`, attaché au CONTACT et sans canal, ce qui permet à un bloc RCS de retomber sur un bloc
-- template WhatsApp dans le MÊME scénario (sortie « non joignable »).
--
-- `default 'whatsapp'` : tout l'existant reste WhatsApp sans réécriture, la migration est rétrocompatible.
-- `conversations` n'est pas touchée, donc son unique (tenant_id, wa_id) de 0009 reste en place.

alter table conversation_messages add column if not exists channel text not null default 'whatsapp';
alter table campaigns add column if not exists channel text not null default 'whatsapp';

-- Une campagne RCS n'a PAS de numéro Meta : `phone_number_id` était `not null` depuis 0003.
alter table campaigns alter column phone_number_id drop not null;
