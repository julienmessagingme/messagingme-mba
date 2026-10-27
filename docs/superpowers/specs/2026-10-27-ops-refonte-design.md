# La refonte de /ops : santé, capacité, et quand grossir l'infrastructure (cadrage du 2026-10-27)

Cadrage en trois rondes de questions avec Julien, le soir des bancs de la nouvelle infrastructure
(`docs/JOURNAL-TECHNIQUE.md`, 2026-10-27). Son besoin : voir clairement ce qui se passe, avec plus d'historique, et
savoir quand il faut changer de machine.

## Ce qui existe

`/ops` est une seule page (`web/app/ops/page.tsx`) : chiffres des clients, workers, équité, pool de connexions, files
pg-boss, latence des files et des routes sur 24 h, tâches de fond, budget Vercel, stockage, numéros fournis, grille de
prix, tableau des espaces et ses gestes. Les mesures minute par minute (`pool_attentes`, `http_latences`, mesures des
tâches) sont gardées 7 jours. Rien ne mesure le processeur ni la mémoire de la base ou de la machine, ni le nombre de
copies d'API, ni le coût.

## Les décisions de Julien

1. **Quatre onglets** dans une seule page : **Santé**, **Capacité**, **Clients**, **Réglages**.
2. **Trente jours d'historique** pour les courbes.
3. **Les signaux de capacité** : les copies d'API allumées, le retard des files, la base (connexions, attentes du pool,
   processeur, mémoire), la machine des workers (processeur, mémoire).
4. **Les alertes** : Telegram (limitées en fréquence, comme la veille de charge actuelle) et leur historique dans `/ops`.
5. **Le coût réel Scaleway**, par poste, dans l'onglet Capacité, lu par l'API de facturation.
6. **Cockpit** (l'outil de mesure de Scaleway) pour la base et l'API ; la mémoire des workers relevée par eux-mêmes.
7. **Les seuils réglables dans `/ops`** (onglet Réglages), avec le journal des changements de la grille de prix.
8. **L'onglet Santé lisible sur téléphone** ; les courbes peuvent rester confortables sur ordinateur seulement.
9. **Santé** montre : une pastille par brique, les derniers signaux de Meta, les incidents des 24 h, une jauge de
   capacité.
10. **Quatre lots**, chacun utilisable seul (le plan).

## Les onglets

**Santé** (sur téléphone d'abord).
- Une pastille verte, orange ou rouge par brique, avec sa raison en une ligne : l'API (`/health`, part de 5xx de
  l'heure), chaque worker (battement par rôle), la base (connexions sur `max_connections`, attentes du pool), les files
  (retard des entrants et des accusés), la porte HubSpot (éveillée ou endormie : un sommeil n'est pas une panne).
- Les derniers signaux de Meta : l'heure du dernier message reçu et du dernier accusé ; un silence anormal se voit.
- Les incidents des 24 h : 5xx, tâches en échec et file d'échec, redémarrages de workers, alertes envoyées.
- La jauge de capacité : la marge avant de devoir grossir, calculée sur le PIRE des signaux de capacité rapporté à son
  seuil, avec le nom de ce signal.

**Capacité** (courbes sur 30 jours, ordinateur).
- Les copies d'API allumées (Cockpit), le nombre et la durée des montées à 2 et 3 copies.
- Le retard des files (p95 par heure des entrants et des accusés).
- La base : connexions, attentes du pool, processeur, mémoire, disque (Cockpit).
- La machine des workers : processeur (Cockpit), mémoire de chaque worker (relevée par lui).
- Le coût Scaleway du mois en cours, sa projection, et le détail par poste.
- Pour chaque signal : son seuil tracé sur la courbe, et ce que veut dire le franchir (« passer en DB-DEV-L »,
  « copie d'API plus grosse »).

**Clients** : ce qui existe aujourd'hui (chiffres, tableau des espaces, gestes, offres), sans changement de fond.

**Réglages** : la grille de prix, les numéros fournis, les e-mails du produit, et les seuils de capacité.

## Les seuils par défaut (bancs du 2026-10-27, réglables)

| Signal | Orange | Rouge | Ce que dit le rouge |
|---|---|---|---|
| Retard des accusés, p95 sur 15 min | 60 s | 120 s | base trop lente : DB-DEV-L |
| Retard des entrants, p95 sur 15 min | 5 s | 30 s | workers ou base saturés |
| Connexions de la base | 70 % | 85 % | budget de connexions à revoir, base plus grosse |
| Processeur de la base, moyenne 15 min | 60 % | 80 % | DB-DEV-L |
| 2e copie d'API, sur 7 jours | 3 montées | 1 h cumulée | copie de base plus grosse |
| Processeur de la machine, moyenne 15 min | 60 % | 80 % | machine plus grosse |
| Mémoire d'un worker | 70 % de sa limite | 85 % | limite ou machine plus grosse |

## Ce qu'il faut à Julien (une commande chacune, préparée)

- Un jeton Cockpit en lecture des métriques, posé dans les secrets du conteneur de l'API.
- Une clé IAM dédiée, `BillingReadOnly` au niveau de l'organisation, posée de même (jamais celle de `claude-code`).

## Hors du cadrage

- L'agrégation des mesures maison au-delà de 30 jours.
- Les alertes par e-mail.
- Tout autre geste d'exploitation nouveau dans l'onglet Clients.
