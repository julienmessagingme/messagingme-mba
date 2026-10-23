-- Les limites de reponses et d'actions d'une conversation d'agent montent au maximum (decision de Julien du 2026-10-23) :
-- c'est le client qui paie son credit IA, et chaque limite se regle desormais depuis Claude (set_agent_limits) et dans
-- la console. A 8 reponses, une conversation un peu longue sortait par Plafond atteint ; 20 et 60 sont les bornes des
-- CHECK de 0086, qui ne changent pas. Une limite reste : elle arrete deux robots qui se repondraient sans fin.
--
-- Seuls les agents restes a l'ancien defaut suivent, chaque colonne pour elle-meme : une limite reglee autrement n'est
-- pas touchee. L'ancien code y survit, elle passe avant le up.
set local lock_timeout = '5s';

alter table agents alter column max_tours set default 20;

alter table agents alter column max_appels_outils set default 60;

update agents set max_tours = 20 where max_tours = 8;

update agents set max_appels_outils = 60 where max_appels_outils = 12;
