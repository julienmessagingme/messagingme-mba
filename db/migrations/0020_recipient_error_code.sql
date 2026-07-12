-- 0020_recipient_error_code.sql — code d'erreur Meta NUMÉRIQUE par destinataire (breakdown analytics par code).
-- Alimenté depuis les statuts webhook (errors[0].code d'un delivery 'failed') ET les échecs d'ENVOI
-- (MetaApiError.code). Nullable = pas d'erreur. Le texte reste dans error / delivery_error (inchangés).
alter table campaign_recipients
  add column if not exists error_code integer;

create index if not exists campaign_recipients_error_code_idx
  on campaign_recipients (error_code) where error_code is not null;
