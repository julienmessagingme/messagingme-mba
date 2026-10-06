-- 0212 : le numero fourni cote client (lot 3b, spec docs/superpowers/specs/2026-10-05-numero-fourni-design.md).
--
--  - tenants.origine : d'ou est ne l'espace. claude_code quand il nait par la connexion OAuth de Claude Code,
--    console sinon. Le credit offert au premier numero verifie en depend (1 EUR contre 5 EUR, decision de Julien du
--    2026-10-05). Fixee a la creation, jamais recalculee. AUCUNE REPRISE, deliberement : les espaces existants restent
--    console, aucun n'a ete marque a sa naissance et une origine devinee serait inventee.
--  - numeros_fournis : le statut bloque, pour un numero que Meta refuse (deja actif sur WhatsApp ailleurs, un numero
--    DIDWW recycle). Il sort de la reserve sans etre resilie chez DIDWW, pour que Julien decide. Le CHECK porte le nom
--    que 0210 a pose dans son create table : un nom a cote laisserait l'ancien en place et refuserait bloque.
--  - numeros_fournis_un_par_espace : un seul numero attribue par espace. C'est lui qui tient deux demandes simultanees
--    du meme espace (double clic, deux onglets) : la seconde echoue en 23505 et relit la premiere.
--
-- 🔴 ELLE AJOUTE ET RELACHE, DONC AVANT LE UP de l'API et des deux workers : le code neuf lit tenants.origine a
-- chaque credit offert et ecrit bloque. L'ancien code ignore la colonne (defaut console) et n'ecrit jamais bloque.
--
-- ⚠️ LE VERROU : add column avec un defaut constant ne reecrit pas la table, mais add constraint relit tenants sous un
-- ACCESS EXCLUSIVE bref (quelques centaines de lignes). Lire pg_stat_activity avant ; lock_timeout pour echouer au
-- bout de 5 s au lieu de faire attendre chaque requete qui lit un espace.
set local lock_timeout = '5s';

alter table tenants add column if not exists origine text not null default 'console';
alter table tenants drop constraint if exists tenants_origine_chk;
alter table tenants add constraint tenants_origine_chk check (origine in ('console', 'claude_code'));

alter table numeros_fournis drop constraint if exists numeros_fournis_statut_chk;
alter table numeros_fournis add constraint numeros_fournis_statut_chk
  check (statut in ('libre', 'attribue', 'resilie', 'bloque'));

create unique index if not exists numeros_fournis_un_par_espace on numeros_fournis (tenant_id) where statut = 'attribue';
