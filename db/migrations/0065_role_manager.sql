-- 0065 : troisième statut de membre, « manager ».
--
-- La contrainte de 0001 n'admettait que deux rôles. Sans cette migration, attribuer « manager » remonte une
-- 23514 depuis la base : l'API validait la valeur, et la base la refusait.
--
-- ⚠️ Le statut n'accorde AUCUN droit nouveau. Toutes les routes réservées le sont à `admin`
-- (`makeRequireRole(['admin'])` sur les groupes, `forbidNonAdmin` dans les handlers) : un manager a donc les
-- accès d'un agent, l'inbox. Ce qu'un manager aura le droit de faire se décidera écriture par écriture.
--
-- Migration ADDITIVE (elle élargit un domaine) : à appliquer AVANT le déploiement du code. Aucune ligne
-- existante ne peut la violer, puisque l'ancien domaine est inclus dans le nouveau.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'manager', 'agent'));
