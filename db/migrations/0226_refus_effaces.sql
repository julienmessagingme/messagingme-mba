-- 0226 : la liste de refus des fiches effacees (lot 13, domaine 5, livraison B ; decision de Julien du 2026-10-09,
-- spec docs/superpowers/specs/2026-10-08-api-complete-design.md, section 7).
--
-- La purge anonymise le numero d une fiche : une fiche recreee ensuite avec le meme numero (import, API, message
-- entrant) repartait sans son STOP. A l effacement d une fiche en STOP (WhatsApp ou RCS), on garde ici une EMPREINTE de
-- chacun de ses identifiants (numero, BSUID), jamais l identifiant : un HMAC dont la cle vit hors de la base
-- (src/crm/refus-effaces.ts). Une empreinte simple d un numero se renverse en quelques minutes ; celle-ci non, sans la
-- cle. Une fiche recreee avec cet identifiant nait en STOP, avec la date d origine, et la ligne est consommee : le
-- refus revit sur la fiche.
--
--  - whatsapp_le : la date du STOP WhatsApp d origine (opt_out_at, ou l instant de la purge s il manquait).
--  - rcs_le : la date du STOP RCS d origine (rcs_optout_at).
--  - Au moins l un des deux : une ligne sans refus n a rien a faire ici.
--
-- Retention : trois ans depuis le STOP le plus recent (le minimum que la CNIL recommande pour respecter une opposition),
-- purgee par le balayage de retention du worker. Cascade depuis tenants : la suppression d un espace l emporte.
--
-- ORDRE : table NEUVE, que l ancien code ignore. Le code neuf la nomme dans la purge et dans les quatre insertions de
-- fiches, dont upsertFromInbound (chaque message entrant) : elle passe AVANT le up de l API et des deux workers.
-- Aucun autre index que la cle primaire : les deux seules requetes cherchent par (tenant_id, empreinte), et la purge
-- de retention balaie une table qui ne compte que les fiches effacees en STOP.
set local lock_timeout = '5s';

create table if not exists refus_effaces (
  tenant_id uuid not null references tenants(id) on delete cascade,
  empreinte text not null,
  whatsapp_le timestamptz,
  rcs_le timestamptz,
  cree_le timestamptz not null default now(),
  primary key (tenant_id, empreinte),
  constraint refus_effaces_un_refus_chk check (whatsapp_le is not null or rcs_le is not null)
);
