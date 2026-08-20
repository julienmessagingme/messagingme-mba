-- 0067 : quand l'agent de Meta passe-t-il la main à un humain ?
--
-- Trois valeurs, qui sont les trois choix de l'écran « Activation » (MBA > Paramètres) :
--   'always'         : l'agent passe la main, la conversation remonte dans « À traiter » ;
--   'business_hours' : seulement pendant les heures d'ouverture du tenant (`business_hours`, migration 0050) ;
--   'never'          : l'agent ne lâche jamais le fil.
--
-- Ce réglage pilote `handoff.enabled` chez Meta, PAS le passage de main lui-même : l'agent décide seul de
-- transférer (« je veux parler à un conseiller »), et `enabled` dit seulement s'il LÂCHE le fil ensuite.
-- C'est pourquoi 'never' s'accompagne toujours d'un message qui ne promet aucun conseiller : sans cela, le
-- client lirait « un conseiller arrive » alors que personne n'est prévenu.
--
-- null = jamais réglé. L'écran affiche alors le défaut usine ('always'), et RIEN n'est écrit chez Meta tant
-- que le client n'a pas choisi : on ne modifie pas la configuration d'un agent sans décision explicite.
--
-- Migration ADDITIVE : à appliquer AVANT le déploiement du code.
alter table tenant_settings
  add column if not exists mba_handoff_mode text
    check (mba_handoff_mode is null or mba_handoff_mode in ('always', 'business_hours', 'never'));
