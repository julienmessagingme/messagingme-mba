# La latence HTTP par route (2026-10-03)

Demandé par Julien : « fais la latence HTTP par route maintenant », point 1 de ce qui reste de l'audit de
performance du 2026-10-02 (§11, « Ce qui manque avant l'autoscaling », point 1). `/ops` mesure finement les FILES ;
côté HTTP il ne mesure rien, alors que deux des seuils de l'audit sont des latences de routes (p95 de l'Inbox au-delà
de 500 à 800 ms, et l'accusé des webhooks).

## Méthode de livraison

**En direct, puis UNE relecture indépendante du diff**, parce que le lot ajoute un crochet sur CHAQUE requête de
l'API, webhooks de Meta compris : la production emprunte ce chemin, et une mesure ne doit jamais faire tomber ce
qu'elle mesure. Il reste petit et réversible (une table neuve que rien d'autre ne lit, une carte de plus dans
`/ops`), d'où pas d'implémenteur séparé. L'essai réel qui clôt le lot : après le déploiement, ouvrir `/ops` en
production et y lire la carte remplie par le vrai trafic (le webhook de Meta, l'Inbox, `/health`), avec des routes
au format `/tenants/:tenantId/...` et jamais un identifiant réel, puis relire la table en base.

## Ce qui se mesure, et comment

- **Une route normalisée, jamais une adresse** : le motif que Fastify a reconnu (`req.routeOptions.url`), donc
  `/tenants/:tenantId/conversations/:conversationId/messages`. Une requête qu'aucune route ne reconnaît (404 des
  robots) tombe sous un seul nom, `(aucune route)` : ni cardinalité qui explose, ni donnée personnelle.
- **Par méthode, route et code de retour**, comme l'audit le demande.
- **Un histogramme à bornes fixes**, parce qu'un p95 ne s'additionne pas : on garde des compteurs par tranche de
  durée, qui s'additionnent entre copies et entre fenêtres, et on en tire p50 et p95 (la borne haute de la tranche,
  plafonnée par le maximum mesuré). Les bornes encadrent les seuils de l'audit (500 et 800 ms en font partie).
- **Le modèle existe déjà** : l'attente du pool (`pool_attentes`, migration 0109). Mesure en mémoire, vidée en base
  chaque minute par la copie qui la porte (`NOM_API`), relue par `/ops`. C'est ce qui rend la mesure juste avec
  plusieurs copies : `/ops` est servi par UNE copie, la table voit les autres.
- **Fenêtres de cinq minutes en base**, pas d'une minute : une ligne par route active et par fenêtre. Rétention de
  sept jours, purgée par le balayage de rétention du worker.

## Tâches

1. `db/migrations/0205_http_latences.sql` : la table `http_latences` (copie, fenêtre, méthode, route, code, tranches,
   somme, maximum), clé primaire commençant par la fenêtre (elle sert la lecture, l'écriture et la purge).
2. `src/ops/latence-http.ts` : la mesure (enregistrer, vider, réinjecter), les bornes, le calcul d'un centile, le
   groupe d'une route (webhooks, Inbox, API publique, autres).
3. `src/ops/latence-http.pg.ts` : écrire une fenêtre (une seule instruction par vidage, les tranches s'additionnent
   en cas de conflit), lire une fenêtre de N heures agrégée, purger.
4. `src/server.ts` : un crochet `onResponse` qui enregistre méthode, route, code et `reply.elapsedTime`.
5. `src/index.ts` : la mesure passée au serveur et vidée chaque minute avec celle du pool. `src/worker.ts` : une
   étape de plus au balayage de rétention.
6. `src/http/ops.ts` : `/ops/overview` rend `latencesHttp` (24 h, lecture au mieux : en échec, une liste vide).
7. `web/app/ops/page.tsx` : une carte « Latence HTTP par route (24 h) », groupée, effectif en premier, p95 en rouge
   au-delà de 800 ms sur les webhooks et l'Inbox, codes 5xx en rouge.

## Tests attendus

- La mesure : un enregistrement tombe dans la bonne tranche (borne incluse), vider remet à zéro, réinjecter fusionne.
- Le centile : effectif vide, tout dans une tranche, plafonné par le maximum, dernière tranche ouverte.
- Le crochet, sur un vrai `buildServer` : la route enregistrée est le MOTIF et pas l'identifiant, le code est le bon,
  une adresse inconnue tombe sous `(aucune route)`.
- Le vidage : rien à écrire au repos, une écriture en échec réinjecte au lieu de perdre.
- L'intégration (CI seulement) : deux écritures dans la même fenêtre additionnent leurs tranches, la lecture agrège
  copies et fenêtres, la purge efface l'ancien.
- `/ops/overview` porte `latencesHttp`, et une lecture en échec ne fait pas tomber l'écran.
- Chaque test vérifié dans les deux sens.

## Ordre de déploiement

La migration CRÉE une table que le code écrit : elle passe AVANT le `up` (l'écriture est au mieux et la lecture
tolère son absence, donc elle n'est pas bloquante, mais l'ordre normal suffit). Puis `up` de `mba-api` et des deux
workers (le balayage de rétention). La console lit `latencesHttp ?? []` : publiée par Vercel avant l'API, elle
affiche la carte vide, sans erreur.
