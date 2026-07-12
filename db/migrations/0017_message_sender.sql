-- 0017_message_sender.sql — auteur d'un message sortant de l'inbox (pastille initiales).
-- Nullable : les rows 'out' legacy (avant cette colonne) et les futures réponses auto de l'agent MBA
-- n'ont pas d'auteur -> repli neutre côté UI. on delete set null : supprimer un user n'efface pas l'historique.
alter table conversation_messages
  add column if not exists sender_user_id uuid references users(id) on delete set null;
