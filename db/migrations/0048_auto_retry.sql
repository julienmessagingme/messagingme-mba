-- Auto-relance des echecs de livraison (F6). Colonnes additives (nullable/default), compatibles migrate.ts.
-- auto_retry_enabled : toggle opt-in par tenant. retry_count : nb d'auto-relances deja faites pour CE destinataire
-- (0 = jamais relance ; borne l'automatisme : 131049 relance 1x, 131026 relance 1x puis marque injoignable au 2e echec).
-- retried_at : instant de la derniere auto-relance (trace + evite un re-declenchement au meme tick).
alter table tenant_settings add column if not exists auto_retry_enabled boolean not null default false;
alter table campaign_recipients add column if not exists retry_count integer not null default 0;
alter table campaign_recipients add column if not exists retried_at timestamptz;
