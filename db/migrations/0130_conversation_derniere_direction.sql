-- 0130 : le SENS du dernier message d une conversation, pour que « A traiter » veuille dire
-- « la balle est dans notre camp ».
--
-- POURQUOI. « A traiter » valait `control_owner <> 'app_workflow'`, c est-a-dire « le scenario ne gere plus
-- ce fil ». Consequence constatee par Julien le 2026-09-10 : un operateur prend la main, REPOND au client, et
-- la conversation reste dans « A traiter » alors qu on attend desormais le CLIENT. Le dossier se remplit de
-- fils ou il n y a rien a faire, et il cesse d etre une liste de travail.
--
-- La possession du fil ne suffit donc pas a decider : il faut savoir QUI A PARLE EN DERNIER. C est ce que
-- cette colonne porte, et rien d autre.
--
-- ⚠️ NULL VEUT DIRE « ON NE SAIT PAS », ET C EST LE BON DEFAUT. La regle s ecrit
-- `last_direction is distinct from 'out'` : une conversation sans valeur reste donc dans « A traiter »,
-- exactement comme avant cette migration. Aucun fil ne disparait du dossier au deploiement, ce qui serait
-- la pire facon d introduire un filtre (personne ne cherche ce qu il ne sait pas avoir perdu).
--
-- ⚠️ ELLE AJOUTE UNE COLONNE QUE LE CODE ECRIT : elle passe AVANT le deploiement. Et le code la LIT avec un
-- `is distinct from`, donc l ancien code (qui l ignore) et le nouveau cohabitent sans se genir.
--
-- MESURE AVANT BACKFILL (2026-09-10) : 14 conversations, 283 messages. Le backfill est donc instantane, et
-- il vaut mieux qu un defaut a null : sans lui, un fil deja repondu par un humain resterait faussement « a
-- traiter » jusqu au message suivant, c est-a-dire precisement le symptome qu on corrige.
alter table conversations add column if not exists last_direction text;

-- La forme, verrouillee en base : `conversation_messages.direction` ne connait que ces deux valeurs, et une
-- troisieme ecrite ici rendrait la regle du dossier silencieusement fausse (ni 'in' ni 'out' = « a traiter »).
alter table conversations drop constraint if exists conversations_last_direction_chk;
alter table conversations add constraint conversations_last_direction_chk
  check (last_direction is null or last_direction in ('in', 'out'));

-- Le dernier message de chaque conversation, par sa date puis par son identifiant (deux messages a la meme
-- milliseconde existent : une reponse automatique suit son declencheur de tres pres).
update conversations c
   set last_direction = m.direction
  from (
    select distinct on (conversation_id) conversation_id, direction
      from conversation_messages
     order by conversation_id, created_at desc, id desc
  ) m
 where m.conversation_id = c.id
   and c.last_direction is null;
