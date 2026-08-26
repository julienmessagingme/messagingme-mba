-- 0085 : l'echeance << pas de reponse >> d'un bloc Question.
--
-- Le bloc Question attend DEUX choses a la fois, ce qu'aucun autre bloc ne fait : une reponse du contact, et
-- le temps qui passe. Son run reste donc `waiting` (sans quoi `findWaitingByWaId` ne le verrait plus et la
-- reponse du contact serait perdue) tout en portant un `resume_at`, que le balayeur de reveil consomme.
--
-- AUCUNE colonne nouvelle : `resume_at` existe depuis la migration 0054 (bloc Attente) et n'etait jusqu'ici
-- pose que sur des runs `sleeping`. Ce qui manque, c'est l'INDEX : la requete de reclamation filtre desormais
-- sur `status = 'waiting' and resume_at is not null`, et l'index partiel de 0054 ne couvre que `sleeping`.
-- Sans lui, chaque passage du balayeur (toutes les 60 s) balaierait toute la table des runs en attente.
--
-- Partiel sur `resume_at is not null` : l'ecrasante majorite des runs `waiting` n'ont aucune echeance (un
-- template ou un message rapide a boutons attend sans limite). L'index ne porte donc que les questions
-- reellement en cours, et reste minuscule.
create index if not exists workflow_runs_question_timeout_idx
  on workflow_runs (resume_at) where status = 'waiting' and resume_at is not null;
