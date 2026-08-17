-- 0058_conversations_fil_unique.sql : RÉPARE l'état laissé par la première version de 0056.
--
-- Ce qui s'est passé. 0056 a d'abord scindé les conversations par canal : ajout de `conversations.channel`,
-- suppression de l'unique (tenant_id, wa_id) et création d'un index unique (tenant_id, channel, wa_id).
-- Cette version a été APPLIQUÉE en production. La décision a ensuite changé (un seul fil par contact, le
-- canal est porté par le MESSAGE), et le fichier 0056 a été corrigé sur place, ce qui ne répare RIEN sur une
-- base où il est déjà enregistré comme appliqué : le runner suit les noms de fichier, il ne les relit pas.
--
-- Conséquence, et c'est la raison de cette migration : `inbox/store.pg.ts` fait
-- `on conflict (tenant_id, wa_id)`. Sans unique à DEUX colonnes, Postgres lève 42P10 à chaque écriture, donc
-- à chaque message entrant WhatsApp et à chaque envoi journalisé. Panne totale et silencieuse du fil.
--
-- Leçon, pour la prochaine fois : une migration déjà appliquée quelque part est IMMUABLE. On la corrige avec
-- une nouvelle migration, jamais sur place, même quand « aucune base ne l'a appliquée » semble vrai.
--
-- Sûreté vérifiée avant écriture : 0 doublon (tenant_id, wa_id) en base, et aucun code ne lit
-- `conversations.channel`.

-- 1. L'unique à DEUX colonnes redevient l'arbitre du ON CONFLICT.
create unique index if not exists conversations_tenant_wa_idx
  on conversations (tenant_id, wa_id);

-- 2. L'index à trois colonnes n'a plus d'objet : un contact n'a qu'un fil.
drop index if exists conversations_tenant_channel_wa_idx;

-- 3. La colonne de canal sur le FIL n'a plus d'objet non plus : c'est `conversation_messages.channel` qui
--    porte le tuyau emprunté, bulle par bulle.
alter table conversations drop column if exists channel;
