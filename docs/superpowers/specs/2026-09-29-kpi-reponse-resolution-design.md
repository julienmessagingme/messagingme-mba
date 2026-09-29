# Quantitatif > Performance : temps de réponse et temps de résolution, cadrage

Demandé et validé par Julien le 2026-09-29, en deux rondes de questions.

## Ce que Julien veut

Deux indicateurs, sur les seules conversations qu'un collaborateur a eu à prendre en main :
- **temps de réponse** : de l'arrivée en statut humain à la première réponse d'un collaborateur, quel qu'il soit ;
- **temps de résolution** : de l'arrivée en statut humain au passage en « Traité ».

Dans un nouveau sous-menu **Quantitatif > Performance**.

## Décisions

| Question | Décision |
|---|---|
| Départ du chrono | Quand un **robot passe la main à l'équipe** : un scénario (bloc « passer à un humain »), un agent IA, l'agent de Meta. Un collaborateur qui prend le fil lui-même en écrivant n'ouvre PAS de demande (ce n'est pas une attente client, et il afficherait 0). |
| Plusieurs passages | **Chaque passage est une demande.** Un nouveau passage pendant qu'une demande est ouverte n'en ouvre pas une seconde. |
| Horaires | **En heures d'ouverture** de l'espace (Paramètres) ; un espace sans horaires est compté en temps brut, et l'écran le dit. |
| Réponse | Un **message écrit dans l'Inbox** par un collaborateur (texte ou modèle). Pas l'API, pas un assistant MCP, pas une campagne, pas un robot. |
| Fin d'une demande | Le premier de : **Traité**, **archivée**, **rendue à un robot** (agent de Meta ou scénario). Tout compte comme résolu. |
| Attribution | Le temps de réponse au collaborateur **qui a répondu le premier** ; le temps de résolution à celui **qui a clos** (Traité, archivé, rendu). Une clôture automatique va dans une ligne « automatique ». |
| Affichage | **Médiane et 90e centile** de chaque temps ; **évolution par jour** ; **tableau par collaborateur** ; **demandes encore ouvertes** (nombre et la plus ancienne) ; demandes **résolues sans aucune réponse**, comptées à part. |
| Filtres | La période seule. |

## Ce qui existe, mesuré le 2026-09-29

- Le journal `conversation_evenements` (migration 0192) s'écrit dans la même requête que chaque changement de
  `PgInboxStore`. Il date déjà `passee_par_mba` (l'agent de Meta passe la main), `prise_mba`, `rendue_mba`,
  `traitee`, `archivee` et leurs inverses.
- 🔴 **Il ne date PAS le passage d'un scénario ou d'un agent IA vers l'équipe** (bascule `app_workflow` vers
  `app_human` avec le drapeau `escalade`), ni le retour de l'équipe vers un scénario.
- Les messages portent leur origine (`conversation_messages.origin`, `humain` pour l'Inbox) et leur auteur
  (`sender_user_id`).
- Les heures d'ouverture et le fuseau de l'espace sont lus par `src/lib/heures-ouvrees.ts`.
- Le groupe « Quantitatif » du menu (`web/lib/nav.ts`) porte Messages & contacts, Coûts, Funnel.

## Design

### 1. Deux événements de plus dans le journal

- `escaladee` : un robot passe la main à l'équipe. Cause requise : le scénario, l'agent IA, et pour l'agent de
  Meta l'événement existant `passee_par_mba` suffit (il n'est pas doublé).
- `rendue_scenario` : l'équipe rend le fil à un scénario (`app_human` vers `app_workflow`).

Écrits comme les autres : dans la MÊME requête que la bascule, seulement si le détenteur a vraiment changé.
Migration additive (le CHECK des types s'élargit), AVANT le `up`. **Pas de reprise** : les chiffres démarrent au
déploiement, et l'écran dit depuis quand il mesure.

### 2. Les demandes, calculées à la lecture

Une demande = un événement d'ouverture (`escaladee` ou `passee_par_mba`) sur une conversation qui n'avait pas de
demande ouverte. Sa **réponse** : le premier message `origin = 'humain'` sortant après l'ouverture et avant la
fin. Sa **fin** : le premier `traitee`, `archivee`, `rendue_mba` ou `rendue_scenario` après l'ouverture.

Les requêtes rendent les instants bruts (ouverture, réponse, fin, et qui) pour la période ; les durées en heures
d'ouverture, la médiane et le 90e centile se calculent en TypeScript, avec une fonction pure de temps ouvré entre
deux instants dans le fuseau de l'espace, bâtie sur `src/lib/heures-ouvrees.ts` et testée à part (nuit, week-end,
jour sans horaire, changement d'heure). `tenant_id = $1` sur chaque requête ; les conversations de test exclues
comme dans les autres statistiques.

### 3. L'écran

`Quantitatif > Performance` (`/dashboard/performance`), avec le sélecteur de période des autres onglets :
- quatre chiffres : médiane et 90 % de réponse, médiane et 90 % de résolution ;
- demandes de la période, résolues, résolues sans réponse, encore ouvertes (et depuis quand la plus ancienne) ;
- une courbe par jour des deux médianes (SVG maison, comme les autres cartes) ;
- le tableau par collaborateur : réponses données, médiane de réponse, demandes closes, médiane de résolution.

Un chiffre inconnu s'écrit « non disponible », jamais 0 (règle de l'écran des publicités). La console part sur
Vercel avant l'API : une route absente affiche « pas encore disponible ».

## Hors périmètre

Filtres par numéro ou par origine, objectifs (SLA) et alertes, historique avant le déploiement, export.
