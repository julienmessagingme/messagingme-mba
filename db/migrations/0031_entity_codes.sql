-- Codes publics « schéma A » (socle API, Lot 4a). Colonnes ADDITIVES : on ne touche à AUCUNE clé primaire /
-- FK / slug / clé (tenant,name) existante. Ces colonnes sont nullables (backfill applicatif ensuite, cf.
-- db/backfill-codes.ts) ; les nouvelles lignes reçoivent leur code à l'INSERT. Migration ADD-only -> ordre de
-- déploiement NORMAL (migrate d'abord, le code neuf lit ces colonnes en tolérant null tant que le backfill n'a
-- pas tourné). Index uniques PARTIELS (where ... is not null) : plusieurs null tolérés avant backfill.
alter table tenants     add column if not exists public_code text;
alter table workflows   add column if not exists code text;
alter table users       add column if not exists code text;
alter table user_fields add column if not exists code text;
alter table tags        add column if not exists code text;

create unique index if not exists tenants_public_code_key on tenants (public_code) where public_code is not null;
create unique index if not exists workflows_code_key      on workflows (code)       where code is not null;
create unique index if not exists users_code_key          on users (code)           where code is not null;
create unique index if not exists user_fields_code_key    on user_fields (code)     where code is not null;
create unique index if not exists tags_code_key           on tags (code)            where code is not null;
