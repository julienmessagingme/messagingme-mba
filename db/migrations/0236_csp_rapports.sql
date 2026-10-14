-- 0236 : les rapports de violation de la CSP de la console (lot 6 du bilan des audits, livraison B3 ; plan
-- docs/superpowers/plans/2026-10-14-lot6-collecteur-csp.md).
--
--  - csp_rapports : ce que les vrais navigateurs signalent sur la console, AGREGE : une ligne par regle violee, origine
--    bloquee, page et disposition, avec un compteur et les deux dates. La console est en observation (Report-Only) :
--    ces lignes disent ce que la politique interdirait une fois passee en blocage. Aucune donnee d espace ni de
--    personne : la page est un chemin sans requete ni identifiant, l origine bloquee n est qu une origine ou un
--    mot-cle. La route borne le nombre de lignes ; la table se vide a la main apres la bascule.
--
-- ELLE AJOUTE SEULEMENT, DONC AVANT LE UP : l ancien code ne la lit pas et y survit.
set local lock_timeout = '5s';

create table if not exists csp_rapports (
  directive   text not null constraint csp_rapports_directive_chk check (char_length(directive) between 1 and 64),
  bloque      text not null constraint csp_rapports_bloque_chk check (char_length(bloque) between 1 and 200),
  page        text not null constraint csp_rapports_page_chk check (char_length(page) between 1 and 200),
  disposition text not null constraint csp_rapports_disposition_chk check (disposition in ('report', 'enforce')),
  compte      integer not null default 1,
  premier_vu  timestamptz not null default now(),
  dernier_vu  timestamptz not null default now(),
  primary key (directive, bloque, page, disposition)
);
