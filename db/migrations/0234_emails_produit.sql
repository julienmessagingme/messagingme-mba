-- 0234 : les e-mails du produit, pilotes depuis /ops (lot 7 ; plan docs/superpowers/plans/2026-10-14-emails-produit.md,
-- spec docs/superpowers/specs/2026-10-14-emails-produit-design.md).
--
--  - identities.langue : la langue de la console de la personne (fr par defaut), donc celle de ses e-mails.
--  - emails_produit_textes : les textes modifies dans /ops, par modele et par langue. Absente = le texte d origine du
--    catalogue (src/emails-produit/catalogue.ts) ; retablir le texte d origine supprime la ligne.
--  - emails_produit_interrupteurs : un modele coupe ou rallume dans /ops. Absente = actif.
--  - emails_produit_envois : le journal ET le dedoublonnage. Une ligne par personne et par occasion (credit bas, cet
--    espace, cette recharge) : la contrainte unique arrete un doublon, puisque aucune file du depot ne dedoublonne. Elle
--    designe la personne, jamais son adresse en clair ; ses variables sont videes une fois l e-mail parti. Tout s efface
--    en cascade avec l espace ou l identite, sans que la suppression d un espace ait a la nommer.
--  - emails_produit_desinscriptions : ce qu une personne ne veut plus recevoir (les commerciaux, les transferts).
--
-- ELLE AJOUTE SEULEMENT, DONC AVANT LE UP de l API et des workers : l ancien code ne lit rien de neuf et y survit.
set local lock_timeout = '5s';

alter table identities add column if not exists langue text not null default 'fr';
alter table identities drop constraint if exists identities_langue_check;
alter table identities add constraint identities_langue_check check (langue in ('fr', 'en'));

create table if not exists emails_produit_textes (
  cle            text not null,
  langue         text not null check (langue in ('fr', 'en')),
  sujet          text not null check (char_length(sujet) between 1 and 200),
  corps          text not null check (char_length(corps) between 1 and 5000),
  bouton_libelle text check (bouton_libelle is null or char_length(bouton_libelle) between 1 and 60),
  bouton_lien    text check (bouton_lien is null or char_length(bouton_lien) between 1 and 500),
  modifie_par    text not null,
  modifie_le     timestamptz not null default now(),
  primary key (cle, langue),
  constraint emails_produit_textes_bouton check ((bouton_libelle is null) = (bouton_lien is null))
);

create table if not exists emails_produit_interrupteurs (
  cle         text primary key,
  actif       boolean not null,
  modifie_par text not null,
  modifie_le  timestamptz not null default now()
);

create table if not exists emails_produit_envois (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  cle         text not null,
  identity_id uuid not null references identities(id) on delete cascade,
  occasion    text not null check (char_length(occasion) between 1 and 200),
  statut      text not null default 'a_envoyer' check (statut in ('a_envoyer', 'envoye', 'echec', 'ignore')),
  raison      text,
  variables   jsonb not null default '{}'::jsonb,
  tentatives  integer not null default 0,
  prochain_essai_le timestamptz,
  resend_id   text,
  cree_le     timestamptz not null default now(),
  envoye_le   timestamptz,
  livre_le    timestamptz,
  ouvert_le   timestamptz,
  clique_le   timestamptz,
  rebond_le   timestamptz,
  plainte_le  timestamptz,
  constraint emails_produit_envois_une_par_occasion unique (tenant_id, cle, identity_id, occasion)
);

-- Le webhook de Resend retrouve l envoi par son identifiant.
create index if not exists emails_produit_envois_resend_idx on emails_produit_envois (resend_id) where resend_id is not null;
-- La cascade de l identite.
create index if not exists emails_produit_envois_identite_idx on emails_produit_envois (identity_id);
-- Les chiffres du mois et la retention.
create index if not exists emails_produit_envois_cree_idx on emails_produit_envois (cree_le);
-- Le balayage des envois a faire (jamais enfiles, ou a reessayer a prochain_essai_le) : son where reprend ce predicat
-- mot pour mot.
create index if not exists emails_produit_envois_a_envoyer_idx on emails_produit_envois (cree_le) where statut = 'a_envoyer';

create table if not exists emails_produit_desinscriptions (
  identity_id uuid not null references identities(id) on delete cascade,
  categorie   text not null check (categorie in ('commercial', 'transfert')),
  le          timestamptz not null default now(),
  primary key (identity_id, categorie)
);
