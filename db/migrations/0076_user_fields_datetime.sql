-- 0076 : autoriser le type `datetime` sur un champ perso.
--
-- 🔴 BUG DE FOND, constate en production le 2026-08-24 : creer un champ << date et heure >> rendait
-- << Internal error >>, par TOUS les chemins (ecran Contenu > Champs, creation a la volee depuis le mapping
-- d un webhook, API publique, import CSV).
--
-- La cause : `datetime` a ete ajoute a `USER_FIELD_TYPES` (src/crm/fields.ts) et au menu de l ecran, mais la
-- contrainte CHECK posee par la migration 0002 ne l a jamais connu. L insertion violait donc la contrainte,
-- l erreur Postgres remontait en 500, et Cloudflare remplacait le corps : l utilisateur ne voyait qu un
-- << Internal error >> sans rapport visible avec ce qu il faisait.
--
-- Autrement dit, ce type etait PROPOSE dans l interface sans avoir jamais ete creable. Le declencheur
-- << X avant une date >> (migration 0075) en depend entierement : sans ce correctif, il n a aucun champ sur
-- lequel se regler.
--
-- ELARGISSEMENT PUR : toutes les valeurs deja en base restent valides, la contrainte ne fait qu accepter une
-- valeur de plus. Aucune ligne a reprendre.
alter table user_fields drop constraint if exists user_fields_type_check;
alter table user_fields add constraint user_fields_type_check
  check (type in ('text', 'number', 'date', 'datetime', 'boolean', 'url'));
