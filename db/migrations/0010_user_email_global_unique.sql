-- Login = un email = un compte : unicité GLOBALE et insensible à la casse.
-- Remplace l'unicité par-tenant (tenant_id, email) comme source de vérité du login
-- (elle reste en place, redondante mais inoffensive). Rend findByEmail déterministe :
-- plus de « même email dans deux tenants » à départager par ORDER BY.
create unique index if not exists users_email_lower_unique on users (lower(email));
