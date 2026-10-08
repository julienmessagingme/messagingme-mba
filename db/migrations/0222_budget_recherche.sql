-- Lot 6, livraison C (rouge de la relecture, decision de Julien du 2026-10-08) : le budget par conversation d'un agent
-- passe de 0,03 euro a 0,07 euro.
--
-- La recherche dans la connaissance (le vecteur de la question et le reranker, environ 0,28 centime en Base) entre
-- desormais dans le cout du tour, donc dans ce budget. A 0,03 euro, un agent qui cherche a chaque appel se taisait
-- (Plafond atteint) bien plus tot qu'avant. 0,07 euro laisse au modele la place d'avant, plus les 12 appels d'outils
-- permis par defaut, tous en recherche, au tarif de la Base.
--
-- Seuls les agents restes au defaut d'avant suivent : un budget regle autrement n'est pas touche. L'ancien code y
-- survit (il lit la colonne telle quelle) : elle passe AVANT le up, avec 0221.
set local lock_timeout = '5s';

alter table agents alter column budget_micro_eur set default 70000;

update agents set budget_micro_eur = 70000 where budget_micro_eur = 30000;
