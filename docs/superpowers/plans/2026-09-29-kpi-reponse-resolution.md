# Quantitatif > Performance : temps de réponse et de résolution, plan

**Spec :** [docs/superpowers/specs/2026-09-29-kpi-reponse-resolution-design.md](../specs/2026-09-29-kpi-reponse-resolution-design.md),
à lire en entier d'abord.

**Contraintes globales :** pas de tiret long ; `tenant_id = $1` sur chaque requête ; migration additive AVANT le
`up`, compteur de `CLAUDE.md` mis à jour dans le commit qui prend le numéro ; pas d'accent grave dans un SQL ;
formes de la console tenues par `tests/web-formes.test.ts` et `tests/web-icones.test.ts`.

## Méthode de livraison

**Implémenteur, puis UNE relecture du diff**, parce que le lot touche les écritures de l'Inbox que la production
emprunte (la bascule de détenteur) et produit un chiffre affiché sur lequel un client jugera son équipe. Aucun
workflow.

Essai réel qui clôt la feature : sur l'espace MessagingMe, faire escalader une conversation par un bloc « passer
à un humain », y répondre depuis l'Inbox quelques minutes plus tard, la marquer Traité ; puis relire Quantitatif >
Performance : une demande, son temps de réponse et de résolution en heures d'ouverture, attribués au bon
collaborateur.

## Tâche 1 : les deux événements

- Migration : le CHECK de `conversation_evenements.type` accepte `escaladee` et `rendue_scenario`.
- `PgInboxStore`, la bascule de détenteur : `escaladee` quand le drapeau d'escalade fait passer un fil à
  `app_human` (cause requise, portée par les appelants : scénario, agent IA) ; `rendue_scenario` quand un fil
  `app_human` passe à `app_workflow`. Même requête, seulement s'il y a changement. `passee_par_mba` inchangé.
- Tests : chaque événement écrit, aucun sans changement, cause présente ; intégration en CI.

## Tâche 2 : les demandes et le temps ouvré

- Une fonction pure `tempsOuvre(debut, fin, fuseau, horaires)` (millisecondes), testée : nuit, week-end, jour
  fermé, changement d'heure, horaires absents (temps brut).
- Un store de lecture des demandes de la période (ouverture, réponse, fin, auteurs), puis le calcul des
  indicateurs (médiane, 90e centile, par jour, par collaborateur, ouvertes, résolues sans réponse).
- Une route gardée comme les autres statistiques, dans le module des stats existant.
- Tests : une demande sans réponse, une demande close par archivage, deux passages sur une même conversation, un
  passage pendant une demande ouverte (pas de seconde demande), la réponse d'un assistant MCP ignorée, l'isolation
  entre espaces.

## Tâche 3 : l'écran

- `Quantitatif > Performance` dans `web/lib/nav.ts` (et son test), la page `/dashboard/performance`.
- e2e : les chiffres, « non disponible » quand il n'y a pas de demande, la route absente.

**Déploiement :** CI lue job par job ; migration appliquée et relue en base AVANT le `up` ; `up` ; fumée ; l'essai
réel ci-dessus ; `features.md` (Performance), `documentation.md` (le calcul), fiche d'aide des statistiques si elle
existe.
