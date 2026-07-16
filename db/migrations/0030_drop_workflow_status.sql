-- Drop de la colonne workflows.status : devenue inutile. Le statut brouillon/actif d'un scénario était 100%
-- cosmétique (jamais lu pour gater l'exécution ni le lancement de campagne, aucune UI pour passer en « actif »).
-- L'auto-save remplace le bouton « Enregistrer », il n'y a plus de notion de statut de scénario.
-- ORDRE CRITIQUE : le code qui a cessé de lire/écrire cette colonne est déployé AVANT cette migration.
alter table workflows drop column if exists status;
