# Inbox : le panneau Détail d'une conversation, cadrage

Demandé et validé par Julien le 2026-09-28, en trois rondes de questions.

## Ce que Julien veut

Dans l'Inbox, quand on choisit une conversation, la moitié basse de la colonne des conversations montre qui est la
personne, où en est la conversation, et ce qui lui est arrivé : pas tous les champs du mini-CRM, l'essentiel.

## Décisions

| Question | Décision |
|---|---|
| Identité | Nom, prénom, téléphone, e-mail (les champs système `name`, `prenom`, `phone`, `email`), les tags, un badge « désabonné » ou « bloqué », le lien « Ouvrir la fiche » |
| Résumé | Celui de l'analyse des conversations (`conversation_analysis.summary`) ; absent : « pas encore analysée » |
| Assignation | « Assignée à » le collaborateur, ou « non affectée » |
| Historique | Assignations (assignée, désassignée, réassignée : qui, par qui) ; prises et rendus à l'agent de Meta ; traitée, archivée, signalée et leurs inverses |
| Réponses de l'agent de Meta et des collaborateurs | **Pas dans le panneau** : le fil les montre déjà |
| Changements automatiques | **Dans l'historique, marqués avec leur cause** (« automatique : campagne Rentrée ») |
| Amorçage | **Depuis l'état actuel**, qui est réel (voir § Données) |
| Affichage | Une frise dans le panneau, du plus récent au plus ancien |
| Panneau | **Repliable**, moitié basse de la colonne quand une conversation est choisie ; le choix est retenu (par navigateur) |
| Actions | **Lecture seule** : les gestes restent dans l'en-tête du fil |
| Rétention | **Comme la conversation** : l'historique part avec elle (purge, effacement RGPD) |
| Qui voit | **Qui voit la conversation** : même règle de visibilité que le fil |

## Ce qui existe, mesuré le 2026-09-28

- L'assignation n'est gardée qu'au présent : `conversations.assigned_to`, `assigned_at`, `assigned_by` (0070).
  `assigned_by` vaut `null` pour un routage automatique, l'agent lui-même pour une prise.
- Le détenteur du fil : `conversations.control_owner` et `control_changed_at` (0040), l'escalade `escaladee_le`.
- Les statuts : `traitee_le` (0160), `archived_at` (0120), `signalee_le` et `signalee_par` (0123).
- 🔴 **Toutes ces écritures vivent dans `PgInboxStore` (`src/inbox/store.pg.ts`)** : `setAssignee`,
  `prendreSiLibre`, `setAssigneeByWaId` (bloc de scénario), `assignerSiLibre` (tour de rôle de campagne), la bascule
  de détenteur (celle qui porte `only`, `escalade`, `effacerEscalade`), `marquerEscalade` (l'agent de Meta passe la
  main), le marquage traité, archivé, signalé, et l'upsert d'un message entrant qui **rouvre** une conversation
  archivée ou traitée.
- Les champs système du mini-CRM : `SYSTEM_FIELD_KEYS` (`src/crm/fields.ts`).

## Design

### 1. Les données : un journal d'événements de conversation

Une table neuve : espace, conversation (**cascade** : l'historique part avec elle), type, acteur (collaborateur,
nullable, `on delete set null`), cible (le collaborateur assigné, nullable, `on delete set null`), cause (texte
court, pour un changement automatique), date. Index sur `(conversation_id, at desc)`.

Types : `assignee`, `desassignee`, `prise_mba` (un collaborateur prend le fil à l'agent de Meta), `rendue_mba`,
`passee_par_mba` (l'agent passe la main à l'équipe), `traitee`, `non_traitee`, `archivee`, `desarchivee`,
`signalee`, `designalee`, `rouverte` (un message du contact sort la conversation d'Archivé ou de Traité).

🔴 **Chaque événement s'écrit dans la MÊME requête que le changement qu'il décrit** (une requête avec CTE dans
`PgInboxStore`), et **seulement si la valeur a vraiment changé**. Deux écritures laisseraient une fenêtre où l'un
existe sans l'autre ; un événement écrit sans comparer l'avant et l'après journaliserait des gestes sans effet
(réassigner à la même personne, archiver une conversation déjà archivée).

⚠️ **Les chemins automatiques passent leur cause** : `setAssigneeByWaId` (le scénario qui la nomme),
`assignerSiLibre` (la campagne du tour de rôle), la bascule de détenteur (qui la demande : un collaborateur, un
scénario, l'agent de Meta, l'expiration du délai de reprise). Le paramètre est **requis** dans leur signature : un
cinquième appelant qui l'oublierait ne compile pas.

**Amorçage** dans la migration, depuis l'état actuel, qui est réel : l'assignation en cours (cible, auteur, date),
`traitee_le`, `archived_at`, `signalee_le` (et son auteur), et `control_changed_at` quand le fil est tenu par un
humain. Une ligne amorcée porte la cause « état au déploiement ». Rien n'est inventé : pas de date, pas de ligne.

### 2. La lecture

`GET /tenants/:tenantId/inbox/conversations/:id/detail` : identité (champs système, tags, désabonné, bloqué,
identifiant de la fiche), résumé de l'analyse (ou `null`), assignation courante (nom du collaborateur), historique
(les 50 derniers événements, nom des acteurs et cibles résolus, un collaborateur supprimé s'affiche « ancien
collaborateur »). **Même garde de visibilité que le fil** (`src/inbox/assignment.ts`) : un agent qui ne voit que
ses conversations et les non affectées ne lit que leur détail ; sinon 404. `tenant_id = $1` sur chaque requête.

### 3. L'écran

La colonne des conversations se partage : la liste en haut, le panneau en bas, moitié-moitié, **quand une
conversation est choisie**. Un bouton replie le panneau (la liste reprend toute la hauteur), retenu par
navigateur. Le panneau défile seul. Il se rafraîchit quand la conversation change, et après un geste de
l'en-tête du fil (assigner, prendre, traiter). Lecture seule.

🔴 La console part sur Vercel au push, avant l'API : une route absente (404) replie le panneau sans erreur.

## Hors périmètre

Réponses de l'agent de Meta et des collaborateurs dans la frise, gestes depuis le panneau, résumé à la demande,
autres champs du mini-CRM, historique au-delà de la vie de la conversation.
