-- 0041_control_handback_delay.sql : combien de temps une conversation reste GELÉE après qu'un opérateur
-- a pris la main, avant de repartir toute seule.
--
-- Pendant ce gel, personne d'autre n'écrit au client : ni le scénario, ni (demain) l'agent de Meta. C'est
-- le temps qu'on laisse à l'humain pour traiter son sujet tranquillement.
--
-- Réglage PAR CLIENT et non global : c'est un arbitrage métier qui dépend de la façon dont chacun
-- travaille. Un service client avec des opérateurs en continu voudra 30 minutes ; un artisan qui répond
-- entre deux chantiers voudra une demi-journée. Le mettre en variable d'environnement obligeait à trancher
-- pour tout le monde à la fois, et seul l'éditeur pouvait le changer.
--
-- NULL = le client n'a rien réglé, on applique le défaut du serveur (CONTROL_HUMAN_TIMEOUT_MS).
-- 0 = jamais de reprise automatique : la conversation reste à l'humain tant qu'il ne la rend pas
-- explicitement. C'est un choix légitime (certains veulent la main définitive), mais il fait porter la
-- responsabilité de rendre la main à l'opérateur, d'où la borne basse à 0 et pas de valeur négative.
--
-- ADD-only, nullable, sans backfill : les clients existants gardent le comportement actuel.
alter table tenant_settings
  add column if not exists control_handback_seconds integer
    check (control_handback_seconds is null or control_handback_seconds >= 0);
