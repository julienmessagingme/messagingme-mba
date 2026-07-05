-- 0007_delivery_status.sql — suivi de livraison Meta (webhooks de statut) par destinataire.
-- `status` reste notre état de traitement interne (pending/sending/sent/failed/skipped) ;
-- `delivery_status` est le cycle de vie Meta (sent -> delivered -> read, ou failed).

alter table campaign_recipients
  add column if not exists delivery_status text
    check (delivery_status is null or delivery_status in ('sent', 'delivered', 'read', 'failed')),
  add column if not exists delivery_error text,
  add column if not exists delivery_updated_at timestamptz;

-- Lookup par message_id lors de la réception d'un webhook de statut.
create index if not exists campaign_recipients_message_id_idx
  on campaign_recipients (message_id) where message_id is not null;
