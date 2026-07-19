-- 0038_campaign_archive.sql — archivage RÉVERSIBLE d'une campagne.
--
-- `archived_at` NULL = active ; non NULL = archivée, masquée de la liste par défaut. La ligne ET ses
-- destinataires RESTENT en base : ils portent l'historique qui alimente les analytics (funnel, coût, erreurs).
-- Les requêtes de stats ne filtrent donc JAMAIS sur cette colonne : archiver ne doit rien changer aux chiffres.
--
-- Colonne ORTHOGONALE au statut, même sémantique que `users.disabled_at`. Surtout PAS un 7e statut :
-- 'archived' écraserait le statut d'origine (on ne saurait plus si la campagne était completed ou failed),
-- rendrait l'archivage irréversible en pratique, et casserait les requêtes qui filtrent sur `status in (...)`,
-- à savoir le garde-fou `listActiveCampaignsForTemplate` et le sweeper de programmation.
--
-- ADD-only. Migrer AVANT de déployer le code neuf.
alter table campaigns add column if not exists archived_at timestamptz;

-- La liste par défaut filtre `archived_at is null` : index partiel, il n'a pas à porter les archivées.
create index if not exists campaigns_active_idx
  on campaigns (tenant_id, created_at desc) where archived_at is null;
