-- 0166_origine_api.sql : une SEPTIEME origine, l'API publique du client.
--
-- POURQUOI. `POST /v1/messages` (lot 7 de la liste de Julien du 2026-09-23) laisse le systeme du client
-- envoyer un simple texte dans la fenetre de 24 h. Ce message part par le MEME point de passage que la
-- reponse d'un operateur et que celle d'un agent MCP (`repondreDansLaFenetre`), et il doit donc dire d'ou il
-- vient : ni un humain (personne n'a tape la phrase dans la console), ni un scenario de chez nous, ni une
-- IA. C'est le systeme du client qui parle, par sa cle d'API.
--
-- 🔴 MEME MOTIF QUE 0101, ET C'EST LA TROISIEME FOIS : chaque nouvel APPELANT du chemin d'envoi ajoute une
-- origine. 0099 en declarait cinq, 0101 en a ajoute une sixieme quand le serveur MCP est arrive, celle-ci
-- une septieme. Ce n'est pas une derive, c'est le contrat : la colonne existe precisement parce que rien
-- d'autre dans la ligne ne distingue ces appelants (meme `type = 'text'`, meme `sender_user_id = null`).
-- Une valeur DEDUITE serait redevenue fausse a chaque fois.
--
-- ⚠️ ELLE RELACHE, DONC L'ANCIEN CODE Y SURVIT, et elle passe AVANT le deploiement. La question n'est pas
-- « ajoute ou retire » mais « l'ancien code survit-il a ce changement ? » (regle corrigee au lot 0128) :
-- elargir un CHECK laisse vivre le code deploye, qui continue d'ecrire les six valeurs d'hier. L'inverse
-- serait bloquant : deployer d'abord ferait echouer le PREMIER appel de la route neuve en 23514, sur un
-- envoi reel, c'est-a-dire au pire moment.
--
-- 🔴 LE NOM DE LA CONTRAINTE A ETE LU EN BASE AVANT D'ECRIRE CE FICHIER, pas devine (lecon de 0122) :
-- `pg_constraint` sur `conversation_messages` ne rend qu'UN seul CHECK parlant d'origine, nomme
-- `conversation_messages_origin_check`, avec ses six valeurs. Un nom a cote aurait laisse l'ancienne
-- contrainte en place ET ajoute la neuve, donc refuse 'api' en silence : un `if exists` ne protege que de
-- l'absence, jamais de l'erreur de nom.
--
-- ⚠️ MESURE AVANT D'APPLIQUER (2026-09-23, production) : 140 messages portent une origine ou null, repartis
-- en null (76), scenario (37), mba (12), humain (11), campagne (4). Aucune valeur hors du CHECK actuel,
-- donc rien ne peut faire echouer l'ajout de la contrainte elargie.

alter table conversation_messages drop constraint if exists conversation_messages_origin_check;
alter table conversation_messages add constraint conversation_messages_origin_check
  check (origin in ('humain', 'scenario', 'ia', 'mba', 'campagne', 'mcp', 'api'));
