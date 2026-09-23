-- 0168_grille_prix_globale.sql : UNE SEULE grille de prix, pour tous les espaces.
--
-- Arbitrage de Julien du 2026-09-23 (lot 8 de sa liste) : les prix se reglent dans /ops, une fois, et
-- l'ecran « Vos prix » des Parametres disparait. Un client n'a pas a fixer ce qu'on lui facture.
--
-- 🔴 ELLE RETOURNE UNE DECISION ECRITE SIX JOURS PLUS TOT, ET IL FAUT LE DIRE. Le docblock de
-- `src/stats/prix.ts` porte, depuis le 2026-09-17, l'exact contraire : « Par ESPACE et pas en configuration
-- globale : le tarif smsmode se negocie, et un grand compte ne se facture pas comme un petit. » Cette
-- raison-la n'a pas disparu, elle a ete PESEE contre une autre et elle a perdu : entre « pouvoir negocier
-- un prix par client » et « le client ne voit ni ne fixe ce qu'on lui facture », Julien a tranche pour le
-- second. Le jour ou un grand compte demandera son prix, ce sera une surcharge PAR ESPACE a rouvrir, pas un
-- oubli a reparer. Ne pas reintroduire la colonne par reflexe.
--
-- 🔴 UNE LIGNE AU PLUS, GARANTIE PAR LE SCHEMA ET PAS PAR LE CODE. `id boolean primary key check (id)`
-- n'accepte que la valeur `true` : il ne PEUT pas y avoir deux grilles. Une table ordinaire avec « on ne met
-- qu'une ligne » se serait mise a en porter deux le jour d'un `insert` maladroit, et le code aurait lu la
-- premiere par hasard. C'est exactement le genre d'invariant qu'un commentaire ne tient pas.
--
-- ⚠️ ELLE CREE UNE TABLE QUE LE CODE NEUF LIT ET ECRIT, donc elle passe AVANT le deploiement. Elle ne touche
-- a AUCUNE colonne existante : les six colonnes de `tenant_settings` restent en place et l'ancien code
-- continue de les lire sans rien remarquer. C'est ce qui rend le retour arriere possible jusqu'au dernier
-- moment. Leur suppression est une migration SUIVANTE, a passer APRES le deploiement, quand plus aucun code
-- deploye ne les lit (regle corrigee au lot 0128 : la question n'est pas « ajoute ou retire » mais
-- « l'ancien code survit-il a ce changement ? »).
--
-- ⚠️ MESURE AVANT D'ECRIRE CE FICHIER (2026-09-23, production) : `tenant_settings` porte UNE seule ligne
-- (marge 100.00, service 2.48 cts, franchise 1000, a partir du 2026-10-01, RCS 6.00 et 8.00). La reprise est
-- donc EXACTE et personne ne verra un chiffre bouger.

create table if not exists grille_prix (
  -- La cle qui rend le singleton STRUCTUREL : `true` est la seule valeur acceptee.
  id                      boolean     primary key default true check (id),
  prix_marge_template     numeric(6,2) not null default 100,
  prix_service_centimes   numeric(6,2) not null default 2.48,
  prix_service_franchise  integer      not null default 1000,
  prix_service_depuis     date         not null default '2026-10-01',
  prix_rcs_centimes       numeric(6,2) not null default 6.00,
  prix_rcs_conv_centimes  numeric(6,2) not null default 8.00,
  modifie_le              timestamptz  not null default now(),
  -- QUI a change le prix. Du texte et pas une cle etrangere vers `users` : /ops s'authentifie par un JETON,
  -- pas par un compte, donc il n'y a pas d'utilisateur a referencer. On garde ce qu'on sait.
  modifie_par             text
);

-- Les MEMES bornes que les CHECK de 0154, mot pour mot. Deux jeux de bornes pour une meme valeur, c'est un
-- 500 au lieu d'un message : si l'ecriture acceptait plus large, Postgres refuserait la ligne sur un geste
-- ordinaire ; plus etroit, un reglage legitime serait refuse sans raison lisible.
alter table grille_prix drop constraint if exists grille_prix_marge_chk;
alter table grille_prix add constraint grille_prix_marge_chk
  check (prix_marge_template between 1 and 1000);

alter table grille_prix drop constraint if exists grille_prix_montants_chk;
alter table grille_prix add constraint grille_prix_montants_chk
  check (prix_service_centimes >= 0 and prix_service_centimes <= 100
     and prix_rcs_centimes >= 0 and prix_rcs_centimes <= 100
     and prix_rcs_conv_centimes >= 0 and prix_rcs_conv_centimes <= 100);

alter table grille_prix drop constraint if exists grille_prix_franchise_chk;
alter table grille_prix add constraint grille_prix_franchise_chk
  check (prix_service_franchise >= 0 and prix_service_franchise <= 1000000);

-- LA REPRISE. Elle REFUSE plutot que d'inventer quand les espaces divergent : mesure ci-dessus, il n'y en a
-- qu'un aujourd'hui, donc ce refus ne peut pas se declencher. Mais le jour ou il le ferait, choisir une
-- ligne « au hasard » ecrirait un prix que personne n'a decide, et le client batirait un budget dessus. Une
-- migration qui echoue AVANT le deploiement ne casse rien (l'ancien code tourne toujours) et force une
-- decision humaine ; une migration qui invente ne se voit jamais.
do $$
declare
  n_distinctes integer;
  src record;
begin
  -- Rien a reprendre si la grille existe deja (migration rejouee) : on ne reecrit jamais un prix en place.
  if exists (select 1 from grille_prix) then
    return;
  end if;

  select count(*) into n_distinctes from (
    select distinct prix_marge_template, prix_service_centimes, prix_service_franchise,
                    prix_service_depuis, prix_rcs_centimes, prix_rcs_conv_centimes
      from tenant_settings
  ) d;

  if n_distinctes > 1 then
    raise exception 'grille_prix : % grilles differentes dans tenant_settings, la reprise ne peut pas choisir. Trancher a la main avant de rejouer cette migration.', n_distinctes;
  end if;

  select prix_marge_template, prix_service_centimes, prix_service_franchise,
         prix_service_depuis, prix_rcs_centimes, prix_rcs_conv_centimes
    into src
    from tenant_settings
   limit 1;

  if found then
    insert into grille_prix (id, prix_marge_template, prix_service_centimes, prix_service_franchise,
                             prix_service_depuis, prix_rcs_centimes, prix_rcs_conv_centimes, modifie_par)
    values (true, src.prix_marge_template, src.prix_service_centimes, src.prix_service_franchise,
            src.prix_service_depuis, src.prix_rcs_centimes, src.prix_rcs_conv_centimes, 'migration 0168');
  else
    -- Aucun espace n'a jamais ouvert ses reglages : la ligne part sur les defauts de la table, qui sont
    -- ceux de 0154. Personne ne voit un chiffre bouger.
    insert into grille_prix (id, modifie_par) values (true, 'migration 0168');
  end if;
end $$;
