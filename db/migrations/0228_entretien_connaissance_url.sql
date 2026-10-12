-- 0228 : l adresse du site donnee pendant l entretien de construction d un agent IA (decision de Julien du 2026-10-12).
--
-- L entretien la demande au point connaissance, et la route la garde dans l etat du tour (connaissanceUrl), mais
-- PgEntretienStore n avait aucune colonne pour elle : elle se perdait a l enregistrement, des le tour suivant. Le bloc
-- « Pour finir » ne pouvait donc pas dire « importez les pages de https://... », ni la console proposer l import du
-- site donne.
--
-- Nullable SANS defaut : absente et vide ne disent pas la meme chose, et un defaut l ecrirait sur chaque entretien
-- existant. Aucun index : on la lit avec la ligne, par sa cle primaire.
--
-- ORDRE : colonne neuve que l ancien code ignore. Le code neuf la nomme dans la lecture de chaque tour de l assistant
-- de construction (un select qui la cite rendrait 42703 sans elle) : elle passe AVANT le up de l API.
set local lock_timeout = '5s';

alter table agent_setup_conversations add column if not exists connaissance_url text;
