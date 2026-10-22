-- Le budget par conversation d'un agent n'a plus de limite par defaut (decision de Julien du 2026-10-22) : c'est le
-- client qui paie son credit IA, et nous margeons dessus. A 0,07 euro, la Free passee a 100 % de commission le meme
-- jour aurait coupe ses conversations environ 25 % plus tot (Plafond atteint).
--
-- 100 euros (100000000 micro-euros) est le maximum que la fiche accepte (src/agent/gestion.ts) : autant dire aucune
-- limite, puisque les tours et les appels d'outils permis bornent deja une conversation bien en dessous. Le solde
-- prepaye reste la vraie limite. Une valeur plutot qu'un nul : le code lit un nombre, et rien n'a a changer.
--
-- Seuls les agents restes au defaut d'avant (0222) suivent : un budget regle autrement n'est pas touche. L'ancien code
-- y survit, elle peut passer avant le up.
set local lock_timeout = '5s';

alter table agents alter column budget_micro_eur set default 100000000;

update agents set budget_micro_eur = 100000000 where budget_micro_eur = 70000;
