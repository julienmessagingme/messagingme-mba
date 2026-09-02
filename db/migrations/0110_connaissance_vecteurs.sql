-- 0110_connaissance_vecteurs.sql : la recherche de connaissance apprend le SENS, pas seulement les mots.
--
-- Julien, le 2026-09-02 : « en bornant a 3 fiches sur 500 tu renvoies potentiellement 1 % du contenu... faut
-- vectoriser ! ». Il avait raison, et mon objection (« le cout est deja borne ») etait l argument inverse du
-- bon : PLAFONNER A 3 FICHES REND LA QUALITE DU TRI PLUS CRITIQUE, PAS MOINS.
--
-- 🔴 LE DEFAUT QUE LE CODE DOCUMENTAIT DEJA. La regle de pertinence actuelle n accepte une fiche que sur des
-- motifs LEXICAUX, et son commentaire dit : « une question sans le moindre mot commun ne fait remonter AUCUNE
-- fiche, donc la sortie tombe de toute façon ». C est presente comme une garantie de surete, et c en est une,
-- mais c est exactement le probleme : « c est combien pour resilier » et « Conditions de sortie de contrat »
-- n ont AUCUN mot en commun. L agent dit « je ne sais pas » alors que la reponse est dans la base.
--
-- CE QUE CETTE MIGRATION POSE, ET CE QU ELLE NE POSE PAS. Elle pose le stockage du RAPPEL (le vecteur d une
-- fiche). Elle ne pose AUCUN verdict : la mesure du 2026-09-02 a montre qu aucun seuil de similarite n est
-- posable (une question hors sujet remonte a 0,361 quand une vraie question descend a 0,299, les nuages se
-- chevauchent). Le verdict appartient a un RERANKER, qui est un appel, pas une colonne. Detail complet :
-- `docs/MESURE-RECHERCHE-CONNAISSANCE-2026-09-02.md`.
--
-- ⚠️ NON BLOQUANTE, comme les deux precedentes : la colonne est nullable, le code sait chercher sans elle
-- (c est le comportement d aujourd hui), et un vecteur absent n empeche jamais une fiche d exister ni d etre
-- trouvee par le plein texte. Une fiche creee est utilisable a la SECONDE, meme si son vecteur n arrive qu au
-- balayage suivant.
--
-- 🔴 LA DIMENSION EST FIGEE PAR LE MODELE, et c est la seule decision de ce fichier qui coute cher a changer.
-- 1536 est celle de `cohere/embed-v4.0`, choisi parce qu il place la bonne fiche en premier 6 fois sur 6 en
-- FRANÇAIS, la ou deux concurrents la placent deuxieme a 0,009 pres. Changer de modele obligerait a recalculer
-- les vecteurs de tous les clients : c est un balayage, pas un drame, mais ça se decide une fois.

create extension if not exists vector;

alter table agent_knowledge add column if not exists embedding vector(1536);

-- Le modele qui a produit le vecteur. 🔴 Ce n est PAS decoratif : le jour ou l on change de modele, c est
-- cette colonne qui dit quelles lignes recalculer, et elle permet de le faire progressivement au lieu de
-- vider la colonne d un coup, ce qui rendrait toutes les bases aveugles le temps du rattrapage.
alter table agent_knowledge add column if not exists embedding_modele text;

-- Index HNSW en distance COSINUS, la meme que celle mesuree par le banc. ⚠️ Un index vectoriel n est pas
-- exact : il rend « probablement les plus proches ». C est sans consequence ici parce qu il ne sert qu au
-- RAPPEL, et que le verdict est rendu apres, par le reranker.
create index if not exists agent_knowledge_embedding_idx
  on agent_knowledge using hnsw (embedding vector_cosine_ops);

-- Le balayage cherche « les fiches sans vecteur, par espace ». Sans cet index il lirait toute la table a
-- chaque passage, y compris quand il n y a rien a faire, ce qui est le cas la quasi-totalite du temps.
create index if not exists agent_knowledge_sans_vecteur_idx
  on agent_knowledge (tenant_id, agent_id) where embedding is null;
