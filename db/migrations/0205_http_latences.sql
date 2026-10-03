-- 0205_http_latences.sql : la duree des requetes HTTP de l'API, par route normalisee et code de retour.
--
-- Audit de performance du 2026-10-02, § 11, premier manque avant l'autoscaling : `/ops` mesure les files, pas les
-- routes, alors que deux des seuils de l'audit sont des latences de routes (p95 de l'Inbox au-dela de 500 a
-- 800 ms, accuse des webhooks).
--
-- Meme modele que `pool_attentes` (0109), et pour la meme raison decisive : `/ops` est servi par UNE copie de
-- l'API, qui ne voit que sa propre memoire. Cette table est le canal par lequel les autres copies se montrent.
--
-- 🔴 UNE ROUTE NORMALISEE, JAMAIS UNE ADRESSE : `route` est le motif reconnu par Fastify
-- (`/tenants/:tenantId/conversations/:conversationId/messages`), et une requete qu'aucune route ne reconnait
-- tombe sous `(aucune route)`. Ni identifiant ni donnee personnelle, et un nombre de lignes borne par celui des
-- routes.
--
-- 🔴 DES TRANCHES ET PAS UN P95 : un centile ne s'additionne pas entre copies ni entre fenetres, des compteurs
-- oui. `seaux[i]` compte les requetes de la i-eme tranche de duree ; les bornes vivent dans le code
-- (`BORNES_LATENCE_MS`, `src/ops/latence-http.ts`), et le nombre de requetes est la somme des tranches (le garder
-- a part serait une seconde verite). Changer les bornes demande de vider la table.
--
-- Volume : une ligne par route active, par copie et par fenetre de cinq minutes. Purgee au-dela de sept jours par
-- le balayage de retention du worker (`RETENTION_LATENCES_JOURS`).
--
-- ⚠️ NON BLOQUANTE : l'ecriture est au mieux et la lecture rend une liste vide si la table manque. Une mesure ne
-- doit jamais faire tomber ce qu'elle mesure.

create table if not exists http_latences (
  -- Debut de la fenetre de cinq minutes. En tete de la cle : elle sert la lecture (« les N dernieres heures »),
  -- l'ecriture et la purge, sans autre index.
  fenetre timestamptz not null,
  -- La copie qui a servi : « api », « api-a », « api-b » (`NOM_API`).
  process text not null,
  methode text not null,
  route text not null,
  code smallint not null,
  -- Une case par tranche de duree, la derniere ouverte vers le haut.
  seaux integer[] not null,
  -- Somme des durees en millisecondes, pour une moyenne sans garder les echantillons.
  somme_ms bigint not null default 0,
  -- La plus longue requete de la ligne : aucun pic n'est perdu, et il plafonne le centile tire des tranches.
  max_ms integer not null default 0,
  primary key (fenetre, process, methode, route, code)
);
