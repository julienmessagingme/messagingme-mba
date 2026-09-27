-- 0183_salesforce_socle.sql : le socle de l app Salesforce (plan 2026-09-26, lot L1).
--
-- POURQUOI. L app Salesforce relie un espace a UNE org Salesforce cliente. Cette migration pose la seule table
-- dont la connexion a besoin, et l interrupteur d espace qui fait apparaitre l integration dans la console.
--
-- 1. LE SCHEMA salesforce, le premier schema que ce depot cree. Ses tables ne sont lues et ecrites QUE par le
--    store du connecteur (src/salesforce/store.pg.ts) : aucune jointure avec public, aucune cle etrangere vers
--    public, jamais une transaction qui ecrive dans les deux. C est ce qui le rend extractible vers sa propre
--    base le jour ou des clients reels le justifient (docs/ARCHITECTURE-CIBLE.md, section 8). Toute requete le
--    QUALIFIE : le depot ne depend d aucun search_path, et cette migration n en pose aucun.
--    Consequence assumee de l absence de cle etrangere : supprimer un espace n emporte pas sa ligne. Aucun
--    chemin ne supprime un espace aujourd hui ; le jour venu, il faudra couper l org puis oublier la ligne.
--
-- 2. salesforce.orgs, une ligne par espace connecte, et une org ne sert qu un espace (unique dans les deux
--    sens). La deconnexion SUPPRIME la ligne, ce qui libere l org pour un autre espace.
--    etat : connexion (le secret est ecrit chez nous, pas encore pose dans l org), connectee, en_pause, coupee
--    (jeton refuse, package desinstalle : motif_coupure dit lequel).
--    secret_entrant_chiffre : le secret qui signe les appels de l org vers nous, CHIFFRE par ENCRYPTION_KEY
--    (src/crypto/secretbox.ts). Chiffre et non haché : la verification HMAC exige le secret en clair. Une org
--    connectee en porte toujours un (CHECK).
--    utilisateur_integration : l utilisateur Salesforce d Engage Me, dont les declencheurs ignoreront les
--    modifications (sinon nos propres ecritures relanceraient des automations).
--    Pour une liste de selection, le champ de consentement se lit par sa valeur oui ET s ecrit par sa valeur
--    non (le STOP). envoyer_resume est FAUX par defaut : le resume contient des propos du client.
--    org_id est l identifiant a 18 caracteres (00D...) : la forme a 15 caracteres rendrait l unicite fausse.
--
-- 3. tenant_settings.salesforce_actif, sur le modele exact de hubspot_actif (0179) : un reglage de l espace,
--    faux par defaut, sans reprise (aucune org n est reliee). La ligne d orgs n existe pas avant la connexion,
--    c est pourquoi l interrupteur vit dans le coeur.
--
-- 4. LES ROLES DE L API DE DONNEES DE SUPABASE ne recoivent rien sur ce schema : on le leur retire
--    explicitement quand ils existent (une base neuve, celle de la CI, ne les porte pas, d ou la garde).
--
-- ADDITIVE : l ancien code ne lit ni la table ni la colonne (la lecture des reglages est un select etoile).
-- Elle passe AVANT le deploiement du code qui les ECRIT (la connexion, l interrupteur), sans quoi ils
-- rendraient 42P01 et 42703.

create schema if not exists salesforce;

create table if not exists salesforce.orgs (
  tenant_id                  uuid primary key,
  org_id                     text not null unique check (org_id ~ '^00D[0-9A-Za-z]{15}$'),
  my_domain                  text not null,
  sandbox                    boolean not null default false,
  etat                       text not null default 'connexion'
                               check (etat in ('connexion', 'connectee', 'en_pause', 'coupee')),
  motif_coupure              text,
  secret_entrant_chiffre     text,
  utilisateur_integration    text,
  version_package            text,
  quota_utilise              integer,
  quota_max                  integer,
  quota_releve_le            timestamptz,
  champ_consentement_lead    text,
  valeur_oui_lead            text,
  valeur_non_lead            text,
  champ_consentement_contact text,
  valeur_oui_contact         text,
  valeur_non_contact         text,
  envoyer_resume             boolean not null default false,
  proprietaire_repli         text,
  connectee_le               timestamptz,
  connectee_par              uuid,
  maj_le                     timestamptz not null default now(),
  constraint orgs_connectee_a_un_secret check (etat <> 'connectee' or secret_entrant_chiffre is not null)
);

alter table tenant_settings add column if not exists salesforce_actif boolean not null default false;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema salesforce from %I', r);
      execute format('revoke all on all tables in schema salesforce from %I', r);
    end if;
  end loop;
end
$$;
