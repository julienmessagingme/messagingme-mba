-- 0008_recipient_claimed_at.sql — horodatage du claim, pour récupérer les 'sending' bloqués.
-- Un 'sending' resté trop longtemps (crash entre claim et envoi) est ramené à 'pending' par
-- le sweeper du worker.

alter table campaign_recipients add column if not exists claimed_at timestamptz;
