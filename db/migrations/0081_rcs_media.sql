-- 0081 : les visuels des messages RCS, heberges par nous.
--
-- Pourquoi cette table existe. Un message RCS a visuel exige une URL PUBLIQUE que l'operateur va chercher
-- lui-meme : ni un identifiant Meta (ce que rend deja /media, inutilisable ici), ni un fichier joint. Sans
-- hebergement, un client doit trouver un webmaster pour poser son image quelque part, ce qui suffit a rendre
-- la fonctionnalite inutilisable pour celui a qui elle sert.
--
-- Pourquoi les OCTETS en base plutot qu'un volume ou un service de stockage. Un volume Docker ne survit pas a
-- une recreation de conteneur sans declaration explicite, et n'est sauvegarde nulle part ; un bucket ajoute un
-- service, des cles et un mode de panne de plus. Ici le volume est minuscule (quelques visuels par client,
-- 2 Mo maximum chacun, borne applicative), il suit la base dans toute restauration, et il se supprime avec le
-- tenant. Si le volume grossit un jour au point de peser, deplacer le stockage ne changera que ce fichier et
-- `media-store.pg.ts` : l'URL publique, elle, ne bouge pas.
--
-- `code` EST l'adresse : la route de lecture est publique et non authentifiee (c'est l'operateur telecom qui
-- telecharge l'image, il n'a aucune session). 26 caracteres base32 = 130 bits, comme le code d'un webhook
-- entrant, et pour la meme raison : ce n'est pas un identifiant, c'est ce qui donne acces au fichier.
--
-- `mime` est le type REEL, deduit de la signature du fichier a l'ecriture, jamais celui que le navigateur a
-- declare. C'est lui qui sera rendu en `Content-Type`.
create table if not exists rcs_media (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  code       text not null,
  mime       text not null check (mime in ('image/jpeg', 'image/png', 'image/gif')),
  bytes      bytea not null,
  taille     integer not null,
  -- Nom du fichier tel que televerse : sert UNIQUEMENT a s'y retrouver dans la mediatheque. Il n'apparait
  -- jamais dans l'URL publique, qui ne porte que le code : un nom de fichier en dit trop (client, campagne).
  nom        text,
  created_at timestamptz not null default now()
);

-- Unique GLOBALEMENT : le code porte le fichier a lui seul sur la route publique, sans tenant dans l'URL.
create unique index if not exists rcs_media_code_unique on rcs_media (code);
-- Mediatheque d'un workspace, du plus recent au plus ancien.
create index if not exists rcs_media_tenant_idx on rcs_media (tenant_id, created_at desc);
