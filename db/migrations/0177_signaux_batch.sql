-- 0177_signaux_batch.sql : les signaux vers l outil d un client (spec 2026-09-24, section 8), lot 6 de l API publique.
--
-- DEUX changements, et l ancien code survit aux deux : il n ecrit pas la table neuve, et il n ecrit jamais
-- la source signaux dans le journal. Donc AVANT le deploiement du code qui les ecrit.
--
-- 1. integration_batch : le reglage de l adaptateur, UNE ligne par espace.
--    Les deux cles sont CHIFFREES (src/crypto/secretbox.ts, ENCRYPTION_KEY) et jamais relues en clair par
--    un ecran. envoyer_resume est FAUX par defaut : le resume contient des propos du client.
--    sans_identifiant compte les signaux non pousses faute d identifiant externe sur la fiche : l ecran du
--    reglage le montre, pour qu un integrateur qui a oublie de nous passer ses identifiants le VOIE.
--    refus_cles_le suspend la remontee quand l outil refuse les cles (401, 403). Sans elle, chaque signal
--    ecrirait une ligne de plus dans agent_tool_calls, que rien ne purge.
--    AUCUN index en plus de la cle primaire : la seule lecture transverse (les espaces actifs, mise en cache
--    par l emetteur) parcourt une table d une ligne par espace branche.
--
-- 2. Le CHECK de la source du journal des appels s ouvre a signaux : un echec de poussee s ecrit dans la
--    moitie systeme du journal des erreurs, comme un connecteur qui refuse un appel. RELACHER un CHECK
--    laisse vivre l ancien code. La liste doit rester celle de SOURCES_APPEL (src/agent/catalog.ts), et
--    tests/sources-appel-parite.test.ts lit la DERNIERE migration qui le pose.

create table if not exists integration_batch (
  tenant_id           uuid primary key references tenants(id) on delete cascade,
  cle_rest_chiffree   text not null,
  cle_projet_chiffree text not null,
  envoyer_resume      boolean not null default false,
  sans_identifiant    bigint not null default 0,
  sans_identifiant_le timestamptz,
  refus_cles_le       timestamptz,
  maj_le              timestamptz not null default now()
);

alter table agent_tool_calls drop constraint if exists agent_tool_calls_source_check;
alter table agent_tool_calls add constraint agent_tool_calls_source_check
  check (source in ('agent', 'scenario', 'optout', 'mba', 'signaux'));
