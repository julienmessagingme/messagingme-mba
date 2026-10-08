-- 0223 : les webhooks sortants (lot 12, livraison A, spec docs/superpowers/specs/2026-10-08-webhooks-sortants-design.md).
--
-- Le mot webhook designe deja l'ENTREE dans ce depot (table webhooks, src/webhooks/) : ces tables disent evenements.
--
-- adresses_evenements : une adresse HTTPS de l'application d'un client, les types qu'elle recoit, et son secret de
-- signature, chiffre (jamais relu par un ecran). Pendant une rotation, l'ancien secret reste valide jusqu'a
-- secret_precedent_jusqua : les deux vont ensemble (adresses_evenements_rotation_chk).
--
-- envois_evenements : une ligne par couple (evenement, adresse), le journal que la console lit. Le corps est fige a la
-- distribution, un reessai renvoie exactement le meme, octet pour octet : text et pas jsonb, qui reordonnerait les
-- cles (la signature porte sur les octets envoyes, et le client lit l'enveloppe dans l'ordre ecrit). Unique sur (adresse_id, evenement_id) : un evenement redelivre
-- par Meta (meme identifiant) ou une distribution rejouee n'envoie pas deux fois. essais_depuis ouvre la fenetre de
-- 24 h des reessais ; un rejeu la rouvre. contact_id en on delete set null, et la purge RGPD d'un contact efface ses
-- lignes (PgContactStore.purgeMany) : le corps porte son numero et ses messages.
--
-- Aucune cle en restrict : la suppression d'un espace passe par la cascade depuis tenants.
-- Deux tables NEUVES que seul le code neuf ecrit et lit : avant le up, sans risque pour l'ancien code.
set local lock_timeout = '5s';

create table if not exists adresses_evenements (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants (id) on delete cascade,
  url                      text not null,
  description              text not null default '',
  types                    text[] not null,
  secret_chiffre           text not null,
  secret_precedent_chiffre text,
  secret_precedent_jusqua  timestamptz,
  active                   boolean not null default true,
  cree_le                  timestamptz not null default now(),
  maj_le                   timestamptz not null default now(),
  constraint adresses_evenements_url_chk check (url ~ '^https://' and length(url) <= 2048),
  constraint adresses_evenements_description_chk check (length(description) <= 200),
  constraint adresses_evenements_types_chk check (cardinality(types) between 1 and 32),
  constraint adresses_evenements_rotation_chk check ((secret_precedent_chiffre is null) = (secret_precedent_jusqua is null))
);

create index if not exists adresses_evenements_espace_idx on adresses_evenements (tenant_id, cree_le);

create table if not exists envois_evenements (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  adresse_id         uuid not null references adresses_evenements (id) on delete cascade,
  evenement_id       text not null,
  type               text not null,
  contact_id         uuid references contacts (id) on delete set null,
  corps              text not null,
  statut             text not null default 'en_cours',
  tentatives         integer not null default 0,
  essais_depuis      timestamptz not null default now(),
  prochain_essai_le  timestamptz,
  dernier_code       integer,
  derniere_reponse   text,
  cree_le            timestamptz not null default now(),
  livre_le           timestamptz,
  constraint envois_evenements_statut_chk check (statut in ('en_cours', 'livre', 'echec')),
  constraint envois_evenements_tentatives_chk check (tentatives >= 0),
  constraint envois_evenements_id_chk check (length(evenement_id) between 1 and 64),
  constraint envois_evenements_type_chk check (length(type) between 1 and 64),
  constraint envois_evenements_reponse_chk check (derniere_reponse is null or length(derniere_reponse) <= 1000),
  constraint envois_evenements_corps_chk check (length(corps) <= 65536),
  constraint envois_evenements_un_par_adresse unique (adresse_id, evenement_id)
);

create index if not exists envois_evenements_journal_idx on envois_evenements (adresse_id, cree_le desc);
create index if not exists envois_evenements_purge_idx on envois_evenements (tenant_id, cree_le);
create index if not exists envois_evenements_contact_idx on envois_evenements (contact_id) where contact_id is not null;
-- L'etat d'une adresse dans la console (derniere livraison, envois en reessai, echecs) : sans ces trois index partiels,
-- chaque lecture de la liste parcourrait tout le journal de chaque adresse (des centaines de milliers de lignes en Pro
-- avec les accuses coches).
create index if not exists envois_evenements_livres_idx on envois_evenements (adresse_id, livre_le desc) where livre_le is not null;
create index if not exists envois_evenements_reessai_idx on envois_evenements (adresse_id) where statut = 'en_cours' and tentatives > 0;
create index if not exists envois_evenements_echecs_idx on envois_evenements (adresse_id) where statut = 'echec';
