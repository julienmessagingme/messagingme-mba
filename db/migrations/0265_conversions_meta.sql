-- 0265 : les conversions envoyees a Meta pour nos publicites (lot 2 du plan docs/superpowers/plans/2026-10-30-pixel-meta.md,
-- spec docs/superpowers/specs/2026-10-30-pixel-meta-design.md).
--
--  - identities.pub_consenti_le : la date de l accord de la personne (la case a l inscription, ou l interrupteur de son
--    compte). null = aucun accord, rien ne part chez Meta pour elle. pub_fbc et pub_fbp : les identifiants du clic et du
--    navigateur que Meta a poses sur la vitrine, gardes seulement avec l accord et effaces au retrait. pub_navigateur :
--    le navigateur de la personne au moment de son accord, que Meta exige pour un evenement de site web.
--  - identities.adresse_prouvee_le : la premiere entree par Google, qui prouve l adresse. null = adresse non prouvee, et
--    son empreinte ne part jamais chez Meta (une inscription par e-mail peut porter l adresse d un tiers).
--  - conversions_meta : le journal ET le dedoublonnage. Une ligne par fait : la cle unique (qui est aussi l event_id
--    envoye a Meta) arrete un doublon, puisque aucune file du depot ne dedoublonne. Elle designe la personne, jamais son
--    adresse ; l IP et le navigateur d une inscription sont effaces des que l envoi est fini. cree_le est l heure du fait,
--    comparee a pub_consenti_le a l envoi. Tout s efface en cascade avec l espace ou l identite, sans que la suppression
--    d un espace ait a la nommer.
--
-- ELLE AJOUTE SEULEMENT, DONC AVANT LE UP de l API et des workers : l ancien code ne lit rien de neuf et y survit.
set local lock_timeout = '5s';

alter table identities add column if not exists pub_consenti_le timestamptz;
alter table identities add column if not exists pub_fbc text;
alter table identities add column if not exists pub_fbp text;
alter table identities add column if not exists adresse_prouvee_le timestamptz;
alter table identities add column if not exists pub_navigateur text;
alter table identities drop constraint if exists identities_pub_navigateur_check;
alter table identities add constraint identities_pub_navigateur_check check (pub_navigateur is null or char_length(pub_navigateur) between 1 and 1000);
alter table identities drop constraint if exists identities_pub_fbc_check;
alter table identities add constraint identities_pub_fbc_check check (pub_fbc is null or char_length(pub_fbc) between 1 and 500);
alter table identities drop constraint if exists identities_pub_fbp_check;
alter table identities add constraint identities_pub_fbp_check check (pub_fbp is null or char_length(pub_fbp) between 1 and 500);

create table if not exists conversions_meta (
  id          uuid primary key default gen_random_uuid(),
  cle         text not null check (char_length(cle) between 1 and 200),
  evenement   text not null check (evenement in ('CompleteRegistration', 'NumeroConnecte', 'Subscribe')),
  identity_id uuid not null references identities(id) on delete cascade,
  tenant_id   uuid references tenants(id) on delete cascade,
  valeur_centimes integer check (valeur_centimes is null or valeur_centimes >= 0),
  devise      text check (devise is null or devise in ('EUR', 'USD', 'GBP')),
  ip          text check (ip is null or char_length(ip) between 1 and 64),
  navigateur  text check (navigateur is null or char_length(navigateur) between 1 and 1000),
  statut      text not null default 'a_envoyer' check (statut in ('a_envoyer', 'envoye', 'echec', 'ignore')),
  raison      text,
  tentatives  integer not null default 0,
  prochain_essai_le timestamptz,
  cree_le     timestamptz not null default now(),
  envoye_le   timestamptz,
  constraint conversions_meta_cle_unique unique (cle)
);

-- La cascade de l identite, et le retrait de l accord, qui abandonne les envois en attente de la personne.
create index if not exists conversions_meta_identite_idx on conversions_meta (identity_id);
-- La cascade de l espace.
create index if not exists conversions_meta_espace_idx on conversions_meta (tenant_id) where tenant_id is not null;
-- Le balayage des envois a faire (jamais enfiles, ou a reessayer a prochain_essai_le) : son where reprend ce predicat
-- mot pour mot.
create index if not exists conversions_meta_a_envoyer_idx on conversions_meta (cree_le) where statut = 'a_envoyer';

-- PAS DE RATTRAPAGE : les faits deja accomplis sont reserves, en ignore. Sans cette reprise, l espace deja connecte qui
-- rejoue sa connexion, ou l espace deja abonne dont la facture suivante arrive, verrait ce fait partir chez Meta comme un
-- fait neuf, une fois l accord donne (la cle est libre, et cree_le serait l heure de la reprise). Meme personne que la
-- reservation du code : l admin actif le plus ancien. Un numero : un numero rattache, un compte de l application deja
-- relie une fois, ou une offre de bienvenue deja servie. Une offre : un abonnement, quel que soit son etat.
insert into conversions_meta (cle, evenement, identity_id, tenant_id, statut, raison)
select distinct on (u.tenant_id) 'numero:' || u.tenant_id, 'NumeroConnecte', u.identity_id, u.tenant_id, 'ignore', 'anterieur'
  from users u
 where u.tenant_id in (select tenant_id from phone_numbers
                       union select tenant_id from comptes_application where relie_le is not null
                       union select tenant_id from credits_offerts)
   and (u.role = 'admin' or offre_de_l_espace(u.tenant_id) = 'pro') and u.disabled_at is null and u.identity_id is not null
 order by u.tenant_id, u.created_at
on conflict on constraint conversions_meta_cle_unique do nothing;

insert into conversions_meta (cle, evenement, identity_id, tenant_id, statut, raison)
select distinct on (u.tenant_id) 'pro:' || u.tenant_id, 'Subscribe', u.identity_id, u.tenant_id, 'ignore', 'anterieur'
  from users u
 where u.tenant_id in (select tenant_id from abonnements_offre)
   and (u.role = 'admin' or offre_de_l_espace(u.tenant_id) = 'pro') and u.disabled_at is null and u.identity_id is not null
 order by u.tenant_id, u.created_at
on conflict on constraint conversions_meta_cle_unique do nothing;
