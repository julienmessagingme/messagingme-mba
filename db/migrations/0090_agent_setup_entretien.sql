-- 0090_agent_setup_entretien.sql — L'entretien de construction d'un agent, tenu par le SERVEUR.
-- ADD-only (une table neuve) : à migrer AVANT le déploiement du code neuf.
--
-- POURQUOI. La conversation de construction vivait dans l'onglet et nulle part ailleurs : quitter l'onglet la
-- perdait, et le client recommençait à zéro. Julien, le 2026-08-31 : « je veux que la conversation qui a été
-- tenue préalablement soit persistante quand on revient plus tard sur l'onglet ».
--
-- 🔴 MAIS CE N'EST PAS QU'UN CONFORT, et c'est la raison profonde de cette table. Tant que rien n'était
-- persisté, la COUVERTURE de l'entretien était forcément une déclaration du modèle, recalculée à chaque tour
-- à partir de ce qu'il voulait bien annoncer. Un modèle pressé se déclarait couvert et sautait le ton,
-- l'identité et la base de connaissance. En tenant l'état ici, la couverture devient un fait du serveur :
-- c'est ce qui rend le questionnement déterministe (cf. `src/agent/setup/couverture.ts`).
--
-- `poses` est ce qui garantit qu'on a réellement fait le tour : un point n'est couvert que s'il a été POSÉ au
-- client, pas seulement si le modèle prétend en connaître la réponse.
--
-- Une seule ligne par agent : l'entretien est un état courant, pas un journal. On ne garde donc aucun
-- historique de versions, et `on delete cascade` emporte tout avec l'agent.
create table if not exists agent_setup_conversations (
  agent_id    uuid primary key references agents(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- Les tours affichés, [{role, content}]. Bornés en écriture par le code, pas ici : la borne est une règle
  -- de coût (un historique sans fin sortirait la fiche de la fenêtre du modèle), pas une règle de schéma.
  messages    jsonb not null default '[]'::jsonb,
  -- Ce que le client a répondu, [{point, valeur, action?}]. C'est la mémoire de l'entretien.
  reponses    jsonb not null default '[]'::jsonb,
  -- Les points DÉJÀ POSÉS au client, [code].
  poses       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);
