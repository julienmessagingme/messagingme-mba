# Inbox : le panneau Détail, plan

**Spec :** [docs/superpowers/specs/2026-09-28-inbox-panneau-detail-design.md](../specs/2026-09-28-inbox-panneau-detail-design.md),
à lire en entier d'abord.

**Contraintes globales :** pas de tiret long ; `tenant_id = $1` sur chaque requête ; migration additive AVANT le
`up`, compteur de `CLAUDE.md` mis à jour dans le commit qui prend le numéro (numéro pris dans le dossier au moment
d'écrire) ; pas d'accent grave dans un SQL, commentaires compris ; les formes de la console : trois rayons,
deux largeurs, une famille d'icônes (`tests/web-formes.test.ts`, `tests/web-icones.test.ts`).

## Méthode de livraison

**Implémenteur, puis UNE relecture du diff**, parce que le lot réécrit les requêtes d'écriture de l'Inbox que la
production emprunte à chaque message entrant, et porte un invariant invisible (l'événement dans la même requête
que le changement, et seulement s'il y a eu changement). Lancé APRÈS le lot 1 du crédit, qui touche aussi
l'Inbox. Aucun workflow.

Essai réel qui clôt la feature : sur l'espace MessagingMe, assigner une conversation, la réassigner, la
désassigner, la prendre à l'agent de Meta puis la lui rendre, l'archiver, puis relire la frise du panneau (qui,
par qui, quand, dans l'ordre) ; et vérifier qu'un message du contact sur une conversation archivée ajoute
« rouverte ».

## Tâche 1 : le journal et ses écritures

- Migration : la table des événements (spec § 1), son index, son amorçage depuis l'état actuel.
- `PgInboxStore` : chaque écriture listée dans la spec (§ Ce qui existe) écrit son événement dans la même requête,
  seulement si la valeur a changé. Les chemins automatiques reçoivent une cause REQUISE ; leurs appelants
  (moteur de scénario, roulement de campagne, `src/inbox/fil.ts`, balayages) la passent.
- Tests : chaque écriture produit son événement, et aucun quand rien ne change (réassigner au même, archiver
  l'archivée) ; la rouverture par un message du contact ; une réaction ne rouvre rien ; la cascade à
  l'effacement ; l'amorçage (une ligne par fait réel, aucune pour une colonne nulle). Intégration en CI, chaque
  test vérifié dans les deux sens.

## Tâche 2 : la route de lecture

- `GET /tenants/:tenantId/inbox/conversations/:id/detail` (spec § 2), dans le module Inbox existant, avec sa
  garde de visibilité.
- Tests : un admin lit tout ; un agent lit les siennes et les non affectées, 404 sur celle d'un autre ; un autre
  espace, 403 ; un résumé absent rend `null` ; un collaborateur supprimé devient « ancien collaborateur ».

## Tâche 3 : le panneau

- La colonne des conversations se partage (spec § 3) ; le panneau repliable, retenu par navigateur ; rafraîchi au
  changement de conversation et après un geste de l'en-tête ; une route absente le replie sans erreur.
- e2e : identité et badges, résumé et « pas encore analysée », frise dans l'ordre, repli retenu au rechargement,
  route absente.

**Déploiement :** CI lue job par job ; migration appliquée et relue en base AVANT le `up` (amorçage compté) ;
`up` ; fumée ; l'essai réel ci-dessus ; `features.md` (Inbox), `documentation.md` (le journal, sa règle
d'écriture), fiche d'aide de l'Inbox si elle existe.
