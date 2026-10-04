-- 0207_taches_mesures.sql : la duree et le nombre de lignes des taches de fond des workers, par heure.
--
-- Audit de performance du 2026-10-02, § 11 (« duree et nombre de lignes des gros balayages ») et § 12 P2 : les
-- declencheurs de l'audit sont des durees (un agregat d'analyse au-dela de cinq minutes, un balayage nocturne qui
-- deborde sa fenetre). Sans mesure gardee, ces seuils ne pouvaient pas etre vus.
--
-- Meme modele que http_latences (0205) et pool_attentes (0109), et pour la meme raison : /ops est servi par l'API,
-- qui ne voit pas la memoire des workers. Chaque worker agrege ses passes en memoire et vide chaque minute.
--
-- Mesuree par le registre commun des taches (src/worker/taches.ts), donc pour TOUTES les taches sans exception :
-- une tache ajoutee demain est mesuree sans y penser. Le nombre de lignes, lui, n'existe que pour les passes qui
-- le rendent (agregats, risque, purges) ; null ailleurs, et null n'est pas zero.
--
-- Volume : une ligne par tache active, par worker et par heure (une trentaine de taches, deux workers : environ
-- 1 500 lignes par jour). Purgee au-dela de sept jours par le balayage de retention du worker.
--
-- ⚠️ NON BLOQUANTE : l'ecriture est au mieux et la lecture rend une liste vide si la table manque. Une mesure ne
-- doit jamais faire tomber ce qu'elle mesure.

create table if not exists taches_mesures (
  -- Debut de l'heure. En tete de la cle : elle sert la lecture (« les N dernieres heures »), l'ecriture et la purge.
  fenetre timestamptz not null,
  -- Le worker qui a fait la passe : « worker-principal », « worker-analyse », ou « worker » en mode unique.
  process text not null,
  -- Le nom de la tache dans le registre (« agregats-analyse », « risque-desengagement »...).
  tache text not null,
  passes integer not null default 0,
  -- Passes qui ont leve : la tache a echoue, sa duree compte quand meme.
  echecs integer not null default 0,
  -- Tours sautes parce que la passe precedente tournait encore : la seule trace d'une passe bloquee, qui ne finit
  -- jamais et n'est donc jamais mesuree en duree.
  sautees integer not null default 0,
  -- Somme des durees en millisecondes, pour une moyenne sans garder les echantillons.
  somme_ms bigint not null default 0,
  -- La plus longue passe de l'heure : c'est elle que les seuils de l'audit regardent.
  max_ms integer not null default 0,
  -- Somme des lignes rendues par les passes qui en rendent ; null tant qu'aucune passe n'en a rendu.
  lignes bigint,
  -- La plus grosse passe de l'heure, en lignes.
  max_lignes integer,
  primary key (fenetre, process, tache)
);
