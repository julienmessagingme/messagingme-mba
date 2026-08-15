-- 0054_workflow_wait.sql : bloc « Attente » dans un scénario.
--
-- Un parcours peut désormais dormir jusqu'à une échéance, en plus d'attendre une réponse du contact :
--   waiting  = attend que le CONTACT réponde (inchangé)
--   sleeping = attend que le TEMPS passe (nouveau), `resume_at` porte l'échéance
-- Le sweeper du worker réveille les runs dus. Le claim se fait en une seule requête
-- (`update ... where status='sleeping' and resume_at <= now() returning`), donc un run n'est repris
-- qu'UNE fois même avec plusieurs workers.

alter table workflow_runs add column if not exists resume_at timestamptz;

-- Le CHECK d'origine (0023) ne connaît pas 'sleeping' : il faut le remplacer, pas en ajouter un second.
-- Nom généré par Postgres en 0023 (contrainte inline) : <table>_<colonne>_check.
alter table workflow_runs drop constraint if exists workflow_runs_status_check;
alter table workflow_runs add constraint workflow_runs_status_check
  check (status in ('waiting', 'inbox', 'done', 'sleeping'));

-- Index du réveil : le sweeper ne lit QUE les runs dormants dus. Partiel -> il reste minuscule même avec
-- beaucoup de runs terminés.
create index if not exists workflow_runs_sleeping_idx
  on workflow_runs (resume_at)
  where status = 'sleeping';

comment on column workflow_runs.resume_at is
  'Échéance de reprise d''un run en sommeil (bloc Attente). NULL hors statut sleeping.';
