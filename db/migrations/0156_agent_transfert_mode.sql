-- 0156 : quand un agent IA passe la main, l'équipe est-elle joignable ?
--
-- Trois valeurs, LES MÊMES que `mba_handoff_mode` (migration 0067), et ce n'est pas de la paresse : cet
-- écran montre les deux agents côte à côte, et deux vocabulaires voisins pour la même question seraient
-- impossibles à rapprocher.
--   'always'         : l'agent passe la main et annonce un conseiller, comme il le fait depuis toujours ;
--   'business_hours' : seulement pendant les heures d'ouverture de l'espace (`business_hours`, 0050) ;
--   'never'          : l'équipe ne reprend jamais le fil en direct.
--
-- 🔴 CE RÉGLAGE NE DÉCIDE PAS SI ON TRANSFÈRE. La conversation arrive dans « À traiter » dans TOUS les cas
-- (arbitrage de Julien, 2026-09-18) : une phrase « nous revenons vers vous » sans ligne de travail derrière
-- est un mensonge poli. Ce qui change, c'est ce que l'agent a le droit de PROMETTRE au contact.
--
-- 🔴 POURQUOI UNE COLONNE À PART, ET PAS `mba_handoff_mode` RÉUTILISÉE. Celle-là pilote `handoff.enabled`
-- CHEZ META, c'est-à-dire la configuration d'un agent que nous ne possédons pas. Les confondre ferait
-- reconfigurer l'agent de Meta quand le client règle son agent IA, et l'inverse.
--
-- null = jamais réglé. Le code lit alors 'always', c'est-à-dire le comportement d'aujourd'hui : cette
-- migration ne change RIEN pour personne tant que le client n'a pas choisi.
--
-- Migration ADDITIVE, d'une colonne que le code ÉCRIT : à appliquer AVANT le déploiement.
alter table tenant_settings
  add column if not exists agent_transfert_mode text
    check (agent_transfert_mode is null or agent_transfert_mode in ('always', 'business_hours', 'never'));
