-- Tags libres sur les contacts (segmentation : "salon-2026", "prospect", ...).
-- Array de texte + index GIN pour requêter par tag (tags @> array['x']).
alter table contacts add column if not exists tags text[] not null default '{}';
create index if not exists contacts_tags_gin on contacts using gin (tags);
