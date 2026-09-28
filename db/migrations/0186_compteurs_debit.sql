-- 0186_compteurs_debit.sql : les compteurs des plafonds de débit, partagés par toutes les copies de l'API.
--
-- POURQUOI. Chaque plafond de débit comptait dans la mémoire de son processus : N copies de l'API servaient N fois
-- chaque plafond (l'API publique par espace, les opérations coûteuses, les tentatives de connexion), et /ops ne
-- voyait que la copie qu'il interrogeait. Le compte vit ici, une ligne par clé et par fenêtre.
--
-- LA FENÊTRE est fixe et alignée sur l'heure de la BASE (début = plancher de maintenant / durée, multiplié par la
-- durée) : toutes les copies écrivent dans la même ligne, quelle que soit leur horloge.
--
-- UN APPEL COMPTÉ est une seule instruction : insert ... on conflict (cle, fenetre) do update set n = n + pas
-- where n + pas <= plafond returning n. Deux appels simultanés se sérialisent sur la ligne, le compte est exact ;
-- un appel refusé n'ajoute rien.
--
-- L'ÉCHÉANCE dit quand la ligne ne sert plus : fin de sa fenêtre, plus la conservation que son compteur demande
-- (deux heures pour l'usage de l'API publique, que /ops montre). Le worker efface les lignes échues.
--
-- AUCUN INDEX sur l'échéance, délibérément : seule la purge la lit sans la clé, et un index serait payé à chaque
-- appel compté.
--
-- ADDITIVE (une table neuve que l'ancien code ignore) : elle passe AVANT le déploiement du code qui l'écrit.
create table if not exists compteurs_debit (
  cle       text not null,
  fenetre   timestamptz not null,
  n         integer not null,
  expire_le timestamptz not null,
  primary key (cle, fenetre)
);
