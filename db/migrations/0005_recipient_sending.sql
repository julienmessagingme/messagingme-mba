-- 0005_recipient_sending.sql — statut 'sending' pour le claim atomique des destinataires.
-- Un destinataire est claimé (pending -> sending) AVANT l'appel Meta : deux runs concurrents
-- ou un replay pg-boss ne peuvent plus le ré-envoyer (listPending ne renvoie que 'pending').

alter table campaign_recipients drop constraint if exists campaign_recipients_status_check;
alter table campaign_recipients add constraint campaign_recipients_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped'));
