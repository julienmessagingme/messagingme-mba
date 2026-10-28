-- 0261_ventes_attribuees.sql : le chiffre d affaires attribue (Shopify), lot 1 (spec et plan du 2026-10-28,
-- docs/superpowers/specs/2026-10-28-revenus-attribues-design.md).
--
-- ventes_attribuees : une ligne par commande payee d un contact connu, attribuee a UNE source (la relance du panier
-- paye, la visite rattachee a nos UTM, sinon le dernier envoi livre dans les 5 jours). L attribution se calcule a la
-- reception de orders/paid puis elle est FIGEE : un mois deja lu ne bouge plus.
--
-- EFFACER UNE PERSONNE N EFFACE PAS LE FAIT (doctrine des clics, 0106) : la purge d un contact, customers/redact et la
-- boutique effacee vident commande_id (et contact_id pour les deux derniers), le montant, la devise, la date et la
-- source restent. D ou contact_id en SET NULL et commande_id nullable.
--
-- relances_panier_jour : le compte ANONYME des relances parties, par jour de Paris. Les paniers ne vivent que 7 jours
-- (ils portent un telephone) ; ce compteur garde l historique des relances sans garder personne.
--
-- 🔴 BLOQUANTE : la purge RGPD (purgeMany) nommera ventes_attribuees. Poussee SEULE et appliquee avant que son code
-- n arrive sur main ; elle part en migration=avant (le chemin du webhook l ecrit). L ancien code ne la nomme pas.

-- Les cles etrangeres vers contacts et campaigns, tables chaudes : ne jamais attendre un verrou plus de 5 s.
set local lock_timeout = '5s';

create table if not exists ventes_attribuees (
  id           bigserial primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  commande_id  text,
  contact_id   uuid references contacts(id) on delete set null,
  montant      numeric(18,3) not null check (montant >= 0),
  devise       text not null check (devise ~ '^[A-Z]{3}$'),
  payee_le     timestamptz not null,
  source       text not null check (source in ('campagne', 'relance_panier', 'scenario', 'agent', 'agent_meta')),
  campaign_id  uuid references campaigns(id) on delete set null,
  preuve       text check (preuve is null or preuve in ('panier', 'utm')),
  relance_le   timestamptz,
  test         boolean not null default false,
  cree_le      timestamptz not null default now(),
  constraint ventes_attribuees_relance_chk check ((source = 'relance_panier') = (relance_le is not null))
);

-- L idempotence : orders/paid peut arriver deux fois. Partiel : une ligne anonymisee n a plus de numero.
create unique index if not exists ventes_attribuees_commande_uidx
  on ventes_attribuees (tenant_id, commande_id) where commande_id is not null;
-- La lecture des ecrans et de l outil (lot 2) : un espace, une periode de paiement.
create index if not exists ventes_attribuees_lecture_idx on ventes_attribuees (tenant_id, payee_le);
-- La purge d un contact retrouve ses ventes.
create index if not exists ventes_attribuees_contact_idx on ventes_attribuees (contact_id) where contact_id is not null;

create table if not exists relances_panier_jour (
  tenant_id uuid not null references tenants(id) on delete cascade,
  jour      date not null,
  n         integer not null default 0 check (n >= 0),
  primary key (tenant_id, jour)
);
