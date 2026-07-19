-- 0037_user_last_login.sql — horodatage de la dernière CONNEXION réussie d'un compte console.
-- Écrit au login (mot de passe ET Google), best-effort : une panne d'écriture ne fait jamais échouer un login.
-- Nullable, SANS backfill : un compte qui ne s'est pas reconnecté depuis cette migration affiche « jamais ».
-- On ne retombe surtout PAS sur created_at, ce serait présenter une date d'inscription comme une connexion.
-- ADD-only. Migrer AVANT de déployer le code neuf (le store lit la colonne).
alter table users add column if not exists last_login_at timestamptz;
