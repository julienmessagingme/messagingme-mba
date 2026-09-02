-- 0105_connector_requests.sql : les REQUETES d un connecteur, rangees dans la bibliotheque du workspace.
--
-- Ce qui change, et pourquoi. Jusqu ici un appel de connecteur etait declare PAR AGENT : la methode, le
-- chemin et les parametres vivaient dans `agent_tools`, donc il fallait re-decrire le meme appel pour chaque
-- agent qui s en sert. Julien, le 2026-09-02, decrit l inverse : « le client choisit dans la liste l appel API
-- setuppe dans Tools > connecteurs API ». La source (adresse + authentification) etait deja partagee par le
-- workspace ; la requete l est desormais aussi, et un agent ne fait plus que PIOCHER dedans.
--
-- C est aussi ce qui rend l ecran possible. Un mini-Postman (methode, parametres d URL, corps, en-tetes,
-- reponse, bouton Test) n a de sens que sur un objet qui existe en dehors d un agent : on ne met pas au point
-- une requete DANS le reglage d un agent, on la met au point une fois, on l eprouve, puis on l ouvre aux
-- agents qui en ont besoin.
--
-- 🔴 AUCUNE DONNEE A REPRENDRE. Verifie en production le 2026-09-02 avant d ecrire cette migration : zero
-- source declaree, zero outil de connecteur, toutes origines confondues. La table part donc vide et
-- `agent_tools.request_id` peut rester nullable sans laisser de ligne batarde derriere.
--
-- ⚠️ NON BLOQUANTE au sens du deploiement : aucun code existant n ecrit dans cette table ni dans cette
-- colonne tant que les routes ne sont pas livrees. La migrer avant reste la regle, l oublier ne casse rien.

create table if not exists connector_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  -- `restrict` et non `cascade` : supprimer une source qui porte des requetes rendrait muets les agents qui
  -- s en servent, en silence. Le refus lisible est porte par la route ; cette contrainte est la ceinture.
  source_id     uuid not null references agent_tool_sources(id) on delete restrict,
  -- Le nom que l utilisateur donne a l appel (« Chercher une commande »). C est lui qui apparait dans la
  -- liste ou un agent vient piocher, donc il doit rester lisible : ce n est pas le nom expose au modele.
  label         text not null,
  method        text not null check (method in ('GET','POST','PUT','PATCH','DELETE')),
  -- Gabarit de chemin, relatif a l adresse de base de la source. Notation `{nom}`, celle de `http-cible.ts`.
  path          text not null,
  -- Parametres d URL : [{cle, valeur}], la valeur etant un gabarit a variables `{{nom}}`.
  query         jsonb not null default '[]'::jsonb,
  -- En-tetes SUPPLEMENTAIRES. ⚠️ L authentification n est PAS ici : elle vit sur la source, chiffree, et
  -- `enTetesAuthSource` reste son unique point de passage. Un secret colle dans un en-tete de requete serait
  -- stocke en clair et repartirait dans chaque export de configuration.
  headers       jsonb not null default '[]'::jsonb,
  -- Comment le corps est SAISI. Deux facons, demandees explicitement : du JSON brut pour qui connait les API,
  -- une liste de champs pour qui ne veut pas voir d accolade. Un seul moteur de substitution dessous.
  body_mode     text not null default 'aucun' check (body_mode in ('aucun','json','champs')),
  body_json     text,
  body_champs   jsonb not null default '[]'::jsonb,
  -- Declaration des variables : d ou vient la valeur de chacune (modele, contact, champ, systeme, fixe).
  variables     jsonb not null default '[]'::jsonb,
  -- 🔴 NON VIDE, meme regle que l ancien chemin (decision D-L2-2) : la reponse appartient au client et part
  -- chez le fournisseur de modele. C est ici, et seulement ici, que quelqu un decide ce que l agent en lit.
  output_paths  text[] not null,
  -- Valeurs d ESSAI, par variable, pour le bouton Test. Elles ne servent qu au test manuel et ne sont jamais
  -- lues a l execution : un connecteur qui retomberait sur une valeur de test enverrait au systeme du client
  -- une donnee inventee, et sa reponse serait fausse sans que rien ne le signale.
  valeurs_test  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Le nom est unique par espace, insensible a la casse : deux requetes « Chercher une commande » et
-- « chercher une commande » dans la meme liste seraient indiscernables au moment de choisir.
create unique index if not exists connector_requests_label_idx
  on connector_requests (tenant_id, lower(label));

-- Lecture type : « les requetes de cette source », pour refuser la suppression d une source qui en porte.
create index if not exists connector_requests_source_idx on connector_requests (tenant_id, source_id);

-- L outil d un agent DESIGNE une requete au lieu de la redecrire. Nullable : les outils maison n en ont pas.
-- `restrict` pour la meme raison que ci-dessus : supprimer une requete utilisee par un agent le rendrait muet.
alter table agent_tools add column if not exists request_id uuid
  references connector_requests(id) on delete restrict;

create index if not exists agent_tools_request_idx on agent_tools (request_id) where request_id is not null;
