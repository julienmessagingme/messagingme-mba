-- 0013_user_name.sql — nom d'affichage optionnel pour les comptes de la console.
-- Purement cosmétique (l'identité de login reste l'email, unique global lower(email), 0010).
-- Nullable : les comptes existants n'en ont pas.
alter table users add column if not exists name text;
