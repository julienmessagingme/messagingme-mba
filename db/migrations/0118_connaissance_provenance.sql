-- 0118_connaissance_provenance.sql : d'ou vient chaque fiche de connaissance.
--
-- 🔴 LE MANQUE, DIT PAR JULIEN LE 2026-09-08. « Il faut avoir en face de chaque fiche la provenance : est-ce
-- parce qu'on a crawle a un moment le site internet ? » Aujourd'hui c'est impossible a dire : une fiche
-- issue d'un PDF joint a la conversation de construction est ecrite par le meme chemin qu'une fiche tapee a
-- la main, donc avec `source_url` a null. Les deux sont INDISCERNABLES, et l'ecran ne peut pas montrer ce
-- qu'il ne sait pas.
--
-- Deux colonnes, et une seule idee : nommer la source au lieu de la deviner de la presence d'une URL.
--
--   source_type = 'page'     -> une page web, `source_url` porte son adresse
--   source_type = 'document' -> un fichier joint, `source_nom` porte son nom
--   source_type = 'manuel'   -> ecrite a la main dans l'ecran, ni l'une ni l'autre
--
-- ⚠️ `source_url` N'EST PAS DETOURNE pour porter un nom de fichier. C'etait le raccourci tentant (il donnait
-- gratuitement le remplacement au reimport), et il a ete ecarte : mettre du non-URL dans un champ URL se
-- paie plus tard, et l'avertissement « source perimee » de l'ecran est deja branche sur ce champ. Un
-- document ne se relit pas tout seul, il n'a pas de date de peremption au meme sens.
--
-- ⚠️ Le defaut est 'manuel' et la colonne est NOT NULL : une fiche sans provenance connue est une fiche
-- ecrite a la main, ce qui est vrai de toutes celles qui existent et dont l'URL est nulle. Un defaut nul
-- aurait laisse un troisieme etat (« on ne sait pas ») que l'ecran aurait du afficher sans rien pouvoir en
-- dire.
--
-- IDEMPOTENTE : `if not exists` sur les colonnes, et la reprise ne reecrit que ce qui differe.

alter table agent_knowledge
  add column if not exists source_type text not null default 'manuel';

alter table agent_knowledge
  add column if not exists source_nom text;

-- La contrainte est posee APRES la reprise ci-dessous : sur une table deja remplie, un `check` ajoute avant
-- la mise a jour echouerait sur les lignes existantes.
update agent_knowledge
   set source_type = 'page'
 where source_url is not null and source_type <> 'page';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_knowledge_source_type_chk') then
    alter table agent_knowledge
      add constraint agent_knowledge_source_type_chk
      check (source_type in ('page', 'document', 'manuel'));
  end if;
end $$;

-- Le remplacement d'une source lit sur (tenant, agent, type, reference). Sans cet index, chaque reimport
-- balaie toutes les fiches de l'espace pour trouver les siennes.
create index if not exists agent_knowledge_source_idx
  on agent_knowledge (tenant_id, agent_id, source_type, source_url, source_nom);
