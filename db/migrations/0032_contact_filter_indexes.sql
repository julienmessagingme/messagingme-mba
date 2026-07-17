-- Lot 8 Phase 2 : index pour la « Liste de contacts » requêtable (source de campagne).
-- La recherche nom (ilike) et les filtres de valeur de champ perso (fields ->> key) faisaient un seq scan.
-- Table petite aujourd'hui (mono-tenant pilote) donc index simple acceptable ; ces index évitent la
-- dégradation quand le volume de contacts monte. Rien de bloquant : ADD only, aucune colonne touchée.
--
-- Note montée en charge : sur une grosse table, créer ces index en CREATE INDEX CONCURRENTLY (hors
-- transaction de migration) pour ne pas verrouiller. Ici (petite table) l'index en ligne est indolore.

create extension if not exists pg_trgm;

-- Recherche nom insensible à la casse et par sous-chaîne (nameSearch -> profile_name ilike '%x%').
create index if not exists contacts_profile_name_trgm on contacts using gin (profile_name gin_trgm_ops);

-- Filtres sur les valeurs de champ perso (fieldFilters -> fields ->> key = / ilike). GIN jsonb generic :
-- accélère les accès par clé du jsonb `fields`.
create index if not exists contacts_fields_gin on contacts using gin (fields);
