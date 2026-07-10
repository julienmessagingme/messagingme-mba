-- 0014_user_disabled.sql — révocation réversible d'un compte console.
-- disabled_at NULL = actif ; non NULL = révoqué (login bloqué, mais la ligne reste, réversible).
-- La suppression définitive est un DELETE (aucune FK ne référence users, cf. migrations).
alter table users add column if not exists disabled_at timestamptz;
