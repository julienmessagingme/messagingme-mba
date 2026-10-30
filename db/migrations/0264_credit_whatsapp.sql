-- 0264 : le Credit WhatsApp, lot 1 (spec docs/superpowers/specs/2026-10-30-credit-whatsapp-design.md, plan
-- docs/superpowers/plans/2026-10-30-credit-whatsapp-notre-cote.md, tache 1).
--
-- Un espace dont un numero est « sur la ligne » ne pose pas de carte chez Meta : la ligne de credit d'un partenaire paie
-- ses messages, et il les prepaie chez nous. Ce qui suit porte ce prepaye.
--  - credits_whatsapp : le solde par espace, en MICRO-EUROS (bigint signe : une regularisation peut le rendre negatif,
--    alors plus rien ne part ; c'est voulu, la garde refuse tout envoi qui le ferait passer sous zero).
--  - credit_whatsapp_provisions : une ligne par message envoye sur la ligne, prise AVANT l'appel a Meta, rattachee au
--    wamid ensuite, rendue ou corrigee a l'accuse. Le solde vaut toujours : mouvements moins provisions non rendues.
--  - credit_whatsapp_mouvements : ce qui entre (achats, recharges) et les regularisations sur les volumes de Meta ;
--    un paiement ne credite qu'une fois (reference unique), une regularisation par jour (remplacee a chaque passe).
--  - lignes_credit_whatsapp : quels numeros sont sur la ligne, depuis quand, jusqu'a quand. SANS cle etrangere vers
--    phone_numbers : un numero deconnecte peut rester sur la ligne du partenaire, /ops doit encore le savoir.
--  - grilles_meta et grille_meta_tarifs : la grille que Meta publie en euros, par marche, categorie et palier, datee.
--  - credit_whatsapp_reglages : la commission des messages (5 %), reglable dans /ops sans deploiement.
--  - tenants : l'open bar de l'Entreprise (envois jamais refuses, factures apres coup) et sa commission negociee.
--  - campaigns_pause_reason_check : credit_whatsapp_epuise et ligne_credit_inactive, sous le meme nom.
--
-- A appliquer AVANT le code : la garde de la fabrique d'envoi lit lignes_credit_whatsapp a CHAQUE envoi, une table
-- absente ferait echouer tous les envois. L'ancien code y survit : il ne nomme aucune de ces tables, les colonnes de
-- tenants ont un defaut constant, et le CHECK elargi accepte tout ce qu'il ecrit. tenants et campaigns sont lues a
-- chaque requete : au-dela de 5 s d'attente d'un verrou, la migration echoue et se rejoue (tout est idempotent).
set local lock_timeout = '5s';

create table if not exists credits_whatsapp (
  tenant_id       uuid primary key references tenants(id) on delete cascade,
  solde_micro_eur bigint not null default 0,
  maj_le          timestamptz not null default now()
);

create table if not exists credit_whatsapp_provisions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  -- L'identifiant Meta du numero qui envoie (phone_numbers.id), en texte, sans cle etrangere : la trace comptable
  -- survit a la deconnexion du numero.
  phone_number_id   text not null,
  -- Pose apres l'envoi. Null entre les deux ecritures, ou quand Meta n'a rien rendu (doute) : la regularisation tranche.
  wamid             text,
  -- Pays ISO du destinataire ; null pour un destinataire sans numero, provisionne au tarif le plus haut.
  pays              text check (pays is null or pays ~ '^[A-Z]{2}$'),
  categorie         text not null check (categorie in ('marketing', 'utility', 'authentication', 'authentication_international', 'service')),
  montant_micro_eur bigint not null check (montant_micro_eur >= 0),
  etat              text not null default 'provisionne' check (etat in ('provisionne', 'rendu', 'ajuste')),
  cree_le           timestamptz not null default now(),
  livre_le          timestamptz
);

create unique index if not exists credit_whatsapp_provisions_wamid_uidx
  on credit_whatsapp_provisions (tenant_id, wamid) where wamid is not null;
create index if not exists credit_whatsapp_provisions_tenant_idx
  on credit_whatsapp_provisions (tenant_id, cree_le desc);
-- La franchise de service se compte par numero et par mois, a chaque message libre (serviceDuMois, credit.pg.ts) : un
-- index PARTIEL, dont le predicat reprend mot pour mot le where de cette requete, pour ne lire que les services du mois.
create index if not exists credit_whatsapp_provisions_service_idx
  on credit_whatsapp_provisions (phone_number_id, cree_le) where categorie = 'service' and etat <> 'rendu';

create table if not exists credit_whatsapp_mouvements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  -- Positif = credit, negatif = debit. La liste des raisons vit dans le code (src/credit-whatsapp/credit.ts).
  delta_micro_eur bigint not null,
  raison          text not null,
  -- Le jour (UTC) d'une regularisation ; null ailleurs.
  jour            date,
  -- Le paiement d'un achat ou d'une recharge (session Checkout ou facture Stripe) : il ne credite qu'une fois.
  reference       text,
  note            text,
  le              timestamptz not null default now()
);

create unique index if not exists credit_whatsapp_mouvements_reference_uidx
  on credit_whatsapp_mouvements (tenant_id, reference) where reference is not null;
create unique index if not exists credit_whatsapp_mouvements_regularisation_uidx
  on credit_whatsapp_mouvements (tenant_id, jour) where raison = 'regularisation';
create index if not exists credit_whatsapp_mouvements_tenant_idx
  on credit_whatsapp_mouvements (tenant_id, le desc);

create table if not exists lignes_credit_whatsapp (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  phone_number_id text not null,
  waba_id         text,
  -- ops : pose a la main pour un numero de test ; option : pose par la connexion d'une place payee (lot 5).
  origine         text not null check (origine in ('ops', 'option')),
  depuis          timestamptz not null default now(),
  -- Pose quand l'option s'arrete : la ligne paie encore chez Meta, la garde refuse alors tout envoi du numero
  -- (ligne_credit_inactive).
  arretee_le      timestamptz,
  -- Pose quand le numero a quitte la ligne pour de bon (reconnecte avec une carte, ligne retiree par le partenaire) :
  -- la garde l'ignore, le numero envoie comme un autre.
  retiree_le      timestamptz,
  note            text
);

-- Un numero a au plus une ligne en cours, active ou arretee ; c'est aussi la recherche de la garde.
create unique index if not exists lignes_credit_whatsapp_numero_uidx
  on lignes_credit_whatsapp (phone_number_id) where retiree_le is null;
create index if not exists lignes_credit_whatsapp_tenant_idx
  on lignes_credit_whatsapp (tenant_id);

create table if not exists grilles_meta (
  id            uuid primary key default gen_random_uuid(),
  en_vigueur_le date not null,
  chargee_le    timestamptz not null default now(),
  chargee_par   text not null,
  devise        text not null default 'EUR' check (devise = 'EUR'),
  note          text
);

create index if not exists grilles_meta_vigueur_idx on grilles_meta (en_vigueur_le desc, chargee_le desc);

create table if not exists grille_meta_tarifs (
  grille_id      uuid not null references grilles_meta(id) on delete cascade,
  marche         text not null,
  categorie      text not null check (categorie in ('marketing', 'utility', 'authentication', 'authentication_international', 'service')),
  -- 0 = le tarif de base ; sinon le seuil bas d'un palier de volume de Meta (utility et authentication), en messages
  -- factures du mois par le portefeuille, tel que pricing_analytics le rend (TIER « 25000001:50000000 » donne 25000001).
  palier         integer not null default 0 check (palier >= 0),
  prix_micro_eur bigint not null check (prix_micro_eur >= 0),
  primary key (grille_id, marche, categorie, palier)
);

-- Une ligne au plus, garantie par le schema (meme forme que grille_prix, 0168).
create table if not exists credit_whatsapp_reglages (
  id             boolean primary key default true check (id),
  commission_pct integer not null default 5 check (commission_pct between 0 and 100),
  modifie_le     timestamptz not null default now(),
  modifie_par    text
);

insert into credit_whatsapp_reglages (id) values (true) on conflict (id) do nothing;

alter table tenants
  add column if not exists entreprise_open_bar_whatsapp boolean not null default false,
  add column if not exists entreprise_commission_messages_pct integer;

alter table tenants drop constraint if exists tenants_entreprise_commission_messages_pct_chk;
alter table tenants add constraint tenants_entreprise_commission_messages_pct_chk
  check (entreprise_commission_messages_pct is null or entreprise_commission_messages_pct between 0 and 100);

alter table campaigns drop constraint if exists campaigns_pause_reason_check;
alter table campaigns add constraint campaigns_pause_reason_check
  check (pause_reason in ('debit', 'qualite', 'hors_horaires', 'numero_delie', 'numero_suspendu', 'credit_whatsapp_epuise', 'ligne_credit_inactive'));
