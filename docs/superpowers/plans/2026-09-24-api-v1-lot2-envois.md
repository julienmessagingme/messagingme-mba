# API publique v1, lot 2 : les envois refondus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /v1/sends` désigne ses destinataires par la résolution de fiche partagée, écarte chacun avec un motif et son index (plus aucune perte silencieuse), juge ce qui part EN PREMIER depuis l'entrée ou depuis le bloc visé, refuse ce que la console refuse, lit la catégorie d'un template chez Meta, accepte la clé d'idempotence en en-tête OU dans le corps avec l'empreinte du corps, et rend un contrat écrit sur `GET /v1/sends/{sendId}` ; `POST /v1/messages/whatsapp` remplace `POST /v1/messages` ; les refus de ces routes portent les codes unifiés (ceux du garde commun sont posés par le lot 1, ce lot les vérifie sans les réécrire).

**Architecture:** Des briques PURES d'abord (`ouvertureApi`, `cleIdempotence` et `empreinteCorps`, `verdictModele`, `trierDestinataires`, `messageDeForme`, `formaterSuiviEnvoi`), chacune testée seule ; deux lectures en base dédiées à l'API (`listContactsPourEnvoiApi`, `lireEnvoiApi`), qui ne touchent pas celles de la console ; puis les deux routes réécrites, qui ne font qu'assembler ces briques, et leur câblage dans `src/index.ts`. La résolution de fiche, l'écriture du consentement et `refuser` viennent du lot 1.

**Tech Stack:** TypeScript 5.7 (ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Fastify 5, zod 4.4, pg, vitest 2, Postgres (Supabase), pg-boss.

**Spec:** docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md

## Global Constraints

- **Portée** : spec § 3 (SAUF la cible `rcsMessage` et les variables par destinataire, qui sont au lot 3), § 4 partie WhatsApp (`POST /v1/messages/whatsapp` remplace `POST /v1/messages`), § 9 (codes unifiés appliqués aux envois et aux messages). Le garde commun (`src/auth/api-key.ts`, `src/auth/rate-limit.ts`, `src/api/usage-guard.ts`) porte ses codes depuis la tâche 2 du LOT 1 : ce lot le VÉRIFIE (tâche 2) et ne le réécrit pas. Défauts 1, 2 et 3 du « Problème » de la spec, chacun avec son test de non-régression vérifié dans les deux sens.
- **Prérequis** : le lot 1 est livré ET déployé. Ce lot consomme, sous ces noms exacts : `src/api/fiche.ts` (`ClesFiche`, `ModeCreation = 'jamais' | 'phone' | 'phone_ou_bsuid'`, `ResolutionFiche`, `CodeResolution`, `MESSAGE_RESOLUTION`, `resoudreFiche(deps, tenantId, cles, { creer })`, `schemaClesFiche` dont `contactId` est un GUID, `DepsFiche = Pick<PgContactStore, 'chercherParCles' | 'creerFicheApi' | 'rattacherCles'>`), `src/api/consentement.ts` (`appliquerConsentement(deps, tenantId, contactId, consent, source)`, `DepsConsentement`), `src/api/contacts-v1.ts` (`creerServiceContactsV1`, qui construit son `DepsConsentement`), `src/api/erreurs.ts` (`CodeApi`, `STATUT_PAR_CODE`, `refuser(reply, statut, code, message)`), `src/auth/rate-limit.ts` (`consommerAvecEntetes` et `consommerEnSilence` à `code?: CodeApi` FACULTATIF), `tests/aide/contacts-v1.ts` (`contactsV1Muets()`), `tests/api-garde-codes.test.ts`, la colonne `contacts.external_id`.
- 🔴 **Un STOP ne se lève pas par machine** (décision de Julien du 2026-09-24, codée au lot 1) : `appliquerConsentement` rend désormais `'change' | 'inchange' | 'refuse' | 'absente'`, et `'refuse'` veut dire « `opted_in` sur une fiche `opted_out` ». Pour un destinataire d'envoi, ce retour n'a PAS à être lu : la fiche reste `opted_out`, et le tri de l'envoi l'écarte en `opted_out`. Un test de ce lot le fige (destinataire `{ phone, consent: 'opted_in' }` sur une fiche désabonnée : écarté `opted_out`, aucune écriture de consentement, aucune ligne d'audit). Le type de la dépendance `appliquerConsentement` de `V1SendsRouteDeps` suit le retour réel, jamais `Promise<void>`.
- **Numéros de ligne** : ceux du code ACTUEL, relevés avant le lot 1. Le lot 1 en décale certains (`src/index.ts`, `src/crm/contact-store.pg.ts`, `tests/v1-sends.test.ts`, `tests/v1-messages.test.ts`) : chaque remplacement cite aussi le texte exact, c'est lui qui fait foi.
- **Forme d'erreur, verbatim de la spec** : « Toute erreur a la forme `{ "error": "<phrase en français>", "code": "<code>" }`. Les codes sont en anglais snake_case ». Toujours par `refuser(...)` dans les routes.
- **Statuts, verbatim** : « 400 corps invalide ; 401 / 403 clé ; 404 introuvable ; 409 l'état de la fiche ou de l'espace l'interdit ; 422 la demande est juste mais ne peut pas partir comme ça ; 429 débit. » Tout défaut de FORME est `invalid_body`, le champ fautif en tête du message.
- **Motifs d'écart de `/v1/sends`** (§ 9) : `invalid_recipient`, `invalid_phone`, `unknown_contact`, `duplicate`, `identity_conflict`, `blocked_contact`, `opted_out`, `no_consent`, `window_closed`, `missing_variable`, `no_phone`.
- **Bornes, verbatim** : `recipients` « 50 au plus » ; `skipped` « tronquée à 200, `skippedTotal` donne le compte réel » ; `ratePerMinute` « entier de 1 à 80, sinon 400 » ; la clé d'idempotence « vit 24 h » ; texte WhatsApp « 4 096 caractères au plus ».
- **Garde commun, verbatim** : « leur ajouter un `code` ne doit changer ni leurs statuts ni leurs en-têtes (`retry-after`, `x-ratelimit-*`) ». C'est le lot 1 qui le fait (code FACULTATIF, pour que la console garde ses refus `{ error }` seuls, `tests/rate-limit-utilisateur.test.ts` le tient) ; ce lot n'y touche pas.
- **Aucun outil tiers n'est nommé dans ce lot** : ni dans le code, ni dans les commentaires, ni dans les messages d'erreur, ni dans les tests. La clé dans le corps sert « un outil qui appelle une adresse par contact », quel qu'il soit.
- **Rédaction** : français, SANS tiret cadratin ni demi-cadratin (virgule, deux-points, parenthèses, point), dans le code, les commentaires, les messages et les commits.
- **Code** : zod `safeParse`, jamais `parse`, jamais de `as` sur une entrée externe (corps, paramètres d'URL, en-têtes). `tenant_id = $n` sur CHAQUE requête SQL. Une dépendance de sécurité (`estDesabonne`, la garde) n'est jamais optionnelle ; les dépendances neuves des routes sont REQUISES. Ne jamais recopier en prose un compteur calculable (nombre de tests, de routes, de migrations).
- **Tests** : unitaires par `npx vitest run <fichier>` ; `npm run typecheck` ; `npm test`. Les tests d'INTÉGRATION (`tests/integration/`) ne se lancent JAMAIS en local (le `DATABASE_URL` local est la PRODUCTION) : ils s'écrivent, et leur verdict se lit sur le run GitHub, job par job, par `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'`, jamais par le code de sortie de `gh run watch`.
- **Test de non-régression dans les deux sens** : remettre le code fautif, lancer SEULEMENT le fichier de test concerné, voir l'échec ET son symptôme, restaurer, relancer vert.
- **Git** : tout sur `main`, pas de branche ni de worktree. JAMAIS `git add` puis `git commit` nu. 🔴 **TOUS les commits de ce lot passent par la procédure P ci-dessous** (commit construit sur `origin/main` par un index temporaire), et pas seulement ceux qui touchent un fichier de câblage : trois tâches (3, 8, 9) touchent `src/index.ts` ou `src/server.ts`, pour lesquels `CLAUDE.md` INTERDIT le `--only` sans condition (puce « LE HOOK `rayon-de-souffle` AGRANDIT LA FENÊTRE »), et un commit poussé en plomberie ne fait pas avancer le `main` LOCAL : un `git commit --only` suivant partirait d'un `main` en retard, son `git push origin main` serait refusé, ou pousserait les commits locaux d'une autre session. La liste des chemins se construit depuis ce qu'on a touché soi-même, jamais depuis `git status`, et l'intrus se cherche dans le DIFF, pas dans la liste. Fichier de câblage partagé (`src/index.ts`, `src/server.ts`, `src/worker.ts`) : annoncer l'édition aux autres sessions (`ListAgents` puis `SendMessage`) AVANT d'y toucher, et prévenir de chaque poussée. Chaque message de commit se termine par la ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Migrations** : le numéro se prend AU MOMENT D'ÉCRIRE (`ls db/migrations | tail -1`, le DOSSIER tranche sur ce qui est pris) ; ligne du compteur de `CLAUDE.md` mise à jour DANS le commit qui prend le numéro ; migration additive, appliquée AVANT le déploiement du code qui l'écrit, relue en base juste après `migrate`. Fichier SQL en ASCII, sans accent grave (backtick) dans les commentaires.

### Procédure de commit P (TOUS les commits de ce lot)

🔴 L'arbre de travail et l'index sont PARTAGÉS par plusieurs sessions, qui ont parfois des commits locaux non poussés. Chaque commit de ce lot se construit donc sur `origin/main`, par un index temporaire, sans toucher ni l'index partagé, ni l'arbre, ni le `main` local. Le commit ne peut PAS emporter ce qu'on n'a pas nommé, et rien ne dépend du temps qui passe entre la relecture et le commit. (Même procédure que le lot 1.)

1. Relire SES hunks contre `origin`, et chercher l'INTRUS dans le diff (une ligne d'une autre session DANS un de ses fichiers), pas dans la liste des chemins :

```bash
cd /c/Users/julie/messagingme-mba && git fetch -q origin && git diff origin/main -- <chemins de la tâche> && git status --porcelain -- <chemins de la tâche>
```

Si un hunk n'est pas de ce lot : appliquer P' à ce fichier.

2. Écrire le message de commit avec l'outil Write dans un fichier temporaire (pas de heredoc long, qui échoue en silence ici), `$M` ci-dessous. Sa dernière ligne est `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

3. Construire et pousser, dans UN SEUL appel (le titre relu et le contenu du commit s'affichent à côté du résultat) :

```bash
cd /c/Users/julie/messagingme-mba && M='<chemin du fichier de message>' && head -1 "$M" \
 && export GIT_INDEX_FILE="$(cygpath -m "$(mktemp -u)")" \
 && git read-tree origin/main \
 && for f in <chemins créés ou modifiés par la tâche>; do git update-index --add --cacheinfo "100644,$(git hash-object -w --path="$f" "$f"),$f"; done \
 && git diff --cached origin/main --stat \
 && { set -o pipefail; git diff --cached origin/main | gitleaks stdin --no-banner; } \
 && C="$(git commit-tree "$(git write-tree)" -p origin/main -F "$M")" \
 && git push origin "$C":main; rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

- Un fichier SUPPRIMÉ par la tâche : ajouter, avant `git diff --cached`, `&& git update-index --force-remove -- <fichier>`.
- `git diff --cached origin/main --stat` doit lister EXACTEMENT les chemins de la tâche, et rien d'autre.
- Push refusé (une autre session a poussé entre le `fetch` et le `push`) : recommencer aux étapes 1 et 3, jamais `git pull` ni `git merge` dans l'arbre partagé.
- ⚠️ `commit-tree` ne déclenche aucun hook : `gitleaks` est lancé à la main ci-dessus, sur EXACTEMENT ce qui part (le diff de l'index temporaire contre `origin/main`, comme au lot 1). 🔴 Pas `gitleaks git --staged` : il compare l'index au HEAD LOCAL, que la plomberie ne fait jamais avancer et qui porte les commits non poussés d'autres sessions. Le hook `rayon-de-souffle` ne tourne pas ; la section « Rayon de souffle » de ce plan et `/revue` en tiennent lieu. Le dépôt local ne bouge pas : ni `git reset`, ni `git checkout`, ni `update-ref` sur l'arbre partagé.
- Après le push : prévenir les autres sessions (`SendMessage`) en nommant les fichiers communs touchés, puis `gh run list --limit 3` et `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'`, job par job.

### Procédure P' (fichier que d'autres sessions modifient aussi : `CLAUDE.md`, `documentation.md`, `src/index.ts`, ou tout fichier dont `git diff origin/main` montre un hunk étranger)

1. Faire SA modification dans l'arbre (outil Edit, le plus petit remplacement possible), pour que l'arbre et les tests locaux la voient.
2. Construire le blob depuis `origin` : `B="$(cygpath -m "$(mktemp)")" && git show origin/main:<fichier> > "$B"`, appliquer LE MÊME remplacement à `"$B"` (outil Edit sur ce chemin absolu), puis, dans la boucle de P, sortir `<fichier>` de la liste et ajouter après elle `&& git update-index --add --cacheinfo "100644,$(git hash-object -w --path=<fichier> "$B"),<fichier>"`.
3. Avant `commit-tree`, avec `GIT_INDEX_FILE` exporté : `git diff --cached origin/main -- <fichier>` ne doit montrer QUE son remplacement.

## Carte des fichiers

| Fichier | Rôle | Tâche |
|---|---|---|
| `src/workflow/engine.ts` | `scanOpening(graph, depuis?)` | 1 |
| `src/workflow/ouverture-api.ts` (neuf) | `OuvertureApi`, `ouvertureApi(graph, depuis?)` | 1 |
| `tests/api-garde-codes.test.ts` (lot 1, relu), `src/auth/rate-limit.ts` (un commentaire, s'il est resté faux) | vérifier les codes du garde commun posés par le lot 1 | 2 |
| `db/migrations/<N>_idempotence_empreinte.sql` (neuf) | `api_idempotency.request_hash` | 3 |
| `src/api/idempotence.ts` (neuf) | `cleIdempotence`, `empreinteCorps` | 3 |
| `src/api/idempotency-store.pg.ts` | `claim(tenant, key, empreinte)`, `verdictLigne` | 3 |
| `src/api/modele-envoi.ts` (neuf), `src/workflow/wiring.ts` | `verdictModele` ; `TplInfo.statut` et `.langue` | 4 |
| `src/campaign/build.ts`, `src/campaign/store.pg.ts` | `ContactEnvoi` ; `listContactsPourEnvoiApi`, `lireEnvoiApi`, `EnvoiApiBrut` | 5 |
| `src/api/sends-build.ts` | `marquerDoublons`, `trierDestinataires`, `construireDestinataires` | 6, 8 |
| `src/api/forme.ts` (neuf), `src/api/suivi-envoi.ts` (neuf) | `messageDeForme` ; `formaterSuiviEnvoi` | 7 |
| `src/http/v1-sends.ts` | route réécrite (POST et GET) | 3, 8 |
| `src/api/consentement.ts`, `src/api/contacts-v1.ts` (lot 1) | `depsConsentementDe`, UNE construction du consentement partagée par `/v1/contacts` et `/v1/sends` | 8 |
| `src/campaign/build.ts`, `tests/campaign-build.test.ts`, `src/crm/contact-store.pg.ts`, `src/campaign/engine.ts`, `src/workflow/executor.ts`, `documentation.md` | commentaires qui nomment l'ancien contrat | 8 |
| `src/http/v1-messages.ts` | `POST /v1/messages/whatsapp` | 9 |
| `src/index.ts` | câblage `v1.sends` et `v1.messages` | 3, 8, 9 |

---

### Task 1: Ce qui part en premier, depuis l'entrée ou depuis un bloc

**Files:**
- Modify: `src/workflow/engine.ts:124-135` (docblock et en-tête de `scanOpening`)
- Create: `src/workflow/ouverture-api.ts`
- Test: `tests/ouverture-api.test.ts` (neuf) ; non modifiés et qui doivent rester verts : `tests/workflow-ouverture.test.ts`, `tests/web-campaign-eligibility.test.ts`

**Interfaces:**
- Consumes: `scanOpening`, `entryNode` (`src/workflow/engine.ts`), `WorkflowGraph` (`src/workflow/graph.ts`), `canalDOuverture` (`src/workflow/store.pg.ts`, dans le test de parité seulement).
- Produces:
  - `export function scanOpening(graph: WorkflowGraph, depuis?: string): OpeningScan` (sans `depuis` : comportement actuel, inchangé)
  - `export type OuvertureApi = 'whatsapp_template' | 'whatsapp_session' | 'rcs'`
  - `export type VerdictOuverture = { ouverture: OuvertureApi } | { ouverture: null; raison: string }`
  - `export function ouvertureApi(graph: WorkflowGraph, depuis?: string): VerdictOuverture`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/ouverture-api.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { ouvertureApi } from '../src/workflow/ouverture-api';
import { scanOpening, entryNode } from '../src/workflow/engine';
import { canalDOuverture } from '../src/workflow/store.pg';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '../src/workflow/graph';

/**
 * CE QU'UN ENVOI PAR L'API FAIT PARTIR EN PREMIER (spec 2026-09-24, § 3, défaut 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : une cible `node` était jugée sur le TYPE du bloc visé (`exigeFenetre24h`).
 * Une condition, une étiquette ou un champ qui mène à un message rapide ne demandait aucune fenêtre, et le
 * message partait vers des gens qui n'avaient pas écrit (Meta 131047). Ce qui compte est ce qui PART.
 *
 * ⚠️ La parité avec la console est gardée ici : `whatsapp_template` et `rcs` valent le canal de
 * `canalDOuverture`, `whatsapp_session` et `null` y valent « pas de campagne ».
 */
const n = (id: string, type: WorkflowNode['type'], data: Record<string, unknown> = {}): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, data });
const a = (id: string, source: string, target: string, sourceHandle?: string): WorkflowEdge => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const g = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowGraph => ({ nodes, edges });

const TEMPLATE = n('t', 'template', { templateName: 'promo' });
const RCS = n('r', 'rcs_message', { text: 'Bonjour' });
const MESSAGE_RAPIDE = n('q', 'quick_message', { body: 'On en parle ?' });
const QUESTION = n('qu', 'question', { body: 'Quel créneau ?' });
const FORMULAIRE = n('f', 'flow', { flowId: 'flow-1' });
const AGENT = n('ag', 'agent', { agentId: 'agent-1' });
const SESSIONS = [MESSAGE_RAPIDE, QUESTION, FORMULAIRE, AGENT];

describe('ouvertureApi depuis l’entrée (cible scénario)', () => {
  it('un template nommé ouvre en whatsapp_template, un bloc RCS configuré en rcs', () => {
    expect(ouvertureApi(g([TEMPLATE]))).toEqual({ ouverture: 'whatsapp_template' });
    expect(ouvertureApi(g([RCS]))).toEqual({ ouverture: 'rcs' });
  });

  it('un message de SESSION ouvre en whatsapp_session, quel que soit son bloc', () => {
    for (const b of SESSIONS) expect(ouvertureApi(g([b])), b.type).toEqual({ ouverture: 'whatsapp_session' });
  });

  it('🔴 un scénario jamais publié (graphe publié vide) ne part pas, et la raison le dit', () => {
    const v = ouvertureApi(g([]));
    if (v.ouverture !== null) throw new Error('attendu : aucune ouverture');
    expect(v.raison).toMatch(/publi/);
  });

  it('rien ne part : attente avant tout envoi, deux templates possibles, template sans nom, aucun envoi', () => {
    const cas: Array<[string, WorkflowGraph]> = [
      ['attente puis template', g([n('w', 'wait', { seconds: 60 }), TEMPLATE], [a('e', 'w', 't')])],
      ['deux templates', g([n('c', 'condition'), n('t1', 'template', { templateName: 'a' }), n('t2', 'template', { templateName: 'b' })], [a('e1', 'c', 't1', 'true'), a('e2', 'c', 't2', 'false')])],
      ['template sans nom', g([n('t', 'template', { templateName: '  ' })])],
      ['une étiquette seule', g([n('x', 'action', { actionKind: 'add_tag', tag: 'vip' })])],
    ];
    for (const [nom, graphe] of cas) {
      const v = ouvertureApi(graphe);
      if (v.ouverture !== null) throw new Error(`${nom} : attendu aucune ouverture`);
      expect(v.raison, nom).not.toBe('');
    }
  });

  it('⚠️ prudence : si UNE branche envoie un message de session, c’est whatsapp_session pour tous', () => {
    const graphe = g([n('c', 'condition'), TEMPLATE, MESSAGE_RAPIDE], [a('e1', 'c', 't', 'true'), a('e2', 'c', 'q', 'false')]);
    expect(ouvertureApi(graphe)).toEqual({ ouverture: 'whatsapp_session' });
  });
});

describe('ouvertureApi depuis un bloc (cible node)', () => {
  it('🔴 défaut 3 : une CONDITION qui mène à un message rapide exige la fenêtre', () => {
    const graphe = g([n('c', 'condition'), MESSAGE_RAPIDE], [a('e', 'c', 'q', 'true')]);
    expect(ouvertureApi(graphe, 'c')).toEqual({ ouverture: 'whatsapp_session' });
  });

  it('🔴 défaut 3 : une ÉTIQUETTE ou un CHAMP qui mène à un message rapide aussi', () => {
    const tag = g([n('x', 'action', { actionKind: 'add_tag', tag: 'vip' }), MESSAGE_RAPIDE], [a('e', 'x', 'q')]);
    const champ = g([n('x', 'action', { actionKind: 'set_field', fieldKey: 'ville', value: 'Lyon' }), MESSAGE_RAPIDE], [a('e', 'x', 'q')]);
    expect(ouvertureApi(tag, 'x')).toEqual({ ouverture: 'whatsapp_session' });
    expect(ouvertureApi(champ, 'x')).toEqual({ ouverture: 'whatsapp_session' });
  });

  it('le DÉPART décide : un template placé après un message de session ouvre en template quand on le vise', () => {
    const graphe = g([MESSAGE_RAPIDE, TEMPLATE], [a('e', 'q', 't')]);
    expect(ouvertureApi(graphe)).toEqual({ ouverture: 'whatsapp_session' });
    expect(ouvertureApi(graphe, 't')).toEqual({ ouverture: 'whatsapp_template' });
  });

  it('les cas de l’ancien jugement par TYPE (exigeFenetre24h) sont conservés', () => {
    for (const b of SESSIONS) expect(ouvertureApi(g([b]), b.id).ouverture, b.type).toBe('whatsapp_session');
    expect(ouvertureApi(g([TEMPLATE]), 't').ouverture).toBe('whatsapp_template');
    expect(ouvertureApi(g([RCS]), 'r').ouverture).toBe('rcs');
    // L'ancien « type null » (bloc qu'on n'a pas su relire) exigeait la fenêtre par prudence ; un bloc
    // introuvable ne part plus du tout, ce qui est plus prudent encore.
    expect(ouvertureApi(g([TEMPLATE]), 'inconnu').ouverture).toBeNull();
  });

  it('⚠️ un bloc « Envoi de mail » seul ne fait partir ni WhatsApp ni RCS : refusé', () => {
    const mail = n('m', 'email', { emailAccountId: 'b1', templateId: 'm1', to: [{ kind: 'literal', value: 'a@exemple.fr' }] });
    expect(ouvertureApi(g([mail]), 'm').ouverture).toBeNull();
  });

  it('un bloc suivi d’une attente avant tout envoi : refusé', () => {
    const graphe = g([n('w', 'wait', { seconds: 60 }), TEMPLATE], [a('e', 'w', 't')]);
    expect(ouvertureApi(graphe, 'w').ouverture).toBeNull();
  });
});

describe('scanOpening : sans point de départ, rien ne change', () => {
  it('partir explicitement de l’entrée rend exactement l’examen d’aujourd’hui', () => {
    const graphes = [
      g([]),
      g([TEMPLATE]),
      g([MESSAGE_RAPIDE, TEMPLATE], [a('e', 'q', 't')]),
      g([RCS, TEMPLATE], [a('e', 'r', 't', 'unreachable')]),
    ];
    for (const graphe of graphes) expect(scanOpening(graphe, entryNode(graphe) ?? undefined)).toEqual(scanOpening(graphe));
  });
});

describe('🔴 parité avec la console (canalDOuverture)', () => {
  it('whatsapp_template vaut whatsapp, rcs vaut rcs, whatsapp_session et aucune ouverture valent null', () => {
    const cas: Array<[string, WorkflowGraph]> = [
      ['template nommé', g([TEMPLATE])],
      ['template sans nom', g([n('t', 'template', { templateName: ' ' })])],
      ['RCS configuré', g([RCS])],
      ['RCS vide', g([n('r', 'rcs_message', { text: ' ' })])],
      ['message rapide', g([MESSAGE_RAPIDE])],
      ['agent', g([AGENT])],
      ['graphe vide', g([])],
      ['attente puis template', g([n('w', 'wait', { seconds: 60 }), TEMPLATE], [a('e', 'w', 't')])],
      ['étiquette puis template', g([n('x', 'action', { actionKind: 'add_tag', tag: 'v' }), TEMPLATE], [a('e', 'x', 't')])],
      ['RCS puis template de repli', g([RCS, TEMPLATE], [a('e', 'r', 't', 'unreachable')])],
      ['deux templates', g([n('c', 'condition'), n('t1', 'template', { templateName: 'a' }), n('t2', 'template', { templateName: 'b' })], [a('e1', 'c', 't1', 'true'), a('e2', 'c', 't2', 'false')])],
      ['condition : template ou message rapide', g([n('c', 'condition'), TEMPLATE, MESSAGE_RAPIDE], [a('e1', 'c', 't', 'true'), a('e2', 'c', 'q', 'false')])],
    ];
    for (const [nom, graphe] of cas) {
      const v = ouvertureApi(graphe).ouverture;
      const attendu = v === 'whatsapp_template' ? 'whatsapp' : v === 'rcs' ? 'rcs' : null;
      expect(canalDOuverture(graphe), nom).toBe(attendu);
    }
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/ouverture-api.test.ts`
Expected: FAIL, « Failed to resolve import "../src/workflow/ouverture-api" ».

- [ ] **Step 3: Donner un point de départ à `scanOpening`**

Dans `src/workflow/engine.ts`, remplacer les lignes 124 à 135 :

```ts
/**
 * Explore, depuis l'entrée, tout ce qui est atteignable AVANT le premier envoi. Les blocs synchrones
 * (tag / field / action) sont traversés, un bloc `condition` explore ses DEUX sorties, `template` et `inbox`
 * arrêtent l'exploration de leur branche.
 *
 * En LARGEUR (file, pas pile) : « le premier template » doit être le plus proche de l'entrée, sinon le mapping
 * de variables d'une campagne viserait un template arbitraire selon l'ordre d'insertion des blocs.
 */
export function scanOpening(graph: WorkflowGraph): OpeningScan {
  const out: OpeningScan = { sessionOpen: false, rcsOpen: false, firstTemplate: null, ambiguousTemplate: false, waitBeforeTemplate: false, unnamedOpeningTemplate: false };
  const entry = entryNode(graph);
  if (!entry) return out;
```

par :

```ts
/**
 * Explore, depuis l'entrée, tout ce qui est atteignable AVANT le premier envoi. Les blocs synchrones
 * (tag / field / action) sont traversés, un bloc `condition` explore ses DEUX sorties, `template` et `inbox`
 * arrêtent l'exploration de leur branche.
 *
 * En LARGEUR (file, pas pile) : « le premier template » doit être le plus proche de l'entrée, sinon le mapping
 * de variables d'une campagne viserait un template arbitraire selon l'ordre d'insertion des blocs.
 *
 * `depuis` : le bloc d'où partir, pour la cible `node` de l'API publique (`ouvertureApi`). Absent, on part de
 * l'entrée : c'est l'appel de la création de campagne, de la liste des scénarios, du sélecteur de l'Inbox et
 * de l'éditeur, et il ne change pas. Un `depuis` absent du graphe rend un examen vide : rien n'ouvre.
 */
export function scanOpening(graph: WorkflowGraph, depuis?: string): OpeningScan {
  const out: OpeningScan = { sessionOpen: false, rcsOpen: false, firstTemplate: null, ambiguousTemplate: false, waitBeforeTemplate: false, unnamedOpeningTemplate: false };
  const entry = depuis ?? entryNode(graph);
  if (!entry) return out;
```

- [ ] **Step 4: Écrire `ouvertureApi`**

Créer `src/workflow/ouverture-api.ts` :

```ts
import type { WorkflowGraph } from './graph';
import { scanOpening } from './engine';

/**
 * CE QU'UN ENVOI PAR L'API FAIT PARTIR EN PREMIER, depuis l'entrée d'un scénario ou depuis un bloc.
 *
 * 🔴 UNE SEULE FONCTION JUGE LE SCÉNARIO ET LE BLOC. Elle remplace `exigeFenetre24h`, qui jugeait une cible
 * `node` sur le TYPE du bloc visé : une condition, une étiquette ou un champ qui mène à un message rapide ne
 * demandait aucune fenêtre, et le message partait vers des gens qui n'avaient pas écrit (Meta 131047).
 *
 * Elle repose sur `scanOpening`, le même examen que la console (`canalDOuverture`, la création de campagne) :
 * `whatsapp_template` et `rcs` y correspondent exactement, `whatsapp_session` et `null` y valent « pas de
 * campagne ». La parité est gardée par `tests/ouverture-api.test.ts`.
 *
 * ⚠️ PRUDENCE : si UNE branche peut envoyer un message de session, c'est `whatsapp_session`, et la fenêtre sera
 * exigée de TOUS les destinataires : on ne sait pas d'avance quelle branche un contact prendra.
 *
 * ⚠️ UN GRAPHE VIDE EST UN SCÉNARIO JAMAIS PUBLIÉ. Un envoi joue `workflows.graph`, le publié ; un brouillon
 * seul n'a rien à jouer. `published_at` n'en décide pas : il vaut null sur les scénarios publiés avant
 * l'arrivée du bouton « Publier » (migration 0095).
 */
export type OuvertureApi = 'whatsapp_template' | 'whatsapp_session' | 'rcs';

export type VerdictOuverture = { ouverture: OuvertureApi } | { ouverture: null; raison: string };

export function ouvertureApi(graph: WorkflowGraph, depuis?: string): VerdictOuverture {
  if (graph.nodes.length === 0) {
    return { ouverture: null, raison: 'le scénario n’a aucun bloc publié : publiez-le avant de l’envoyer' };
  }
  if (depuis !== undefined && !graph.nodes.some((n) => n.id === depuis)) {
    return { ouverture: null, raison: 'le bloc de départ n’existe pas dans le scénario publié' };
  }
  const scan = scanOpening(graph, depuis);
  if (scan.waitBeforeTemplate) {
    return { ouverture: null, raison: 'une attente précède le premier envoi : rien ne partirait au lancement' };
  }
  if (scan.ambiguousTemplate) {
    return { ouverture: null, raison: 'plusieurs templates différents peuvent ouvrir : impossible de savoir lequel part' };
  }
  if (scan.unnamedOpeningTemplate) {
    return { ouverture: null, raison: 'un template d’ouverture n’a pas encore de modèle choisi' };
  }
  if (scan.sessionOpen) return { ouverture: 'whatsapp_session' };
  if (scan.rcsOpen) return { ouverture: 'rcs' };
  if (scan.firstTemplate && String(scan.firstTemplate.data.templateName ?? '').trim() !== '') {
    return { ouverture: 'whatsapp_template' };
  }
  return { ouverture: null, raison: 'rien ne part : ni template, ni bloc RCS, ni message avant la fin du parcours' };
}
```

- [ ] **Step 5: Le voir passer, et les voisins rester verts**

Run: `npx vitest run tests/ouverture-api.test.ts tests/workflow-ouverture.test.ts tests/web-campaign-eligibility.test.ts`
Expected: PASS, les trois fichiers.

- [ ] **Step 6: Vérifier le test du point de départ dans les deux sens**

Dans `src/workflow/engine.ts`, remplacer temporairement `const entry = depuis ?? entryNode(graph);` par `const entry = entryNode(graph);`.
Run: `npx vitest run tests/ouverture-api.test.ts`
Expected: FAIL sur « le DÉPART décide » (reçu `{ ouverture: 'whatsapp_session' }`, attendu `whatsapp_template`).
Restaurer `const entry = depuis ?? entryNode(graph);`, relancer : PASS.

- [ ] **Step 7: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur.

Commit par la procédure P. Chemins : `src/workflow/engine.ts src/workflow/ouverture-api.ts tests/ouverture-api.test.ts`. Message :

```
feat(api): ouvertureApi juge ce qui part en premier, depuis l entree ou depuis un bloc

scanOpening gagne un point de depart optionnel ; sans lui, rien ne change pour la console.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 2: Le garde commun porte déjà ses codes (lot 1) : vérifier, ne rien réécrire

**Files:**
- Read: `tests/api-garde-codes.test.ts`, `src/auth/rate-limit.ts`, `src/auth/api-key.ts`, `src/api/usage-guard.ts` (tels que la tâche 2 du lot 1 les laisse)
- Modify (seulement s'il est resté faux) : `src/auth/rate-limit.ts:13-14` (commentaire d'en-tête)

**Interfaces:**
- Consumes: les refus du garde commun posés par le lot 1 : `unauthorized` (401), `missing_scope` (403), `rate_limited` (429), `tenant_locked` (403) sur la surface publique, `{ error }` seul sur la console ; `consommerAvecEntetes(limiteur, cle, reply, message?, code?: CodeApi)` et `consommerEnSilence(limiteur, cle, reply, message?, code?: CodeApi)`.
- Produces: rien de neuf. Les tests de route des tâches 8 et 9 exigent `unauthorized` et `missing_scope` : ils reposent sur ce que cette tâche constate.

🔴 **POURQUOI UNE VÉRIFICATION, ET PAS UNE RÉÉCRITURE** : la tâche 2 du lot 1 pose déjà ces codes, avec un `code` FACULTATIF pour que la console garde ses refus `{ error }` seuls. Les réécrire ici (un `code: 'rate_limited'` en dur dans `refuserTropDeRequetes`) écraserait sa signature, casserait le typecheck, et ferait tomber `tests/rate-limit-utilisateur.test.ts`, qui affirme `toEqual({ error: … })` sur un refus de la CONSOLE.

- [ ] **Step 1: Constater que les codes sont là**

Run: `cd /c/Users/julie/messagingme-mba && grep -n "code?: CodeApi" src/auth/rate-limit.ts && grep -n "'unauthorized'\|'missing_scope'\|'rate_limited'" src/auth/api-key.ts src/api/usage-guard.ts`
Expected: `consommerAvecEntetes`, `consommerEnSilence` et `refuserTropDeRequetes` portent `code?: CodeApi` ; `api-key.ts` et `usage-guard.ts` nomment les trois codes. Si rien ne sort, le lot 1 n'est pas livré : S'ARRÊTER (c'est un prérequis de ce lot) et ne rien écrire dans ces fichiers.

- [ ] **Step 2: Les tests du garde, et celui de la console, verts**

Run: `npx vitest run tests/api-garde-codes.test.ts tests/rate-limit-utilisateur.test.ts tests/api-key-middleware.test.ts tests/api-usage-observation.test.ts`
Expected: PASS. `tests/rate-limit-utilisateur.test.ts` vert prouve que le code ne fuit pas dans les refus de la console.

- [ ] **Step 3: Le commentaire d'en-tête de `src/auth/rate-limit.ts`**

Run: `grep -n "le seul import de" src/auth/rate-limit.ts; grep -c "^import" src/auth/rate-limit.ts`
Le commentaire (l. 13-14 aujourd'hui) dit « le seul import de ce fichier est un `import type` ». Le lot 1 y ajoute `import type { CodeApi } from '../api/erreurs';` : la phrase devient fausse (deux imports) alors que son sens (aucune dépendance de RUNTIME) reste vrai. Si le premier `grep` sort une ligne ET que le second compte 2 ou plus, remplacer :

```ts
 * requêtes d'une même fenêtre suffisent à saturer le pool sans jamais franchir le plafond affiché. Aucune dépendance de RUNTIME : le seul import de
 * ce fichier est un `import type`, effacé à la compilation. À garder ainsi, pour que le limiteur reste
```

par :

```ts
 * requêtes d'une même fenêtre suffisent à saturer le pool sans jamais franchir le plafond affiché. Aucune dépendance de RUNTIME : ce
 * fichier n'a que des `import type`, effacés à la compilation. À garder ainsi, pour que le limiteur reste
```

Sinon (le lot 1 l'a déjà reformulé, ou le fichier n'a qu'un import) : ne rien changer.

- [ ] **Step 4: Typecheck et commit, seulement si l'étape 3 a changé le commentaire**

Run: `npm run typecheck`
Expected: aucune erreur.

Commit par la procédure P. Chemins : `src/auth/rate-limit.ts`. Message :

```
docs(auth): rate-limit n a que des import type, et plus un seul

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 3: Idempotence, la clé en en-tête ou dans le corps, l'empreinte gardée

**Files:**
- Create: `db/migrations/<N>_idempotence_empreinte.sql` (N = prochain numéro libre, pris à l'étape 1)
- Create: `src/api/idempotence.ts`
- Modify: `src/api/idempotency-store.pg.ts` (tout le fichier)
- Modify: `src/http/v1-sends.ts:1-15` (imports), `:70` (dépendance), `:100-102` (clé), `:178-181` (claim)
- Modify: `src/index.ts:3113` (câblage partagé : annoncer avant)
- Modify: `CLAUDE.md` (ligne du compteur de migrations, section Déploiement)
- Test: `tests/api-idempotence.test.ts` (neuf), `tests/v1-sends.test.ts` (fixture d'idempotence et cas neufs), `tests/integration/stores.integration.test.ts:2025-2046`

**Interfaces:**
- Consumes: `refuser`, `CodeApi` (lot 1), `sha256Hex` (`src/lib/signature.ts`).
- Produces:
  - `export const CLE_IDEMPOTENCE_MAX = 255`
  - `export type CleIdempotence = { ok: true; cle: string } | { ok: false; code: 'idempotency_key_required' | 'invalid_body'; message: string }`
  - `export function cleIdempotence(entete: string | string[] | undefined, corps: unknown): CleIdempotence`
  - `export function empreinteCorps(corps: unknown): string`
  - `export type IdempotencyClaim = { claimed: true } | { claimed: false; pending: true } | { claimed: false; reused: true } | { claimed: false; sendId: string; response: unknown }`
  - `export interface LigneIdempotence { send_id: string | null; response: unknown; request_hash: string | null }`
  - `export function verdictLigne(r: LigneIdempotence | undefined, empreinte: string): IdempotencyClaim`
  - `PgApiIdempotencyStore.claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>`
  - `V1SendsRouteDeps.idempotencyClaim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>`

- [ ] **Step 1: Prendre le numéro de migration et écrire la migration**

Run: `ls db/migrations | tail -1`
Le numéro suivant est N (le DOSSIER tranche sur ce qui est pris). Créer `db/migrations/<N>_idempotence_empreinte.sql` :

```sql
-- <N>_idempotence_empreinte.sql : l'EMPREINTE du corps d'un envoi par l'API, gardee avec sa cle d'idempotence.
--
-- POURQUOI : la meme cle avec un AUTRE corps rejouait en silence le rapport du premier envoi. L'appelant
-- croyait le sien parti. Avec l'empreinte, ce cas est refuse (idempotency_key_reused).
--
-- PUREMENT ADDITIVE : une colonne nullable, sans defaut, sans index. L'ancien code l'ignore ; le code neuf
-- l'ECRIT a chaque claim, donc elle passe AVANT le deploiement.
--
-- null = une ligne d'avant cette migration : elle rejoue son rapport comme aujourd'hui, et disparait avec la
-- purge des 24 h (sweepOlderThan, worker).
alter table api_idempotency add column if not exists request_hash text;
```

(Remplacer `<N>` par le numéro réel, dans le nom du fichier ET dans la première ligne.)

- [ ] **Step 2: Écrire les tests purs qui échouent**

Créer `tests/api-idempotence.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { cleIdempotence, empreinteCorps, CLE_IDEMPOTENCE_MAX } from '../src/api/idempotence';
import { verdictLigne } from '../src/api/idempotency-store.pg';

/**
 * L'IDEMPOTENCE D'UN ENVOI PAR L'API (spec 2026-09-24, § 3 « Idempotence »).
 *
 * 🔴 LE CAS QUI JUSTIFIE CE FICHIER : la même clé avec un AUTRE corps rejouait en silence le rapport du
 * premier envoi. `verdictLigne` est la décision du magasin, testée ici sans base.
 */
describe('cleIdempotence', () => {
  it('en-tête seul', () => {
    expect(cleIdempotence('k1', {})).toEqual({ ok: true, cle: 'k1' });
  });

  it('corps seul : un outil qui appelle une adresse par contact remplit son corps, pas toujours ses en-têtes', () => {
    expect(cleIdempotence(undefined, { idempotencyKey: 'k2' })).toEqual({ ok: true, cle: 'k2' });
  });

  it('les deux, identiques aux espaces près : acceptée', () => {
    expect(cleIdempotence(' k3 ', { idempotencyKey: 'k3' })).toEqual({ ok: true, cle: 'k3' });
  });

  it('🔴 les deux, DIFFÉRENTES : invalid_body, jamais un choix silencieux', () => {
    expect(cleIdempotence('k4', { idempotencyKey: 'k5' })).toMatchObject({ ok: false, code: 'invalid_body' });
  });

  it('aucune, ou vide : idempotency_key_required', () => {
    expect(cleIdempotence(undefined, {})).toMatchObject({ ok: false, code: 'idempotency_key_required' });
    expect(cleIdempotence('   ', { idempotencyKey: '' })).toMatchObject({ ok: false, code: 'idempotency_key_required' });
    expect(cleIdempotence(undefined, null)).toMatchObject({ ok: false, code: 'idempotency_key_required' });
  });

  it('en-tête répété : la première valeur', () => {
    expect(cleIdempotence(['k6', 'k7'], {})).toEqual({ ok: true, cle: 'k6' });
  });

  it('une clé de corps qui n’est pas un texte, ou trop longue : invalid_body', () => {
    expect(cleIdempotence(undefined, { idempotencyKey: 42 })).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(cleIdempotence('x'.repeat(CLE_IDEMPOTENCE_MAX + 1), {})).toMatchObject({ ok: false, code: 'invalid_body' });
  });
});

describe('empreinteCorps', () => {
  it('l’ordre des clés d’objet ne compte pas', () => {
    expect(empreinteCorps({ a: 1, b: { c: 2, d: 3 } })).toBe(empreinteCorps({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('🔴 la clé d’idempotence n’entre PAS dans l’empreinte : en-tête ou corps, même demande', () => {
    expect(empreinteCorps({ a: 1, idempotencyKey: 'x' })).toBe(empreinteCorps({ a: 1 }));
  });

  it('l’ordre des destinataires COMPTE : c’est leur index que le rapport rend', () => {
    expect(empreinteCorps({ r: [1, 2] })).not.toBe(empreinteCorps({ r: [2, 1] }));
  });

  it('un autre destinataire, une autre empreinte', () => {
    expect(empreinteCorps({ r: [{ contactId: 'a' }] })).not.toBe(empreinteCorps({ r: [{ contactId: 'b' }] }));
  });

  it('un corps absent a une empreinte stable', () => {
    expect(empreinteCorps(undefined)).toBe(empreinteCorps(null));
  });
});

describe('verdictLigne : ce que vaut une clé déjà posée', () => {
  it('🔴 même clé, AUTRE empreinte : reused, que le calcul soit fini ou non', () => {
    expect(verdictLigne({ send_id: 's1', response: { a: 1 }, request_hash: 'h1' }, 'h2')).toEqual({ claimed: false, reused: true });
    expect(verdictLigne({ send_id: null, response: null, request_hash: 'h1' }, 'h2')).toEqual({ claimed: false, reused: true });
  });

  it('même empreinte : en cours pendant le calcul, rejeu du rapport après', () => {
    expect(verdictLigne({ send_id: null, response: null, request_hash: 'h1' }, 'h1')).toEqual({ claimed: false, pending: true });
    expect(verdictLigne({ send_id: 's1', response: { a: 1 }, request_hash: 'h1' }, 'h1')).toEqual({ claimed: false, sendId: 's1', response: { a: 1 } });
  });

  it('ligne d’avant la migration (empreinte nulle) : rejeu comme aujourd’hui', () => {
    expect(verdictLigne({ send_id: 's1', response: { a: 1 }, request_hash: null }, 'h9')).toEqual({ claimed: false, sendId: 's1', response: { a: 1 } });
  });

  it('ligne disparue entre l’insertion et la lecture : en cours, le client réessaie', () => {
    expect(verdictLigne(undefined, 'h1')).toEqual({ claimed: false, pending: true });
  });
});
```

- [ ] **Step 3: Les voir échouer**

Run: `npx vitest run tests/api-idempotence.test.ts`
Expected: FAIL, « Failed to resolve import "../src/api/idempotence" ».

- [ ] **Step 4: Écrire `src/api/idempotence.ts`**

```ts
import { sha256Hex } from '../lib/signature';

/**
 * L'IDEMPOTENCE D'UN ENVOI PAR L'API : quelle clé, et quelle empreinte (spec 2026-09-24, § 3).
 *
 * 🔴 LA CLÉ SE DONNE EN EN-TÊTE (`Idempotency-Key`) OU DANS LE CORPS (`idempotencyKey`). Un outil qui appelle
 * une adresse PAR CONTACT remplit son corps avec les données du contact, et rien ne garantit qu'il en fasse
 * autant pour ses en-têtes : exiger l'en-tête lui interdirait une clé par contact. Les deux présentes et
 * différentes : refus, jamais un choix silencieux entre les deux.
 *
 * 🔴 L'EMPREINTE DU CORPS EST GARDÉE AVEC LA CLÉ (`api_idempotency.request_hash`) : la même clé avec un AUTRE
 * corps est refusée au lieu de rejouer en silence le rapport du premier envoi.
 */

/** La borne d'une clé : de quoi porter un identifiant, une étape et une date, pas un document. */
export const CLE_IDEMPOTENCE_MAX = 255;

export type CleIdempotence =
  | { ok: true; cle: string }
  | { ok: false; code: 'idempotency_key_required' | 'invalid_body'; message: string };

export function cleIdempotence(entete: string | string[] | undefined, corps: unknown): CleIdempotence {
  const brute = Array.isArray(entete) ? entete[0] : entete;
  const enTete = typeof brute === 'string' && brute.trim() !== '' ? brute.trim() : null;
  const valeur = corps !== null && typeof corps === 'object' && 'idempotencyKey' in corps ? corps.idempotencyKey : undefined;
  if (valeur !== undefined && typeof valeur !== 'string') {
    return { ok: false, code: 'invalid_body', message: 'idempotencyKey : texte attendu' };
  }
  const dansCorps = typeof valeur === 'string' && valeur.trim() !== '' ? valeur.trim() : null;
  if (enTete !== null && dansCorps !== null && enTete !== dansCorps) {
    return { ok: false, code: 'invalid_body', message: 'la clé d’idempotence de l’en-tête et celle du corps diffèrent : n’en donner qu’une, ou la même' };
  }
  const cle = enTete ?? dansCorps;
  if (cle === null) {
    return { ok: false, code: 'idempotency_key_required', message: 'clé d’idempotence requise : en-tête Idempotency-Key ou champ idempotencyKey du corps' };
  }
  if (cle.length > CLE_IDEMPOTENCE_MAX) {
    return { ok: false, code: 'invalid_body', message: `clé d’idempotence : ${CLE_IDEMPOTENCE_MAX} caractères au plus` };
  }
  return { ok: true, cle };
}

/** Sérialisation CANONIQUE : clés d'objet triées, récursivement. L'ordre d'un tableau est gardé : il a un sens. */
function canonique(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonique);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonique(x)]),
    );
  }
  return v;
}

/**
 * L'EMPREINTE d'un corps d'envoi : ce qui dit « c'est la MÊME demande ».
 *
 * ⚠️ `idempotencyKey` est RETIRÉE avant le calcul : la même demande passée une fois avec la clé en en-tête, une
 * fois avec la clé dans le corps, doit avoir la même empreinte, sinon le rejeu légitime serait refusé.
 */
export function empreinteCorps(corps: unknown): string {
  const sansCle = corps !== null && typeof corps === 'object' && !Array.isArray(corps)
    ? Object.fromEntries(Object.entries(corps).filter(([k]) => k !== 'idempotencyKey'))
    : corps;
  return sha256Hex(JSON.stringify(canonique(sansCle) ?? null));
}
```

- [ ] **Step 5: Réécrire le magasin avec l'empreinte**

Remplacer tout `src/api/idempotency-store.pg.ts` par :

```ts
import type { Pool } from 'pg';

export type IdempotencyClaim =
  | { claimed: true }
  | { claimed: false; pending: true }
  | { claimed: false; reused: true }
  | { claimed: false; sendId: string; response: unknown };

/** La ligne d'une clé déjà posée, telle que la base la rend. */
export interface LigneIdempotence {
  send_id: string | null;
  response: unknown;
  request_hash: string | null;
}

/**
 * CE QUE VAUT UNE CLÉ DÉJÀ POSÉE, pour le corps qu'on présente. Pure : c'est la décision du magasin, testée
 * sans base (`tests/api-idempotence.test.ts`).
 *
 * 🔴 L'EMPREINTE PASSE AVANT TOUT LE RESTE : une clé qui a servi pour un AUTRE corps est `reused`, que son
 * calcul soit fini ou en cours. Rejouer le rapport du premier ferait croire à l'appelant que le sien est parti.
 *
 * ⚠️ Une ligne d'avant la migration (`request_hash` null) rejoue son rapport comme avant : on ne sait pas ce
 * qu'elle a reçu, et elle disparaît avec la purge des 24 h.
 *
 * ⚠️ Une ligne ABSENTE (libérée par un `release` entre l'insertion ratée et la lecture) vaut « en cours » :
 * le client réessaie, et prendra la clé.
 */
export function verdictLigne(r: LigneIdempotence | undefined, empreinte: string): IdempotencyClaim {
  if (!r) return { claimed: false, pending: true };
  if (r.request_hash !== null && r.request_hash !== empreinte) return { claimed: false, reused: true };
  if (r.send_id === null) return { claimed: false, pending: true };
  return { claimed: false, sendId: r.send_id, response: r.response };
}

/**
 * Idempotence des envois API (clé obligatoire). `claim` pose atomiquement la ligne AVEC l'empreinte du corps
 * (contrainte unique (tenant, key)) : premier arrivé -> `claimed:true` (traiter) ; sinon `verdictLigne` dit
 * `reused` (autre corps, 422), `pending` (calcul en cours, 409 retryable) ou rejoue le rapport. `complete`
 * renseigne send_id + réponse ; `release` défait le claim si le traitement échoue (libère la clé pour un vrai
 * retry). Purge à 24 h par le worker.
 */
export class PgApiIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim> {
    const ins = await this.pool.query<{ id: string }>(
      `insert into api_idempotency (tenant_id, idempotency_key, request_hash) values ($1, $2, $3)
       on conflict (tenant_id, idempotency_key) do nothing
       returning tenant_id as id`,
      [tenantId, key, empreinte],
    );
    if ((ins.rowCount ?? 0) > 0) return { claimed: true };
    const existing = await this.pool.query<LigneIdempotence>(
      `select send_id, response, request_hash from api_idempotency where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, key],
    );
    return verdictLigne(existing.rows[0], empreinte);
  }

  async complete(tenantId: string, key: string, sendId: string, response: unknown): Promise<void> {
    await this.pool.query(
      `update api_idempotency set send_id = $3, response = $4::jsonb where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, key, sendId, JSON.stringify(response)],
    );
  }

  /** Défait un claim resté sans send_id (échec applicatif) pour ne pas bloquer un retry légitime. */
  async release(tenantId: string, key: string): Promise<void> {
    await this.pool.query(
      `delete from api_idempotency where tenant_id = $1 and idempotency_key = $2 and send_id is null`,
      [tenantId, key],
    );
  }

  /** Purge les clés plus vieilles que `ms` (worker). Retourne le nb supprimé. */
  async sweepOlderThan(ms: number): Promise<number> {
    const res = await this.pool.query(
      `delete from api_idempotency where created_at < now() - ($1::bigint || ' milliseconds')::interval`,
      [Math.floor(ms)],
    );
    return res.rowCount ?? 0;
  }
}
```

- [ ] **Step 6: Voir les tests purs passer, et vérifier `reused` dans les deux sens**

Run: `npx vitest run tests/api-idempotence.test.ts`
Expected: PASS.
Mutation : dans `verdictLigne`, supprimer temporairement la ligne `if (r.request_hash !== null && r.request_hash !== empreinte) return { claimed: false, reused: true };`.
Run: `npx vitest run tests/api-idempotence.test.ts`
Expected: FAIL sur « même clé, AUTRE empreinte » (reçu `{ claimed: false, sendId: 's1', … }` puis `{ pending: true }`, attendu `reused`). Restaurer la ligne, relancer : PASS.

- [ ] **Step 7: Écrire les cas de route qui échouent**

Dans `tests/v1-sends.test.ts` :

a) Ajouter aux imports :

```ts
import { verdictLigne } from '../src/api/idempotency-store.pg';
import { empreinteCorps } from '../src/api/idempotence';
```

b) Remplacer la ligne `  const idem = new Map<string, { sendId: string; response: unknown } | 'pending'>();` par :

```ts
  const idem = new Map<string, { hash: string; sendId?: string; response?: unknown }>();
```

c) Remplacer les trois fakes `idempotencyClaim`, `idempotencyComplete`, `idempotencyRelease` par :

```ts
    // Le MÊME verdict que le magasin : c'est sa fonction pure qui décide, la route n'en a pas de copie.
    idempotencyClaim: async (_t, key, empreinte): Promise<IdempotencyClaim> => {
      const ligne = idem.get(key);
      if (!ligne) { idem.set(key, { hash: empreinte }); return { claimed: true }; }
      return verdictLigne({ send_id: ligne.sendId ?? null, response: ligne.response ?? null, request_hash: ligne.hash }, empreinte);
    },
    idempotencyComplete: async (_t, key, sendId, response) => { const l = idem.get(key); if (l) { l.sendId = sendId; l.response = response; } },
    idempotencyRelease: async (_t, key) => { idem.delete(key); },
```

d) Remplacer le test `'claim concurrent (pending) -> 409'` en entier par :

```ts
  it('claim concurrent (pending) -> 409 idempotency_in_progress', async () => {
    const { server, idem } = app();
    const corps = { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] };
    idem.set('busy', { hash: empreinteCorps(corps) }); // une requête concurrente, MÊME corps, en cours
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'busy'), payload: corps });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'idempotency_in_progress' });
    await server.close();
  });
```

e) Dans le test `'sans Idempotency-Key -> 400'`, ajouter après `expect(res.statusCode).toBe(400);` :

```ts
    expect(res.json()).toMatchObject({ code: 'idempotency_key_required' });
```

f) Ajouter, juste après le test `'rejeu même Idempotency-Key -> rapport caché, PAS de 2e campagne'` :

```ts
  it('clé dans le CORPS seulement : acceptée, et le rejeu rend le même rapport sans seconde campagne', async () => {
    const { server, cap } = app();
    const p = { idempotencyKey: 'k-corps', target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] };
    const r1 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY), payload: p });
    const r2 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY), payload: p });
    expect(r1.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('clé en en-tête puis dans le corps, même demande : même empreinte, rejeu', async () => {
    const { server, cap } = app();
    const p = { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] };
    const r1 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'k-mixte'), payload: p });
    const r2 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY), payload: { ...p, idempotencyKey: 'k-mixte' } });
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('en-tête et corps DIFFÉRENTS -> 400 invalid_body, rien n’est créé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'k-a'), payload: { idempotencyKey: 'k-b', target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('🔴 la même clé avec un AUTRE corps -> 422 idempotency_key_reused, jamais le rejeu silencieux du premier', async () => {
    const { server, cap } = app();
    const r1 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'k-reuse'), payload: { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] } });
    const r2 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'k-reuse'), payload: { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33698765432'] } });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });
```

- [ ] **Step 8: Les voir échouer**

Run: `npx vitest run tests/v1-sends.test.ts`
Expected: FAIL à l'EXÉCUTION (vitest ne vérifie pas les types) : « clé dans le CORPS seulement » rend 400 (la route exige encore l'en-tête), « la même clé avec un AUTRE corps » rend 201 (le premier rapport est rejoué), et « sans Idempotency-Key » comme le 409 échouent sur `code`, absent des corps d'erreur actuels.
Run: `npm run typecheck`
Expected: FAIL sur la fixture de `tests/v1-sends.test.ts` : son `idempotencyClaim` attend trois paramètres, le contrat `V1SendsRouteDeps` n'en déclare encore que deux (`tsconfig.json` inclut `tests/`).

- [ ] **Step 9: Brancher la route**

Dans `src/http/v1-sends.ts` :

a) Ajouter aux imports (après la ligne `import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';`) :

```ts
import { cleIdempotence, empreinteCorps } from '../api/idempotence';
import { refuser } from '../api/erreurs';
```

b) Ligne 70, remplacer `  idempotencyClaim(tenantId: string, key: string): Promise<IdempotencyClaim>;` par :

```ts
  /** `empreinte` = `empreinteCorps(corps)` : la même clé avec un autre corps rend `reused`. */
  idempotencyClaim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>;
```

c) Lignes 100 à 102, remplacer :

```ts
    const idem = req.headers['idempotency-key'];
    const idemKey = (Array.isArray(idem) ? idem[0] : idem)?.trim();
    if (!idemKey) return reply.code(400).send({ error: 'header Idempotency-Key requis' });
```

par :

```ts
    // La clé se donne en en-tête OU dans le corps (`idempotencyKey`) : un outil qui appelle une adresse par
    // contact remplit son corps avec les données du contact, pas toujours ses en-têtes.
    const idem = cleIdempotence(req.headers['idempotency-key'], req.body);
    if (!idem.ok) return refuser(reply, 400, idem.code, idem.message);
    const idemKey = idem.cle;
```

d) Lignes 178 à 181, remplacer :

```ts
    // Idempotence : claim atomique. Concurrent -> 409 ; déjà calculé -> rejeu du rapport.
    const claim = await deps.idempotencyClaim(tenantId, idemKey);
    if (!claim.claimed && 'pending' in claim) return reply.code(409).send({ error: 'envoi identique en cours (Idempotency-Key)' });
    if (!claim.claimed) return reply.code(201).send(claim.response);
```

par :

```ts
    // Idempotence : claim atomique AVEC l'empreinte du corps. Autre corps -> 422 ; concurrent -> 409 ; déjà
    // calculé -> rejeu du rapport.
    const claim = await deps.idempotencyClaim(tenantId, idemKey, empreinteCorps(req.body));
    if (!claim.claimed && 'reused' in claim) {
      return refuser(reply, 422, 'idempotency_key_reused', 'cette clé d’idempotence a déjà servi pour un autre corps : une clé désigne un seul envoi, et elle vit 24 h');
    }
    if (!claim.claimed && 'pending' in claim) {
      return refuser(reply, 409, 'idempotency_in_progress', 'un envoi avec cette clé d’idempotence est en cours : réessayez dans un instant');
    }
    if (!claim.claimed) return reply.code(201).send(claim.response);
```

e) `src/index.ts` (câblage partagé : annoncer l'édition aux autres sessions AVANT), ligne 3113, remplacer `        idempotencyClaim: (tenant, key) => idempotencyStore.claim(tenant, key),` par :

```ts
        idempotencyClaim: (tenant, key, empreinte) => idempotencyStore.claim(tenant, key, empreinte),
```

- [ ] **Step 10: Les voir passer, et vérifier `reused` dans les deux sens côté route**

Run: `npx vitest run tests/v1-sends.test.ts tests/api-idempotence.test.ts tests/api-usage-observation.test.ts`
Expected: PASS.
Mutation : dans `src/http/v1-sends.ts`, supprimer temporairement le bloc `if (!claim.claimed && 'reused' in claim) { … }`.
Run: `npx vitest run tests/v1-sends.test.ts`
Expected: FAIL sur « la même clé avec un AUTRE corps » (reçu 201 avec un corps vide, attendu 422). Restaurer, relancer : PASS.

- [ ] **Step 11: Écrire le test d'intégration (il ne tourne qu'en CI)**

Dans `tests/integration/stores.integration.test.ts`, remplacer le test `'PgApiIdempotencyStore : claim atomique, complete rejoue, release libère, sweep purge'` (lignes 2025 à 2046) en entier par :

```ts
  it('PgApiIdempotencyStore : claim atomique AVEC empreinte, complete rejoue, reused refusé, release libère, sweep purge', async () => {
    const store = new PgApiIdempotencyStore(pool);
    const key = `idem-${Date.now()}`;
    expect(await store.claim(tenantId, key, 'empreinte-a')).toEqual({ claimed: true });
    // 2e claim avant complete, MÊME corps -> pending ; AUTRE corps -> reused, même pendant le calcul.
    expect(await store.claim(tenantId, key, 'empreinte-a')).toEqual({ claimed: false, pending: true });
    expect(await store.claim(tenantId, key, 'empreinte-b')).toEqual({ claimed: false, reused: true });
    await store.complete(tenantId, key, '11111111-1111-1111-1111-111111111111', { ok: 1 });
    // après complete -> rejeu du rapport pour le même corps, refus pour un autre.
    expect(await store.claim(tenantId, key, 'empreinte-a')).toMatchObject({ claimed: false, sendId: '11111111-1111-1111-1111-111111111111', response: { ok: 1 } });
    expect(await store.claim(tenantId, key, 'empreinte-b')).toEqual({ claimed: false, reused: true });
    // 🔴 L'empreinte est bien ÉCRITE : c'est la colonne de la migration, et le claim la nomme.
    const ligne = await pool.query<{ request_hash: string | null }>(
      'select request_hash from api_idempotency where tenant_id = $1 and idempotency_key = $2',
      [tenantId, key],
    );
    expect(ligne.rows[0]?.request_hash).toBe('empreinte-a');
    // Une ligne d'AVANT la migration (empreinte nulle) rejoue son rapport, quel que soit le corps.
    const ancienne = `idem-ancienne-${Date.now()}`;
    await pool.query(
      'insert into api_idempotency (tenant_id, idempotency_key, send_id, response) values ($1, $2, $3, $4::jsonb)',
      [tenantId, ancienne, '22222222-2222-2222-2222-222222222222', JSON.stringify({ ok: 2 })],
    );
    expect(await store.claim(tenantId, ancienne, 'nimporte')).toMatchObject({ claimed: false, sendId: '22222222-2222-2222-2222-222222222222', response: { ok: 2 } });
    // release ne touche PAS une clé complétée (send_id non null).
    await store.release(tenantId, key);
    expect((await store.claim(tenantId, key, 'empreinte-a')).claimed).toBe(false);
    // release libère une clé PENDING (claim sans complete).
    const key2 = `idem2-${Date.now()}`;
    await store.claim(tenantId, key2, 'empreinte-c');
    await store.release(tenantId, key2);
    expect(await store.claim(tenantId, key2, 'empreinte-d')).toEqual({ claimed: true }); // re-claimable, nouvel envoi
    // sweep purge tout (fenêtre 0).
    expect(await store.sweepOlderThan(0)).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 12: Typecheck, suite unitaire**

Run: `npm run typecheck && npm test`
Expected: aucune erreur de type, suite verte.

- [ ] **Step 13: Mettre à jour la ligne du compteur de `CLAUDE.md`, dans CE commit**

Run: `git diff origin/main -- CLAUDE.md`
Dans la section « Déploiement » de `CLAUDE.md`, sur la ligne du compteur (« Dernière appliquée … ÉCRITE ET PAS ENCORE APPLIQUÉE … Prochaine libre = … et le dossier `db/migrations/` s'arrête à … ») : ajouter aux migrations écrites et pas encore appliquées « **<N>** (`idempotence_empreinte`, `api_idempotency.request_hash`, lot 2 de l'API cohérente ; purement additive, donc AVANT le `up`) », puis porter « Prochaine libre » à N+1 et « le dossier s'arrête à » à N. Ne rien toucher d'autre dans ce fichier.
`CLAUDE.md` est édité par d'autres sessions (il était déjà modifié dans l'arbre au moment d'écrire ce plan) : il entre dans le commit par la procédure P', jamais par son contenu d'arbre, même si le `git diff` ci-dessus paraît ne montrer que la ligne du compteur.

- [ ] **Step 14: Commit, push, verdict de l'intégration**

Commit par la procédure P ; `src/index.ts` et `CLAUDE.md` par P' (fichier de câblage partagé, et fichier que d'autres sessions éditent). Chemins : `db/migrations/<N>_idempotence_empreinte.sql src/api/idempotence.ts src/api/idempotency-store.pg.ts src/http/v1-sends.ts src/index.ts CLAUDE.md tests/api-idempotence.test.ts tests/v1-sends.test.ts tests/integration/stores.integration.test.ts`. Message :

```
feat(api): cle d idempotence en en-tete ou dans le corps, empreinte du corps gardee (<N>)

La meme cle avec un autre corps rend 422 idempotency_key_reused au lieu de rejouer le premier rapport.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Puis : `gh run list --limit 3` et `gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'`.
Expected: tous les jobs `success`, `integration` compris (c'est lui qui prouve le claim sur une vraie base).

---

### Task 4: La catégorie d'un template, lue chez Meta

**Files:**
- Create: `src/api/modele-envoi.ts`
- Modify: `src/workflow/wiring.ts:171-184` (type `TplInfo`) et `:258-264` (objet `info`)
- Test: `tests/api-modele-envoi.test.ts` (neuf) ; `tests/workflow-cablage-categorie.test.ts` doit rester vert

**Interfaces:**
- Consumes: `workflowRuntime.templateVarInfo(tenant, name, language)` (`src/workflow/wiring.ts:241`), qui rend `null` sur template introuvable (ou espace sans WABA) et LÈVE sur panne de lecture chez Meta.
- Produces:
  - `export type LectureModele = { statut: 'approuve'; categorie: 'marketing' | 'utility' } | { statut: 'absent' } | { statut: 'illisible' } | { statut: 'categorie_non_admise'; categorie: string }`
  - `export interface ModeleLu { statut?: string; langue?: string; category?: string }`
  - `export function verdictModele(info: ModeleLu | null, langue: string): LectureModele`
  - `TplInfo.statut: string` et `TplInfo.langue: string` (statut Meta et langue du template TROUVÉ)

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/api-modele-envoi.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verdictModele } from '../src/api/modele-envoi';

/**
 * CE QU'UN ENVOI PAR L'API SAIT D'UN TEMPLATE (spec 2026-09-24, § 3 « Catégorie, numéro, débit », défaut 2).
 *
 * 🔴 La catégorie était DÉCLARÉE par l'appelant : un template marketing annoncé « utility » partait aux
 * contacts dont le consentement est inconnu. Elle est désormais lue chez Meta, comme dans l'Inbox.
 */
describe('verdictModele', () => {
  it('approuvé, dans la langue demandée : sa catégorie, lue chez Meta', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'marketing' }, 'fr')).toEqual({ statut: 'approuve', categorie: 'marketing' });
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'utility' }, 'fr')).toEqual({ statut: 'approuve', categorie: 'utility' });
  });

  it('🔴 défaut 2 : introuvable, non approuvé, ou d’une AUTRE langue -> absent', () => {
    expect(verdictModele(null, 'fr')).toEqual({ statut: 'absent' });
    expect(verdictModele({ statut: 'PENDING', langue: 'fr', category: 'utility' }, 'fr')).toEqual({ statut: 'absent' });
    expect(verdictModele({ statut: 'REJECTED', langue: 'fr', category: 'utility' }, 'fr')).toEqual({ statut: 'absent' });
    // La lecture partagée retombe sur le NOM SEUL quand la langue ne correspond pas : pour l'API c'est un autre
    // template, et l'envoi échouerait chez Meta pour chaque destinataire.
    expect(verdictModele({ statut: 'APPROVED', langue: 'en', category: 'utility' }, 'fr')).toEqual({ statut: 'absent' });
  });

  it('catégorie ABSENTE -> illisible, jamais « utility » par défaut', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr' }, 'fr')).toEqual({ statut: 'illisible' });
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: '' }, 'fr')).toEqual({ statut: 'illisible' });
  });

  it('⚠️ catégorie LUE mais hors des deux admises -> categorie_non_admise, qui la nomme : réessayer n’y changerait rien', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'authentication' }, 'fr'))
      .toEqual({ statut: 'categorie_non_admise', categorie: 'authentication' });
  });
});

describe('la lecture partagée du template garde son statut et sa langue', () => {
  // Sans les commentaires : une explication qui CITE le bon code ne doit pas faire passer un câblage fautif.
  const source = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('🔴 `templateVarInfo` rend le statut et la langue du template TROUVÉ, lus chez Meta', () => {
    expect(source).toMatch(/statut: tpl\.status/);
    expect(source).toMatch(/langue: tpl\.language/);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-modele-envoi.test.ts`
Expected: FAIL, « Failed to resolve import "../src/api/modele-envoi" ».

- [ ] **Step 3: Écrire `src/api/modele-envoi.ts`**

```ts
/**
 * CE QU'UN ENVOI PAR L'API SAIT D'UN TEMPLATE, lu chez Meta (spec 2026-09-24, § 3).
 *
 * 🔴 LA CATÉGORIE N'EST PLUS DÉCLARÉE PAR L'APPELANT. Déclarée, un template marketing annoncé « utility »
 * partait aux contacts dont le consentement est inconnu. L'Inbox la lit déjà chez Meta
 * (`categorieDuModele`) ; l'API fait de même, avec la même lecture partagée (`templateVarInfo`) et son cache.
 *
 * ⚠️ `absent` couvre trois cas qu'un intégrateur corrige de la même façon : introuvable, pas encore approuvé
 * (ou refusé), ou d'une autre langue. La lecture partagée retombe sur le NOM SEUL quand la langue ne
 * correspond pas, ce qui convient au worker et pas à l'API : un envoi vise une langue précise.
 *
 * ⚠️ `illisible` n'est JAMAIS ramené à « utility » : dans le doute, l'envoi est refusé, comme dans l'Inbox.
 *
 * ⚠️ `categorie_non_admise` N'EST PAS `illisible` : la catégorie a été LUE (`authentication`, par exemple), et
 * elle n'est pas de celles que l'API envoie. Réessayer ne changera jamais rien, et le message doit le dire au
 * lieu d'inviter l'intégrateur à recommencer.
 */
export type LectureModele =
  | { statut: 'approuve'; categorie: 'marketing' | 'utility' }
  | { statut: 'absent' }
  | { statut: 'illisible' }
  | { statut: 'categorie_non_admise'; categorie: string };

/** Ce que la lecture partagée rend d'un template (`TplInfo`, `src/workflow/wiring.ts`), réduit à ce qui sert ici. */
export interface ModeleLu {
  statut?: string;
  langue?: string;
  category?: string;
}

export function verdictModele(info: ModeleLu | null, langue: string): LectureModele {
  if (info === null || info.langue !== langue || info.statut !== 'APPROVED') return { statut: 'absent' };
  if (info.category === 'marketing' || info.category === 'utility') return { statut: 'approuve', categorie: info.category };
  if (info.category !== undefined && info.category !== '') return { statut: 'categorie_non_admise', categorie: info.category };
  return { statut: 'illisible' };
}
```

- [ ] **Step 4: Garder le statut et la langue dans la lecture partagée**

Dans `src/workflow/wiring.ts`, dans le type `TplInfo`, juste après la ligne `    count: number;` (ligne 172), ajouter :

```ts
    /**
     * Statut Meta et langue du template TROUVÉ (`APPROVED`, `PENDING`…). L'API publique refuse un template non
     * approuvé, et la langue dit si la lecture est retombée sur le nom seul (`verdictModele`). Aucun autre
     * lecteur ne les lit : le worker et l'Inbox n'en dépendent pas.
     */
    statut: string;
    langue: string;
```

et dans l'objet `info` (ligne 258), remplacer la ligne `      count: countTemplateVariables(tpl.body),` par :

```ts
      count: countTemplateVariables(tpl.body),
      statut: tpl.status,
      langue: tpl.language,
```

- [ ] **Step 5: Le voir passer, et le garde voisin rester vert**

Run: `npx vitest run tests/api-modele-envoi.test.ts tests/workflow-cablage-categorie.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur.

Commit par la procédure P. Chemins : `src/api/modele-envoi.ts src/workflow/wiring.ts tests/api-modele-envoi.test.ts`. Message :

```
feat(api): verdictModele, la categorie d un template lue chez Meta, statut et langue gardes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 5: Les deux lectures en base de l'API

**Files:**
- Modify: `src/campaign/build.ts:6-11` (ajout de `ContactEnvoi` après `BuildContact`)
- Modify: `src/campaign/store.pg.ts:1-12` (imports), après `:189` (type `EnvoiApiBrut`), après `:1094` (deux méthodes de `PgCampaignRepo`)
- Test: `tests/integration/stores.integration.test.ts` (trois cas neufs après le test `'PgContactStore.upsertByPhoneReturningId / findByPhone / listContactsForBuildByIds'`, ligne 2083)

**Interfaces:**
- Consumes: `RECIPIENT_FAILED_SQL` (`src/campaign/echecs-sql.ts`), colonne `contacts.external_id` (lot 1).
- Produces:
  - `export interface ContactEnvoi extends BuildContact { bloque: boolean; rcsDesabonne: boolean }` (`src/campaign/build.ts`)
  - `export interface EnvoiApiBrut { id; status: CampaignStatus; createdAt; channel: 'whatsapp' | 'rcs'; templateName: string | null; templateLanguage: string | null; workflowCode: string | null; startNodeId: string | null; graph: WorkflowGraph | null; counts: { pending; sending; sent; failed; skipped }; recipients: Array<{ contactId; externalId: string | null; status: string; messageId: string | null; error: string | null; errorCode: number | null; sentAt: string | null; deliveryStatus: string | null; deliveryError: string | null }> }` (`src/campaign/store.pg.ts`)
  - `PgCampaignRepo.listContactsPourEnvoiApi(tenantId: string, ids: string[]): Promise<ContactEnvoi[]>`
  - `PgCampaignRepo.lireEnvoiApi(campaignId: string, tenantId: string): Promise<EnvoiApiBrut | null>`

- [ ] **Step 1: Écrire les tests d'intégration (ils ne tournent qu'en CI)**

Dans `tests/integration/stores.integration.test.ts`, juste après le test qui se termine par `expect(await repo.listContactsForBuildByIds(tenantId, [])).toEqual([]);` (ligne 2083), ajouter :

```ts
  /**
   * 🔴 DÉFAUT 1 DE LA SPEC API (2026-09-24) : la lecture de l'API LIT les bloqués au lieu de les filtrer.
   * `listContactsForBuildByIds` les retire (`blocked_at is null`), et la route les perdait en silence après
   * les avoir comptés. Celle-ci les rend, avec de quoi les écarter en `blocked_contact`.
   */
  it('PgCampaignRepo.listContactsPourEnvoiApi : bloqués et STOP RCS LUS, supprimés absents, espace tenu', async () => {
    const store = new PgContactStore(pool);
    const repo = new PgCampaignRepo(pool);
    const libre = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600002401', profileName: null, fields: {}, optInStatus: 'opted_in' });
    const bloque = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600002402', profileName: null, fields: {}, optInStatus: 'unknown' });
    const supprime = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600002403', profileName: null, fields: {}, optInStatus: 'unknown' });
    await pool.query('update contacts set blocked_at = now(), rcs_optout_at = now() where id = $1 and tenant_id = $2', [bloque.id, tenantId]);
    await pool.query('update contacts set deleted_at = now() where id = $1 and tenant_id = $2', [supprime.id, tenantId]);
    const lus = await repo.listContactsPourEnvoiApi(tenantId, [libre.id, bloque.id, supprime.id]);
    expect(lus.map((c) => c.id).sort()).toEqual([libre.id, bloque.id].sort());
    expect(lus.find((c) => c.id === libre.id)).toMatchObject({ phone_e164: '+33600002401', optInStatus: 'opted_in', bloque: false, rcsDesabonne: false });
    expect(lus.find((c) => c.id === bloque.id)).toMatchObject({ bloque: true, rcsDesabonne: true });
    // Un autre espace ne lit rien de celui-ci, même avec les bons identifiants.
    expect(await repo.listContactsPourEnvoiApi('00000000-0000-0000-0000-000000000000', [libre.id])).toEqual([]);
    expect(await repo.listContactsPourEnvoiApi(tenantId, [])).toEqual([]);
  });

  it('PgCampaignRepo.lireEnvoiApi : l’envoi, ses compteurs et ses destinataires, identifiant externe compris, tenus à l’espace', async () => {
    const store = new PgContactStore(pool);
    const repo = new PgCampaignRepo(pool);
    const c = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600002404', profileName: null, fields: {}, optInStatus: 'opted_in' });
    await pool.query('update contacts set external_id = $3 where id = $1 and tenant_id = $2', [c.id, tenantId, 'crm-itest-2404']);
    const { campaignId } = await repo.createWithRecipients(
      { tenantId, phoneNumberId: 'pn-suivi', name: '[API] suivi', category: 'utility', templateName: 'confirmation', templateLanguage: 'fr', paramMapping: [] },
      [{ contactId: c.id, toE164: '+33600002404', resolvedParams: [] }],
    );
    const lu = await repo.lireEnvoiApi(campaignId, tenantId);
    expect(lu).toMatchObject({
      id: campaignId, status: 'draft', channel: 'whatsapp', templateName: 'confirmation', templateLanguage: 'fr',
      workflowCode: null, startNodeId: null, graph: null,
      counts: { pending: 1, sending: 0, sent: 0, failed: 0, skipped: 0 },
    });
    expect(lu!.recipients).toEqual([{
      contactId: c.id, externalId: 'crm-itest-2404', status: 'pending', messageId: null, error: null,
      errorCode: null, sentAt: null, deliveryStatus: null, deliveryError: null,
    }]);
    expect(await repo.lireEnvoiApi(campaignId, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('PgCampaignRepo.lireEnvoiApi : un envoi de bloc rend le code du scénario, le bloc de départ et le graphe PUBLIÉ', async () => {
    const wf = new PgWorkflowStore(pool);
    const repo = new PgCampaignRepo(pool);
    const graphe = { nodes: [{ id: 'q', type: 'quick_message' as const, position: { x: 0, y: 0 }, data: { body: 'Bonjour', code: 'nod_itest_q' } }], edges: [] };
    const { id } = await wf.insert(tenantId, 'Suivi API', graphe);
    await wf.publish(id, tenantId);
    const { campaignId } = await repo.createWithRecipients(
      { tenantId, phoneNumberId: 'pn-suivi', name: '[API] bloc', category: 'utility', templateName: '', templateLanguage: '', paramMapping: [], workflowId: id, startNodeId: 'q' },
      [],
    );
    const lu = await repo.lireEnvoiApi(campaignId, tenantId);
    const code = (await wf.getById(id, tenantId))!.code;
    expect(lu).toMatchObject({ templateName: null, workflowCode: code, startNodeId: 'q' });
    expect(lu!.graph?.nodes.map((n) => n.id)).toEqual(['q']);
    expect(lu!.recipients).toEqual([]);
  });
```

- [ ] **Step 2: Constater que le typecheck échoue**

Run: `npm run typecheck`
Expected: FAIL, « Property 'listContactsPourEnvoiApi' does not exist on type 'PgCampaignRepo' » (et `lireEnvoiApi`). C'est le seul « rouge » visible en local : ces tests ne s'exécutent qu'en CI.

- [ ] **Step 3: Déclarer `ContactEnvoi`**

Dans `src/campaign/build.ts`, juste après l'interface `BuildContact` (ligne 11), ajouter :

```ts
/**
 * Un contact vu par un envoi de l'API publique : ce que la construction lit, PLUS ce qui l'écarte avec un
 * motif (spec 2026-09-24, § 3 « Aucune perte silencieuse »).
 *
 * 🔴 `bloque` EST LU, JAMAIS FILTRÉ. La lecture de la console (`listContactsForBuildByIds`) retire les
 * bloqués, ce qui est juste pour elle ; l'API les comptait puis les perdait sans motif (défaut 1).
 */
export interface ContactEnvoi extends BuildContact {
  /** `blocked_at is not null` : écarté `blocked_contact`. */
  bloque: boolean;
  /** `rcs_optout_at is not null` : STOP reçu en RCS, écarté `opted_out` sur une ouverture RCS. */
  rcsDesabonne: boolean;
}
```

- [ ] **Step 4: Écrire les deux lectures**

Dans `src/campaign/store.pg.ts` :

a) Imports : remplacer `import type { BuildContact, BuiltRecipient } from './build';` par `import type { BuildContact, BuiltRecipient, ContactEnvoi } from './build';`, et ajouter `import type { WorkflowGraph } from '../workflow/graph';`.

b) Juste après l'interface `CampaignDetail` (qui se termine ligne 189), ajouter :

```ts
/**
 * CE QUE LA LECTURE D'UN ENVOI DE L'API REND, AVANT MISE EN FORME (`formaterSuiviEnvoi`,
 * `src/api/suivi-envoi.ts`).
 *
 * 🔴 CE N'EST PAS `CampaignDetail` : l'API renvoyait l'objet de la console (`chaine`, `paramMapping`,
 * `archivedAt`), donc un changement de la console changeait l'API. Cette lecture ne sert que l'API.
 *
 * ⚠️ `graph` est le graphe PUBLIÉ relu MAINTENANT : l'ouverture d'un envoi de scénario ou de bloc se recalcule
 * dessus, aucune colonne ne la fige.
 *
 * ⚠️ `channel` EST LU, parce que `GET /v1/sends/{sendId}` lit N'IMPORTE QUELLE campagne de l'espace, console
 * comprise : une campagne RCS de la console porte `template_name` à `''` (pas null, `insertCampaignRow`), et
 * sans son canal le suivi l'annoncerait comme un template WhatsApp au nom vide.
 */
export interface EnvoiApiBrut {
  id: string;
  status: CampaignStatus;
  createdAt: string;
  /** `campaigns.channel` (0056, `not null default 'whatsapp'`). Une campagne RCS n'a jamais de scénario. */
  channel: 'whatsapp' | 'rcs';
  templateName: string | null;
  templateLanguage: string | null;
  /** Code public `scn_…` du scénario. null pour un template, ou un scénario supprimé depuis. */
  workflowCode: string | null;
  startNodeId: string | null;
  graph: WorkflowGraph | null;
  counts: { pending: number; sending: number; sent: number; failed: number; skipped: number };
  recipients: Array<{
    contactId: string;
    externalId: string | null;
    status: string;
    messageId: string | null;
    error: string | null;
    errorCode: number | null;
    sentAt: string | null;
    deliveryStatus: string | null;
    deliveryError: string | null;
  }>;
}
```

c) Dans `PgCampaignRepo`, juste après la méthode `listContactsForBuildByIds` (qui se termine ligne 1094), ajouter :

```ts
  /**
   * Les contacts d'un envoi de l'API publique, BLOQUÉS COMPRIS, avec ce qui les écarte.
   *
   * 🔴 ELLE NE FILTRE PAS `blocked_at`, à la différence de `listContactsForBuildByIds` (la console, qui la
   * garde) : l'API doit DIRE qu'un contact est bloqué (`blocked_contact`), sinon il est compté puis perdu en
   * silence (défaut 1 de la spec du 2026-09-24). Une fiche SUPPRIMÉE reste absente : la route l'écarte
   * `unknown_contact`.
   */
  async listContactsPourEnvoiApi(tenantId: string, ids: string[]): Promise<ContactEnvoi[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<{
      id: string; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      fields: Record<string, unknown>; opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
      bloque: boolean; rcs_desabonne: boolean;
    }>(
      `select id, phone_e164, bsuid, profile_name, fields, opt_in_status,
              blocked_at is not null as bloque, rcs_optout_at is not null as rcs_desabonne
         from contacts
        where tenant_id = $1 and deleted_at is null and id = any($2::uuid[])`,
      [tenantId, ids],
    );
    return res.rows.map((r) => ({
      id: r.id, phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields,
      optInStatus: r.opt_in_status, bloque: r.bloque, rcsDesabonne: r.rcs_desabonne,
    }));
  }

  /**
   * UN ENVOI DE L'API, tel que `GET /v1/sends/{sendId}` le décrit. null si absent ou d'un autre espace.
   *
   * ⚠️ TROIS REQUÊTES, TOUTES TENUES À L'ESPACE : l'en-tête filtre `c.tenant_id = $2`, et les deux lectures de
   * destinataires JOIGNENT la campagne sur ce même espace plutôt que de s'en remettre à la première.
   * ⚠️ Mêmes définitions que les compteurs de la console (`summarySelect`) : « envoyé » exclut un échec de
   * livraison, « en échec » est `RECIPIENT_FAILED_SQL`.
   */
  async lireEnvoiApi(campaignId: string, tenantId: string): Promise<EnvoiApiBrut | null> {
    const tete = await this.pool.query<{
      id: string; status: CampaignStatus; created_at: Date; channel: string; template_name: string | null; template_language: string | null;
      start_node_id: string | null; workflow_code: string | null; graph: WorkflowGraph | null;
    }>(
      `select c.id, c.status, c.created_at, c.channel, c.template_name, c.template_language, c.start_node_id,
              w.code as workflow_code, w.graph
         from campaigns c
         left join workflows w on w.id = c.workflow_id and w.tenant_id = c.tenant_id
        where c.id = $1 and c.tenant_id = $2`,
      [campaignId, tenantId],
    );
    const t = tete.rows[0];
    if (!t) return null;
    const compte = await this.pool.query<{ pending: string; sending: string; sent: string; failed: string; skipped: string }>(
      `select count(r.id) filter (where r.status = 'pending') as pending,
              count(r.id) filter (where r.status = 'sending') as sending,
              count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed') as sent,
              count(r.id) filter (where ${RECIPIENT_FAILED_SQL}) as failed,
              count(r.id) filter (where r.status = 'skipped') as skipped
         from campaign_recipients r
         join campaigns c on c.id = r.campaign_id and c.tenant_id = $2
        where r.campaign_id = $1`,
      [campaignId, tenantId],
    );
    const k = compte.rows[0];
    const dest = await this.pool.query<{
      contact_id: string; external_id: string | null; status: string; message_id: string | null; error: string | null;
      error_code: number | null; sent_at: Date | null; delivery_status: string | null; delivery_error: string | null;
    }>(
      `select r.contact_id, ct.external_id, r.status, r.message_id, r.error, r.error_code, r.sent_at,
              r.delivery_status, r.delivery_error
         from campaign_recipients r
         join campaigns c on c.id = r.campaign_id and c.tenant_id = $2
         left join contacts ct on ct.id = r.contact_id and ct.tenant_id = $2
        where r.campaign_id = $1
        order by r.id
        limit 500`,
      [campaignId, tenantId],
    );
    return {
      id: t.id,
      status: t.status,
      createdAt: t.created_at.toISOString(),
      // Deux valeurs en base (0056) ; toute autre retombe sur WhatsApp, le défaut de la colonne.
      channel: t.channel === 'rcs' ? 'rcs' : 'whatsapp',
      templateName: t.template_name,
      templateLanguage: t.template_language,
      workflowCode: t.workflow_code,
      startNodeId: t.start_node_id,
      graph: t.graph,
      counts: {
        pending: Number(k?.pending ?? 0),
        sending: Number(k?.sending ?? 0),
        sent: Number(k?.sent ?? 0),
        failed: Number(k?.failed ?? 0),
        skipped: Number(k?.skipped ?? 0),
      },
      recipients: dest.rows.map((r) => ({
        contactId: r.contact_id,
        externalId: r.external_id,
        status: r.status,
        messageId: r.message_id,
        error: r.error,
        errorCode: r.error_code,
        sentAt: r.sent_at ? r.sent_at.toISOString() : null,
        deliveryStatus: r.delivery_status,
        deliveryError: r.delivery_error,
      })),
    };
  }
```

- [ ] **Step 5: Typecheck et suite unitaire**

Run: `npm run typecheck && npm test`
Expected: aucune erreur, suite verte (rien ne consomme encore ces méthodes).

- [ ] **Step 6: Commit, push, verdict de l'intégration**

Commit par la procédure P. Chemins : `src/campaign/build.ts src/campaign/store.pg.ts tests/integration/stores.integration.test.ts`. Message :

```
feat(api): deux lectures dediees a l API, contacts bloques lus et suivi d un envoi

listContactsPourEnvoiApi ne filtre plus les bloques, lireEnvoiApi ne renvoie plus l objet de la console.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Puis : `gh run list --limit 3` et `gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'`.
Expected: tous les jobs `success`, `integration` compris.

---

### Task 6: Trier les destinataires sans perte silencieuse

**Files:**
- Modify: `src/api/sends-build.ts` (ajouts ; l'ancien `buildApiRecipients` reste jusqu'à la tâche 8)
- Test: `tests/api-tri-destinataires.test.ts` (neuf)

**Interfaces:**
- Consumes: `buildRecipients`, `BuiltRecipient`, `ContactEnvoi`, `SkippedRecipient` (`src/campaign/build.ts`), `CodeApi` (lot 1), `OuvertureApi` (tâche 1), `TemplateParam` (`src/crm/template.ts`).
- Produces:
  - `export const CODES_ECART` (tableau `as const`, vérifié `satisfies readonly CodeApi[]`) et `export type CodeEcart = (typeof CODES_ECART)[number]`
  - `export interface Ecart { index: number; reason: CodeEcart }`
  - `export type DestinataireResolu = { index: number; contactId: string; consent?: 'opted_in' | 'opted_out'; consentSource?: string } | { index: number; ecart: CodeEcart }`
  - `export function marquerDoublons(resolus: readonly DestinataireResolu[]): DestinataireResolu[]`
  - `export interface EntreeTri { category: CampaignCategory; ouverture: OuvertureApi; resolus: readonly DestinataireResolu[]; contacts: readonly ContactEnvoi[]; fenetreOuverteParContact?: ReadonlyMap<string, boolean> }`
  - `export interface ResultatTri { eligibles: Array<{ index: number; contact: ContactEnvoi }>; ecarts: Ecart[] }`
  - `export function trierDestinataires(e: EntreeTri): ResultatTri`
  - `export function construireDestinataires(category: CampaignCategory, params: TemplateParam[], tri: ResultatTri, now: Date): { recipients: BuiltRecipient[]; ecarts: Ecart[] }`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/api-tri-destinataires.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { construireDestinataires, marquerDoublons, trierDestinataires, type DestinataireResolu } from '../src/api/sends-build';
import type { ContactEnvoi } from '../src/campaign/build';
import type { TemplateParam } from '../src/crm/template';

/**
 * LE TRI DES DESTINATAIRES D'UN ENVOI PAR L'API (spec 2026-09-24, § 3 « Aucune perte silencieuse »).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : chaque destinataire finit ENVOYÉ ou ÉCARTÉ, avec son motif et son index. Le
 * défaut 1 de la spec était un contact bloqué compté dans `matched`, puis retiré par la lecture des fiches :
 * ni destinataire, ni écart.
 *
 * ⚠️ Les cas de l'ancien `buildApiRecipients` (tests/api-sends-build.test.ts) sont CONSERVÉS ici, sous leurs
 * nouveaux codes : `not_opted_in` devient `no_consent` (marketing sans opt-in) ou `opted_out` (désabonné),
 * `out_of_window` devient `window_closed`, et le doublon silencieux devient `duplicate`.
 */
const ct = (over: Partial<ContactEnvoi> & Pick<ContactEnvoi, 'id'>): ContactEnvoi => ({
  phone_e164: '+33600000001', bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in', bloque: false, rcsDesabonne: false, ...over,
});
const vers = (index: number, contactId: string): DestinataireResolu => ({ index, contactId });

describe('marquerDoublons', () => {
  it('la seconde désignation d’une même fiche devient `duplicate`, la première reste', () => {
    expect(marquerDoublons([vers(0, 'a'), vers(1, 'b'), vers(2, 'a')])).toEqual([vers(0, 'a'), vers(1, 'b'), { index: 2, ecart: 'duplicate' }]);
  });

  it('un écart déjà posé passe tel quel, et le marquage est idempotent', () => {
    const une = marquerDoublons([{ index: 0, ecart: 'invalid_phone' }, vers(1, 'a'), vers(2, 'a')]);
    expect(une).toEqual([{ index: 0, ecart: 'invalid_phone' }, vers(1, 'a'), { index: 2, ecart: 'duplicate' }]);
    expect(marquerDoublons(une)).toEqual(une);
  });
});

describe('trierDestinataires', () => {
  const base = { category: 'utility' as const, ouverture: 'whatsapp_template' as const };

  it('🔴 défaut 1 : un contact BLOQUÉ est écarté `blocked_contact`, jamais perdu en silence', () => {
    const r = trierDestinataires({ ...base, resolus: [vers(0, 'b')], contacts: [ct({ id: 'b', bloque: true })] });
    expect(r.eligibles).toEqual([]);
    expect(r.ecarts).toEqual([{ index: 0, reason: 'blocked_contact' }]);
  });

  it('le blocage passe avant tout : bloqué ET désabonné est `blocked_contact`', () => {
    expect(trierDestinataires({ ...base, resolus: [vers(0, 'a')], contacts: [ct({ id: 'a', bloque: true, optInStatus: 'opted_out' })] }).ecarts)
      .toEqual([{ index: 0, reason: 'blocked_contact' }]);
  });

  it('une fiche absente de la lecture (supprimée entre-temps) est écartée `unknown_contact`', () => {
    expect(trierDestinataires({ ...base, resolus: [vers(0, 'x')], contacts: [] }).ecarts).toEqual([{ index: 0, reason: 'unknown_contact' }]);
  });

  it('marketing : l’opt-in part, l’inconnu est `no_consent`, le désabonné `opted_out` (ancien `not_opted_in`)', () => {
    const r = trierDestinataires({
      category: 'marketing', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a'), vers(1, 'b'), vers(2, 'c')],
      contacts: [ct({ id: 'a' }), ct({ id: 'b', optInStatus: 'unknown' }), ct({ id: 'c', optInStatus: 'opted_out' })],
    });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'no_consent' }, { index: 2, reason: 'opted_out' }]);
  });

  it('utility : le consentement inconnu passe, le désabonné reste écarté', () => {
    const r = trierDestinataires({ ...base, resolus: [vers(0, 'a'), vers(1, 'b')], contacts: [ct({ id: 'a', optInStatus: 'unknown' }), ct({ id: 'b', optInStatus: 'opted_out' })] });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'opted_out' }]);
  });

  it('ouverture RCS : STOP RCS -> `opted_out`, fiche sans numéro -> `no_phone` ; en WhatsApp le STOP RCS ne compte pas', () => {
    const contacts = [ct({ id: 'a', rcsDesabonne: true }), ct({ id: 'b', phone_e164: null, bsuid: 'BS-b' })];
    const rcs = trierDestinataires({ ...base, ouverture: 'rcs', resolus: [vers(0, 'a'), vers(1, 'b')], contacts });
    expect(rcs.ecarts).toEqual([{ index: 0, reason: 'opted_out' }, { index: 1, reason: 'no_phone' }]);
    const wa = trierDestinataires({ ...base, resolus: [vers(0, 'a'), vers(1, 'b')], contacts });
    expect(wa.eligibles.map((x) => x.index)).toEqual([0, 1]);
  });

  it('ouverture de session : fenêtre fermée ou inconnue -> `window_closed` (ancien `out_of_window`)', () => {
    const r = trierDestinataires({
      ...base, ouverture: 'whatsapp_session',
      resolus: [vers(0, 'a'), vers(1, 'b'), vers(2, 'c')],
      contacts: [ct({ id: 'a' }), ct({ id: 'b' }), ct({ id: 'c' })],
      fenetreOuverteParContact: new Map([['a', true], ['b', false]]),
    });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'window_closed' }, { index: 2, reason: 'window_closed' }]);
  });

  it('⚠️ ouverture de session SANS lecture de fenêtre : tout est fermé, jamais tout ouvert', () => {
    expect(trierDestinataires({ ...base, ouverture: 'whatsapp_session', resolus: [vers(0, 'a')], contacts: [ct({ id: 'a' })] }).ecarts)
      .toEqual([{ index: 0, reason: 'window_closed' }]);
  });

  it('un doublon qui arrive au tri sans marquage est écarté `duplicate` (ancien doublon silencieux)', () => {
    const r = trierDestinataires({ ...base, resolus: [vers(0, 'a'), vers(1, 'a')], contacts: [ct({ id: 'a' })] });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'duplicate' }]);
  });
});

describe('construireDestinataires', () => {
  const prenom: TemplateParam[] = [{ position: 1, source: { type: 'field', key: 'prenom' } }];

  it('une variable manquante est `missing_variable` À L’INDEX du destinataire, et les écarts sont triés par index', () => {
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a'), { index: 1, ecart: 'invalid_phone' }, vers(2, 'b')],
      contacts: [ct({ id: 'a', fields: {} }), ct({ id: 'b', phone_e164: '+33600000002', fields: { prenom: 'Léa' } })],
    });
    const { recipients, ecarts } = construireDestinataires('utility', prenom, tri, new Date('2026-09-24T10:00:00Z'));
    expect(recipients).toEqual([{ contactId: 'b', toE164: '+33600000002', resolvedParams: ['Léa'] }]);
    expect(ecarts).toEqual([{ index: 0, reason: 'missing_variable' }, { index: 1, reason: 'invalid_phone' }]);
  });

  it('l’adresse vient de la FICHE : le numéro, sinon le BSUID', () => {
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a'), vers(1, 'b')],
      contacts: [ct({ id: 'a', phone_e164: '+33600000003', bsuid: 'BS-a' }), ct({ id: 'b', phone_e164: null, bsuid: 'BS-b' })],
    });
    expect(construireDestinataires('utility', [], tri, new Date()).recipients.map((r) => r.toE164)).toEqual(['+33600000003', 'BS-b']);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-tri-destinataires.test.ts`
Expected: FAIL, « marquerDoublons is not a function » (export absent).

- [ ] **Step 3: Écrire le tri**

Dans `src/api/sends-build.ts`, remplacer les trois lignes d'import du haut :

```ts
import { optInAllows } from '../campaign/guardrails';
import type { BuildContact } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
```

par :

```ts
import { optInAllows } from '../campaign/guardrails';
import { buildRecipients, type BuildContact, type BuiltRecipient, type ContactEnvoi, type SkippedRecipient } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
import type { TemplateParam } from '../crm/template';
import type { OuvertureApi } from '../workflow/ouverture-api';
import type { CodeApi } from './erreurs';
```

puis ajouter À LA FIN du fichier :

```ts
/**
 * LES MOTIFS D'ÉCART D'UN ENVOI PAR L'API (spec 2026-09-24, § 9). Les MÊMES codes que les erreurs des autres
 * routes : un même refus porte le même code partout. `satisfies` fait refuser au compilateur un motif qui ne
 * serait pas un code de l'API.
 */
export const CODES_ECART = [
  'invalid_recipient', 'invalid_phone', 'unknown_contact', 'duplicate', 'identity_conflict', 'blocked_contact',
  'opted_out', 'no_consent', 'window_closed', 'missing_variable', 'no_phone',
] as const satisfies readonly CodeApi[];
export type CodeEcart = (typeof CODES_ECART)[number];

/** Un destinataire écarté : son INDEX dans `recipients`, qui le retrouve quelle que soit la clé utilisée. */
export interface Ecart { index: number; reason: CodeEcart }

/** Un destinataire après résolution de sa fiche, ou le motif qui l'a écarté avant même de la lire. */
export type DestinataireResolu =
  | { index: number; contactId: string; consent?: 'opted_in' | 'opted_out'; consentSource?: string }
  | { index: number; ecart: CodeEcart };

/**
 * La seconde désignation d'une MÊME fiche est un doublon : écarté `duplicate`, jamais fusionné en silence.
 * Idempotente : la route l'appelle avant d'écrire les consentements, le tri la rappelle par sûreté.
 */
export function marquerDoublons(resolus: readonly DestinataireResolu[]): DestinataireResolu[] {
  const vus = new Set<string>();
  return resolus.map((r) => {
    if (!('contactId' in r)) return r;
    if (vus.has(r.contactId)) return { index: r.index, ecart: 'duplicate' };
    vus.add(r.contactId);
    return r;
  });
}

export interface EntreeTri {
  category: CampaignCategory;
  ouverture: OuvertureApi;
  resolus: readonly DestinataireResolu[];
  /** Les fiches, relues APRÈS l'écriture des consentements : le tri voit l'état que l'appelant a demandé. */
  contacts: readonly ContactEnvoi[];
  /** Fenêtre de 24 h par contact, lue pour une ouverture `whatsapp_session` seulement. Absente = fermée. */
  fenetreOuverteParContact?: ReadonlyMap<string, boolean>;
}

export interface ResultatTri {
  eligibles: Array<{ index: number; contact: ContactEnvoi }>;
  ecarts: Ecart[];
}

/**
 * Le motif qui écarte ce contact, ou null. L'ORDRE est celui de la gravité : un contact bloqué l'est avant
 * d'être désabonné, un désabonné l'est avant de manquer de consentement.
 */
function motifDEcart(c: ContactEnvoi, e: EntreeTri): CodeEcart | null {
  if (c.bloque) return 'blocked_contact';
  if (c.optInStatus === 'opted_out') return 'opted_out';
  if (e.ouverture === 'rcs' && c.rcsDesabonne) return 'opted_out';
  if (e.ouverture === 'rcs' && !c.phone_e164) return 'no_phone';
  // Aucune adresse du tout : la base l'interdit, mais `buildRecipients` l'écarterait SANS motif.
  if (!c.phone_e164 && !c.bsuid) return 'no_phone';
  if (e.category === 'marketing' && c.optInStatus !== 'opted_in') return 'no_consent';
  // Fermée ou INCONNUE : une fenêtre qu'on n'a pas lue n'est pas ouverte.
  if (e.ouverture === 'whatsapp_session' && e.fenetreOuverteParContact?.get(c.id) !== true) return 'window_closed';
  return null;
}

/**
 * LE TRI DES DESTINATAIRES D'UN ENVOI PAR L'API : chacun finit éligible ou écarté avec son motif et son index.
 *
 * 🔴 AUCUNE PERTE SILENCIEUSE (spec 2026-09-24, § 3). Une fiche désignée mais absente de la lecture (supprimée
 * entre la résolution et la lecture) est `unknown_contact`, jamais oubliée.
 */
export function trierDestinataires(e: EntreeTri): ResultatTri {
  const parId = new Map(e.contacts.map((c) => [c.id, c]));
  const eligibles: ResultatTri['eligibles'] = [];
  const ecarts: Ecart[] = [];
  for (const r of marquerDoublons(e.resolus)) {
    if ('ecart' in r) { ecarts.push({ index: r.index, reason: r.ecart }); continue; }
    const c = parId.get(r.contactId);
    if (!c) { ecarts.push({ index: r.index, reason: 'unknown_contact' }); continue; }
    const motif = motifDEcart(c, e);
    if (motif) { ecarts.push({ index: r.index, reason: motif }); continue; }
    eligibles.push({ index: r.index, contact: c });
  }
  return { eligibles, ecarts };
}

/** Les motifs de `buildRecipients`, dans le vocabulaire de l'API. Exhaustif : un motif neuf ne compile pas. */
const MOTIF_DE_CONSTRUCTION: Record<SkippedRecipient['reason'], CodeEcart> = {
  missing_variable: 'missing_variable',
  not_opted_in: 'no_consent',
  no_phone_number: 'no_phone',
};

/**
 * Les destinataires construits (variables de template résolues) et TOUS les écarts, triés par index.
 * `buildRecipients` reste la construction partagée avec la console : on ne la modifie pas, on traduit ses motifs.
 */
export function construireDestinataires(
  category: CampaignCategory,
  params: TemplateParam[],
  tri: ResultatTri,
  now: Date,
): { recipients: BuiltRecipient[]; ecarts: Ecart[] } {
  const built = buildRecipients(category, params, tri.eligibles.map((x) => x.contact), { now });
  const indexDe = new Map(tri.eligibles.map((x) => [x.contact.id, x.index]));
  const ecarts = [...tri.ecarts];
  for (const s of built.skipped) {
    const index = indexDe.get(s.contactId);
    if (index !== undefined) ecarts.push({ index, reason: MOTIF_DE_CONSTRUCTION[s.reason] });
  }
  ecarts.sort((a, b) => a.index - b.index);
  return { recipients: built.recipients, ecarts };
}
```

- [ ] **Step 4: Le voir passer**

Run: `npx vitest run tests/api-tri-destinataires.test.ts tests/api-sends-build.test.ts tests/campaign-build.test.ts`
Expected: PASS (l'ancien test de `buildApiRecipients` reste vert jusqu'à la tâche 8).

- [ ] **Step 5: Vérifier le défaut 1 dans les deux sens**

Mutation : dans `motifDEcart`, supprimer temporairement la ligne `if (c.bloque) return 'blocked_contact';`.
Run: `npx vitest run tests/api-tri-destinataires.test.ts`
Expected: FAIL sur « défaut 1 : un contact BLOQUÉ » (le contact bloqué sort dans `eligibles`, `ecarts` vide). Restaurer la ligne, relancer : PASS.

- [ ] **Step 6: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur.

Commit par la procédure P. Chemins : `src/api/sends-build.ts tests/api-tri-destinataires.test.ts`. Message :

```
feat(api): trierDestinataires, chaque destinataire finit envoye ou ecarte avec son index

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 7: Les deux formes que l'API rend, le défaut de forme et le suivi d'un envoi

**Files:**
- Create: `src/api/forme.ts`
- Create: `src/api/suivi-envoi.ts`
- Test: `tests/api-forme.test.ts` (neuf), `tests/api-suivi-envoi.test.ts` (neuf)

**Interfaces:**
- Consumes: `EnvoiApiBrut` (tâche 5), `ouvertureApi`, `OuvertureApi` (tâche 1), `CampaignStatus` (`src/campaign/types.ts`).
- Produces:
  - `export function messageDeForme(err: ZodError, precisions?: Readonly<Record<string, string>>): string`
  - `export type CibleSuivi = { template: { name: string; language: string } } | { scenario: string | null } | { node: string | null } | { rcsMessage: string | null }`
  - `export interface DestinataireSuivi { contactId: string; externalId: string | null; channel: 'whatsapp' | 'rcs'; status: string; messageId: string | null; delivery: string | null; error: { message: string; metaCode: number | null } | null; sentAt: string | null }`
  - `export interface SuiviEnvoiApi { sendId: string; status: CampaignStatus; target: CibleSuivi; opening: OuvertureApi | null; createdAt: string; counts: { pending: number; sending: number; sent: number; failed: number; skipped: number }; recipients: DestinataireSuivi[] }`
  - `export function formaterSuiviEnvoi(b: EnvoiApiBrut): SuiviEnvoiApi`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `tests/api-forme.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { messageDeForme } from '../src/api/forme';

/**
 * LE MESSAGE D'UN DÉFAUT DE FORME (spec 2026-09-24, § 9) : « fields.adresse : texte attendu », le CHEMIN
 * d'abord, en français. Les formes des issues de zod 4 ont été relevées sur la version installée.
 */
const s = z.strictObject({
  text: z.string().min(1).max(5),
  n: z.number().int().optional(),
  liste: z.array(z.string()).max(2).optional(),
  cat: z.enum(['a', 'b']).optional(),
});
const msg = (v: unknown, precisions?: Record<string, string>): string => {
  const r = s.safeParse(v);
  if (r.success) throw new Error('attendu : un échec de forme');
  return messageDeForme(r.error, precisions);
};

describe('messageDeForme', () => {
  it('type attendu, en français', () => {
    expect(msg({ text: 3 })).toBe('text : texte attendu');
    expect(msg({})).toBe('text : texte attendu');
    expect(msg({ text: 'a', n: 2.5 })).toBe('n : entier attendu');
  });

  it('bornes de texte et de tableau', () => {
    expect(msg({ text: '' })).toBe('text : 1 caractère(s) au moins');
    expect(msg({ text: 'abcdefg' })).toBe('text : 5 caractère(s) au plus');
    expect(msg({ text: 'a', liste: ['a', 'b', 'c'] })).toBe('liste : 2 élément(s) au plus');
  });

  it('champ inconnu : il est NOMMÉ', () => {
    expect(msg({ text: 'a', to: 'x' })).toBe('corps : champ inconnu (to)');
  });

  it('valeur hors énumération : les valeurs admises', () => {
    expect(msg({ text: 'a', cat: 'z' })).toBe('cat : valeur admise a | b');
  });

  it('une précision par chemin remplace la phrase générique', () => {
    expect(msg({ text: 3 }, { text: 'une phrase courte' })).toBe('text : une phrase courte');
  });
});
```

Créer `tests/api-suivi-envoi.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { formaterSuiviEnvoi } from '../src/api/suivi-envoi';
import type { EnvoiApiBrut } from '../src/campaign/store.pg';

/**
 * LE CONTRAT DE `GET /v1/sends/{sendId}` (spec 2026-09-24, § 3).
 *
 * 🔴 L'API renvoyait l'objet de la console (`chaine`, `paramMapping`, `archivedAt`) : un changement de la
 * console changeait l'API, sans contrat ni exemple. Ce fichier fixe le contrat.
 */
/** Des identifiants de fiche au FORMAT d'un vrai, comme ceux que l'API rend. */
const C1 = '11111111-1111-4111-8111-000000000001';
const C2 = '11111111-1111-4111-8111-000000000002';
const C3 = '11111111-1111-4111-8111-000000000003';

const TEMPLATE: EnvoiApiBrut = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'running',
  createdAt: '2026-09-24T10:00:00.000Z',
  channel: 'whatsapp',
  templateName: 'confirmation',
  templateLanguage: 'fr',
  workflowCode: null,
  startNodeId: null,
  graph: null,
  counts: { pending: 0, sending: 0, sent: 1, failed: 2, skipped: 0 },
  recipients: [
    { contactId: C1, externalId: 'crm-7781', status: 'sent', messageId: 'wamid.A', error: null, errorCode: null, sentAt: '2026-09-24T10:00:05.000Z', deliveryStatus: 'delivered', deliveryError: null },
    { contactId: C2, externalId: null, status: 'sent', messageId: 'wamid.B', error: null, errorCode: 131026, sentAt: '2026-09-24T10:00:06.000Z', deliveryStatus: 'failed', deliveryError: 'Message undeliverable' },
    { contactId: C3, externalId: null, status: 'failed', messageId: null, error: 'template inconnu', errorCode: 132001, sentAt: null, deliveryStatus: null, deliveryError: null },
  ],
};

describe('formaterSuiviEnvoi', () => {
  it('🔴 le contrat, et rien que lui : aucune clé de la console ne fuit', () => {
    const s = formaterSuiviEnvoi(TEMPLATE);
    expect(Object.keys(s).sort()).toEqual(['counts', 'createdAt', 'opening', 'recipients', 'sendId', 'status', 'target']);
    expect(Object.keys(s.recipients[0]!).sort()).toEqual(['channel', 'contactId', 'delivery', 'error', 'externalId', 'messageId', 'sentAt', 'status']);
  });

  it('un envoi de template : cible, ouverture, destinataires, et les deux sortes d’échec', () => {
    expect(formaterSuiviEnvoi(TEMPLATE)).toEqual({
      sendId: '11111111-1111-4111-8111-111111111111',
      status: 'running',
      target: { template: { name: 'confirmation', language: 'fr' } },
      opening: 'whatsapp_template',
      createdAt: '2026-09-24T10:00:00.000Z',
      counts: { pending: 0, sending: 0, sent: 1, failed: 2, skipped: 0 },
      recipients: [
        { contactId: C1, externalId: 'crm-7781', channel: 'whatsapp', status: 'sent', messageId: 'wamid.A', delivery: 'delivered', error: null, sentAt: '2026-09-24T10:00:05.000Z' },
        // Échec de LIVRAISON signalé plus tard : `status` reste `sent` en base, l'API dit `failed`.
        { contactId: C2, externalId: null, channel: 'whatsapp', status: 'failed', messageId: 'wamid.B', delivery: 'failed', error: { message: 'Message undeliverable', metaCode: 131026 }, sentAt: '2026-09-24T10:00:06.000Z' },
        // Refus à l'ENVOI.
        { contactId: C3, externalId: null, channel: 'whatsapp', status: 'failed', messageId: null, delivery: null, error: { message: 'template inconnu', metaCode: 132001 }, sentAt: null },
      ],
    });
  });

  it('un envoi de scénario qui ouvre en RCS : cible par code, canal rcs, jamais l’identifiant synthétique `wf-`', () => {
    const s = formaterSuiviEnvoi({
      ...TEMPLATE,
      templateName: null, templateLanguage: null, workflowCode: 'scn_demo_01', startNodeId: null,
      graph: { nodes: [{ id: 'r', type: 'rcs_message', position: { x: 0, y: 0 }, data: { text: 'Bonjour' } }], edges: [] },
      recipients: [{ ...TEMPLATE.recipients[0]!, messageId: 'wf-5f1c', deliveryStatus: null }],
    });
    expect(s.target).toEqual({ scenario: 'scn_demo_01' });
    expect(s.opening).toBe('rcs');
    expect(s.recipients[0]).toMatchObject({ channel: 'rcs', messageId: null, delivery: null });
  });

  it('un envoi de bloc : la cible est le CODE du bloc, l’ouverture se juge depuis lui', () => {
    const s = formaterSuiviEnvoi({
      ...TEMPLATE,
      templateName: null, templateLanguage: null, workflowCode: 'scn_demo_02', startNodeId: 'q',
      graph: { nodes: [{ id: 'q', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Bonjour', code: 'nod_demo_q' } }], edges: [] },
    });
    expect(s.target).toEqual({ node: 'nod_demo_q' });
    expect(s.opening).toBe('whatsapp_session');
  });

  it('un scénario supprimé depuis : cible et ouverture inconnues, jamais inventées', () => {
    const s = formaterSuiviEnvoi({ ...TEMPLATE, templateName: null, templateLanguage: null, workflowCode: null, startNodeId: null, graph: null });
    expect(s.target).toEqual({ scenario: null });
    expect(s.opening).toBeNull();
    expect(s.recipients.every((r) => r.channel === 'whatsapp')).toBe(true);
  });

  it('🔴 une campagne RCS de la console (`template_name` vide, pas null) : cible RCS, ouverture et canal RCS, jamais un template au nom vide', () => {
    const s = formaterSuiviEnvoi({
      ...TEMPLATE, channel: 'rcs', templateName: '', templateLanguage: '',
      recipients: [{ ...TEMPLATE.recipients[0]!, messageId: 'sms-1' }],
    });
    expect(s.target).toEqual({ rcsMessage: null });
    expect(s.opening).toBe('rcs');
    expect(s.recipients[0]).toMatchObject({ channel: 'rcs', messageId: 'sms-1' });
  });

  it('un nom de template VIDE sur une campagne WhatsApp n’est pas une cible template', () => {
    const s = formaterSuiviEnvoi({ ...TEMPLATE, templateName: '', templateLanguage: '' });
    expect(s.target).toEqual({ scenario: null });
    expect(s.opening).toBeNull();
  });
});
```

- [ ] **Step 2: Les voir échouer**

Run: `npx vitest run tests/api-forme.test.ts tests/api-suivi-envoi.test.ts`
Expected: FAIL, « Failed to resolve import "../src/api/forme" » et « "../src/api/suivi-envoi" ».

- [ ] **Step 3: Écrire `src/api/forme.ts`**

```ts
import type { ZodError } from 'zod';

/**
 * LE MESSAGE D'UN DÉFAUT DE FORME, en français, le CHEMIN d'abord (spec 2026-09-24, § 9 : « fields.adresse :
 * texte attendu »). Le chemin est ce qui fait corriger : il désigne le champ, là où « Invalid input » envoie
 * relire tout le corps.
 *
 * ⚠️ Les messages de zod sont en anglais : on traduit les cas que nos schémas provoquent (formes relevées
 * sur zod 4.4 : `invalid_type` et son `expected`, `too_small` / `too_big` et leur `origin`,
 * `unrecognized_keys`, `invalid_value`). `precisions` remplace la phrase pour un chemin donné, quand la
 * générique ne dit pas assez (une union de cibles, par exemple).
 *
 * ⚠️ Le chemin et les noms de champs inconnus sont BORNÉS avant d'être recopiés : ils viennent de l'appelant,
 * et une clé de 5 000 caractères reviendrait sinon telle quelle dans la réponse.
 *
 * ⚠️ `raisonDeValidation` (`src/api/contacts-upsert.ts`) reste propre aux contacts : ses phrases nomment des
 * champs de fiche.
 */
const TYPES: Readonly<Record<string, string>> = {
  string: 'texte', number: 'nombre', int: 'entier', boolean: 'booléen', array: 'tableau', object: 'objet',
};

/** L'unité d'une borne : des éléments pour un tableau, des caractères pour un texte, rien pour un nombre. */
const unite = (origine: string): string => (origine === 'array' ? ' élément(s)' : origine === 'string' ? ' caractère(s)' : '');

export function messageDeForme(err: ZodError, precisions: Readonly<Record<string, string>> = {}): string {
  const i = err.issues[0];
  if (!i) return 'corps invalide';
  const chemin = i.path.map(String).join('.').slice(0, 80) || 'corps';
  const precision = precisions[chemin];
  if (precision !== undefined) return `${chemin} : ${precision}`;
  switch (i.code) {
    case 'invalid_type':
      return `${chemin} : ${TYPES[i.expected] ?? i.expected} attendu`;
    case 'too_small':
      return `${chemin} : ${String(i.minimum)}${unite(i.origin)} au moins`;
    case 'too_big':
      return `${chemin} : ${String(i.maximum)}${unite(i.origin)} au plus`;
    case 'unrecognized_keys':
      return `${chemin} : champ inconnu (${i.keys.slice(0, 5).map((k) => k.slice(0, 40)).join(', ')})`;
    case 'invalid_value':
      return `${chemin} : valeur admise ${i.values.map(String).join(' | ')}`;
    default:
      return `${chemin} : valeur invalide`;
  }
}
```

- [ ] **Step 4: Écrire `src/api/suivi-envoi.ts`**

```ts
import type { EnvoiApiBrut } from '../campaign/store.pg';
import type { CampaignStatus } from '../campaign/types';
import { ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';

/**
 * LE CONTRAT DE `GET /v1/sends/{sendId}` (spec 2026-09-24, § 3).
 *
 * 🔴 UNE MISE EN FORME DÉDIÉE, ET PAS L'OBJET DE LA CONSOLE : un changement de la console ne change plus l'API.
 *
 * ⚠️ Pour un scénario ou un bloc, la ligne décrit le DÉPART du parcours, et `channel` son canal d'ouverture ;
 * la suite du parcours se lit dans la console. L'ouverture est recalculée sur le graphe PUBLIÉ relu
 * maintenant (aucune colonne ne la fige) : un scénario republié entre-temps se lit tel qu'il est.
 *
 * ⚠️ LA LECTURE VOIT TOUTE CAMPAGNE DE L'ESPACE, console comprise. Une campagne RCS de la console porte
 * `template_name` à `''` : le CANAL est donc jugé AVANT le template, et un nom vide n'est jamais une cible.
 * Sa cible est `{ rcsMessage: null }` : la campagne garde le CONTENU du message (`campaigns.rcs_message`), pas
 * son nom dans la bibliothèque, et ce lot ne l'invente pas.
 */
export type CibleSuivi =
  | { template: { name: string; language: string } }
  | { scenario: string | null }
  | { node: string | null }
  | { rcsMessage: string | null };

export interface DestinataireSuivi {
  contactId: string;
  externalId: string | null;
  channel: 'whatsapp' | 'rcs';
  status: string;
  messageId: string | null;
  delivery: string | null;
  error: { message: string; metaCode: number | null } | null;
  sentAt: string | null;
}

export interface SuiviEnvoiApi {
  sendId: string;
  status: CampaignStatus;
  target: CibleSuivi;
  opening: OuvertureApi | null;
  createdAt: string;
  counts: { pending: number; sending: number; sent: number; failed: number; skipped: number };
  recipients: DestinataireSuivi[];
}

/**
 * Préfixe de l'identifiant SYNTHÉTIQUE qu'une campagne de scénario écrit à la place d'un wamid
 * (`wf-<workflowId>`, `src/campaign/engine.ts`). Le rendre ferait chercher à l'intégrateur un message qui
 * n'existe pas chez Meta : il vaut null.
 */
const ID_SYNTHETIQUE = 'wf-';

/** Un nom de template ÉCRIT : null et `''` ne désignent aucun template. */
const nomDeTemplate = (b: EnvoiApiBrut): string | null =>
  (b.templateName !== null && b.templateName.trim() !== '' ? b.templateName : null);

function cibleDe(b: EnvoiApiBrut): CibleSuivi {
  // Le CANAL d'abord : une campagne RCS porte `template_name` à `''`, pas null.
  if (b.channel === 'rcs') return { rcsMessage: null };
  const nom = nomDeTemplate(b);
  if (nom !== null) return { template: { name: nom, language: b.templateLanguage ?? '' } };
  if (b.startNodeId !== null) {
    const noeud = b.graph?.nodes.find((n) => n.id === b.startNodeId);
    return { node: typeof noeud?.data.code === 'string' ? noeud.data.code : null };
  }
  return { scenario: b.workflowCode };
}

function ouvertureDe(b: EnvoiApiBrut): OuvertureApi | null {
  if (b.channel === 'rcs') return 'rcs';
  if (nomDeTemplate(b) !== null) return 'whatsapp_template';
  if (b.graph === null) return null;
  return ouvertureApi(b.graph, b.startNodeId ?? undefined).ouverture;
}

export function formaterSuiviEnvoi(b: EnvoiApiBrut): SuiviEnvoiApi {
  const opening = ouvertureDe(b);
  const channel: 'whatsapp' | 'rcs' = opening === 'rcs' ? 'rcs' : 'whatsapp';
  return {
    sendId: b.id,
    status: b.status,
    target: cibleDe(b),
    opening,
    createdAt: b.createdAt,
    counts: { ...b.counts },
    recipients: b.recipients.map((r) => {
      // « En échec » a deux définitions en base (`RECIPIENT_FAILED_SQL`) : le refus à l'envoi, et l'échec
      // de livraison signalé plus tard, où `status` reste `sent`. L'API dit `failed` dans les deux cas.
      const echec = r.status === 'failed' || r.deliveryStatus === 'failed';
      return {
        contactId: r.contactId,
        externalId: r.externalId,
        channel,
        status: echec ? 'failed' : r.status,
        messageId: r.messageId !== null && !r.messageId.startsWith(ID_SYNTHETIQUE) ? r.messageId : null,
        delivery: r.deliveryStatus,
        error: echec ? { message: r.error ?? r.deliveryError ?? 'échec d’envoi', metaCode: r.errorCode } : null,
        sentAt: r.sentAt,
      };
    }),
  };
}
```

- [ ] **Step 5: Les voir passer**

Run: `npx vitest run tests/api-forme.test.ts tests/api-suivi-envoi.test.ts`
Expected: PASS.

- [ ] **Step 6: Vérifier le cas de la campagne RCS dans les deux sens**

Mutation : dans `src/api/suivi-envoi.ts`, remplacer temporairement `const nomDeTemplate = (b: EnvoiApiBrut): string | null =>` et sa ligne suivante par `const nomDeTemplate = (b: EnvoiApiBrut): string | null => b.templateName;`, et supprimer la ligne `if (b.channel === 'rcs') return { rcsMessage: null };` (c'est l'ancien jugement : « un nom non null est un template »).
Run: `npx vitest run tests/api-suivi-envoi.test.ts`
Expected: FAIL sur « une campagne RCS de la console » (reçu `{ template: { name: '', language: '' } }`, attendu `{ rcsMessage: null }`) et sur « un nom de template VIDE ». Restaurer les deux, relancer : PASS.

- [ ] **Step 7: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur.

Commit par la procédure P. Chemins : `src/api/forme.ts src/api/suivi-envoi.ts tests/api-forme.test.ts tests/api-suivi-envoi.test.ts`. Message :

```
feat(api): messageDeForme et formaterSuiviEnvoi, le contrat ecrit du suivi d un envoi

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 8: La route `/v1/sends` refondue, et son câblage

**Files:**
- Modify: `src/http/v1-sends.ts` (réécrit en entier)
- Modify: `src/api/sends-build.ts` (retrait de `ApiSkipReason`, `ApiSkip`, `buildApiRecipients` et de l'import `optInAllows`)
- Delete: `tests/api-sends-build.test.ts` (ses cas sont conservés dans `tests/api-tri-destinataires.test.ts`, tâche 6)
- Modify: `src/api/consentement.ts` (lot 1 : ajout de `depsConsentementDe`), `src/api/contacts-v1.ts` (lot 1 : `creerServiceContactsV1` construit son `DepsConsentement` par `depsConsentementDe`)
- Modify: `src/index.ts:39` (imports), le bloc `v1.sends` (`:3086-3117`), et UNE constante `depsConsentement` déclarée juste avant `const app = buildServer({` (`:639`, après `auditSink`, l. 241) (câblage partagé : annoncer avant)
- Modify (commentaires) : `src/campaign/engine.ts:896-897`, `src/workflow/executor.ts:1459-1461`, `documentation.md:358`, `src/campaign/build.ts:66-68`, `tests/campaign-build.test.ts:63-64`, `src/crm/contact-store.pg.ts:183` et `:287-289`
- Test: `tests/v1-sends.test.ts` (réécrit), `tests/api-usage-observation.test.ts:39-52` (double muet), `tests/v1-cablage.test.ts` (neuf), `tests/api-consentement-deps.test.ts` (neuf)

**Interfaces:**
- Consumes: tâches 1 à 7 ; du lot 1 : `resoudreFiche`, `appliquerConsentement`, `schemaClesFiche`, `ClesFiche`, `ModeCreation`, `ResolutionFiche`, `DepsConsentement`, `refuser`, `CodeApi`, `contactsV1Muets` (`tests/aide/contacts-v1.ts`) ; `MAX_OPT_IN_SOURCE` (`src/api/contacts-upsert.ts`) ; `contactStore` et `auditSink` (`src/index.ts:207`, `:241`).
- Produces:
  - `export function depsConsentementDe(contacts: Pick<DepsConsentement, 'ecrireConsentementParId'>, audit: AuditSink): DepsConsentement` (`src/api/consentement.ts`) : la SEULE construction des dépendances du consentement, pour `/v1/contacts` comme pour `/v1/sends`.
  - `V1SendsRouteDeps` : `resolveScenario(tenantId, ref): Promise<ResolveResult<{ id: string; name: string; graph: WorkflowGraph }>>` ; `resolveNode(tenantId, code): Promise<ResolveResult<{ workflowId: string; nodeId: string; label: string; graph: WorkflowGraph }>>` (REQUIS) ; `lireModele(tenantId, name, language): Promise<LectureModele>` ; `getWindowOpenByWaIds` (REQUIS) ; `resoudreFiche(tenantId, cles, { creer })` ; `appliquerConsentement(tenantId, contactId, consent, source)` ; `listContactsPourEnvoi(tenantId, ids): Promise<ContactEnvoi[]>` ; `lireEnvoi(sendId, tenantId): Promise<EnvoiApiBrut | null>` ; `createSend`, `enqueue`, `idempotencyClaim/Complete/Release`, `getTenantPhoneNumberId`, `phoneNumberBelongsToTenant`, `sleep?` inchangés.
  - Réponse 201 : `{ sendId, opening, recipientCount, created, matched, skipped: Array<{ index, reason }>, skippedTotal }`.
  - Points d'extension du lot 3 : un membre de plus dans l'union `schemaCible` et dans `CibleDemandee`, et `variables` dans `schemaDestinataire`.

- [ ] **Step 1: Annoncer l'édition du câblage partagé**

Envoyer aux autres sessions du dépôt (`ListAgents`, puis `SendMessage`) : « J'édite `src/index.ts` (bloc `v1.sends`, imports, une constante `depsConsentement` avant `buildServer`) et `src/api/contacts-v1.ts` pour le lot 2 de l'API cohérente. »

- [ ] **Step 2: Écrire le test de route qui échoue**

Remplacer tout `tests/v1-sends.test.ts` par :

```ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { verdictLigne, type IdempotencyClaim } from '../src/api/idempotency-store.pg';
import { empreinteCorps } from '../src/api/idempotence';
import { formaterSuiviEnvoi } from '../src/api/suivi-envoi';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { V1SendsRouteDeps, V1SendCreateInput } from '../src/http/v1-sends';
import type { BuiltRecipient, ContactEnvoi } from '../src/campaign/build';
import type { EnvoiApiBrut } from '../src/campaign/store.pg';
import type { ClesFiche, ModeCreation } from '../src/api/fiche';
import type { LectureModele } from '../src/api/modele-envoi';
import type { WorkflowGraph, WorkflowNode } from '../src/workflow/graph';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';

/**
 * `POST /v1/sends` ET `GET /v1/sends/{sendId}` (spec 2026-09-24, § 3 et § 9).
 *
 * 🔴 LES TROIS DÉFAUTS DE LA SPEC ONT ICI LEUR TEST DE ROUTE, vérifié dans les deux sens : un contact bloqué
 * perdu en silence (1), l'API qui accepte ce que la console refuse (2), une cible `node` jugée sur le TYPE du
 * bloc au lieu de ce qu'il envoie en premier (3).
 *
 * ⚠️ Les cas de l'ancienne version de ce fichier sont conservés sous le nouveau contrat : destinataires
 * désignés par leur fiche (plus de chaînes nues), `out_of_window` devenu `window_closed`, `createMissing`
 * disparu (la création dépend de l'ouverture), `exigeFenetre24h` remplacé par `ouvertureApi`.
 *
 * ⚠️ LES FICHES PORTENT DES IDENTIFIANTS AU FORMAT D'UN VRAI (`C1`…`C5`) : chaque destinataire passe par
 * `schemaClesFiche` (lot 1), dont `contactId` est un GUID. Un « c1 » serait écarté `invalid_recipient` avant
 * même d'atteindre la résolution, et presque tous les cas ci-dessous deviendraient verts ou rouges pour une
 * autre raison que la leur.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() {}
}
const SEND_KEY = cleApiDeTest('envoi');
const NOSCOPE_KEY = cleApiDeTest('sans_scope');
const C1 = '11111111-1111-4111-8111-000000000001';
const C2 = '11111111-1111-4111-8111-000000000002';
const C3 = '11111111-1111-4111-8111-000000000003';
const C4 = '11111111-1111-4111-8111-000000000004';
const C5 = '11111111-1111-4111-8111-000000000005';

const PHONE = (n: number): string => `+3361234500${n}`;
const fiche = (id: string, n: number, over: Partial<ContactEnvoi> = {}): ContactEnvoi => ({
  id, phone_e164: PHONE(n), bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in', bloque: false, rcsDesabonne: false, ...over,
});
const noeud = (id: string, type: WorkflowNode['type'], data: Record<string, unknown> = {}): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, data });

const G_TEMPLATE: WorkflowGraph = { nodes: [noeud('t', 'template', { templateName: 'promo' })], edges: [] };
const G_SESSION: WorkflowGraph = { nodes: [noeud('q', 'quick_message', { body: 'Bonjour' })], edges: [] };
const SCENARIOS: Record<string, WorkflowGraph> = { scn_template: G_TEMPLATE, scn_session: G_SESSION, scn_vide: { nodes: [], edges: [] } };
/** Les cibles `node` : `nod_<id du bloc>`. */
const G_NODES: WorkflowGraph = {
  nodes: [
    noeud('cond', 'condition'),
    noeud('qm', 'quick_message', { body: 'On en parle ?' }),
    noeud('rcs', 'rcs_message', { text: 'Carte' }),
    noeud('tpl', 'template', { templateName: 'relance' }),
    noeud('attente', 'wait', { seconds: 60 }),
    noeud('tpl2', 'template', { templateName: 'rappel' }),
  ],
  edges: [
    { id: 'e1', source: 'cond', target: 'qm', sourceHandle: 'true' },
    { id: 'e2', source: 'attente', target: 'tpl2' },
  ],
};

interface Monde {
  fiches: Map<string, ContactEnvoi>;
  /** wa_id -> fenêtre ouverte. Absent = fermée. */
  fenetre: Map<string, boolean>;
  modele: LectureModele;
}

function app(over: Partial<Omit<V1SendsRouteDeps, 'usage'>> = {}, monde: Partial<Monde> = {}) {
  const m: Monde = {
    fiches: new Map([[C1, fiche(C1, 1)], [C2, fiche(C2, 2)]]),
    fenetre: new Map([['33612345001', true], ['33612345002', true]]),
    modele: { statut: 'approuve', categorie: 'utility' },
    ...monde,
  };
  const cap = {
    sends: [] as Array<{ input: V1SendCreateInput; recipients: BuiltRecipient[] }>,
    enqueued: [] as Array<{ id: string; rate: number | null }>,
    resolutions: [] as Array<{ cles: ClesFiche; creer: ModeCreation }>,
    consentements: [] as Array<{ contactId: string; consent: 'opted_in' | 'opted_out'; source: string; lecturesAvant: number }>,
    lectures: 0,
    fenetresDemandees: [] as string[][],
  };
  const idem = new Map<string, { hash: string; sendId?: string; response?: unknown }>();
  const keys = new FakeApiKeys()
    .add(SEND_KEY, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .add(NOSCOPE_KEY, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });

  const sends: Omit<V1SendsRouteDeps, 'usage'> = {
    resolveScenario: async (_t, ref) => {
      if (ref === 'Ambigu') return { ok: false, reason: 'ambiguous', matches: [{ id: 'a', name: 'Ambigu', graph: G_TEMPLATE }, { id: 'b', name: 'Ambigu', graph: G_TEMPLATE }] };
      const graph = SCENARIOS[ref];
      return graph ? { ok: true, value: { id: `wf-${ref}`, name: ref, graph } } : { ok: false, reason: 'not_found' };
    },
    resolveNode: async (_t, code) => {
      const id = code.replace(/^nod_/, '');
      return G_NODES.nodes.some((n) => n.id === id)
        ? { ok: true, value: { workflowId: 'wf-nodes', nodeId: id, label: `Bloc ${id}`, graph: G_NODES } }
        : { ok: false, reason: 'not_found' };
    },
    lireModele: async () => m.modele,
    getWindowOpenByWaIds: async (_t, waIds) => { cap.fenetresDemandees.push(waIds); return new Map(waIds.map((w) => [w, m.fenetre.get(w) === true])); },
    getTenantPhoneNumberId: async () => 'pn-default',
    phoneNumberBelongsToTenant: async (pn) => pn === 'pn-mine',
    /** Double de la résolution du lot 1 : par contactId, numéro ou BSUID ; crée sur un numéro si on le demande. */
    resoudreFiche: async (tenant, cles, o) => {
      cap.resolutions.push({ cles, creer: o.creer });
      if (tenant !== 't1') return { ok: false, code: 'unknown_contact' };
      if (!cles.contactId && !cles.externalId && !cles.phone && !cles.bsuid) return { ok: false, code: 'invalid_recipient' };
      if (cles.phone !== undefined && !/^\+\d{8,15}$/.test(cles.phone)) return { ok: false, code: 'invalid_phone' };
      const toutes = [...m.fiches.values()];
      const trouvees = new Set<string>();
      if (cles.contactId) {
        if (!m.fiches.has(cles.contactId)) return { ok: false, code: 'unknown_contact' };
        trouvees.add(cles.contactId);
      }
      const parTel = cles.phone ? toutes.find((f) => f.phone_e164 === cles.phone) : undefined;
      if (parTel) trouvees.add(parTel.id);
      const parBsuid = cles.bsuid ? toutes.find((f) => f.bsuid === cles.bsuid) : undefined;
      if (parBsuid) trouvees.add(parBsuid.id);
      if (trouvees.size > 1) return { ok: false, code: 'identity_conflict' };
      const [id] = [...trouvees];
      if (id) return { ok: true, contactId: id, cree: false };
      if (o.creer === 'jamais' || !cles.phone) return { ok: false, code: 'unknown_contact' };
      const neuf = `n${m.fiches.size + 1}`;
      m.fiches.set(neuf, { ...fiche(neuf, 0), phone_e164: cles.phone, optInStatus: 'unknown' });
      return { ok: true, contactId: neuf, cree: true };
    },
    appliquerConsentement: async (_t, contactId, consent, source) => {
      cap.consentements.push({ contactId, consent, source, lecturesAvant: cap.lectures });
      const f = m.fiches.get(contactId);
      if (f) f.optInStatus = consent;
    },
    listContactsPourEnvoi: async (_t, ids) => {
      cap.lectures += 1;
      return ids.flatMap((id) => { const f = m.fiches.get(id); return f ? [{ ...f }] : []; });
    },
    createSend: async (input, recipients) => { cap.sends.push({ input, recipients }); return { campaignId: 'camp1', recipientCount: recipients.length }; },
    enqueue: async (id, _t, _n, rate) => { cap.enqueued.push({ id, rate }); },
    // Le MÊME verdict que le magasin : c'est sa fonction pure qui décide.
    idempotencyClaim: async (_t, key, empreinte): Promise<IdempotencyClaim> => {
      const ligne = idem.get(key);
      if (!ligne) { idem.set(key, { hash: empreinte }); return { claimed: true }; }
      return verdictLigne({ send_id: ligne.sendId ?? null, response: ligne.response ?? null, request_hash: ligne.hash }, empreinte);
    },
    idempotencyComplete: async (_t, key, sendId, response) => { const l = idem.get(key); if (l) { l.sendId = sendId; l.response = response; } },
    idempotencyRelease: async (_t, key) => { idem.delete(key); },
    lireEnvoi: async () => null,
    sleep: async () => {}, // pas de temporisation réelle dans les tests de retry
    ...over,
  };
  // Le module `/v1/contacts` n'est pas appelé ici : le double muet du lot 1 suffit à le monter.
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts: contactsV1Muets(), sends } }), cap, idem, m };
}

const H = (key: string, idemKey?: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(idemKey ? { 'idempotency-key': idemKey } : {}) } });
const envoyer = (server: ReturnType<typeof app>['server'], payload: object, idemKey?: string, key = SEND_KEY) =>
  server.inject({ method: 'POST', url: '/v1/sends', ...H(key, idemKey), payload });

const TPL = { target: { template: { name: 'confirmation', language: 'fr' } } };
const SCN = (ref: string) => ({ target: { scenario: ref }, category: 'utility' as const });
const NODE = (code: string) => ({ target: { node: code }, category: 'utility' as const });
interface Rapport { sendId: string; opening: string; recipientCount: number; created: number; matched: number; skipped: Array<{ index: number; reason: string }>; skippedTotal: number }

describe('POST /v1/sends : cible template', () => {
  it('201 : catégorie LUE CHEZ META, ouverture whatsapp_template, campagne créée puis enfilée', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'marketing' } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-tpl');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sendId: 'camp1', opening: 'whatsapp_template', recipientCount: 1, created: 0, matched: 1, skipped: [], skippedTotal: 0 });
    expect(cap.sends[0]!.input).toMatchObject({ category: 'marketing', templateName: 'confirmation', templateLanguage: 'fr', name: '[API] confirmation', phoneNumberId: 'pn-default' });
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual([PHONE(1)]);
    expect(cap.enqueued).toEqual([{ id: 'camp1', rate: null }]);
    await server.close();
  });

  it('🔴 elle ne transmet AUCUN choix de relance, et c’est ce qui lui garde la règle d’avant (0165)', async () => {
    // `insertCampaignRow` pose `reessai_par_campagne` sur `input.reessayer !== undefined` : ajouter
    // `reessayer: true` ici par symétrie avec la console ferait relancer chaque échec de l'API.
    const { server, cap } = app();
    await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-relance');
    expect(Object.keys(cap.sends[0]!.input)).not.toContain('reessayer');
    await server.close();
  });

  it('🔴 défaut 2 : un template absent ou non approuvé -> 404 template_not_found, RIEN n’est créé', async () => {
    const { server, cap } = app({}, { modele: { statut: 'absent' } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-absent');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'template_not_found' });
    expect(cap.sends).toHaveLength(0);
    expect(cap.resolutions).toHaveLength(0);
    await server.close();
  });

  it('catégorie illisible chez Meta -> 422 template_category_unknown, jamais « utility » par défaut', async () => {
    const { server, cap } = app({}, { modele: { statut: 'illisible' } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-illisible');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'template_category_unknown' });
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('⚠️ catégorie LUE mais non envoyable (authentication) -> 422 qui la nomme, sans inviter à réessayer', async () => {
    const { server, cap } = app({}, { modele: { statut: 'categorie_non_admise', categorie: 'authentication' } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-auth');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'template_category_unknown' });
    expect(res.json<{ error: string }>().error).toContain('authentication');
    expect(res.json<{ error: string }>().error).not.toMatch(/réessayez/);
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('une `category` envoyée sur un template -> 400 invalid_body : elle est lue chez Meta', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...TPL, category: 'utility', recipients: [{ contactId: C1 }] }, 'i-cat');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toContain('category');
    await server.close();
  });

  it('🔴 params malformé -> 400 déterministe, jamais un 500', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], params: [{ position: 1, source: { key: 'prenom' } }] }, 'i-params-ko');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });
});

describe('POST /v1/sends : cible scénario', () => {
  it('un scénario qui ouvre par un template : 201, ouverture whatsapp_template, workflowId', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-scn');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_template', recipientCount: 1 });
    expect(cap.sends[0]!.input).toMatchObject({ workflowId: 'wf-scn_template', category: 'utility', name: '[API] scn_template' });
    expect(cap.sends[0]!.input.startNodeId).toBeUndefined();
    await server.close();
  });

  it('🔴 défaut 2 : un scénario qui ouvre par un message de session -> 422 unsendable_target, comme la console', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...SCN('scn_session'), recipients: [{ contactId: C1 }] }, 'i-scn-session');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'unsendable_target' });
    // Le message DIT le chemin qui marche : viser le bloc.
    expect(res.json<{ error: string }>().error).toContain('node');
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('🔴 un scénario jamais publié -> 422 unsendable_target, et le message le dit', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...SCN('scn_vide'), recipients: [{ contactId: C1 }] }, 'i-scn-vide');
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/publi/);
    await server.close();
  });

  it('sans `category` -> 400 ; avec des `params` -> 400', async () => {
    const { server } = app();
    expect((await envoyer(server, { target: { scenario: 'scn_template' }, recipients: [{ contactId: C1 }] }, 'i-sans-cat')).json()).toMatchObject({ code: 'invalid_body' });
    const params = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    expect((await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }], params }, 'i-params')).statusCode).toBe(400);
    await server.close();
  });

  it('introuvable -> 404 scenario_not_found ; nom ambigu -> 409 scenario_ambiguous ; bloc inconnu -> 404 node_not_found', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...SCN('scn_absent'), recipients: [{ contactId: C1 }] }, 'i1')).json()).toMatchObject({ code: 'scenario_not_found' });
    const ambigu = await envoyer(server, { ...SCN('Ambigu'), recipients: [{ contactId: C1 }] }, 'i2');
    expect(ambigu.statusCode).toBe(409);
    expect(ambigu.json()).toMatchObject({ code: 'scenario_ambiguous' });
    const bloc = await envoyer(server, { ...NODE('nod_x'), recipients: [{ contactId: C1 }] }, 'i3');
    expect(bloc.statusCode).toBe(404);
    expect(bloc.json()).toMatchObject({ code: 'node_not_found' });
    await server.close();
  });

  it('la fenêtre n’est PAS interrogée pour un scénario ou un template', async () => {
    const { server, cap } = app();
    await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-nowin-1');
    await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-nowin-2');
    expect(cap.fenetresDemandees).toEqual([]);
    await server.close();
  });
});

describe('POST /v1/sends : cible node', () => {
  it('🔴 défaut 3 : un bloc CONDITION qui mène à un message rapide exige la fenêtre : fermée -> window_closed', async () => {
    const { server, cap } = app({}, { fenetre: new Map() });
    const res = await envoyer(server, { ...NODE('nod_cond'), recipients: [{ contactId: C1 }] }, 'i-cond');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_session', recipientCount: 0, skipped: [{ index: 0, reason: 'window_closed' }], skippedTotal: 1 });
    expect(cap.sends[0]!.recipients).toEqual([]);
    await server.close();
  });

  it('bloc de session, fenêtre ouverte : 201, départ à CE bloc, libellé du bloc dans le nom', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }] }, 'i-qm');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_session', recipientCount: 1 });
    expect(cap.sends[0]!.input).toMatchObject({ workflowId: 'wf-nodes', startNodeId: 'qm' });
    expect(cap.sends[0]!.input.name).toContain('Bloc qm');
    await server.close();
  });

  it('la fenêtre est interrogée avec le wa_id (chiffres nus), pas le E.164', async () => {
    const { server, cap } = app();
    await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }] }, 'i-waid');
    expect(cap.fenetresDemandees).toEqual([['33612345001']]);
    await server.close();
  });

  it('mélange ouvert / fermé : seul l’ouvert part', async () => {
    const { server, cap } = app({}, { fenetre: new Map([['33612345001', true], ['33612345002', false]]) });
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }, { contactId: C2 }] }, 'i-mix');
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 1, reason: 'window_closed' }] });
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual([PHONE(1)]);
    await server.close();
  });

  it('ouverture de session : un numéro INCONNU est écarté unknown_contact, AUCUNE fiche créée', async () => {
    const { server, cap, m } = app();
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ phone: '+33700000009' }] }, 'i-inconnu');
    expect(res.json()).toMatchObject({ created: 0, skipped: [{ index: 0, reason: 'unknown_contact' }] });
    expect(cap.resolutions[0]!.creer).toBe('jamais');
    expect(m.fiches.size).toBe(2);
    await server.close();
  });

  it('bloc RCS : la fenêtre n’est PAS interrogée, et un numéro inconnu est CRÉÉ (joignable sans avoir écrit)', async () => {
    const { server, cap } = app({}, { fenetre: new Map() });
    const res = await envoyer(server, { ...NODE('nod_rcs'), recipients: [{ phone: '+33700000009' }] }, 'i-rcs');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'rcs', created: 1, recipientCount: 1, skipped: [] });
    expect(cap.resolutions[0]!.creer).toBe('phone');
    expect(cap.fenetresDemandees).toEqual([]);
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual(['+33700000009']);
    await server.close();
  });

  it('bloc RCS : une fiche sans numéro est `no_phone`, un STOP RCS est `opted_out`', async () => {
    const fiches = new Map<string, ContactEnvoi>([
      [C3, fiche(C3, 3, { phone_e164: null, bsuid: 'BS3' })],
      [C4, fiche(C4, 4, { rcsDesabonne: true })],
    ]);
    const { server } = app({}, { fiches });
    const res = await envoyer(server, { ...NODE('nod_rcs'), recipients: [{ contactId: C3 }, { contactId: C4 }] }, 'i-rcs-ecarts');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'no_phone' }, { index: 1, reason: 'opted_out' }] });
    await server.close();
  });

  it('un bloc suivi d’une attente avant tout envoi -> 422 unsendable_target', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...NODE('nod_attente'), recipients: [{ contactId: C1 }] }, 'i-attente');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'unsendable_target' });
    expect(res.json<{ error: string }>().error).toContain('attente');
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('des params sur une cible node -> 400 (ils ne seraient jamais envoyés)', async () => {
    const { server, cap } = app();
    const params = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }], params }, 'i-node-params');
    expect(res.statusCode).toBe(400);
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });
});

describe('POST /v1/sends : les destinataires', () => {
  it('🔴 défaut 1 : un contact BLOQUÉ est écarté blocked_contact, jamais compté puis perdu', async () => {
    const { server, cap } = app({}, { fiches: new Map([[C1, fiche(C1, 1, { bloque: true })]]) });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-bloque');
    expect(res.json()).toMatchObject({ matched: 1, recipientCount: 0, skipped: [{ index: 0, reason: 'blocked_contact' }], skippedTotal: 1 });
    expect(cap.sends[0]!.recipients).toEqual([]);
    await server.close();
  });

  it('🔴 aucune perte silencieuse : chaque destinataire finit envoyé OU écarté, une seule fois, avec son index', async () => {
    const fiches = new Map<string, ContactEnvoi>([
      [C1, fiche(C1, 1, { fields: { prenom: 'Camille' } })],
      [C2, fiche(C2, 2, { bloque: true })],
      [C3, fiche(C3, 3, { optInStatus: 'opted_out' })],
      [C4, fiche(C4, 4, { optInStatus: 'unknown' })],
      [C5, fiche(C5, 5)],
    ]);
    const { server } = app({}, { fiches, modele: { statut: 'approuve', categorie: 'marketing' } });
    const recipients = [
      { contactId: C1 },                        // 0 : part
      null,                                       // 1 : invalid_recipient
      { phone: 'pas-un-numero' },                 // 2 : invalid_phone
      { bsuid: 'inconnu' },                       // 3 : unknown_contact (un envoi ne fonde pas une fiche sur un BSUID)
      { contactId: C1 },                        // 4 : duplicate
      { contactId: C1, phone: PHONE(2) },       // 5 : identity_conflict
      { contactId: C2 },                        // 6 : blocked_contact
      { contactId: C3 },                        // 7 : opted_out
      { contactId: C4 },                        // 8 : no_consent
      { contactId: C5 },                        // 9 : missing_variable (pas de prénom)
      { phone: '+33700000001' },                  // 10 : créé, puis no_consent (marketing)
    ];
    const params = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    const res = await envoyer(server, { ...TPL, recipients, params }, 'i-invariant');
    const body = res.json<Rapport>();
    expect(body.skipped).toEqual([
      { index: 1, reason: 'invalid_recipient' },
      { index: 2, reason: 'invalid_phone' },
      { index: 3, reason: 'unknown_contact' },
      { index: 4, reason: 'duplicate' },
      { index: 5, reason: 'identity_conflict' },
      { index: 6, reason: 'blocked_contact' },
      { index: 7, reason: 'opted_out' },
      { index: 8, reason: 'no_consent' },
      { index: 9, reason: 'missing_variable' },
      { index: 10, reason: 'no_consent' },
    ]);
    expect(body.recipientCount + body.skippedTotal).toBe(recipients.length);
    expect(new Set(body.skipped.map((s) => s.index)).size).toBe(body.skipped.length);
    expect(body).toMatchObject({ recipientCount: 1, created: 1, matched: 6 });
    await server.close();
  });

  it('l’adresse WhatsApp vient de la FICHE : désignée par son BSUID, une fiche à numéro part sur son numéro', async () => {
    const { server, cap } = app({}, { fiches: new Map([[C1, fiche(C1, 1, { bsuid: 'BS1' })]]) });
    await envoyer(server, { ...TPL, recipients: [{ bsuid: 'BS1' }] }, 'i-adresse');
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual([PHONE(1)]);
    await server.close();
  });

  it('un destinataire en chaîne nue (ancienne forme) est écarté invalid_recipient, il ne fait pas tomber l’envoi', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...TPL, recipients: [PHONE(1), { contactId: C1 }] }, 'i-chaine');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 0, reason: 'invalid_recipient' }] });
    await server.close();
  });

  it('un `contactId` qui n’est pas au format d’un identifiant est écarté invalid_recipient, sans aller le chercher', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: 'pas-un-uuid' }, { contactId: C1 }] }, 'i-pas-uuid');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 0, reason: 'invalid_recipient' }] });
    expect(cap.resolutions.map((r) => r.cles.contactId)).toEqual([C1]);
    await server.close();
  });
});

describe('POST /v1/sends : le consentement par destinataire', () => {
  it('🔴 il est écrit AVANT la lecture des fiches, donc avant le tri marketing', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'marketing' }, fiches: new Map([[C1, fiche(C1, 1, { optInStatus: 'unknown' })]]) });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'opted_in' }] }, 'i-consent');
    expect(res.json()).toMatchObject({ recipientCount: 1, skippedTotal: 0 });
    expect(cap.consentements).toEqual([{ contactId: C1, consent: 'opted_in', source: 'api', lecturesAvant: 0 }]);
    await server.close();
  });

  it('opted_out : écrit avec sa source, puis ce destinataire est écarté opted_out', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'opted_out', consentSource: 'formulaire-site' }] }, 'i-optout');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }] });
    expect(cap.consentements).toEqual([{ contactId: C1, consent: 'opted_out', source: 'formulaire-site', lecturesAvant: 0 }]);
    await server.close();
  });

  it('un doublon n’écrit pas une seconde fois le consentement', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'opted_in' }, { contactId: C1, consent: 'opted_out' }] }, 'i-doublon');
    expect(cap.consentements.map((c) => c.consent)).toEqual(['opted_in']);
    expect(res.json()).toMatchObject({ skipped: [{ index: 1, reason: 'duplicate' }] });
    await server.close();
  });
});

describe('POST /v1/sends : idempotence', () => {
  const CORPS = { ...TPL, recipients: [{ contactId: C1 }] };

  it('clé dans le CORPS seulement : acceptée, et le rejeu rend le même rapport sans seconde campagne', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, { ...CORPS, idempotencyKey: 'k-corps' });
    const r2 = await envoyer(server, { ...CORPS, idempotencyKey: 'k-corps' });
    expect(r1.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('clé en en-tête puis dans le corps, même demande : même empreinte, rejeu', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, CORPS, 'k-mixte');
    const r2 = await envoyer(server, { ...CORPS, idempotencyKey: 'k-mixte' });
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('les deux, identiques : accepté', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...CORPS, idempotencyKey: 'k-deux' }, 'k-deux')).statusCode).toBe(201);
    await server.close();
  });

  it('les deux, DIFFÉRENTES : 400 invalid_body, rien n’est créé', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...CORPS, idempotencyKey: 'k-b' }, 'k-a');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('aucune clé : 400 idempotency_key_required', async () => {
    const { server } = app();
    const res = await envoyer(server, CORPS);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'idempotency_key_required' });
    await server.close();
  });

  it('🔴 la même clé avec un AUTRE corps : 422 idempotency_key_reused, jamais le rejeu silencieux du premier', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, CORPS, 'k-reuse');
    const r2 = await envoyer(server, { ...TPL, recipients: [{ contactId: C2 }] }, 'k-reuse');
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('un envoi identique en cours : 409 idempotency_in_progress', async () => {
    const { server, idem } = app();
    idem.set('k-busy', { hash: empreinteCorps(CORPS) });
    const res = await envoyer(server, CORPS, 'k-busy');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'idempotency_in_progress' });
    await server.close();
  });

  it('🔴 le rejeu d’un envoi SCELLÉ rend son rapport même si le template a changé depuis, et rien ne repart', async () => {
    // La clé est lue AVANT le numéro, la cible et le template : un rejeu légitime ne doit pas dépendre de
    // lectures qui bougent après coup, sinon l'intégrateur conclut à tort que rien n'est parti.
    const { server, cap, m } = app();
    const r1 = await envoyer(server, CORPS, 'k-scelle');
    m.modele = { statut: 'absent' };
    const r2 = await envoyer(server, CORPS, 'k-scelle');
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('un refus de cible LIBÈRE la clé : le même appel repart une fois le template approuvé', async () => {
    const { server, cap, m, idem } = app({}, { modele: { statut: 'absent' } });
    const r1 = await envoyer(server, CORPS, 'k-libere');
    expect(r1.statusCode).toBe(404);
    expect(idem.has('k-libere')).toBe(false);
    m.modele = { statut: 'approuve', categorie: 'utility' };
    const r2 = await envoyer(server, CORPS, 'k-libere');
    expect(r2.statusCode).toBe(201);
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('scelle l’idempotence AVANT enqueue : un échec d’enqueue -> 201 sans release (pas de double envoi au retry)', async () => {
    const order: string[] = [];
    let released = false;
    const { server } = app({
      createSend: async (_i, recipients) => { order.push('createSend'); return { campaignId: 'campX', recipientCount: recipients.length }; },
      idempotencyComplete: async () => { order.push('complete'); },
      enqueue: async () => { order.push('enqueue'); throw new Error('pg-boss down'); },
      idempotencyRelease: async () => { released = true; },
    });
    const res = await envoyer(server, CORPS, 'k-seal');
    expect(res.statusCode).toBe(201);
    expect(order).toEqual(['createSend', 'complete', 'enqueue', 'enqueue', 'enqueue']);
    expect(released).toBe(false);
    await server.close();
  });

  it('enqueue : échec TRANSITOIRE -> retry -> succès', async () => {
    let attempts = 0;
    let released = false;
    const { server } = app({
      enqueue: async () => { attempts += 1; if (attempts < 3) throw new Error('pg-boss saturé'); },
      idempotencyRelease: async () => { released = true; },
    });
    expect((await envoyer(server, CORPS, 'k-retry')).statusCode).toBe(201);
    expect(attempts).toBe(3);
    expect(released).toBe(false);
    await server.close();
  });

  it('enqueue : échec PERSISTANT -> borné à 3 tentatives, 201, idempotence toujours scellée', async () => {
    let attempts = 0;
    let released = false;
    const { server } = app({
      enqueue: async () => { attempts += 1; throw new Error('pg-boss down'); },
      idempotencyRelease: async () => { released = true; },
    });
    expect((await envoyer(server, CORPS, 'k-retry-ko')).statusCode).toBe(201);
    expect(attempts).toBe(3);
    expect(released).toBe(false);
    await server.close();
  });

  it('échec AVANT scellement (createSend lève) -> release (retry propre)', async () => {
    let released = false;
    const { server } = app({
      createSend: async () => { throw new Error('db down'); },
      idempotencyRelease: async () => { released = true; },
    });
    await expect(envoyer(server, CORPS, 'k-fail')).resolves.toMatchObject({ statusCode: 500 });
    expect(released).toBe(true);
    await server.close();
  });
});

describe('POST /v1/sends : forme, numéro, débit, droits', () => {
  it('ratePerMinute : entier de 1 à 80, sinon 400 (plus de ramenage ni d’extinction silencieuse)', async () => {
    const { server, cap } = app();
    for (const [i, r] of ([0, 81, 2.5, '20'] as const).entries()) {
      expect((await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], ratePerMinute: r }, `i-rate-${i}`)).statusCode, String(r)).toBe(400);
    }
    expect((await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], ratePerMinute: 20 }, 'i-rate-ok')).statusCode).toBe(201);
    expect(cap.enqueued).toEqual([{ id: 'camp1', rate: 20 }]);
    await server.close();
  });

  it('`createMissing` a disparu : 400 invalid_body qui le nomme', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], createMissing: false }, 'i-cm');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('createMissing');
    await server.close();
  });

  it('recipients vide ou de plus de 50 ; cible absente -> 400 qui décrit les cibles', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...TPL, recipients: [] }, 'i-vide')).statusCode).toBe(400);
    const beaucoup = Array.from({ length: 51 }, () => ({ contactId: C1 }));
    expect((await envoyer(server, { ...TPL, recipients: beaucoup }, 'i-51')).statusCode).toBe(400);
    const sansCible = await envoyer(server, { recipients: [{ contactId: C1 }] }, 'i-sans-cible');
    expect(sansCible.statusCode).toBe(400);
    expect(sansCible.json<{ error: string }>().error).toContain('template');
    await server.close();
  });

  it('phoneNumberId d’un autre espace -> 400 invalid_body ; espace sans numéro -> 409 no_whatsapp_number', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], phoneNumberId: 'pn-autrui' }, 'i-pn')).json()).toMatchObject({ code: 'invalid_body' });
    await server.close();
    const sans = app({ getTenantPhoneNumberId: async () => null });
    const res = await envoyer(sans.server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-sans-pn');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_whatsapp_number' });
    await sans.server.close();
  });

  it('sans clé -> 401 unauthorized ; sans le droit sends:create -> 403 missing_scope', async () => {
    const { server } = app();
    const sans = await server.inject({ method: 'POST', url: '/v1/sends', headers: { 'content-type': 'application/json' }, payload: { ...TPL, recipients: [{ contactId: C1 }] } });
    expect(sans.statusCode).toBe(401);
    expect(sans.json()).toMatchObject({ code: 'unauthorized' });
    const scope = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-scope', NOSCOPE_KEY);
    expect(scope.statusCode).toBe(403);
    expect(scope.json()).toMatchObject({ code: 'missing_scope' });
    await server.close();
  });
});

describe('GET /v1/sends/{sendId}', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const BRUT: EnvoiApiBrut = {
    id: ID, status: 'running', createdAt: '2026-09-24T10:00:00.000Z', channel: 'whatsapp', templateName: 'confirmation', templateLanguage: 'fr',
    workflowCode: null, startNodeId: null, graph: null,
    counts: { pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 },
    recipients: [{ contactId: C1, externalId: 'crm-7781', status: 'sent', messageId: 'wamid.A', error: null, errorCode: null, sentAt: '2026-09-24T10:00:05.000Z', deliveryStatus: 'delivered', deliveryError: null }],
  };

  it('trouvé : 200 et le CONTRAT de l’API, pas l’objet de la console', async () => {
    const { server } = app({ lireEnvoi: async (id, t) => (id === ID && t === 't1' ? BRUT : null) });
    const res = await server.inject({ method: 'GET', url: `/v1/sends/${ID}`, ...H(SEND_KEY) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(formaterSuiviEnvoi(BRUT));
    await server.close();
  });

  it('inconnu -> 404 send_not_found ; identifiant qui n’est pas un uuid -> 404 aussi, sans lecture, jamais un 500', async () => {
    let lectures = 0;
    const { server } = app({ lireEnvoi: async () => { lectures += 1; return null; } });
    const inconnu = await server.inject({ method: 'GET', url: '/v1/sends/22222222-2222-4222-8222-222222222222', ...H(SEND_KEY) });
    expect(inconnu.statusCode).toBe(404);
    expect(inconnu.json()).toMatchObject({ code: 'send_not_found' });
    const pasUuid = await server.inject({ method: 'GET', url: '/v1/sends/inconnu', ...H(SEND_KEY) });
    expect(pasUuid.statusCode).toBe(404);
    expect(pasUuid.json()).toMatchObject({ code: 'send_not_found' });
    expect(lectures).toBe(1);
    await server.close();
  });
});
```

Créer `tests/v1-cablage.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DE `/v1/sends`, LU DANS `src/index.ts`.
 *
 * 🔴 POURQUOI UN TEST DE SOURCE. Une flèche à moins de paramètres est assignable à un contrat qui en déclare
 * plus : `(tenant, key) => store.claim(tenant, key, 'x')` ou `(t, id, consent) => appliquerConsentement(…,
 * 'api')` compileraient et avaleraient l'empreinte ou la source du consentement, en silence. Même famille que
 * `tests/workflow-cablage-categorie.test.ts` et `tests/campagne-cablage.test.ts`.
 */
const sansCommentaires = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const source = sansCommentaires('../src/index.ts');

describe('câblage de /v1/sends', () => {
  it('🔴 l’empreinte du corps atteint le magasin d’idempotence', () => {
    expect(source).toMatch(/idempotencyClaim: \(tenant, key, empreinte\) => idempotencyStore\.claim\(tenant, key, empreinte\)/);
  });

  it('🔴 la SOURCE du consentement atteint l’écriture', () => {
    expect(source).toMatch(/appliquerConsentement: \(tenant, contactId, consent, source\) => appliquerConsentement\(depsConsentement, tenant, contactId, consent, source\)/);
  });

  it('🔴 le consentement a UNE construction, partagée avec `/v1/contacts` : `depsConsentementDe`, des deux côtés', () => {
    expect(source).toMatch(/const depsConsentement = depsConsentementDe\(contactStore, auditSink\)/);
    expect(sansCommentaires('../src/api/contacts-v1.ts')).toMatch(/depsConsentementDe\(deps\.contacts, deps\.audit\)/);
  });

  it('🔴 la résolution de fiche lit le MÊME dépôt que `/v1/contacts`, et ses quatre paramètres passent', () => {
    expect(source).toMatch(/resoudreFiche: \(tenant, cles, o\) => resoudreFiche\(contactStore, tenant, cles, o\)/);
  });

  it('🔴 la catégorie d’un template est lue chez Meta, avec la langue DEMANDÉE', () => {
    expect(source).toMatch(/verdictModele\(await workflowRuntime\.templateVarInfo\(tenant, name, language\), language\)/);
  });

  it('les contacts de l’API sont lus par la lecture qui garde les bloqués', () => {
    expect(source).toMatch(/listContactsPourEnvoi: \(tenant, ids\) => repo\.listContactsPourEnvoiApi\(tenant, ids\)/);
  });
});
```

- [ ] **Step 3: Les voir échouer**

Run: `npx vitest run tests/v1-sends.test.ts tests/v1-cablage.test.ts`
Expected: FAIL à l'EXÉCUTION (vitest ne vérifie pas les types). L'ancienne route exige encore `category` sur un template et lit des numéros nus : les cas de template rendent 400 là où ils attendent 201, 404 ou 422, et les autres échouent sur leur statut ou leur corps ; le GET appelle `getSendDetail`, absent de la fixture (500 au lieu de 200 ou 404). `tests/v1-cablage.test.ts` ne trouve aucun de ses motifs.
Run: `npm run typecheck`
Expected: FAIL sur la fixture : `lireModele`, `resoudreFiche`, `appliquerConsentement`, `listContactsPourEnvoi`, `lireEnvoi` n'existent pas dans `V1SendsRouteDeps`, et `findContactByPhone`, `createContactByPhone`, `listContactsForBuildByIds`, `getSendDetail` y manquent.

- [ ] **Step 4: Réécrire `src/http/v1-sends.ts`**

Remplacer tout le fichier par :

```ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { waIdOf } from '../crm/identity';
import type { BuiltRecipient, ContactEnvoi } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
import type { EnvoiApiBrut } from '../campaign/store.pg';
import { validateParamMapping, type TemplateParam } from '../crm/template';
import type { ResolveResult } from '../ids/resolve';
import type { WorkflowGraph } from '../workflow/graph';
import { ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';
import type { IdempotencyClaim } from '../api/idempotency-store.pg';
import { cleIdempotence, empreinteCorps } from '../api/idempotence';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { refuser, type CodeApi } from '../api/erreurs';
import { schemaClesFiche, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { MAX_OPT_IN_SOURCE } from '../api/contacts-upsert';
import { construireDestinataires, marquerDoublons, trierDestinataires, type DestinataireResolu, type Ecart } from '../api/sends-build';
import type { LectureModele } from '../api/modele-envoi';
import { messageDeForme } from '../api/forme';
import { formaterSuiviEnvoi } from '../api/suivi-envoi';

export interface V1SendCreateInput {
  tenantId: string;
  phoneNumberId: string;
  name: string;
  category: CampaignCategory;
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  workflowId?: string;
  /** Cible node : le run démarre à ce bloc du scénario (au lieu de son entrée). */
  startNodeId?: string;
}

export interface V1SendsRouteDeps {
  /**
   * Le garde d'usage, injecté au bootstrap. OBLIGATOIRE, comme sur `/v1/contacts` : optionnel, il
   * manquerait un jour à une route et le compteur de cette route disparaîtrait sans bruit.
   */
  usage: ApiUsageGuard;
  /** Scénario par code `scn_` ou par nom, AVEC son graphe PUBLIÉ : c'est lui que `ouvertureApi` juge. */
  resolveScenario(tenantId: string, ref: string): Promise<ResolveResult<{ id: string; name: string; graph: WorkflowGraph }>>;
  /** Bloc par code `nod_`, dans les graphes PUBLIÉS, avec le graphe d'où juger ce qui part depuis lui. */
  resolveNode(tenantId: string, code: string): Promise<ResolveResult<{ workflowId: string; nodeId: string; label: string; graph: WorkflowGraph }>>;
  /** Le template lu chez Meta : sa catégorie, ou pourquoi il ne peut pas partir (`verdictModele`). */
  lireModele(tenantId: string, name: string, language: string): Promise<LectureModele>;
  /** Fenêtre de service 24 h par wa_id. Absent de la map = fermée. Lue pour une ouverture de session seulement. */
  getWindowOpenByWaIds(tenantId: string, waIds: string[]): Promise<Map<string, boolean>>;
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /** La résolution de fiche du lot 1 (`resoudreFiche`), liée à ses dépendances par le câblage. */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /** L'écriture du consentement du lot 1 (`appliquerConsentement`), liée à ses dépendances par le câblage. */
  appliquerConsentement(tenantId: string, contactId: string, consent: 'opted_in' | 'opted_out', source: string): Promise<void>;
  /** Les fiches désignées, BLOQUÉES COMPRISES (`listContactsPourEnvoiApi`). */
  listContactsPourEnvoi(tenantId: string, ids: string[]): Promise<ContactEnvoi[]>;
  createSend(input: V1SendCreateInput, recipients: BuiltRecipient[]): Promise<{ campaignId: string; recipientCount: number }>;
  /** `tenantId` porte le GROUPE de la file (lot 5) : la concurrence des runs est plafonnée par espace. */
  enqueue(campaignId: string, tenantId: string, pendingCount: number, ratePerMinute: number | null): Promise<void>;
  /** `empreinte` = `empreinteCorps(corps)` : la même clé avec un autre corps rend `reused`. */
  idempotencyClaim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>;
  idempotencyComplete(tenantId: string, key: string, sendId: string, response: unknown): Promise<void>;
  idempotencyRelease(tenantId: string, key: string): Promise<void>;
  /** L'envoi tel que `GET /v1/sends/{sendId}` le décrit, avant mise en forme (`lireEnvoiApi`). */
  lireEnvoi(sendId: string, tenantId: string): Promise<EnvoiApiBrut | null>;
  /** Attente entre deux tentatives d'enqueue. Injectable pour tester le retry sans temporisation réelle. */
  sleep?(ms: number): Promise<void>;
}

const MAX_RECIPIENTS = 50;
const MAX_SKIPPED_REPORT = 200;
/** Retry borné de l'enqueue : 3 tentatives, backoff court entre chacune. Cf. la note au call site sur ce qui
 *  rend ce retry sûr (ce n'est PAS une déduplication de file). */
const ENQUEUE_MAX_ATTEMPTS = 3;
const ENQUEUE_RETRY_DELAYS_MS = [100, 300];

/**
 * LES TROIS CIBLES DE CE LOT. Strictes : un objet qui porterait deux cibles, ou une clé mal orthographiée, est
 * refusé plutôt que lu à moitié. Le lot 3 ajoute `rcsMessage` à cette union.
 */
const schemaCible = z.union([
  z.strictObject({ template: z.strictObject({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(1).max(20) }) }),
  z.strictObject({ scenario: z.string().trim().min(1).max(200) }),
  z.strictObject({ node: z.string().trim().min(1).max(200) }),
]);

/**
 * LE CORPS. STRICT au premier niveau : c'est une enveloppe que NOUS définissons, une clé mal orthographiée
 * (`ratePerMinutes`) ne doit pas changer le comportement en silence, et une clé disparue (`createMissing`)
 * doit se voir. `recipients` reste en `unknown[]` : un destinataire mal formé est ÉCARTÉ, il ne fait pas
 * tomber l'envoi.
 */
const schemaCorps = z.strictObject({
  idempotencyKey: z.string().optional(),
  target: schemaCible,
  recipients: z.array(z.unknown()).min(1).max(MAX_RECIPIENTS),
  params: z.array(z.unknown()).optional(),
  category: z.enum(['marketing', 'utility']).optional(),
  ratePerMinute: z.number().int().min(1).max(80).optional(),
  phoneNumberId: z.string().trim().min(1).max(64).optional(),
});

/**
 * UN DESTINATAIRE : les clés de fiche du lot 1, plus son consentement. Ses clés inconnues sont ÉCARTÉES, pas
 * refusées, comme sur `/v1/contacts` : l'outil de l'appelant peut y laisser des données de son propre profil.
 */
const schemaDestinataire = z.object({
  ...schemaClesFiche.shape,
  consent: z.enum(['opted_in', 'opted_out']).optional(),
  consentSource: z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional(),
});

const PRECISIONS = {
  target: 'une cible parmi { "template": { "name", "language" } }, { "scenario": "scn_…" ou un nom } et { "node": "nod_…" }',
} as const;

type Corps = z.infer<typeof schemaCorps>;
type Refus = { refus: { statut: 400 | 404 | 409 | 422; code: CodeApi; message: string } };

/** La cible demandée, après les règles de forme qui dépendent d'elle. Pure : aucune lecture. */
type CibleDemandee =
  | { kind: 'template'; name: string; language: string }
  | { kind: 'scenario'; ref: string; category: CampaignCategory }
  | { kind: 'node'; code: string; category: CampaignCategory };

/** La cible résolue : ce qui part en premier, la catégorie qui décide du consentement, ce qu'on écrit. */
interface CibleResolue {
  ouverture: OuvertureApi;
  category: CampaignCategory;
  label: string;
  templateName: string;
  templateLanguage: string;
  workflowId?: string;
  startNodeId?: string;
}

interface RapportEnvoi {
  sendId: string;
  opening: OuvertureApi;
  recipientCount: number;
  created: number;
  matched: number;
  skipped: Ecart[];
  skippedTotal: number;
}

function lireCible(corps: Corps, params: TemplateParam[]): CibleDemandee | { message: string } {
  const t = corps.target;
  if ('template' in t) {
    // La catégorie d'un template est LUE CHEZ META : l'accepter du corps laisserait un appelant la déclarer.
    if (corps.category !== undefined) return { message: 'category : refusé sur un template, sa catégorie est lue chez Meta' };
    return { kind: 'template', name: t.template.name, language: t.template.language };
  }
  if (corps.category === undefined) return { message: 'category : requise sur un scénario ou un bloc (marketing | utility)' };
  if (params.length > 0) return { message: 'params : n’a de sens que sur un template (aucune variable n’est envoyée à un scénario ou à un bloc)' };
  return 'scenario' in t
    ? { kind: 'scenario', ref: t.scenario, category: corps.category }
    : { kind: 'node', code: t.node, category: corps.category };
}

async function numeroDEnvoi(deps: V1SendsRouteDeps, tenantId: string, demande: string | undefined): Promise<{ phoneNumberId: string } | Refus> {
  if (demande !== undefined) {
    return await deps.phoneNumberBelongsToTenant(demande, tenantId)
      ? { phoneNumberId: demande }
      : { refus: { statut: 400, code: 'invalid_body', message: 'phoneNumberId : numéro inconnu de cet espace' } };
  }
  const defaut = await deps.getTenantPhoneNumberId(tenantId);
  return defaut
    ? { phoneNumberId: defaut }
    : { refus: { statut: 409, code: 'no_whatsapp_number', message: 'aucun numéro WhatsApp connecté sur cet espace' } };
}

/**
 * LA CIBLE RÉSOLUE, avec ce qu'elle fait partir en premier (spec 2026-09-24, § 3).
 *
 * 🔴 LES GARDES DE LA CONSOLE, ALIGNÉES (défaut 2) : l'API répondait 201 à un scénario que la création de
 * campagne refuse, à un template inconnu ou non approuvé, et chaque destinataire échouait ensuite chez Meta.
 *
 * 🔴 UNE CIBLE `node` EST JUGÉE SUR CE QUI PART EN PREMIER DEPUIS ELLE (défaut 3), plus sur le type du bloc.
 */
async function resoudreCible(deps: V1SendsRouteDeps, tenantId: string, c: CibleDemandee): Promise<CibleResolue | Refus> {
  if (c.kind === 'template') {
    const lu = await deps.lireModele(tenantId, c.name, c.language);
    if (lu.statut === 'absent') {
      return { refus: { statut: 404, code: 'template_not_found', message: `template introuvable, non approuvé ou d’une autre langue : ${c.name} (${c.language})` } };
    }
    if (lu.statut === 'illisible') {
      return { refus: { statut: 422, code: 'template_category_unknown', message: 'la catégorie de ce template n’a pas pu être lue chez Meta : l’envoi est refusé par prudence, réessayez dans un instant' } };
    }
    if (lu.statut === 'categorie_non_admise') {
      // LUE, et définitive : réessayer n'y changera rien, le message ne doit pas le suggérer.
      return { refus: { statut: 422, code: 'template_category_unknown', message: `catégorie ${lu.categorie.slice(0, 40)} non envoyable par l’API : un template marketing ou utility est attendu` } };
    }
    return { ouverture: 'whatsapp_template', category: lu.categorie, label: c.name, templateName: c.name, templateLanguage: c.language };
  }
  if (c.kind === 'scenario') {
    const r = await deps.resolveScenario(tenantId, c.ref);
    if (!r.ok && r.reason === 'ambiguous') {
      return { refus: { statut: 409, code: 'scenario_ambiguous', message: 'plusieurs scénarios portent ce nom : désignez-le par son code scn_' } };
    }
    if (!r.ok) return { refus: { statut: 404, code: 'scenario_not_found', message: 'scénario introuvable' } };
    const v = ouvertureApi(r.value.graph);
    if (v.ouverture === null) return { refus: { statut: 422, code: 'unsendable_target', message: `ce scénario ne peut pas partir : ${v.raison}` } };
    if (v.ouverture === 'whatsapp_session') {
      return { refus: { statut: 422, code: 'unsendable_target', message: 'ce scénario ouvre par un message de session (message rapide, question, formulaire ou agent), qui exige que le contact ait écrit dans les 24 h : visez le bloc (cible node) pour écrire à quelqu’un dans sa fenêtre' } };
    }
    return { ouverture: v.ouverture, category: c.category, label: r.value.name, templateName: '', templateLanguage: '', workflowId: r.value.id };
  }
  const r = await deps.resolveNode(tenantId, c.code);
  if (!r.ok) return { refus: { statut: 404, code: 'node_not_found', message: 'bloc introuvable dans les scénarios publiés' } };
  const v = ouvertureApi(r.value.graph, r.value.nodeId);
  if (v.ouverture === null) return { refus: { statut: 422, code: 'unsendable_target', message: `ce bloc ne peut pas partir : ${v.raison}` } };
  return { ouverture: v.ouverture, category: c.category, label: r.value.label, templateName: '', templateLanguage: '', workflowId: r.value.workflowId, startNodeId: r.value.nodeId };
}

/**
 * Chaque destinataire résolu en fiche par la fonction PARTAGÉE du lot 1, ou écarté avec son motif.
 *
 * ⚠️ `creer` vient de l'ouverture : un template ou un RCS part vers quelqu'un qui n'a pas écrit, donc un
 * `phone` inconnu fonde une fiche ; une ouverture de session n'a par construction aucune fenêtre chez un
 * inconnu, donc `jamais`. Un inconnu qui ne porte qu'un `bsuid` n'est jamais créé ici (`phone`).
 */
async function resoudreDestinataires(
  deps: V1SendsRouteDeps, tenantId: string, bruts: unknown[], creer: ModeCreation,
): Promise<{ resolus: DestinataireResolu[]; created: number; matched: number }> {
  const resolus: DestinataireResolu[] = [];
  let created = 0;
  let matched = 0;
  for (const [index, brut] of bruts.entries()) {
    const d = schemaDestinataire.safeParse(brut);
    if (!d.success) { resolus.push({ index, ecart: 'invalid_recipient' }); continue; }
    const { consent, consentSource, ...cles } = d.data;
    const r = await deps.resoudreFiche(tenantId, cles, { creer });
    if (!r.ok) { resolus.push({ index, ecart: r.code }); continue; }
    if (r.cree) created += 1; else matched += 1;
    resolus.push(consent ? { index, contactId: r.contactId, consent, consentSource: consentSource ?? 'api' } : { index, contactId: r.contactId });
  }
  return { resolus, created, matched };
}

/** La fenêtre de 24 h par contact, en UNE requête pour tout le lot, interrogée avec le wa_id (chiffres nus). */
async function fenetresParContact(deps: V1SendsRouteDeps, tenantId: string, contacts: ContactEnvoi[]): Promise<Map<string, boolean>> {
  const waIdParContact = new Map<string, string>();
  for (const c of contacts) {
    const w = waIdOf(c.phone_e164, c.bsuid);
    if (w) waIdParContact.set(c.id, w);
  }
  const parWaId = await deps.getWindowOpenByWaIds(tenantId, [...new Set(waIdParContact.values())]);
  return new Map([...waIdParContact].map(([id, w]) => [id, parWaId.get(w) === true]));
}

const FORME_ID_ENVOI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schemaIdEnvoi = z.object({ sendId: z.string().regex(FORME_ID_ENVOI) });

/**
 * API publique /v1 des envois (spec 2026-09-24, § 3). Tenant issu de la clé (`req.auth`), jamais du corps.
 * Garde attendue : `[makeRequireApiKey, requireScope('sends:create')]`.
 *
 * 🔴 L'ORDRE COMPTE : la forme (gratuite), le compteur d'usage, le claim d'idempotence, PUIS le numéro et la
 * cible (des lectures), et SEULEMENT ALORS ce qui écrit (fiches, consentements, campagne). Le claim passe
 * AVANT les lectures : un rejeu légitime rend le rapport SCELLÉ même si, depuis, le template est repassé en
 * attente, le scénario dépublié ou le numéro retiré (sinon 404, 409 ou 422 feraient croire à l'intégrateur
 * que rien n'est parti). Un refus après le claim LIBÈRE la clé, une erreur aussi.
 */
export function registerV1Sends(app: FastifyInstance, deps: V1SendsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/sends', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const lu = schemaCorps.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error, PRECISIONS));
    const corps = lu.data;
    const idem = cleIdempotence(req.headers['idempotency-key'], corps);
    if (!idem.ok) return refuser(reply, 400, idem.code, idem.message);
    // Même validation que la route console : une source malformée casserait sinon au moment de résoudre les
    // variables, en 500 sur un endpoint public au lieu d'un 400 déterministe.
    const params = validateParamMapping(corps.params ?? []);
    if (params === null) return refuser(reply, 400, 'invalid_body', 'params : positions 1..N contiguës et sources valides attendues');
    const demandee = lireCible(corps, params);
    if ('message' in demandee) return refuser(reply, 400, 'invalid_body', demandee.message);

    /**
     * ⚠️ COMPTÉ AVANT LA RÉSOLUTION DE LA CIBLE, qui fait déjà des lectures (scénario, bloc, template chez
     * Meta, numéro). Compter après laisserait ce travail-là hors des compteurs.
     */
    if (!await compterOuRefuser(deps.usage, req, reply, 'sends.create', corps.recipients.length)) return reply;

    // Idempotence : claim atomique AVEC l'empreinte du corps, AVANT toute lecture qui peut changer d'un appel à
    // l'autre (numéro, cible, template chez Meta). Autre corps -> 422 ; concurrent -> 409 ; déjà scellé ->
    // rejeu du rapport, tel quel.
    const claim = await deps.idempotencyClaim(tenantId, idem.cle, empreinteCorps(req.body));
    if (!claim.claimed && 'reused' in claim) {
      return refuser(reply, 422, 'idempotency_key_reused', 'cette clé d’idempotence a déjà servi pour un autre corps : une clé désigne un seul envoi, et elle vit 24 h');
    }
    if (!claim.claimed && 'pending' in claim) {
      return refuser(reply, 409, 'idempotency_in_progress', 'un envoi avec cette clé d’idempotence est en cours : réessayez dans un instant');
    }
    if (!claim.claimed) return reply.code(201).send(claim.response);

    /** Un refus après le claim n'a rien créé : la clé est LIBÉRÉE, le même appel repartira une fois corrigé. */
    const libererEtRefuser = async (r: Refus['refus']) => {
      await deps.idempotencyRelease(tenantId, idem.cle);
      return refuser(reply, r.statut, r.code, r.message);
    };

    // Rempli + scellé dans le try ; l'enqueue (hors try) le lit après scellement (definite assignment).
    let report!: RapportEnvoi;
    try {
      const numero = await numeroDEnvoi(deps, tenantId, corps.phoneNumberId);
      if ('refus' in numero) return await libererEtRefuser(numero.refus);
      const cible = await resoudreCible(deps, tenantId, demandee);
      if ('refus' in cible) return await libererEtRefuser(cible.refus);
      const { resolus, created, matched } = await resoudreDestinataires(
        deps, tenantId, corps.recipients, cible.ouverture === 'whatsapp_session' ? 'jamais' : 'phone',
      );
      const uniques = marquerDoublons(resolus);
      /**
       * 🔴 LE CONSENTEMENT S'ÉCRIT AVANT LA LECTURE DES FICHES, donc avant le tri marketing (spec § 3) : un
       * outil où vit le consentement envoie sans pousser chaque fiche au préalable. Une fois par fiche : un
       * doublon n'écrit rien.
       */
      for (const r of uniques) {
        if ('contactId' in r && r.consent) await deps.appliquerConsentement(tenantId, r.contactId, r.consent, r.consentSource ?? 'api');
      }
      const contacts = await deps.listContactsPourEnvoi(tenantId, uniques.flatMap((r) => ('contactId' in r ? [r.contactId] : [])));
      const fenetre = cible.ouverture === 'whatsapp_session' ? await fenetresParContact(deps, tenantId, contacts) : undefined;
      const tri = trierDestinataires({
        category: cible.category, ouverture: cible.ouverture, resolus: uniques, contacts,
        ...(fenetre ? { fenetreOuverteParContact: fenetre } : {}),
      });
      const { recipients, ecarts } = construireDestinataires(cible.category, params, tri, new Date());
      report = {
        sendId: '',
        opening: cible.ouverture,
        recipientCount: recipients.length,
        created,
        matched,
        skipped: ecarts.slice(0, MAX_SKIPPED_REPORT),
        skippedTotal: ecarts.length,
      };
      const send = await deps.createSend(
        {
          tenantId, phoneNumberId: numero.phoneNumberId, name: `[API] ${cible.label}`.slice(0, 120), category: cible.category,
          templateName: cible.templateName, templateLanguage: cible.templateLanguage, paramMapping: params,
          ...(cible.workflowId ? { workflowId: cible.workflowId } : {}),
          ...(cible.startNodeId ? { startNodeId: cible.startNodeId } : {}),
        },
        recipients,
      );
      report.sendId = send.campaignId;
      // SCELLE l'idempotence AVANT l'enqueue : sans ça, un échec de complete APRÈS un enqueue réussi ferait
      // release, et un retry recréerait une 2e campagne, donc renverrait les messages EN DOUBLE. Échec avant
      // scellement -> release + throw (retry propre).
      await deps.idempotencyComplete(tenantId, idem.cle, send.campaignId, report);
    } catch (err) {
      await deps.idempotencyRelease(tenantId, idem.cle);
      throw err;
    }

    // Idempotence scellée, DÉFINITIVEMENT : aucun chemin ci-dessous ne release. On RETENTE l'enfilement pour
    // couvrir le hoquet transitoire de la file au lieu de laisser une campagne draft jamais lancée. Échec
    // persistant -> 201 + log fort : sous-envoi assumé, jamais de sur-envoi.
    //
    // ⚠️ Ce qui rend le retry sûr, c'est le claim atomique par destinataire, PAS une déduplication de file :
    // il n'y en a aucune. Borné à 3 tentatives, sur un chemin d'échec rare.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await deps.enqueue(report.sendId, tenantId, report.recipientCount, corps.ratePerMinute ?? null);
        break;
      } catch (err) {
        const last = attempt === ENQUEUE_MAX_ATTEMPTS - 1;
        // eslint-disable-next-line no-console
        console.error(
          last
            ? `v1/sends: enqueue échoué ${ENQUEUE_MAX_ATTEMPTS} fois après scellement idempotence (campagne NON lancée, à ré-enfiler à la main):`
            : `v1/sends: enqueue échoué (tentative ${attempt + 1}/${ENQUEUE_MAX_ATTEMPTS}), nouvelle tentative:`,
          report.sendId,
          err instanceof Error ? err.message : err,
        );
        if (last) break;
        await sleep(ENQUEUE_RETRY_DELAYS_MS[attempt] ?? 300);
      }
    }
    return reply.code(201).send(report);
  });

  app.get('/v1/sends/:sendId', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    // ⚠️ UNE LECTURE COMPTE AUSSI, POUR UNE UNITÉ, et AVANT le contrôle de forme : un intégrateur qui sonde
    // l'avancement toutes les secondes est exactement l'usage qu'on veut VOIR.
    if (!await compterOuRefuser(deps.usage, req, reply, 'sends.read')) return reply;
    // Un identifiant qui n'est pas un uuid ferait lever Postgres (22P02), donc un 500 : il est inconnu, 404.
    const p = schemaIdEnvoi.safeParse(req.params);
    if (!p.success) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    const brut = await deps.lireEnvoi(p.data.sendId, req.auth.tenantId);
    if (!brut) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    return reply.code(200).send(formaterSuiviEnvoi(brut));
  });
}
```

- [ ] **Step 5: Une seule construction des dépendances du consentement (`depsConsentementDe`)**

Ce que le lot 1 laisse, et pourquoi il faut y toucher : `resoudreFiche` prend `DepsFiche = Pick<PgContactStore, …>`, donc `contactStore` lui-même, ce que `creerServiceContactsV1` lui passe déjà (`deps.contacts`) : rien à construire, le câblage de l'étape 6 lui passe `contactStore`. Le consentement, lui, a son `DepsConsentement` construit DANS `creerServiceContactsV1` (`src/api/contacts-v1.ts`, `const consentement: DepsConsentement = { ecrireConsentementParId: …, audit: deps.audit }`) : `src/index.ts` n'a aucune expression à réutiliser, et en écrire une seconde ferait deux constructions qui peuvent diverger (une route journaliserait un consentement que l'autre ne journaliserait pas). La construction devient une fonction du module qui possède le type, et les deux appelants s'en servent.

a) Créer `tests/api-consentement-deps.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { depsConsentementDe } from '../src/api/consentement';
import type { AuditSink } from '../src/audit/journal';

/**
 * LES DÉPENDANCES DU CONSENTEMENT, CONSTRUITES À UN SEUL ENDROIT (`/v1/contacts` et `/v1/sends`).
 *
 * 🔴 Deux constructions divergeraient : une route journaliserait un consentement que l'autre écrirait sans
 * trace. `tests/v1-cablage.test.ts` vérifie que les deux appelants passent par cette fonction.
 */
describe('depsConsentementDe', () => {
  it('🔴 les quatre paramètres atteignent le dépôt, et l’audit est celui qu’on donne', async () => {
    const recus: unknown[][] = [];
    const audit: AuditSink = async () => {};
    const deps = depsConsentementDe({ ecrireConsentementParId: async (...a) => { recus.push(a); return 'change'; } }, audit);
    expect(await deps.ecrireConsentementParId('t1', 'fiche-1', 'opted_out', 'formulaire-site')).toBe('change');
    expect(recus).toEqual([['t1', 'fiche-1', 'opted_out', 'formulaire-site']]);
    expect(deps.audit).toBe(audit);
  });

  it('⚠️ le dépôt garde son `this` : une méthode de classe passée telle quelle le perdrait', async () => {
    class Depot {
      appels = 0;
      async ecrireConsentementParId(): Promise<'inchange'> { this.appels += 1; return 'inchange'; }
    }
    const depot = new Depot();
    await depsConsentementDe(depot, async () => {}).ecrireConsentementParId('t1', 'fiche-1', 'opted_in', 'api');
    expect(depot.appels).toBe(1);
  });
});
```

Run: `npx vitest run tests/api-consentement-deps.test.ts`
Expected: FAIL, `depsConsentementDe is not a function` (export absent).

b) Dans `src/api/consentement.ts`, juste après l'interface `DepsConsentement`, ajouter :

```ts
/**
 * LES DÉPENDANCES DU CONSENTEMENT, CONSTRUITES ICI ET NULLE PART AILLEURS : `creerServiceContactsV1`
 * (`/v1/contacts`) et le câblage de `/v1/sends` (`src/index.ts`) passent par elle. Deux constructions
 * écrites à la main divergeraient, et une route journaliserait un consentement que l'autre écrirait sans trace.
 *
 * ⚠️ La flèche garde le `this` du dépôt : passer `contacts.ecrireConsentementParId` tel quel le perdrait sur
 * une instance de `PgContactStore`.
 */
export function depsConsentementDe(contacts: Pick<DepsConsentement, 'ecrireConsentementParId'>, audit: AuditSink): DepsConsentement {
  return {
    ecrireConsentementParId: (tenantId, contactId, statut, source) => contacts.ecrireConsentementParId(tenantId, contactId, statut, source),
    audit,
  };
}
```

c) Dans `src/api/contacts-v1.ts` (lot 1), dans `creerServiceContactsV1`, remplacer :

```ts
  const consentement: DepsConsentement = {
    ecrireConsentementParId: (t, id, statut, source) => deps.contacts.ecrireConsentementParId(t, id, statut, source),
    audit: deps.audit,
  };
```

par :

```ts
  // UNE construction, partagée avec `/v1/sends` (`src/index.ts`) : `depsConsentementDe`.
  const consentement = depsConsentementDe(deps.contacts, deps.audit);
```

et, dans l'import de `'./consentement'`, remplacer `import { appliquerConsentement, type DepsConsentement } from './consentement';` par `import { appliquerConsentement, depsConsentementDe } from './consentement';`. Puis `grep -n "DepsConsentement" src/api/contacts-v1.ts` : s'il sort encore une ligne, remettre `type DepsConsentement` dans cet import (le typecheck le signalera de toute façon).

Run: `npx vitest run tests/api-consentement-deps.test.ts tests/api-consentement.test.ts tests/v1-contacts.test.ts`
Expected: PASS (les deux fichiers du lot 1 restent verts : le comportement de `/v1/contacts` ne bouge pas).

- [ ] **Step 6: Câbler `v1.sends`**

Relire `git diff origin/main -- src/index.ts` AVANT d'éditer : tout hunk étranger se retrouvera au commit (procédure P').

Dans `src/index.ts`, après la ligne 39 (`import { PgApiIdempotencyStore } from './api/idempotency-store.pg';`), ajouter :

```ts
import { verdictModele } from './api/modele-envoi';
import { resoudreFiche } from './api/fiche';
import { appliquerConsentement, depsConsentementDe } from './api/consentement';
```

Juste avant la ligne `  const app = buildServer({` (l. 639 aujourd'hui ; `contactStore` et `auditSink` sont déclarés plus haut, l. 207 et 241), ajouter :

```ts
  // Les dépendances du consentement posé par l'API : la MÊME construction que `/v1/contacts`
  // (`depsConsentementDe`, que `creerServiceContactsV1` appelle aussi), jamais une seconde écrite à la main.
  const depsConsentement = depsConsentementDe(contactStore, auditSink);
```

Remplacer tout le bloc `sends: { … },` (lignes 3086 à 3117) par :

```ts
      sends: {
        resolveScenario: (tenant, ref) => resolveScenario(tenant, ref, workflowStore),
        /**
         * Cible node : le code `nod_` vit dans le graphe PUBLIÉ, d'où le scan des scénarios de l'espace. Le
         * graphe est rendu AVEC le bloc : c'est depuis lui que `ouvertureApi` juge ce qui part en premier.
         * Le libellé du bloc (ou son code à défaut) nomme la campagne dans la console.
         */
        resolveNode: async (tenant, code) => {
          const r = await resolveNode(tenant, code, workflowStore);
          // Un code `nod_` est unique : resolveNode ne produit jamais 'ambiguous', seulement not_found.
          if (!r.ok) return { ok: false, reason: 'not_found' };
          const node = r.value.graph.nodes.find((n) => n.id === r.value.nodeId);
          const label = String(node?.data.label ?? '').trim() || code;
          return { ok: true, value: { workflowId: r.value.workflowId, nodeId: r.value.nodeId, label, graph: r.value.graph } };
        },
        /**
         * 🔴 LA CATÉGORIE D'UN TEMPLATE EST LUE CHEZ META, comme dans l'Inbox (`categorieDuModele`) : déclarée
         * par l'appelant, un template marketing annoncé « utility » partait aux contacts sans consentement.
         * MÊME lecture et MÊME cache court que le worker. Une panne de lecture est « illisible », jamais
         * « utility » par défaut.
         */
        lireModele: async (tenant, name, language) => {
          try {
            return verdictModele(await workflowRuntime.templateVarInfo(tenant, name, language), language);
          } catch {
            return { statut: 'illisible' };
          }
        },
        getWindowOpenByWaIds: (tenant, waIds) => inboxStore.getWindowOpenByWaIds(tenant, waIds),
        getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
        phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
        // La résolution de fiche et l'écriture du consentement du lot 1, sur les MÊMES dépendances que
        // `/v1/contacts` : le dépôt des contacts lui-même, et `depsConsentementDe`. Les quatre paramètres de
        // chaque flèche sont gardés par `tests/v1-cablage.test.ts`.
        resoudreFiche: (tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o),
        appliquerConsentement: (tenant, contactId, consent, source) => appliquerConsentement(depsConsentement, tenant, contactId, consent, source),
        // Bloqués COMPRIS : l'API les écarte avec un motif au lieu de les perdre (défaut 1).
        listContactsPourEnvoi: (tenant, ids) => repo.listContactsPourEnvoiApi(tenant, ids),
        createSend: (input, recipients) => repo.createWithRecipients(input, recipients),
        enqueue: (campaignId, tenantId, count, rate) =>
          enqueueCampaignRun(queue, {
            campaignId,
            tenantId,
            pendingCount: count,
            resolvedRatePerMinute: resolveRatePerMinute(rate, config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE, plafondLePlusBas(config)),
          }),
        idempotencyClaim: (tenant, key, empreinte) => idempotencyStore.claim(tenant, key, empreinte),
        idempotencyComplete: (tenant, key, sendId, response) => idempotencyStore.complete(tenant, key, sendId, response),
        idempotencyRelease: (tenant, key) => idempotencyStore.release(tenant, key),
        lireEnvoi: (sendId, tenant) => repo.lireEnvoiApi(sendId, tenant),
      },
```

- [ ] **Step 7: Retirer l'ancien tri et son test, mettre le double muet au contrat**

Dans `src/api/sends-build.ts` : supprimer le bloc qui va du commentaire `/** Motif d'écart d'un destinataire (D-5). …` jusqu'à l'accolade fermante de `buildApiRecipients` (types `ApiSkipReason`, `ApiSkip` et la fonction), et la ligne `import { optInAllows } from '../campaign/guardrails';` ; retirer `type BuildContact` de l'import de `'../campaign/build'` s'il n'est plus lu (le typecheck le dira).

Supprimer le fichier `tests/api-sends-build.test.ts` (ses cas vivent dans `tests/api-tri-destinataires.test.ts` sous leurs nouveaux codes, cf. l'en-tête de ce fichier).

Dans `tests/api-usage-observation.test.ts`, remplacer la constante `sendsMuets` (lignes 39 à 52) par :

```ts
const sendsMuets: Omit<V1SendsRouteDeps, 'usage'> = {
  resolveScenario: async () => ({ ok: false, reason: 'not_found' }),
  resolveNode: async () => ({ ok: false, reason: 'not_found' }),
  lireModele: async () => ({ statut: 'absent' }),
  getWindowOpenByWaIds: async () => new Map(),
  getTenantPhoneNumberId: async () => 'pn-1',
  phoneNumberBelongsToTenant: async () => true,
  resoudreFiche: async () => ({ ok: false, code: 'unknown_contact' }),
  appliquerConsentement: async () => { /* rien */ },
  listContactsPourEnvoi: async () => [],
  createSend: async () => ({ campaignId: 'camp1', recipientCount: 0 }),
  enqueue: async () => { /* rien */ },
  idempotencyClaim: async () => ({ claimed: true as const }),
  idempotencyComplete: async () => { /* rien */ },
  idempotencyRelease: async () => { /* rien */ },
  lireEnvoi: async () => null,
};
```

- [ ] **Step 8: Corriger les commentaires qui affirment l'ancien comportement**

`src/campaign/engine.ts`, lignes 896 et 897, remplacer :

```ts
        // Campagne NODE (/v1/sends) : on démarre le workflow à un BLOC PRÉCIS. Les destinataires hors fenêtre
        // 24 h ont déjà été écartés (`out_of_window`) à la création, donc l'envoi de session est légitime ici.
```

par :

```ts
        // Campagne NODE (/v1/sends) : on démarre le workflow à un BLOC PRÉCIS. Quand ce bloc fait partir un
        // message de SESSION en premier (`ouvertureApi`), les destinataires hors fenêtre de 24 h ont déjà été
        // écartés (`window_closed`) à la création ; un bloc qui ouvre par un template ou un RCS n'en a pas.
```

`src/workflow/executor.ts`, lignes 1459 à 1461 (la ligne 1458 est l'ouverture `/**` du docblock, qui ne change pas), remplacer :

```ts
   * Démarre un run à un bloc ARBITRAIRE du graphe (cible `node` de /v1/sends, D-1). La garde fenêtre 24 h n'est
   * PAS appliquée ici : l'appelant a déjà écarté les contacts hors fenêtre (`out_of_window`), et l'intérêt même
   * de la cible node est d'envoyer un message de session (quick_message/flow) à quelqu'un qui vient d'écrire.
```

par :

```ts
   * Démarre un run à un bloc ARBITRAIRE du graphe (cible `node` de /v1/sends, D-1). La garde fenêtre 24 h n'est
   * PAS appliquée ici : quand ce qui part en premier depuis ce bloc est un message de session (`ouvertureApi`),
   * l'appelant a déjà écarté les contacts hors fenêtre (`window_closed`), et l'intérêt même de la cible node
   * est d'écrire à quelqu'un qui vient d'écrire.
```

`documentation.md`, ligne 358, remplacer ``(ouverture à froid) et `exigeFenetre24h` (API publique).`` par :

```
`besoinsFenetre` (reprise), la garde de `runFrom` (ouverture à froid) et `ouvertureApi` (API publique,
`src/workflow/ouverture-api.ts`, qui juge ce qui part en PREMIER depuis l'entrée ou depuis le bloc visé).
```

(La ligne entière commence par `` `besoinsFenetre` (reprise), la garde de `runFrom` `` : la remplacer par ces deux lignes.)

`src/campaign/build.ts`, lignes 66 à 68 aujourd'hui (décalées d'une quinzaine de lignes vers le bas par l'ajout de `ContactEnvoi` en tâche 5 : se repérer au texte), remplacer :

```ts
    // Écart RAPPORTÉ, et non silencieux : une campagne marketing sur une liste sans opt-in explicite rendait
    // 0 destinataire sans que rien ne dise pourquoi. Le motif était déjà nommé sur la voie API
    // (`buildApiRecipients`), il manquait sur la voie écran, qui est justement celle qu'un opérateur utilise.
```

par :

```ts
    // Écart RAPPORTÉ, et non silencieux : une campagne marketing sur une liste sans opt-in explicite rendait
    // 0 destinataire sans que rien ne dise pourquoi. Le motif était déjà nommé sur la voie API (aujourd'hui
    // `trierDestinataires`, `src/api/sends-build.ts`), il manquait sur la voie écran, celle d'un opérateur.
```

`tests/campaign-build.test.ts`, lignes 63 et 64, remplacer :

```ts
 * variable de template, seul motif qu'il connaissait. Le motif existait déjà sur la voie API
 * (`buildApiRecipients`), il manquait sur la voie écran, celle que l'opérateur utilise.
```

par :

```ts
 * variable de template, seul motif qu'il connaissait. Le motif existait déjà sur la voie API (aujourd'hui
 * `trierDestinataires`, `src/api/sends-build.ts`), il manquait sur la voie écran, celle que l'opérateur utilise.
```

`src/crm/contact-store.pg.ts`, ligne 183 aujourd'hui (dans `upsertByPhoneReturningId` ; le lot 1 décale ce fichier : se repérer au texte), remplacer :

```ts
         -- Ré-ajouter un contact (import CSV, /v1/sends createMissing) le RESSUSCITE : re-poser le numéro
```

par :

```ts
         -- Ré-ajouter un contact (webhook entrant, création à la main dans la console) le RESSUSCITE : re-poser le numéro
```

(Les deux seuls appelants de `upsertByPhoneReturningId` après ce lot passent par `upsertContactsFromApi`, `src/index.ts:772` et `:2172` ; `/v1/sends` crée désormais par `resoudreFiche`.)

Même fichier, lignes 287 à 289 aujourd'hui (docblock de `findByPhone`), remplacer :

```ts
  /** Contact ACTIF par téléphone E.164 exact (tenant scopé). null si absent OU supprimé (soft-delete) : un
   *  contact supprimé est « introuvable » pour l'API d'envoi (/v1/sends) -> il est skippé (unknown_contact) ou,
   *  si createMissing, ré-upserté donc ressuscité. Jamais destinataire d'un envoi. */
```

par :

```ts
  /** Contact ACTIF par téléphone E.164 exact (tenant scopé). null si absent OU supprimé (soft-delete) : un
   *  contact supprimé est « introuvable » pour le serveur MCP (`contactParTelephone`). L'API publique ne passe
   *  plus par ici : elle résout une fiche par `resoudreFiche` (lot 1). Jamais destinataire d'un envoi. */
```

Run: `grep -rln "buildApiRecipients\|createMissing\|out_of_window\|exigeFenetre24h" src tests web/lib --include=*.ts --include=*.tsx`
Expected: exactement quatre fichiers, qui nomment l'ancien contrat pour dire ce qui l'a remplacé : `src/workflow/ouverture-api.ts`, `tests/ouverture-api.test.ts`, `tests/api-tri-destinataires.test.ts` et `tests/v1-sends.test.ts`. Tout autre fichier porte un commentaire resté faux : le corriger avant de continuer. (`web/app/developers/api/page.tsx` décrit encore l'ancien contrat : il est réécrit au lot 4, cf. « Rayon de souffle ».)

- [ ] **Step 9: Voir passer, typecheck**

Run: `npm run typecheck`
Expected: aucune erreur.
Run: `npx vitest run tests/v1-sends.test.ts tests/v1-cablage.test.ts tests/api-tri-destinataires.test.ts tests/api-usage-observation.test.ts tests/ouverture-api.test.ts tests/api-consentement-deps.test.ts tests/api-consentement.test.ts tests/v1-contacts.test.ts tests/campaign-build.test.ts`
Expected: PASS.

- [ ] **Step 10: Vérifier les trois défauts, l'empreinte et l'ordre du claim dans les deux sens**

Pour chacun : muter, lancer SEULEMENT `npx vitest run tests/v1-sends.test.ts`, lire l'échec et son symptôme, restaurer, relancer vert.

1. Défaut 1 : dans `src/api/sends-build.ts`, supprimer la ligne `if (c.bloque) return 'blocked_contact';`.
   Expected: FAIL sur « défaut 1 : un contact BLOQUÉ » (`recipientCount: 1`, `skipped: []`) et sur « aucune perte silencieuse » (l'index 6 manque des écarts).
2. Défaut 2 (scénario) : dans `resoudreCible`, supprimer le bloc `if (v.ouverture === 'whatsapp_session') { … }` de la branche scénario.
   Expected: FAIL sur « défaut 2 : un scénario qui ouvre par un message de session » (201 au lieu de 422).
3. Défaut 2 (template) : dans `resoudreCible`, supprimer le bloc `if (lu.statut === 'absent') { … }` (vitest ne vérifie pas les types : le test s'exécute).
   Expected: FAIL sur « défaut 2 : un template absent » (201 et une campagne créée avec une catégorie `undefined`, au lieu de 404).
4. Défaut 3 : dans la branche node de `resoudreCible`, remplacer `const v = ouvertureApi(r.value.graph, r.value.nodeId);` par `const v: { ouverture: OuvertureApi } = { ouverture: 'rcs' };` (l'ancien jugement : une condition ne demandait aucune fenêtre).
   Expected: FAIL sur « défaut 3 : un bloc CONDITION » (`recipientCount: 1`, `skipped: []`, `opening: 'rcs'`).
5. Empreinte : supprimer le bloc `if (!claim.claimed && 'reused' in claim) { … }`.
   Expected: FAIL sur « la même clé avec un AUTRE corps » (201 au lieu de 422).
6. Ordre du claim : juste AVANT la ligne `const claim = await deps.idempotencyClaim(…)`, ajouter temporairement `const avant = await resoudreCible(deps, tenantId, demandee); if ('refus' in avant) return refuser(reply, avant.refus.statut, avant.refus.code, avant.refus.message);` (l'ancien ordre : la cible lue avant la clé).
   Expected: FAIL sur « le rejeu d'un envoi SCELLÉ » (404 `template_not_found` au lieu du rapport rejoué).
7. Libération sur refus : dans `libererEtRefuser`, supprimer la ligne `await deps.idempotencyRelease(tenantId, idem.cle);`.
   Expected: FAIL sur « un refus de cible LIBÈRE la clé » (la clé reste posée, et le second appel rend 409 `idempotency_in_progress` au lieu de 201).

Après la dernière restauration : `git diff origin/main -- src/http/v1-sends.ts src/api/sends-build.ts` ne doit montrer QUE le travail de cette tâche.

- [ ] **Step 11: Suite complète et auto-attaque**

Run: `npm test && npm run auto-attaque`
Expected: suite verte ; l'auto-attaque (serveur monté en mémoire, sans base ni réseau) ne trouve rien.

- [ ] **Step 12: Commit**

Commit par la procédure P, avec :
- `src/index.ts` et `documentation.md` par P' (fichier de câblage partagé ; fichier que d'autres sessions éditent) ;
- `tests/api-sends-build.test.ts` SUPPRIMÉ : `&& git update-index --force-remove -- tests/api-sends-build.test.ts` avant `git diff --cached`.

Chemins créés ou modifiés : `src/http/v1-sends.ts src/api/sends-build.ts src/api/consentement.ts src/api/contacts-v1.ts src/index.ts src/campaign/engine.ts src/workflow/executor.ts src/campaign/build.ts src/crm/contact-store.pg.ts documentation.md tests/v1-sends.test.ts tests/v1-cablage.test.ts tests/api-usage-observation.test.ts tests/api-consentement-deps.test.ts tests/campaign-build.test.ts`. Message :

```
feat(api): /v1/sends refondu, fiches resolues, ecarts par index, ouverture jugee depuis le bloc

Defauts 1, 2 et 3 de la spec du 2026-09-24 : bloque perdu en silence, gardes de la console, fenetre jugee sur le type du bloc. GET /v1/sends rend un contrat ecrit. La cle d idempotence est lue avant la cible, et un refus la libere. depsConsentementDe : une seule construction du consentement pour /v1/contacts et /v1/sends.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Puis : prévenir les autres sessions (`src/index.ts`, `src/api/contacts-v1.ts` touchés), `gh run list --limit 3` et `gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'`.

---

### Task 9: `POST /v1/messages/whatsapp` remplace `POST /v1/messages`

**Files:**
- Modify: `src/http/v1-messages.ts` (réécrit en entier)
- Modify: `src/index.ts:3118-3151` (bloc `v1.messages` : commentaire d'en-tête et `findContactByPhone` remplacé), câblage partagé : annoncer avant
- Modify: `src/server.ts:245` (commentaire), câblage partagé : annoncer avant
- Modify: `src/api/usage-guard.ts:28`, `src/inbox/origine.ts:82`, `web/lib/qui-a-repondu.ts:43` (commentaires)
- Test: `tests/v1-messages.test.ts` (réécrit)

**Interfaces:**
- Consumes: `repondreDansLaFenetre`, `DepsRepondre` (`src/inbox/repondre.ts`, NON modifié) ; lot 1 : `schemaClesFiche`, `ClesFiche`, `ModeCreation`, `ResolutionFiche`, `MESSAGE_RESOLUTION` (`src/api/fiche.ts`), `STATUT_PAR_CODE`, `refuser` (`src/api/erreurs.ts`), `contactsV1Muets` (`tests/aide/contacts-v1.ts`) ; `messageDeForme` (tâche 7) ; `TEXTE_MAX_CARACTERES` (4 096).
- Produces:
  - `V1MessagesRouteDeps { repondre: DepsRepondre; resoudreFiche(tenantId, cles, { creer }): Promise<ResolutionFiche>; ouvrirConversation(tenantId, contactId): Promise<string | null>; usage: ApiUsageGuard }` (`findContactByPhone` disparaît)
  - Réponse 200 `{ messageId, conversationId, channel: 'whatsapp' }`. Le lot 3 ajoute `POST /v1/messages/rcs` dans ce même fichier.

- [ ] **Step 1: Annoncer l'édition du câblage partagé**

Envoyer aux autres sessions (`ListAgents`, puis `SendMessage`) : « J'édite `src/index.ts` (bloc `v1.messages`) et `src/server.ts` (un commentaire, ligne 245) pour le lot 2 de l'API cohérente. »

- [ ] **Step 2: Écrire le test qui échoue**

Remplacer tout `tests/v1-messages.test.ts` par :

```ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { estLourde, unitesDe } from '../src/api/usage-guard';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { DepsRepondre } from '../src/inbox/repondre';
import type { OrigineMessage } from '../src/inbox/origine';
import type { ClesFiche, ModeCreation } from '../src/api/fiche';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';

/**
 * `POST /v1/messages/whatsapp` : UN SIMPLE TEXTE, À UNE FICHE, DANS LA FENÊTRE DE 24 H (spec 2026-09-24, § 4).
 *
 * 🔴 CE QUE CES CAS PROTÈGENT VRAIMENT, ET CE N'EST PAS LA ROUTE. La route ne décide de rien : elle résout
 * une fiche par la fonction partagée du lot 1, ouvre son fil, et appelle `repondreDansLaFenetre`, partagé
 * avec la console et le serveur MCP. Ce qui mérite un test, c'est que ce troisième appelant hérite bien des
 * mêmes garde-fous, et que les refus portent les codes unifiés.
 *
 * ⚠️ LES ASSERTIONS PORTENT SUR CE QUI PART ET SUR CE QUI EST ENREGISTRÉ, pas sur ce que la fonction rend.
 * ⚠️ Les cas de l'ancienne route sont conservés : `contact_inconnu` est devenu `unknown_contact`,
 * `contact_indisponible` `blocked_contact`, `contact_desabonne` `opted_out`, `aucun_numero`
 * `no_whatsapp_number` ; la normalisation du numéro vit désormais dans la résolution partagée.
 * ⚠️ Les fiches portent des identifiants au FORMAT d'un vrai (`C1`, `C2`) : le corps passe par
 * `schemaClesFiche` (lot 1), dont `contactId` est un GUID, et le schéma est STRICT ici. Un « c1 » rendrait
 * 400 `invalid_body` avant même la résolution.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const C1 = '11111111-1111-4111-8111-000000000001';
const C2 = '11111111-1111-4111-8111-000000000002';
const VALID = cleApiDeTest('valide');
const NOSCOPE = cleApiDeTest('sans_scope');
const NUMERO = '+33612345678';
const URL_WA = '/v1/messages/whatsapp';

interface Monde {
  /** La fiche que les clés désignent. `null` = inconnue. */
  fiche: { id: string } | null;
  /** `null` = fiche bloquée ou supprimée : `ouvrirConversation` refuse. */
  conversation: string | null;
  fenetreOuverte: boolean;
  desabonne: boolean;
  numeroDeLEspace: string | null;
}

const MONDE: Monde = { fiche: { id: C1 }, conversation: 'conv-1', fenetreOuverte: true, desabonne: false, numeroDeLEspace: 'pn1' };

function app(over: Partial<Monde> = {}) {
  const m: Monde = { ...MONDE, ...over };
  const envois: Array<{ to: string; text: string }> = [];
  const enregistres: Array<{ body: string; origine: OrigineMessage; auteur: string | null; type?: string }> = [];
  const desabonneLu: string[] = [];
  const prises: string[] = [];
  const resolutions: Array<{ tenant: string; cles: ClesFiche; creer: ModeCreation }> = [];

  const repondre: DepsRepondre = {
    getConversationContext: async (id, tenant) => (
      tenant === 't1' && id === m.conversation ? { waId: '33612345678', lastInboundAt: null, windowOpen: m.fenetreOuverte } : null
    ),
    getTenantPhoneNumberId: async () => m.numeroDeLEspace,
    sendReply: async (_t, _pn, to, text) => { envois.push({ to, text }); return 'wamid.envoye'; },
    estDesabonne: async (_t, waId) => { desabonneLu.push(waId); return m.desabonne; },
    recordOutbound: async (_id, body, _msgId, origine, type, _cat, _name, sender) => {
      enregistres.push({ body, origine, auteur: sender ?? null, type });
    },
    takeControl: async (_t, waId) => { prises.push(waId); },
  };

  const keys = new FakeApiKeys()
    .add(VALID, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .add(NOSCOPE, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });

  const server = buildServer({
    queue: new FakeQueue(),
    v1: {
      apiKeys: keys,
      contacts: contactsV1Muets(),
      messages: {
        repondre,
        /** Double de la résolution du lot 1 : elle NORMALISE le numéro (format national compris). */
        resoudreFiche: async (tenant, cles, o) => {
          resolutions.push({ tenant, cles, creer: o.creer });
          if (!cles.contactId && !cles.externalId && !cles.phone && !cles.bsuid) return { ok: false, code: 'invalid_recipient' };
          const tel = cles.phone?.replace(/\s/g, '').replace(/^0/, '+33');
          if (tel !== undefined && !/^\+\d{8,15}$/.test(tel)) return { ok: false, code: 'invalid_phone' };
          if (cles.contactId === C2 && tel === NUMERO) return { ok: false, code: 'identity_conflict' };
          const designe = cles.contactId === C1 || tel === NUMERO || cles.externalId === 'crm-7781';
          return tenant === 't1' && designe && m.fiche ? { ok: true, contactId: m.fiche.id, cree: false } : { ok: false, code: 'unknown_contact' };
        },
        ouvrirConversation: async (tenant, contactId) => (tenant === 't1' && contactId === C1 ? m.conversation : null),
      },
    },
  });
  return { server, envois, enregistres, desabonneLu, prises, resolutions };
}

const auth = (key: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });
const post = (server: ReturnType<typeof app>['server'], payload: unknown, key = VALID, url = URL_WA) =>
  server.inject({ method: 'POST', url, ...auth(key), payload: payload as object });

describe('POST /v1/messages/whatsapp', () => {
  it('par contactId -> 200, le texte PART, il est enregistré avec l’origine `api`, et le canal est dit', async () => {
    const { server, envois, enregistres, prises, resolutions } = app();
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: 'wamid.envoye', conversationId: 'conv-1', channel: 'whatsapp' });
    expect(envois).toEqual([{ to: '33612345678', text: 'bonjour' }]);
    // 🔴 L'ORIGINE EST LE SUJET DE LA MIGRATION 0166 ; `auteur` à null : aucun opérateur ne signe.
    expect(enregistres).toEqual([{ body: 'bonjour', origine: 'api', auteur: null, type: 'text' }]);
    // Le fil est PRIS : le scénario cesse d'avancer seul, l'agent de Meta cesse de répondre.
    expect(prises).toEqual(['33612345678']);
    expect(resolutions[0]!.tenant).toBe('t1');
    await server.close();
  });

  it('🔴 un message simple ne CRÉE jamais de fiche : la route le demande à la résolution', async () => {
    const { server, resolutions } = app();
    await post(server, { phone: NUMERO, text: 'x' });
    expect(resolutions.map((r) => r.creer)).toEqual(['jamais']);
    await server.close();
  });

  it('par numéro (format national compris, normalisé par la résolution partagée) ou par identifiant externe', async () => {
    const { server, envois } = app();
    expect((await post(server, { phone: '06 12 34 56 78', text: 'salut' })).statusCode).toBe(200);
    expect((await post(server, { externalId: 'crm-7781', text: 'salut' })).statusCode).toBe(200);
    expect(envois).toHaveLength(2);
    await server.close();
  });

  it('🔴 une fiche DÉSABONNÉE est refusée 409 opted_out, et RIEN ne part', async () => {
    const { server, envois, enregistres, desabonneLu } = app({ desabonne: true });
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'opted_out' });
    expect(desabonneLu, 'la garde doit avoir été INTERROGÉE').toEqual(['33612345678']);
    expect(envois).toEqual([]);
    expect(enregistres).toEqual([]);
    await server.close();
  });

  it('🔴 hors fenêtre de 24 h -> 422 window_closed, le message dit l’autre chemin, et rien ne part', async () => {
    const { server, envois } = app({ fenetreOuverte: false });
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'window_closed' });
    expect(res.json<{ error: string }>().error).toContain('/v1/sends');
    expect(envois).toEqual([]);
    await server.close();
  });

  it('🔴 une fiche BLOQUÉE ou SUPPRIMÉE -> 409 blocked_contact, et la fenêtre n’est même pas consultée', async () => {
    const { server, envois, desabonneLu } = app({ conversation: null });
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'blocked_contact' });
    expect(envois).toEqual([]);
    expect(desabonneLu).toEqual([]);
    await server.close();
  });

  it('une fiche inconnue -> 404 unknown_contact ; deux clés sur deux fiches -> 409 identity_conflict', async () => {
    const inconnue = app({ fiche: null });
    const r1 = await post(inconnue.server, { phone: NUMERO, text: 'x' });
    expect(r1.statusCode).toBe(404);
    expect(r1.json()).toMatchObject({ code: 'unknown_contact' });
    await inconnue.server.close();
    const { server } = app();
    const r2 = await post(server, { contactId: C2, phone: NUMERO, text: 'x' });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ code: 'identity_conflict' });
    await server.close();
  });

  it('aucun numéro WhatsApp sur l’espace -> 409 no_whatsapp_number, pas un 500', async () => {
    const { server, envois } = app({ numeroDeLEspace: null });
    const res = await post(server, { contactId: C1, text: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_whatsapp_number' });
    expect(envois).toEqual([]);
    await server.close();
  });

  it('corps invalide -> 400 invalid_body ; aucune clé -> 400 invalid_recipient ; numéro invalide -> 400 invalid_phone', async () => {
    const { server } = app();
    for (const corps of [{}, { contactId: C1 }, { contactId: C1, text: '' }, { contactId: C1, text: 'x'.repeat(4097) }, { contactId: C1, text: 123 }]) {
      const res = await post(server, corps);
      expect(res.statusCode, JSON.stringify(corps).slice(0, 60)).toBe(400);
      expect(res.json(), JSON.stringify(corps).slice(0, 60)).toMatchObject({ code: 'invalid_body' });
    }
    // L'ancienne forme `{ to, text }` est refusée en NOMMANT le champ : l'intégrateur sait quoi changer.
    const ancienne = await post(server, { to: NUMERO, text: 'x' });
    expect(ancienne.json()).toMatchObject({ code: 'invalid_body' });
    expect(ancienne.json<{ error: string }>().error).toContain('to');
    expect((await post(server, { text: 'x' })).json()).toMatchObject({ code: 'invalid_recipient' });
    expect((await post(server, { phone: '00', text: 'x' })).json()).toMatchObject({ code: 'invalid_phone' });
    await server.close();
  });

  it('un `contactId` qui n’est pas au format d’un identifiant -> 400 invalid_body qui le nomme, sans résolution ni envoi', async () => {
    const { server, envois, resolutions } = app();
    const res = await post(server, { contactId: 'pas-un-uuid', text: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toContain('contactId');
    expect(resolutions).toEqual([]);
    expect(envois).toEqual([]);
    await server.close();
  });

  it('l’ancienne adresse `POST /v1/messages` n’existe plus', async () => {
    const { server } = app();
    expect((await post(server, { contactId: C1, text: 'x' }, VALID, '/v1/messages')).statusCode).toBe(404);
    await server.close();
  });

  it('sans Bearer -> 401 unauthorized ; clé sans le droit `sends:create` -> 403 missing_scope', async () => {
    const { server } = app();
    const sans = await server.inject({ method: 'POST', url: URL_WA, headers: { 'content-type': 'application/json' }, payload: { contactId: C1, text: 'x' } });
    expect(sans.statusCode).toBe(401);
    expect(sans.json()).toMatchObject({ code: 'unauthorized' });
    const scope = await post(server, { contactId: C1, text: 'x' }, NOSCOPE);
    expect(scope.statusCode).toBe(403);
    expect(scope.json()).toMatchObject({ code: 'missing_scope' });
    await server.close();
  });

  it('🔴 le tenant vient de la CLÉ, jamais du corps : un `tenantId` dans le corps est refusé, rien ne part', async () => {
    const { server, envois } = app();
    const res = await post(server, { contactId: C1, text: 'x', tenantId: 'autre-espace' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(envois).toEqual([]);
    await server.close();
  });

  it('le garde d’usage compte UNE unité, et l’opération n’est pas « lourde »', () => {
    expect(unitesDe('messages.send', 999)).toBe(1);
    expect(estLourde('messages.send')).toBe(false);
  });
});
```

- [ ] **Step 3: Le voir échouer**

Run: `npx vitest run tests/v1-messages.test.ts`
Expected: FAIL à l'EXÉCUTION (vitest ne vérifie pas les types) : `/v1/messages/whatsapp` n'existe pas encore, donc 404 là où les cas attendent 200, 400, 404, 409 ou 422 ; et « l'ancienne adresse n'existe plus » échoue aussi, l'ancienne route répondant encore (400 sur ce corps, au lieu de 404).
Run: `npm run typecheck`
Expected: FAIL sur la fixture : `resoudreFiche` n'existe pas dans `V1MessagesRouteDeps`, et `findContactByPhone` y manque.

- [ ] **Step 4: Réécrire `src/http/v1-messages.ts`**

Remplacer tout le fichier par :

```ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { repondreDansLaFenetre, type DepsRepondre } from '../inbox/repondre';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { STATUT_PAR_CODE, refuser } from '../api/erreurs';
import { MESSAGE_RESOLUTION, schemaClesFiche, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { messageDeForme } from '../api/forme';

/**
 * API PUBLIQUE /v1 DES MESSAGES SIMPLES : `POST /v1/messages/whatsapp`, un texte, à UNE fiche, dans la
 * fenêtre de service de 24 h (spec 2026-09-24, § 4). Elle remplace `POST /v1/messages` : le canal se lit dans
 * l'adresse, jamais dans un paramètre, et la personne se désigne par sa FICHE (`contactId`, `externalId`,
 * `phone` ou `bsuid`). Le lot 3 ajoute `POST /v1/messages/rcs` ici.
 *
 * 🔴 ELLE N'A AUCUNE LOGIQUE D'ENVOI À ELLE, ET C'EST TOUT LE POINT. Les gestes (la fenêtre, le désabonnement,
 * l'envoi, la trace dans l'Inbox) vivent dans `repondreDansLaFenetre`, qui sert déjà la console et le serveur
 * MCP. Le jour où la règle de la fenêtre change, elle change pour les trois d'un coup.
 *
 * 🔴 LA FICHE BLOQUÉE EST ÉCARTÉE PAR `ouvrirConversation`, PAS PAR UNE GARDE DE PLUS ICI : c'est la même
 * fonction que le bouton « Ouvrir la conversation » du mini-CRM, qui refuse une fiche supprimée comme une
 * fiche bloquée. Une seconde garde écrite ici aurait pu diverger de celle-là.
 *
 * ⚠️ ELLE NE CRÉE JAMAIS DE FICHE (`creer: 'jamais'`) : un message simple ne fonde pas une relation, un envoi
 * (`POST /v1/sends`) le fait.
 *
 * ⚠️ AUCUNE CLÉ D'IDEMPOTENCE, À LA DIFFÉRENCE DE `/v1/sends`, et c'est délibéré : un message de session est le
 * pendant exact de la barre de réponse de l'Inbox, qui n'en a pas non plus.
 */
export interface V1MessagesRouteDeps {
  /**
   * Les dépendances de `repondreDansLaFenetre`, passées telles quelles.
   *
   * 🔴 OBJET IMBRIQUÉ, TRANSMIS D'UN SEUL COUP, jamais recopié champ par champ : un `Pick<>` recopié pour être
   * RETRANSMIS dérive. La capacité qu'on perdrait en l'oubliant s'appelle `estDesabonne`.
   */
  repondre: DepsRepondre;
  /** La résolution de fiche du lot 1, liée à ses dépendances par le câblage. */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /**
   * Le fil de cette fiche, créé s'il n'existe pas. `null` = fiche supprimée, bloquée, ou sans identité
   * joignable. MÊME fonction que le bouton « Ouvrir la conversation » du mini-CRM.
   */
  ouvrirConversation(tenantId: string, contactId: string): Promise<string | null>;
  /** Le garde d'usage, injecté au bootstrap. OBLIGATOIRE, comme sur les autres modules /v1. */
  usage: ApiUsageGuard;
}

/**
 * ⚠️ `safeParse`, jamais `parse`, jamais un `as` sur ce corps. STRICT : l'ancienne forme `{ to, text }` est
 * refusée en nommant `to`, et un `tenantId` glissé dans le corps aussi (le tenant vient de la CLÉ).
 */
const schemaMessage = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().min(1).max(TEXTE_MAX_CARACTERES),
});

/**
 * Le refus d'une résolution de fiche : le statut vient de la table des codes, le message de la résolution
 * PARTAGÉE (`MESSAGE_RESOLUTION`, lot 1), comme sur `/v1/contacts`. Une seule précision propre à cette route :
 * une fiche inconnue n'y est jamais créée, et le message dit où elle l'est.
 */
const INCONNUE_POUR_UN_MESSAGE = 'aucune fiche pour cette personne : un message simple ne crée pas de fiche, un envoi (POST /v1/sends) le fait';

/**
 * Le tenant vient à 100 % de `req.auth` (posé par `makeRequireApiKey`), jamais de l'URL ni du corps.
 * Garde attendue : `[makeRequireApiKey, requireScope('sends:create')]`.
 *
 * ⚠️ `sends:create` ET NON UN DROIT NEUF : les droits d'une clé se fixent à sa CRÉATION. La contrepartie est
 * assumée : une clé qui pouvait déclencher un template peut écrire un texte libre, borné par la fenêtre de
 * 24 h (donc aux seules personnes qui viennent d'écrire) et par le désabonnement.
 */
export function registerV1Messages(app: FastifyInstance, deps: V1MessagesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/messages/whatsapp', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const lu = schemaMessage.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));

    // Compté APRÈS la validation, comme sur `/v1/contacts` : un corps malformé n'a demandé aucun travail.
    if (!await compterOuRefuser(deps.usage, req, reply, 'messages.send')) return reply;

    const { text, ...cles } = lu.data;
    const fiche = await deps.resoudreFiche(tenantId, cles, { creer: 'jamais' });
    if (!fiche.ok) {
      const message = fiche.code === 'unknown_contact' ? INCONNUE_POUR_UN_MESSAGE : MESSAGE_RESOLUTION[fiche.code];
      return refuser(reply, STATUT_PAR_CODE[fiche.code], fiche.code, message);
    }

    const conversationId = await deps.ouvrirConversation(tenantId, fiche.contactId);
    if (!conversationId) return refuser(reply, 409, 'blocked_contact', 'cette fiche est bloquée, supprimée, ou sans adresse WhatsApp');

    /**
     * `auteur` à `null` : personne ne SIGNE ce message dans l'Inbox. `origine` à `'api'` : c'est le système du
     * client qui parle (migration 0166).
     */
    const res = await repondreDansLaFenetre(deps.repondre, tenantId, conversationId, text, null, 'api');
    if (!('refus' in res)) return reply.code(200).send({ messageId: res.messageId, conversationId, channel: 'whatsapp' });
    const motif = res.refus.motif;
    switch (motif) {
      case 'contact_desabonne':
        return refuser(reply, 409, 'opted_out', 'cette personne a demandé à ne plus recevoir de messages');
      case 'aucun_numero':
        return refuser(reply, 409, 'no_whatsapp_number', 'aucun numéro WhatsApp sur cet espace');
      case 'conversation_inconnue':
        // Inatteignable : le fil vient d'être ouvert, avec le même espace. Traité quand même, jamais rangé
        // sous « fenêtre fermée », qui enverrait l'intégrateur faire approuver un template pour rien.
        return refuser(reply, 404, 'unknown_contact', 'conversation introuvable pour cette fiche');
      case 'fenetre_fermee':
        return refuser(reply, 422, 'window_closed', 'fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).');
      default: {
        // EXHAUSTIF : un motif ajouté demain à `RefusReponse` ne compile pas ici, au lieu de sortir sous une
        // raison fausse.
        const inconnu: never = motif;
        throw new Error(`motif de refus inconnu : ${String(inconnu)}`);
      }
    }
  });
}
```

- [ ] **Step 5: Câbler et corriger les commentaires**

`src/index.ts`, bloc `messages:` : remplacer la ligne 3119 `       * `POST /v1/messages` : un simple texte dans la fenêtre de 24 h (lot 7 du 2026-09-23).` par :

```ts
       * `POST /v1/messages/whatsapp` : un simple texte dans la fenêtre de 24 h (lot 7 du 2026-09-23, adresse
       * renommée par le lot 2 de l'API cohérente du 2026-09-24).
```

et remplacer la ligne `        findContactByPhone: async (tenant, phone) => { const c = await contactStore.findByPhone(tenant, phone); return c ? { id: c.id } : null; },` (ligne 3147, dans le bloc `messages:`, PAS celle du bloc `sends:` déjà retiré) par :

```ts
        // La MÊME résolution de fiche, sur le MÊME dépôt, que `/v1/contacts` et `/v1/sends` (lot 1). La route
        // demande `jamais` : un message simple ne crée pas de fiche, le câblage n'en décide pas.
        resoudreFiche: (tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o),
```

`src/server.ts`, ligne 245, remplacer ``    /** Un simple texte dans la fenetre de 24 h (`POST /v1/messages`, lot 7). */`` par :

```ts
    /** Un simple texte dans la fenetre de 24 h (`POST /v1/messages/whatsapp`, lot 7, adresse renommee le 2026-09-24). */
```

`src/api/usage-guard.ts`, ligne 28 : ``  // Un texte libre dans la fenetre de 24 h (`POST /v1/messages`). UNE unite par appel : un message, une`` devient ``  // Un texte libre dans la fenetre de 24 h (`POST /v1/messages/whatsapp`). UNE unite par appel : un message, une``.

`src/inbox/origine.ts`, ligne 82 : ``   * L'API publique du client (migration 0166) : un envoi par `POST /v1/messages`.`` devient ``   * L'API publique du client (migration 0166) : un envoi par `POST /v1/messages/whatsapp`.``.

`web/lib/qui-a-repondu.ts`, ligne 43 : ``  // contrainte de Meta, pas une opinion : `POST /v1/messages` n'existe QUE dans la fenetre de 24 h, donc un`` devient ``  // contrainte de Meta, pas une opinion : `POST /v1/messages/whatsapp` n'existe QUE dans la fenetre de 24 h, donc un``.

- [ ] **Step 6: Voir passer, typecheck, suite**

Run: `npm run typecheck`
Expected: aucune erreur (en particulier aucun `findContactByPhone` restant dans `V1MessagesRouteDeps`).
Run: `npx vitest run tests/v1-messages.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Vérifier la garde de désabonnement dans les deux sens**

Mutation : dans `src/http/v1-messages.ts`, remplacer `'api'` par `'humain'` dans l'appel `repondreDansLaFenetre(…, null, 'api')` (une machine qui se ferait passer pour un opérateur échapperait à la garde).
Run: `npx vitest run tests/v1-messages.test.ts`
Expected: FAIL sur « une fiche DÉSABONNÉE est refusée » (200, un envoi part, `desabonneLu` vide) et sur l'origine enregistrée. Restaurer `'api'`, relancer : PASS.

- [ ] **Step 8: Commit et push**

Commit par la procédure P ; `src/index.ts` et `src/server.ts` par P' (fichiers de câblage partagés). Chemins : `src/http/v1-messages.ts src/index.ts src/server.ts src/api/usage-guard.ts src/inbox/origine.ts web/lib/qui-a-repondu.ts tests/v1-messages.test.ts`. Message :

```
feat(api): POST /v1/messages/whatsapp remplace /v1/messages, fiche resolue, codes unifies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Puis : prévenir les autres sessions (`src/index.ts`, `src/server.ts` touchés), `gh run list --limit 3` et `gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'`.

---

### Task 10: Vérification d'ensemble, CI, revue

**Files:** aucun fichier neuf ; lecture seule, sauf les corrections que la revue exige.

**Interfaces:**
- Consumes: tout le lot.
- Produces: un `main` vert en CI, une revue sans 🔴.

- [ ] **Step 1: Tout relancer en local**

Run: `npm run typecheck && npm test && npm run auto-attaque`
Expected: aucune erreur de type, suite verte, auto-attaque sans trouvaille.

- [ ] **Step 2: Lire le verdict de la CI, job par job**

Run: `gh run list --limit 5`
Puis, pour le run du DERNIER commit de code de ce lot : `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'`
Expected: tous les jobs `success`, `integration` compris (il est le seul à prouver `claim`, `listContactsPourEnvoiApi` et `lireEnvoiApi` sur une vraie base). Un push qui ne touche que des `.md` ne déclenche aucun run : lire celui du dernier commit de CODE.

- [ ] **Step 3: Revue**

Lancer `/revue` sur l'ensemble du lot (`git log --oneline` depuis le premier commit de la tâche 1), avec sa section « Rayon de souffle » confrontée à la section du même nom ci-dessous. Corriger 🔴 ET 🟡 dans la foulée, chacun par un commit construit selon la procédure P (P' pour un fichier partagé), puis relancer les étapes 1 et 2.

---

## Écarts à la spec et aux autres lots (à faire valider par Julien avant l'exécution)

1. **`canalDOuverture` ne gagne PAS l'option `depuis`**, que la spec (§ 3, « Ce qu'un scénario ou un bloc envoie EN PREMIER ») lui donne. Aucun appelant ne l'utiliserait : la cible `node` passe par `ouvertureApi`, et la parité entre les deux est gardée par `tests/ouverture-api.test.ts`. Si Julien valide, la phrase de la spec est à corriger (« `canalDOuverture` gagne la même option » devient « `ouvertureApi` porte l'option ; `canalDOuverture` garde sa signature, sa parité avec elle est testée ») ; sinon, ajouter `depuis?: string` à `canalDOuverture` en tâche 1, transmis à `scanOpening`, sans appelant.
2. **Le garde commun n'est plus dans ce lot** : la spec (§ 9, dernier paragraphe) ne le range dans aucun des lots du § 12, et la tâche 2 du lot 1 pose déjà ses codes (avec un `code` facultatif qui garde la console intacte). Ce lot le vérifie (tâche 2) et ne le réécrit pas, pour ne pas écraser la signature du lot 1.
3. **Ce lot touche deux fichiers du lot 1** (tâche 8) : `src/api/consentement.ts` gagne `depsConsentementDe`, et `src/api/contacts-v1.ts` s'en sert au lieu de construire son `DepsConsentement` à la main. Sans cela, `/v1/sends` aurait dû écrire une seconde construction dans `src/index.ts`. Le comportement de `/v1/contacts` ne change pas (ses tests restent verts, étape 9).
4. **La clé d'idempotence est lue AVANT le numéro et la cible** (tâche 8), à la différence de l'ancienne route : un rejeu légitime rend le rapport scellé même si le template a changé depuis. La spec ne fixait pas cet ordre ; il est écrit ici parce qu'il change ce que voit l'intégrateur.
5. **`GET /v1/sends/{sendId}` d'une campagne RCS de la console** rend `target: { rcsMessage: null }` (tâche 7) : la spec ne décrit la cible `rcsMessage` qu'au lot 3. Le lot 3 (`cibleRcsDuSuivi`, écrit sur `CampaignDetail`) doit partir d'`EnvoiApiBrut`, qui porte désormais `channel`.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** La production emprunte ces chemins (création de campagnes qui envoient de vrais messages, écriture du consentement, fiches créées à la volée), un message parti ne se rappelle pas, et le code porte des invariants invisibles qu'aucun compilateur ne voit (le scellement de l'idempotence AVANT l'enfilement, la clé lue AVANT les lectures qui bougent, la fenêtre de 24 h jugée sur ce qui part en premier, la lecture qui ne filtre plus les bloqués quand celle de la console les filtre, l'empreinte qui exclut la clé) : deux oui en haut des quatre questions, donc un œil sur chaque diff, et `/revue-finale` avant le déploiement.

L'essai réel qui clôt ce lot, le geste en production sans lequel il n'est que vert et pas éprouvé, est décrit dans la section « Essai réel qui clôt le lot » ci-dessous.

## Essai réel qui clôt le lot

Avec une VRAIE clé (Developers > Clés d'API, droits `sends:create` et `contacts:write`), en production, sur le numéro d'essai, en regardant le téléphone, Campagnes et l'Inbox (repris du § 14 de la spec, étapes 2, 4 et 5, réduites à ce que ce lot livre ; le template à variable par destinataire et le message RCS de bibliothèque sont au lot 3) :

1. `POST /v1/sends` avec l'idempotence DANS LE CORPS : `{ "idempotencyKey": "essai-lot2-1", "target": { "template": { "name": "<template approuvé>", "language": "fr" } }, "recipients": [{ "phone": "<numéro d'essai>", "externalId": "essai-lot2", "consent": "opted_in" }] }`. Réponse 201 avec `opening: "whatsapp_template"` ; le message arrive ; la campagne `[API] …` apparaît dans Campagnes.
2. Le même corps une seconde fois : même rapport, AUCUN second message. Même clé avec un autre destinataire : 422 `idempotency_key_reused`. En base, en lecture seule : `select request_hash is not null from api_idempotency where idempotency_key = 'essai-lot2-1'` rend `true`.
3. `GET /v1/sends/{sendId}` : le contrat (`target`, `opening`, `counts`, `recipients[].externalId = "essai-lot2"`, `delivery` qui passe à `delivered` puis `read`), et aucune clé de la console (`chaine`, `paramMapping`, `archivedAt`).
4. Défaut 2 : un template inexistant rend 404 `template_not_found` ; un scénario qui ouvre par un message rapide rend 422 `unsendable_target`.
5. Défaut 3 : un bloc CONDITION qui mène à un message rapide (`nod_…` d'un scénario publié), vers une fiche dont la fenêtre est FERMÉE : écartée `window_closed`, rien ne part. Puis écrire depuis le téléphone d'essai et recommencer : le message rapide arrive.
6. `POST /v1/messages/whatsapp` `{ "externalId": "essai-lot2", "text": "…" }` dans la fenêtre : il arrive et apparaît dans l'Inbox, origine `api`. Vers une fiche d'essai qui n'a pas écrit depuis plus de 24 h : 422 `window_closed`. L'ancienne adresse `POST /v1/messages` rend 404.
7. `POST /v1/sends` avec `consent: "opted_out"` sur le destinataire : écarté `opted_out`, et la ligne d'audit `contact.optout` existe. Remettre ensuite la fiche d'essai en `opted_in` DEPUIS SA FICHE DANS LA CONSOLE : l'API ne réabonne jamais (un `consent: "opted_in"` sur une fiche `opted_out` rend 409 `opted_out` sur `/v1/contacts` sans rien écrire, et l'écarte `opted_out` sur `/v1/sends` sans lever le STOP).
8. Défaut 1 : bloquer une fiche d'essai dans le mini-CRM, l'envoyer par `contactId` : écartée `blocked_contact`, `matched` la compte, `recipientCount + skippedTotal` égale le nombre de destinataires. La débloquer ensuite.

## Rayon de souffle

Repris du § 17 de la spec et complété par la lecture du code :

- **`exigeFenetre24h` disparaît** : son seul lecteur de code était `src/http/v1-sends.ts` ; ses cas sont conservés dans `tests/ouverture-api.test.ts` (« les cas de l'ancien jugement par TYPE »). Commentaires qui la nommaient : `src/index.ts:3096` (retiré avec le câblage), `documentation.md:358` (corrigé) ; `docs/JOURNAL-TECHNIQUE.md` et `AGENT-IA-PLAN-L0-L1.md` sont des archives qui racontent le passé, non corrigées.
- **`scanOpening(graph, depuis?)`** : lu par la création de campagne (`src/http/campaigns.ts:335`), `canalDOuverture` et `listResume` (`src/workflow/store.pg.ts:32`, `:204-205`), donc la liste des scénarios, l'assistant de campagne et le sélecteur de l'Inbox. Tous l'appellent sans point de départ : `tests/workflow-ouverture.test.ts` et `tests/web-campaign-eligibility.test.ts` restent verts SANS modification. Le miroir navigateur `web/lib/campaign-eligibility.ts` n'est pas touché. `canalDOuverture` ne gagne PAS l'option (aucun appelant) : la parité est gardée par test, et c'est un écart à la spec (§ 3) soumis à Julien (« Écarts à la spec », point 1).
- **`out_of_window` devient `window_closed`, `not_opted_in` devient `no_consent` ou `opted_out`** : commentaires `src/campaign/engine.ts:896-897` et `src/workflow/executor.ts:1459-1461` corrigés. `features.md:1708` et la page `web/app/developers/api/page.tsx` décrivent encore l'ancien contrat (`recipients` en chaînes, `createMissing`, `category` sur un template, `/v1/messages`) : ils sont réécrits au lot 4. Entre le déploiement de ce lot et celui du lot 4, la page est fausse ; personne n'est branché (spec), la fenêtre est assumée et doit rester courte. `web/lib/campagne-ecartes.ts` lit `not_opted_in` de la CONSOLE (`src/campaign/build.ts`), qui ne change pas.
- **`buildApiRecipients`, `ApiSkip`, `ApiSkipReason` supprimés** : lecteurs `src/http/v1-sends.ts` et `tests/api-sends-build.test.ts` (supprimé, cas conservés). Deux commentaires qui les citaient deviendraient faux, et une justification fausse se recopie : `src/campaign/build.ts:66-68` et `tests/campaign-build.test.ts:63-64` (corrigés en tâche 8, étape 8, vers `trierDestinataires`). `buildRecipients` n'est PAS modifié : il sert la console (`src/campaign/create.ts`), le webhook d'alimentation et l'API.
- **`createMissing` disparaît** : deux commentaires de `src/crm/contact-store.pg.ts` le nommaient (l. 183, dans `upsertByPhoneReturningId` ; l. 287-289, le docblock de `findByPhone`), corrigés en tâche 8, étape 8. Après ce lot, `upsertByPhoneReturningId` n'a plus que les deux appelants d'`upsertContactsFromApi` (`src/index.ts:772`, `:2172`), et `findByPhone` que le serveur MCP (`contactParTelephone`, `src/index.ts:3190`). L'étape 8 relance un `grep` qui doit ne plus trouver l'ancien contrat que dans les quatre fichiers qui disent ce qui l'a remplacé.
- **`listContactsForBuildByIds` n'est PAS modifié** (lu par `src/campaign/create.ts:43`) : il garde `blocked_at is null`. La lecture neuve `listContactsPourEnvoiApi` ne sert que l'API.
- **`getCampaignDetail` n'est PAS modifié** (la console) ; l'API ne le lit plus.
- **`api_idempotency`** : `claim` gagne un paramètre REQUIS, un seul appelant (`src/index.ts`). La purge du worker (`src/worker.ts:1411`) ne change pas, la colonne part avec les lignes. Une ligne d'avant la migration (empreinte nulle) rejoue comme avant.
- **`TplInfo` gagne `statut` et `langue`** (`src/workflow/wiring.ts`) : les lecteurs de `templateVarInfo` (worker `src/worker.ts:822`, `:843` ; câblage `src/workflow/wiring.ts:825`, `:856` ; API `src/index.ts:1125`, `:1131`) ne lisent que `count`, `category`, `carousel`, `headerFormat`, `headerMediaUrl`. `tests/workflow-cablage-categorie.test.ts` relit ce fichier par expressions régulières, qui restent vraies. Le cache court (5 min) vaut aussi pour le statut : un template approuvé il y a moins de cinq minutes peut encore être lu `PENDING`.
- **Refus du garde commun : NON modifiés par ce lot.** Le lot 1 (tâche 2) leur a donné un `code` FACULTATIF : `refuserTropDeRequetes` sert AUSSI la console (`src/auth/middleware.ts:112`, `:168`), les rappels RCS (`src/http/rcs-callback.ts:99`) et `/w/:code`, qui gardent `{ error }` seul. Ce lot ne fait que le vérifier (tâche 2) ; les tests de route des tâches 8 et 9 exigent `unauthorized` et `missing_scope`, donc ils tomberaient si le lot 1 revenait en arrière. Seule écriture possible ici : la reformulation du commentaire d'en-tête de `src/auth/rate-limit.ts`, s'il est resté faux.
- **`LectureModele` gagne `categorie_non_admise`** (tâche 4) : un seul lecteur, `resoudreCible` (`src/http/v1-sends.ts`), qui le traite ; le double muet de `tests/api-usage-observation.test.ts` rend `absent` et n'est pas concerné.
- **`EnvoiApiBrut` porte `channel`** (tâche 5), lu de `campaigns.channel` (0056, `not null default 'whatsapp'`) : `formaterSuiviEnvoi` juge le canal AVANT le template, parce que la lecture voit aussi les campagnes RCS de la console (`template_name` à `''`). Le lot 3 écrit `cibleRcsDuSuivi` sur `CampaignDetail` : il doit partir d'`EnvoiApiBrut`.
- **L'ordre du claim d'idempotence change** (tâche 8) : la clé est posée AVANT le numéro et la cible, et un refus après elle la LIBÈRE. Conséquences : un rejeu rend le rapport scellé quel que soit l'état actuel du template, du scénario ou du numéro ; un appel refusé écrit puis efface une ligne d'`api_idempotency` (au lieu de n'en rien écrire) ; un second appel de même clé pendant la résolution de la cible reçoit 409 `idempotency_in_progress`. La purge des 24 h (`src/worker.ts:1411`) n'est pas concernée.
- **`depsConsentementDe`** (tâche 8) : `src/api/consentement.ts` et `src/api/contacts-v1.ts` sont des fichiers du lot 1. `creerServiceContactsV1` construit désormais son `DepsConsentement` par elle, sans rien changer à ce qu'il écrit ni à ce qu'il journalise : `tests/api-consentement.test.ts` et `tests/v1-contacts.test.ts` (lot 1) restent verts sans modification, et `tests/v1-cablage.test.ts` exige que les deux appelants passent par elle.
- **`/v1/messages` disparaît** : commentaires `src/server.ts:245`, `src/index.ts:3119`, `src/api/usage-guard.ts:28`, `src/inbox/origine.ts:82`, `web/lib/qui-a-repondu.ts:43` corrigés. ⚠️ Ce dernier affirme que l'API « n'existe QUE dans la fenêtre de 24 h » pour justifier le badge « scripté » : vrai pour `/v1/messages/whatsapp`, FAUX dès le lot 3 (`/v1/messages/rcs`, même origine `api`, sans fenêtre). Le lot 3 doit reprendre ce commentaire et la raison du badge.
- **`repondreDansLaFenetre` n'est PAS modifié** (console, MCP, API).
- **Ce que le câblage suppose des modules changés (question inverse)** : `resoudreFiche` reçoit `contactStore` lui-même (`DepsFiche` est un `Pick<PgContactStore, …>`), le même objet que `creerServiceContactsV1` lui passe pour `/v1/contacts` ; `appliquerConsentement` reçoit `depsConsentement`, construite par la même `depsConsentementDe` que `/v1/contacts`, sur `contactStore` et `auditSink` (tous deux déclarés avant `buildServer`, `src/index.ts:207` et `:241`) ; `lireModele` suppose que `templateVarInfo` rend `null` sur template introuvable ou espace sans WABA, et LÈVE sur panne de lecture (vérifié dans `src/workflow/wiring.ts:241-267` : `tplClient.list` lève, `find` rend `undefined`) ; `lireEnvoiApi` nomme `contacts.external_id` (lot 1).
- **L'auto-attaque** (`scripts/auto-attaque.mts`) inventorie les routes du serveur construit : `POST /v1/messages/whatsapp` y est attaquée sans rien câbler de plus.
- **Changement de comportement assumé** : une cible `node` sur un bloc « Envoi de mail » seul était acceptée (le type `email` n'exigeait aucune fenêtre) ; elle est désormais refusée `unsendable_target`, faute de message WhatsApp ou RCS à faire partir.

## Déploiement

1. **Prérequis** : le lot 1 est DÉPLOYÉ (migration `contacts.external_id` appliquée et `indisvalid` vérifié, `resoudreFiche` en production). `lireEnvoiApi` nomme `external_id`, et les routes de ce lot sont liées à `resoudreFiche`.
2. **Revue finale** : `/revue-finale` (la garde de déploiement l'exige).
3. **CI** : `gh run list --limit 5`, puis `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'` sur le dernier commit DE CODE : tous `success`. Puis `git log <commit déployé>..origin/main --oneline` : relire ce qui part (d'autres sessions poussent sur `main`).
4. **Migration AVANT le `up`** (le code neuf ÉCRIT `request_hash` à chaque claim : sans la colonne, chaque `POST /v1/sends` lèverait `42703`). Sur le VPS (`ssh`, dans `/home/ubuntu/mba`, détail dans `DEPLOY.md`) : `git pull` ; `sudo docker compose build mba-api` ; `sudo docker compose run --rm --no-deps mba-api ls db/migrations | tail -5` (voir ce que l'image va appliquer, migrations d'autres lots comprises) ; `sudo docker compose run --rm --no-deps mba-api npm run migrate`.
5. **Relecture en base, juste après `migrate`** : `select name from public.schema_migrations order by name desc limit 3;` (la migration de ce lot en tête) ; `select data_type, is_nullable, column_default from information_schema.columns where table_name = 'api_idempotency' and column_name = 'request_hash';` rend `text`, `YES`, `null`.
6. **`up`** : `sudo docker compose up -d --build` (API et worker, même image).
7. **Contrôle public des deux portes** : `curl -s -o /dev/null -w '%{http_code}\n' https://api.messagingme.app/health` et `curl -s -o /dev/null -w '%{http_code}\n' https://mba.messagingme.app/api/backend/health` rendent 200. Un 502 avec des conteneurs `healthy` : `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`, puis recontrôler.
8. **Compteur** : mettre à jour la ligne « Dernière appliquée » de `CLAUDE.md` (section Déploiement) avec le numéro et l'horodatage LUS dans `schema_migrations`, et retirer ce numéro des migrations « écrites et pas encore appliquées ». Commit par la procédure P, `CLAUDE.md` par P' (d'autres sessions l'éditent), message `docs(claude): <N> appliquee le <date> a <heure> UTC` suivi de la ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
9. **Console** : ce lot ne pousse aucun écran qui appelle une route neuve (seul un commentaire de `web/lib/qui-a-repondu.ts` change). La page de documentation réécrite (lot 4) se pousse APRÈS le déploiement de l'API qui porte ses routes.
10. **Essai réel** (section ci-dessus), puis `/sync`.
