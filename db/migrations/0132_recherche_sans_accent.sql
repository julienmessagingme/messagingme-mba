-- 0132 : la recherche plein texte cesse d etre SOURDE aux mots sans accent.
--
-- 🔴 CE QUI A ETE MESURE, LE 2026-09-11, SUR LE CORPUS REEL D UN CLIENT. `to_tsvector('french','prévoyance')`
-- rend le lexeme 'prévoi' ; `to_tsvector('french','prevoyance')` rend 'prevoi'. Les deux ne se rencontrent
-- JAMAIS. Sur les 10 fiches de l agent Gan Prevoyance : « prévoyance » trouvait 3 fiches, « prevoyance » en
-- trouvait ZERO. C est une demi-cecite systematique sur un corpus francais, et les gens tapent sans accents,
-- surtout au telephone.
--
-- 🔴 ET ELLE ETAIT JUSTIFIEE PAR ECRIT. `termesDeRecherche` portait « LES ACCENTS SONT CONSERVES [...] les
-- retirer cote requete casserait le rapprochement au lieu de l elargir ». L observation etait exacte et la
-- conclusion fausse : retirer les accents d UN SEUL cote casse, les retirer des DEUX repare. Une justification
-- a moitie vraie est plus dangereuse qu aucune, elle a l air verifiee.
--
-- 🔴 POURQUOI ON N A RIEN VU. La recherche est HYBRIDE : la moitie semantique (pgvector) rattrapait souvent,
-- donc le defaut se presentait comme « l agent sait parfois, et parfois pas ». Julien l a signale le
-- 2026-09-11 sous une autre hypothese (« le bac a sable n actionne pas les outils »), qui s est revelee
-- fausse : les essais enregistres montrent l outil appele les trois fois. Ce qui changeait etait la question.
--
-- CE QUE FAIT LA MIGRATION : une configuration de recherche qui passe par le dictionnaire `unaccent` AVANT
-- le radicaliseur francais, et les deux colonnes generees reconstruites dessus. Apres coup, « prevoyance » et
-- « prévoyance » rendent le MEME lexeme 'prevoi'.
--
-- ⚠️ ELLE PASSE AVANT LE DEPLOIEMENT, parce que le code neuf INTERROGE `french_sans_accent` : sans elle, il
-- leverait a chaque recherche. La question posee a chaque migration (« l ancien code survit-il ? ») a une
-- reponse nuancee ici, et il faut la dire : pendant la duree du deploiement, l ancien code interroge encore
-- en `french` sur une colonne devenue `french_sans_accent`, donc ses requetes ACCENTUEES cessent de matcher
-- pendant que ses requetes SANS accent se mettent a marcher. C est un ECHANGE, pas une perte, il dure le
-- temps d un `up -d --build`, il ne touche que la moitie lexicale (la moitie semantique est intacte), et il
-- porte aujourd hui sur 10 fiches chez un client. Le refuser aurait demande une colonne de transition pour
-- un gain de deux minutes.
--
-- ⚠️ `unaccent` EST UN DICTIONNAIRE, PAS UNE FONCTION APPELEE DANS LA COLONNE. C est ce qui rend la chose
-- possible : la fonction `unaccent(text)` est STABLE, donc interdite dans une colonne generee, alors que
-- `to_tsvector(regconfig, text)` avec un cast EXPLICITE est IMMUTABLE quelle que soit la configuration
-- nommee. C est deja la raison du cast `::regconfig` de la migration 0086, et on s en sert ici.
--
-- ⚠️ CE QU ELLE NE REPARE PAS, ET C EST DELIBERE : la proximite de TITRE, calculee par `similarity()` de
-- pg_trgm, reste sensible aux accents. Elle a son propre contrat, l index trigramme `..._titre_trgm_idx`,
-- qui porte sur `titre` BRUT : envelopper la colonne dans `unaccent()` cote requete sortirait de cet index
-- sans autre symptome qu un plan d execution different, c est-a-dire exactement le piege que ce depot a deja
-- paye deux fois. Les trigrammes degradent d ailleurs proprement, un accent en moins ne coute qu un peu de
-- score. La reparation s arrete donc au plein texte, et le dire ici evite de croire les accents regles
-- partout.
--
-- REPETEE EN VRAI AVANT D ETRE ECRITE : jouee entierement dans une transaction ANNULEE sur la base de
-- production, extension comprise. Verdict mesure : « prevoyance » passe de 0 a 4 fiches, « prévoyance » de
-- 3 a 4, et les deux rendent exactement le meme resultat.

-- ⚠️ SANS `with schema`, DONC DANS `public`, ET C EST DELIBERE. Deux raisons : c est deja la ou vivent
-- `pg_trgm` et `vector` sur cette base (mesure), et surtout le Postgres jetable de la CI n a pas de schema
-- `extensions`. Le nommer ferait echouer la migration en integration, c est-a-dire au seul endroit qui la
-- joue avant la production. La resolution de `unaccent` ci-dessous se fait par le search_path, ou `public`
-- est toujours present.
create extension if not exists unaccent;

-- Idempotent a la main : `create text search configuration` n a pas de `if not exists`, et un `drop` en tete
-- echouerait des qu une colonne generee en depend (c est-a-dire des la premiere execution reussie).
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'french_sans_accent') then
    create text search configuration french_sans_accent (copy = french);
    alter text search configuration french_sans_accent
      alter mapping for hword, hword_part, word with unaccent, french_stem;
  end if;
end
$$;

-- Les deux corpus, et il n y en a que deux : `agent_knowledge` (0086) et `aide_fiches` (0131). Un troisieme
-- qui naitrait sans passer par ici hériterait du defaut, d ou le test qui LIT les fichiers de migration.
alter table agent_knowledge drop column if exists corps_tsv;
alter table agent_knowledge add column corps_tsv tsvector generated always as
  (to_tsvector('french_sans_accent'::regconfig, coalesce(titre,'') || ' ' || coalesce(corps,''))) stored;
-- ⚠️ L index part AVEC la colonne : le recreer n est pas une precaution, c est obligatoire. Sans lui, la
-- recherche continue de rendre les bons resultats en balayant la table, donc le defaut est INVISIBLE
-- jusqu au jour ou le corpus grossit.
create index if not exists agent_knowledge_tsv_idx on agent_knowledge using gin (corps_tsv);

alter table aide_fiches drop column if exists corps_tsv;
alter table aide_fiches add column corps_tsv tsvector generated always as
  (to_tsvector('french_sans_accent'::regconfig, coalesce(titre,'') || ' ' || coalesce(corps,''))) stored;
create index if not exists aide_fiches_tsv_idx on aide_fiches using gin (corps_tsv);
