-- 0152 : ce qu un outil IMPORTE d un serveur MCP garde de son annonce, et la garde de `kind`.
--
-- AUCUNE TABLE NOUVELLE. Un serveur MCP est une ligne d `agent_tool_sources` avec kind = 'mcp', que 0088
-- prevoyait deja ("'mcp' est declare des maintenant pour que L4 n ait pas de migration a faire, mais aucun
-- code ne le sert"), et ses outils sont des lignes d `agent_tools` avec origin = 'mcp', que 0086 prevoyait
-- aussi. La contrainte `agent_tools_origin_src_chk` impose deja qu un outil non maison porte une source.
--
-- ELLE AJOUTE DES COLONNES QUE LE CODE ECRIT, donc elle passe AVANT le deploiement.
--
-- 🔴 ET ELLE EST DELIBEREMENT PERMISSIVE : elle NE POSE PAS le CHECK qui exigerait `source_kind`. Le code
-- DEPLOYE au moment ou elle s applique ne connait pas cette colonne, donc il l ecrit a null : un CHECK
-- strict ferait echouer toute creation d outil de connecteur pendant la fenetre censee etre la plus sure,
-- celle ou l on peut encore revenir en arriere. C est mot pour mot ce qui est arrive avec 0128, dont la
-- lecon est ecrite dans CLAUDE.md : "avant ou apres le deploiement" ne se decide pas sur ajoute/retire,
-- mais sur "l ancien code survit-il a ce changement ?". Le CHECK strict fera l objet d une migration
-- SUIVANTE, appliquee APRES que le code qui renseigne `source_kind` soit en production.
--
-- MESURE FAITE EN BASE AVANT DE L ECRIRE (lecture seule, 2026-09-16) : 4 outils, tous origin='mba' et sans
-- source ; 1 source, kind='http', en brouillon ; ZERO croisement origin/kind deja faux. La reprise n a donc
-- rien a reprendre aujourd hui, et la cle etrangere composite s applique sans forcer.

-- ---------------------------------------------------------------- ce que l annonce distante laisse

-- L annonce BRUTE du serveur pour cet outil (name, title, description, inputSchema, outputSchema,
-- annotations), telle qu elle est arrivee.
--
-- POURQUOI LA GARDER, alors qu on en derive deja `params`. C est la seule facon de DIRE CE QUI A CHANGE au
-- rafraichissement. Le consentement tombe quand le schema bouge (0127 : il porte sur un outil precis) ;
-- sans l annonce d avant, on saurait qu il a bouge sans pouvoir dire en quoi, et le client devrait
-- reautoriser a l aveugle.
alter table agent_tools add column if not exists mcp_annonce jsonb;

-- null = activable. Sinon, la RAISON en clair, affichee telle quelle au client.
-- Trois formes n ont pas de jeu de feuilles fixe (tableau, alternatives, objet dont la forme n est pas
-- declaree) : on les IMPORTE et on les MONTRE, on ne les active pas. Une raison STOCKEE plutot que
-- recalculee a l affichage, parce que c est l import qui l a etablie et qu elle doit survivre a un
-- remaniement de notre aplatisseur.
alter table agent_tools add column if not exists mcp_non_activable text;

-- L outil a disparu du catalogue distant. On ne le supprime PAS : la ligne est la trace de ce qui a tourne,
-- et le journal des appels y renvoie.
alter table agent_tools add column if not exists mcp_indisponible_le timestamptz;

-- Dernier rafraichissement ou le serveur l annoncait encore.
alter table agent_tools add column if not exists mcp_vu_le timestamptz;

-- AUCUN INDEX SUR CES QUATRE-LA, delibere : les lectures passent par `source_id`, qui porte deja
-- `agent_tools_source_idx`. Un index partiel est un contrat avec une requete precise, et aucune requete de
-- ce lot n en demande un.

-- ---------------------------------------------------------------- la garde de `kind`

-- 🔴 CE QU ELLE FERME (le "trou n°3" de AGENT-IA-PLAN-L4.md, relevé par la revue du 2026-09-16).
-- Rien n empechait un outil origin='mcp' de pointer vers une source kind='http', ni l inverse :
-- `agent_tools_origin_src_chk` (0088) verifie qu une source EXISTE, pas LAQUELLE. Le resolveur d execution
-- serait alors parti dans la mauvaise branche, sur un chemin qu aucun test unitaire ne voit puisqu il monte
-- son propre faux cablage.
--
-- ⚠️ PAS DE DECLENCHEUR, UNE CLE ETRANGERE COMPOSITE. Le declencheur est le reflexe, et c est le mauvais :
-- il s ecrit, se teste mal, et ne se voit pas quand on lit le schema. Une cle etrangere composite dit la
-- meme chose, la base la fait respecter, et le prochain lecteur la trouve la ou il cherche deja.
--
-- ⚠️ `source_kind` EST UNE DONNEE DERIVEE, donc une seconde verite, ce que ce depot evite d ordinaire. Elle
-- est acceptee ici parce que c est le seul moyen de faire porter l invariant par la BASE plutot que par une
-- vigilance, et parce que la cle etrangere composite la rend impossible a faire diverger.
alter table agent_tool_sources drop constraint if exists agent_tool_sources_id_kind_key;
alter table agent_tool_sources add constraint agent_tool_sources_id_kind_key unique (id, kind);

alter table agent_tools add column if not exists source_kind text;

-- La reprise passe AVANT la cle etrangere, et l ordre n est pas cosmetique : un outil existant qui porte
-- une source doit voir son `source_kind` renseigne avant qu une contrainte ne le reclame.
-- (Mesure du jour : zero ligne concernee. La requete reste, parce qu elle sera vraie sur toute base
-- fraiche et sur tout environnement de test.)
update agent_tools t set source_kind = s.kind
  from agent_tool_sources s
  where s.id = t.source_id and t.source_kind is null;

-- ⚠️ EN `MATCH SIMPLE` (le defaut) : une ligne dont `source_kind` est null echappe a cette cle. C est
-- exactement ce qui permet au code DEPLOYE, qui ignore la colonne, de continuer a creer des outils. La
-- fermeture complete viendra du CHECK strict, dans une migration SUIVANTE, apres le deploiement.
alter table agent_tools drop constraint if exists agent_tools_source_kind_fk;
alter table agent_tools add constraint agent_tools_source_kind_fk
  foreign key (source_id, source_kind) references agent_tool_sources (id, kind);
