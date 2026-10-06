-- 0211 : un consommateur (un agent IA, l'agent de Meta) ne voit jamais deux outils du même nom.
-- Plan : docs/superpowers/plans/2026-10-06-nom-unique-par-consommateur.md.
--
-- 🔴 CE QUE ÇA FERME. 0157 a posé deux index partiels qui ne se recoupent pas : une définition d'ESPACE (appel de
-- connecteur, outil MCP, outil de l'agent de Meta) est unique par espace, une ACTION est unique par agent. Une action
-- et un appel de connecteur pouvaient donc porter le même nom, et un agent qui utilise les deux recevait deux
-- fonctions homonymes. Mesuré le 2026-10-05 par le Gateway, avec le corps de `chat-client.ts` : les trois
-- fournisseurs refusent en 400 non rejouable (zai/glm-4.7-flash servi par bedrock, anthropic/claude-haiku-4.5,
-- google/gemini-2.5-flash servi par vertex), donc CHAQUE tour de cet agent finissait en échec technique.
--
-- 🔴 UNE CLÉ ÉTRANGÈRE COMPOSITE, PAS UN DÉCLENCHEUR NI UNE VÉRIFICATION DANS LE CODE. L'unicité porte sur deux
-- tables (le nom vit sur l'outil, le consommateur sur la liaison), et aucun index ne les traverse. Le nom est donc
-- recopié sur la liaison, et la clé étrangère en `on update cascade` tient la copie juste, comme 0152 tient
-- `source_kind` : un renommage la met à jour dans la même instruction, et l'index refuse alors le renommage qui
-- ferait un doublon chez N'IMPORTE QUEL consommateur de l'outil. Une vérification lue puis écrite laisserait passer
-- deux écritures simultanées ; l'index les sérialise.
--
-- ⚠️ MESURÉE AVANT D'ÊTRE ÉCRITE (production, 2026-10-05 à 21 h 18 UTC) : 14 liaisons, aucun consommateur ne voit
-- deux outils du même nom, aucune liaison n'est d'un autre espace que son outil. La reprise ne peut pas faire
-- échouer l'index.
--
-- ⚠️ NULLABLE, DÉLIBÉRÉMENT : le code déployé n'écrit pas la colonne, et il doit survivre à la migration, qui passe
-- AVANT le `up` de l'API (le code neuf l'écrit). En MATCH SIMPLE, une liaison sans nom échappe à la clé et à
-- l'index (`null` n'égale rien) : c'est la fenêtre du déploiement, que la migration du lot 2 referme (reprise, puis `not null`)
-- APRÈS le `up`.
--
-- ⚠️ EFFET SUR LES VERROUS : `name` entre dans une contrainte unique non partielle, donc un renommage verrouille
-- l'outil en `FOR UPDATE` (et non plus `FOR NO KEY UPDATE`) : il attend un rattachement en cours (`for key share`),
-- ce qui est le but. L'ordre reste celui du dépôt : la définition, puis ses liaisons.
set local lock_timeout = '5s';

alter table agent_tools drop constraint if exists agent_tools_id_name_key;
alter table agent_tools add constraint agent_tools_id_name_key unique (id, name);

alter table agent_tool_consommateurs add column if not exists tool_name text;

-- La reprise passe avant la clé, qui exige une copie juste sur chaque liaison nommée.
update agent_tool_consommateurs c set tool_name = t.name
  from agent_tools t
 where t.id = c.tool_id and c.tool_name is distinct from t.name;

-- `on delete cascade` comme la clé simple qu'elle double (`agent_tool_consommateurs_tool_id_fkey`) : en `no action`,
-- son contrôle pourrait passer avant la cascade de l'autre et refuser la suppression d'un outil.
alter table agent_tool_consommateurs drop constraint if exists atc_tool_name_fkey;
alter table agent_tool_consommateurs add constraint atc_tool_name_fkey
  foreign key (tool_id, tool_name) references agent_tools (id, name) on update cascade on delete cascade;

-- Le contrat : par espace et par consommateur, un nom une seule fois. Lu par son nom dans `src/agent/catalog.pg.ts`,
-- qui le traduit en 409 : le renommer casse ce refus lisible sans casser la garde.
create unique index if not exists atc_nom_par_consommateur_uidx
  on agent_tool_consommateurs (tenant_id, consommateur, tool_name);
