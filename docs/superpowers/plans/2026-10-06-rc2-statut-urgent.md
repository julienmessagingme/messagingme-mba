# RC2 : le statut « urgent » des conversations

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06. Plan COURT : tâches,
> interfaces, tests attendus, ordre de déploiement, sans code.

**But :** tout collaborateur peut marquer une conversation urgente, et un agent IA aussi, par un outil.

**Décisions de Julien :**

| Question | Décision |
|---|---|
| Qui le pose | Tout collaborateur (admin, manager, agent humain), et un agent IA par un outil ; pas l'agent de Meta |
| Ce qu'il fait | Un dossier « Urgent », une pastille rouge, et les urgentes en tête de « À traiter ». Aucune notification hors console |
| Lien avec l'urgence notée par l'analyse (0 à 10) | Aucun : une décision, pas un constat (même séparation que « signalé » et `abusive`) |
| L'agent IA qui le pose | Il continue de répondre : urgent n'est pas un transfert |
| Quand il tombe | À la main par n'importe qui, et tout seul à « Traité » et à l'archivage |
| L'outil de l'agent IA | Éteint partout : posé sur aucun agent à la livraison, on l'ajoute à la main |

## Contraintes globales

- Isolation : `tenant_id = $1` sur chaque requête neuve ; les routes neuves vivent dans le module Inbox déjà au registre
  (`acces: 'tenant'`), `npx tsx scripts/auto-attaque.mts` passe en local avant de pousser.
- Aucun tiret cadratin ni demi-cadratin ; commentaires en français, densité du code voisin.
- Commit en plomberie si un fichier de câblage partagé est touché (`src/socle.ts`, `src/worker.ts`, `src/index.ts`,
  `src/server.ts`), annoncé avant.
- Migration : la prochaine libre du DOSSIER `db/migrations` d'origin au moment d'écrire (0215 au 2026-10-06, mais le
  lot 4 du numéro fourni avance en parallèle). La ligne « Dernière appliquée » de `CLAUDE.md` s'écrit dans le commit
  qui applique.

## T1. La migration

- `conversations.urgente_le timestamptz` nullable SANS défaut, `conversations.urgente_par uuid` nullable, clé
  étrangère vers `users(id)` en `on delete set null` (le départ d'un collaborateur ne retire pas l'urgence). Un agent
  IA qui pose l'urgence laisse `urgente_par` à nul : c'est l'événement de frise qui dit « l'agent IA ».
- Index partiel `conversations_urgentes_idx on conversations (tenant_id, urgente_le desc) where urgente_le is not
  null`, sur le modèle de `conversations_signalees_main_idx` (0123), pour le dossier et son compteur.
- `conversation_evenements_type_check` reposé SOUS SON NOM avec les quinze types de 0209 plus `urgente` et
  `urgence_levee` (`lock_timeout` de 5 s, comme 0194 et 0209).
- **Elle passe AVANT le `up`** : la liste de l'Inbox nommera `urgente_le` dans son `select`, donc l'ancien schéma
  ferait tomber l'Inbox en `42703`. Elle n'enlève rien : l'ancien code y survit.
- Relue en base juste après : les deux colonnes (type, nullabilité, aucun défaut), la clé étrangère en
  `confdeltype = 'n'`, l'index avec son prédicat exact, le CHECK sous son nom à dix-sept types, zéro conversation
  urgente.

## T2. Le magasin et les routes

**Fichiers :** `src/inbox/store.pg.ts` (+ son interface), `src/http/inbox.ts`, tests.

- `marquerUrgente(tenantId, conversationId, urgente: boolean, par: AuteurDuChangement | 'agent_ia'): Promise<boolean>`,
  sur le modèle exact de `signalerConversation` (l. 1182) : une instruction qui pose ou retire, écrit l'événement
  `urgente` ou `urgence_levee` seulement si l'état change (même garde « avant / après » que le signalement).
- `marquerTraitee(…, true)` et `archiverConversation(…, true)` remettent `urgente_le` et `urgente_par` à nul DANS LA
  MÊME instruction, comme elles effacent déjà `escaladee_le` (l. 1113-1174), et écrivent `urgence_levee` si elle était
  posée.
- Liste : `urgente: boolean` dans chaque ligne (`(c.urgente_le is not null) as urgente`, à côté de `signalee_main`),
  option `urgentes: true` pour le dossier (filtre `c.urgente_le is not null`, hors archivées comme les autres), compteur
  `urgentes` dans le calcul des compteurs (l. 1044-1088).
- 🔴 **L'ordre de « À traiter » et sa pagination.** La liste pagine en tuple `(last_message_at, id)` (l. 935-940). Les
  urgentes en tête changent l'ordre de CE dossier seulement : `order by (c.urgente_le is not null) desc,
  c.last_message_at desc, c.id desc`, et le curseur porte le rang d'urgence (`(rang, last_message_at, id) < (…)`). Les
  autres dossiers gardent leur ordre et leur curseur. Mesurer le plan d'exécution de la première page de « À traiter »
  sur un gros espace avant et après.
- Routes `POST /tenants/:tenantId/inbox/conversations/:id/urgent` et `/ne-plus-urgent`, construites dans la même
  boucle que `signaler` / `ne-plus-signaler` (l. 394-402) : ouvertes à tout rôle authentifié, auteur pris dans la
  session, jamais dans le corps.

**Tests attendus :** poser, retirer, poser deux fois (un seul événement) ; « Traité » et l'archivage retirent l'urgence
et journalisent ; le dossier et son compteur concordent (intégration) ; la première page de « À traiter » met une
urgente ancienne avant une non urgente récente, et la page 2 reprend sans doublon ni trou à la frontière (le cas que la
pagination casserait) ; un autre espace reçoit 404 ; un agent humain peut poser l'urgence sur une conversation affectée
à un collègue (même règle que le signalement).

## T3. L'outil de l'agent IA

**Fichiers :** `src/agent/outils-maison.ts` (le catalogue), `src/agent/resolvers/mba.ts` (le handler),
`tests/agent-outils-maison.test.ts` (le miroir `HANDLERS`), tests.

- Entrée de catalogue `marquer_urgent`, nom par défaut `mba_marquer_urgent`, risque `write`, AUCUN paramètre, titre
  « Marquer la conversation urgente », « quand ne pas l'appeler » : « Ne pas l'appeler pour une simple demande
  d'information ». Il ne figure PAS dans `OUTILS_SURS` (ce que l'agent tiers d'un client peut poser par MCP) : décision
  par défaut, à rouvrir si Julien le demande.
- Le handler appelle `marquerUrgente(…, true, 'agent_ia')` sur la conversation de la session et rend « fait » au
  modèle ; la session continue (aucune sortie, aucun changement de fil).
- Éteint partout : aucune pose automatique, aucune reprise des agents existants. Il apparaît dans « Donner un outil de
  plus » de l'écran de l'agent (et dans la section « Toujours là » quand RC4 la livrera).

**Tests attendus :** le miroir des handlers ; le handler pose l'urgence de la BONNE conversation et pas d'une autre du
même contact ; la session de l'agent reste ouverte ; le bac à sable simule l'outil sans rien écrire.

## T4. La console

**Fichiers :** `web/components/InboxDossiers.tsx`, `web/lib/inbox-rangement.ts`, la ligne de la liste, l'en-tête de la
conversation, la frise, e2e.

- Dossier « Urgent (n) » placé juste sous « À traiter » ; pastille rouge sur la ligne et dans l'en-tête ; geste
  « Marquer urgent » / « Plus urgent » à côté de « Signaler ».
- Frise : « Marquée urgente par <nom> », « Marquée urgente par l'agent IA », « Urgence levée ».
- ⚠️ `grep` des libellés de dossiers et de gestes dans `web/e2e` avant (les e2e trouvent par rôle et par texte).

**Tests attendus :** un e2e qui marque une conversation, la retrouve dans « Urgent » et en tête de « À traiter », puis
la passe « Traité » et la voit sortir du dossier.

## T5. Documentation

`documentation.md` (les marques d'une conversation, l'ordre de « À traiter », modifié sur place), `features.md` (Inbox
et outils de l'agent IA, avec leurs fiches d'aide et empreintes, `tests/aide-proposer.test.ts` vert avant le push),
`CLAUDE.md` (dernière migration appliquée), journal.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante en fin de lot, parce que le lot touche la
requête de la liste de l'Inbox (rafraîchie toutes les quatre secondes par chaque opérateur) et sa pagination en tuple,
un invariant invisible qu'un ordre changé casse sans erreur, plus une migration sur `conversations`.

**Ordre de déploiement :** CI verte job par job (`gh run view --json jobs`), `compose build`, `pg_stat_activity` lu
(aucune transaction longue, aucun verrou sur `conversations`), migration appliquée puis relue en base, `up` de l'API
et des deux workers, rechargement NPM et contrôle public des deux portes. La console part APRÈS (elle appelle les
routes neuves) : soit pousser `web/` après le `up`, soit la livrer dans le même push en tolérant l'absence de la route.

**L'essai réel qui clôt :** dans l'espace de Julien, marquer à la main une conversation urgente depuis l'Inbox, la
voir dans « Urgent » et en tête de « À traiter », puis la passer « Traité » et la voir quitter le dossier ; puis donner
l'outil à un agent IA, lui écrire depuis un vrai téléphone « c'est urgent, ma commande n'est jamais arrivée », et voir
la conversation marquée par l'agent, qui continue de répondre.
