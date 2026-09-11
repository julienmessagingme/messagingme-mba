-- 0131 : les fiches du MODE D EMPLOI de la console, pour le bot d aide.
--
-- POURQUOI UNE TABLE A PART, et surtout PAS `agent_knowledge` avec un `tenant_id` nullable. Ce filtre par
-- espace est LE controle d isolation entre clients : la RLS est contournee (le pooler est superuser), donc
-- `tenant_id = $1` est le seul controle qui reste sur 235 routes. Le rendre conditionnel sur la table qui
-- porte la connaissance METIER des clients, pour y loger une donnee qui n a aucune raison d y etre, serait
-- un mauvais echange. Une table de plus ne coute rien.
--
-- ⚠️ AUCUN `tenant_id` ICI, ET C EST VOULU : le mode d emploi d Engage Me est le meme pour tout le monde.
-- C est aussi ce qui permet de mutualiser le cout d une question posee deux fois par deux clients.
--
-- ⚠️ CETTE TABLE N EST PAS LA SOURCE, ELLE EST L INDEX. La source, ce sont les fichiers de
-- `docs/aide/fiches/`, versionnes et relus en diff git. `npm run aide:charger` recopie les fichiers ici et
-- SUPPRIME les lignes dont le fichier a disparu. Une ligne effacee a la main revient donc au chargement
-- suivant, et c est le comportement voulu : sans ca, le bot continuerait de repondre avec une page effacee.
--
-- ⚠️ ELLE CREE UNE TABLE QUE LE CODE ECRIT : elle passe AVANT le deploiement.
create table if not exists aide_fiches (
  id                uuid primary key default gen_random_uuid(),
  -- Le NOM DU FICHIER sans extension. C est elle qui rend le chargement idempotent : recharger met a jour,
  -- il ne duplique pas. Unique, donc `on conflict (cle) do update` est possible.
  cle               text not null unique,
  titre             text not null,
  corps             text not null,
  -- La cle de NAV de l ecran concerne (`campagnes`, `workflows`...), JAMAIS une URL. Une URL enregistree en
  -- base vieillit en silence le jour ou une page demenage ; une cle est resolue a l affichage par la carte
  -- (`src/aide/carte.ts`), donc elle suit, et une cle inconnue est detectable par un test.
  ecran             text,
  -- La section de `features.md` dont la fiche est tiree, et l empreinte de cette section au moment de la
  -- relecture. C est ce couple qui permet de DETECTER qu une fiche est devenue perimee, sans la regenerer
  -- en silence : une regeneration automatique remplacerait un texte relu par un texte non relu.
  source_section    text,
  source_empreinte  text,
  -- Meme colonne generee et meme configuration ('french') qu en 0086 : les fiches sont ecrites en francais,
  -- et c est la langue du dictionnaire qui decide du rappel lexical.
  corps_tsv         tsvector generated always as
                      (to_tsvector('french'::regconfig, coalesce(titre,'') || ' ' || coalesce(corps,''))) stored,
  -- Memes colonnes et MEME DIMENSION qu en 0110, parce que c est le MEME modele qui vectorise
  -- (`AGENT_EMBED_MODEL`). En changer obligerait a recalculer les deux bases, pas une seule.
  embedding         vector(1536),
  embedding_modele  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists aide_fiches_tsv_idx on aide_fiches using gin (corps_tsv);
create index if not exists aide_fiches_titre_trgm_idx on aide_fiches using gin (titre gin_trgm_ops);
-- Meme index et MEME DISTANCE qu en 0110 (cosinus). En changer ici rendrait les deux recherches
-- incomparables sans qu aucune erreur ne le signale : le classement serait simplement different.
create index if not exists aide_fiches_embedding_idx
  on aide_fiches using hnsw (embedding vector_cosine_ops);
