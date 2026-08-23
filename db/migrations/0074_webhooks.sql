-- 0074 : webhooks ENTRANTS (menu Tools). Un outil tiers (Zapier, Make, un CRM, un formulaire de site) poste
-- du JSON sur une URL que la console fournit ; on en extrait des valeurs vers des champs de contact, et/ou on
-- declenche un scenario.
--
-- Pourquoi le scenario n'est PAS une colonne d'ici. La tentation etait de poser workflow_id / start_node_id /
-- cooldown_seconds sur cette table, comme sur automations. On aurait alors DUPLIQUE la semantique du
-- declenchement a deux endroits, avec deux jeux de garde-fous a maintenir. A la place, un webhook qui doit
-- lancer un scenario POSSEDE une ligne automations de type 'webhook' (automation_id ci-dessous) : le
-- declenchement passe donc par runAutomations et herite gratuitement de ses six filtres (contact bloque,
-- anti-rebond par contact, condition, plafond horaire, un seul parcours actif, correspondance). Il n'y a
-- qu'une seule source de verite, et zero logique de declenchement nouvelle.
--
-- Cette ligne compagnon est POSSEDEE par le webhook : elle est creee, modifiee et supprimee depuis l'ecran
-- Tools > Webhooks, et l'ecran Automation ne la liste pas (elle n'a pas de sens hors de son webhook).
--
-- ADDITIVE : aucune table existante n'est modifiee, aucun comportement actuel ne change tant que personne
-- ne cree de webhook.
create table if not exists webhooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  -- Actif par defaut, contrairement a automations.enabled : un webhook desactive rend 404, donc creer un
  -- webhook eteint reviendrait a donner une URL morte a coller chez le tiers.
  enabled boolean not null default true,
  -- Partie publique de l'URL, opaque. C'EST la cle d'acces : 26 caracteres base32 (130 bits), pas un
  -- identifiant. Le tenant est deduit de ce code, JAMAIS du corps de la requete (une URL remise a Zapier
  -- n'est pas un connecteur maison a secret unique).
  code text not null,
  -- Secret d'en-tete OPTIONNEL : un formulaire de site ne sait souvent pas en poser, et l'exiger fermerait
  -- la porte au cas le plus simple. Stocke HACHE (sha256Hex) comme api_keys ; le clair n'est montre qu'une
  -- fois, a la creation.
  secret_hash text,
  -- [{ "chemin": "client.tel", "cible": "sys:phone" }, ...]. On itere sur NOTRE mapping, jamais sur les
  -- cles recues : sinon un tiers ecrirait ou il veut.
  mapping jsonb not null default '[]'::jsonb,
  -- Creer les contacts inconnus. Decision de Julien du 2026-08-22, qui diverge de /hubspot/deal-stage (qui
  -- ne cree PAS) : un webhook << formulaire soumis >> vient d'une personne qui vient d'agir, pas d'un
  -- prospect jamais contacte. Le choix reste VISIBLE et reversible, d'ou la colonne plutot qu'une constante.
  create_contact boolean not null default true,
  -- La ligne automations compagnon. NULL = ce webhook n'ecrit que des champs. on delete set null : supprimer
  -- le SCENARIO (cascade automations) ne doit pas supprimer le webhook, qui garde son URL et son mapping.
  automation_id uuid references automations(id) on delete set null,
  -- LE dernier appel recu, jamais d'historique : c'est ce qui permet de construire le mapping dans l'ecran,
  -- et le seul moyen de deboguer << pourquoi rien ne se passe >>. Contient du JSON tiers, donc
  -- potentiellement des donnees personnelles non demandees : purge a 7 jours + bouton << oublier >>.
  last_payload jsonb,
  last_received_at timestamptz,
  -- Compteur affiche a cote de la case << creer les contacts inconnus >>, pour que la decision reste visible.
  contacts_created integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Le code est l'unique cle de lecture de la route publique : unique GLOBALEMENT (il porte le tenant a lui
-- seul), et c'est cet index qui sert la requete du chemin chaud.
create unique index if not exists webhooks_code_unique on webhooks (code);

-- Liste de l'ecran Tools > Webhooks.
create index if not exists webhooks_tenant_idx on webhooks (tenant_id, created_at desc);
