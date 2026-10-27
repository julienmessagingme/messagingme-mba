# La refonte de /ops : le plan des quatre lots (2026-10-27)

Spec : `docs/superpowers/specs/2026-10-27-ops-refonte-design.md` (les décisions de Julien, les onglets, les seuils).

## Méthode de livraison

**Un implémenteur, une relecture indépendante par lot, déploiement approuvé par Julien** : c'est un écran
d'exploitation que la production n'emprunte pas, mais les lots 2 à 4 ajoutent des appels sortants (Cockpit,
facturation), des secrets et des alertes Telegram, et un seuil mal posé réveille Julien pour rien ou se tait le jour où
il compte. Pas de feature-loop : l'essentiel se juge à l'œil (Santé sur téléphone, lisibilité des courbes). L'essai réel
qui clôt chaque lot : Julien ouvre `/ops` sur son téléphone et sur son ordinateur, et dit ce qu'il comprend de chaque
onglet sans explication.

⚠️ **`web/app/ops/page.tsx` est aussi touché par l'offre Business** (gestes du Business, sous-lot B) : le lot 1 le découpe
en onglets, donc il s'annonce aux sessions voisines avant de commencer, et se fait sur la tête de `main`.

## Lot 1 : les onglets, Santé et Capacité avec ce qu'on mesure déjà

- Découper la page en quatre onglets (un composant par onglet), sans changer le fond de Clients ni de Réglages ; une
  adresse par onglet (`/ops?onglet=sante`) pour les favoris.
- Santé : pastilles des briques à partir des mesures existantes (battement des workers, `pool_attentes`,
  `http_latences`, files pg-boss), derniers signaux de Meta (`webhook_events`), incidents des 24 h ; mise en page
  téléphone d'abord.
- Capacité : retard des files par heure (nouvelle mesure horaire tirée de pg-boss, qui ne garde pas ses tâches 30 jours),
  attentes du pool, copies d'API déduites des noms de copie dans `pool_attentes`.
- Rétention des mesures maison portée de 7 à 30 jours (`POOL_ATTENTES_RETENTION_DAYS`, `RETENTION_LATENCES_JOURS`,
  `RETENTION_TACHES_JOURS`), après avoir relevé leur volume en production ; agrégation horaire si le volume l'exige.
- Tests : le calcul de chaque pastille (pur, testé par cas), la route de lecture de l'onglet Santé (garde ops), la
  purge à 30 jours.

## Lot 2 : Cockpit, et la mémoire des workers

- Un client Cockpit en lecture (requêtes de type Prometheus), jeton dans les secrets de l'API ; une commande pour Julien
  qui crée le jeton, le pose et vérifie une lecture.
- Capacité et Santé : processeur, mémoire, connexions et disque de la base ; copies d'API et leur historique ; processeur
  de la machine.
- Chaque worker relève sa mémoire (processus et limite de son conteneur) à son battement ; courbe par worker.
- Une panne de Cockpit dégrade l'affichage (« mesure indisponible »), jamais l'écran.

## Lot 3 : le coût Scaleway

- Lecture de la consommation du mois (API de facturation `v2beta1`), mise en cache quelques heures ; projection au
  rythme du mois ; détail par poste.
- Une commande pour Julien : la clé IAM dédiée, `BillingReadOnly` au niveau de l'organisation, posée dans les secrets.

## Lot 4 : les seuils réglables et les alertes

- Les seuils de la spec en base, réglables dans Réglages, avec le journal des changements (le même que la grille de
  prix) ; valeurs bornées et validées par Zod.
- La jauge de capacité de Santé et le seuil tracé sur chaque courbe.
- Une alerte Telegram au franchissement (orange et rouge), limitée en fréquence par signal, et leur historique dans les
  incidents de Santé ; branchée sur la veille de charge existante, qui garde ses propres alertes.

## Ordre de déploiement

Chaque lot se déploie seul, l'API avant la console quand l'écran lit une route neuve (ou l'écran tolère son absence).
Les secrets des lots 2 et 3 sont posés par Julien avant le déploiement qui les lit.
