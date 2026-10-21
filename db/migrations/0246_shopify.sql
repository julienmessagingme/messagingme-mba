-- 0246 : le connecteur Shopify, lot 1 (plan docs/superpowers/plans/2026-10-21-connecteur-shopify.md).
--
-- Le marchand cree une app dans SON organisation Shopify (la skill du plugin pilote la CLI) et nous transmet son
-- identifiant et son secret. Shopify signe chaque webhook avec ce secret : la boutique se reconnait a son domaine
-- (X-Shopify-Shop-Domain), et c est le secret de CETTE boutique qui verifie la signature.
--
-- Dans public et non dans un schema a part : la purge d une fiche (purgeMany) nomme shopify_commandes et
-- shopify_paniers, et la suppression d un espace passe par la cascade vers tenants.
--
-- shopify_boutiques : une par espace, un espace par boutique (domaine unique). secret_chiffre par ENCRYPTION_KEY
--   (src/crypto/secretbox.ts), chiffre et non hache : le HMAC exige le secret en clair. etat coupee = plus aucun
--   message, mais le secret RESTE : Shopify envoie shop/redact environ 48 h apres la desinstallation, et les sujets
--   RGPD d une boutique coupee doivent encore se verifier. La ligne part par shop/redact ou avec l espace.
--   consentement_par et consentement_le : le marchand a affirme que ses clients consentent (decision de Julien) ;
--   tant qu ils sont nuls, aucune fiche n est ecrite consentante par le connecteur.
-- shopify_messages : un message par evenement et par espace (cle primaire) : brancher REMPLACE, jamais deux envois.
--   variables : la liste ordonnee des donnees Shopify ({{1}}, {{2}}...), cles de src/shopify/donnees.ts.
-- shopify_evenements : une ligne par evenement metier (orders/paid:<id>), le dedoublonnage ET les chiffres de la
--   carte. issue nulle = en cours. Purgee a 30 jours.
-- shopify_commandes : la commande, le client Shopify et la fiche ecrite, pour retrouver la fiche quand Shopify
--   demande d effacer un client (customers/redact nomme le client et ses commandes, la fiche nait du telephone de
--   livraison). Vit autant que la fiche : purgeMany efface ses lignes (la purge anonymise la fiche sans la supprimer,
--   la cascade sur contacts ne joue donc pas).
-- shopify_paniers : les checkouts en attente de relance (lot 2). Pose des ce lot parce que purgeMany le nomme.
--
-- A appliquer SEULE et AVANT le code : purgeMany nomme ces tables, et une table absente ferait echouer toute purge
-- en 42P01. L ancien code ne les lit pas. Tables neuves, mais leurs cles etrangeres prennent un verrou SHARE ROW
-- EXCLUSIVE sur tenants et contacts, lues et ecrites par le chemin chaud : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

create table if not exists shopify_boutiques (
  tenant_id             uuid primary key references tenants(id) on delete cascade,
  domaine               text not null unique check (domaine ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' and char_length(domaine) <= 100),
  client_id             text not null check (char_length(client_id) between 1 and 100),
  secret_chiffre        text not null,
  nom                   text,
  pays                  text,
  devise                text,
  etat                  text not null default 'connectee' check (etat in ('connectee', 'coupee')),
  motif_coupure         text,
  coupee_le             timestamptz,
  consentement_par      uuid,
  consentement_le       timestamptz,
  delai_panier_minutes  integer not null default 60 check (delai_panier_minutes between 15 and 4320),
  connectee_par         uuid,
  connectee_le          timestamptz not null default now(),
  dernier_evenement_le  timestamptz,
  maj_le                timestamptz not null default now()
);

create table if not exists shopify_messages (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  evenement   text not null check (evenement in ('order_paid', 'order_fulfilled', 'checkout_abandoned')),
  modele      text not null check (char_length(modele) between 1 and 512),
  langue      text not null check (char_length(langue) between 1 and 20),
  variables   jsonb not null default '[]'::jsonb check (jsonb_typeof(variables) = 'array'),
  actif       boolean not null default true,
  modifie_par uuid,
  modifie_le  timestamptz not null default now(),
  primary key (tenant_id, evenement)
);

create table if not exists shopify_evenements (
  tenant_id uuid not null references tenants(id) on delete cascade,
  cle       text not null check (char_length(cle) <= 200),
  sujet     text not null,
  issue     text,
  recu_le   timestamptz not null default now(),
  maj_le    timestamptz not null default now(),
  primary key (tenant_id, cle)
);
create index if not exists shopify_evenements_recu_le on shopify_evenements (tenant_id, recu_le);

create table if not exists shopify_commandes (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  commande_id text not null,
  client_id   text,
  contact_id  uuid not null references contacts(id) on delete cascade,
  cree_le     timestamptz not null default now(),
  primary key (tenant_id, commande_id)
);
create index if not exists shopify_commandes_contact on shopify_commandes (contact_id);
create index if not exists shopify_commandes_client on shopify_commandes (tenant_id, client_id) where client_id is not null;

create table if not exists shopify_paniers (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  jeton      text not null,
  telephone  text,
  nom        text,
  lien       text,
  ouvert_le  timestamptz not null default now(),
  maj_le     timestamptz not null default now(),
  ferme_le   timestamptz,
  relance_le timestamptz,
  issue      text,
  primary key (tenant_id, jeton)
);
create index if not exists shopify_paniers_telephone on shopify_paniers (tenant_id, telephone) where telephone is not null;
