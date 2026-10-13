-- 0230 : le second facteur des administrateurs devient un choix de l espace (decision de Julien du 2026-10-13 ; plan
-- docs/superpowers/plans/2026-10-13-ops-entreprise-second-facteur-inbox.md).
--
-- Jusqu ici, tout admin devait poser un second facteur avant d entrer. Desormais, seul un admin d un espace qui
-- l exige y est tenu (src/auth/facteur-exige.ts). Faux par defaut, espaces existants compris : un admin qui a deja
-- son facteur continue de donner son code, et peut le retirer depuis Mon compte. L exploitation n en depend pas.
-- Une colonne NOT NULL a defaut constant ne reecrit pas la table (Postgres 11 et suivants). L ancien code ne la lit
-- pas : elle passe AVANT le code qui la lit.
set local lock_timeout = '5s';

alter table tenants add column if not exists second_facteur_admins boolean not null default false;
