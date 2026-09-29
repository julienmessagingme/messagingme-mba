-- 0191_stripe_recharge.sql : recharger le credit IA par Stripe, et les 5 euros offerts au premier numero.
--
-- POURQUOI. Le credit prepaye d un espace ne se rechargeait qu a la main, par /ops. Julien a cree deux prix
-- Stripe ponctuels (Refill 50 et Refill 100, HT) : un admin paie sur la page hebergee par Stripe, et le webhook
-- de Stripe credite l espace (docs/superpowers/specs/2026-09-28-recharge-stripe-design.md). Et le credit offert
-- ne se donne plus a la creation d un espace, qui se recolte par script, mais a la connexion de son premier
-- numero WhatsApp (decision de Julien du 2026-09-29).
--
-- TROIS TABLES, TOUTES ADDITIVES. L ancien code n en lit aucune : elle passe AVANT le deploiement du code qui
-- les ecrit (la route de paiement, le webhook, la liaison d un numero), sans quoi chacun de ces chemins
-- echouerait en 42P01.

-- LE CLIENT STRIPE D UN ESPACE, cree au premier achat et reutilise ensuite (ses factures se suivent sous un
-- seul client chez Stripe).
-- 🔴 LA CLE PRIMAIRE PORTE LE MODE (test ou live). Un client cree avec une cle de test n existe pas en live :
-- sans le mode, l espace qui a fait l essai en test garderait son identifiant de test, et son premier vrai
-- paiement echouerait sur « No such customer ». C est exactement l essai reel qui clot le chantier.
-- UNIQUE sur l identifiant Stripe : deux espaces ne partagent jamais un client, donc jamais ses factures.
create table if not exists stripe_clients (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  livemode    boolean not null,
  customer_id text not null unique,
  cree_le     timestamptz not null default now(),
  primary key (tenant_id, livemode)
);

-- LES PAIEMENTS RECUS, un par session Checkout.
-- 🔴 LA CLE PRIMAIRE SUR LA SESSION EST L IDEMPOTENCE DU WEBHOOK. Stripe renvoie couramment le meme evenement,
-- et deux evenements (paiement immediat, paiement differe reussi) peuvent designer la meme session. Le webhook
-- insere cette ligne, le credit et son mouvement achat dans UNE transaction : un conflit sur la cle veut dire
-- deja credite, et rien d autre ne s ecrit.
-- Les montants sont en CENTIMES, comme Stripe les rend : HT (ce qui devient du credit, recoupe avec l offre)
-- et TTC (ce que le client a paye, TVA comprise, nul si Stripe ne le donne pas). Le credit accorde est en
-- micro-euros, comme le solde. Aucun index de plus : la seule lecture est le conflit sur la cle primaire.
create table if not exists stripe_paiements (
  session_id           text primary key,
  tenant_id            uuid not null references tenants(id) on delete cascade,
  offre                text not null,
  credit_micro_eur     bigint not null,
  montant_ht_centimes  integer not null,
  montant_ttc_centimes integer,
  facture_id           text,
  livemode             boolean not null,
  cree_le              timestamptz not null default now()
);

-- LE CREDIT OFFERT A LA CONNEXION DU PREMIER NUMERO WHATSAPP, une ligne par offre.
-- 🔴 DEUX BORNES, ET CE SONT LES CONTRAINTES QUI LES TIENNENT : une offre par espace (cle primaire) ET jamais
-- deux fois pour le meme numero (unique), meme s il change d espace. La liaison insere ici, et n ecrit le
-- credit et son mouvement offert que si l insertion a eu lieu, dans la meme transaction.
-- ⚠️ PAS DE CLE ETRANGERE VERS tenants, delibere : cette table est la memoire de ce qui a DEJA ETE DONNE. Une
-- cascade l effacerait avec l espace, et le meme numero, relie a un espace neuf, repartirait avec 5 euros de
-- plus. Une ligne orpheline ne coute rien et ne se lit jamais par l espace disparu.
create table if not exists credits_offerts (
  tenant_id         uuid primary key,
  phone_number_id   text not null unique,
  montant_micro_eur bigint not null,
  offert_le         timestamptz not null default now()
);

-- PAS RETROACTIF : les espaces qui ont DEJA un numero sont marques, a zero. Sans cette reprise, un espace
-- existant qui rejoue l inscription sur son numero (geste idempotent) recevrait l offre des nouveaux.
-- Un seul numero par espace (le plus petit identifiant) : la cle primaire n en accepte qu un.
insert into credits_offerts (tenant_id, phone_number_id, montant_micro_eur)
select distinct on (tenant_id) tenant_id, id, 0
  from phone_numbers
 order by tenant_id, id
on conflict do nothing;
