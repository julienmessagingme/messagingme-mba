-- 0021_flow_cta.sql — libellé personnalisable du bouton final (Footer) d'un WhatsApp Flow.
-- null = défaut « Envoyer ». Réécrit dans le flow_json à la création/édition du flow.
alter table flows
  add column if not exists cta text;
