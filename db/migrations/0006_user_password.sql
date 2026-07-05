-- 0006_user_password.sql — mot de passe (hash scrypt) pour l'auth de la console.
-- Les comptes existent déjà (users, 0001) ; on ajoute le hash. Un user sans hash ne peut
-- pas se connecter (compte non provisionné).

alter table users add column if not exists password_hash text;
