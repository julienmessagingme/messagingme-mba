-- 0202 : LE BATTEMENT DU WORKER PASSE D'UNE LIGNE UNIQUE À UNE LIGNE PAR RÔLE (lot du double worker,
-- docs/superpowers/plans/2026-10-02-deux-workers-et-banc-deux-api.md).
--
-- Elle n'ajoute AUCUNE colonne : `worker_heartbeat.id` était déjà une clé primaire, écrite en dur à 'worker'.
-- Le code neuf y écrit le RÔLE (`principal`, `analyse`, ou `all` pour un worker unique). Ce qui reste, et c'est
-- tout ce que fait ce fichier, c'est l'ANCIENNE ligne : plus personne ne l'écrit une fois les rôles posés, elle
-- vieillit, et /ops l'afficherait comme un worker MORT, c'est-à-dire une fausse alerte permanente.
--
-- 🔴 APRÈS LE `up`, JAMAIS AVANT, et c'est l'inverse de la routine. L'ancien worker réécrit cette ligne à chaque
-- battement (toutes les 20 s) : effacée avant le déploiement, elle reviendrait vingt secondes plus tard, puis
-- resterait périmée pour toujours, cette migration étant déjà marquée appliquée. La séquence est donc build,
-- `up -d --build`, PUIS `migrate`. C'est le cas que `CLAUDE.md` décrit pour une migration qui RETIRE : la
-- question n'est pas « ajoute ou retire » mais « l'ancien code survit-il ? », et ici il annulerait l'effacement.
--
-- ⚠️ IDEMPOTENTE ET SANS EFFET SI ELLE NE TROUVE RIEN : une base neuve (CI, banc) n'a jamais eu de ligne 'worker'.

delete from worker_heartbeat where id = 'worker';
