-- Destination d'un fil après une prise en main opérateur, au moment où le sweep de handback (0041) voudrait
-- le rendre au scénario (C.4). Deux niveaux :
--   tenant_settings.return_behavior : défaut du client. null = pas de choix explicite -> repli 'resume'.
--   conversations.return_behavior    : surcharge d'UN fil, prime sur le défaut tenant. null = suit le défaut.
-- Valeurs : 'resume' = rendu au scénario (comportement historique) ; 'inbox' = reste à l'humain, visible dans
-- « À traiter », jamais rendu automatiquement (l'opérateur le rend via « Rendre la main »). Validé au niveau
-- route/store (pas de CHECK en base, cohérent avec timezone/business_hours en 0050). Colonnes additives
-- nullables, compatibles migrate.ts (idempotent).
alter table tenant_settings add column if not exists return_behavior text;
alter table conversations   add column if not exists return_behavior text;
