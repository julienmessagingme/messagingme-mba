# Le bloc Attente en secondes : plan d'implémentation (2026-10-17)

> Pour l'implémenteur : la spec voyage avec ce plan, lire les deux.
> Spec : `docs/superpowers/specs/2026-10-16-attente-en-secondes-design.md` (validée par Julien le 2026-10-17).

**But** : une pause de 1 à 59 s entre deux messages d'un scénario, tenue à la seconde, avec « en train d'écrire… »
quand le parcours répond à un message du contact.

**Architecture** : le parcours s'endort en base comme aujourd'hui ; le processus qui l'endort arme un minuteur local
qui le réclame par son identifiant à l'échéance, sous le même bail que le balayage, et le balayage reste le filet.

## Méthode de livraison

**Implémenteur par lot, puis une relecture indépendante du diff en fin de lot** : le réveil des parcours est un
chemin que la production emprunte (réponses aux clients, campagnes) et il porte un invariant invisible, une seule
reprise par bail, qu'un test unitaire monté sur un faux store ne prouve pas ; la relecture regarde surtout les trois
points où l'exécuteur écrit un sommeil et la réclamation par identifiant, parce qu'un minuteur armé sur une écriture
refusée ou une réclamation sans bail enverrait un message deux fois ou depuis un parcours clos.

**L'essai réel qui clôt** : depuis le téléphone de Julien, sur un espace de test, un mot-clé lance « message,
Attente 4 s, message, Attente 3 s, message ». On relève l'heure des trois bulles (4 s et 3 s d'écart, à une seconde
près), on voit « en train d'écrire… » pendant les pauses et les coches bleues sur le mot-clé. On répond « ok » pendant
une pause pour voir ce que devient la séquence. Puis le même scénario lancé depuis l'Inbox (pause silencieuse
attendue) et une campagne de trois contacts de test.

## Contraintes communes

- L'unité s'appelle `seconds` dans `data.unit`, de 1 à 59 (entier) dans l'écran ; le moteur accepte toute valeur
  positive, bornée par `WAIT_MAX_MS` comme les autres.
- Seuil du réveil court : `REVEIL_COURT_MAX_MS = 60_000` (une pause de 60 s ou plus garde le seul balayage).
- Tolérance de la réclamation par identifiant : `resume_at <= now() + interval '2 seconds'`. Le balayage garde sa
  condition stricte.
- Bail posé par la réclamation par identifiant : 15 minutes, le même que `claimDue`.
- Concurrence des reprises par minuteur : `WORKFLOW_REVEIL_COURT_CONCURRENCY`, défaut 4, par processus.
- « En train d'écrire… » : seulement sur WhatsApp, seulement sur un identifiant qui commence par `wamid.`, une fois
  par entrée en pause, best-effort (un refus est journalisé et n'arrête rien), jamais en `DRY_RUN`.
- Aucune migration. Aucune dépendance neuve de l'exécuteur n'est optionnelle ; leurs fausses inertes vivent dans
  `tests/`, jamais dans `src/`.
- Pas de tiret cadratin dans les textes de la console ; vouvoiement (`tests/web-vouvoiement.test.ts`).

## À relire en priorité (ce qu'aucun test de tâche ne couvre seul)

- Horloge du processus en avance sur Postgres : la tolérance de 2 s doit suffire, sinon chaque pause retombe sur le
  balayage (60 s). Test en tâche 2.
- Processus arrêté pendant une pause : le balayage doit encore prendre un parcours court non réclamé. Test en tâche 2.
- Campagne de milliers de destinataires avec une pause en secondes : les reprises ne partent jamais plus de
  `WORKFLOW_REVEIL_COURT_CONCURRENCY` à la fois. Test en tâche 3.
- Parcours clos pendant les envois qui précèdent la pause : aucun minuteur. Test en tâche 4.
- Message du contact pendant la pause : comportement actuel (le parcours `sleeping` n'est pas avancé). Épinglé par un
  test en tâche 4, jugé à l'essai réel.

## Tâches

Chaque tâche : test d'abord, vu rouge, code, vu vert, commit (plomberie ou `--only`, règle du dépôt).

### 1. Le moteur connaît les secondes

- `src/workflow/engine.ts` : `WAIT_UNITS` gagne `'seconds'`, `UNIT_MS.seconds = 1000`. `questionTimeoutMs` lit ses
  propres unités, `QUESTION_UNITS = ['minutes', 'hours', 'days']` (exportée) : une échéance en secondes y rend 0.
  `PAS_MIN_MS` ne bouge pas (une pause en secondes compte pour 60 s dans l'estimation de la fenêtre, surestimation
  voulue : c'est la borne qui protège des cycles).
- `src/workflow/node-list.ts` : le résumé dit `attendre N s`.
- Tests (`tests/workflow-wait.test.ts`) : `{delay: 4, unit: 'seconds'}` donne 4000 ; 1, 59, 0,5 (500), 0, -1, unité
  inconnue (0) ; `walk` rend `sleeping` avec `resumeInMs: 4000`. `tests/workflow-question-node.test.ts` : une échéance
  `timeoutUnit: 'seconds'` rend 0. Résumé de la liste des blocs : « attendre 4 s ».

### 2. La réclamation d'un parcours par son identifiant

- `src/workflow/run-store.pg.ts` : `claimSleepingById(id: string): Promise<DueRun | null>`. Une requête, même forme que
  `claimDue` (`for update skip locked`, bail de 15 minutes, `created_at` borné à 90 jours, statut en littéral), avec
  `id = $1` et la tolérance de 2 s ; rend la ligne avec `status: 'sleeping'`.
- `src/workflow/wake-sweep.ts` : `DueRun` gagne `lastMessageId: string | null`, REQUIS (le compilateur oblige chaque
  réclamation à le transmettre ; `claimDue` le lit déjà). `WorkflowExecutor.resume` accepte `lastMessageId?: string | null`.
- Tests unitaires (`tests/run-store-claims.test.ts`) : la requête porte `skip locked`, le bail de 15 minutes, `id = $1`,
  la tolérance de 2 s, et `last_message_id` au retour des deux réclamations.
- Tests d'intégration (`tests/integration/stores.integration.test.ts`, CI seulement) : dû pris ; échéance dans 1 s
  pris, dans 3 s refusé ; déjà réclamé par `claimDueSleeping` refusé ; `done` refusé ; deux réclamations simultanées,
  une seule ligne rendue ; un parcours court jamais réclamé par minuteur reste pris par `claimDueSleeping` une fois dû.

### 3. Le réveil court

- Nouveau `src/workflow/reveil-court.ts` :
  `creerReveilCourt(deps: { reclamer(id: string): Promise<DueRun | null>; reprendre(run: DueRun): Promise<boolean>;
  concurrence: number; poser?(ms: number, f: () => void): void }): ReveilCourt`, avec
  `ReveilCourt = { armer(runId: string, resumeAt: Date, maintenant: number): void }`.
  `armer` ignore une échéance à `REVEIL_COURT_MAX_MS` ou plus (exportée d'ici). À l'échéance, la réclamation passe
  par une file en mémoire à `concurrence` reprises simultanées ; `reclamer` rendant `null` ne reprend rien ; une
  erreur est journalisée, jamais levée. `poser` par défaut : `setTimeout` puis `unref()`, pour ne pas retenir l'arrêt
  du processus.
- `src/config.ts` : `WORKFLOW_REVEIL_COURT_CONCURRENCY`, défaut 4, à côté de `WORKFLOW_WAKE_SWEEP_INTERVAL_MS`.
- Tests (`tests/workflow-reveil-court.test.ts`, minuteries simulées) : reprise à l'échéance et pas avant ; 60 s non
  armé ; dix échéances simultanées, jamais plus de 4 reprises en vol ; `null` sans reprise ; une reprise qui lève
  n'empêche pas la suivante.

### 4. L'exécuteur arme le minuteur et signale la saisie

- `WorkflowExecutorDeps` gagne `reveilCourt: ReveilCourt` et
  `signalerSaisie(tenantId: string, messageId: string): Promise<void>`, tous deux requis.
- Une méthode privée `apresSommeil(tenantId, runId, state: RunState, canal: RunChannel, messageEntrant: string | null)`,
  appelée seulement APRÈS une écriture réussie d'un état `sleeping`, sur les trois chemins : démarrage (l'état écrit
  vers `executor.ts:1300`, message entrant = `messageDeclencheur`), avance (`:1767`, message entrant = `messageId`),
  reprise (`:897`, message entrant = `run.lastMessageId`). Si l'échéance tombe sous `REVEIL_COURT_MAX_MS` : signaler la
  saisie (contraintes communes), puis `reveilCourt.armer`.
- `src/meta/client.ts` : `signalerSaisie(messageId: string): Promise<void>`, `POST messages` avec
  `messaging_product: 'whatsapp'`, `status: 'read'`, `message_id`, `typing_indicator: { type: 'text' }` (par `call`,
  donc frein du numéro et relances compris). `ClientDesEnvois` le nomme.
- `src/workflow/envois-bloc.ts` : `signalerSaisie(tenant, messageId)` (garde `dryRun`, `clientWhatsApp`, refus
  journalisé et avalé) ; `EnvoisDeBloc` le nomme.
- `src/workflow/wiring.ts` : construit le réveil court avec `reclamer: (id) => runStore.claimSleepingById(id)` et
  `reprendre: (run) => workflowExecutor.resume(run)` (liaison tardive, l'exécuteur étant construit juste après), la
  concurrence venant de la config ; le passe à l'exécuteur avec `signalerSaisie` des envois.
- `npm run typecheck` liste les fixtures d'exécuteur à compléter : elles reçoivent `reveilCourtInerte` et
  `saisieInerte`, déclarées dans `tests/` (un seul fichier, importé).
- Tests (`tests/workflow-attente-secondes.test.ts`) : minuteur armé après chacun des trois chemins, avec la bonne
  échéance ; pas armé quand l'écriture est refusée (parcours clos pendant les envois) ; pas armé pour 60 s ; la reprise
  qui se rendort ré-arme ; saisie signalée avec le `wamid.` sur WhatsApp, pas avec `agent:x:y`, pas en RCS, pas sans
  message ; un `signalerSaisie` qui lève n'arrête pas le parcours et le minuteur est armé quand même ; un message du
  contact pendant la pause n'avance pas le parcours. Côté envois : `DRY_RUN` n'appelle pas Meta, le corps envoyé est
  exactement celui des contraintes.

### 5. Le mot-clé transporte son message

- `src/automation/match.ts` : l'événement `message` gagne `messageId?: string`. `src/webhooks/triggers.ts` y met
  `m.messageId` ; `src/automation/event-job.ts` le garde s'il est une chaîne non vide.
- `src/workflow/lancements.ts` : `DemandeAutomatisme` gagne `messageDeclencheur: string | null` (requis) ;
  `departDe` le passe pour les trois types d'automatisme, au départ `entree` ET au départ `bloc` (le type
  `DepartDuParcours` `bloc` gagne `messageDeclencheur?`, et l'exécuteur le lit vers `executor.ts:1391` comme pour
  `entree`).
- `src/automation/runner.ts` : `messageDeclencheur` vaut `ev.messageId` pour un événement `message` WhatsApp, `null`
  partout ailleurs (RCS, tag, analyse, date).
- Tests : `tests/webhook-triggers.test.ts` (l'événement porte l'identifiant) ; le runner (WhatsApp oui, RCS `null`,
  tag `null`) ; les lancements (entrée et bloc) ; l'exécuteur : un parcours lancé par mot-clé qui attend sur une
  Question ne prend pas la redélivrance du message déclencheur pour une réponse.

### 6. La console

- `web/components/WorkflowConfigPanel.tsx` : l'unité « secondes » en tête de la liste ; en secondes, entier de 1 à 59
  (ramené dans la borne), avec la mention « Au-delà de 59 secondes, passez en minutes. »
- `web/components/WorkflowNode.tsx` : le résumé dit « attendre N s ».
- `features.md`, § Bloc « Attente », ligne « après un délai » : secondes (de 1 à 59, tenues à la seconde, avec
  « en train d'écrire… » quand le scénario répond au contact), minutes, heures, jours. La fiche d'aide qui cite la
  section et son empreinte dans le même commit ; `npx vitest run tests/aide-proposer.test.ts` vert avant le push.
- Tests : `web/e2e/workflow-type-chooser-wait.spec.ts` (choisir « secondes », saisir 75, valeur ramenée à 59, résumé
  « attendre 59 s »). Puis la suite racine entière (règle du dépôt pour un lot console).

## Ordre de déploiement

1. Tâches 1 à 5 poussées ensemble ; `npm test`, `npm run typecheck` et l'auto-attaque en local ; CI lue job par job
   (`gh run view <id> --json jobs`), l'intégration y compris.
2. La relecture indépendante du lot ; un rouge se corrige, son test vérifié dans les deux sens, sans relecture de
   relecture.
3. API et worker sur la même image (`DEPLOY.md`), aucune migration.
4. Tâche 6 poussée APRÈS le `up` (Vercel publie la console au push : un bloc en secondes enregistré avant serait
   traversé sans pause).
5. L'essai réel ; `docs/prive/ESSAIS-REELS.md` mis à jour.

Retour arrière : une image antérieure lit `seconds` comme une unité inconnue, donc le bloc est traversé sans pause et
sans erreur ; `claimSleepingById` n'a pas de trace en base. Rien à défaire.
