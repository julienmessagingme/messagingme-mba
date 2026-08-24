-- 0083 : garder le DERNIER rappel recu du fournisseur RCS, par agent.
--
-- 🔴 Lecon du 2026-08-24. Un rappel smsmode est arrive, notre lecture l'a rejete, et la seule trace etait une
-- ligne de log disant << non exploitable >> SANS le corps. Impossible de savoir ce qu'ils avaient envoye :
-- il aurait fallu redeployer une version qui journalise, puis demander a quelqu'un de recliquer.
--
-- On garde donc le dernier corps recu, exactement comme `webhooks.last_payload` pour les webhooks entrants
-- (0074) : c'est ce qui permet de construire le mapping ET de comprendre << pourquoi rien ne se passe >>.
--
-- Contient de la donnee tierce, donc potentiellement personnelle (un numero, le texte d'une reponse) : un
-- SEUL corps conserve a la fois, ecrase au suivant, et efface avec l'agent.
alter table rcs_agents add column if not exists last_callback jsonb;
alter table rcs_agents add column if not exists last_callback_at timestamptz;
