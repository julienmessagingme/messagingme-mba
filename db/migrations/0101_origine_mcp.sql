-- 0101_origine_mcp.sql : une SIXIÈME origine, l'agent tiers branché par MCP.
--
-- Trouvé par la revue du lot MCP, et c'est exactement le piège que la migration 0099 disait avoir fermé.
-- `recordOutbound` (envoi par conversation) DÉDUISAIT l'origine de l'expéditeur : « un expéditeur humain
-- veut dire humain, sinon scénario ». C'était vrai tant que ce chemin n'avait que des appelants de la
-- console, protégés par JWT. Le serveur MCP en a ajouté un quatrième, sans expéditeur humain : chaque
-- réponse d'un agent tiers partait donc en base marquée `scenario`.
--
-- 🔴 Le pire n'est pas l'erreur, c'est qu'elle était INVISIBLE. La valeur étant écrite explicitement, le
-- repli « indéterminée » de `ORIGINE_EFFECTIVE_SQL` ne pouvait pas se déclencher : le tableau « qui a écrit
-- les messages de service » aurait compté tout le trafic MCP comme du scripté, sans que rien ne cloche.
-- La leçon vaut au-delà de ce cas : une valeur DÉDUITE d'un autre champ est une garde qui ne tient que tant
-- que la liste des appelants ne bouge pas, et une liste d'appelants bouge toujours.
--
-- Le correctif de fond est en TypeScript (le paramètre devient obligatoire, comme sur
-- `recordOutboundByWaId`). Cette migration ne fait qu'ouvrir la contrainte à la valeur nouvelle.
--
-- 🔴 BLOQUANTE : dès le déploiement, une réponse MCP écrit `origin = 'mcp'`, que la contrainte doit accepter.

alter table conversation_messages drop constraint if exists conversation_messages_origin_check;
alter table conversation_messages add constraint conversation_messages_origin_check
  check (origin in ('humain', 'scenario', 'ia', 'mba', 'campagne', 'mcp'));
