-- Suppression douce des contacts (mini-CRM, action en masse « Supprimer »). Colonne additive nullable,
-- compatible migrate.ts. deleted_at non nul = contact supprime : masque des listes/filtres CRM ET non
-- selectionnable comme destinataire de campagne (le WHERE de contact-store ajoute `deleted_at is null`).
-- Reversible en base (remettre deleted_at a null), et l'historique de campagnes (campaign_recipients) est
-- PRESERVE contrairement a un DELETE en cascade.
alter table contacts add column if not exists deleted_at timestamptz;

-- Index partiel sur les contacts ACTIFS : la quasi-totalite des lectures CRM filtrent `deleted_at is null`
-- et trient par created_at desc. Accelere list/query/count/ids sans alourdir les rares lignes supprimees.
create index if not exists idx_contacts_active
  on contacts (tenant_id, created_at desc) where deleted_at is null;
