# API publique v1, lot 6 : dictionnaire des signaux et adaptateur Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** remonter vers l'outil d'un client un DICTIONNAIRE de signaux indépendant de tout outil (livraison, lecture, échec, réponse, clic, désabonnement, conversation analysée, plus l'état courant de la fiche), et le traduire pour un premier outil, Batch, par un adaptateur réglé dans Paramètres > Intégrations.

**Architecture:** les chemins chauds (accusés Meta et RCS, entrants Meta et RCS, redirection d'un lien suivi, désabonnements, sortie de l'analyse) appellent UN émetteur générique (`src/signaux/emetteur.ts`) qui ne lève jamais, ne lit rien tant qu'aucun espace n'a branché d'outil, et enfile dans la file de chaque adaptateur actif des jobs MINIMAUX : une liste bornée de signaux (`SIGNAUX_PAR_JOB`), avec une PRIORITÉ (réponses, clics, désabonnements et analyses passent devant les accusés). Le worker de la file `signaux-batch` relit ce que le job ne porte pas (fiche, origine du message, analyse) par des lectures génériques (`completer.ts`), traduit par une fonction PURE (`versBatch`) vers les noms de champs que le DICTIONNAIRE fixe (`CHAMPS_EVENEMENT`), puis pousse vers `POST /profiles/update` de Batch. Un échec de poussée s'écrit dans la moitié « système » du journal des erreurs (`agent_tool_calls`, source `signaux`), sous un libellé qui ne nomme aucun outil.

**Tech Stack:** TypeScript (ESM, tsx), Fastify 5, pg-boss 12, Zod 4 (`safeParse` uniquement), Postgres (pooler Supabase), Next.js 15 (console), Vitest 2, Playwright.

**Spec:** docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md (§ 8 en entier, § 5 dernier point, § 10 « Réglage Batch » et « Ce que nous remontons », § 13 « Adaptateur Batch », § 14 item 6, § 16, § 17).

---

## Global Constraints

### Ce que ce lot consomme, et d'où

| Lot | Ce que le lot 6 en lit | Où il s'en sert |
|---|---|---|
| 1 | la colonne `contacts.external_id` (et son index unique partiel) ; `PgContactStore.ecrireConsentementParId`, inscrite dans `METHODES_QUI_ANNONCENT` de `tests/optout-poussee.test.ts` | `PgSignauxStore` (tâche 6) : c'est le `custom_id` du profil Batch ; tâche 9, étape 5 : le désabonnement de l'API passe par l'annonce, donc par le signal |
| 3 | ce qu'il a changé sous nos pieds : `PuitsAccuses.echecsLibres` (REQUIS), le couple `{ delivery; tarifsMeta; echecsLibres }` de `WebhookJobDeps` et la fixture `aucunEchecLibre` (`tests/webhook-fixtures.ts`) ; `onDlr` réduit à `onDlr: (tenant, dlr) => traiterRapportRcs({ … }, tenant, dlr)` (corps extrait vers `src/rcs/rapport-livraison.ts`) | tâche 4 : `PuitsAccuses`, `processStatuses` et le handler GARDENT `echecsLibres`, et les tests le passent ; tâche 9 : le signal RCS s'ajoute au câblage d'`onDlr` APRÈS `traiterRapportRcs`, sans toucher ce module. Se repérer aux ANCRES citées, pas aux numéros de ligne |
| 4 | `web/app/developers/api/page.tsx` réécrite et `web/lib/api-exemples.ts` | tâche 13 : la section « Ce que nous remontons » s'ajoute à la page, et le test « aucun outil tiers » lit les deux fichiers |
| 5 | les valeurs neuves de `INTENTS` (`achat`, `suivi_commande`, `retour`) | aucune ligne : `intent` traverse l'adaptateur tel quel, et la doc renvoie à l'écran d'analyse au lieu de recopier la liste |

Les lots 1 à 5 sont déployés AVANT ce lot (section Déploiement). Les numéros de ligne de ce plan ont été relus le 2026-09-24 sur `260ba2c6`, AVANT les lots 1 à 5 : quand un fichier a été touché depuis, se repérer au texte d'ancrage cité entre guillemets, jamais au seul numéro.

### 🔴 La demande de Julien, relayée pour ce plan

> « je veux pas de mention particuliere à batch dans la doc car ça doit servir à d'autres aussi »

Conséquences, toutes tenues par ce plan :

- le dictionnaire (`src/signaux/types.ts`), l'émetteur et les lectures ne nomment AUCUN outil ; Batch n'existe que dans `src/signaux/batch.ts`, `src/signaux/travail-batch.ts`, `src/signaux/integration-batch.pg.ts`, la route du réglage et son écran ;
- 🔴 les NOMS DES CHAMPS de chaque événement (`canal`, `send_id`, `action_suggestion`, `summary_1`…) sont fixés par le DICTIONNAIRE (`CHAMPS_EVENEMENT`, tâche 2), pas par l'adaptateur : la documentation annonce qu'ils « restent les mêmes quel que soit l'outil », donc un second adaptateur ne peut pas les renommer. L'adaptateur les consomme par leur type (un nom absent du dictionnaire ne compile pas), et la page de doc est tenue à la même liste par un test (tâche 13) ;
- la section « Ce que nous remontons » de la page Documentation API, le module qui la nourrit, `features.md` et `documentation.md` décrivent le dictionnaire et « l'outil branché dans Paramètres > Intégrations », sans jamais nommer Batch ; un test le vérifie (tâche 13) ;
- 🔴 le libellé d'une poussée ratée dans Sécurité > Journal des erreurs (`NOM_APPEL_SIGNAUX`) et le message d'erreur qui l'accompagne ne nomment pas l'outil non plus : la spec (§ 10) réserve le nom de Batch à l'écran de réglage de son adaptateur, et le journal est un écran de la marque, lu par d'autres que l'intégrateur ;
- la règle des noms (`em_`, 30 caractères, `[a-z0-9_]`) et la borne des textes (300 caractères) se disent « la plus stricte des outils connus », jamais « la borne de Batch ».

### Règles du dépôt qui s'appliquent à chaque tâche

- Tests unitaires : `npx vitest run <fichier>`. Typage : `npm run typecheck`. Suite : `npm test`.
- 🔴 Les tests d'INTÉGRATION (`tests/integration/*.integration.test.ts`) ne se lancent JAMAIS en local : le `DATABASE_URL` local est la PRODUCTION. Ils s'écrivent, et leur verdict se lit sur le run GitHub, job par job : `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'`. Jamais le code de sortie de `gh run watch`, qui a déjà rendu 0 sur un run en échec.
- Zod : `safeParse`, jamais `parse`, jamais `as` sur une entrée externe. Ici, trois entrées externes : le job relu depuis pg-boss (`schemaJobSignaux`), la réponse de Batch (`reponseBatch`) et le corps du réglage (`corpsReglage`).
- `tenant_id = $1` sur CHAQUE requête qui sert un espace. La seule lecture transverse de ce lot est `PgIntegrationBatchStore.espacesActifs`, qui alimente le cache de l'émetteur ; elle le dit dans son commentaire.
- Toute file pg-boss entre dans `BASE_QUEUES`, avec une cadence (`QUEUE_POLLING_SECONDS`) et un classement (`FILES_NOTIFIEES`).
- Un test de non-régression se vérifie DANS LES DEUX SENS (tâche 11 : remettre le code fautif, voir l'échec et son symptôme, restaurer).
- Aucun compteur calculable recopié en prose (nombre de files, de tests, de migrations).
- Rédaction : français, sans tiret cadratin ni demi-cadratin. Ne jamais écrire le nom de l'infrastructure sous-jacente de messagingme.app.
- Chemin chaud : tout ajout dans `processStatuses`, `processInbound`, `onDlr`, `onMo` et la redirection `/r/` est BEST-EFFORT (un `throw` y ferait rejouer le job entier, ou bloquerait une redirection) et ne coûte AUCUNE requête sur un statut `sent` ni tant qu'aucun espace n'a branché d'outil.

### Commits : l'arbre est partagé par plusieurs sessions

🔴 **TOUS les commits de ce lot suivent la procédure P**, la même que le lot 1 (`docs/superpowers/plans/2026-09-24-api-v1-lot1-identite-contacts.md`, § « Procédure de commit P »). Jamais `git add` suivi d'un `git commit`, même `--only` : `git push origin main` pousserait aussi les commits locaux non poussés d'une autre session, et `git commit --only` prend le contenu du DISQUE, qui peut porter une ligne d'un pair. Jamais non plus de `git merge`, `git reset`, `git checkout` ni `update-ref` dans l'arbre partagé : avancer `HEAD` réécrirait sur disque les fichiers des autres sessions, c'est exactement la fenêtre que la plomberie existe pour fermer (`CLAUDE.md` du dépôt, 2026-09-23 : « Ni l'index partagé ni l'arbre sur disque ne sont touchés »). Le `HEAD` local ne bouge donc pas de tout le lot, et c'est voulu : la vérité est `origin/main`.

**Procédure P** (chaque commit) :

1. Relire SES hunks, dans le même appel que la suite, et chercher l'INTRUS dans le diff (pas dans la liste des chemins) :

```bash
cd /c/Users/julie/messagingme-mba && git fetch -q origin && git diff origin/main -- <chemins de la tâche> && git status --porcelain -- <chemins de la tâche>
```

La liste des chemins est la section **Files** de la tâche, jamais `git status`. Si un hunk n'est pas de ce lot : s'arrêter et appliquer P' à ce fichier.

2. Écrire le message dans un fichier temporaire (il se termine par la ligne d'attribution), puis construire et pousser :

```bash
cd /c/Users/julie/messagingme-mba && M="$(cygpath -m "$(mktemp)")" && cat > "$M" <<'EOF'
<type>(<zone>): <résumé>

<corps>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
export GIT_INDEX_FILE="$(cygpath -m "$(mktemp -u)")" \
 && git read-tree origin/main \
 && for f in <chemins de la tâche>; do git update-index --add --cacheinfo "100644,$(git hash-object -w --path="$f" "$f"),$f"; done \
 && { set -o pipefail; git diff --cached origin/main | gitleaks stdin --no-banner; } \
 && C="$(git commit-tree "$(git write-tree)" -p origin/main -F "$M")" \
 && git push origin "$C":main; rm -f "$GIT_INDEX_FILE" "$M"; unset GIT_INDEX_FILE
```

3. Vérifier sur `origin`, jamais sur `HEAD` local : `git fetch -q origin && git log --oneline -1 origin/main && git show --stat origin/main`, qui doit montrer SES chemins et eux seuls. Un `push` refusé (une autre session a poussé entre-temps) se rejoue tel quel depuis l'étape 1 : `read-tree origin/main` repart de la nouvelle tête, sans `pull` ni `rebase`.

⚠️ `commit-tree` ne déclenche aucun hook : `gitleaks` est lancé à la main ci-dessus, sur EXACTEMENT ce qui part (le diff de l'index temporaire contre `origin/main`, comme au lot 1). 🔴 Pas `gitleaks git --staged` : il compare l'index au HEAD LOCAL, que la plomberie ne fait jamais avancer et qui porte les commits non poussés d'autres sessions. Le hook `rayon-de-souffle` ne tourne pas, la section « Rayon de souffle » de ce plan et `/revue` en tiennent lieu. Après le push : `gh run list --limit 3`, puis lire le run job par job.

**Procédure P'** (fichier que d'autres sessions modifient aussi : `CLAUDE.md` et `todo.md`, en `MM` au moment d'écrire ce plan, ou tout fichier dont `git diff origin/main` montre un hunk étranger) :

1. Faire SA modification dans l'arbre (outil Edit, le plus petit remplacement possible), pour qu'un commit ultérieur de l'autre session la porte aussi.
2. Construire le blob depuis `origin` : `B="$(cygpath -m "$(mktemp)")" && git show origin/main:<fichier> > "$B"`, appliquer LE MÊME remplacement à `"$B"` (outil Edit sur ce chemin absolu), puis, dans la boucle de P, remplacer la ligne du fichier par `git update-index --add --cacheinfo "100644,$(git hash-object -w --path=<fichier> "$B"),<fichier>"`.
3. Relire `git diff origin/main --cached -- <fichier>` (avec `GIT_INDEX_FILE` exporté) : il ne doit montrer QUE son remplacement.

**Fichiers de câblage partagés** (`src/server.ts`, `src/index.ts`, `src/worker.ts`) : ANNONCER l'édition aux autres sessions (outil `ListAgents` puis `SendMessage`, un message, pas de verrou) AVANT de toucher le fichier, puis relire `git diff origin/main -- <fichier>` juste avant P. Un hunk étranger impose P'.

### Faits de l'API Profils de Batch, relus sur https://doc.batch.com/developer/api/cep/profiles/update.md le 2026-09-24

- `POST https://api.batch.com/2.13/profiles/update`, en-têtes `Authorization: Bearer <clé REST>` et `X-Batch-Project: <clé de projet>`.
- Corps : un TABLEAU de `{ identifiers: { custom_id }, attributes, events }` ; un événement est `{ name, time (RFC 3339), attributes }`.
- Bornes : 200 profils par appel, 15 événements par profil et par appel, clé d'attribut et nom d'événement en `[a-z0-9_]` de 30 caractères au plus, 50 attributs de fiche par opération, 25 ko par événement, 300 mises à jour de profil par seconde (seau de 1 000).
- 🔴 Un attribut TEXTE fait de 1 à 300 caractères, de fiche COMME D'ÉVÉNEMENT : la page dit des attributs de fiche « cannot be empty or over 300 characters », et des attributs d'événement « All types except for Array & Object behave as they do in profile attributes ». Aucune longueur supérieure n'est citée, sauf 2 048 pour un attribut de type URL. Un résumé de conversation (800 caractères au plus côté analyse) ne tient donc ni en attribut ni en un seul champ d'événement : il voyage en MORCEAUX (`summary_1` à `summary_3`, tâche 2).
- Un attribut invalide (vide, trop long, mauvais type) est rejeté SEUL : l'appel rend 202 `SUCCESS_WITH_PARTIAL_ERRORS` avec le détail, le reste du profil passe. Un défaut de borne ne fait donc échouer aucun test HTTP : il fait disparaître la donnée, en silence. C'est pourquoi la traduction est testée sur ses bornes (tâche 3).
- Attribut date : clé `date(<nom>)`.
- Réponses : 202 `{ "code": "SUCCESS" }` ou `{ "code": "SUCCESS_WITH_PARTIAL_ERRORS", "errors": [...] }` ; 400 et 401 et 404 terminaux ; 429, 500, 503 à rejouer ; corps d'erreur `{ error_code, error_message }`.
- ⚠️ Le segment de version (`2.13`) vit dans UNE constante (`BATCH_URL_PROFILS`) : le relire sur la page au moment d'écrire la tâche 3.

---

### Task 1 : La migration, la source `signaux` du journal, et le compteur

**Files:**
- Create: `db/migrations/<N>_signaux_batch.sql` (`<N>` pris à l'étape 1)
- Create: `tests/signaux-migration.test.ts`
- Modify: `tests/sources-appel-parite.test.ts` (fin du `describe`, après le cas « la liste lue en base contient bien l’agent de Meta », ligne 35 à 37)
- Modify: `src/agent/catalog.ts:28` (`SOURCES_APPEL`)
- Modify: `web/components/ErreursLivraison.tsx:201-207` (`quiAppelait`)
- Modify: `CLAUDE.md` (phrase du compteur, section « Déploiement », paragraphe « **Dernière appliquée : … »)

**Interfaces:**
- Consumes : `agent_tool_calls_source_check` (0142, relâché en 0161), `SOURCES_APPEL`.
- Produces : table `integration_batch(tenant_id uuid PK, cle_rest_chiffree text, cle_projet_chiffree text, envoyer_resume boolean default false, sans_identifiant bigint default 0, sans_identifiant_le timestamptz, refus_cles_le timestamptz, maj_le timestamptz)` ; `SOURCES_APPEL = ['agent', 'scenario', 'optout', 'mba', 'signaux']` ; CHECK de même liste.

- [ ] **Step 1 : prendre le numéro, au moment d'écrire (le DOSSIER tranche sur ce qui est pris)**

```bash
cd /c/Users/julie/messagingme-mba && git fetch origin && ls db/migrations | tail -1 && git ls-tree --name-only origin/main db/migrations/ | tail -1
```

`<N>` = le plus grand des deux numéros affichés, plus un, sur quatre chiffres (sortie `0176_xxx.sql` : `<N>` = `0177`). Vérifier qu'il est libre : `ls db/migrations | grep -c "^<N>_"` doit rendre `0`.

- [ ] **Step 2 : écrire les tests qui échouent**

Ajouter à la fin du `describe` de `tests/sources-appel-parite.test.ts` :

```ts
  it('🔴 la liste lue en base contient la remontée des signaux (lot 6 de l’API publique)', () => {
    // Sans elle, l'échec d'une poussée vers l'outil d'un client serait refusé par le CHECK, et le journal
    // (best-effort) l'avalerait en silence : le client ne verrait jamais que sa remontée ne marche pas.
    expect(listeEnBase()).toContain('signaux');
  });
```

Créer `tests/signaux-migration.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * LA MIGRATION DES SIGNAUX (spec 2026-09-24, § 8 et § 11), lue dans le FICHIER, pas recopiée.
 *
 * ⚠️ Elle ne se vérifie en base que dans le job `integration` de la CI (`tests/integration/signaux.integration.test.ts`),
 * et en production juste après `migrate`. Ce test-ci garde ce que le fichier doit dire, sans base.
 */
const DOSSIER = resolve(__dirname, '..', 'db', 'migrations');
const fichiers = readdirSync(DOSSIER).filter((f) => /^\d{4}_signaux_batch\.sql$/.test(f));
const sql = fichiers.length === 1 ? readFileSync(join(DOSSIER, fichiers[0]!), 'utf8') : '';

describe('la migration des signaux', () => {
  it('existe, une seule fois', () => {
    expect(fichiers).toHaveLength(1);
  });

  it('crée le réglage : clés chiffrées, résumé DÉCOCHÉ par défaut, compteur et suspension', () => {
    expect(sql).toMatch(/create table if not exists integration_batch/);
    expect(sql).toMatch(/tenant_id\s+uuid primary key references tenants\(id\) on delete cascade/);
    expect(sql).toMatch(/cle_rest_chiffree\s+text not null/);
    expect(sql).toMatch(/cle_projet_chiffree\s+text not null/);
    expect(sql).toMatch(/envoyer_resume\s+boolean not null default false/);
    expect(sql).toMatch(/sans_identifiant\s+bigint not null default 0/);
    expect(sql).toMatch(/refus_cles_le\s+timestamptz/);
  });

  it('🔴 elle est additive : aucune table ni colonne ne disparaît, donc elle passe AVANT le déploiement', () => {
    expect(sql).not.toMatch(/drop\s+(table|column)/i);
  });

  it('🔴 aucun accent grave dans le fichier (ils ferment le gabarit de chaîne des outils qui le relisent)', () => {
    expect(sql).not.toContain('`');
  });
});
```

- [ ] **Step 3 : les voir échouer**

```bash
npx vitest run tests/sources-appel-parite.test.ts tests/signaux-migration.test.ts
```

Attendu : ÉCHEC du cas « contient la remontée des signaux » (`expected [ 'agent', 'mba', 'optout', 'scenario' ] to include 'signaux'`) et des quatre cas de `signaux-migration` (`expected [] to have a length of 1`).

- [ ] **Step 4 : écrire la migration**

`db/migrations/<N>_signaux_batch.sql` (ASCII, sans accent grave, commentaires sans accents comme les migrations voisines) :

```sql
-- <N>_signaux_batch.sql : les signaux vers l outil d un client (spec 2026-09-24, section 8), lot 6 de l API publique.
--
-- DEUX changements, et l ancien code survit aux deux : il n ecrit pas la table neuve, et il n ecrit jamais
-- la source signaux dans le journal. Donc AVANT le deploiement du code qui les ecrit.
--
-- 1. integration_batch : le reglage de l adaptateur, UNE ligne par espace.
--    Les deux cles sont CHIFFREES (src/crypto/secretbox.ts, ENCRYPTION_KEY) et jamais relues en clair par
--    un ecran. envoyer_resume est FAUX par defaut : le resume contient des propos du client.
--    sans_identifiant compte les signaux non pousses faute d identifiant externe sur la fiche : l ecran du
--    reglage le montre, pour qu un integrateur qui a oublie de nous passer ses identifiants le VOIE.
--    refus_cles_le suspend la remontee quand l outil refuse les cles (401, 403). Sans elle, chaque signal
--    ecrirait une ligne de plus dans agent_tool_calls, que rien ne purge.
--    AUCUN index en plus de la cle primaire : la seule lecture transverse (les espaces actifs, mise en cache
--    par l emetteur) parcourt une table d une ligne par espace branche.
--
-- 2. Le CHECK de la source du journal des appels s ouvre a signaux : un echec de poussee s ecrit dans la
--    moitie systeme du journal des erreurs, comme un connecteur qui refuse un appel. RELACHER un CHECK
--    laisse vivre l ancien code. La liste doit rester celle de SOURCES_APPEL (src/agent/catalog.ts), et
--    tests/sources-appel-parite.test.ts lit la DERNIERE migration qui le pose.

create table if not exists integration_batch (
  tenant_id           uuid primary key references tenants(id) on delete cascade,
  cle_rest_chiffree   text not null,
  cle_projet_chiffree text not null,
  envoyer_resume      boolean not null default false,
  sans_identifiant    bigint not null default 0,
  sans_identifiant_le timestamptz,
  refus_cles_le       timestamptz,
  maj_le              timestamptz not null default now()
);

alter table agent_tool_calls drop constraint if exists agent_tool_calls_source_check;
alter table agent_tool_calls add constraint agent_tool_calls_source_check
  check (source in ('agent', 'scenario', 'optout', 'mba', 'signaux'));
```

Dans `src/agent/catalog.ts`, ligne 28 :

```ts
export const SOURCES_APPEL = ['agent', 'scenario', 'optout', 'mba', 'signaux'] as const;
```

et compléter le commentaire juste au-dessus (après « l'agent de Meta compris depuis le relais (migration 0161). ») :

```ts
 * `signaux` (lot 6 de l'API publique) : la poussée des signaux vers l'outil qu'un client a branché dans
 * Paramètres > Intégrations. Elle n'appelle aucun connecteur, mais son échec est de la même nature : le
 * système du CLIENT a refusé ce que nous lui passions.
```

- [ ] **Step 5 : les voir passer, et le typage**

```bash
npx vitest run tests/sources-appel-parite.test.ts tests/signaux-migration.test.ts && npm run typecheck
```

Attendu : tous verts, typage propre.

- [ ] **Step 6 : dire en français qui appelait**

Dans `web/components/ErreursLivraison.tsx`, fonction `quiAppelait` (ligne 201), ajouter après la ligne `if (source === 'mba') return t('l’agent de Meta', 'Meta’s agent');` :

```tsx
    if (source === 'signaux') return t('la remontée des signaux vers votre outil', 'the signal push to your tool');
```

- [ ] **Step 7 : écrire la ligne du compteur DANS ce commit (onzième dérive de `CLAUDE.md`)**

Dans le paragraphe qui commence par « **Dernière appliquée : », remplacer la phrase « **ÉCRITE ET PAS ENCORE APPLIQUÉE : … », puis « **Prochaine libre = … », par :

```markdown
**ÉCRITE ET PAS ENCORE APPLIQUÉE : <N>** (`signaux_batch`, lot 6 de l'API publique : la table du réglage de l'adaptateur de signaux, et le CHECK de la source du journal des appels relâché pour `signaux` ; additive et relâchante, donc AVANT le `up`). **Prochaine libre = <N+1>**, et le dossier `db/migrations/` s'arrête à <N>.
```

Si la phrase existante nomme d'autres migrations écrites et non appliquées (celles des lots précédents), les GARDER et ajouter `<N>` à la liste. `CLAUDE.md` est modifié par une autre session : procédure P' (étape 8).

- [ ] **Step 8 : commit (procédure P, avec P' pour `CLAUDE.md`)**

Annoncer l'édition de `CLAUDE.md` aux autres sessions. Chemins : `db/migrations/<N>_signaux_batch.sql tests/signaux-migration.test.ts tests/sources-appel-parite.test.ts src/agent/catalog.ts web/components/ErreursLivraison.tsx CLAUDE.md` (ce dernier par son blob `"$B"`, construit depuis `origin/main` selon P' ; `git diff origin/main --cached -- CLAUDE.md` ne montre qu'UNE phrase changée). Message : `feat(signaux): migration <N>, reglage de l adaptateur et source signaux du journal (lot 6)`.

---

### Task 2 : Le dictionnaire (`src/signaux/types.ts`)

**Files:**
- Create: `src/signaux/types.ts`
- Create: `tests/signaux-types.test.ts`

**Interfaces:**
- Consumes : `llmOutputSchema` (`src/analysis/schema.ts:48`, champ `summary` borné à 800 ligne 66), dans le TEST seulement, pour dériver le nombre de morceaux du résumé.
- Produces :
  - `NOM_DICTIONNAIRE_RE: RegExp`, `CHAMP_RE: RegExp`, `NOMS_EVENEMENTS` (`as const`, les événements du § 8), `type NomEvenement`, `NOMS_ATTRIBUTS` (les attributs du § 8), `type NomAttribut`, `CANAUX_SIGNAL = ['whatsapp', 'rcs']`, `type CanalSignal`, `SOURCE_STOP_RCS = 'rcs_stop'`
  - `TEXTE_SIGNAL_MAX = 300`, `MORCEAUX_RESUME = ['summary_1', 'summary_2', 'summary_3']`, `CHAMP_ID_EVENEMENT = 'em_event_id'`, `CHAMPS_EVENEMENT` (`as const satisfies Record<NomEvenement, readonly string[]>`), `type ChampEvenement<N extends NomEvenement>`
  - `NOM_APPEL_SIGNAUX` (le libellé NEUTRE d'une poussée ratée dans le journal des erreurs), `SIGNAUX_PAR_JOB = 200`
  - `function borneTexte(v: string, max?: number): string`, `function morceauxDuResume(texte: string): string[]`
  - `function idSignal(nom: NomEvenement, cleNaturelle?: string): string`
  - `schemaSignal` (Zod, union discriminée sur `nom`, `.strict()`), `type Signal`
  - `schemaJobSignaux` (`{ tenantId: uuid, signaux: Signal[] }` de 1 à `SIGNAUX_PAR_JOB`, `.strict()`), `type JobSignaux`
  - `interface ContactDuSignal { contactId: string; externalId: string | null; optOutWhatsapp: boolean; optOutRcs: boolean }`
  - `interface AnalyseDuSignal { intent; sentiment; satisfaction: number | null; urgence: number | null; resolved: boolean; topic; actionSuggestion; handledBy; exchangesCount: number; summary: string | null }`
  - `type ContenuSignal` (une variante par nom ; `em_opted_out` porte `canal: CanalSignal | null`), `interface SignalComplet { id: string; le: string; contact: ContactDuSignal; contenu: ContenuSignal }`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/signaux-types.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import {
  NOMS_EVENEMENTS, NOMS_ATTRIBUTS, NOM_DICTIONNAIRE_RE, CHAMP_RE, CHAMPS_EVENEMENT, CHAMP_ID_EVENEMENT,
  MORCEAUX_RESUME, TEXTE_SIGNAL_MAX, SIGNAUX_PAR_JOB, NOM_APPEL_SIGNAUX,
  borneTexte, morceauxDuResume, idSignal, schemaSignal, schemaJobSignaux,
} from '../src/signaux/types';
import { llmOutputSchema } from '../src/analysis/schema';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const LE = '2026-09-24T10:00:00.000Z';

describe('le dictionnaire des signaux', () => {
  it('🔴 chaque nom tient la règle la plus stricte des outils connus : em_, 30 caractères, [a-z0-9_]', () => {
    for (const n of [...NOMS_EVENEMENTS, ...NOMS_ATTRIBUTS]) {
      expect(n, n).toMatch(NOM_DICTIONNAIRE_RE);
      expect(n.length, n).toBeLessThanOrEqual(30);
    }
  });

  it('aucun nom en double entre événements et attributs', () => {
    const tous = [...NOMS_EVENEMENTS, ...NOMS_ATTRIBUTS];
    expect(new Set(tous).size).toBe(tous.length);
  });

  it('la règle refuse ce qu’un outil strict refuserait', () => {
    expect('em_Majuscule').not.toMatch(NOM_DICTIONNAIRE_RE);
    expect(`em_${'x'.repeat(28)}`).not.toMatch(NOM_DICTIONNAIRE_RE);
    expect('sans_prefixe').not.toMatch(NOM_DICTIONNAIRE_RE);
    expect('em_tiret-bas').not.toMatch(NOM_DICTIONNAIRE_RE);
  });

  it('🔴 les champs de CHAQUE événement sont fixés ici, et tiennent la même règle de nom', () => {
    expect(Object.keys(CHAMPS_EVENEMENT).sort()).toEqual([...NOMS_EVENEMENTS].sort());
    for (const [nom, champs] of Object.entries(CHAMPS_EVENEMENT)) {
      expect(new Set(champs).size, nom).toBe(champs.length);
      for (const c of champs) {
        expect(c, `${nom}.${c}`).toMatch(CHAMP_RE);
        // L'identifiant d'événement est COMMUN : il ne se redéclare pas dans un événement.
        expect(c, `${nom}.${c}`).not.toBe(CHAMP_ID_EVENEMENT);
      }
    }
    expect(CHAMP_ID_EVENEMENT).toMatch(CHAMP_RE);
  });

  it('🔴 le libellé du journal des erreurs ne nomme aucun outil (spec § 10)', () => {
    expect(NOM_APPEL_SIGNAUX).not.toMatch(/\b(batch|brevo|splio|sfmc|salesforce|hubspot|klaviyo|braze)\b/i);
  });
});

describe('les textes : une borne, et le résumé en morceaux', () => {
  it('🔴 le résumé le plus long que l’analyse produit tient ENTIER dans les morceaux (dérivé, pas recopié)', () => {
    const maxAnalyse = llmOutputSchema.shape.summary.unwrap().maxLength ?? Number.POSITIVE_INFINITY;
    // `- 1` : un morceau peut s'arrêter un caractère plus tôt pour ne pas couper un emoji.
    expect(MORCEAUX_RESUME.length * (TEXTE_SIGNAL_MAX - 1)).toBeGreaterThanOrEqual(maxAnalyse);
    const resume = 'Le client demande où en est sa livraison. '.repeat(40).slice(0, maxAnalyse);
    const morceaux = morceauxDuResume(resume);
    expect(morceaux.join('')).toBe(resume);
    expect(morceaux.length).toBeLessThanOrEqual(MORCEAUX_RESUME.length);
    for (const m of morceaux) expect(m.length).toBeLessThanOrEqual(TEXTE_SIGNAL_MAX);
  });

  it('un résumé court : un seul morceau, et rien pour un résumé vide', () => {
    expect(morceauxDuResume('Court.')).toEqual(['Court.']);
    expect(morceauxDuResume('')).toEqual([]);
  });

  it('🔴 borneTexte ne coupe pas un emoji en deux (un demi-caractère serait refusé par l’outil)', () => {
    const v = `${'x'.repeat(TEXTE_SIGNAL_MAX - 1)}😀fin`;
    const b = borneTexte(v);
    expect(b).toBe('x'.repeat(TEXTE_SIGNAL_MAX - 1));
    expect(borneTexte('court')).toBe('court');
  });
});

describe('idSignal : l’em_event_id', () => {
  it('🔴 avec une clé naturelle, il est STABLE : un webhook redélivré donne le même identifiant', () => {
    expect(idSignal('em_message_delivered', 'wamid.X')).toBe(idSignal('em_message_delivered', 'wamid.X'));
  });

  it('deux événements du même message ne se confondent pas', () => {
    expect(idSignal('em_message_delivered', 'wamid.X')).not.toBe(idSignal('em_message_read', 'wamid.X'));
  });

  it('🔴 il ne laisse pas sortir la clé : un identifiant de message WhatsApp encode le numéro', () => {
    const id = idSignal('em_message_delivered', 'wamid.HBgLMzM2MTIzNDU2NzgVAgARGBI');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain('wamid');
  });

  it('sans clé naturelle, un identifiant neuf à chaque émission (figé ensuite dans le job)', () => {
    expect(idSignal('em_opted_out')).not.toBe(idSignal('em_opted_out'));
  });
});

describe('schemaJobSignaux : le job se relit comme une entrée externe', () => {
  const reponse = { nom: 'em_replied', id: idSignal('em_replied', 'wamid.R'), le: LE, waId: '33612345678', canal: 'whatsapp', bouton: 'Oui' };
  const ok = { tenantId: T, signaux: [reponse] };

  it('accepte un job bien formé', () => {
    expect(schemaJobSignaux.safeParse(ok).success).toBe(true);
  });

  it('🔴 refuse une clé en trop, même dans un signal (le texte d’un message n’a pas de place ici)', () => {
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [{ ...reponse, texte: 'bonjour' }] }).success).toBe(false);
  });

  it('refuse un nom hors dictionnaire, un canal inconnu, un espace qui n’est pas un uuid', () => {
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [{ ...reponse, nom: 'em_inconnu' }] }).success).toBe(false);
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [{ ...reponse, canal: 'sms' }] }).success).toBe(false);
    expect(schemaJobSignaux.safeParse({ ...ok, tenantId: 't1' }).success).toBe(false);
  });

  it('🔴 un job porte de 1 à SIGNAUX_PAR_JOB signaux, jamais zéro, jamais plus', () => {
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [] }).success).toBe(false);
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: Array.from({ length: SIGNAUX_PAR_JOB }, () => reponse) }).success).toBe(true);
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: Array.from({ length: SIGNAUX_PAR_JOB + 1 }, () => reponse) }).success).toBe(false);
  });

  it('accepte un cas de CHAQUE nom du dictionnaire, ni plus ni moins', () => {
    const signaux = [
      { nom: 'em_message_delivered', id: idSignal('em_message_delivered', 'm1'), le: LE, waId: '336', canal: 'rcs', messageId: 'm1' },
      { nom: 'em_message_read', id: idSignal('em_message_read', 'm1'), le: LE, waId: '336', canal: 'whatsapp', messageId: 'm1' },
      { nom: 'em_message_failed', id: idSignal('em_message_failed', 'm1'), le: LE, waId: '336', canal: 'whatsapp', messageId: 'm1', motif: '131026 Message undeliverable', codeMeta: 131026 },
      { nom: 'em_replied', id: idSignal('em_replied', 'm2'), le: LE, waId: '336', canal: 'rcs', bouton: null },
      { nom: 'em_link_clicked', id: idSignal('em_link_clicked'), le: LE, contactId: C, lien: 'ab12cd34ef56' },
      { nom: 'em_opted_out', id: idSignal('em_opted_out'), le: LE, waId: '336', canal: 'whatsapp' },
      { nom: 'em_conversation_analyzed', id: idSignal('em_conversation_analyzed'), le: LE, conversationId: C },
    ];
    for (const s of signaux) expect(schemaSignal.safeParse(s).success, s.nom).toBe(true);
    expect(signaux.map((s) => s.nom).sort()).toEqual([...NOMS_EVENEMENTS].sort());
  });
});
```

- [ ] **Step 2 : le voir échouer**

```bash
npx vitest run tests/signaux-types.test.ts
```

Attendu : ÉCHEC à l'import (`Failed to load url ../src/signaux/types`).

- [ ] **Step 3 : écrire le module**

`src/signaux/types.ts` :

```ts
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * LE DICTIONNAIRE DES SIGNAUX (spec 2026-09-24, § 8) : ce que la console remonte vers l'outil d'un client
 * (plateforme d'orchestration, CRM, outil marketing) quand il se passe quelque chose sur une fiche.
 *
 * 🔴 INDÉPENDANT DE TOUT OUTIL CIBLE, et c'est sa raison d'être. Ce fichier dit CE QUI S'EST PASSÉ et SOUS
 * QUELS NOMS ça part (événements, attributs, champs de chaque événement) : un ADAPTATEUR par outil (dans ce
 * dossier) le traduit dans le format de son outil, sans l'étendre ni le renommer. Rien ici n'importe un
 * adaptateur, et la documentation publique le décrit sans nommer aucun outil
 * (`web/lib/signaux-dictionnaire.ts`, parité tenue par `tests/web-signaux-parite.test.ts`).
 */

/** Préfixe `em_`, 30 caractères au plus, `[a-z0-9_]` : la règle de nom la plus stricte des outils connus. */
export const NOM_DICTIONNAIRE_RE = /^em_[a-z0-9_]{1,27}$/;
/** La clé d'un champ d'événement : la même règle, sans le préfixe. */
export const CHAMP_RE = /^[a-z0-9_]{1,30}$/;

export const NOMS_EVENEMENTS = [
  'em_message_delivered',
  'em_message_read',
  'em_message_failed',
  'em_replied',
  'em_link_clicked',
  'em_opted_out',
  'em_conversation_analyzed',
] as const;
export type NomEvenement = (typeof NOMS_EVENEMENTS)[number];

/** L'état courant d'une fiche, poussé AVEC les événements. */
export const NOMS_ATTRIBUTS = [
  'em_contact_id',
  'em_last_intent',
  'em_last_sentiment',
  'em_satisfaction',
  'em_urgency',
  'em_last_resolved',
  'em_last_reply_at',
  'em_whatsapp_optout',
  'em_rcs_optout',
  'em_rcs_reachable',
] as const;
export type NomAttribut = (typeof NOMS_ATTRIBUTS)[number];

export const CANAUX_SIGNAL = ['whatsapp', 'rcs'] as const;
export type CanalSignal = (typeof CANAUX_SIGNAL)[number];

/** La source d'un désabonnement dit STOP sur le canal RCS, pendant de `SOURCE_STOP_WHATSAPP`. */
export const SOURCE_STOP_RCS = 'rcs_stop';

/**
 * Un texte de signal tient en 300 caractères, et n'est jamais vide : la borne la plus stricte des outils connus,
 * appliquée au dictionnaire lui-même pour que tout adaptateur le transporte tel quel.
 */
export const TEXTE_SIGNAL_MAX = 300;

/**
 * 🔴 LE RÉSUMÉ D'UNE CONVERSATION VOYAGE EN MORCEAUX. Il fait jusqu'à 800 caractères côté analyse
 * (`llmOutputSchema.summary`), donc plus que `TEXTE_SIGNAL_MAX` : il part en morceaux CONSÉCUTIFS, à recoller
 * bout à bout, sans séparateur. Le borner à 300 aurait jeté la fin de deux résumés sur trois (« 2 à 3
 * phrases », consigne du prompt), et le laisser entier le ferait refuser par l'outil, en silence. Le nombre de
 * morceaux est tenu par un test qui le DÉRIVE de la borne de l'analyse.
 */
export const MORCEAUX_RESUME = ['summary_1', 'summary_2', 'summary_3'] as const;

/** L'identifiant stable d'un événement (`idSignal`), présent sur CHAQUE événement. */
export const CHAMP_ID_EVENEMENT = 'em_event_id';

/**
 * 🔴 LES NOMS DES CHAMPS DE CHAQUE ÉVÉNEMENT, tels qu'ils partent chez l'outil, QUEL QU'IL SOIT.
 *
 * Ils vivent ICI et pas dans un adaptateur : la documentation publique annonce qu'ils « restent les mêmes quel
 * que soit l'outil », donc un second adaptateur ne peut pas les renommer. Un adaptateur les consomme par leur
 * TYPE (`ChampEvenement`) : un nom qui n'est pas dans cette liste ne compile pas. La page de documentation est
 * tenue à cette liste par `tests/web-signaux-parite.test.ts`. `CHAMP_ID_EVENEMENT` s'ajoute à chacun.
 */
export const CHAMPS_EVENEMENT = {
  em_message_delivered: ['canal', 'origine', 'send_id'],
  em_message_read: ['canal', 'origine', 'send_id'],
  em_message_failed: ['canal', 'origine', 'send_id', 'motif', 'code_meta'],
  em_replied: ['canal', 'bouton'],
  em_link_clicked: ['lien', 'template', 'destination'],
  em_opted_out: ['canal', 'source'],
  em_conversation_analyzed: [
    'intent', 'sentiment', 'satisfaction', 'urgence', 'resolved', 'topic', 'action_suggestion', 'handled_by',
    'exchanges_count', ...MORCEAUX_RESUME,
  ],
} as const satisfies Record<NomEvenement, readonly string[]>;
export type ChampEvenement<N extends NomEvenement> = (typeof CHAMPS_EVENEMENT)[N][number];

/**
 * Le libellé d'une poussée ratée dans Sécurité > Journal des erreurs, LE MÊME pour tout adaptateur.
 *
 * 🔴 IL NE NOMME AUCUN OUTIL : la spec (§ 10) réserve le nom de l'outil à l'écran de réglage de son adaptateur,
 * et le journal est lu par la marque, pas seulement par l'intégrateur qui a branché l'outil.
 */
export const NOM_APPEL_SIGNAUX = 'Outil branché (Paramètres > Intégrations) : mise à jour des profils';

/**
 * Au plus autant de signaux par job. Une action en masse (un désabonnement de milliers de fiches, écrit dans la
 * requête HTTP d'un opérateur) s'enfile donc en quelques jobs, et non en un enfilement par fiche.
 */
export const SIGNAUX_PAR_JOB = 200;

/** Borne un texte sans couper une paire de substitution : un emoji coupé en deux serait un caractère invalide. */
export function borneTexte(v: string, max: number = TEXTE_SIGNAL_MAX): string {
  if (v.length <= max) return v;
  const c = v.charCodeAt(max - 1);
  return v.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** Le résumé en morceaux consécutifs de `TEXTE_SIGNAL_MAX` au plus, recollables bout à bout. */
export function morceauxDuResume(texte: string): string[] {
  const morceaux: string[] = [];
  let reste = texte;
  while (reste !== '' && morceaux.length < MORCEAUX_RESUME.length) {
    const m = borneTexte(reste);
    morceaux.push(m);
    reste = reste.slice(m.length);
  }
  return morceaux;
}

/**
 * L'identifiant STABLE d'un signal, qui voyage comme `em_event_id`.
 *
 * 🔴 IL EST FIGÉ À L'ÉMISSION, DANS LE JOB : une poussée rejouée par la file porte donc le même, et l'outil du
 * client peut dédupliquer. Avec une CLÉ NATURELLE (l'identifiant que Meta ou le fournisseur RCS a donné au
 * message), il reste le même quand le fournisseur nous redélivre son webhook.
 *
 * ⚠️ OPAQUE, et pas la clé elle-même : un identifiant de message WhatsApp encode le numéro du destinataire,
 * qui n'a rien à faire dans un identifiant d'événement.
 */
export function idSignal(nom: NomEvenement, cleNaturelle?: string): string {
  if (cleNaturelle === undefined) return randomUUID();
  return createHash('sha256').update(`${nom}:${cleNaturelle}`).digest('hex').slice(0, 32);
}

const id = z.string().regex(/^[0-9a-f-]{32,36}$/);
const le = z.string().min(1).max(40).refine((v) => !Number.isNaN(Date.parse(v)), { message: 'date illisible' });
const canal = z.enum(CANAUX_SIGNAL);
const waId = z.string().trim().min(1).max(64);
const messageId = z.string().min(1).max(200);

/**
 * Ce que le CHEMIN CHAUD émet : ce qu'il sait déjà, rien de plus. La fiche, l'origine du message et l'analyse
 * se relisent au moment de pousser (`completerSignal`), jamais sur un accusé de livraison.
 *
 * `.strict()` partout : le job se relit depuis la file comme une entrée externe, et une clé en trop dit qu'un
 * émetteur et le lecteur ne parlent plus du même contrat.
 */
export const schemaSignal = z.discriminatedUnion('nom', [
  z.object({ nom: z.literal('em_message_delivered'), id, le, waId, canal, messageId }).strict(),
  z.object({ nom: z.literal('em_message_read'), id, le, waId, canal, messageId }).strict(),
  z.object({
    nom: z.literal('em_message_failed'), id, le, waId, canal, messageId,
    motif: z.string().max(500).nullable(),
    codeMeta: z.number().int().nullable(),
  }).strict(),
  z.object({ nom: z.literal('em_replied'), id, le, waId, canal, bouton: z.string().max(300).nullable() }).strict(),
  z.object({ nom: z.literal('em_link_clicked'), id, le, contactId: z.string().uuid(), lien: z.string().min(1).max(64) }).strict(),
  /**
   * ⚠️ Ici, `canal` dit QUEL CONSENTEMENT l'écriture a retiré : `whatsapp` pour `opt_in_status` (le dépôt des
   * contacts), `rcs` pour `rcs_optout_at` (le STOP RCS). Ce n'est PAS le canal sur lequel la personne a parlé :
   * celui-là se déduit de la source au moment de pousser (`completerSignal`), et reste absent quand le refus
   * vient de la console ou de l'API.
   */
  z.object({ nom: z.literal('em_opted_out'), id, le, waId, canal }).strict(),
  z.object({ nom: z.literal('em_conversation_analyzed'), id, le, conversationId: z.string().uuid() }).strict(),
]);
export type Signal = z.infer<typeof schemaSignal>;

/** Un job : UN espace, de 1 à `SIGNAUX_PAR_JOB` signaux. */
export const schemaJobSignaux = z.object({
  tenantId: z.string().uuid(),
  signaux: z.array(schemaSignal).min(1).max(SIGNAUX_PAR_JOB),
}).strict();
export type JobSignaux = z.infer<typeof schemaJobSignaux>;

/** La fiche d'un signal, telle qu'un adaptateur la voit : identifiants et consentement COURANT. */
export interface ContactDuSignal {
  contactId: string;
  /** L'identifiant de l'outil du client (`contacts.external_id`). `null` = la fiche ne peut pas être poussée. */
  externalId: string | null;
  optOutWhatsapp: boolean;
  optOutRcs: boolean;
}

/** Une analyse de conversation. `null` sur une note veut dire « pas de mesure », jamais 0. */
export interface AnalyseDuSignal {
  intent: string;
  sentiment: string;
  satisfaction: number | null;
  urgence: number | null;
  resolved: boolean;
  topic: string;
  actionSuggestion: string;
  handledBy: string;
  exchangesCount: number;
  /** Présent en base, mais un adaptateur ne l'envoie que si l'espace a coché l'option, et en morceaux (`morceauxDuResume`). */
  summary: string | null;
}

export type ContenuSignal =
  | { nom: 'em_message_delivered' | 'em_message_read'; canal: CanalSignal; origine: string | null; sendId: string | null }
  | { nom: 'em_message_failed'; canal: CanalSignal; origine: string | null; sendId: string | null; motif: string | null; codeMeta: number | null }
  | { nom: 'em_replied'; canal: CanalSignal; bouton: string | null }
  | { nom: 'em_link_clicked'; lien: string; template: string | null; destination: string | null }
  /**
   * `canal` : le canal sur lequel la personne a DIT STOP, et SEULEMENT celui-là. Un refus posé par la console,
   * une action en masse ou l'API n'a pas de canal (`null`) : l'annoncer `whatsapp` ferait croire à l'intégrateur
   * que le contact a écrit STOP. `source` dit toujours d'où vient le refus (`opt_in_source`, ou `rcs_stop`).
   */
  | { nom: 'em_opted_out'; canal: CanalSignal | null; source: string | null }
  | { nom: 'em_conversation_analyzed'; analyse: AnalyseDuSignal };

/** Ce qu'un adaptateur reçoit : le signal émis, complété de ce que le chemin chaud ne savait pas. */
export interface SignalComplet {
  id: string;
  le: string;
  contact: ContactDuSignal;
  contenu: ContenuSignal;
}
```

- [ ] **Step 4 : le voir passer**

```bash
npx vitest run tests/signaux-types.test.ts && npm run typecheck
```

Attendu : vert.

- [ ] **Step 5 : commit (procédure P)**

Chemins : `src/signaux/types.ts tests/signaux-types.test.ts`. Message : `feat(signaux): le dictionnaire et ses noms de champs, independants de tout outil (lot 6)`.

---

### Task 3 : L'adaptateur Batch, traduction PURE et client HTTP (`src/signaux/batch.ts`)

**Files:**
- Create: `src/signaux/batch.ts`
- Create: `tests/signaux-batch.test.ts`
- Modify: `docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md` (§ 8, puce « **Le résumé** », ligne 500 à 502 ; et § 13, puce « **Adaptateur Batch** », ligne 649 à 652)

**Interfaces:**
- Consumes : `SignalComplet`, `ContenuSignal`, `NomEvenement`, `ChampEvenement`, `CHAMP_ID_EVENEMENT`, `MORCEAUX_RESUME`, `borneTexte`, `morceauxDuResume` (tâche 2) ; dans `src/meta/http.ts` : `HttpResponse` (ligne 1), `HttpTransport` (ligne 15), `parseRetryAfter` (ligne 145), `RetryOpts` (ligne 181), `withRetry` (ligne 202).
- Produces :
  - `FILE_SIGNAUX_BATCH = 'signaux-batch'`, `BATCH_URL_PROFILS`, `BATCH_MAX_PROFILS = 200`, `BATCH_MAX_EVENEMENTS = 15`, `BATCH_MAX_TEXTE = 300`
  - `type ValeurBatch`, `interface EvenementBatch { name; time; attributes }`, `interface ProfilBatch { identifiers: { custom_id }; attributes?; events? }`, `interface OptionsBatch { resume: boolean }`
  - `function versBatch(signaux: readonly SignalComplet[], options: OptionsBatch): { requetes: ProfilBatch[][]; sansIdentifiant: number }` (PURE)
  - `class BatchApiError extends Error { status; retryable; detail; retryAfterMs }` (son message ne nomme pas l'outil : il part dans le journal des erreurs), `interface ClesBatch { cleRest; cleProjet }`
  - `function pousserVersBatch(requete: ProfilBatch[], cles: ClesBatch, transport: HttpTransport, retry?: RetryOpts): Promise<{ partiel: string | null }>`

- [ ] **Step 1 : relire la page de l'API Profils** (`https://doc.batch.com/developer/api/cep/profiles/update.md`) et vérifier que l'adresse, les deux en-têtes, les bornes et les codes de la section « Faits de l'API Profils » sont toujours ceux de la page. 🔴 Vérifier EXPLICITEMENT la borne des attributs D'ÉVÉNEMENT, pas seulement celle des attributs de fiche : la section « Event attributes » renvoie aux attributs de fiche (« All types except for Array & Object behave as they do in profile attributes »), donc un texte d'événement fait lui aussi de 1 à 300 caractères. Si la page citait un jour une borne plus large pour les événements, `BATCH_MAX_TEXTE` resterait à 300 (le dictionnaire tient la plus stricte, `TEXTE_SIGNAL_MAX`), mais la phrase du commentaire de `BATCH_MAX_TEXTE` se corrigerait. Un écart se corrige dans les constantes ci-dessous ET dans ce plan.

- [ ] **Step 2 : écrire le test qui échoue**

`tests/signaux-batch.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import {
  versBatch, pousserVersBatch, BatchApiError, BATCH_URL_PROFILS, BATCH_MAX_PROFILS, BATCH_MAX_EVENEMENTS,
  BATCH_MAX_TEXTE, type ProfilBatch,
} from '../src/signaux/batch';
import {
  NOM_DICTIONNAIRE_RE, CHAMPS_EVENEMENT, CHAMP_ID_EVENEMENT, MORCEAUX_RESUME, TEXTE_SIGNAL_MAX,
  type AnalyseDuSignal, type ContenuSignal, type NomEvenement, type SignalComplet,
} from '../src/signaux/types';
import type { HttpResponse, HttpTransport } from '../src/meta/http';

const LE = '2026-09-24T10:00:00.000Z';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const S = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const ID = 'a'.repeat(32);

function signal(contenu: ContenuSignal, over: { externalId?: string | null; id?: string } = {}): SignalComplet {
  return {
    id: over.id ?? ID,
    le: LE,
    contact: { contactId: C, externalId: over.externalId === undefined ? 'crm-7781' : over.externalId, optOutWhatsapp: false, optOutRcs: false },
    contenu,
  };
}
const livre = (canal: 'whatsapp' | 'rcs' = 'whatsapp'): ContenuSignal => ({ nom: 'em_message_delivered', canal, origine: 'api', sendId: S });
const echecRcs: ContenuSignal = { nom: 'em_message_failed', canal: 'rcs', origine: null, sendId: null, motif: 'UNDELIVERABLE', codeMeta: null };
const analyse = (over: Partial<AnalyseDuSignal> = {}): ContenuSignal => ({
  nom: 'em_conversation_analyzed',
  analyse: {
    intent: 'sav', sentiment: 'positif', satisfaction: 8, urgence: 2, resolved: true, topic: 'livraison',
    actionSuggestion: 'aucune', handledBy: 'humain', exchangesCount: 6, summary: 'Le client demande où en est sa livraison.',
    ...over,
  },
});
function seul(r: ReturnType<typeof versBatch>): ProfilBatch {
  expect(r.requetes).toHaveLength(1);
  expect(r.requetes[0]).toHaveLength(1);
  return r.requetes[0]![0]!;
}

describe('versBatch : la traduction du dictionnaire (fonction PURE)', () => {
  it('un accusé de livraison devient un événement, et l’état courant de la fiche l’accompagne', () => {
    const p = seul(versBatch([signal(livre())], { resume: false }));
    expect(p.identifiers).toEqual({ custom_id: 'crm-7781' });
    expect(p.attributes).toEqual({ em_contact_id: C, em_whatsapp_optout: false, em_rcs_optout: false });
    expect(p.events).toEqual([
      { name: 'em_message_delivered', time: LE, attributes: { em_event_id: ID, canal: 'whatsapp', origine: 'api', send_id: S } },
    ]);
  });

  it('la joignabilité RCS suit la livraison dans les deux sens, et reste muette pour WhatsApp', () => {
    expect(seul(versBatch([signal(livre('rcs'))], { resume: false })).attributes?.em_rcs_reachable).toBe(true);
    expect(seul(versBatch([signal(echecRcs)], { resume: false })).attributes?.em_rcs_reachable).toBe(false);
    expect(seul(versBatch([signal(livre('whatsapp'))], { resume: false })).attributes).not.toHaveProperty('em_rcs_reachable');
  });

  it('une réponse date le dernier contact, et ne porte que le bouton', () => {
    const p = seul(versBatch([signal({ nom: 'em_replied', canal: 'whatsapp', bouton: 'Oui' })], { resume: false }));
    expect(p.attributes?.['date(em_last_reply_at)']).toBe(LE);
    expect(p.events?.[0]?.attributes).toEqual({ em_event_id: ID, canal: 'whatsapp', bouton: 'Oui' });
  });

  it('une valeur absente n’est pas envoyée : null ne s’écrit pas chez l’outil', () => {
    const p = seul(versBatch([signal({ nom: 'em_message_delivered', canal: 'whatsapp', origine: null, sendId: null })], { resume: false }));
    expect(p.events?.[0]?.attributes).toEqual({ em_event_id: ID, canal: 'whatsapp' });
  });

  it('🔴 un texte VIDE n’est pas envoyé non plus : l’outil le refuserait, seul et en silence (202 partiel)', () => {
    const clic = seul(versBatch([signal({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: '', destination: '   ' })], { resume: false }));
    expect(clic.events?.[0]?.attributes).toEqual({ em_event_id: ID, lien: 'ab12cd34ef56' });
    const desabo = seul(versBatch([signal({ nom: 'em_opted_out', canal: null, source: '' })], { resume: false }));
    expect(desabo.events?.[0]?.attributes).toEqual({ em_event_id: ID });
  });

  it('🔴 un désabonnement posé par la console n’a pas de canal : seule sa source part', () => {
    const p = seul(versBatch([signal({ nom: 'em_opted_out', canal: null, source: 'crm' })], { resume: false }));
    expect(p.events?.[0]?.attributes).toEqual({ em_event_id: ID, source: 'crm' });
  });

  it('une conversation analysée met à jour les attributs de la fiche et porte l’analyse dans l’événement', () => {
    const p = seul(versBatch([signal(analyse())], { resume: false }));
    expect(p.attributes).toMatchObject({ em_last_intent: 'sav', em_last_sentiment: 'positif', em_last_resolved: true, em_satisfaction: 8, em_urgency: 2 });
    expect(p.events?.[0]?.attributes).toMatchObject({
      intent: 'sav', sentiment: 'positif', satisfaction: 8, urgence: 2, resolved: true, topic: 'livraison',
      action_suggestion: 'aucune', handled_by: 'humain', exchanges_count: 6,
    });
  });

  it('🔴 une note ABSENTE n’écrase pas la précédente, une note à 0 est une vraie mesure', () => {
    const sans = seul(versBatch([signal(analyse({ satisfaction: null, urgence: null }))], { resume: false }));
    expect(sans.attributes).not.toHaveProperty('em_satisfaction');
    expect(sans.attributes).not.toHaveProperty('em_urgency');
    const zero = seul(versBatch([signal(analyse({ satisfaction: 0, urgence: 0 }))], { resume: false }));
    expect(zero.attributes).toMatchObject({ em_satisfaction: 0, em_urgency: 0 });
  });

  it('🔴 le résumé ne part QUE si l’option est cochée : il contient des propos du client', () => {
    const sans = seul(versBatch([signal(analyse())], { resume: false })).events?.[0]?.attributes ?? {};
    for (const m of MORCEAUX_RESUME) expect(sans, m).not.toHaveProperty(m);
    const avec = seul(versBatch([signal(analyse())], { resume: true })).events?.[0]?.attributes ?? {};
    expect(avec.summary_1).toBe('Le client demande où en est sa livraison.');
    expect(avec).not.toHaveProperty('summary_2');
  });

  it('🔴 un résumé LONG part ENTIER, en morceaux de 300 au plus, à recoller dans l’ordre', () => {
    const long = 'Le client relance pour sa commande 4521, livrée incomplète. '.repeat(20).slice(0, 800);
    const a = seul(versBatch([signal(analyse({ summary: long }))], { resume: true })).events?.[0]?.attributes ?? {};
    const morceaux = MORCEAUX_RESUME.map((m) => a[m]).filter((v): v is string => typeof v === 'string');
    expect(morceaux.join('')).toBe(long);
    for (const m of morceaux) expect(m.length).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
  });

  it('🔴 chaque événement porte EXACTEMENT les champs du dictionnaire, plus em_event_id', () => {
    const pleins: ContenuSignal[] = [
      { nom: 'em_message_delivered', canal: 'rcs', origine: 'campagne', sendId: S },
      { nom: 'em_message_read', canal: 'whatsapp', origine: 'api', sendId: S },
      { nom: 'em_message_failed', canal: 'whatsapp', origine: 'api', sendId: S, motif: '131026 Message undeliverable', codeMeta: 131026 },
      { nom: 'em_replied', canal: 'whatsapp', bouton: 'Oui' },
      { nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: 'promo', destination: 'https://client.fr/promo' },
      { nom: 'em_opted_out', canal: 'whatsapp', source: 'whatsapp_stop' },
      analyse({ summary: 'x'.repeat(700) }),
    ];
    expect(pleins.map((c) => c.nom).sort()).toEqual(Object.keys(CHAMPS_EVENEMENT).sort());
    for (const c of pleins) {
      const e = seul(versBatch([signal(c)], { resume: true })).events?.[0];
      const attendus = [CHAMP_ID_EVENEMENT, ...CHAMPS_EVENEMENT[c.nom as NomEvenement]].sort();
      expect(Object.keys(e?.attributes ?? {}).sort(), c.nom).toEqual(attendus);
    }
  });

  it('la borne du dictionnaire tient dans celle de l’outil', () => {
    expect(TEXTE_SIGNAL_MAX).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
  });

  it('🔴 une fiche SANS externalId n’est pas poussée, et elle est COMPTÉE', () => {
    const r = versBatch([signal(livre(), { externalId: null }), signal(livre(), { externalId: '  ' }), signal(livre())], { resume: false });
    expect(r.sansIdentifiant).toBe(2);
    expect(r.requetes.flat().map((p) => p.identifiers.custom_id)).toEqual(['crm-7781']);
  });

  it('deux signaux d’une même fiche : un profil, les événements dans l’ordre, le dernier état gagne', () => {
    const p = seul(versBatch([signal(livre('rcs'), { id: '1'.repeat(32) }), signal(echecRcs, { id: '2'.repeat(32) })], { resume: false }));
    expect(p.events?.map((e) => e.name)).toEqual(['em_message_delivered', 'em_message_failed']);
    expect(p.attributes?.em_rcs_reachable).toBe(false);
  });

  it(`🔴 jamais plus de ${BATCH_MAX_PROFILS} profils par appel`, () => {
    const signaux = Array.from({ length: 450 }, (_, i) => signal(livre(), { externalId: `crm-${i}` }));
    expect(versBatch(signaux, { resume: false }).requetes.map((r) => r.length)).toEqual([200, 200, 50]);
  });

  it(`🔴 jamais plus de ${BATCH_MAX_EVENEMENTS} événements par profil et par appel, jamais deux fois le même profil dans un appel`, () => {
    const signaux = Array.from({ length: 40 }, (_, i) => signal(livre(), { id: i.toString(16).padStart(32, '0') }));
    const { requetes } = versBatch(signaux, { resume: false });
    expect(requetes.map((r) => r.map((p) => p.events?.length ?? 0))).toEqual([[15], [15], [10]]);
    for (const r of requetes) {
      const ids = r.map((p) => p.identifiers.custom_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // L'état de la fiche part avec la DERNIÈRE tranche, celle que l'outil reçoit en dernier.
    expect(requetes.map((r) => r[0]!.attributes === undefined)).toEqual([true, true, false]);
  });

  it('🔴 aucun texte au-delà de 300 caractères ni vide, de fiche COMME d’événement, et toute clé tient la règle des noms', () => {
    // La borne vaut pour les attributs d'ÉVÉNEMENT aussi (page de l'API Profils, « Event attributes »). Un texte
    // trop long y serait rejeté seul, en 202 partiel : aucun test HTTP ne le verrait, la donnée disparaîtrait.
    const long = 'x'.repeat(2000);
    const signaux = [
      signal({ nom: 'em_message_failed', canal: 'whatsapp', origine: long, sendId: S, motif: long, codeMeta: 131026 }, { externalId: 'a' }),
      signal({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: long, destination: long }, { externalId: 'b' }),
      signal(analyse({ topic: long, summary: long }), { externalId: 'c' }),
    ];
    const cle = /^([a-z0-9_]{1,30}|date\([a-z0-9_]{1,30}\))$/;
    for (const p of versBatch(signaux, { resume: true }).requetes.flat()) {
      for (const [k, v] of Object.entries(p.attributes ?? {})) {
        expect(k).toMatch(cle);
        if (typeof v === 'string') {
          expect(v.length, k).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
          expect(v.trim(), k).not.toBe('');
        }
      }
      for (const e of p.events ?? []) {
        expect(e.name).toMatch(NOM_DICTIONNAIRE_RE);
        for (const [k, v] of Object.entries(e.attributes)) {
          expect(k).toMatch(cle);
          if (typeof v === 'string') {
            expect(v.length, k).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
            expect(v.trim(), k).not.toBe('');
          }
        }
      }
    }
  });
});

class FauxTransport implements HttpTransport {
  readonly appels: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly reponses: Array<HttpResponse | Error>) {}
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.appels.push({ url, body, headers });
    const r = this.reponses.shift();
    if (r === undefined) throw new Error('faux transport : plus de réponse prévue');
    if (r instanceof Error) throw r;
    return r;
  }
}
const CLES = { cleRest: 'cle-rest-test', cleProjet: 'projet-test' };
const REQUETE: ProfilBatch[] = [{ identifiers: { custom_id: 'crm-7781' }, attributes: { em_contact_id: C } }];
const vite = { sleep: async (): Promise<void> => {} };

describe('pousserVersBatch : le client HTTP', () => {
  it('pose l’adresse, les deux en-têtes et le corps', async () => {
    const t = new FauxTransport([{ status: 202, json: { code: 'SUCCESS' } }]);
    expect(await pousserVersBatch(REQUETE, CLES, t, vite)).toEqual({ partiel: null });
    expect(t.appels).toEqual([{
      url: BATCH_URL_PROFILS, body: REQUETE,
      headers: { authorization: 'Bearer cle-rest-test', 'x-batch-project': 'projet-test' },
    }]);
  });

  it('un succès PARTIEL est rendu, pas avalé', async () => {
    const t = new FauxTransport([{ status: 202, json: {
      code: 'SUCCESS_WITH_PARTIAL_ERRORS',
      errors: [{ category: 'attribute', bulk_index: 0, attribute: 'em_last_intent', reason: 'invalid value' }],
    } }]);
    expect(await pousserVersBatch(REQUETE, CLES, t, vite)).toEqual({ partiel: 'em_last_intent : invalid value' });
  });

  it('🔴 429 et 5xx sont rejoués', async () => {
    const t = new FauxTransport([
      { status: 429, json: { error_code: 'TOO_MANY_REQUESTS' }, headers: { 'retry-after': '1' } },
      { status: 503, json: null },
      { status: 202, json: { code: 'SUCCESS' } },
    ]);
    expect(await pousserVersBatch(REQUETE, CLES, t, vite)).toEqual({ partiel: null });
    expect(t.appels).toHaveLength(3);
  });

  it('🔴 une panne réseau est rejouée', async () => {
    const t = new FauxTransport([new TypeError('fetch failed'), { status: 202, json: { code: 'SUCCESS' } }]);
    await pousserVersBatch(REQUETE, CLES, t, vite);
    expect(t.appels).toHaveLength(2);
  });

  it('🔴 un 4xx est TERMINAL : un seul appel, une erreur non rejouable qui porte le message de l’outil', async () => {
    const t = new FauxTransport([{ status: 400, json: { error_code: 'MALFORMED_PARAMETER', error_message: 'custom_id too long' } }]);
    const err = await pousserVersBatch(REQUETE, CLES, t, vite).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchApiError);
    expect(err).toMatchObject({ status: 400, retryable: false, detail: 'custom_id too long' });
    expect(t.appels).toHaveLength(1);
    // 🔴 Ce message part dans Sécurité > Journal des erreurs : il ne nomme pas l'outil (spec § 10).
    expect((err as Error).message).not.toMatch(/batch/i);
  });

  it('les nouveaux essais sont bornés, puis l’erreur remonte REJOUABLE (pour la file)', async () => {
    const t = new FauxTransport([{ status: 500, json: null }, { status: 500, json: null }]);
    const err = await pousserVersBatch(REQUETE, CLES, t, { ...vite, maxRetries: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, retryable: true });
    expect(t.appels).toHaveLength(2);
  });
});
```

- [ ] **Step 3 : le voir échouer**

```bash
npx vitest run tests/signaux-batch.test.ts
```

Attendu : ÉCHEC à l'import (`Failed to load url ../src/signaux/batch`).

- [ ] **Step 4 : écrire l'adaptateur**

`src/signaux/batch.ts` :

```ts
import { z } from 'zod';
import { parseRetryAfter, withRetry, type HttpTransport, type RetryOpts } from '../meta/http';
import {
  CHAMP_ID_EVENEMENT, MORCEAUX_RESUME, borneTexte, morceauxDuResume,
  type ChampEvenement, type ContenuSignal, type NomEvenement, type SignalComplet,
} from './types';

/**
 * L'ADAPTATEUR BATCH (spec 2026-09-24, § 8) : le dictionnaire des signaux traduit pour l'API Profils de Batch.
 *
 * 🔴 C'EST LE SEUL FICHIER (avec son travail de file et son réglage) OÙ BATCH EXISTE. Le dictionnaire
 * (`types.ts`) et l'émetteur ne le nomment pas : un second outil se branche par un second adaptateur, sans
 * toucher au dictionnaire. Et cet adaptateur ne CHOISIT aucun nom : les noms d'événements, d'attributs et de
 * champs sont ceux du dictionnaire (`CHAMPS_EVENEMENT`), la documentation publique les promet identiques pour
 * tous les outils.
 *
 * Batch est un HÔTE FIXE, pas une adresse saisie par un client : la garde d'adresse publique ne s'applique pas,
 * comme pour les clients de Meta et du fournisseur RCS.
 */

/** La file pg-boss de cet adaptateur (déclarée dans `BASE_QUEUES`). */
export const FILE_SIGNAUX_BATCH = 'signaux-batch';

/** Relue sur la page de l'API Profils le 2026-09-24. La version vit ICI et nulle part ailleurs. */
export const BATCH_URL_PROFILS = 'https://api.batch.com/2.13/profiles/update';
export const BATCH_MAX_PROFILS = 200;
export const BATCH_MAX_EVENEMENTS = 15;
/**
 * Un attribut texte chez Batch fait de 1 à 300 caractères, de FICHE COMME D'ÉVÉNEMENT : la page le dit des
 * attributs de fiche (« cannot be empty or over 300 characters ») et renvoie à eux pour ceux d'un événement
 * (« All types except for Array & Object behave as they do in profile attributes »), relue le 2026-09-24.
 * Un texte vide ou plus long y est rejeté SEUL, en 202 `SUCCESS_WITH_PARTIAL_ERRORS` : la poussée « réussit »
 * et la donnée disparaît. D'où le résumé en morceaux (`morceauxDuResume`), et `propre`, qui écarte le vide.
 */
export const BATCH_MAX_TEXTE = 300;

export type ValeurBatch = string | number | boolean;
export interface EvenementBatch {
  name: string;
  time: string;
  attributes: Record<string, ValeurBatch>;
}
export interface ProfilBatch {
  identifiers: { custom_id: string };
  attributes?: Record<string, ValeurBatch>;
  events?: EvenementBatch[];
}
export interface OptionsBatch {
  /** L'espace a coché « Envoyer le résumé des conversations ». */
  resume: boolean;
}

type Brut = Record<string, ValeurBatch | null | undefined>;
/** Les champs d'un événement, NOMMÉS par le dictionnaire : un nom qui n'y figure pas ne compile pas (`satisfies`). */
type Champs<N extends NomEvenement> = Partial<Record<ChampEvenement<N>, ValeurBatch | null>>;

const borne = (v: string): string => borneTexte(v, BATCH_MAX_TEXTE);

/**
 * Retire ce qui ne s'écrit pas chez l'outil et borne les textes.
 *
 * 🔴 L'ABSENCE (`null`) ET LE TEXTE VIDE sont écartés tous les deux. Une absence ne s'écrit pas ; un texte vide
 * (un `topic` vide, une origine `''`) serait refusé par Batch attribut par attribut, et chaque signal ajouterait
 * une ligne « succès partiel » au journal des erreurs pour rien.
 */
function propre(o: Brut): Record<string, ValeurBatch> {
  const out: Record<string, ValeurBatch> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      if (v.trim() === '') continue;
      out[k] = borne(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * L'état courant de la fiche, envoyé avec CHAQUE événement.
 *
 * ⚠️ `em_contact_id` part à chaque poussée, pas seulement à la première : réécrire la même valeur ne coûte
 * rien chez l'outil, et se souvenir de « déjà envoyé » demanderait un état de plus qui peut mentir.
 */
function attributsDeFiche(s: SignalComplet): Record<string, ValeurBatch> {
  const c = s.contenu;
  const a: Brut = {
    em_contact_id: s.contact.contactId,
    em_whatsapp_optout: s.contact.optOutWhatsapp,
    em_rcs_optout: s.contact.optOutRcs,
  };
  if (c.nom === 'em_replied') a['date(em_last_reply_at)'] = s.le;
  if ((c.nom === 'em_message_delivered' || c.nom === 'em_message_read') && c.canal === 'rcs') a.em_rcs_reachable = true;
  if (c.nom === 'em_message_failed' && c.canal === 'rcs') a.em_rcs_reachable = false;
  if (c.nom === 'em_conversation_analyzed') {
    a.em_last_intent = c.analyse.intent;
    a.em_last_sentiment = c.analyse.sentiment;
    a.em_last_resolved = c.analyse.resolved;
    // 🔴 `null` n'est pas 0 : une analyse sans note ne l'écrase pas (`propre` retire la clé).
    a.em_satisfaction = c.analyse.satisfaction;
    a.em_urgency = c.analyse.urgence;
  }
  return propre(a);
}

/**
 * Les champs d'un événement, sous les noms du DICTIONNAIRE. Chaque branche `satisfies` le type de son événement :
 * un champ renommé ou inventé ici ne compile pas, et `tests/signaux-batch.test.ts` vérifie qu'il n'en MANQUE
 * aucun (les morceaux du résumé s'ajoutent dans `evenement`, seulement si l'option est cochée).
 */
function attributsDEvenement(c: ContenuSignal): Brut {
  switch (c.nom) {
    case 'em_message_delivered':
      return { canal: c.canal, origine: c.origine, send_id: c.sendId } satisfies Champs<'em_message_delivered'>;
    case 'em_message_read':
      return { canal: c.canal, origine: c.origine, send_id: c.sendId } satisfies Champs<'em_message_read'>;
    case 'em_message_failed':
      return { canal: c.canal, origine: c.origine, send_id: c.sendId, motif: c.motif, code_meta: c.codeMeta } satisfies Champs<'em_message_failed'>;
    case 'em_replied':
      return { canal: c.canal, bouton: c.bouton } satisfies Champs<'em_replied'>;
    case 'em_link_clicked':
      return { lien: c.lien, template: c.template, destination: c.destination } satisfies Champs<'em_link_clicked'>;
    case 'em_opted_out':
      return { canal: c.canal, source: c.source } satisfies Champs<'em_opted_out'>;
    case 'em_conversation_analyzed':
      return {
        intent: c.analyse.intent,
        sentiment: c.analyse.sentiment,
        satisfaction: c.analyse.satisfaction,
        urgence: c.analyse.urgence,
        resolved: c.analyse.resolved,
        topic: c.analyse.topic,
        action_suggestion: c.analyse.actionSuggestion,
        handled_by: c.analyse.handledBy,
        exchanges_count: c.analyse.exchangesCount,
      } satisfies Champs<'em_conversation_analyzed'>;
  }
}

function evenement(s: SignalComplet, o: OptionsBatch): EvenementBatch {
  const c = s.contenu;
  const brut: Brut = { [CHAMP_ID_EVENEMENT]: s.id, ...attributsDEvenement(c) };
  // 🔴 LE RÉSUMÉ CONTIENT DES PROPOS DU CLIENT : il ne part que si l'espace l'a demandé. Et il part en MORCEAUX
  // de 300 caractères au plus (`summary_1` à `summary_3`) : un texte d'événement plafonne à 300 chez Batch, le
  // résumé en fait jusqu'à 800, et un texte trop long serait refusé seul, sans que la poussée échoue.
  if (c.nom === 'em_conversation_analyzed' && o.resume && c.analyse.summary) {
    morceauxDuResume(c.analyse.summary).forEach((m, i) => {
      const cle = MORCEAUX_RESUME[i];
      if (cle !== undefined) brut[cle] = m;
    });
  }
  return { name: c.nom, time: s.le, attributes: propre(brut) };
}

/**
 * Traduit des signaux complets en corps d'appels à `POST /profiles/update`. PURE : aucune lecture, aucune date.
 *
 * - Une fiche sans `externalId` n'est PAS poussée : elle est comptée (`sansIdentifiant`), et l'écran du réglage
 *   montre ce compte.
 * - Une même fiche = un profil par appel ; ses événements restent dans l'ordre ; son état est celui du DERNIER
 *   signal.
 * - Bornes de Batch : `BATCH_MAX_PROFILS` profils par appel, `BATCH_MAX_EVENEMENTS` événements par profil et par
 *   appel. Au-delà, la fiche repasse dans l'appel SUIVANT (jamais deux fois dans le même), et son état part avec
 *   sa dernière tranche.
 */
export function versBatch(signaux: readonly SignalComplet[], options: OptionsBatch): { requetes: ProfilBatch[][]; sansIdentifiant: number } {
  let sansIdentifiant = 0;
  const parProfil = new Map<string, { attributes: Record<string, ValeurBatch>; events: EvenementBatch[] }>();
  for (const s of signaux) {
    const customId = s.contact.externalId?.trim() ?? '';
    if (customId === '') {
      sansIdentifiant += 1;
      continue;
    }
    const p = parProfil.get(customId) ?? { attributes: {}, events: [] };
    Object.assign(p.attributes, attributsDeFiche(s));
    p.events.push(evenement(s, options));
    parProfil.set(customId, p);
  }

  const requetes: ProfilBatch[][] = [];
  for (const [customId, p] of parProfil) {
    const tranches: EvenementBatch[][] = [];
    for (let i = 0; i < p.events.length; i += BATCH_MAX_EVENEMENTS) tranches.push(p.events.slice(i, i + BATCH_MAX_EVENEMENTS));
    let depart = 0;
    tranches.forEach((events, i) => {
      let r = depart;
      while ((requetes[r]?.length ?? 0) >= BATCH_MAX_PROFILS) r += 1;
      const derniere = i === tranches.length - 1;
      (requetes[r] ??= []).push({ identifiers: { custom_id: customId }, ...(derniere ? { attributes: p.attributes } : {}), events });
      depart = r + 1;
    });
  }
  return { requetes, sansIdentifiant };
}

/**
 * Une réponse de Batch en erreur. `retryable` (429, 5xx) : `withRetry` rejoue, puis la file. Sinon terminal.
 *
 * ⚠️ Son MESSAGE part dans Sécurité > Journal des erreurs (`erreur` de la ligne) : il ne nomme pas l'outil, pour
 * la même raison que `NOM_APPEL_SIGNAUX` (spec § 10). Le nom de la classe, lui, ne sort pas du code.
 */
export class BatchApiError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(readonly status: number, readonly retryable: boolean, readonly detail: string | null, retryAfterMs?: number) {
    super(`l’outil branché a répondu ${status}${detail ? ` : ${detail}` : ''}`);
    this.name = 'BatchApiError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ClesBatch {
  cleRest: string;
  cleProjet: string;
}

/** La réponse de Batch, lue comme une entrée externe : `safeParse`, jamais `as`. */
const reponseBatch = z.object({
  code: z.string().optional(),
  errors: z.array(z.object({ attribute: z.string().optional(), reason: z.string().optional() }).passthrough()).optional(),
  error_message: z.string().optional(),
}).passthrough();

/**
 * Pousse UN appel. Rejoue sur 429, 5xx et panne réseau (backoff borné de `withRetry`) ; un 4xx est terminal.
 * Un succès partiel (202 `SUCCESS_WITH_PARTIAL_ERRORS`) n'est pas une erreur, mais il est RENDU : l'appelant
 * l'écrit dans le journal, sans quoi un attribut refusé disparaîtrait en silence.
 */
export async function pousserVersBatch(
  requete: ProfilBatch[],
  cles: ClesBatch,
  transport: HttpTransport,
  retry: RetryOpts = {},
): Promise<{ partiel: string | null }> {
  return withRetry(async () => {
    const res = await transport.post(BATCH_URL_PROFILS, requete, {
      authorization: `Bearer ${cles.cleRest}`,
      'x-batch-project': cles.cleProjet,
    });
    const lu = reponseBatch.safeParse(res.json);
    const corps = lu.success ? lu.data : null;
    if (res.status >= 200 && res.status < 300) {
      if (corps?.code !== 'SUCCESS_WITH_PARTIAL_ERRORS') return { partiel: null };
      const e = corps.errors?.[0];
      const raison = [e?.attribute, e?.reason].filter((x): x is string => typeof x === 'string' && x !== '').join(' : ');
      return { partiel: borne(raison === '' ? 'erreurs partielles' : raison) };
    }
    const retryable = res.status === 429 || res.status >= 500;
    throw new BatchApiError(
      res.status,
      retryable,
      corps?.error_message ? borne(corps.error_message) : null,
      retryable ? parseRetryAfter(res.headers) : undefined,
    );
  }, retry);
}
```

- [ ] **Step 5 : le voir passer**

```bash
npx vitest run tests/signaux-batch.test.ts tests/signaux-types.test.ts && npm run typecheck
```

Attendu : vert.

- [ ] **Step 6 : corriger la spec, qui affirmait le contraire de la page**

Dans `docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md`, § 8, la puce qui commence par « **Le résumé** ne peut pas être un attribut » devient :

```markdown
- **Le résumé** ne tient pas en un seul champ : un texte plafonne à 300 caractères chez Batch, pour un
  attribut de fiche COMME pour un attribut d'événement (la page renvoie des seconds aux premiers, relue le
  2026-09-24), et le résumé en fait jusqu'à 800. Il voyage donc dans l'événement, en morceaux consécutifs de
  300 caractères au plus (`summary_1` à `summary_3`, à recoller bout à bout), et seulement si l'espace a
  activé l'option, parce qu'il contient des propos du client. Les noms de ces morceaux, comme ceux de tous
  les champs, sont fixés par le dictionnaire, pas par l'adaptateur.
```

puis, dans le même § 8, juste après la puce qui commence par « **« À la fin d'une conversation »** veut dire », ajouter :

```markdown
- **« Immédiat »** veut dire : enfilé sur le fait, sans attendre de balayage, puis poussé par la file de
  l'adaptateur, un job à la fois par espace. Les réponses, clics, désabonnements et analyses y passent DEVANT
  les accusés (priorité de file) ; derrière une campagne de plusieurs milliers de destinataires, les accusés
  de livraison et de lecture peuvent donc arriver avec plusieurs dizaines de minutes de retard. La doc le dit.
```

et, au § 13, dans la puce « **Adaptateur Batch** », le passage « aucun attribut texte ne dépasse 300 caractères ; le résumé n'apparaît que si l'option est cochée » (il court sur les lignes 650 et 651, coupé après le premier point-virgule) devient « aucun texte, de fiche ou d'événement, ne dépasse 300 caractères ni n'est vide ; le résumé n'apparaît que si l'option est cochée, et il arrive entier, en morceaux ».

- [ ] **Step 7 : commit (procédure P)**

Chemins : `src/signaux/batch.ts tests/signaux-batch.test.ts docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md`. Message : `feat(signaux): adaptateur Batch, traduction pure, textes bornes a 300 partout, resume en morceaux (lot 6)`.

---

### Task 4 : Les points d'accroche des webhooks Meta (accusés et entrants)

**Files:**
- Modify: `src/webhooks/delivery.ts` (après `extractDelivery`, ligne 25 à 49 ; `PuitsAccuses` ligne 84 à 88 ; déstructuration ligne 109 ; après le bloc `if (nodeEvents && d.status !== 'sent')`, ligne 152 à 159)
- Modify: `src/webhooks/inbound.ts` (types avant `processInbound`, ligne 306 ; signature de `processInbound`, ligne 308 à 323 ; appel après `await store.recordInbound(tenantId, m);` ligne 347)
- Modify: `src/webhooks/handler.ts` (`WebhookJobDepsCommunes` ligne 52 ; déstructuration ligne 114 à 118 ; appels ligne 129 et 146)
- Modify: `tests/crm-consentement.test.ts` (les appels de `processInbound` à plus de deux arguments, ligne 75 à 163)
- Create: `tests/signaux-webhooks.test.ts`

**Interfaces:**
- Produces :
  - `interface AccuseDuStatut { messageId: string; status: DeliveryStatus; waId: string | null; motif: string | null; codeMeta: number | null; le: string | null }`
  - `type SignalAccuse = (phoneNumberId: string, accuse: AccuseDuStatut) => Promise<void>`
  - `function destinataireDuStatut(data: unknown): string | null`, `function instantDuStatut(data: unknown): string | null`
  - `PuitsAccuses.signaux?: SignalAccuse`
  - `type SignalReponse = (tenantId: string, m: InboundMessage) => Promise<void>`
  - `interface DepsEntrants { upsertContact?: InboundContactUpsert; optOut?: InboundOptOut; assignation?: InboundAssignation; signalReponse?: SignalReponse }` ; `processInbound(payload: unknown, store: InboxStore, deps?: DepsEntrants): Promise<void>` (défaut `{}`).
  - `WebhookJobDeps.signauxAccuse?` et `WebhookJobDeps.signalReponse?` : OPTIONNELS dans cette tâche, rendus REQUIS avec leur câblage en tâche 10 (sinon le worker ne compile plus entre les deux).

🔴 **POURQUOI UN OBJET, ET PAS UN SIXIÈME PARAMÈTRE POSITIONNEL.** `processInbound` prenait déjà trois dépendances optionnelles à la queue (`upsertContact`, `optOut`, `assignation`), de types voisins. Un quatrième au rang six, c'est exactement le motif que `handleWebhookJob` (commentaire de `WebhookJobDepsCommunes`, lot 3 du programme II : « Insérer un paramètre au mauvais rang y changeait le câblage en silence ») et `processStatuses` (`PuitsAccuses`, revue finale du 2026-09-23 : « NOMMÉS et jamais positionnels ») ont retiré : un rang inversé passe le compilateur, et le test devait écrire `undefined, undefined, undefined`. Les appels à deux arguments (`tests/detenteur-du-fil.test.ts`, `tests/inbound.test.ts`) ne changent pas ; ceux qui en passent davantage (le handler et `tests/crm-consentement.test.ts`) nomment désormais ce qu'ils passent.

- [ ] **Step 1 : écrire le test qui échoue**

`tests/signaux-webhooks.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { handleWebhookJob } from '../src/webhooks/handler';
import { destinataireDuStatut, instantDuStatut, type AccuseDuStatut } from '../src/webhooks/delivery';
import { processInbound, type InboundMessage } from '../src/webhooks/inbound';
import { aucunTarif, aucunEchecLibre, aucuneArriveePub, aucunRoutagePub } from './webhook-fixtures';

/**
 * LES POINTS D'ACCROCHE DES SIGNAUX sur les webhooks Meta (spec 2026-09-24, § 8). Ce test ne dit rien du coût
 * (c'est le puits qui décide de ne rien lire, `tests/signaux-emetteur.test.ts`) : il dit que CHAQUE accusé et
 * CHAQUE entrant arrive au puits, et qu'un puits en panne ne fait rien échouer.
 */
const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const statuts = (...s: Array<Record<string, unknown>>) => ({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: s } }] }],
});
const entrant = (type: string, extra: Record<string, unknown>) => ({
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'PN1' },
    contacts: [{ wa_id: '33612345678' }],
    messages: [{ id: 'wamid.in1', from: '33612345678', type, timestamp: '1790000000', ...extra }],
  } }] }],
});
const store = { insertEvent: async () => true };
const delivery = { updateDeliveryByMessageId: async () => 1 };

describe('les accusés Meta passent au puits des signaux', () => {
  it('🔴 chaque accusé, avec son numéro, son destinataire, son motif et son instant', async () => {
    const vus: Array<{ pn: string; a: AccuseDuStatut }> = [];
    await handleWebhookJob(statuts(
      { id: 'wamid.1', status: 'delivered', recipient_id: '33612345678', timestamp: '1790000000' },
      { id: 'wamid.2', status: 'failed', recipient_id: '33612345678', errors: [{ code: 131026, title: 'Message undeliverable' }] },
    ), { store, delivery, tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre, signauxAccuse: async (pn, a) => { vus.push({ pn, a }); } });
    expect(vus).toEqual([
      { pn: 'PN1', a: { messageId: 'wamid.1', status: 'delivered', waId: '33612345678', motif: null, codeMeta: null, le: new Date(1790000000 * 1000).toISOString() } },
      { pn: 'PN1', a: { messageId: 'wamid.2', status: 'failed', waId: '33612345678', motif: '131026 Message undeliverable', codeMeta: 131026, le: null } },
    ]);
  });

  it('🔴 un puits en panne ne fait pas échouer la livraison, qui est la donnée métier', async () => {
    const maj: string[] = [];
    await expect(handleWebhookJob(statuts({ id: 'wamid.3', status: 'read', recipient_id: '336' }), {
      store,
      delivery: { updateDeliveryByMessageId: async (id) => { maj.push(id); return 1; } },
      tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre,
      signauxAccuse: async () => { throw new Error('file indisponible'); },
    })).resolves.toBeUndefined();
    expect(maj).toEqual(['wamid.3']);
  });

  it('un accusé sans numéro Meta (aucun rattachement à un espace) ne va pas au puits', async () => {
    const vus: string[] = [];
    await handleWebhookJob({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.4', status: 'read' }] } }] }] }, {
      store, delivery, tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre, signauxAccuse: async (_pn, a) => { vus.push(a.messageId); },
    });
    expect(vus).toEqual([]);
  });

  it('les deux lecteurs du statut ne lèvent jamais', () => {
    expect(destinataireDuStatut({ recipient_id: '336' })).toBe('336');
    expect(destinataireDuStatut({ recipient_id: '' })).toBeNull();
    expect(destinataireDuStatut(null)).toBeNull();
    expect(instantDuStatut({ timestamp: '1790000000' })).toBe(new Date(1790000000 * 1000).toISOString());
    expect(instantDuStatut({ timestamp: 'demain' })).toBeNull();
    expect(instantDuStatut('x')).toBeNull();
  });
});

describe('les entrants Meta passent au puits des signaux', () => {
  const inbox = { phoneNumberTenant: async () => T, recordInbound: async () => {} };

  it('🔴 la réponse passe au puits APRÈS son enregistrement, avec son espace', async () => {
    const ordre: string[] = [];
    await processInbound(
      entrant('text', { text: { body: 'bonjour' } }),
      { phoneNumberTenant: async () => T, recordInbound: async () => { ordre.push('enregistre'); } },
      { signalReponse: async (t, m: InboundMessage) => { ordre.push(`signal:${t}:${m.messageId}`); } },
    );
    expect(ordre).toEqual(['enregistre', `signal:${T}:wamid.in1`]);
  });

  it('🔴 un puits en panne ne fait pas échouer la réception', async () => {
    let enregistres = 0;
    await expect(processInbound(
      entrant('text', { text: { body: 'bonjour' } }),
      { phoneNumberTenant: async () => T, recordInbound: async () => { enregistres += 1; } },
      { signalReponse: async () => { throw new Error('file indisponible'); } },
    )).resolves.toBeUndefined();
    expect(enregistres).toBe(1);
  });

  it('🔴 l’ÉCHO de l’agent de Meta (`message_echoes`) n’arrive PAS au puits : ce n’est pas une réponse du contact', async () => {
    // Forme RÉELLE, reprise de `tests/webhooks-change.test.ts` (STANDBY_ECHO) : l'écho vit sous
    // `standby.message_echoes`, que seul `processHandovers` lit. `extractInbound` ne lit que `messages`.
    const vus: string[] = [];
    await processInbound({ entry: [{ changes: [{ field: 'standby', value: {
      metadata: { phone_number_id: 'PN1' },
      standby: { message_echoes: [{ id: 'wamid.echo', message: { to: '33612345678', type: 'text', text: { body: 'Réponse de l’agent' } }, timestamp: '1790000000' }] },
    } }] }] }, inbox, { signalReponse: async (_t, m) => { vus.push(m.messageId); } });
    expect(vus).toEqual([]);
  });

  it('un message du CLIENT en `standby` (l’agent de Meta tient le fil) arrive au puits : il a bien répondu', async () => {
    // Forme RÉELLE (STANDBY_ENTRANT, essais de Julien du 2026-09-16) : le texte du client, avec son `from`.
    const vus: string[] = [];
    await processInbound({ entry: [{ changes: [{ field: 'standby', value: {
      metadata: { phone_number_id: 'PN1' },
      standby: {
        contacts: [{ wa_id: '33612345678' }],
        messages: [{ id: 'wamid.sb', from: '33612345678', type: 'text', text: { body: 'je veux un conseiller' }, timestamp: '1790000000' }],
      },
    } }] }] }, inbox, { signalReponse: async (_t, m) => { vus.push(`${m.field}:${m.messageId}`); } });
    expect(vus).toEqual(['standby:wamid.sb']);
  });

  it('le handler transmet le puits à la réception', async () => {
    const vus: string[] = [];
    await handleWebhookJob(entrant('button', { button: { text: 'Oui', payload: 'Oui' } }), {
      store,
      inbox: { phoneNumberTenant: async () => T, recordInbound: async () => {} },
      arriveesPub: aucuneArriveePub,
      routagePub: aucunRoutagePub,
      signalReponse: async (_t, m) => { vus.push(`${m.type}:${m.body}`); },
    });
    expect(vus).toEqual(['button:Oui']);
  });
});
```

- [ ] **Step 2 : le voir échouer**

```bash
npx vitest run tests/signaux-webhooks.test.ts
```

Attendu : ÉCHEC, `destinataireDuStatut is not a function` et le puits jamais appelé (`expected [] to deeply equal [...]`). Le cas de l'écho est déjà VERT (c'est `extractInbound` qui tient cette propriété, ce test la fige) ; tous les autres sont rouges.

- [ ] **Step 3 : écrire les points d'accroche**

Dans `src/webhooks/delivery.ts`, ajouter l'import en tête :

```ts
import { asRecord } from './json';
```

Ajouter après la fonction `extractDelivery` :

```ts
/**
 * Ce que la remontée des SIGNAUX reçoit d'un accusé (spec 2026-09-24, § 8).
 *
 * 🔴 BEST-EFFORT, ET GRATUIT PAR DÉFAUT : ce chemin traite chaque accusé de chaque message de la plateforme. Le
 * puits décide lui-même de ne rien lire (statut `sent`, aucun espace branché) ; il ne doit jamais faire échouer
 * le traitement d'une livraison, qui est la donnée métier.
 */
export interface AccuseDuStatut {
  messageId: string;
  status: DeliveryStatus;
  /** Le destinataire tel que Meta le nomme (`recipient_id`) : numéro en chiffres nus, ou BSUID. */
  waId: string | null;
  motif: string | null;
  codeMeta: number | null;
  /** L'instant que Meta a daté (`timestamp`), en ISO ; `null` s'il manque. La file des accusés peut avoir du retard. */
  le: string | null;
}
export type SignalAccuse = (phoneNumberId: string, accuse: AccuseDuStatut) => Promise<void>;

/** Le destinataire d'un statut Meta, ou `null`. Ne lève jamais. */
export function destinataireDuStatut(data: unknown): string | null {
  const r = asRecord(data)['recipient_id'];
  return typeof r === 'string' && r.trim() !== '' ? r : null;
}

/** L'instant d'un statut Meta (secondes Unix), en ISO, ou `null`. Ne lève jamais. */
export function instantDuStatut(data: unknown): string | null {
  const brut = asRecord(data)['timestamp'];
  const secondes = typeof brut === 'string' || typeof brut === 'number' ? Number(brut) : Number.NaN;
  return Number.isFinite(secondes) && secondes > 0 ? new Date(secondes * 1000).toISOString() : null;
}
```

`PuitsAccuses` porte, depuis le lot 3 (sa tâche 5), le puits REQUIS `echecsLibres: EchecsLibresSink` (avec son commentaire) juste après `tarifs`. Il le GARDE tel quel, et devient :

```ts
export interface PuitsAccuses {
  tarifs: TarifsMetaSink;
  /* …le commentaire du lot 3, inchangé… */
  echecsLibres: EchecsLibresSink;
  nodeEvents?: NodeStatusSink;
  remiseMba?: RemiseMbaSurAccuse;
  /** Les signaux (spec 2026-09-24, § 8). Requis au niveau du handler, qui est le seul appelant de production. */
  signaux?: SignalAccuse;
}
```

Dans `processStatuses`, la ligne `const { tarifs, echecsLibres, nodeEvents, remiseMba } = puits;` (écrite par le lot 3) devient :

```ts
  const { tarifs, echecsLibres, nodeEvents, remiseMba, signaux } = puits;
```

et, juste après le bloc `if (nodeEvents && d.status !== 'sent') { ... }` (ancre : « mesure de bloc (statut) ignorée »), en fin de corps de boucle, APRÈS tout ce que le lot 3 y a ajouté :

```ts
    // 🔴 LES SIGNAUX (spec 2026-09-24, § 8), EN DERNIER ET ISOLÉS : ils ne décident de rien pour la livraison,
    // et le puits se charge de ne rien lire quand personne n'écoute.
    if (signaux && ev.phoneNumberId) {
      try {
        await signaux(ev.phoneNumberId, {
          messageId: d.messageId,
          status: d.status,
          waId: destinataireDuStatut(ev.data),
          motif: d.error,
          codeMeta: d.errorCode,
          le: instantDuStatut(ev.data),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('signal d’accusé ignoré:', err instanceof Error ? err.message : err);
      }
    }
```

Dans `src/webhooks/inbound.ts`, juste après la ligne `export type InboundAssignation = (tenantId: string, waId: string) => Promise<unknown>;` (ligne 306) :

```ts

/**
 * Remonte une RÉPONSE comme signal (spec 2026-09-24, § 8). Reçoit le message ENTIER, et c'est au puits de n'en
 * garder que ce que le dictionnaire autorise : jamais le texte, seulement le bouton tapé.
 */
export type SignalReponse = (tenantId: string, m: InboundMessage) => Promise<void>;

/**
 * Les dépendances SECONDAIRES de `processInbound`, NOMMÉES (lot 6 de l'API publique, 2026-09-24).
 *
 * 🔴 UN OBJET, PLUS UNE QUEUE DE PARAMÈTRES OPTIONNELS. Le quatrième s'ajoutait au rang six, derrière trois
 * optionnels de types voisins : un rang inversé y passe le compilateur en silence. Même leçon que
 * `WebhookJobDeps` (`./handler.ts`) et `PuitsAccuses` (`./delivery.ts`, revue finale du 2026-09-23). Toutes
 * restent optionnelles ICI (les tests de réception s'en passent) ; c'est `WebhookJobDeps` qui exige le puits
 * des signaux avec `inbox` (tâche 10).
 */
export interface DepsEntrants {
  upsertContact?: InboundContactUpsert;
  optOut?: InboundOptOut;
  /**
   * RÉPARTITION D'UNE RÉPONSE DE CAMPAGNE (migration 0134). Absente -> aucune affectation automatique,
   * c'est-à-dire le comportement d'avant : la conversation tombe dans « À traiter ».
   *
   * 🔴 ELLE PASSE APRÈS `recordInbound`, ET C'EST OBLIGATOIRE : c'est cet appel-là qui CRÉE la
   * conversation (`upsertConversationByWaId`). L'affectation vise une ligne de `conversations` ; jouée
   * avant, elle ne trouverait rien à affecter sur la toute première réponse d'un contact, c'est-à-dire
   * précisément le cas qu'elle existe pour servir.
   */
  assignation?: InboundAssignation;
  /** Les signaux (spec 2026-09-24, § 8). APRÈS `recordInbound` : on ne remonte pas un message non enregistré. */
  signalReponse?: SignalReponse;
}
```

La signature de `processInbound` (ligne 308 à 323), dont le commentaire du paramètre `assignation` vient d'être déplacé tel quel dans `DepsEntrants`, devient :

```ts
export async function processInbound(
  payload: unknown,
  store: InboxStore,
  deps: DepsEntrants = {},
): Promise<void> {
  const { upsertContact, optOut, assignation, signalReponse } = deps;
```

(le corps de la boucle ne change pas : il lit les mêmes noms). Puis, juste après `await store.recordInbound(tenantId, m);` :

```ts
    if (signalReponse) {
      try {
        await signalReponse(tenantId, m);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('processInbound: signal de réponse ignoré:', err instanceof Error ? err.message : err);
      }
    }
```

Dans `src/webhooks/handler.ts` : ajouter aux imports

```ts
import type { SignalAccuse } from './delivery';
import type { SignalReponse } from './inbound';
```

ajouter à la fin de `interface WebhookJobDepsCommunes` :

```ts
  /** Les signaux (spec 2026-09-24, § 8). OPTIONNELS le temps du lot : la tâche 10 les rend REQUIS avec leur câblage. */
  signauxAccuse?: SignalAccuse;
  signalReponse?: SignalReponse;
```

ajouter `signauxAccuse, signalReponse,` à la déstructuration de `handleWebhookJob` (ligne 114 à 118, qui porte déjà `echecsLibres` depuis le lot 3), puis la ligne que le lot 3 a écrite (`if (delivery) await processStatuses(events, delivery, { tarifs: tarifsMeta, echecsLibres, nodeEvents, remiseMba });`) devient :

```ts
  if (delivery) await processStatuses(events, delivery, { tarifs: tarifsMeta, echecsLibres, nodeEvents, remiseMba, signaux: signauxAccuse });
```

```ts
  if (inbox) {
    await processInbound(raw, inbox, {
      upsertContact: upsert, optOut: inboundOptOut, assignation: inboundAssignation, signalReponse,
    });
  }
```

Puis `npm run typecheck` : le compilateur désigne chaque appel de `processInbound` qui passe encore ses dépendances en position. Dans `tests/crm-consentement.test.ts`, les remplacer ainsi (le sens de chaque cas ne change pas) :

- `h.store, h.upsert, h.optOut)` (ligne 75, 87, 95, 101 et 118) et `]), h.store, h.upsert, h.optOut);` (ligne 112 et 151) deviennent `h.store, { upsertContact: h.upsert, optOut: h.optOut })` et `]), h.store, { upsertContact: h.upsert, optOut: h.optOut });` ;
- `h.store, h.upsert)` (ligne 141) devient `h.store, { upsertContact: h.upsert })` ;
- ligne 131 à 133, `payload([texte('STOP')]), store,` puis `async () => 'created',` puis `async () => { throw new Error('pooler injoignable'); },` deviennent `payload([texte('STOP')]), store,` puis `{ upsertContact: async () => 'created', optOut: async () => { throw new Error('pooler injoignable'); } },` ;
- `store, undefined, async () => 'c1')` (ligne 163) devient `store, { optOut: async () => 'c1' })`.

- [ ] **Step 4 : le voir passer, et ne rien casser autour**

```bash
npx vitest run tests/signaux-webhooks.test.ts tests/crm-consentement.test.ts tests/inbound.test.ts tests/detenteur-du-fil.test.ts tests/delivery.test.ts tests/webhook-triggers.test.ts tests/pubs-tarif-meta.test.ts tests/pubs-arrivees.test.ts tests/workflow-mesure-statuts.test.ts tests/release-mba-sur-accuse.test.ts && npm run typecheck
```

Attendu : vert, et aucun cas de `tests/crm-consentement.test.ts` retiré ni affaibli (réécrire un test garde le cas qu'il exerçait).

- [ ] **Step 5 : commit (procédure P)**

Chemins : `src/webhooks/delivery.ts src/webhooks/inbound.ts src/webhooks/handler.ts tests/crm-consentement.test.ts tests/signaux-webhooks.test.ts`. Message : `feat(signaux): points d accroche des accuses et des entrants Meta, dependances de processInbound nommees (lot 6)`.

---

### Task 5 : L'émetteur (`src/signaux/emetteur.ts`)

**Files:**
- Create: `src/signaux/emetteur.ts`
- Create: `tests/signaux-emetteur.test.ts`
- Modify: `src/queue/queue.ts:30-34` (`enqueue` : l'option `priority`)
- Modify: `src/queue/pgboss.ts:212-225` (`enqueue` passe par une fonction PURE `sendOptions`, écrite juste après `workConcurrencyOptions`, ligne 111, avant `export class PgBossQueue`, ligne 125)
- Modify: `src/queue/fake.ts:11` et `:23` (le type des options d'`enqueue`)
- Create: `tests/queue-priorite.test.ts`

**Interfaces:**
- Consumes : `idSignal`, `schemaSignal`, `SIGNAUX_PAR_JOB`, `CanalSignal`, `JobSignaux`, `NomEvenement`, `Signal` (tâche 2) ; `AccuseDuStatut`, `SignalAccuse`, `InboundMessage`, `SignalReponse` (tâche 4).
- Produces :
  - `Queue.enqueue(name, data, opts?: { expireInSeconds?: number; groupId?: string; priority?: number })` ; `function sendOptions(opts?): { expireInSeconds?: number; group?: { id: string }; priority?: number }` (`src/queue/pgboss.ts`)
  - `DUREE_CACHE_ESPACES_ACTIFS_MS = 60_000`, `PRIORITE_SIGNAL: Readonly<Record<NomEvenement, number>>`, `TYPES_DE_REPONSE: ReadonlySet<string>`
  - `interface DestinationSignaux { file: string; espacesActifs(): Promise<ReadonlySet<string>> }`
  - `interface DepsEmetteur { destinations; enfiler(file, job: JobSignaux, opts: { groupId: string; priority: number }); log? }`
  - `interface Emetteur { emettreSignal(tenantId: string, signal: Signal): Promise<void>; emettreSignaux(tenantId: string, signaux: readonly Signal[]): Promise<void>; quelquUnEcoute(): Promise<boolean> }`, `function creerEmetteur(deps: DepsEmetteur): Emetteur`
  - `signalDeLAccuse(a: AccuseDuStatut, canal: CanalSignal): Signal | null`, `boutonTape(m)`, `signalDeLaReponse(r, canal): Signal`, `signalDuClic(contactId, code): Signal`, `signalDesabonnement(waId, canal): Signal`, `signalAnalyse(conversationId): Signal`
  - `creerPuitsSignauxMeta(deps: { emetteur; tenantDuNumero(pnid): Promise<string | null> }): { accuse: SignalAccuse; reponse: SignalReponse }`
  - `annoncerAussiAuxSignaux(annonce, emetteur): (tenantId: string, waIds: string[]) => Promise<void>`

🔴 **LE DÉBIT, ET POURQUOI LE JOB PORTE UNE LISTE ET UNE PRIORITÉ.** La file est groupée par espace (`groupConcurrency: 1`) : les jobs d'un même espace passent un par un, chacun avec ses lectures et son appel HTTP. Sur un espace branché, une campagne de 5 000 destinataires produit de l'ordre de 10 000 accusés (délivré, lu), donc autant de jobs ; sans priorité, la réponse d'un client arrivée juste après attendrait derrière eux, alors que la spec (§ 8) la dit « immédiate ». Deux parades, toutes les deux dans cette tâche :

- **la PRIORITÉ** : pg-boss prend les jobs par `priority desc` puis par date de création (option `priority` de la prise, vraie par défaut, lue dans `node_modules/pg-boss/dist/plans.js`, gabarit de la requête de prise ligne 1224 : `ORDER BY ${priority ? 'j.priority desc, ' : ''}…`, avec `priority = true` par défaut ligne 1165, pg-boss 12.25.1). Réponses, clics, désabonnements et analyses passent en `1`, les accusés restent à `0` : ils passent DEVANT un arriéré d'accusés, qui s'écoule ensuite. L'ordre entre un accusé et une réponse de la même fiche n'est plus garanti, et c'est sans effet : chaque événement porte son `time`, et l'état de la fiche est relu au moment de pousser ;
- **la LISTE** : un job porte de 1 à `SIGNAUX_PAR_JOB` signaux. Un désabonnement de masse (action en masse de l'Inbox ou du mini-CRM, dans la requête HTTP d'un opérateur) s'enfile en quelques jobs au lieu d'un enfilement par fiche, et le travail les pousse en quelques appels (`versBatch` découpe déjà à 200 profils et 15 événements).

⚠️ **CE QUI RESTE, ET QUE LA DOC DIT** (tâche 13) : les accusés d'une grosse campagne sont toujours poussés un job par accusé, donc peuvent arriver avec du retard (plusieurs dizaines de minutes pour quelques milliers de destinataires, ordre de grandeur non mesuré). Lire les jobs par lots côté worker (pg-boss `batchSize`) le résorberait, mais casserait l'invariant « un job par appel du handler » que `PgBossQueue.work` verrouille (`batchSize: 1`, `src/queue/pgboss.ts:257`), dont d'autres files dépendent : hors lot.

- [ ] **Step 1 : écrire le test qui échoue**

`tests/signaux-emetteur.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import {
  creerEmetteur, creerPuitsSignauxMeta, annoncerAussiAuxSignaux, boutonTape, PRIORITE_SIGNAL,
  signalDeLAccuse, signalDeLaReponse, signalDuClic, signalDesabonnement, signalAnalyse,
} from '../src/signaux/emetteur';
import { NOMS_EVENEMENTS, SIGNAUX_PAR_JOB, schemaSignal, type JobSignaux, type Signal } from '../src/signaux/types';
import type { InboundMessage } from '../src/webhooks/inbound';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

function emetteurDeTest(actifs: string[] = [T]) {
  const jobs: Array<{ file: string; job: JobSignaux; opts: { groupId: string; priority: number } }> = [];
  const logs: string[] = [];
  let lectures = 0;
  const emetteur = creerEmetteur({
    destinations: [{ file: 'signaux-test', espacesActifs: async () => { lectures += 1; return new Set(actifs); } }],
    enfiler: async (file, job, opts) => { jobs.push({ file, job, opts }); },
    log: (m) => { logs.push(m); },
  });
  return { emetteur, jobs, logs, lectures: () => lectures };
}
const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  phoneNumberId: 'PN1', waId: '33612345678', messageId: 'wamid.in1', type: 'text', body: 'bonjour',
  buttonPayload: null, profileName: null, field: 'messages', ...over,
});

describe('creerEmetteur', () => {
  it('un espace qui n’a rien branché : rien n’est enfilé', async () => {
    const { emetteur, jobs } = emetteurDeTest([]);
    await emetteur.emettreSignal(T, signalDesabonnement('33612345678', 'whatsapp'));
    expect(jobs).toEqual([]);
  });

  it('un espace branché : un job, dans la file de l’adaptateur, groupé par espace, avec sa priorité', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const s = signalDesabonnement('33612345678', 'whatsapp');
    await emetteur.emettreSignal(T, s);
    expect(jobs).toEqual([{ file: 'signaux-test', job: { tenantId: T, signaux: [s] }, opts: { groupId: T, priority: 1 } }]);
  });

  it('🔴 les accusés restent DERRIÈRE : réponses, clics, désabonnements et analyses passent devant', () => {
    expect(Object.keys(PRIORITE_SIGNAL).sort()).toEqual([...NOMS_EVENEMENTS].sort());
    for (const n of ['em_message_delivered', 'em_message_read', 'em_message_failed'] as const) {
      for (const devant of ['em_replied', 'em_link_clicked', 'em_opted_out', 'em_conversation_analyzed'] as const) {
        expect(PRIORITE_SIGNAL[devant], `${devant} devant ${n}`).toBeGreaterThan(PRIORITE_SIGNAL[n]);
      }
    }
  });

  it('🔴 une émission groupée se range par priorité, en jobs de SIGNAUX_PAR_JOB au plus', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const livre = signalDeLAccuse({ messageId: 'wamid.1', status: 'delivered', waId: '336', motif: null, codeMeta: null, le: null }, 'whatsapp')!;
    const desabos = Array.from({ length: SIGNAUX_PAR_JOB + 50 }, (_, i) => signalDesabonnement(`336${i}`, 'whatsapp'));
    await emetteur.emettreSignaux(T, [livre, ...desabos]);
    expect(jobs.map((j) => [j.opts.priority, j.job.signaux.length])).toEqual([[0, 1], [1, SIGNAUX_PAR_JOB], [1, 50]]);
  });

  it('🔴 un signal hors contrat est écarté SEUL : les autres partent', async () => {
    const { emetteur, jobs, logs } = emetteurDeTest();
    const bon = signalDesabonnement('336', 'whatsapp');
    const horsContrat = { ...signalDesabonnement('337', 'whatsapp'), texte: 'x' } as unknown as Signal;
    await emetteur.emettreSignaux(T, [bon, horsContrat]);
    expect(jobs.map((j) => j.job.signaux)).toEqual([[bon]]);
    expect(logs.some((l) => l.includes('hors contrat'))).toBe(true);
  });

  it('🔴 il ne lève JAMAIS : une lecture ou un enfilement en panne se journalise', async () => {
    const logs: string[] = [];
    const lectureCassee = creerEmetteur({
      destinations: [{ file: 'f', espacesActifs: async () => { throw new Error('base indisponible'); } }],
      enfiler: async () => {},
      log: (m) => { logs.push(m); },
    });
    await expect(lectureCassee.emettreSignal(T, signalAnalyse(C))).resolves.toBeUndefined();
    const fileCassee = creerEmetteur({
      destinations: [{ file: 'f', espacesActifs: async () => new Set([T]) }],
      enfiler: async () => { throw new Error('file pleine'); },
      log: (m) => { logs.push(m); },
    });
    await expect(fileCassee.emettreSignal(T, signalAnalyse(C))).resolves.toBeUndefined();
    expect(logs).toHaveLength(2);
  });

  it('🔴 un signal hors contrat n’entre pas dans la file (le lecteur le refuserait jusqu’à la DLQ)', async () => {
    const { emetteur, jobs, logs } = emetteurDeTest();
    const horsContrat = { ...signalDesabonnement('33612345678', 'whatsapp'), texte: 'x' } as unknown as Signal;
    await emetteur.emettreSignal(T, horsContrat);
    expect(jobs).toEqual([]);
    expect(logs[0]).toContain('hors contrat');
  });

  it('quelquUnEcoute : vrai dès qu’un espace a branché un outil', async () => {
    expect(await emetteurDeTest([]).emetteur.quelquUnEcoute()).toBe(false);
    expect(await emetteurDeTest([T]).emetteur.quelquUnEcoute()).toBe(true);
  });
});

describe('les signaux que les chemins chauds fabriquent', () => {
  it('un accusé `sent`, ou sans destinataire, ne fait aucun signal', () => {
    expect(signalDeLAccuse({ messageId: 'w', status: 'sent', waId: '336', motif: null, codeMeta: null, le: null }, 'whatsapp')).toBeNull();
    expect(signalDeLAccuse({ messageId: 'w', status: 'delivered', waId: null, motif: null, codeMeta: null, le: null }, 'whatsapp')).toBeNull();
  });

  it('délivré, lu, en échec : trois noms, un identifiant STABLE par message, le motif borné', () => {
    const accuse = (status: 'delivered' | 'read' | 'failed') =>
      signalDeLAccuse({ messageId: 'wamid.1', status, waId: '336', motif: status === 'failed' ? 'x'.repeat(900) : null, codeMeta: status === 'failed' ? 131026 : null, le: '2026-09-24T10:00:00.000Z' }, 'rcs');
    expect(accuse('delivered')?.nom).toBe('em_message_delivered');
    expect(accuse('read')?.nom).toBe('em_message_read');
    const echec = accuse('failed');
    expect(echec).toMatchObject({ nom: 'em_message_failed', canal: 'rcs', codeMeta: 131026, le: '2026-09-24T10:00:00.000Z' });
    expect(echec?.nom === 'em_message_failed' ? echec.motif?.length : -1).toBe(500);
    expect(accuse('delivered')?.id).toBe(accuse('delivered')?.id);
    for (const s of [accuse('delivered'), accuse('read'), echec]) expect(schemaSignal.safeParse(s).success).toBe(true);
  });

  it('boutonTape : le libellé d’un bouton, jamais un texte saisi', () => {
    expect(boutonTape(message())).toBeNull();
    expect(boutonTape(message({ type: 'button', body: 'Oui', buttonPayload: 'Oui' }))).toBe('Oui');
    expect(boutonTape(message({ type: 'interactive', body: 'Rappelez-moi', buttonPayload: 'btn:1' }))).toBe('Rappelez-moi');
    expect(boutonTape(message({ type: 'interactive', body: '[formulaire]', buttonPayload: '{"adresse":"12 rue des Lilas"}' }))).toBeNull();
    expect(boutonTape(message({ type: 'interactive', body: 'Envoyer', buttonPayload: ' {"x":1}' }))).toBeNull();
  });

  it('🔴 une réponse ne transporte JAMAIS le texte du message', () => {
    const s = signalDeLaReponse({ messageId: 'wamid.in1', waId: '336', bouton: boutonTape(message({ body: 'mon adresse est 12 rue des Lilas' })) }, 'whatsapp');
    expect(JSON.stringify(s)).not.toContain('Lilas');
    expect(schemaSignal.safeParse(s).success).toBe(true);
  });

  it('clic, désabonnement, analyse : conformes au contrat', () => {
    for (const s of [signalDuClic(C, 'ab12cd34ef56'), signalDesabonnement('336', 'rcs'), signalAnalyse(C)]) {
      expect(schemaSignal.safeParse(s).success, s.nom).toBe(true);
    }
  });
});

describe('creerPuitsSignauxMeta : le coût sur le chemin chaud des accusés', () => {
  function puits(actifs: string[]) {
    let numeros = 0;
    const t = emetteurDeTest(actifs);
    const p = creerPuitsSignauxMeta({ emetteur: t.emetteur, tenantDuNumero: async () => { numeros += 1; return T; } });
    return { p, t, numeros: () => numeros };
  }

  it('🔴 un statut `sent` ne lit RIEN : ni la liste des espaces, ni le numéro', async () => {
    const { p, t, numeros } = puits([T]);
    await p.accuse('PN1', { messageId: 'wamid.1', status: 'sent', waId: '336', motif: null, codeMeta: null, le: null });
    expect(t.lectures()).toBe(0);
    expect(numeros()).toBe(0);
  });

  it('🔴 personne n’a branché d’outil : le numéro n’est pas résolu', async () => {
    const { p, t, numeros } = puits([]);
    await p.accuse('PN1', { messageId: 'wamid.1', status: 'delivered', waId: '336', motif: null, codeMeta: null, le: null });
    expect(numeros()).toBe(0);
    expect(t.jobs).toEqual([]);
  });

  it('un espace branché : l’accusé devient un signal de son espace, en priorité basse', async () => {
    const { p, t } = puits([T]);
    await p.accuse('PN1', { messageId: 'wamid.1', status: 'read', waId: '336', motif: null, codeMeta: null, le: null });
    expect(t.jobs.map((j) => [j.job.tenantId, j.job.signaux[0]!.nom, j.opts.priority])).toEqual([[T, 'em_message_read', 0]]);
  });

  it('🔴 la réponse ne transporte jamais le texte du message, et garde l’instant de Meta', async () => {
    const { p, t } = puits([T]);
    const envoyeLe = new Date('2026-09-24T09:59:00.000Z');
    await p.reponse(T, message({ body: 'mon adresse est 12 rue des Lilas', envoyeLe }));
    expect(t.jobs).toHaveLength(1);
    expect(JSON.stringify(t.jobs[0])).not.toContain('Lilas');
    expect(t.jobs[0]!.job.signaux[0]).toMatchObject({ nom: 'em_replied', canal: 'whatsapp', bouton: null, le: envoyeLe.toISOString() });
  });

  it('🔴 une réaction, un type non pris en charge ou inconnu n’est PAS une réponse', async () => {
    const { p, t } = puits([T]);
    await p.reponse(T, message({ type: 'reaction', body: '👍', buttonPayload: 'wamid.x' }));
    await p.reponse(T, message({ type: 'unsupported', body: null }));
    await p.reponse(T, message({ type: 'unknown', body: null }));
    expect(t.jobs).toEqual([]);
  });

  it('🔴 un message du contact en `standby` reste une réponse : l’agent de Meta tient le fil, le contact a bien écrit', async () => {
    // L'avance de scénario et les automations refusent le standby parce que RÉPONDRE reprendrait le fil à
    // l'agent de Meta. Un signal n'envoie rien au contact : cette raison ne s'applique pas. Et l'écho de ce que
    // l'agent a dit n'arrive jamais ici (`message_echoes`, lu par `processHandovers` seul, tâche 4).
    const { p, t } = puits([T]);
    await p.reponse(T, message({ field: 'standby' }));
    expect(t.jobs.map((j) => j.job.signaux[0]!.nom)).toEqual(['em_replied']);
  });
});

describe('annoncerAussiAuxSignaux : le désabonnement', () => {
  it('annonce au connecteur PUIS un signal par personne, dans UN job', async () => {
    const ordre: string[] = [];
    const { emetteur, jobs } = emetteurDeTest();
    await annoncerAussiAuxSignaux(async (t, w) => { ordre.push(`annonce:${t}:${w.join(',')}`); }, emetteur)(T, ['336', '337']);
    expect(ordre).toEqual([`annonce:${T}:336,337`]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job.signaux).toMatchObject([
      { nom: 'em_opted_out', waId: '336', canal: 'whatsapp' },
      { nom: 'em_opted_out', waId: '337', canal: 'whatsapp' },
    ]);
  });

  it('🔴 un désabonnement de MASSE s’enfile en quelques jobs, pas un par fiche', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const waIds = Array.from({ length: 2 * SIGNAUX_PAR_JOB + 50 }, (_, i) => `3361234${String(i).padStart(4, '0')}`);
    await annoncerAussiAuxSignaux(async () => {}, emetteur)(T, waIds);
    expect(jobs.map((j) => j.job.signaux.length)).toEqual([SIGNAUX_PAR_JOB, SIGNAUX_PAR_JOB, 50]);
  });

  it('🔴 une annonce en panne n’empêche pas le signal, et son erreur remonte à qui la journalise', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const compose = annoncerAussiAuxSignaux(async () => { throw new Error('file pleine'); }, emetteur);
    await expect(compose(T, ['336'])).rejects.toThrow('file pleine');
    expect(jobs).toHaveLength(1);
  });
});
```

Créer `tests/queue-priorite.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { sendOptions } from '../src/queue/pgboss';
import { FakeQueue } from '../src/queue/fake';

/**
 * LA PRIORITÉ D'UN JOB (lot 6 de l'API publique) : elle doit VRAIMENT atteindre `boss.send`, sinon les réponses
 * d'un client attendent derrière les accusés d'une campagne sans que rien ne le signale. Même patron que
 * `workConcurrencyOptions` (`tests/queue-group-concurrency.test.ts`) : la fonction PURE est le câblage.
 */
describe('sendOptions (options passées à boss.send)', () => {
  it('une absence reste une absence', () => {
    expect(sendOptions()).toEqual({});
    expect(sendOptions({})).toEqual({});
  });

  it('groupId devient group.id, expireInSeconds passe tel quel (comportement d’avant)', () => {
    expect(sendOptions({ groupId: 't', expireInSeconds: 600 })).toEqual({ group: { id: 't' }, expireInSeconds: 600 });
  });

  it('🔴 priority est transmise dès qu’elle est DÉFINIE, 0 compris (une valeur explicite n’est pas une absence)', () => {
    expect(sendOptions({ priority: 0 })).toEqual({ priority: 0 });
    expect(sendOptions({ groupId: 't', priority: 1 })).toEqual({ group: { id: 't' }, priority: 1 });
  });
});

describe('FakeQueue : la priorité traverse l’abstraction', () => {
  it('enqueue transporte priority dans les opts', async () => {
    const q = new FakeQueue();
    await q.enqueue('f', { a: 1 }, { groupId: 't', priority: 1 });
    expect(q.enqueued[0]?.opts).toEqual({ groupId: 't', priority: 1 });
  });
});
```

- [ ] **Step 2 : le voir échouer**

```bash
npx vitest run tests/signaux-emetteur.test.ts tests/queue-priorite.test.ts
```

Attendu : ÉCHEC à l'import (`Failed to load url ../src/signaux/emetteur`) ; `sendOptions is not a function` ; et une erreur de typage sur `priority` dans `FakeQueue.enqueue` (`npm run typecheck` : `Object literal may only specify known properties`).

- [ ] **Step 3 : écrire l'émetteur**

`src/signaux/emetteur.ts` :

```ts
import type { AccuseDuStatut, SignalAccuse } from '../webhooks/delivery';
import type { InboundMessage, SignalReponse } from '../webhooks/inbound';
import {
  SIGNAUX_PAR_JOB, idSignal, schemaSignal, type CanalSignal, type JobSignaux, type NomEvenement, type Signal,
} from './types';

/**
 * L'ÉMETTEUR DE SIGNAUX (spec 2026-09-24, § 8) : le SEUL point par lequel un chemin du produit dit « il s'est
 * passé quelque chose sur cette fiche ».
 *
 * 🔴 IL NE LÈVE JAMAIS, et ses points d'appel sont des chemins CHAUDS : l'accusé de chaque message, chaque
 * message entrant, la redirection d'un lien suivi. Une panne de la remontée ne doit ni retarder ni faire
 * rejouer aucun d'eux.
 *
 * 🔴 IL NE CONNAÎT AUCUN OUTIL. Il reçoit une liste de DESTINATIONS (une par adaptateur : sa file, et les
 * espaces qui l'ont branché) ; brancher un second outil ajoute une destination, rien d'autre.
 *
 * ⚠️ LA LISTE DES ESPACES ACTIFS SE LIT À TRAVERS UN CACHE COURT (`DUREE_CACHE_ESPACES_ACTIFS_MS`), par
 * process. Conséquence assumée : un outil branché depuis l'écran reçoit les signaux émis par le WORKER jusqu'à
 * une minute plus tard (l'API, elle, invalide son cache à l'enregistrement).
 */
export const DUREE_CACHE_ESPACES_ACTIFS_MS = 60_000;

/**
 * 🔴 LA PRIORITÉ D'UN SIGNAL DANS LA FILE (pg-boss prend `priority desc`, puis par date de création).
 *
 * Les ACCUSÉS restent à 0 : une campagne en produit des milliers d'un coup, et la file d'un espace les traite un
 * par un. Tout ce qui répond à un GESTE du contact (réponse, clic, désabonnement) ou le résume (analyse) passe
 * en 1, donc devant cet arriéré : c'est ce qui permet à la documentation de promettre ces signaux dans la minute.
 */
export const PRIORITE_SIGNAL: Readonly<Record<NomEvenement, number>> = {
  em_message_delivered: 0,
  em_message_read: 0,
  em_message_failed: 0,
  em_replied: 1,
  em_link_clicked: 1,
  em_opted_out: 1,
  em_conversation_analyzed: 1,
};

/**
 * Les types de message WhatsApp qui sont une RÉPONSE du contact : ce qu'il a composé ou tapé. Une réaction (un
 * emoji posé sur un message), un type non pris en charge par Meta (`unsupported`), un message système ou un type
 * inconnu n'en sont pas : les compter ferait mentir `em_replied` et `em_last_reply_at`. Liste POSITIVE, donc un
 * type que Meta ajouterait demain ne devient pas une réponse sans qu'on l'ait décidé.
 */
export const TYPES_DE_REPONSE: ReadonlySet<string> = new Set([
  'text', 'button', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'order',
]);

export interface DestinationSignaux {
  /** La file pg-boss de l'adaptateur, déclarée dans `BASE_QUEUES`. */
  file: string;
  /** Les espaces où l'adaptateur est actif, lus à travers un cache court : jamais une requête par signal. */
  espacesActifs(): Promise<ReadonlySet<string>>;
}

export interface DepsEmetteur {
  destinations: readonly DestinationSignaux[];
  enfiler(file: string, job: JobSignaux, opts: { groupId: string; priority: number }): Promise<void>;
  log?(message: string): void;
}

export interface Emetteur {
  emettreSignal(tenantId: string, signal: Signal): Promise<void>;
  /** Plusieurs signaux d'un même espace (un désabonnement de masse) : rangés par priorité, en jobs bornés. */
  emettreSignaux(tenantId: string, signaux: readonly Signal[]): Promise<void>;
  /** Un espace au moins a-t-il branché un outil ? Permet à un accusé de ne rien lire quand la réponse est non. */
  quelquUnEcoute(): Promise<boolean>;
}

const texteErreur = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function creerEmetteur(deps: DepsEmetteur): Emetteur {
  const emettreSignaux = async (tenantId: string, signaux: readonly Signal[]): Promise<void> => {
    if (signaux.length === 0) return;
    for (const d of deps.destinations) {
      try {
        if (!(await d.espacesActifs()).has(tenantId)) continue;
        // Validé AVANT d'entrer dans la file, signal par signal : le lecteur relit le job avec le même schéma, et
        // un job qu'il refuse irait jusqu'à la DLQ après cinq essais, en emportant les signaux valides avec lui.
        const parPriorite = new Map<number, Signal[]>();
        for (const s of signaux) {
          const valide = schemaSignal.safeParse(s);
          if (!valide.success) {
            deps.log?.(`signaux: ${s.nom} hors contrat pour ${tenantId}, non enfile (${valide.error.issues[0]?.message ?? 'forme'})`);
            continue;
          }
          const p = PRIORITE_SIGNAL[valide.data.nom];
          const liste = parPriorite.get(p) ?? [];
          liste.push(valide.data);
          parPriorite.set(p, liste);
        }
        for (const [priority, liste] of parPriorite) {
          for (let i = 0; i < liste.length; i += SIGNAUX_PAR_JOB) {
            await deps.enfiler(d.file, { tenantId, signaux: liste.slice(i, i + SIGNAUX_PAR_JOB) }, { groupId: tenantId, priority });
          }
        }
      } catch (err) {
        deps.log?.(`signaux: ${signaux.length} signal(aux) non enfile(s) vers ${d.file} pour ${tenantId}: ${texteErreur(err)}`);
      }
    }
  };
  return {
    emettreSignaux,
    emettreSignal: (tenantId, signal) => emettreSignaux(tenantId, [signal]),
    async quelquUnEcoute() {
      for (const d of deps.destinations) {
        try {
          if ((await d.espacesActifs()).size > 0) return true;
        } catch (err) {
          deps.log?.(`signaux: espaces actifs illisibles pour ${d.file}: ${texteErreur(err)}`);
        }
      }
      return false;
    },
  };
}

const maintenant = (): string => new Date().toISOString();

/** Un accusé en signal. `sent` n'en est pas un (l'envoi est déjà su), et sans destinataire il n'y a pas de fiche. */
export function signalDeLAccuse(a: AccuseDuStatut, canal: CanalSignal): Signal | null {
  if (a.status === 'sent' || a.waId === null || a.waId.trim() === '') return null;
  const le = a.le ?? maintenant();
  if (a.status === 'failed') {
    return {
      nom: 'em_message_failed', id: idSignal('em_message_failed', a.messageId), le, waId: a.waId, canal,
      messageId: a.messageId, motif: a.motif === null ? null : a.motif.slice(0, 500), codeMeta: a.codeMeta,
    };
  }
  if (a.status === 'delivered') {
    return { nom: 'em_message_delivered', id: idSignal('em_message_delivered', a.messageId), le, waId: a.waId, canal, messageId: a.messageId };
  }
  return { nom: 'em_message_read', id: idSignal('em_message_read', a.messageId), le, waId: a.waId, canal, messageId: a.messageId };
}

/**
 * Le libellé du bouton tapé, ou `null`. JAMAIS un texte saisi : une réponse de FORMULAIRE porte son JSON dans
 * `buttonPayload`, et ce JSON est ce que la personne a écrit.
 */
export function boutonTape(m: Pick<InboundMessage, 'type' | 'body' | 'buttonPayload'>): string | null {
  if (m.type === 'button') return m.body;
  if (m.type !== 'interactive' || m.buttonPayload === null) return null;
  if (m.buttonPayload.trimStart().startsWith('{') || m.body === '[formulaire]') return null;
  return m.body;
}

export function signalDeLaReponse(r: { messageId: string; waId: string; bouton: string | null; le?: string }, canal: CanalSignal): Signal {
  return {
    nom: 'em_replied', id: idSignal('em_replied', r.messageId), le: r.le ?? maintenant(), waId: r.waId, canal,
    bouton: r.bouton === null ? null : r.bouton.slice(0, 300),
  };
}

/** Un clic ATTRIBUÉ (l'adresse portait le jeton du contact). Un clic anonyme ne fait pas de signal : sans fiche, pas de profil. */
export function signalDuClic(contactId: string, code: string): Signal {
  return { nom: 'em_link_clicked', id: idSignal('em_link_clicked'), le: maintenant(), contactId, lien: code };
}

export function signalDesabonnement(waId: string, canal: CanalSignal): Signal {
  return { nom: 'em_opted_out', id: idSignal('em_opted_out'), le: maintenant(), waId, canal };
}

/** La conversation analysée : une RÉFÉRENCE. L'analyse se relit au moment de pousser, jamais dans la file. */
export function signalAnalyse(conversationId: string): Signal {
  return { nom: 'em_conversation_analyzed', id: idSignal('em_conversation_analyzed'), le: maintenant(), conversationId };
}

/**
 * Les deux puits que le webhook Meta reçoit (tâche 4).
 *
 * 🔴 L'ORDRE DE `accuse` EST LA GARANTIE DE COÛT : un statut `sent` (le plus fréquent) s'arrête avant toute
 * lecture, et tant qu'aucun espace n'a branché d'outil, le numéro n'est même pas résolu.
 *
 * ⚠️ `reponse` GARDE LE `standby`, délibérément. Un message extrait par `processInbound` en `standby` est un
 * message du CONTACT pendant que l'agent de Meta tient le fil (payload réel, essais du 2026-09-16) ; l'écho de
 * ce que l'agent a dit vit sous `message_echoes`, que `extractInbound` ne lit pas. L'avance de scénario et les
 * automations le refusent parce que RÉPONDRE reprendrait le fil à l'agent ; un signal n'envoie rien au contact.
 * Le filtrer perdrait chaque réponse faite à une campagne qui confie ses réponses à l'agent de Meta.
 */
export function creerPuitsSignauxMeta(deps: {
  emetteur: Emetteur;
  tenantDuNumero(phoneNumberId: string): Promise<string | null>;
}): { accuse: SignalAccuse; reponse: SignalReponse } {
  return {
    async accuse(phoneNumberId, a) {
      const signal = signalDeLAccuse(a, 'whatsapp');
      if (signal === null) return;
      if (!(await deps.emetteur.quelquUnEcoute())) return;
      const tenantId = await deps.tenantDuNumero(phoneNumberId);
      if (tenantId !== null) await deps.emetteur.emettreSignal(tenantId, signal);
    },
    async reponse(tenantId, m) {
      if (!TYPES_DE_REPONSE.has(m.type)) return;
      await deps.emetteur.emettreSignal(tenantId, signalDeLaReponse({
        messageId: m.messageId,
        waId: m.waId,
        bouton: boutonTape(m),
        ...(m.envoyeLe ? { le: m.envoyeLe.toISOString() } : {}),
      }, 'whatsapp'));
    },
  };
}

/**
 * Compose l'annonce d'opt-out du dépôt des contacts avec les signaux.
 *
 * 🔴 POSÉE SUR LE DÉPÔT, COMME L'ANNONCE : elle couvre par CONSTRUCTION toutes les méthodes capables d'écrire
 * `opted_out` (mot-clé entrant, fiche, action en masse, consentement de l'API), au lieu d'être recopiée sur
 * chaque appelant. Le STOP RCS n'y passe pas (il écrit `rcs_optout_at` ailleurs) : il émet lui-même.
 *
 * ⚠️ `finally` : une annonce en panne n'empêche pas le signal, et son erreur remonte au dépôt, qui la journalise.
 *
 * ⚠️ `'whatsapp'` dit ici QUEL CONSENTEMENT le dépôt a retiré (`opt_in_status`), pas le canal sur lequel la
 * personne a parlé : celui-là se déduit de la source au moment de pousser (`completerSignal`).
 *
 * 🔴 UNE SEULE ÉMISSION pour toute la liste : une action en masse de milliers de fiches s'enfile en quelques
 * jobs (`SIGNAUX_PAR_JOB`), dans la requête HTTP de l'opérateur, et non en un enfilement par fiche.
 */
export function annoncerAussiAuxSignaux(
  annonce: (tenantId: string, waIds: string[]) => Promise<void>,
  emetteur: Emetteur,
): (tenantId: string, waIds: string[]) => Promise<void> {
  return async (tenantId, waIds) => {
    try {
      await annonce(tenantId, waIds);
    } finally {
      await emetteur.emettreSignaux(tenantId, waIds.map((waId) => signalDesabonnement(waId, 'whatsapp')));
    }
  };
}
```

Puis la PRIORITÉ dans l'abstraction de file. Dans `src/queue/queue.ts`, la ligne `    opts?: { expireInSeconds?: number; groupId?: string },` de `enqueue` (ligne 33) devient :

```ts
    /**
     * `priority` (lot 6 de l'API publique, 2026-09-24) : pg-boss prend les jobs par `priority desc`, puis par
     * date de création. Absente = 0, le comportement de toutes les files d'avant. Sert à faire passer les
     * signaux qui répondent à un geste du contact devant un arriéré d'accusés (`PRIORITE_SIGNAL`).
     */
    opts?: { expireInSeconds?: number; groupId?: string; priority?: number },
```

Dans `src/queue/pgboss.ts`, juste après la fonction `workConcurrencyOptions` (qui se termine avant `export class PgBossQueue`, ligne 125) :

```ts
/**
 * Options d'ENVOI passées à `boss.send`. Fonction PURE et exportée pour être testée, comme `workConcurrencyOptions`
 * (`tests/queue-priorite.test.ts`).
 *
 * ⚠️ `priority` est transmise dès qu'elle est DÉFINIE, 0 compris : une valeur explicite n'est pas une absence
 * (même piège que `concurrency: 0`). `expireInSeconds` et `groupId` gardent EXACTEMENT leur règle d'avant.
 */
export function sendOptions(opts: { expireInSeconds?: number; groupId?: string; priority?: number } = {}): {
  expireInSeconds?: number;
  group?: { id: string };
  priority?: number;
} {
  return {
    ...(opts.expireInSeconds ? { expireInSeconds: opts.expireInSeconds } : {}),
    ...(opts.groupId ? { group: { id: opts.groupId } } : {}),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
  };
}
```

et, dans `enqueue` (ligne 212 à 225), la signature prend `opts?: { expireInSeconds?: number; groupId?: string; priority?: number },`, et l'appel `await this.boss.send(name, data as object, { … });` (ligne 221 à 224) devient :

```ts
    await this.boss.send(name, data as object, sendOptions(opts));
```

Les deux commentaires au-dessus de l'appel, sur `expireInSeconds` et `groupId`, restent, et gagnent cette ligne :

```ts
    // `priority` : voir `sendOptions`, et `PRIORITE_SIGNAL` (`src/signaux/emetteur.ts`) pour son premier usage.
```

Dans `src/queue/fake.ts`, les deux types d'options d'`enqueue` (ligne 11 et ligne 23) deviennent `{ expireInSeconds?: number; groupId?: string; priority?: number }`.

- [ ] **Step 4 : le voir passer, et ne rien casser autour**

```bash
npx vitest run tests/signaux-emetteur.test.ts tests/queue-priorite.test.ts tests/queue-group-concurrency.test.ts tests/campaign-enqueue.test.ts && npm run typecheck
```

Attendu : vert. Aucun appelant existant de `enqueue` ne passe `priority` : pour eux, `sendOptions` rend exactement l'objet d'avant (cas « une absence reste une absence » et « comportement d'avant »).

- [ ] **Step 5 : commit (procédure P)**

Chemins : `src/signaux/emetteur.ts tests/signaux-emetteur.test.ts src/queue/queue.ts src/queue/pgboss.ts src/queue/fake.ts tests/queue-priorite.test.ts`. Message : `feat(signaux): l emetteur, sans outil ni cout tant que personne n ecoute, jobs bornes et prioritaires (lot 6)`.

---

### Task 6 : Les lectures (fiche, message, lien, analyse) et le réglage en base

**Files:**
- Create: `src/signaux/completer.ts`
- Create: `src/signaux/store.pg.ts`
- Create: `src/signaux/integration-batch.pg.ts`
- Create: `tests/signaux-completer.test.ts`
- Create: `tests/signaux-isolation.test.ts`
- Create: `tests/integration/signaux.integration.test.ts`

**Interfaces:**
- Consumes : `MATCH_BY_WAID_SQL` (`src/crm/contact-store.pg.ts:57`) ; `SOURCE_STOP_WHATSAPP` (`src/crm/consentement.ts:102`) ; colonnes `contacts.external_id` (lot 1), `contacts.opt_in_status`, `.opt_in_source`, `.rcs_optout_at`, `.deleted_at` ; `conversation_messages.meta_message_id`, `.origin` ; `campaign_recipients.message_id` (index `campaign_recipients_message_id_idx`, 0007) ET `campaign_envois.message_id` (index `campaign_envois_message_id_idx`, 0134) ; `tracked_links.template_name`, `.destination` ; `conversation_analysis` (0027, 0100, 0121) ; table `integration_batch` (tâche 1) ; `NOM_APPEL_SIGNAUX` (tâche 2).
- Produces :
  - `interface FicheDuSignal extends ContactDuSignal { optInSource: string | null }`
  - `interface LecturesSignal { ficheParWaId; ficheParId; waIdDeLaConversation; contexteDuMessage; lien; analyse }`
  - `function completerSignal(l: LecturesSignal, tenantId: string, s: Signal): Promise<SignalComplet | null>`
  - `class PgSignauxStore implements LecturesSignal`
  - `interface VueIntegrationBatch { envoyerResume; sansIdentifiant: number; sansIdentifiantLe; refusClesLe; majLe }`, `interface SecretsIntegrationBatch`, `class PgIntegrationBatchStore { lire; secrets; enregistrer; supprimer; espacesActifs; noterSansIdentifiant; suspendre }`

- [ ] **Step 1 : écrire le test unitaire qui échoue**

`tests/signaux-completer.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { completerSignal, type FicheDuSignal, type LecturesSignal } from '../src/signaux/completer';
import { signalAnalyse, signalDeLAccuse, signalDeLaReponse, signalDesabonnement, signalDuClic } from '../src/signaux/emetteur';
import { SOURCE_STOP_RCS, type AnalyseDuSignal, type Signal } from '../src/signaux/types';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const S = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const CONV = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const FICHE: FicheDuSignal = { contactId: C, externalId: 'crm-7781', optOutWhatsapp: true, optOutRcs: false, optInSource: 'whatsapp_stop' };
const ANALYSE: AnalyseDuSignal = {
  intent: 'sav', sentiment: 'neutre', satisfaction: null, urgence: 4, resolved: false, topic: 'livraison',
  actionSuggestion: 'rappeler', handledBy: 'humain', exchangesCount: 3, summary: 'Résumé.',
};

function lectures(over: Partial<LecturesSignal> = {}) {
  const tenants: string[] = [];
  const l: LecturesSignal = {
    ficheParWaId: async (t) => { tenants.push(t); return FICHE; },
    ficheParId: async (t) => { tenants.push(t); return FICHE; },
    waIdDeLaConversation: async (t) => { tenants.push(t); return '33612345678'; },
    contexteDuMessage: async (t) => { tenants.push(t); return { origine: 'campagne', sendId: S }; },
    lien: async (t) => { tenants.push(t); return { template: 'promo', destination: 'https://client.fr/promo' }; },
    analyse: async (t) => { tenants.push(t); return ANALYSE; },
    ...over,
  };
  return { l, tenants };
}
const accuse = (status: 'delivered' | 'failed'): Signal => signalDeLAccuse({
  messageId: 'wamid.1', status, waId: '33612345678',
  motif: status === 'failed' ? '131026 Message undeliverable' : null, codeMeta: status === 'failed' ? 131026 : null, le: null,
}, 'whatsapp')!;

describe('completerSignal : relire ce que le chemin chaud ne portait pas', () => {
  it('un accusé : la fiche par son wa_id, l’origine du message et son envoi', async () => {
    const r = await completerSignal(lectures().l, T, accuse('delivered'));
    expect(r?.contact).toEqual({ contactId: C, externalId: 'crm-7781', optOutWhatsapp: true, optOutRcs: false });
    expect(r?.contenu).toEqual({ nom: 'em_message_delivered', canal: 'whatsapp', origine: 'campagne', sendId: S });
  });

  it('un échec garde son motif et son code', async () => {
    const r = await completerSignal(lectures().l, T, accuse('failed'));
    expect(r?.contenu).toEqual({ nom: 'em_message_failed', canal: 'whatsapp', origine: 'campagne', sendId: S, motif: '131026 Message undeliverable', codeMeta: 131026 });
  });

  it('une réponse garde son bouton', async () => {
    const r = await completerSignal(lectures().l, T, signalDeLaReponse({ messageId: 'wamid.in', waId: '336', bouton: 'Oui' }, 'rcs'));
    expect(r?.contenu).toEqual({ nom: 'em_replied', canal: 'rcs', bouton: 'Oui' });
  });

  it('un clic : la fiche par son identifiant, le template et la destination du lien', async () => {
    const r = await completerSignal(lectures().l, T, signalDuClic(C, 'ab12cd34ef56'));
    expect(r?.contenu).toEqual({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: 'promo', destination: 'https://client.fr/promo' });
    const inconnu = await completerSignal(lectures({ lien: async () => null }).l, T, signalDuClic(C, 'ab12cd34ef56'));
    expect(inconnu?.contenu).toEqual({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: null, destination: null });
  });

  it('un désabonnement dit sa source : celle de la fiche, ou le STOP RCS', async () => {
    expect((await completerSignal(lectures().l, T, signalDesabonnement('336', 'whatsapp')))?.contenu)
      .toEqual({ nom: 'em_opted_out', canal: 'whatsapp', source: 'whatsapp_stop' });
    expect((await completerSignal(lectures().l, T, signalDesabonnement('336', 'rcs')))?.contenu)
      .toEqual({ nom: 'em_opted_out', canal: 'rcs', source: SOURCE_STOP_RCS });
  });

  it('🔴 un désabonnement posé par la console ou l’API n’a PAS de canal : personne n’a écrit STOP', async () => {
    for (const source of ['crm', 'api', 'webhook:formulaire-site']) {
      const l = lectures({ ficheParWaId: async () => ({ ...FICHE, optInSource: source }) }).l;
      expect((await completerSignal(l, T, signalDesabonnement('336', 'whatsapp')))?.contenu, source)
        .toEqual({ nom: 'em_opted_out', canal: null, source });
    }
  });

  it('une conversation analysée : la fiche par la conversation, et l’analyse relue', async () => {
    const r = await completerSignal(lectures().l, T, signalAnalyse(CONV));
    expect(r?.contenu).toEqual({ nom: 'em_conversation_analyzed', analyse: ANALYSE });
  });

  it('plus rien à pousser : fiche supprimée, conversation inconnue, analyse disparue', async () => {
    expect(await completerSignal(lectures({ ficheParWaId: async () => null }).l, T, accuse('delivered'))).toBeNull();
    expect(await completerSignal(lectures({ waIdDeLaConversation: async () => null }).l, T, signalAnalyse(CONV))).toBeNull();
    expect(await completerSignal(lectures({ analyse: async () => null }).l, T, signalAnalyse(CONV))).toBeNull();
  });

  it('🔴 chaque lecture reçoit l’espace du JOB, jamais un autre', async () => {
    const { l, tenants } = lectures();
    for (const s of [accuse('delivered'), signalDuClic(C, 'ab12cd34ef56'), signalAnalyse(CONV)]) await completerSignal(l, T, s);
    expect(tenants.length).toBeGreaterThan(0);
    expect(new Set(tenants)).toEqual(new Set([T]));
  });
});
```

Créer `tests/signaux-isolation.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 🔴 L'ISOLATION ENTRE CLIENTS DES LECTURES DES SIGNAUX, lue dans le CODE (lot 6 de l'API publique).
 *
 * La connexion passe par le pooler en rôle superuser, la RLS est contournée : `tenant_id = $1` est le SEUL
 * contrôle. Les cas « un autre espace » de `tests/integration/signaux.integration.test.ts` le prouvent contre
 * une vraie base, mais ils ne tournent qu'en CI et ne peuvent donc pas être vérifiés dans le sens ROUGE sans
 * pousser une fuite (tâche 11). Ce test-ci, lui, tourne partout et se mute en local : chaque `from` d'une
 * requête de `PgSignauxStore` a son filtre d'espace, et `PgIntegrationBatchStore` n'a qu'UNE lecture sans
 * filtre, la lecture transverse documentée des espaces actifs.
 */
function requetes(fichier: string): string[] {
  const source = readFileSync(new URL(`../${fichier}`, import.meta.url), 'utf8');
  // `(?:\/\/[^\n]*\n\s*)*` : une requête peut être précédée d'un commentaire `//` (celle de `lire` l'est), qui
  // contient lui-même des accents graves. Sans ce saut, elle serait simplement IGNORÉE, donc jamais vérifiée.
  return [...source.matchAll(/this\.pool\.query(?:<[^>]*>)?\(\s*(?:\/\/[^\n]*\n\s*)*`([\s\S]*?)`/g)].map((m) => m[1]!);
}
const compter = (texte: string, motif: RegExp): number => texte.match(motif)?.length ?? 0;

describe('isolation des lectures des signaux', () => {
  it('🔴 PgSignauxStore : chaque `from` porte son `tenant_id = $1`', () => {
    const rs = requetes('src/signaux/store.pg.ts');
    // Six requêtes : ficheParWaId, ficheParId, waIdDeLaConversation, contexteDuMessage, lien, analyse.
    expect(rs.length, 'une requête échappe au balayage : c’est le test qui est cassé').toBe(6);
    for (const r of rs) {
      expect(compter(r, /tenant_id = \$1/g), r).toBe(compter(r, /\bfrom\b/gi));
    }
  });

  it('🔴 PgIntegrationBatchStore : une seule lecture sans filtre d’espace, celle des espaces actifs', () => {
    const rs = requetes('src/signaux/integration-batch.pg.ts');
    // Huit requêtes : lire, secrets, les deux d'enregistrer, supprimer, espacesActifs, noterSansIdentifiant,
    // suspendre. Moins, c'est qu'une requête échappe au balayage.
    expect(rs.length).toBe(8);
    const sansFiltre = rs.filter((r) => /\bwhere\b/i.test(r) && !/tenant_id = \$1/.test(r));
    expect(sansFiltre).toHaveLength(1);
    expect(sansFiltre[0]).toMatch(/select tenant_id from integration_batch where refus_cles_le is null/);
  });
});
```

- [ ] **Step 2 : le voir échouer**

```bash
npx vitest run tests/signaux-completer.test.ts tests/signaux-isolation.test.ts
```

Attendu : ÉCHEC à l'import (`Failed to load url ../src/signaux/completer`), et `ENOENT` sur `src/signaux/store.pg.ts` pour le test d'isolation.

- [ ] **Step 3 : écrire les lectures génériques**

`src/signaux/completer.ts` :

```ts
import { SOURCE_STOP_WHATSAPP } from '../crm/consentement';
import { SOURCE_STOP_RCS, type AnalyseDuSignal, type CanalSignal, type ContactDuSignal, type Signal, type SignalComplet } from './types';

/**
 * RELIRE CE QUE LE SIGNAL NE TRANSPORTE PAS (spec 2026-09-24, § 8), au moment de pousser et jamais sur le
 * chemin chaud : la fiche et son consentement COURANT, l'origine et l'envoi d'un message, le lien cliqué,
 * l'analyse. GÉNÉRIQUE : aucun outil cible n'est nommé ici, tout adaptateur en part.
 *
 * `null` = plus rien à pousser (fiche supprimée, conversation ou analyse disparue) : ce n'est pas un échec.
 */
export interface FicheDuSignal extends ContactDuSignal {
  /** L'origine du dernier consentement écrit (`opt_in_source`) : c'est la source d'un désabonnement WhatsApp. */
  optInSource: string | null;
}

/** Chaque lecture reçoit l'espace du JOB et filtre dessus (`tenant_id = $1`) : c'est le seul contrôle. */
export interface LecturesSignal {
  ficheParWaId(tenantId: string, waId: string): Promise<FicheDuSignal | null>;
  ficheParId(tenantId: string, contactId: string): Promise<FicheDuSignal | null>;
  waIdDeLaConversation(tenantId: string, conversationId: string): Promise<string | null>;
  contexteDuMessage(tenantId: string, messageId: string): Promise<{ origine: string | null; sendId: string | null }>;
  lien(tenantId: string, code: string): Promise<{ template: string | null; destination: string } | null>;
  analyse(tenantId: string, conversationId: string): Promise<AnalyseDuSignal | null>;
}

/**
 * Le canal sur lequel la personne a DIT STOP, ou `null`.
 *
 * 🔴 LE `canal` DU JOB NE LE DIT PAS : il dit quel consentement l'écriture a retiré (`opt_in_status` pour
 * `whatsapp`). Or le dépôt des contacts écrit `opted_out` pour le mot-clé STOP, mais aussi depuis la fiche,
 * l'action en masse, un scénario ou l'API publique. Annoncer `whatsapp` pour ces derniers ferait croire à
 * l'intégrateur que le contact a écrit STOP sur WhatsApp. Seule la source le prouve, relue sur la fiche.
 */
function canalDuStop(s: Extract<Signal, { nom: 'em_opted_out' }>, fiche: FicheDuSignal): CanalSignal | null {
  if (s.canal === 'rcs') return 'rcs';
  return fiche.optInSource === SOURCE_STOP_WHATSAPP ? 'whatsapp' : null;
}

async function ficheDu(l: LecturesSignal, tenantId: string, s: Signal): Promise<FicheDuSignal | null> {
  if (s.nom === 'em_link_clicked') return l.ficheParId(tenantId, s.contactId);
  if (s.nom === 'em_conversation_analyzed') {
    const waId = await l.waIdDeLaConversation(tenantId, s.conversationId);
    return waId === null ? null : l.ficheParWaId(tenantId, waId);
  }
  return l.ficheParWaId(tenantId, s.waId);
}

export async function completerSignal(l: LecturesSignal, tenantId: string, s: Signal): Promise<SignalComplet | null> {
  const fiche = await ficheDu(l, tenantId, s);
  if (fiche === null) return null;
  const base = {
    id: s.id,
    le: s.le,
    contact: { contactId: fiche.contactId, externalId: fiche.externalId, optOutWhatsapp: fiche.optOutWhatsapp, optOutRcs: fiche.optOutRcs },
  };
  switch (s.nom) {
    case 'em_message_delivered':
    case 'em_message_read': {
      const ctx = await l.contexteDuMessage(tenantId, s.messageId);
      return { ...base, contenu: { nom: s.nom, canal: s.canal, origine: ctx.origine, sendId: ctx.sendId } };
    }
    case 'em_message_failed': {
      const ctx = await l.contexteDuMessage(tenantId, s.messageId);
      return { ...base, contenu: { nom: s.nom, canal: s.canal, origine: ctx.origine, sendId: ctx.sendId, motif: s.motif, codeMeta: s.codeMeta } };
    }
    case 'em_replied':
      return { ...base, contenu: { nom: s.nom, canal: s.canal, bouton: s.bouton } };
    case 'em_link_clicked': {
      const lien = await l.lien(tenantId, s.lien);
      return { ...base, contenu: { nom: s.nom, lien: s.lien, template: lien?.template ?? null, destination: lien?.destination ?? null } };
    }
    case 'em_opted_out':
      // ⚠️ La source est relue au moment de pousser : un contact réabonné entre-temps rend la source de son
      // réabonnement, donc aucun canal. C'est le sens exact de « le canal n'est dit que s'il est prouvé ».
      return { ...base, contenu: { nom: s.nom, canal: canalDuStop(s, fiche), source: s.canal === 'rcs' ? SOURCE_STOP_RCS : fiche.optInSource } };
    case 'em_conversation_analyzed': {
      const analyse = await l.analyse(tenantId, s.conversationId);
      return analyse === null ? null : { ...base, contenu: { nom: s.nom, analyse } };
    }
  }
}
```

`src/signaux/store.pg.ts` :

```ts
import type { Pool } from 'pg';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { AnalyseDuSignal } from './types';
import type { FicheDuSignal, LecturesSignal } from './completer';

/**
 * Les lectures des signaux, en Postgres. `tenant_id = $1` sur CHAQUE requête : la connexion passe par le pooler
 * en rôle superuser, la RLS est contournée, ce filtre est le seul contrôle.
 */
interface LigneFiche {
  id: string;
  external_id: string | null;
  opt_in_status: string;
  opt_in_source: string | null;
  rcs_optout_at: Date | null;
}
const COLONNES_FICHE = 'id, external_id, opt_in_status, opt_in_source, rcs_optout_at';

function fiche(r: LigneFiche): FicheDuSignal {
  return {
    contactId: r.id,
    externalId: r.external_id,
    optOutWhatsapp: r.opt_in_status === 'opted_out',
    optOutRcs: r.rcs_optout_at !== null,
    optInSource: r.opt_in_source,
  };
}

export class PgSignauxStore implements LecturesSignal {
  constructor(private readonly pool: Pool) {}

  /** Par `wa_id` : numéro (avec ou sans `+`) ou BSUID, par le fragment PARTAGÉ du dépôt, jamais recopié. */
  async ficheParWaId(tenantId: string, waId: string): Promise<FicheDuSignal | null> {
    const res = await this.pool.query<LigneFiche>(
      `select ${COLONNES_FICHE} from contacts
        where tenant_id = $1 and deleted_at is null
        ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0] ? fiche(res.rows[0]) : null;
  }

  async ficheParId(tenantId: string, contactId: string): Promise<FicheDuSignal | null> {
    const res = await this.pool.query<LigneFiche>(
      `select ${COLONNES_FICHE} from contacts where tenant_id = $1 and id = $2 and deleted_at is null`,
      [tenantId, contactId],
    );
    return res.rows[0] ? fiche(res.rows[0]) : null;
  }

  async waIdDeLaConversation(tenantId: string, conversationId: string): Promise<string | null> {
    const res = await this.pool.query<{ wa_id: string }>(
      `select wa_id from conversations where tenant_id = $1 and id = $2`,
      [tenantId, conversationId],
    );
    return res.rows[0]?.wa_id ?? null;
  }

  /**
   * L'origine d'un message sortant et l'envoi auquel il appartient. Trois sous-requêtes sur clé, chacune servie
   * par son index (`conversation_messages_wamid_uidx`, `campaign_recipients_message_id_idx`,
   * `campaign_envois_message_id_idx`), chacune filtrée sur l'espace par sa jointure.
   *
   * 🔴 `campaign_envois` EN REPLI, ET IL N'EST PAS FACULTATIF. `campaign_recipients.message_id` ne garde que la
   * DERNIÈRE tentative d'un destinataire (0134) : l'accusé d'un étage PRÉCÉDENT d'une chaîne de repli (le
   * WhatsApp en échec avant le RCS, ou délivré tard) n'y est plus, et rendrait `sendId` à `null`. Le journal des
   * tentatives, lui, les garde toutes.
   */
  async contexteDuMessage(tenantId: string, messageId: string): Promise<{ origine: string | null; sendId: string | null }> {
    const res = await this.pool.query<{ origine: string | null; send_id: string | null }>(
      `select
         (select m.origin from conversation_messages m join conversations c on c.id = m.conversation_id
           where c.tenant_id = $1 and m.meta_message_id = $2 limit 1) as origine,
         coalesce(
           (select r.campaign_id from campaign_recipients r join campaigns k on k.id = r.campaign_id
             where k.tenant_id = $1 and r.message_id = $2 limit 1),
           (select e.campaign_id from campaign_envois e join campaigns ke on ke.id = e.campaign_id
             where ke.tenant_id = $1 and e.message_id = $2 limit 1)
         ) as send_id`,
      [tenantId, messageId],
    );
    const r = res.rows[0];
    return { origine: r?.origine ?? null, sendId: r?.send_id ?? null };
  }

  async lien(tenantId: string, code: string): Promise<{ template: string | null; destination: string } | null> {
    const res = await this.pool.query<{ template_name: string | null; destination: string }>(
      `select template_name, destination from tracked_links where tenant_id = $1 and code = lower($2)`,
      [tenantId, code],
    );
    const r = res.rows[0];
    return r ? { template: r.template_name, destination: r.destination } : null;
  }

  async analyse(tenantId: string, conversationId: string): Promise<AnalyseDuSignal | null> {
    const res = await this.pool.query<{
      intent: string; sentiment: string; satisfaction: number | null; urgence: number | null; resolved: boolean;
      topic: string; action_suggestion: string; handled_by: string; exchanges_count: number; summary: string | null;
    }>(
      `select intent, sentiment, satisfaction, urgence, resolved, topic, action_suggestion, handled_by,
              exchanges_count, summary
         from conversation_analysis where tenant_id = $1 and conversation_id = $2`,
      [tenantId, conversationId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      intent: r.intent,
      sentiment: r.sentiment,
      satisfaction: r.satisfaction,
      urgence: r.urgence,
      resolved: r.resolved,
      topic: r.topic,
      actionSuggestion: r.action_suggestion,
      handledBy: r.handled_by,
      exchangesCount: r.exchanges_count,
      summary: r.summary,
    };
  }
}
```

`src/signaux/integration-batch.pg.ts` :

```ts
import type { Pool } from 'pg';

/**
 * LE RÉGLAGE DE L'ADAPTATEUR BATCH, une ligne par espace (migration `<N>_signaux_batch`).
 *
 * 🔴 LES CLÉS NE SORTENT JAMAIS EN CLAIR DE CE FICHIER VERS UN ÉCRAN : `lire` ne les sélectionne même pas.
 * Seul `secrets` les rend, CHIFFRÉES, au worker qui pousse.
 *
 * ⚠️ `tenant_id = $1` sur chaque requête qui sert un espace. `espacesActifs` est la SEULE lecture transverse,
 * et c'est délibéré : elle alimente le cache de l'émetteur, qui répond « cet espace a-t-il branché un outil ? »
 * sans une requête par signal. Elle exclut un espace dont les clés ont été refusées : ses signaux ne sont plus
 * enfilés tant qu'il ne les a pas corrigées.
 */
export interface VueIntegrationBatch {
  envoyerResume: boolean;
  sansIdentifiant: number;
  sansIdentifiantLe: string | null;
  refusClesLe: string | null;
  majLe: string;
}

export interface SecretsIntegrationBatch {
  cleRestChiffree: string;
  cleProjetChiffree: string;
  envoyerResume: boolean;
  refusClesLe: string | null;
}

export class PgIntegrationBatchStore {
  constructor(private readonly pool: Pool) {}

  async lire(tenantId: string): Promise<VueIntegrationBatch | null> {
    const res = await this.pool.query<{
      envoyer_resume: boolean; sans_identifiant: string; sans_identifiant_le: Date | null; refus_cles_le: Date | null; maj_le: Date;
    }>(
      // `::text` : un bigint arrive en texte chez node-pg, et le dire ici évite qu'un `Number` implicite le cache.
      `select envoyer_resume, sans_identifiant::text as sans_identifiant, sans_identifiant_le, refus_cles_le, maj_le
         from integration_batch where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      envoyerResume: r.envoyer_resume,
      sansIdentifiant: Number(r.sans_identifiant),
      sansIdentifiantLe: r.sans_identifiant_le?.toISOString() ?? null,
      refusClesLe: r.refus_cles_le?.toISOString() ?? null,
      majLe: r.maj_le.toISOString(),
    };
  }

  async secrets(tenantId: string): Promise<SecretsIntegrationBatch | null> {
    const res = await this.pool.query<{ cle_rest_chiffree: string; cle_projet_chiffree: string; envoyer_resume: boolean; refus_cles_le: Date | null }>(
      `select cle_rest_chiffree, cle_projet_chiffree, envoyer_resume, refus_cles_le from integration_batch where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      cleRestChiffree: r.cle_rest_chiffree,
      cleProjetChiffree: r.cle_projet_chiffree,
      envoyerResume: r.envoyer_resume,
      refusClesLe: r.refus_cles_le?.toISOString() ?? null,
    };
  }

  /**
   * Écrit le réglage. Les clés arrivent DÉJÀ chiffrées ; `null` = garder celle qui est enregistrée.
   *
   * 🔴 `false` = premier branchement sans les DEUX clés : rien n'est écrit (une ligne sans clé ne pousserait
   * rien et ferait croire le contraire). Une clé neuve lève la suspension : c'est le geste qui la corrige.
   */
  async enregistrer(tenantId: string, r: { cleRestChiffree: string | null; cleProjetChiffree: string | null; envoyerResume: boolean }): Promise<boolean> {
    if (r.cleRestChiffree !== null && r.cleProjetChiffree !== null) {
      await this.pool.query(
        `insert into integration_batch (tenant_id, cle_rest_chiffree, cle_projet_chiffree, envoyer_resume)
         values ($1, $2, $3, $4)
         on conflict (tenant_id) do update set
           cle_rest_chiffree = excluded.cle_rest_chiffree,
           cle_projet_chiffree = excluded.cle_projet_chiffree,
           envoyer_resume = excluded.envoyer_resume,
           refus_cles_le = null,
           maj_le = now()`,
        [tenantId, r.cleRestChiffree, r.cleProjetChiffree, r.envoyerResume],
      );
      return true;
    }
    const res = await this.pool.query(
      `update integration_batch set
         cle_rest_chiffree = coalesce($2::text, cle_rest_chiffree),
         cle_projet_chiffree = coalesce($3::text, cle_projet_chiffree),
         envoyer_resume = $4,
         refus_cles_le = case when $2::text is null and $3::text is null then refus_cles_le else null end,
         maj_le = now()
       where tenant_id = $1`,
      [tenantId, r.cleRestChiffree, r.cleProjetChiffree, r.envoyerResume],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async supprimer(tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from integration_batch where tenant_id = $1`, [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  async espacesActifs(): Promise<Set<string>> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from integration_batch where refus_cles_le is null`,
    );
    return new Set(res.rows.map((r) => r.tenant_id));
  }

  async noterSansIdentifiant(tenantId: string, n: number): Promise<void> {
    await this.pool.query(
      `update integration_batch set sans_identifiant = sans_identifiant + $2, sans_identifiant_le = now() where tenant_id = $1`,
      [tenantId, n],
    );
  }

  /** L'outil a refusé les clés (401, 403) : on suspend, une fois, jusqu'à ce qu'on en enregistre de nouvelles. */
  async suspendre(tenantId: string): Promise<void> {
    await this.pool.query(
      `update integration_batch set refus_cles_le = now() where tenant_id = $1 and refus_cles_le is null`,
      [tenantId],
    );
  }
}
```

- [ ] **Step 4 : le voir passer**

```bash
npx vitest run tests/signaux-completer.test.ts tests/signaux-isolation.test.ts && npm run typecheck
```

Attendu : vert.

- [ ] **Step 5 : écrire le test d'intégration (jamais lancé en local)**

`tests/integration/signaux.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgSignauxStore } from '../../src/signaux/store.pg';
import { PgIntegrationBatchStore } from '../../src/signaux/integration-batch.pg';
import { PgJournalAppels } from '../../src/agent/catalog.pg';
import { PgErreursLivraisonStore } from '../../src/ops/erreurs-livraison.pg';
import { PgTrackedLinkStore } from '../../src/links/tracked-links.pg';
import { NOM_APPEL_SIGNAUX } from '../../src/signaux/types';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES LECTURES DES SIGNAUX ET LE RÉGLAGE, contre un VRAI Postgres (lot 6 de l'API publique).
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION) : joué par le job `integration`.
 */
describe.skipIf(!url)('signaux : lectures et réglage (Postgres)', () => {
  let pool: Pool;
  let lectures: PgSignauxStore;
  let reglages: PgIntegrationBatchStore;
  let tenantId: string;
  let autreTenantId: string;
  let contactId: string;
  let conversationId: string;
  let campagneId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    lectures = new PgSignauxStore(pool);
    reglages = new PgIntegrationBatchStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-signaux') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-signaux-autre') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, external_id, opt_in_status, opt_in_source)
       values ($1, '+33600000881', 'crm-itest-1', 'opted_out', 'whatsapp_stop') returning id`,
      [tenantId],
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000881', $2) returning id`,
      [tenantId, contactId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, origin)
       values ($1, 'out', 'text', 'x', 'wamid.itest.signaux.1', 'api')`,
      [conversationId],
    );
    campagneId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, status) values ($1, 'itest-signaux', 'utility', 'completed') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const destinataireId = (await pool.query<{ id: string }>(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, message_id)
       values ($1, $2, '+33600000881', 'sent', 'wamid.itest.signaux.1') returning id`,
      [campagneId, contactId],
    )).rows[0]!.id;
    // Une chaîne de repli : l'étage 1 est parti sous un AUTRE identifiant, que `campaign_recipients.message_id`
    // (la dernière tentative) ne garde plus. Seul le journal des tentatives (0134) le connaît encore.
    await pool.query(
      `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, message_id)
       values ($1, $2, $3, 1, 'whatsapp', 'sent', 'wamid.itest.signaux.etage1'),
              ($1, $2, $3, 2, 'rcs', 'sent', 'wamid.itest.signaux.1')`,
      [campagneId, destinataireId, contactId],
    );
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model, summary, satisfaction, urgence)
       values ($1, $2, 'positif', 'sav', 'livraison', true, 'humain', 4, 'aucune', 0.9, 'j', 'test', 'test', 'Résumé.', null, 3)`,
      [conversationId, tenantId],
    );
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('la fiche se retrouve par wa_id, avec son identifiant externe et son consentement', async () => {
    expect(await lectures.ficheParWaId(tenantId, '33600000881')).toEqual({
      contactId, externalId: 'crm-itest-1', optOutWhatsapp: true, optOutRcs: false, optInSource: 'whatsapp_stop',
    });
    expect((await lectures.ficheParId(tenantId, contactId))?.externalId).toBe('crm-itest-1');
  });

  it('🔴 la fiche d’un espace n’est jamais rendue à un autre', async () => {
    expect(await lectures.ficheParWaId(autreTenantId, '33600000881')).toBeNull();
    expect(await lectures.ficheParId(autreTenantId, contactId)).toBeNull();
    expect(await lectures.waIdDeLaConversation(autreTenantId, conversationId)).toBeNull();
  });

  it('le contexte d’un message : son origine et son envoi', async () => {
    expect(await lectures.contexteDuMessage(tenantId, 'wamid.itest.signaux.1')).toEqual({ origine: 'api', sendId: campagneId });
  });

  it('🔴 le contexte d’un message d’un autre espace reste vide', async () => {
    expect(await lectures.contexteDuMessage(autreTenantId, 'wamid.itest.signaux.1')).toEqual({ origine: null, sendId: null });
  });

  it('🔴 l’accusé d’un étage REMPLACÉ d’une chaîne de repli retrouve quand même son envoi', async () => {
    expect(await lectures.contexteDuMessage(tenantId, 'wamid.itest.signaux.etage1')).toEqual({ origine: null, sendId: campagneId });
    expect(await lectures.contexteDuMessage(autreTenantId, 'wamid.itest.signaux.etage1')).toEqual({ origine: null, sendId: null });
  });

  it('l’analyse relue garde null pour une note absente', async () => {
    expect(await lectures.analyse(tenantId, conversationId)).toMatchObject({ intent: 'sav', satisfaction: null, urgence: 3, summary: 'Résumé.' });
    expect(await lectures.analyse(autreTenantId, conversationId)).toBeNull();
    expect(await lectures.waIdDeLaConversation(tenantId, conversationId)).toBe('33600000881');
  });

  it('le lien : son template et sa destination, dans son espace seulement', async () => {
    const code = await new PgTrackedLinkStore(pool).allocate(
      tenantId, 'itestsig0001', { templateName: 'promo', templateLanguage: 'fr', cardIndex: null, buttonIndex: 0 }, 'https://client.fr/promo', true,
    );
    expect(await lectures.lien(tenantId, code)).toEqual({ template: 'promo', destination: 'https://client.fr/promo' });
    expect(await lectures.lien(autreTenantId, code)).toBeNull();
  });

  it('🔴 un premier branchement sans les deux clés n’écrit rien', async () => {
    expect(await reglages.enregistrer(autreTenantId, { cleRestChiffree: 'x', cleProjetChiffree: null, envoyerResume: false })).toBe(false);
    expect(await reglages.lire(autreTenantId)).toBeNull();
  });

  it('brancher, relire SANS secret, puis modifier l’option sans renvoyer les clés', async () => {
    expect(await reglages.enregistrer(tenantId, { cleRestChiffree: 'chiffre-rest', cleProjetChiffree: 'chiffre-projet', envoyerResume: false })).toBe(true);
    const vue = await reglages.lire(tenantId);
    expect(vue).toMatchObject({ envoyerResume: false, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: null });
    expect(JSON.stringify(vue)).not.toContain('chiffre-');
    expect(await reglages.enregistrer(tenantId, { cleRestChiffree: null, cleProjetChiffree: null, envoyerResume: true })).toBe(true);
    expect(await reglages.secrets(tenantId)).toMatchObject({ cleRestChiffree: 'chiffre-rest', cleProjetChiffree: 'chiffre-projet', envoyerResume: true });
  });

  it('🔴 un espace dont les clés sont refusées sort des espaces actifs, et une clé neuve l’y remet', async () => {
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(true);
    await reglages.suspendre(tenantId);
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(false);
    expect((await reglages.lire(tenantId))?.refusClesLe).not.toBeNull();
    // Changer l'option seule ne lève PAS la suspension : ce ne sont pas de nouvelles clés.
    await reglages.enregistrer(tenantId, { cleRestChiffree: null, cleProjetChiffree: null, envoyerResume: false });
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(false);
    await reglages.enregistrer(tenantId, { cleRestChiffree: 'chiffre-rest-2', cleProjetChiffree: null, envoyerResume: false });
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(true);
  });

  it('le compte des signaux sans identifiant s’additionne et se date', async () => {
    await reglages.noterSansIdentifiant(tenantId, 2);
    await reglages.noterSansIdentifiant(tenantId, 3);
    const vue = await reglages.lire(tenantId);
    expect(vue?.sansIdentifiant).toBe(5);
    expect(vue?.sansIdentifiantLe).not.toBeNull();
  });

  it('🔴 le journal accepte la source signaux (CHECK relâché), et le journal des erreurs la rend', async () => {
    const journal = new PgJournalAppels(pool);
    const id = await journal.ouvrir({
      tenantId, sessionId: null, toolId: null, toolName: NOM_APPEL_SIGNAUX, origin: 'http',
      argsRediges: { signaux: 1, noms: 'em_replied', em_event_id: 'e' }, source: 'signaux',
    });
    await journal.clore({ tenantId, id, status: 'refuse', httpStatus: 401, dureeMs: 50, erreur: 'l’outil branché a répondu 401' });
    const lignes = await new PgErreursLivraisonStore(pool).listerEchecsSysteme(tenantId);
    expect(lignes.map((l) => l.source)).toContain('signaux');
  });

  it('supprimer le réglage', async () => {
    expect(await reglages.supprimer(tenantId)).toBe(true);
    expect(await reglages.supprimer(tenantId)).toBe(false);
    expect(await reglages.lire(tenantId)).toBeNull();
  });
});
```

- [ ] **Step 6 : typage du test d'intégration (sans le lancer)**

```bash
npm run typecheck
```

Attendu : propre. Le verdict du test lui-même se lira sur le job `integration` après le push (tâche 11).

- [ ] **Step 7 : commit (procédure P)**

Chemins : `src/signaux/completer.ts src/signaux/store.pg.ts src/signaux/integration-batch.pg.ts tests/signaux-completer.test.ts tests/signaux-isolation.test.ts tests/integration/signaux.integration.test.ts`. Message : `feat(signaux): lectures generiques, repli sur le journal des tentatives, reglage de l adaptateur en base (lot 6)`.

---

### Task 7 : Le travail de la file (`src/signaux/travail-batch.ts`)

**Files:**
- Create: `src/signaux/travail-batch.ts`
- Create: `tests/signaux-travail-batch.test.ts`

**Interfaces:**
- Consumes : `schemaJobSignaux`, `NOM_APPEL_SIGNAUX`, `Signal`, `SignalComplet` (tâche 2) ; `versBatch`, `BatchApiError`, `ClesBatch`, `ProfilBatch` (tâche 3) ; `StatutAppel` (`src/agent/catalog.ts:37`), `JournalAppels` (`src/agent/catalog.ts:369`) ; `HttpTimeoutError` (`src/meta/http.ts:54`).
- Produces : `interface ReglageBatchClair { cles: ClesBatch; envoyerResume: boolean; suspendu: boolean }`, `interface DepsTravailBatch`, `function creerTravailSignauxBatch(deps: DepsTravailBatch): (data: unknown) => Promise<void>`.

- [ ] **Step 1 : écrire le test qui échoue**

`tests/signaux-travail-batch.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { creerTravailSignauxBatch, type DepsTravailBatch } from '../src/signaux/travail-batch';
import { BatchApiError, type ProfilBatch } from '../src/signaux/batch';
import { signalDeLaReponse, signalAnalyse } from '../src/signaux/emetteur';
import { HttpTimeoutError } from '../src/meta/http';
import type { JournalAppels } from '../src/agent/catalog';
import { NOM_APPEL_SIGNAUX, type Signal, type SignalComplet } from '../src/signaux/types';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const CLES = { cleRest: 'cle-rest-test', cleProjet: 'projet-test' };
const REPONSE = signalDeLaReponse({ messageId: 'wamid.in1', waId: '33612345678', bouton: 'Oui' }, 'whatsapp');
const JOB = { tenantId: T, signaux: [REPONSE] };

function complet(s: Signal, externalId: string | null = 'crm-7781'): SignalComplet {
  const contact = { contactId: C, externalId, optOutWhatsapp: false, optOutRcs: false };
  if (s.nom === 'em_conversation_analyzed') {
    return { id: s.id, le: s.le, contact, contenu: { nom: s.nom, analyse: {
      intent: 'sav', sentiment: 'neutre', satisfaction: 5, urgence: 1, resolved: true, topic: 't',
      actionSuggestion: 'aucune', handledBy: 'humain', exchangesCount: 2, summary: 'Propos du client.',
    } } };
  }
  return { id: s.id, le: s.le, contact, contenu: { nom: 'em_replied', canal: 'whatsapp', bouton: 'Oui' } };
}

function monter(over: Partial<DepsTravailBatch> = {}) {
  const trace = {
    pousses: [] as ProfilBatch[][],
    journal: [] as Array<Record<string, unknown>>,
    sansId: [] as number[],
    suspendus: [] as string[],
    completes: 0,
  };
  const journal: JournalAppels = {
    ouvrir: async (i) => { trace.journal.push({ ouvert: i }); return 'ligne-1'; },
    clore: async (i) => { trace.journal.push({ clos: i }); },
  };
  const deps: DepsTravailBatch = {
    reglage: async () => ({ cles: CLES, envoyerResume: false, suspendu: false }),
    completer: async (_t, s) => { trace.completes += 1; return complet(s); },
    pousser: async (r) => { trace.pousses.push(r); return { partiel: null }; },
    noterSansIdentifiant: async (_t, n) => { trace.sansId.push(n); },
    suspendre: async (t) => { trace.suspendus.push(t); },
    journal,
    maintenant: () => 1000,
    ...over,
  };
  return { travail: creerTravailSignauxBatch(deps), trace };
}

describe('le travail de la file signaux-batch', () => {
  it('🔴 un job hors contrat lève (la file le rejoue puis le range en DLQ)', async () => {
    await expect(monter().travail({ tenantId: T, signaux: [{ nom: 'em_inconnu' }] })).rejects.toThrow(/payload invalide/);
    await expect(monter().travail({ tenantId: T, signaux: [] })).rejects.toThrow(/payload invalide/);
  });

  it('🔴 un job de plusieurs signaux : chacun complété une fois, UN appel pour tous', async () => {
    const signaux = ['a', 'b', 'c'].map((x) => signalDeLaReponse({ messageId: `wamid.${x}`, waId: '33612345678', bouton: null }, 'whatsapp'));
    const { travail, trace } = monter();
    await travail({ tenantId: T, signaux });
    expect(trace.completes).toBe(3);
    expect(trace.pousses).toHaveLength(1);
    expect(trace.pousses[0]![0]!.events).toHaveLength(3);
  });

  it('🔴 un 4xx sur une tranche n’empêche pas la suivante', async () => {
    // Seize événements d'une même fiche : deux appels (quinze, puis un).
    const signaux = Array.from({ length: 16 }, (_, i) => signalDeLaReponse({ messageId: `wamid.in${i}`, waId: '33612345678', bouton: null }, 'whatsapp'));
    let appels = 0;
    const { travail, trace } = monter({
      pousser: async (r) => { appels += 1; if (appels === 1) throw new BatchApiError(400, false, 'x'); trace.pousses.push(r); return { partiel: null }; },
    });
    await expect(travail({ tenantId: T, signaux })).resolves.toBeUndefined();
    expect(appels).toBe(2);
    expect(trace.pousses).toHaveLength(1);
  });

  it('un espace débranché depuis l’émission : rien, sans rien relire', async () => {
    const { travail, trace } = monter({ reglage: async () => null });
    await travail(JOB);
    expect(trace.completes).toBe(0);
    expect(trace.pousses).toEqual([]);
  });

  it('un espace suspendu (clés refusées) : rien', async () => {
    const { travail, trace } = monter({ reglage: async () => ({ cles: CLES, envoyerResume: false, suspendu: true }) });
    await travail(JOB);
    expect(trace.pousses).toEqual([]);
  });

  it('une fiche disparue : rien, et ce n’est pas un échec', async () => {
    const { travail, trace } = monter({ completer: async () => null });
    await expect(travail(JOB)).resolves.toBeUndefined();
    expect(trace.pousses).toEqual([]);
  });

  it('🔴 une fiche SANS externalId : comptée, jamais poussée', async () => {
    const { travail, trace } = monter({ completer: async (_t, s) => complet(s, null) });
    await travail(JOB);
    expect(trace.sansId).toEqual([1]);
    expect(trace.pousses).toEqual([]);
  });

  it('le cas nominal : un appel, avec les clés, et aucune ligne de journal', async () => {
    let clesVues: unknown = null;
    const { travail, trace } = monter({ pousser: async (r, cles) => { trace.pousses.push(r); clesVues = cles; return { partiel: null }; } });
    await travail(JOB);
    expect(trace.pousses).toHaveLength(1);
    expect(trace.pousses[0]![0]!.identifiers).toEqual({ custom_id: 'crm-7781' });
    expect(clesVues).toEqual(CLES);
    expect(trace.journal).toEqual([]);
  });

  it('🔴 le résumé ne part que si l’espace l’a demandé', async () => {
    const analyse = { tenantId: T, signaux: [signalAnalyse(C)] };
    const sans = monter();
    await sans.travail(analyse);
    expect(sans.trace.pousses[0]![0]!.events?.[0]?.attributes).not.toHaveProperty('summary_1');
    const avec = monter({ reglage: async () => ({ cles: CLES, envoyerResume: true, suspendu: false }) });
    await avec.travail(analyse);
    expect(avec.trace.pousses[0]![0]!.events?.[0]?.attributes.summary_1).toBe('Propos du client.');
  });

  it('un succès partiel s’écrit dans le journal, sans relance', async () => {
    const { travail, trace } = monter({ pousser: async () => ({ partiel: 'em_last_intent : invalid value' }) });
    await expect(travail(JOB)).resolves.toBeUndefined();
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'erreur_outil', httpStatus: 202, erreur: 'em_last_intent : invalid value' }) });
  });

  it('🔴 un 4xx est TERMINAL : une ligne de journal, et le job NE lève PAS (la file ne le rejoue pas)', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(400, false, 'custom_id too long'); } });
    await expect(travail(JOB)).resolves.toBeUndefined();
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'refuse', httpStatus: 400 }) });
    expect(trace.suspendus).toEqual([]);
  });

  it('🔴 des clés refusées (401, 403) SUSPENDENT la remontée : une seule ligne au lieu d’une par signal', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(401, false, 'invalid key'); } });
    await travail(JOB);
    expect(trace.suspendus).toEqual([T]);
  });

  it('🔴 un 5xx épuisé s’écrit ET lève : la file le rejouera', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(503, true, null); } });
    await expect(travail(JOB)).rejects.toBeInstanceOf(BatchApiError);
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'erreur_outil', httpStatus: 503 }) });
  });

  it('un délai dépassé s’écrit « timeout » et lève', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new HttpTimeoutError('https://api.batch.com/x', 30000); } });
    await expect(travail(JOB)).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'timeout' }) });
  });

  it('🔴 la ligne de journal ne porte aucune donnée de la personne, ni le nom de l’outil', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(400, false, null); } });
    await travail(JOB);
    expect(trace.journal).toContainEqual({ ouvert: expect.objectContaining({
      toolName: NOM_APPEL_SIGNAUX, source: 'signaux', sessionId: null,
      argsRediges: { signaux: 1, noms: 'em_replied', em_event_id: REPONSE.id },
    }) });
    expect(JSON.stringify(trace.journal)).not.toContain('33612345678');
    // Le libellé ET le message d'erreur s'affichent dans Sécurité > Journal des erreurs (spec § 10).
    expect(JSON.stringify(trace.journal)).not.toMatch(/batch/i);
  });

  it('🔴 un journal en panne n’avale pas la relance d’un échec rejouable', async () => {
    const journalCasse: JournalAppels = { ouvrir: async () => { throw new Error('base indisponible'); }, clore: async () => {} };
    const { travail } = monter({ journal: journalCasse, pousser: async () => { throw new BatchApiError(500, true, null); } });
    await expect(travail(JOB)).rejects.toBeInstanceOf(BatchApiError);
  });
});
```

- [ ] **Step 2 : le voir échouer**

```bash
npx vitest run tests/signaux-travail-batch.test.ts
```

Attendu : ÉCHEC à l'import (`Failed to load url ../src/signaux/travail-batch`).

- [ ] **Step 3 : écrire le travail**

`src/signaux/travail-batch.ts` :

```ts
import type { JournalAppels, StatutAppel } from '../agent/catalog';
import { HttpTimeoutError } from '../meta/http';
import { BatchApiError, versBatch, type ClesBatch, type ProfilBatch } from './batch';
import { NOM_APPEL_SIGNAUX, schemaJobSignaux, type Signal, type SignalComplet } from './types';

/** Le réglage d'un espace, DÉCHIFFRÉ par le câblage. `suspendu` = l'outil a refusé les clés. */
export interface ReglageBatchClair {
  cles: ClesBatch;
  envoyerResume: boolean;
  suspendu: boolean;
}

export interface DepsTravailBatch {
  /** Relu à CHAQUE job : l'espace a pu débrancher l'outil, ou changer l'option, depuis l'émission. */
  reglage(tenantId: string): Promise<ReglageBatchClair | null>;
  completer(tenantId: string, signal: Signal): Promise<SignalComplet | null>;
  pousser(requete: ProfilBatch[], cles: ClesBatch): Promise<{ partiel: string | null }>;
  noterSansIdentifiant(tenantId: string, n: number): Promise<void>;
  suspendre(tenantId: string): Promise<void>;
  journal: JournalAppels;
  maintenant?: () => number;
  log?: (message: string) => void;
}

const texte = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Le travail de la file `signaux-batch` (spec 2026-09-24, § 8). Un job = UN espace, de 1 à `SIGNAUX_PAR_JOB`
 * signaux, complétés un par un puis traduits ENSEMBLE (`versBatch` regroupe par fiche et découpe aux bornes).
 *
 * - Un job hors contrat LÈVE : la file le rejoue puis le range en DLQ, visible de `/ops`.
 * - Un 4xx est TERMINAL : une ligne dans la moitié « système » du journal des erreurs, et la tranche suivante
 *   part quand même (une fiche refusée ne doit pas bloquer les autres). 401 et 403 SUSPENDENT en plus la
 *   remontée, jusqu'à de nouvelles clés, et arrêtent le job : les mêmes clés échoueraient sur chaque tranche, et
 *   chaque signal écrirait sa ligne dans `agent_tool_calls`, que rien ne purge.
 * - 429, 5xx, panne réseau : déjà rejoués par `pousserVersBatch` ; épuisés, ils s'écrivent ET lèvent, et la file
 *   rejoue le job ENTIER plus tard, tranches déjà passées comprises. Les mêmes `em_event_id` repartent : l'outil
 *   peut dédupliquer, et un attribut de fiche réécrit à l'identique ne coûte rien.
 * - La ligne de journal ne porte que le nombre de signaux, leurs NOMS et l'`em_event_id` du premier, jamais une
 *   donnée de la personne ; son libellé (`NOM_APPEL_SIGNAUX`) ne nomme pas l'outil.
 */
export function creerTravailSignauxBatch(deps: DepsTravailBatch): (data: unknown) => Promise<void> {
  const maintenant = deps.maintenant ?? Date.now;

  const journaliser = async (
    tenantId: string, signaux: readonly Signal[], statut: StatutAppel, debut: number, erreur: string, httpStatus?: number,
  ): Promise<void> => {
    try {
      const id = await deps.journal.ouvrir({
        tenantId, sessionId: null, toolId: null, toolName: NOM_APPEL_SIGNAUX, origin: 'http',
        argsRediges: {
          signaux: signaux.length,
          noms: [...new Set(signaux.map((s) => s.nom))].sort().join(','),
          em_event_id: signaux[0]?.id ?? null,
        },
        source: 'signaux',
      });
      await deps.journal.clore({
        tenantId, id, status: statut, ...(httpStatus !== undefined ? { httpStatus } : {}),
        dureeMs: maintenant() - debut, erreur: erreur.slice(0, 500),
      });
    } catch (err) {
      deps.log?.(`signaux-batch: journal impossible pour ${tenantId}: ${texte(err)}`);
    }
  };

  return async (data) => {
    const job = schemaJobSignaux.safeParse(data);
    if (!job.success) {
      const i = job.error.issues[0];
      throw new Error(`signaux-batch : payload invalide (${i ? `${i.path.join('.')} ${i.message}` : 'forme'})`);
    }
    const { tenantId, signaux } = job.data;

    const reglage = await deps.reglage(tenantId);
    if (reglage === null || reglage.suspendu) return;

    // Un à un : chaque lecture est sur clé, et un job en porte au plus `SIGNAUX_PAR_JOB`.
    const complets: SignalComplet[] = [];
    for (const s of signaux) {
      const c = await deps.completer(tenantId, s);
      if (c !== null) complets.push(c);
    }
    if (complets.length === 0) return;

    const { requetes, sansIdentifiant } = versBatch(complets, { resume: reglage.envoyerResume });
    if (sansIdentifiant > 0) {
      try {
        await deps.noterSansIdentifiant(tenantId, sansIdentifiant);
      } catch (err) {
        deps.log?.(`signaux-batch: compte sans identifiant non ecrit pour ${tenantId}: ${texte(err)}`);
      }
    }

    for (const requete of requetes) {
      const debut = maintenant();
      try {
        const r = await deps.pousser(requete, reglage.cles);
        if (r.partiel !== null) await journaliser(tenantId, signaux, 'erreur_outil', debut, r.partiel, 202);
      } catch (err) {
        if (err instanceof BatchApiError && !err.retryable) {
          await journaliser(tenantId, signaux, 'refuse', debut, err.message, err.status);
          if (err.status === 401 || err.status === 403) {
            try {
              await deps.suspendre(tenantId);
            } catch (e) {
              deps.log?.(`signaux-batch: suspension non ecrite pour ${tenantId}: ${texte(e)}`);
            }
            return;
          }
          continue;
        }
        await journaliser(
          tenantId, signaux, err instanceof HttpTimeoutError ? 'timeout' : 'erreur_outil', debut, texte(err),
          err instanceof BatchApiError ? err.status : undefined,
        );
        throw err;
      }
    }
  };
}
```

- [ ] **Step 4 : le voir passer**

```bash
npx vitest run tests/signaux-travail-batch.test.ts && npm run typecheck
```

Attendu : vert.

- [ ] **Step 5 : commit (procédure P)**

Chemins : `src/signaux/travail-batch.ts tests/signaux-travail-batch.test.ts`. Message : `feat(signaux): travail de la file signaux-batch, jobs groupes, 4xx terminal et suspension sur cles refusees (lot 6)`.

---

### Task 8 : Les routes du réglage (`/tenants/:tenantId/integrations/batch`)

**Files:**
- Create: `src/http/integration-batch.ts`
- Create: `tests/http-integration-batch.test.ts`
- Modify: `src/server.ts:10` (import), `:85` (import de type), `:160` (`ServerDeps`), `:458` (registre, après l'entrée `rcsChannel`)
- Modify: `src/audit/store.pg.ts:117` (`AuditAction`)
- Modify: `web/lib/journal.ts:18` (`ACTIONS_JOURNAL`)

**Interfaces:**
- Consumes : `VueIntegrationBatch` (tâche 6) ; `Guard` (`src/auth/middleware.ts`), `scopeTenant` (`src/http/scope.ts`), `makeJournal`, `AuditSink` (`src/audit/journal.ts`).
- Produces : `interface IntegrationBatchRouteDeps { lire; enregistrer(tenantId, r: { cleRest?: string; cleProjet?: string; envoyerResume: boolean }): Promise<boolean>; supprimer; chiffrementPret: boolean; audit? }` (`chiffrementPret` REQUIS : `ENCRYPTION_KEY` vaut `''` par défaut, `src/config.ts:38`, et la configuration ne l'exige que pour le Gateway, l'inscription Meta et les publicités ; sans elle, `encryptSecret` lève, donc un 500 et une page Cloudflare au lieu d'un refus lisible) ; `registerIntegrationBatch(app, deps, garde: Guard)` ; `GET|PUT|DELETE /tenants/:tenantId/integrations/batch` (admin) rendant `{ branche: false }` ou `{ branche: true, envoyerResume, sansIdentifiant, sansIdentifiantLe, refusClesLe, majLe }` ; `AuditAction` += `integration.branchee`, `integration.modifiee`, `integration.debranchee` ; `ServerDeps.integrationBatch?`.

- [ ] **Step 1 : écrire le test qui échoue**

`tests/http-integration-batch.test.ts` :

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { IntegrationBatchRouteDeps } from '../src/http/integration-batch';
import type { VueIntegrationBatch } from '../src/signaux/integration-batch.pg';

const SECRET = 'test-secret';
let admin = '';
let agent = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const en = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });
const URL_T1 = '/tenants/t1/integrations/batch';
const VUE: VueIntegrationBatch = {
  envoyerResume: false, sansIdentifiant: 12, sansIdentifiantLe: '2026-09-24T09:00:00.000Z', refusClesLe: null, majLe: '2026-09-24T08:00:00.000Z',
};

function monter(initial: VueIntegrationBatch | null = null, chiffrementPret = true) {
  const trace = {
    enregistre: [] as Array<{ tenant: string; r: { cleRest?: string; cleProjet?: string; envoyerResume: boolean } }>,
    supprime: [] as string[],
    audit: [] as Array<{ action: string; detail: unknown }>,
  };
  let ligne = initial;
  const deps: IntegrationBatchRouteDeps = {
    chiffrementPret,
    lire: async () => ligne,
    enregistrer: async (tenant, r) => {
      trace.enregistre.push({ tenant, r });
      if (ligne === null && (r.cleRest === undefined || r.cleProjet === undefined)) return false;
      ligne = { envoyerResume: r.envoyerResume, sansIdentifiant: ligne?.sansIdentifiant ?? 0, sansIdentifiantLe: null, refusClesLe: null, majLe: '2026-09-24T10:00:00.000Z' };
      return true;
    },
    supprimer: async (tenant) => { trace.supprime.push(tenant); const avait = ligne !== null; ligne = null; return avait; },
    audit: async (_t, _acteur, action, _cible, detail) => { trace.audit.push({ action, detail }); },
  };
  const app = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, integrationBatch: deps });
  return { app, trace };
}

describe('le réglage de l’adaptateur Batch', () => {
  it('non branché : la lecture le dit', async () => {
    const { app } = monter();
    const r = await app.inject({ method: 'GET', url: URL_T1, ...en(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ branche: false });
  });

  it('branché : la lecture rend le compte des signaux non poussés, et jamais les clés', async () => {
    const { app } = monter(VUE);
    const r = await app.inject({ method: 'GET', url: URL_T1, ...en(admin) });
    expect(r.json()).toEqual({ branche: true, ...VUE });
  });

  it('🔴 un premier branchement sans les DEUX clés est refusé, sans rien écrire', async () => {
    const { app, trace } = monter();
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { cleRest: 'k', envoyerResume: false } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/clé REST et la clé de projet/);
    expect(trace.audit).toEqual([]);
  });

  it('brancher : clés détourées, réponse SANS clé, audit sans clé', async () => {
    const { app, trace } = monter();
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { cleRest: '  rest-1  ', cleProjet: 'projet-1', envoyerResume: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ branche: true, envoyerResume: false });
    expect(trace.enregistre).toEqual([{ tenant: 't1', r: { cleRest: 'rest-1', cleProjet: 'projet-1', envoyerResume: false } }]);
    expect(JSON.stringify(r.json())).not.toContain('rest-1');
    expect(trace.audit).toEqual([{ action: 'integration.branchee', detail: { outil: 'batch', envoyerResume: false, clesChangees: true } }]);
    expect(JSON.stringify(trace.audit)).not.toContain('rest-1');
  });

  it('modifier l’option sans renvoyer les clés', async () => {
    const { app, trace } = monter(VUE);
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { envoyerResume: true } });
    expect(r.statusCode).toBe(200);
    expect(trace.enregistre[0]!.r).toEqual({ envoyerResume: true });
    expect(trace.audit).toEqual([{ action: 'integration.modifiee', detail: { outil: 'batch', envoyerResume: true, clesChangees: false } }]);
  });

  it('🔴 un corps hors contrat est refusé AVANT toute écriture (clé inconnue, option absente, clé vide)', async () => {
    const { app, trace } = monter(VUE);
    for (const payload of [{ envoyerResume: true, url: 'https://ailleurs' }, { cleRest: 'k' }, { cleRest: '', envoyerResume: false }]) {
      const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(trace.enregistre).toEqual([]);
  });

  it('🔴 sans clé de chiffrement sur l’instance : des clés reçues sont refusées LISIBLEMENT, rien n’est écrit', async () => {
    const { app, trace } = monter(null, false);
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { cleRest: 'k', cleProjet: 'p', envoyerResume: false } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/chiffrement/);
    expect(trace.enregistre).toEqual([]);
    expect(trace.audit).toEqual([]);
  });

  it('sans clé de chiffrement, changer la seule option reste possible (rien à chiffrer)', async () => {
    const { app } = monter(VUE, false);
    const r = await app.inject({ method: 'PUT', url: URL_T1, ...en(admin), payload: { envoyerResume: true } });
    expect(r.statusCode).toBe(200);
  });

  it('débrancher, puis débrancher ce qui ne l’est plus', async () => {
    const { app, trace } = monter(VUE);
    expect((await app.inject({ method: 'DELETE', url: URL_T1, ...en(admin) })).json()).toEqual({ branche: false });
    expect(trace.audit).toEqual([{ action: 'integration.debranchee', detail: { outil: 'batch' } }]);
    expect((await app.inject({ method: 'DELETE', url: URL_T1, ...en(admin) })).statusCode).toBe(404);
  });

  it('🔴 un AGENT ne lit ni n’écrit rien : les clés de l’espace sont une décision d’admin', async () => {
    const { app, trace } = monter(VUE);
    expect((await app.inject({ method: 'GET', url: URL_T1, ...en(agent) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: URL_T1, ...en(agent), payload: { envoyerResume: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: URL_T1, ...en(agent) })).statusCode).toBe(403);
    expect(trace.enregistre).toEqual([]);
    expect(trace.supprime).toEqual([]);
  });

  it('🔴 l’espace d’un autre client dans l’adresse : refusé', async () => {
    const { app, trace } = monter(VUE);
    expect((await app.inject({ method: 'GET', url: '/tenants/t2/integrations/batch', ...en(admin) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/tenants/t2/integrations/batch', ...en(admin) })).statusCode).toBe(403);
    expect(trace.supprime).toEqual([]);
  });
});
```

- [ ] **Step 2 : le voir échouer**

```bash
npx vitest run tests/http-integration-batch.test.ts
```

Attendu : ÉCHEC à l'import (`Failed to load url ../src/http/integration-batch`).

- [ ] **Step 3 : écrire la route, l'audit et le montage**

`src/http/integration-batch.ts` :

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { makeJournal, type AuditSink } from '../audit/journal';
import { scopeTenant } from './scope';
import type { VueIntegrationBatch } from '../signaux/integration-batch.pg';

/**
 * PARAMÈTRES > INTÉGRATIONS > BATCH (spec 2026-09-24, § 8) : brancher l'outil qui reçoit les signaux.
 *
 * 🔴 RÉSERVÉ AUX ADMINS, LECTURE COMPRISE (montée sous `g.admin`) : ces clés font sortir des données de
 * contacts de l'espace, c'est une décision de la marque, comme un connecteur.
 *
 * 🔴 LES CLÉS NE REVIENNENT JAMAIS : ni dans une réponse, ni dans le journal d'audit. Le chiffrement se fait
 * dans le câblage (`enregistrer`), jamais ici.
 */
export interface IntegrationBatchRouteDeps {
  lire(tenantId: string): Promise<VueIntegrationBatch | null>;
  /** Chiffre les clés reçues et écrit. `false` = premier branchement sans les DEUX clés : rien n'est écrit. */
  enregistrer(tenantId: string, r: { cleRest?: string; cleProjet?: string; envoyerResume: boolean }): Promise<boolean>;
  supprimer(tenantId: string): Promise<boolean>;
  /**
   * L'instance sait-elle CHIFFRER une clé ? REQUIS, et calculé une fois au câblage. `ENCRYPTION_KEY` vaut `''`
   * par défaut et la configuration ne l'exige que pour d'autres fonctions : sans elle, `encryptSecret` lève, et
   * la route rendrait 500 (une page Cloudflare sans explication) au lieu d'un refus que l'écran peut afficher.
   */
  chiffrementPret: boolean;
  audit?: AuditSink;
}

/** Le corps du réglage, lu comme une entrée externe. `.strict()` : une clé inconnue est une faute, pas un ajout. */
const corpsReglage = z.object({
  cleRest: z.string().trim().min(1).max(256).optional(),
  cleProjet: z.string().trim().min(1).max(256).optional(),
  envoyerResume: z.boolean(),
}).strict();

const vue = (v: VueIntegrationBatch | null) => (v === null ? { branche: false } : { branche: true, ...v });
const CIBLE = { kind: 'integration', id: 'batch' };

export function registerIntegrationBatch(app: FastifyInstance, deps: IntegrationBatchRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send(vue(await deps.lire(tenant)));
  });

  app.put('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const corps = corpsReglage.safeParse(req.body ?? {});
    if (!corps.success) {
      const i = corps.error.issues[0];
      return reply.code(400).send({ error: `${i && i.path.length > 0 ? i.path.join('.') : 'corps'} : ${i?.message ?? 'invalide'}` });
    }
    const { cleRest, cleProjet, envoyerResume } = corps.data;
    if ((cleRest !== undefined || cleProjet !== undefined) && !deps.chiffrementPret) {
      // Même patron que les routes dont la configuration manque (publicités, installation HubSpot) : 503, et
      // une phrase que l'écran affiche telle quelle. Changer la seule option ne chiffre rien et reste permis.
      return reply.code(503).send({ error: 'Le chiffrement des secrets n’est pas configuré sur cette instance : impossible d’enregistrer des clés.' });
    }
    const avant = await deps.lire(tenant);
    const fait = await deps.enregistrer(tenant, {
      ...(cleRest !== undefined ? { cleRest } : {}),
      ...(cleProjet !== undefined ? { cleProjet } : {}),
      envoyerResume,
    });
    if (!fait) return reply.code(400).send({ error: 'La clé REST et la clé de projet sont requises pour brancher Batch.' });
    await journal(tenant, req, avant === null ? 'integration.branchee' : 'integration.modifiee', CIBLE, {
      outil: 'batch', envoyerResume, clesChangees: cleRest !== undefined || cleProjet !== undefined,
    });
    return reply.code(200).send(vue(await deps.lire(tenant)));
  });

  app.delete('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!(await deps.supprimer(tenant))) return reply.code(404).send({ error: 'Batch n’est pas branché sur cet espace.' });
    await journal(tenant, req, 'integration.debranchee', CIBLE, { outil: 'batch' });
    return reply.code(200).send({ branche: false });
  });
}
```

Dans `src/audit/store.pg.ts`, la dernière ligne de `AuditAction`, `| 'pubs.reprise';`, devient :

```ts
  | 'pubs.reprise'
  /**
   * LE BRANCHEMENT D'UN OUTIL QUI REÇOIT LES SIGNAUX (lot 6 de l'API publique, 2026-09-24). Même famille que
   * `connecteur.cree` : c'est par lui que des données de contacts QUITTENT l'espace. Le détail ne porte jamais
   * les clés, seulement l'outil, l'option du résumé et le fait que les clés ont changé.
   */
  | 'integration.branchee'
  | 'integration.modifiee'
  | 'integration.debranchee';
```

Dans `web/lib/journal.ts`, après `'conversation.effacee': [...],` :

```ts
  'integration.branchee': ['Outil branché sur les signaux', 'Tool connected to signals'],
  'integration.modifiee': ['Réglage d’un outil modifié', 'Tool settings changed'],
  'integration.debranchee': ['Outil débranché', 'Tool disconnected'],
```

Dans `src/server.ts` (fichier de câblage PARTAGÉ : annoncer l'édition aux autres sessions) :

```ts
import { registerIntegrationBatch } from './http/integration-batch';
```

(avec les autres `register…`, près de la ligne 10)

```ts
import type { IntegrationBatchRouteDeps } from './http/integration-batch';
```

(avec les autres imports de type, près de la ligne 85)

Dans `ServerDeps`, après `rcsChannel?: RcsChannelRouteDeps;` :

```ts
  /** Paramètres > Intégrations > Batch : l'outil qui reçoit les signaux (lot 6 de l'API publique). Admin, lecture comprise. */
  integrationBatch?: IntegrationBatchRouteDeps;
```

Dans `modulesDeRoutes`, après l'entrée `entree('rcsChannel', ...)` :

```ts
    entree('integrationBatch', 'tenant', deps.integrationBatch, (app, d, g) => registerIntegrationBatch(app, d, g.admin)),
```

- [ ] **Step 4 : le voir passer, et le garde-fou d'authentification couvrir le nouveau module**

```bash
npx vitest run tests/http-integration-batch.test.ts tests/scope-tenant.test.ts && npm run typecheck
```

Attendu : vert. `tests/scope-tenant.test.ts` porte désormais un cas « integrationBatch monté seul, sans auth : le serveur refuse de démarrer », DÉRIVÉ du registre sans qu'on l'écrive.

- [ ] **Step 5 : commit (procédure P ; `src/server.ts` est un câblage partagé, son édition a été annoncée)**

Chemins : `src/http/integration-batch.ts tests/http-integration-batch.test.ts src/server.ts src/audit/store.pg.ts web/lib/journal.ts`. L'étape 1 de P (`git diff origin/main -- <chemins>`) ne doit montrer que ses hunks ; un hunk étranger dans `src/server.ts` impose P' à ce fichier. Message : `feat(signaux): routes du reglage de l adaptateur, admin, cles jamais relues, 503 lisible sans chiffrement (lot 6)`.

---

### Task 9 : Le câblage de l'API (liens suivis, RCS, désabonnements, réglage)

**Files:**
- Modify: `src/http/links.ts:25-43` (`LinksRouteDeps`) et `:116-120` (après l'enregistrement du clic)
- Modify: `tests/http-links.test.ts:15-26` (fixture `app`) et fin du `describe`
- Modify: `src/index.ts` (fichier de câblage PARTAGÉ) : imports (près de `:28` et `:128`), émetteur avant le dépôt des contacts (`:196-214`), `links` (`:756-762`), `integrationBatch` (avant `rcsChannel:`, `:2608`), `onDlr` (le câblage `onDlr: (tenant, dlr) => traiterRapportRcs({ … }, tenant, dlr),` que le lot 3 y a posé), `onMo` (`:2672-2690`)
- Create: `tests/signaux-cablage.test.ts`

**Interfaces:**
- Consumes : `creerEmetteur`, `annoncerAussiAuxSignaux`, `signalDeLAccuse`, `signalDeLaReponse`, `signalDesabonnement`, `signalDuClic`, `DUREE_CACHE_ESPACES_ACTIFS_MS` (tâche 5) ; `FILE_SIGNAUX_BATCH` (tâche 3) ; `PgIntegrationBatchStore` (tâche 6) ; `IntegrationBatchRouteDeps` (tâche 8) ; `encryptSecret` (`src/crypto/secretbox.ts:29`) ; `cacheCourt` (`src/lib/cache-court.ts`).
- Produces : `LinksRouteDeps.signalerClic(tenantId: string, contactId: string, code: string): Promise<void>` (REQUIS) ; l'API émet les signaux RCS, les clics attribués, et les désabonnements qu'elle écrit.

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `tests/http-links.test.ts` : l'interface `Capture` gagne `signaux: Array<{ tenantId: string; contactId: string; code: string }>;`, l'initialisation `const cap: Capture = { clics: [], lus: [], signaux: [] };`, et la fixture `links` gagne, après `recordClick` :

```ts
    signalerClic: async (tenantId, contactId, code) => { cap.signaux.push({ tenantId, contactId, code }); },
```

Ajouter à la fin du `describe('redirection publique /r/:code', ...)` :

```ts
  it('🔴 un clic ATTRIBUÉ remonte comme signal, dans l’espace du LIEN', async () => {
    const jeton = 'abcdefghjkmnpqrs';
    const { server, cap } = app({ contactParJeton: async (t, j) => (t === 't1' && j === jeton ? 'contact-1' : null) });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${jeton}` });
    expect(res.statusCode).toBe(302);
    expect(cap.signaux).toEqual([{ tenantId: 't1', contactId: 'contact-1', code: CODE }]);
    await server.close();
  });

  it('un clic ANONYME ne remonte pas : sans fiche, il n’y a pas de profil à mettre à jour', async () => {
    const { server, cap } = app();
    await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(cap.clics).toHaveLength(1);
    expect(cap.signaux).toEqual([]);
    await server.close();
  });

  it('🔴 un clic de robot ne remonte pas non plus', async () => {
    const { server, cap } = app({ contactParJeton: async () => 'contact-1' });
    await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs`, headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    expect(cap.signaux).toEqual([]);
    await server.close();
  });

  it('🔴 un signal en panne REDIRIGE quand même', async () => {
    const { server } = app({ contactParJeton: async () => 'contact-1', signalerClic: async () => { throw new Error('file pleine'); } });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/promo');
    await server.close();
  });

  it('🔴 la redirection n’ATTEND PAS le signal : une file lente ne retarde aucun clic', async () => {
    // Un signal qui ne se termine jamais : si la route l'attendait, `inject` ne rendrait jamais la main.
    const { server } = app({ contactParJeton: async () => 'contact-1', signalerClic: () => new Promise<void>(() => {}) });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs` });
    expect(res.statusCode).toBe(302);
    await server.close();
  });
```

Créer `tests/signaux-cablage.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DES SIGNAUX, lu dans le CODE et pas dans la prose (spec 2026-09-24, § 8).
 *
 * Le typage impose déjà une partie des branchements (le puits des accusés et celui des réponses sont requis
 * par `handleWebhookJob`, le signal du clic par `LinksRouteDeps`). Ce test garde ce que le typage ne voit pas :
 * les dépendances optionnelles (l'annonce d'opt-out du dépôt des contacts) et les fermetures écrites en ligne
 * (les rappels RCS, la sortie de l'analyse).
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const api = sansCommentaires(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));

describe('le câblage des signaux dans l’API', () => {
  it('🔴 les désabonnements écrits par l’API (fiche, action en masse, API publique) deviennent des signaux', () => {
    expect(api).toMatch(/new PgContactStore\(\s*pool,\s*annoncerAussiAuxSignaux\(/);
  });

  it('🔴 le rapport de livraison RCS remonte ses accusés', () => {
    expect(api).toMatch(/signalDeLAccuse\(\{ messageId: dlr\.messageId/);
  });

  it('🔴 la réponse RCS et son STOP remontent', () => {
    expect(api).toMatch(/signalDeLaReponse\(\{\s*messageId: mo\.messageId/);
    expect(api).toMatch(/signalDesabonnement\(mo\.from, 'rcs'\)/);
  });

  it('le clic attribué remonte', () => {
    expect(api).toMatch(/signalerClic: \(tenant, contactId, code\) => emetteur\.emettreSignal\(tenant, signalDuClic\(contactId, code\)\)/);
  });

  it('🔴 le réglage invalide le cache de l’émetteur de l’API (enregistrer ET débrancher)', () => {
    expect(api.match(/espacesBatch\.invalider\('actifs'\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2 : les voir échouer**

```bash
npx vitest run tests/http-links.test.ts tests/signaux-cablage.test.ts
```

Attendu : ÉCHEC des cas « clic ATTRIBUÉ » (`expected [] to deeply equal [...]`) et de tous les cas de `signaux-cablage` (motifs absents de `src/index.ts`). Le cas « n'ATTEND PAS » est vert d'avance (rien n'appelle encore le signal) : son sens rouge se vérifie en tâche 11 (mutation 7).

- [ ] **Step 3 : la route des liens**

Dans `src/http/links.ts`, ajouter à `LinksRouteDeps`, après `contactParJeton?` :

```ts
  /**
   * Remonte le clic comme SIGNAL (spec 2026-09-24, § 8), seulement quand on sait QUI a cliqué : un clic
   * anonyme n'a pas de fiche, donc pas de profil à mettre à jour chez l'outil du client.
   *
   * REQUISE : la redirection est le seul endroit où le clic se sait, un câblage qui l'oublierait perdrait tous
   * les clics sans erreur.
   *
   * 🔴 LA REDIRECTION NE L'ATTEND PAS, contrairement à `recordClick`. Au premier clic après l'expiration du cache
   * des espaces actifs, l'émetteur lit la base puis enfile un job : l'attendre ajouterait ces deux allers-retours
   * au chemin de CHAQUE lien déjà envoyé, pour une donnée que personne ne regarde à la seconde. Lancée sans être
   * attendue, sa panne se journalise et ne touche pas au 302.
   */
  signalerClic(tenantId: string, contactId: string, code: string): Promise<void>;
```

et, juste après le bloc `try { await deps.recordClick(...) } catch (err) { journaliser('error', 'clic_non_enregistre', ...) }` :

```ts
      if (contactId !== null) {
        const attribue = contactId;
        // Lancé, JAMAIS attendu (voir `signalerClic`). La fonction `async` enveloppe aussi une levée SYNCHRONE du
        // câblage : aucune promesse rejetée ne reste sans gestionnaire.
        void (async () => {
          try {
            await deps.signalerClic(lien.tenantId, attribue, normalise);
          } catch (err) {
            journaliser('error', 'signal_clic_non_emis', { err, code: normalise, tenantId: lien.tenantId });
          }
        })();
      }
```

- [ ] **Step 4 : le câblage de `src/index.ts`**

ANNONCER l'édition de `src/index.ts` aux autres sessions. Imports, avec les autres :

```ts
import { PgIntegrationBatchStore } from './signaux/integration-batch.pg';
import {
  creerEmetteur, annoncerAussiAuxSignaux, signalDeLAccuse, signalDeLaReponse, signalDesabonnement, signalDuClic,
  DUREE_CACHE_ESPACES_ACTIFS_MS,
} from './signaux/emetteur';
import { FILE_SIGNAUX_BATCH } from './signaux/batch';
```

Juste avant le commentaire « 🔴 L'ANNONCE D'UN OPT-OUT, POSÉE SUR LE DÉPÔT LUI-MÊME » (après `const campaignDraftStore = …`) :

```ts
  /**
   * LES SIGNAUX (spec 2026-09-24, § 8). L'API en émet aussi : les rappels RCS, les clics sur un lien suivi et
   * les désabonnements écrits depuis la console ou l'API publique arrivent ICI, pas dans le worker.
   *
   * 🔴 CONSTRUIT AVANT LE DÉPÔT DES CONTACTS, qui l'appelle à chaque désabonnement. Le cache des espaces actifs
   * est invalidé par l'écran du réglage : un outil branché reçoit les signaux de l'API sans attendre.
   */
  const integrationBatch = new PgIntegrationBatchStore(pool);
  const espacesBatch = cacheCourt<ReadonlySet<string>>(DUREE_CACHE_ESPACES_ACTIFS_MS);
  const emetteur = creerEmetteur({
    destinations: [{ file: FILE_SIGNAUX_BATCH, espacesActifs: () => espacesBatch.lire('actifs', () => integrationBatch.espacesActifs()) }],
    enfiler: (file, job, opts) => queue.enqueue(file, job, opts),
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  });
```

Le dépôt des contacts devient :

```ts
  const contactStore = new PgContactStore(
    pool,
    annoncerAussiAuxSignaux(
      creerAnnonceOptOut({
        enfiler: (job, opts) => queue.enqueue(FILE_POUSSEE_OPTOUT, job, opts),
        // eslint-disable-next-line no-console
        log: (m) => console.warn(m),
      }),
      emetteur,
    ),
  );
```

Dans `links: { ... }`, après `contactParJeton: …` :

```ts
      // Le clic ATTRIBUÉ devient un signal (spec 2026-09-24, § 8). L'espace vient du LIEN, comme pour le clic.
      signalerClic: (tenant, contactId, code) => emetteur.emettreSignal(tenant, signalDuClic(contactId, code)),
```

Avant `rcsChannel: {` :

```ts
    // Paramètres > Intégrations > Batch. Les clés sont chiffrées ICI, jamais stockées en clair, et le cache de
    // l'émetteur de l'API est invalidé à chaque changement : brancher ou débrancher prend effet tout de suite.
    integrationBatch: {
      lire: (tenant) => integrationBatch.lire(tenant),
      // Mesuré avec la VRAIE fonction de chiffrement, pas une copie de sa règle (la regex de la clé est déjà
      // écrite trois fois dans `src/config.ts`) : c'est exactement ce qu'`enregistrer` va appeler.
      chiffrementPret: (() => {
        try {
          encryptSecret('sonde', config.ENCRYPTION_KEY);
          return true;
        } catch {
          return false;
        }
      })(),
      enregistrer: async (tenant, r) => {
        const fait = await integrationBatch.enregistrer(tenant, {
          cleRestChiffree: r.cleRest === undefined ? null : encryptSecret(r.cleRest, config.ENCRYPTION_KEY),
          cleProjetChiffree: r.cleProjet === undefined ? null : encryptSecret(r.cleProjet, config.ENCRYPTION_KEY),
          envoyerResume: r.envoyerResume,
        });
        espacesBatch.invalider('actifs');
        return fait;
      },
      supprimer: async (tenant) => {
        const fait = await integrationBatch.supprimer(tenant);
        espacesBatch.invalider('actifs');
        return fait;
      },
      audit: auditSink,
    },
```

`onDlr` n'a PLUS de corps dans `src/index.ts` : le lot 3 (sa tâche 6) l'a extrait vers `traiterRapportRcs` (`src/rcs/rapport-livraison.ts`), et le câblage est devenu une flèche à une seule expression, `onDlr: (tenant, dlr) => traiterRapportRcs({ …ses dépendances… }, tenant, dlr),`. Le signal ne va PAS dans `traiterRapportRcs` (ce module ne connaît aucun émetteur, et ses tests restent tels quels) : il s'ajoute au câblage, APRÈS le traitement du lot 3, sans toucher à l'objet de dépendances. Remplacer la tête de la flèche et sa fin, et rien d'autre :

```ts
      onDlr: async (tenant, dlr) => {
        await traiterRapportRcs({
          // …les dépendances du lot 3, recopiées telles quelles, ligne pour ligne…
        }, tenant, dlr);
        // 3. Les SIGNAUX (spec 2026-09-24, § 8). APRÈS le rapport du lot 3 (livraison, échec d'un message libre,
        //    joignabilité, sorties du bloc) : l'état que l'outil relira est alors écrit. L'émetteur ne lève
        //    jamais : un rapport de livraison ne doit pas échouer pour lui.
        if (dlr.status !== null && dlr.to !== '') {
          const signal = signalDeLAccuse({ messageId: dlr.messageId, status: dlr.status, waId: dlr.to, motif: dlr.detail, codeMeta: null, le: null }, 'rcs');
          if (signal !== null) await emetteur.emettreSignal(tenant, signal);
        }
      },
```

Contrôle : `git diff origin/main -- src/index.ts` ne montre, dans ce bloc, que la tête `async (tenant, dlr) => {`, le `await` devant `traiterRapportRcs(`, le `;` de fin et le bloc « 3. Les SIGNAUX » ; l'objet de dépendances du lot 3 est intact.

Dans `onMo`, juste après le bloc `if (!marque) { console.error(...STOP RCS reçu... sans fiche contact...) }` (dans le `if (mo.kind === 'text' && estDemandeArret(mo.text))`) :

```ts
          // Le STOP RCS n'écrit pas par le dépôt des contacts (il pose `rcs_optout_at`) : l'annonce composée
          // plus haut ne le voit pas, il émet donc lui-même son signal.
          if (marque) await emetteur.emettreSignal(tenant, signalDesabonnement(mo.from, 'rcs'));
```

et juste après `await inboxStore.recordInbound(tenant, { ... }, 'rcs');` :

```ts
        // 2 ter. La RÉPONSE comme signal (spec 2026-09-24, § 8) : le bouton tapé seulement, jamais le texte.
        await emetteur.emettreSignal(tenant, signalDeLaReponse({
          messageId: mo.messageId, waId: mo.from, bouton: mo.kind === 'suggestion' ? mo.text : null,
        }, 'rcs'));
```

- [ ] **Step 5 : vérifier le chemin de désabonnement du lot 1**

Ce qui garantit le signal n'est pas qu'un fichier NOMME `opted_out`, c'est que l'écriture passe par une méthode du dépôt des contacts qui ANNONCE (l'annonce est composée avec le signal plus haut). Trois contrôles, qui doivent tous rendre au moins une ligne :

```bash
cd /c/Users/julie/messagingme-mba \
 && grep -n "METHODES_QUI_ANNONCENT = .*ecrireConsentementParId" tests/optout-poussee.test.ts \
 && grep -n "deps\.ecrireConsentementParId(" src/api/consentement.ts \
 && grep -n "deps\.contacts\.ecrireConsentementParId(" src/api/contacts-v1.ts \
 && grep -n -A1 "creerServiceContactsV1({" src/index.ts | grep "contacts: contactStore"
```

Attendu : (1) la méthode figure dans `METHODES_QUI_ANNONCENT`, dont le test DÉRIVE du fichier la liste des écritures qui posent `opt_out_at` (une méthode qui écrirait un opt-out sans annoncer le ferait échouer) ; (2) `appliquerConsentement` passe par sa dépendance, et par aucune requête à elle ; (3) le service des fiches branche cette dépendance sur la méthode de son dépôt ; (4) ce dépôt est `contactStore`, celui que l'étape 4 compose avec les signaux. Une ligne manque : S'ARRÊTER et le signaler à Julien avant de continuer (le corriger est un changement du lot 1).

- [ ] **Step 6 : les voir passer**

```bash
npx vitest run tests/http-links.test.ts tests/signaux-cablage.test.ts tests/optout-poussee.test.ts tests/scope-tenant.test.ts && npm run typecheck
```

Attendu : vert.

- [ ] **Step 7 : commit (procédure P ; `src/index.ts` est un câblage partagé, son édition a été annoncée)**

Chemins : `src/index.ts src/http/links.ts tests/http-links.test.ts tests/signaux-cablage.test.ts`. Un hunk étranger dans `src/index.ts` impose P' à ce fichier. Message : `feat(signaux): cablage de l API, rappels RCS, clics sans attente, desabonnements et reglage (lot 6)`.

---

### Task 10 : Le câblage du worker (file, accusés, entrants, analyse)

**Files:**
- Modify: `src/queue/names.ts:13` (`BASE_QUEUES`), `:49-52` (commentaire des cadences), `:56-66` (`QUEUE_POLLING_SECONDS`), `:89-99` (`FILES_NOTIFIEES`)
- Modify: `tests/queue-names.test.ts:3` (import), `:30-35` et `:47-51` (résolution des constantes), fin de fichier (nouveau `describe`)
- Modify: `src/webhooks/handler.ts` (`WebhookJobDepsCommunes`, `WebhookJobDeps` ligne 106 à 111)
- Modify: `tests/webhook-fixtures.ts` (deux fixtures)
- Modify: `tests/delivery.test.ts:67-71`, `tests/pubs-tarif-meta.test.ts:90-99`, `tests/pubs-arrivees.test.ts:108-…`, `tests/webhook-triggers.test.ts` (chaque appel de `handleWebhookJob` qui passe `inbox`)
- Modify: `src/worker.ts` (fichier de câblage PARTAGÉ) : imports, émetteur avant le dépôt des contacts (`:250-262`), appels de `handleWebhookJob` (`:483` et `:703`), après le travail `optout-poussee` (`:906`), `onAnalyzed` (`:978-1003`)
- Modify: `tests/signaux-cablage.test.ts` (partie worker)

**Interfaces:**
- Consumes : tout ce qui précède.
- Produces : file `signaux-batch` dans `BASE_QUEUES` (30 s, non notifiée) ; `WebhookJobDeps` exige `signauxAccuse` avec `delivery`, et `signalReponse` avec `inbox` ; fixtures `aucunSignalAccuse`, `aucunSignalReponse`.

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `tests/queue-names.test.ts`, ajouter l'import :

```ts
import { FILE_SIGNAUX_BATCH } from '../src/signaux/batch';
```

dans le premier cas, juste avant la ligne qui lève « constante de file inconnue du test », ajouter :

```ts
      if (name === 'FILE_SIGNAUX_BATCH') return FILE_SIGNAUX_BATCH;
```

dans l'objet `RESOLUTION` du second cas, ajouter `FILE_SIGNAUX_BATCH,` (la valeur vient de l'import, pas d'une copie) ; et à la fin du fichier :

```ts
describe('la file des signaux (lot 6 de l’API publique)', () => {
  it('🔴 elle est déclarée, donc visible de /ops avec sa DLQ', () => {
    expect(BASE_QUEUES as readonly string[]).toContain(FILE_SIGNAUX_BATCH);
    expect(ALL_QUEUES).toContain(dlqName(FILE_SIGNAUX_BATCH));
  });

  it('traitement de fond : sondée lentement, jamais réveillée', () => {
    expect(pollingSecondsFor(FILE_SIGNAUX_BATCH)).toBe(30);
    expect(notifieePour(FILE_SIGNAUX_BATCH)).toBe(false);
  });
});
```

Ajouter à `tests/signaux-cablage.test.ts` :

```ts
const worker = sansCommentaires(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));

describe('le câblage des signaux dans le worker', () => {
  it('🔴 les désabonnements écrits par le worker (le STOP WhatsApp) deviennent des signaux', () => {
    expect(worker).toMatch(/new PgContactStore\(\s*pool,\s*annoncerAussiAuxSignaux\(/);
  });

  it('🔴 les DEUX files qui voient des accusés passent le puits, et la réponse n’arrive que par une', () => {
    expect(worker.match(/signauxAccuse: puitsSignaux\.accuse/g)).toHaveLength(2);
    expect(worker.match(/signalReponse: puitsSignaux\.reponse/g)).toHaveLength(1);
  });

  it('🔴 la conversation analysée est un consommateur du point de sortie, AVANT l’automation qui peut sortir tôt', () => {
    const signal = worker.indexOf('emetteur.emettreSignal(stored.tenantId, signalAnalyse(stored.conversationId))');
    const automation = worker.indexOf("{ kind: 'analysis', waId: ctx.waId");
    expect(signal).toBeGreaterThan(-1);
    expect(automation).toBeGreaterThan(signal);
  });

  it('la file des signaux est consommée', () => {
    expect(worker).toMatch(/queue\.work\(FILE_SIGNAUX_BATCH, creerTravailSignauxBatch\(/);
  });
});
```

- [ ] **Step 2 : les voir échouer**

```bash
npx vitest run tests/queue-names.test.ts tests/signaux-cablage.test.ts
```

Attendu : ÉCHEC de « elle est déclarée » (`expected [...] to include 'signaux-batch'`), de la cadence (`expected 5 to be 30`), et des quatre cas worker de `signaux-cablage`.

- [ ] **Step 3 : déclarer la file**

`src/queue/names.ts`, ligne 13 :

```ts
export const BASE_QUEUES = ['webhook', 'webhook-status', 'campaign-run', 'analyze-conversation', 'push-analysis', 'hubspot-catchup', 'automation-event', 'agent-turn', 'optout-poussee', 'signaux-batch'] as const;
```

Dans le commentaire des cadences, après la puce `optout-poussee` :

```ts
 * - `signaux-batch` : pousse les signaux vers l'outil qu'un client a branché (lot 6 de l'API publique).
 *   Traitement de fond : un signal remonté trente secondes plus tard ne change rien à une orchestration qui
 *   réagit en minutes -> 30 s. ⚠️ Ce qui tient la promesse « dans la minute » des réponses, clics et
 *   désabonnements n'est pas cette cadence, c'est leur PRIORITÉ (`PRIORITE_SIGNAL`) : sans elle, ils
 *   attendraient derrière l'arriéré d'accusés d'une grosse campagne, que la file d'un espace traite un par un.
```

Dans `QUEUE_POLLING_SECONDS`, après `'optout-poussee': 30,` : `'signaux-batch': 30,`. Dans `FILES_NOTIFIEES`, après `'optout-poussee': false, …` :

```ts
  'signaux-batch': false, // traitement de fond, et une rafale d'accusés en produit autant : l'espacer protège la base
```

- [ ] **Step 4 : rendre les puits REQUIS dans le handler, et le dire aux tests**

Dans `src/webhooks/handler.ts`, retirer de `WebhookJobDepsCommunes` les deux champs optionnels ajoutés en tâche 4, et `WebhookJobDeps` devient (le couple des accusés porte déjà `echecsLibres` depuis le lot 3, tâche 5, avec son commentaire : le garder, et ajouter `signauxAccuse` À CÔTÉ) :

```ts
export type WebhookJobDeps = WebhookJobDepsCommunes
  & (
    { delivery: DeliveryStore; tarifsMeta: TarifsMetaSink; echecsLibres: EchecsLibresSink; signauxAccuse: SignalAccuse }
    | { delivery?: undefined; tarifsMeta?: undefined; echecsLibres?: undefined; signauxAccuse?: undefined }
  )
  & (
    { inbox: InboxStore; arriveesPub: ArriveesPubDeps; routagePub: RoutagePubDeps; signalReponse: SignalReponse }
    | { inbox?: undefined; arriveesPub?: undefined; routagePub?: undefined; signalReponse?: undefined }
  );
```

avec, dans le commentaire au-dessus :

```ts
 * 🔴 LES SIGNAUX ENTRENT DANS LES MÊMES COUPLES (lot 6 de l'API publique) : un accusé arrive par DEUX files
 * (`webhook` et `webhook-status`), et un câblage qui oublierait le puits sur l'une perdrait les accusés d'un
 * découpage de lots qui appartient à Meta, sans aucune erreur.
```

Dans `tests/webhook-fixtures.ts`, ajouter l'import et les fixtures :

```ts
import type { SignalAccuse } from '../src/webhooks/delivery';
import type { SignalReponse } from '../src/webhooks/inbound';

/** Aucun signal remonté : le test ne porte pas sur les signaux, et le DIT (lot 6 de l'API publique). */
export const aucunSignalAccuse: SignalAccuse = async () => {};
export const aucunSignalReponse: SignalReponse = async () => {};
```

Puis :

```bash
npm run typecheck
```

Le compilateur désigne CHAQUE appel de `handleWebhookJob` auquel il manque son puits. Ajouter `signauxAccuse: aucunSignalAccuse,` à ceux qui passent `delivery` (`tests/delivery.test.ts`, `tests/pubs-tarif-meta.test.ts`) et `signalReponse: aucunSignalReponse,` à ceux qui passent `inbox` (`tests/pubs-arrivees.test.ts`, `tests/webhook-triggers.test.ts`), avec l'import depuis `./webhook-fixtures`. `src/worker.ts` apparaît aussi dans la liste : c'est l'étape 5.

- [ ] **Step 5 : le câblage de `src/worker.ts`**

ANNONCER l'édition de `src/worker.ts` aux autres sessions. Imports, avec les autres :

```ts
import { cacheCourt } from './lib/cache-court';
import { PgIntegrationBatchStore } from './signaux/integration-batch.pg';
import { PgSignauxStore } from './signaux/store.pg';
import { completerSignal } from './signaux/completer';
import {
  creerEmetteur, creerPuitsSignauxMeta, annoncerAussiAuxSignaux, signalAnalyse, DUREE_CACHE_ESPACES_ACTIFS_MS,
} from './signaux/emetteur';
import { FILE_SIGNAUX_BATCH, pousserVersBatch } from './signaux/batch';
import { creerTravailSignauxBatch } from './signaux/travail-batch';
```

Juste avant le commentaire « 🔴 LA MEME ANNONCE QUE COTE API, ET C'EST OBLIGATOIRE » (après `const flowStore = new PgFlowStore(pool);`) :

```ts
  /**
   * LES SIGNAUX (spec 2026-09-24, § 8) : ce que la console remonte vers l'outil d'un client.
   *
   * 🔴 L'ÉMETTEUR EST CONSTRUIT AVANT LE DÉPÔT DES CONTACTS, qui l'appelle à chaque désabonnement. Il ne
   * connaît aucun outil : chaque adaptateur est une DESTINATION (sa file, ses espaces actifs lus à travers
   * un cache court, qui rattrape un branchement fait depuis l'écran en une minute au plus).
   */
  const integrationBatch = new PgIntegrationBatchStore(pool);
  const espacesBatch = cacheCourt<ReadonlySet<string>>(DUREE_CACHE_ESPACES_ACTIFS_MS);
  const emetteur = creerEmetteur({
    destinations: [{ file: FILE_SIGNAUX_BATCH, espacesActifs: () => espacesBatch.lire('actifs', () => integrationBatch.espacesActifs()) }],
    enfiler: (file, job, opts) => queue.enqueue(file, job, opts),
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  });
  /**
   * Le numéro Meta -> son espace, pour les ACCUSÉS, qui ne portent que le numéro. Consulté seulement quand un
   * espace au moins a branché un outil. ⚠️ Seules les réponses POSITIVES restent en cache : une réponse nulle
   * deviendrait fausse à l'instant où un client branche son premier numéro (leçon de `src/meta/numero-espace.ts`).
   */
  const espaceDuNumero = cacheCourt<string | null>(5 * 60_000);
  const puitsSignaux = creerPuitsSignauxMeta({
    emetteur,
    tenantDuNumero: async (pnid) => {
      const t = await espaceDuNumero.lire(pnid, () => inboxStore.phoneNumberTenant(pnid));
      if (t === null) espaceDuNumero.invalider(pnid);
      return t;
    },
  });
```

Le dépôt des contacts devient :

```ts
  const contactStore = new PgContactStore(
    pool,
    annoncerAussiAuxSignaux(
      creerAnnonceOptOut({
        enfiler: (job, opts) => queue.enqueue(FILE_POUSSEE_OPTOUT, job, opts),
        // eslint-disable-next-line no-console
        log: (m) => console.warn(m),
      }),
      emetteur,
    ),
  );
```

Dans l'appel `handleWebhookJob` de la file `webhook`, après `tarifsMeta: tarifsMetaStore,` et la ligne `echecsLibres: echecsMessages,` que le lot 3 (tâche 5) y a posée et qui RESTE :

```ts
      // 🔴 LES SIGNAUX (spec 2026-09-24, § 8), SUR LES DEUX FILES qui voient des accusés, pour la raison écrite
      // au-dessus de `remiseMba` ; la réponse, elle, n'arrive que par celle-ci.
      signauxAccuse: puitsSignaux.accuse,
      signalReponse: puitsSignaux.reponse,
```

L'appel de la file `webhook-status` (tel que le lot 3 l'a laissé, `echecsLibres: echecsMessages` compris) devient :

```ts
    await handleWebhookJob(data, { store: eventStore, delivery: recipientStore, nodeEvents: nodeEventStore, remiseMba: remiseMbaSurAccuse, tarifsMeta: tarifsMetaStore, echecsLibres: echecsMessages, signauxAccuse: puitsSignaux.accuse });
```

⚠️ Retirer `echecsLibres` ici ne compilerait pas (le couple l'exige depuis le lot 3), mais c'est ce qui rendrait de nouveau invisibles les échecs des messages libres sur cette file : le garder est la raison de ce rappel.

Juste après la fin du travail `optout-poussee` (ancre : `await queue.work(FILE_POUSSEE_OPTOUT, creerTravailPousseeOptOut({ … }));`) :

```ts
  /**
   * File signaux-batch (spec 2026-09-24, § 8) : pousser les signaux vers Batch, un job (de 1 à
   * `SIGNAUX_PAR_JOB` signaux d'un même espace) à la fois par espace.
   *
   * 🔴 INCONDITIONNELLE, comme `optout-poussee` : le travail relit le réglage et ne fait rien s'il n'y en a pas.
   * Ne pas consommer quand personne n'est branché laisserait s'empiler des jobs que personne ne dépile.
   *
   * ⚠️ Groupée par ESPACE (le `groupId` posé par l'émetteur) : la rafale d'un client ne passe pas devant les
   * autres. Dans un espace, la PRIORITÉ (`PRIORITE_SIGNAL`) fait passer réponses, clics, désabonnements et
   * analyses devant un arriéré d'accusés. Les DEUX options de concurrence vont ensemble, `groupConcurrency`
   * étant un no-op tant que `concurrency` vaut 1. Deux en vol restent loin des 300 mises à jour par seconde
   * que Batch accepte.
   */
  const signauxStore = new PgSignauxStore(pool);
  await queue.work(FILE_SIGNAUX_BATCH, creerTravailSignauxBatch({
    reglage: async (t) => {
      const s = await integrationBatch.secrets(t);
      if (s === null) return null;
      return {
        cles: {
          cleRest: decryptSecret(s.cleRestChiffree, config.ENCRYPTION_KEY),
          cleProjet: decryptSecret(s.cleProjetChiffree, config.ENCRYPTION_KEY),
        },
        envoyerResume: s.envoyerResume,
        suspendu: s.refusClesLe !== null,
      };
    },
    completer: (t, s) => completerSignal(signauxStore, t, s),
    pousser: (requete, cles) => pousserVersBatch(requete, cles, transport),
    noterSansIdentifiant: (t, n) => integrationBatch.noterSansIdentifiant(t, n),
    suspendre: async (t) => {
      await integrationBatch.suspendre(t);
      espacesBatch.invalider('actifs');
    },
    journal: new PgJournalAppels(pool),
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  }), { concurrency: 2, groupConcurrency: 1 });
```

Dans `onAnalyzed`, remplacer le commentaire « DEUX consommateurs du même point de sortie … » par « TROIS consommateurs du même point de sortie : le push connecteur (Pièce 2), les signaux (lot 6 de l'API publique) et, depuis E.2, les automations « conversation analysée » », et insérer ENTRE le `try` du push connecteur et le `try` de l'automation :

```ts
      try {
        // 🔴 AVANT L'AUTOMATION, qui SORT de la fonction (`if (!ctx) return;`) quand la conversation n'a pas de
        // contexte : placé après, le signal disparaîtrait dans ce cas-là, en silence. Il ne relit rien ici,
        // la fiche et l'analyse se relisent au moment de pousser.
        await emetteur.emettreSignal(stored.tenantId, signalAnalyse(stored.conversationId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('signal « conversation analysée » ignoré (best-effort):', err instanceof Error ? err.message : err);
      }
```

- [ ] **Step 6 : les voir passer, suite complète**

```bash
npx vitest run tests/queue-names.test.ts tests/signaux-cablage.test.ts && npm run typecheck && npm test
```

Attendu : vert partout.

- [ ] **Step 7 : commit (procédure P ; `src/worker.ts` est un câblage partagé, son édition a été annoncée)**

Chemins : `src/worker.ts src/queue/names.ts src/webhooks/handler.ts tests/queue-names.test.ts tests/webhook-fixtures.ts tests/delivery.test.ts tests/pubs-tarif-meta.test.ts tests/pubs-arrivees.test.ts tests/webhook-triggers.test.ts tests/signaux-cablage.test.ts`. Un hunk étranger dans `src/worker.ts` impose P' à ce fichier. Message : `feat(signaux): cablage du worker, file signaux-batch, accuses, entrants et analyse (lot 6)`.

---

### Task 11 : Vérification du backend (deux sens, suite, CI, revue)

**Files:** aucun fichier livré ; les mutations sont défaites et vérifiées.

- [ ] **Step 1 : suite complète et typage**

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck && npm test
```

Attendu : vert.

- [ ] **Step 2 : vérifier chaque garde DANS LES DEUX SENS** (remettre le défaut avec l'outil Edit, voir l'échec ET son symptôme, défaire, puis `git fetch -q origin && git diff --exit-code origin/main -- <fichier>` rend 0 : le fichier égale ce qui a été poussé. ⚠️ Pas `git diff` nu : la procédure P ne fait jamais avancer le `HEAD` local, qui ne connaît donc pas les commits du lot)

1. **Un `sent` ne lit rien.** Dans `creerPuitsSignauxMeta.accuse`, placer la ligne `if (!(await deps.emetteur.quelquUnEcoute())) return;` AVANT `if (signal === null) return;`. `npx vitest run tests/signaux-emetteur.test.ts` : échec de « un statut `sent` ne lit RIEN », symptôme `expected 1 to be 0` sur `t.lectures()`. Défaire.
2. **Jamais le texte.** Dans `boutonTape`, remplacer la première ligne par `if (m.type === 'button' || m.type === 'text') return m.body;`. Échec des deux cas « ne transporte JAMAIS le texte », symptôme : le JSON contient `Lilas`. Défaire.
3. **Une fiche sans `externalId` n'est pas poussée.** Dans `versBatch`, remplacer `continue;` (dans le `if (customId === '')`) par rien. `npx vitest run tests/signaux-batch.test.ts` : échec de « SANS externalId », symptôme : `custom_id` vide dans la liste. Défaire.
4. **Le résumé seulement si coché.** Dans `evenement`, retirer `o.resume && `. Échec de « le résumé ne part QUE si », symptôme : `summary_1` présent avec `resume: false`. Défaire.
5. **Un 4xx est terminal.** Dans `creerTravailSignauxBatch`, remplacer le `continue;` de la branche non rejouable par `throw err;`. `npx vitest run tests/signaux-travail-batch.test.ts` : échec de « un 4xx est TERMINAL » et de « un 4xx sur une tranche n'empêche pas la suivante », symptôme `promise rejected ... instead of resolving`. Défaire.
6. **L'annonce composée.** Dans `src/worker.ts`, remplacer temporairement l'argument `annoncerAussiAuxSignaux(creerAnnonceOptOut({ … }), emetteur)` du dépôt des contacts par `creerAnnonceOptOut({ … })` seul. ANNONCER cette mutation (fichier de câblage partagé). `npx vitest run tests/signaux-cablage.test.ts` : échec du cas « STOP WhatsApp ». Défaire, puis `git diff origin/main -- src/worker.ts` : aucun hunk.
7. **La redirection n'attend pas le signal.** Dans `src/http/links.ts`, remplacer `void (async () => {` par `await (async () => {`. `npx vitest run tests/http-links.test.ts` : échec de « la redirection n'ATTEND PAS le signal », symptôme `Test timed out in 5000ms`. Défaire.
8. **Le texte vide ne part pas.** Dans `propre` (`src/signaux/batch.ts`), retirer la ligne `if (v.trim() === '') continue;`. `npx vitest run tests/signaux-batch.test.ts` : échec de « un texte VIDE n'est pas envoyé », symptôme `template: ''` et `destination: '   '` présents dans les attributs. Défaire.
9. **Le repli sur le journal des tentatives.** Dans `contexteDuMessage` (`src/signaux/store.pg.ts`), retirer `ke.tenant_id = $1 and ` de la sous-requête sur `campaign_envois`. `npx vitest run tests/signaux-isolation.test.ts` : échec de « chaque `from` porte son `tenant_id = $1` », symptôme `expected 2 to be 3` sur cette requête. Défaire. 🔴 Cette mutation RETIRE UN FILTRE D'ISOLATION de l'arbre partagé : l'ANNONCER avant (quatrième annonce du `CLAUDE.md` du dépôt), ne créer aucun fichier de sauvegarde (`.bak`), et vérifier la restauration par `git diff origin/main -- src/signaux/store.pg.ts` (seuls les hunks du lot, sans perte du filtre), pas à l'œil.
10. **Le canal d'un désabonnement.** Dans `canalDuStop` (`src/signaux/completer.ts`), remplacer `fiche.optInSource === SOURCE_STOP_WHATSAPP ? 'whatsapp' : null` par `'whatsapp'`. `npx vitest run tests/signaux-completer.test.ts` : échec de « un désabonnement posé par la console ou l'API n'a PAS de canal », symptôme `canal: 'whatsapp'` au lieu de `null`. Défaire.

⚠️ **CE QUI N'EST PAS VÉRIFIÉ DANS LE SENS ROUGE, ET POURQUOI.** Les cas « un autre espace » de `tests/integration/signaux.integration.test.ts` ne tournent que dans le job `integration` de la CI : la base locale est la PRODUCTION, et le poste n'a pas de Postgres jetable. Les voir échouer demanderait de POUSSER sur `origin/main` une lecture privée de son filtre d'espace, que n'importe quel `up --build` lancé pendant la fenêtre (par une autre session) mettrait en production : c'est exactement le risque que la quatrième annonce du `CLAUDE.md` décrit, en pire. On ne le fait donc pas. Le sens rouge de l'isolation est porté par `tests/signaux-isolation.test.ts` (mutation 9 ci-dessus), qui lit les requêtes RÉELLES et tourne partout ; le test d'intégration en garde le sens vert, contre une vraie base. Le dire dans le compte rendu du lot, plutôt que de le laisser croire vérifié.

- [ ] **Step 3 : lire la CI, job par job**

```bash
gh run list --limit 5
gh run view <id du run du dernier commit de code> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Attendu : TOUS les jobs en `success`, dont `integration` (c'est lui qui joue `tests/integration/signaux.integration.test.ts` et la migration sur une base fraîche). Un job rouge se lit (`gh run view <id> --log-failed`) et se corrige avant d'aller plus loin.

- [ ] **Step 4 : revue**

Lancer `/revue` sur le diff du lot (`git log --oneline origin/main` pour borner les commits du lot 6), avec la section « Rayon de souffle » (ci-dessous) comme liste à parcourir. Corriger les 🔴 ET les 🟡, revérifier soi-même (typage, tests, CI), jamais sur le seul rapport d'un agent.

---

### Task 12 : L'écran du réglage (Paramètres > Intégrations > Batch)

🔴 **Prérequis : l'API de ce lot est en production** (section Déploiement, étapes 1 à 7). Vercel publie la console à chaque push : un écran qui appelle une route que la production n'a pas afficherait « Lecture impossible » chez tous les clients (vécu avec l'onglet « Outils » le 2026-09-21). Contrôle :

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.messagingme.app/tenants/00000000-0000-4000-8000-000000000000/integrations/batch
```

Attendu : `401` (la route existe et exige une session). `404` : l'API n'est pas déployée, ne PAS commencer cette tâche.

**Files:**
- Modify: `web/lib/api/integrations.ts` (juste après la fonction `revokeApiKey`, ligne 53 à 55 sur `260ba2c6` ; le lot 1 touche ce fichier avant nous, se repérer au nom de la fonction)
- Create: `web/components/ReglageIntegrationBatch.tsx`
- Modify: `web/app/parametres/page.tsx:9` (import) et `:260` (avant `<BlockedContacts tenantId={tenantId} />`)
- Create: `web/e2e/parametres-integration-batch.spec.ts`

**Interfaces:**
- Consumes : `GET|PUT|DELETE /tenants/:tenantId/integrations/batch` (tâche 8) ; `request` (`web/lib/http.ts:104`) ; `useT`, `useLocale` ; `formatDate`, `hourMin` (`web/lib/day.ts`) ; `cardCls`, `inputCls` (`web/lib/ui.ts`).
- Produces : `interface EtatIntegrationBatch`, `lireIntegrationBatch`, `enregistrerIntegrationBatch`, `debrancherIntegrationBatch` ; composant `ReglageIntegrationBatch({ tenantId })`.

- [ ] **Step 1 : écrire le test de bout en bout qui échoue**

`web/e2e/parametres-integration-batch.spec.ts` :

```ts
import { test, expect, type Page } from '@playwright/test';

/**
 * PARAMÈTRES > INTÉGRATIONS > BATCH (lot 6 de l'API publique, spec 2026-09-24, § 8).
 *
 * 🔴 CE QUE SEUL CE TEST PEUT VOIR : ce que l'écran ENVOIE (jamais une clé vide, jamais une clé déjà
 * enregistrée), et ce qu'il MONTRE (le compte des signaux non poussés, le refus des clés). Le serveur tient sa
 * frontière de son côté (`tests/http-integration-batch.test.ts`).
 */
interface Trace { puts: Array<Record<string, unknown>>; suppressions: number }

async function monter(page: Page, initial: Record<string, unknown>): Promise<Trace> {
  const trace: Trace = { puts: [], suppressions: 0 };
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: 'admin', tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  let etat: Record<string, unknown> = initial;
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/integrations/batch')) {
      if (req.method() === 'PUT') {
        const corps = req.postDataJSON() as Record<string, unknown>;
        trace.puts.push(corps);
        etat = { branche: true, envoyerResume: corps.envoyerResume === true, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: null, majLe: '2026-09-24T10:00:00.000Z' };
        return json(etat);
      }
      if (req.method() === 'DELETE') {
        trace.suppressions += 1;
        etat = { branche: false };
        return json(etat);
      }
      return json(etat);
    }
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) return json({ actif: false });
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, autoRetryEnabled: false, timezone: 'Europe/Paris', businessHours: {} });
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: 'admin' });
    return json({});
  });
  await page.goto('/parametres');
  return trace;
}

test.describe('Paramètres > Intégrations > Batch', () => {
  test('🔴 non branché : il faut les DEUX clés, et le résumé part décoché', async ({ page }) => {
    const trace = await monter(page, { branche: false });
    const bouton = page.getByTestId('integration-batch-enregistrer');
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Non branché|Not connected/);
    await expect(bouton).toBeDisabled();
    await page.getByTestId('integration-batch-cle-rest').fill('cle-rest-e2e');
    await expect(bouton).toBeDisabled();
    await page.getByTestId('integration-batch-cle-projet').fill('projet-e2e');
    await expect(page.getByTestId('integration-batch-resume')).not.toBeChecked();
    await bouton.click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toEqual({ cleRest: 'cle-rest-e2e', cleProjet: 'projet-e2e', envoyerResume: false });
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Branché|Connected/);
    // Les clés ne restent pas à l'écran une fois enregistrées.
    await expect(page.getByTestId('integration-batch-cle-rest')).toHaveValue('');
  });

  test('🔴 branché : le compte des signaux non poussés se voit, et l’option s’enregistre SANS renvoyer les clés', async ({ page }) => {
    const trace = await monter(page, {
      branche: true, envoyerResume: false, sansIdentifiant: 12, sansIdentifiantLe: '2026-09-24T09:00:00.000Z', refusClesLe: null, majLe: '2026-09-24T08:00:00.000Z',
    });
    await expect(page.getByTestId('integration-batch-sans-identifiant')).toContainText('12');
    await page.getByTestId('integration-batch-resume').check();
    await page.getByTestId('integration-batch-enregistrer').click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toEqual({ envoyerResume: true });
  });

  test('🔴 des clés refusées par l’outil se voient', async ({ page }) => {
    await monter(page, {
      branche: true, envoyerResume: false, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: '2026-09-24T09:30:00.000Z', majLe: '2026-09-24T08:00:00.000Z',
    });
    await expect(page.getByTestId('integration-batch-refus')).toBeVisible();
  });

  test('🔴 une réponse sans `branche` se lit « non branché », sans faire tomber la page', async ({ page }) => {
    await monter(page, {});
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Non branché|Not connected/);
    await expect(page.getByTestId('param-timezone')).toBeVisible();
  });

  test('débrancher', async ({ page }) => {
    const trace = await monter(page, {
      branche: true, envoyerResume: false, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: null, majLe: '2026-09-24T08:00:00.000Z',
    });
    await page.getByTestId('integration-batch-debrancher').click();
    await expect.poll(() => trace.suppressions, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Non branché|Not connected/);
  });
});
```

- [ ] **Step 2 : le voir échouer**

ANNONCER aux autres sessions qu'une suite e2e va tourner (deux suites concurrentes empoisonnent `web/.next`). Puis :

```bash
cd /c/Users/julie/messagingme-mba/web && npx playwright test e2e/parametres-integration-batch.spec.ts
```

Attendu : ÉCHEC, `getByTestId('integration-batch-etat')` introuvable. Si l'erreur est `ENOENT` sur un fichier de `.next` puis « Timed out waiting 180000ms from config.webServer » : `rm -rf .next && npm run build`, puis relancer.

- [ ] **Step 3 : écrire le client et l'écran**

Dans `web/lib/api/integrations.ts`, après `revokeApiKey` :

```ts
// --- Intégrations : l'outil qui reçoit les signaux (Paramètres > Intégrations) ---

/**
 * L'état du branchement, tel que le serveur le rend. Les clés n'y sont JAMAIS : le serveur ne les relit pas en
 * clair pour l'écran, il dit seulement qu'elles existent.
 */
export interface EtatIntegrationBatch {
  branche: boolean;
  envoyerResume?: boolean;
  sansIdentifiant?: number;
  sansIdentifiantLe?: string | null;
  refusClesLe?: string | null;
  majLe?: string;
}
export function lireIntegrationBatch(tenantId: string): Promise<EtatIntegrationBatch> {
  return request<EtatIntegrationBatch>(`/tenants/${tenantId}/integrations/batch`);
}
/** Une clé absente = garder celle qui est enregistrée. Les deux sont requises au premier branchement. */
export function enregistrerIntegrationBatch(
  tenantId: string,
  corps: { cleRest?: string; cleProjet?: string; envoyerResume: boolean },
): Promise<EtatIntegrationBatch> {
  return request<EtatIntegrationBatch>(`/tenants/${tenantId}/integrations/batch`, { method: 'PUT', body: JSON.stringify(corps) });
}
export function debrancherIntegrationBatch(tenantId: string): Promise<EtatIntegrationBatch> {
  return request<EtatIntegrationBatch>(`/tenants/${tenantId}/integrations/batch`, { method: 'DELETE' });
}
```

`web/components/ReglageIntegrationBatch.tsx` :

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { lireIntegrationBatch, enregistrerIntegrationBatch, debrancherIntegrationBatch, type EtatIntegrationBatch } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { cardCls, inputCls } from '@/lib/ui';

/**
 * PARAMÈTRES > INTÉGRATIONS > BATCH (lot 6 de l'API publique, spec 2026-09-24, § 8) : les clés de l'outil qui
 * reçoit les signaux. Réservé aux admins, comme tout l'écran où il vit.
 *
 * 🔴 LES CLÉS NE REVIENNENT JAMAIS À L'ÉCRAN. Un champ vide veut dire « garder celle qui est enregistrée ».
 *
 * 🔴 LE COMPTE DES SIGNAUX NON POUSSÉS EST LA RAISON D'ÊTRE DE CETTE CARTE, autant que les clés : une fiche sans
 * identifiant externe n'est pas remontée, et un intégrateur qui a oublié de nous passer ses identifiants doit le
 * VOIR ici, pas le découvrir dans son outil vide.
 *
 * ⚠️ UNE RÉPONSE SANS `branche` (un proxy qui rend `{}`, une API plus ancienne que l'écran) se lit « non
 * branché », jamais comme une panne du rendu : c'est la leçon de `ErreursSysteme`, où une réponse inattendue
 * faisait tomber tout le centre de Sécurité.
 */
export function ReglageIntegrationBatch({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<EtatIntegrationBatch | null>(null);
  const [cleRest, setCleRest] = useState('');
  const [cleProjet, setCleProjet] = useState('');
  const [resume, setResume] = useState(false);
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [erreur, setErreur] = useState<string | null>(null);

  const appliquer = useCallback((r: EtatIntegrationBatch | null | undefined) => {
    const propre: EtatIntegrationBatch = r?.branche === true ? r : { branche: false };
    setEtat(propre);
    setResume(propre.envoyerResume === true);
  }, []);

  useEffect(() => {
    let vivant = true;
    lireIntegrationBatch(tenantId)
      .then((r) => { if (vivant) appliquer(r); })
      .catch((e: unknown) => {
        if (!vivant) return;
        setEtat({ branche: false });
        setErreur(e instanceof Error ? e.message : t('Lecture impossible', 'Unable to read'));
      });
    return () => { vivant = false; };
  }, [tenantId, appliquer, t]);

  const branche = etat?.branche === true;
  const clesSaisies = cleRest.trim() !== '' && cleProjet.trim() !== '';
  const peutEnregistrer = etat !== null && statut !== 'saving' && (branche || clesSaisies);
  const date = (iso: string): string => `${formatDate(iso, locale)} ${hourMin(iso, locale)}`;

  const enregistrer = () => {
    if (!peutEnregistrer) return;
    setStatut('saving');
    setErreur(null);
    enregistrerIntegrationBatch(tenantId, {
      ...(cleRest.trim() !== '' ? { cleRest: cleRest.trim() } : {}),
      ...(cleProjet.trim() !== '' ? { cleProjet: cleProjet.trim() } : {}),
      envoyerResume: resume,
    })
      .then((r) => { appliquer(r); setCleRest(''); setCleProjet(''); setStatut('saved'); })
      .catch((e: unknown) => { setStatut('error'); setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Unable to save')); });
  };

  const debrancher = () => {
    setStatut('saving');
    setErreur(null);
    debrancherIntegrationBatch(tenantId)
      .then(() => { appliquer({ branche: false }); setStatut('idle'); })
      .catch((e: unknown) => { setStatut('error'); setErreur(e instanceof Error ? e.message : t('Débranchement impossible', 'Unable to disconnect')); });
  };

  const libelle = statut === 'saving' ? t('enregistrement…', 'saving…') : statut === 'saved' ? t('enregistré', 'saved') : '';
  const perdus = etat?.sansIdentifiant ?? 0;

  return (
    <section className="space-y-3" data-testid="integrations">
      <header className="space-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Intégrations', 'Integrations')}</span>
        <p className="text-sm text-ink-600">
          {t(
            'L’outil qui reçoit les signaux de la console (livraisons, réponses, clics, désabonnements, conversations analysées) sur les profils qu’il connaît.',
            'The tool that receives the console’s signals (deliveries, replies, clicks, unsubscribes, analysed conversations) on the profiles it knows.',
          )}
        </p>
      </header>

      <div className={cardCls} data-testid="integration-batch">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink-900">Batch</h3>
            <p className="mt-1 text-sm text-ink-600" data-testid="integration-batch-etat">
              {etat === null
                ? t('Lecture…', 'Loading…')
                : branche
                  ? t('Branché : les signaux partent vers vos profils Batch.', 'Connected: signals go to your Batch profiles.')
                  : t('Non branché : aucun signal ne part.', 'Not connected: no signal is sent.')}
            </p>
          </div>
          <span className="text-xs text-ink-400">{libelle}</span>
        </div>

        {branche && etat?.refusClesLe && (
          <p className="mt-3 rounded-lg border border-coral px-3 py-2 text-sm text-coral" data-testid="integration-batch-refus">
            {t(
              `Batch a refusé vos clés le ${date(etat.refusClesLe)} : la remontée est suspendue jusqu’à ce que vous enregistriez des clés valides.`,
              `Batch rejected your keys on ${date(etat.refusClesLe)}: signals are paused until you save valid keys.`,
            )}
          </p>
        )}

        {branche && (
          <p className="mt-3 text-sm text-ink-600" data-testid="integration-batch-sans-identifiant">
            {perdus === 0
              ? t('Toutes les fiches concernées portaient un identifiant externe.', 'Every contact involved had an external id.')
              : t(
                `${perdus} signaux non poussés : ces fiches n’ont pas d’identifiant externe (externalId), qui se transmet par l’API.${etat?.sansIdentifiantLe ? ` Dernier le ${date(etat.sansIdentifiantLe)}.` : ''}`,
                `${perdus} signals not sent: those contacts have no external id (externalId), which is passed through the API.${etat?.sansIdentifiantLe ? ` Last on ${date(etat.sansIdentifiantLe)}.` : ''}`,
              )}
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-ink-700">
            {t('Clé d’API REST', 'REST API key')}
            <input
              type="password"
              autoComplete="off"
              data-testid="integration-batch-cle-rest"
              value={cleRest}
              onChange={(e) => setCleRest(e.target.value)}
              placeholder={branche ? t('enregistrée : laisser vide pour la garder', 'saved: leave empty to keep it') : ''}
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className="block text-sm text-ink-700">
            {t('Clé de projet', 'Project key')}
            <input
              type="password"
              autoComplete="off"
              data-testid="integration-batch-cle-projet"
              value={cleProjet}
              onChange={(e) => setCleProjet(e.target.value)}
              placeholder={branche ? t('enregistrée : laisser vide pour la garder', 'saved: leave empty to keep it') : ''}
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>

        <label className="mt-3 flex items-start gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            data-testid="integration-batch-resume"
            checked={resume}
            onChange={(e) => setResume(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-ink-300"
          />
          <span>
            {t('Envoyer le résumé des conversations', 'Send conversation summaries')}
            <span className="block text-xs text-ink-500">
              {t(
                'Il contient des propos de vos clients : ne le cochez que si votre outil a le droit de les garder.',
                'It contains your customers’ words: tick it only if your tool is allowed to keep them.',
              )}
            </span>
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            data-testid="integration-batch-enregistrer"
            onClick={enregistrer}
            disabled={!peutEnregistrer}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-200"
          >
            {branche ? t('Enregistrer', 'Save') : t('Brancher', 'Connect')}
          </button>
          {branche && (
            <button
              data-testid="integration-batch-debrancher"
              onClick={debrancher}
              disabled={statut === 'saving'}
              className="rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed"
            >
              {t('Débrancher', 'Disconnect')}
            </button>
          )}
          {!branche && !clesSaisies && (
            <span className="text-xs text-ink-500">{t('Les deux clés sont requises pour brancher.', 'Both keys are required to connect.')}</span>
          )}
        </div>

        {erreur !== null && <p className="mt-3 text-sm text-coral" data-testid="integration-batch-erreur">{erreur}</p>}
      </div>
    </section>
  );
}
```

Dans `web/app/parametres/page.tsx`, ajouter l'import à côté de celui de `BlockedContacts` :

```tsx
import { ReglageIntegrationBatch } from '@/components/ReglageIntegrationBatch';
```

et, juste avant `<BlockedContacts tenantId={tenantId} />` :

```tsx
          {/* INTÉGRATIONS (lot 6 de l'API publique) : l'outil qui reçoit les signaux. Admin seulement, comme
              tout ce bloc : un manager ne voit que la section de la prise par les agents. */}
          <ReglageIntegrationBatch tenantId={tenantId} />
```

- [ ] **Step 4 : le voir passer, et ne rien casser à côté**

```bash
cd /c/Users/julie/messagingme-mba/web && npx tsc --noEmit && npx playwright test e2e/parametres-integration-batch.spec.ts e2e/parametres.spec.ts e2e/parametres-prise-agents.spec.ts
```

Attendu : vert. `parametres-prise-agents.spec.ts` rend `{}` pour toute adresse inconnue : c'est ce qui prouve la tolérance de la carte.

- [ ] **Step 5 : commit (procédure P), APRÈS le déploiement de l'API (prérequis en tête de tâche)**

Chemins : `web/lib/api/integrations.ts web/components/ReglageIntegrationBatch.tsx web/app/parametres/page.tsx web/e2e/parametres-integration-batch.spec.ts`. Message : `feat(signaux): ecran Parametres > Integrations > Batch (lot 6)`. Ce push publie la console chez Vercel.

---

### Task 13 : La documentation, neutre sur l'outil (« Ce que nous remontons », `features.md`, `documentation.md`)

🔴 **Même prérequis que la tâche 12** (l'API de ce lot en production) : la page décrit des signaux que seule l'API déployée émet.

**Files:**
- Create: `web/lib/signaux-dictionnaire.ts`
- Create: `web/components/DocSignaux.tsx`
- Modify: `web/app/developers/api/page.tsx` (import ; `<DocSignaux />` comme DERNIÈRE section du conteneur de `DocsInner`)
- Create: `tests/web-signaux-parite.test.ts`
- Modify: `features.md` (fin de la section `## API publique …`, avant `## Brancher vos systèmes : les connecteurs API …`)
- Modify: `documentation.md:833` (tableau des files), `:1115` (secrets chiffrés), `:1535` (modules partagés)
- Modify: `todo.md` (une section neuve, juste avant `## 🟡 API publique : ce qui manque encore (mémo d'architecture du 2026-09-19, décision du 2026-09-21)`, ligne 406 sur `260ba2c6` ; procédure P')

**Interfaces:**
- Consumes : `NOMS_EVENEMENTS`, `NOMS_ATTRIBUTS`, `CHAMPS_EVENEMENT`, `CHAMP_ID_EVENEMENT` (tâche 2) ; la page et `web/lib/api-exemples.ts` du lot 4.
- Produces : `EVENEMENTS_SIGNAUX` (chaque entrée porte ses `champs`, la liste EXACTE du dictionnaire), `ATTRIBUTS_SIGNAUX`, `CHAMP_ID_DOC` ; composant `DocSignaux()`.

- [ ] **Step 1 : écrire le test qui échoue**

`tests/web-signaux-parite.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EVENEMENTS_SIGNAUX, ATTRIBUTS_SIGNAUX, CHAMP_ID_DOC } from '../web/lib/signaux-dictionnaire';
import { NOMS_EVENEMENTS, NOMS_ATTRIBUTS, CHAMPS_EVENEMENT, CHAMP_ID_EVENEMENT, type NomEvenement } from '../src/signaux/types';

/**
 * LA DOCUMENTATION DES SIGNAUX (lot 6 de l'API publique).
 *
 * 🔴 DEUX PROPRIÉTÉS, et la seconde est une demande de Julien du 2026-09-24 (« pas de mention particulière à
 * Batch dans la doc, ça doit servir à d'autres aussi ») : la doc liste EXACTEMENT le dictionnaire du serveur,
 * noms de CHAMPS compris, et elle ne nomme AUCUN outil tiers. Le nom de l'outil branché n'existe que sur son
 * écran de réglage. Les champs comptent autant que les événements : la page promet qu'ils « restent les mêmes
 * quel que soit l'outil », et c'est parce qu'ils vivent dans le dictionnaire (et pas dans un adaptateur) que la
 * promesse peut être tenue.
 */
const lire = (chemin: string): string => readFileSync(new URL(`../${chemin}`, import.meta.url), 'utf8');
const OUTILS_TIERS = /\b(batch|brevo|splio|sfmc|salesforce|hubspot|klaviyo|braze)\b/i;

describe('la documentation des signaux', () => {
  it('🔴 les événements documentés sont EXACTEMENT ceux du dictionnaire', () => {
    expect(EVENEMENTS_SIGNAUX.map((e) => e.nom).sort()).toEqual([...NOMS_EVENEMENTS].sort());
  });

  it('🔴 les attributs documentés sont EXACTEMENT ceux du dictionnaire', () => {
    expect(ATTRIBUTS_SIGNAUX.map((a) => a.nom).sort()).toEqual([...NOMS_ATTRIBUTS].sort());
  });

  it('🔴 les CHAMPS documentés de chaque événement sont EXACTEMENT ceux du dictionnaire, dans son ordre', () => {
    for (const e of EVENEMENTS_SIGNAUX) {
      expect([...e.champs], e.nom).toEqual([...CHAMPS_EVENEMENT[e.nom as NomEvenement]]);
    }
    expect(CHAMP_ID_DOC).toBe(CHAMP_ID_EVENEMENT);
  });

  it('chaque entrée a son texte dans les deux langues', () => {
    for (const e of EVENEMENTS_SIGNAUX) for (const v of [...e.quand, ...e.note]) expect(v.trim(), e.nom).not.toBe('');
    for (const a of ATTRIBUTS_SIGNAUX) for (const v of a.sens) expect(v.trim(), a.nom).not.toBe('');
  });

  it('🔴 aucun outil tiers n’est nommé : la documentation sert à tous les intégrateurs', () => {
    for (const f of ['web/lib/signaux-dictionnaire.ts', 'web/components/DocSignaux.tsx']) {
      expect(lire(f), f).not.toMatch(OUTILS_TIERS);
    }
    // La page et ses exemples : la seule occurrence tolérée est l'adresse de la route d'import par lot.
    for (const f of ['web/app/developers/api/page.tsx', 'web/lib/api-exemples.ts']) {
      expect(lire(f).replace(/contacts\/batch/g, ''), f).not.toMatch(OUTILS_TIERS);
    }
  });

  it('la section est bien rendue par la page', () => {
    expect(lire('web/app/developers/api/page.tsx')).toMatch(/<DocSignaux \/>/);
  });
});
```

- [ ] **Step 2 : le voir échouer**

```bash
npx vitest run tests/web-signaux-parite.test.ts
```

Attendu : ÉCHEC à l'import (`Failed to load url ../web/lib/signaux-dictionnaire`).

- [ ] **Step 3 : écrire le dictionnaire de la doc, sa section et son montage**

`web/lib/signaux-dictionnaire.ts` :

```ts
/**
 * LE DICTIONNAIRE DES SIGNAUX, TEL QUE LA DOCUMENTATION API LE PRÉSENTE (spec 2026-09-24, § 8).
 *
 * 🔴 PARITÉ : les noms d'événements, d'attributs ET de champs sont ceux de `src/signaux/types.ts`, ni plus ni
 * moins (`tests/web-signaux-parite.test.ts`). Un signal ou un champ ajouté côté serveur sans être documenté ici
 * fait échouer ce test. ⚠️ Le module ne les IMPORTE pas : la console est un projet séparé, qui n'importe rien de
 * `src/`. Le test est ce qui tient les deux listes d'accord.
 *
 * 🔴 AUCUN OUTIL TIERS NOMMÉ (demande de Julien du 2026-09-24) : ce texte sert à tout intégrateur, quel que soit
 * l'outil qu'il branche. Le même test le vérifie.
 */
export interface EntreeEvenement {
  nom: string;
  quand: readonly [string, string];
  /** Les noms des champs de l'événement, tels qu'ils partent : la liste EXACTE du dictionnaire, dans son ordre. */
  champs: readonly string[];
  /** Ce qu'il faut savoir de plus, en une phrase. */
  note: readonly [string, string];
}
export interface EntreeAttribut {
  nom: string;
  sens: readonly [string, string];
}

/** L'identifiant stable que porte CHAQUE événement, en plus de ses champs. */
export const CHAMP_ID_DOC = 'em_event_id';

/** Réponses, clics, désabonnements et analyses passent DEVANT les accusés dans la file. */
const PRIORITAIRE = ['Dans la minute, en priorité', 'Within a minute, with priority'] as const;
const ACCUSE = [
  'Dans la minute ; en retard derrière une grosse campagne',
  'Within a minute; delayed behind a large campaign',
] as const;

export const EVENEMENTS_SIGNAUX: readonly EntreeEvenement[] = [
  {
    nom: 'em_message_delivered', quand: ACCUSE, champs: ['canal', 'origine', 'send_id'],
    note: ['send_id seulement quand le message appartient à un envoi', 'send_id only when the message belongs to a send'],
  },
  {
    nom: 'em_message_read', quand: ACCUSE, champs: ['canal', 'origine', 'send_id'],
    note: ['Mêmes champs que la livraison', 'Same fields as delivery'],
  },
  {
    nom: 'em_message_failed', quand: ACCUSE, champs: ['canal', 'origine', 'send_id', 'motif', 'code_meta'],
    note: ['code_meta : le code d’erreur de l’opérateur, quand il en donne un', 'code_meta: the carrier error code, when it gives one'],
  },
  {
    nom: 'em_replied', quand: PRIORITAIRE, champs: ['canal', 'bouton'],
    note: ['bouton : le libellé du bouton tapé. Jamais le texte du message. Une réaction (emoji) n’est pas une réponse.', 'bouton: the label of the tapped button. Never the message text. A reaction (emoji) is not a reply.'],
  },
  {
    nom: 'em_link_clicked', quand: PRIORITAIRE, champs: ['lien', 'template', 'destination'],
    note: ['lien : le code du lien suivi. Seulement quand le clic est attribué à une fiche.', 'lien: the tracked link code. Only when the click is attributed to a contact.'],
  },
  {
    nom: 'em_opted_out', quand: PRIORITAIRE, champs: ['canal', 'source'],
    note: [
      'canal : SEULEMENT quand la personne a écrit STOP sur ce canal ; absent pour un désabonnement posé par votre équipe ou par l’API. source : d’où vient le refus (whatsapp_stop, rcs_stop, crm, api…).',
      'canal: ONLY when the person wrote STOP on that channel; absent for an unsubscribe set by your team or through the API. source: where the refusal comes from (whatsapp_stop, rcs_stop, crm, api…).',
    ],
  },
  {
    nom: 'em_conversation_analyzed',
    quand: ['À la fin d’une conversation', 'At the end of a conversation'],
    champs: [
      'intent', 'sentiment', 'satisfaction', 'urgence', 'resolved', 'topic', 'action_suggestion', 'handled_by',
      'exchanges_count', 'summary_1', 'summary_2', 'summary_3',
    ],
    note: [
      'summary_1 à summary_3 : le résumé, SEULEMENT si l’option est activée, en morceaux de 300 caractères au plus, à recoller bout à bout sans séparateur (les derniers sont absents quand il est court).',
      'summary_1 to summary_3: the summary, ONLY when the option is on, in chunks of at most 300 characters, to join end to end with no separator (the last ones are absent when it is short).',
    ],
  },
];

export const ATTRIBUTS_SIGNAUX: readonly EntreeAttribut[] = [
  { nom: 'em_contact_id', sens: ['Notre identifiant de fiche (contactId), pour nous renvoyer la fiche sans ambiguïté', 'Our contact id (contactId), to send the contact back to us unambiguously'] },
  { nom: 'em_last_intent', sens: ['L’intention de la dernière conversation analysée (mêmes valeurs que l’écran d’analyse)', 'The intent of the last analysed conversation (same values as the analysis screen)'] },
  { nom: 'em_last_sentiment', sens: ['Le sentiment de la dernière conversation analysée', 'The sentiment of the last analysed conversation'] },
  { nom: 'em_satisfaction', sens: ['La satisfaction, de 0 à 10. Absente d’une analyse, elle n’écrase pas la précédente', 'Satisfaction, from 0 to 10. Missing from an analysis, it does not overwrite the previous one'] },
  { nom: 'em_urgency', sens: ['L’urgence, de 0 à 10, même règle', 'Urgency, from 0 to 10, same rule'] },
  { nom: 'em_last_resolved', sens: ['La dernière conversation analysée est-elle résolue ?', 'Is the last analysed conversation resolved?'] },
  { nom: 'em_last_reply_at', sens: ['La date de la dernière réponse du contact', 'The date of the contact’s last reply'] },
  { nom: 'em_whatsapp_optout', sens: ['Le contact est-il désabonné ?', 'Has the contact unsubscribed?'] },
  { nom: 'em_rcs_optout', sens: ['A-t-il dit STOP sur le canal RCS ?', 'Did they say STOP on the RCS channel?'] },
  { nom: 'em_rcs_reachable', sens: ['Le dernier message RCS lui a-t-il été délivré ?', 'Was the last RCS message delivered to them?'] },
];
```

`web/components/DocSignaux.tsx` :

```tsx
'use client';

import { useT } from '@/lib/i18n';
import { EVENEMENTS_SIGNAUX, ATTRIBUTS_SIGNAUX, CHAMP_ID_DOC } from '@/lib/signaux-dictionnaire';

const inline = 'rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.8em] text-ink-800';

/**
 * « CE QUE NOUS REMONTONS » (spec 2026-09-24, § 8 et § 10) : le dictionnaire des signaux, pour l'intégrateur.
 *
 * 🔴 AUCUN OUTIL TIERS N'EST NOMMÉ ICI, NI DANS LE MODULE QUI LE NOURRIT (demande de Julien du 2026-09-24 : la
 * documentation sert à tous les intégrateurs). Le nom de l'outil branché n'apparaît que sur son écran de
 * réglage. `tests/web-signaux-parite.test.ts` le vérifie, et tient la liste alignée sur le serveur.
 */
export function DocSignaux() {
  const t = useT();
  const C = ({ children }: { children: React.ReactNode }) => <code className={inline}>{children}</code>;
  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm" data-testid="doc-signaux">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Ce que nous remontons', 'What we send back')}</h3>
      <div className="mt-3 space-y-3 text-sm text-ink-700">
        <p>
          {t(
            'Quand il se passe quelque chose sur une fiche, la console pousse un événement, avec l’état courant de la fiche, vers l’outil que votre administrateur a branché dans Paramètres > Intégrations. Les noms commencent par ',
            'When something happens on a contact, the console pushes an event, with the contact’s current state, to the tool your administrator connected in Settings > Integrations. Names start with ',
          )}
          <C>em_</C>
          {t(
            ' ; ces noms, et ceux des champs de chaque événement, restent les mêmes quel que soit l’outil. Un texte fait 300 caractères au plus, et une valeur absente ou vide n’est pas envoyée.',
            '; these names, and those of each event’s fields, stay the same whatever the tool. A text is at most 300 characters long, and a missing or empty value is not sent.',
          )}
        </p>
        <p>
          {t(
            'Seuls les outils proposés dans Paramètres > Intégrations reçoivent ces signaux : ce n’est pas un webhook vers une adresse de votre choix, et un outil absent de cette liste ne reçoit rien.',
            'Only the tools offered in Settings > Integrations receive these signals: this is not a webhook to an address of your choice, and a tool missing from that list receives nothing.',
          )}
        </p>
        <p>
          {t('Le profil est désigné par votre identifiant, ', 'The profile is designated by your own id, ')}
          <C>externalId</C>
          {t(
            ' : une fiche qui n’en porte pas n’est pas remontée, et l’écran du réglage compte ces signaux. Passez-le à chaque appel (fiche, envoi, message).',
            ': a contact without one is not sent back, and the settings screen counts those signals. Pass it on every call (contact, send, message).',
          )}
        </p>
        <p>
          {t('Chaque événement porte un ', 'Every event carries a stable ')}
          <C>{CHAMP_ID_DOC}</C>
          {t(' stable : un même événement peut arriver deux fois, dédupliquez sur cet identifiant.', ': the same event can arrive twice, deduplicate on it.')}
        </p>
        <p>
          {t(
            'Les signaux partent par une file : comptez moins d’une minute en temps normal. Les réponses, les clics, les désabonnements et les conversations analysées passent DEVANT les accusés de livraison et de lecture ; derrière une campagne de plusieurs milliers de destinataires, ces accusés peuvent arriver avec plusieurs dizaines de minutes de retard. Chaque événement porte l’heure où il s’est produit, pas celle où il arrive.',
            'Signals go through a queue: expect less than a minute in normal conditions. Replies, clicks, unsubscribes and analysed conversations go AHEAD of delivery and read receipts; behind a campaign of several thousand recipients, those receipts can arrive tens of minutes late. Every event carries the time it happened, not the time it arrives.',
          )}
        </p>
        <p>
          {t(
            'Le texte d’un message n’est JAMAIS remonté. Le résumé d’une conversation ne l’est que si l’option est activée dans le réglage : il contient des propos du client.',
            'A message’s text is NEVER sent back. A conversation summary is sent only when the option is on in the settings: it contains the customer’s words.',
          )}
        </p>
        <p>
          {t(
            '« À la fin d’une conversation » veut dire : 25 minutes sans message, puis le passage de l’analyse, toutes les 5 minutes. Comptez environ une demi-heure après le dernier message : assez pour une relance, pas pour une alerte immédiate.',
            '“At the end of a conversation” means: 25 minutes without a message, then the analysis pass, every 5 minutes. Expect about half an hour after the last message: enough for a follow-up, not for an immediate alert.',
          )}
        </p>
        <p>
          {t('Valeurs de ', 'Values of ')}<C>origine</C>{' : '}
          <C>humain</C>, <C>scenario</C>, <C>ia</C>, <C>mba</C>, <C>campagne</C>, <C>mcp</C>, <C>api</C>
          {t(' ; de ', '; of ')}<C>canal</C>{' : '}<C>whatsapp</C>, <C>rcs</C>
          {t(
            ". Une note absente (satisfaction, urgence) veut dire « pas de mesure » : elle n'écrase jamais la précédente.",
            '. A missing score (satisfaction, urgency) means “no measure”: it never overwrites the previous one.',
          )}
        </p>

        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-ink-100 text-ink-500">
              <th className="py-1.5 pr-3 font-medium">{t('Événement', 'Event')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('Quand', 'When')}</th>
              <th className="py-1.5 font-medium">{t('Champs', 'Fields')}</th>
            </tr>
          </thead>
          <tbody>
            {EVENEMENTS_SIGNAUX.map((e) => (
              <tr key={e.nom} className="border-b border-ink-50 align-top">
                <td className="py-1.5 pr-3"><C>{e.nom}</C></td>
                <td className="py-1.5 pr-3 text-ink-600">{t(...e.quand)}</td>
                <td className="py-1.5 text-ink-600">
                  <span className="flex flex-wrap gap-1">
                    {e.champs.map((c) => <C key={c}>{c}</C>)}
                  </span>
                  <span className="mt-1 block">{t(...e.note)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-ink-100 text-ink-500">
              <th className="py-1.5 pr-3 font-medium">{t('Attribut de la fiche', 'Contact attribute')}</th>
              <th className="py-1.5 font-medium">{t('Sens', 'Meaning')}</th>
            </tr>
          </thead>
          <tbody>
            {ATTRIBUTS_SIGNAUX.map((a) => (
              <tr key={a.nom} className="border-b border-ink-50 align-top">
                <td className="py-1.5 pr-3"><C>{a.nom}</C></td>
                <td className="py-1.5 text-ink-600">{t(...a.sens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

Dans `web/app/developers/api/page.tsx`, ajouter l'import `import { DocSignaux } from '@/components/DocSignaux';` et rendre `<DocSignaux />` comme DERNIER enfant du conteneur `max-w-3xl space-y-4` de `DocsInner` (`data-testid="doc-api"`), donc après « Exemples complets » (`#exemples`), la dernière section que le lot 4 y pose. L'e2e du lot 4 (`web/e2e/developers-api.spec.ts`, « la page rendue ne nomme aucun outil tiers ») lit le texte rendu de TOUT `doc-api`, cette section comprise : il doit rester vert après ce montage (le relancer à l'étape 7).

- [ ] **Step 4 : `features.md`, sous la section de l'API (sa décision `integrateurs` couvre la sous-section)**

À la fin de la section `## API publique …` (quel que soit le titre exact que le lot 4 lui a laissé), avant `## Brancher vos systèmes : les connecteurs API …`, ajouter une sous-section de niveau `###`, jamais `##` (une section `##` neuve exigerait une fiche d'aide ou une entrée de `SECTIONS_SANS_FICHE`, `tests/aide-proposer.test.ts`) :

```markdown
### Ce que la console remonte vers l'outil du client (Paramètres > Intégrations)

- ✅ **Un dictionnaire de signaux, le même pour tous les outils** : quand un message est délivré, lu ou en
  échec, quand le contact répond, clique un lien suivi ou se désabonne, et quand sa conversation est analysée,
  la console pousse un ÉVÉNEMENT, avec l'état courant de la fiche, vers l'outil qu'un admin a branché dans
  **Paramètres > Intégrations**. Les noms commencent par `em_`, et les noms des champs de chaque événement sont
  fixés par le dictionnaire : un adaptateur par outil les TRANSPORTE, il ne les renomme pas. La liste complète
  est dans Developers > Documentation API, section « Ce que nous remontons ».
  🔴 **Jamais le texte d'un message.** Le résumé d'une conversation seulement si l'admin coche l'option,
  décochée par défaut : il contient des propos du client. Il part en morceaux de 300 caractères au plus
  (`summary_1` à `summary_3`), la borne de texte la plus stricte des outils connus.
  ⚠️ **Les réponses, clics, désabonnements et analyses passent devant les accusés** de livraison et de
  lecture (priorité de file) : derrière une campagne de plusieurs milliers de destinataires, ces accusés
  peuvent arriver avec plusieurs dizaines de minutes de retard, pendant que les réponses continuent de partir
  dans la minute. Chaque événement porte l'heure où il s'est produit.
  ⚠️ **Le canal d'un désabonnement n'est dit que s'il est prouvé** : la personne a écrit STOP sur ce canal.
  Un désabonnement posé par l'équipe ou par l'API ne porte que sa source.
  ⚠️ **Le profil est désigné par l'`externalId`** que l'outil nous passe par l'API. Une fiche qui n'en porte
  pas n'est pas remontée, et l'écran du réglage COMPTE ces signaux : un intégrateur qui a oublié de nous
  passer ses identifiants le voit, au lieu de trouver son outil vide.
  ⚠️ **Une poussée refusée se lit dans Sécurité > Journal des erreurs**, moitié « système ». Des clés
  refusées par l'outil suspendent la remontée jusqu'à ce qu'on en enregistre de nouvelles, et l'écran le dit.
  ⚠️ « Conversation analysée » arrive environ une demi-heure après le dernier message : assez pour une
  relance, pas pour une alerte.
```

- [ ] **Step 5 : `documentation.md`, sans nommer l'outil**

Ligne 833, la ligne « de fond » du tableau des files devient :

```markdown
| de fond (personne n'attend) | 30 s | `webhook-status`, `analyze-conversation`, `push-analysis`, `hubspot-catchup`, `optout-poussee`, les files d'adaptateur de signaux (`signaux-*`) |
```

Ligne 1115, la phrase « Chiffrés au repos » se termine par :

```markdown
passe SMTP (`email_accounts.password_enc`), les secrets de connecteur API (`agent_tool_sources`), les clés d'un
outil qui reçoit les signaux (la table de son adaptateur, dans `src/signaux/`).
```

Après la ligne `| \`src/queue/names.ts\` | … |` du tableau des modules partagés (ligne 1535) :

```markdown
| `src/signaux/types.ts` | 🔴 le DICTIONNAIRE des signaux remontés vers l'outil d'un client, indépendant de tout outil : noms d'événements et d'attributs, noms des CHAMPS de chaque événement (`CHAMPS_EVENEMENT`), borne des textes, résumé en morceaux, `idSignal` (l'`em_event_id` STABLE et opaque), libellé neutre du journal des erreurs. Un adaptateur le traduit, il ne l'étend ni ne le renomme |
| `src/signaux/emetteur.ts` | 🔴 le SEUL point d'émission d'un signal : il ne lève jamais, ne lit rien tant qu'aucun espace n'a branché d'outil, ne transporte que ce que le chemin chaud sait déjà, et enfile des jobs bornés (`SIGNAUX_PAR_JOB`) avec leur priorité (`PRIORITE_SIGNAL` : les accusés derrière). La fiche, l'origine et l'analyse se relisent au moment de pousser (`completer.ts`) |
```

- [ ] **Step 6 : `todo.md`, le piège armé de la facturation (procédure P')**

`agent_tool_calls` est AUSSI le grand livre de facturation (migration 0086 : « c est la meme table, volontairement »), et rien ne la lit pour facturer aujourd'hui (vérifié : son seul lecteur est `PgErreursLivraisonStore.listerEchecsSysteme`). Ce lot y écrit des lignes qui ne sont pas des appels d'outil. Juste avant la ligne `## 🟡 API publique : ce qui manque encore (mémo d'architecture du 2026-09-19, décision du 2026-09-21)`, ajouter :

```markdown
## 🟡 La facturation qui lira `agent_tool_calls` devra exclure `source = 'signaux'` (lot 6 de l'API publique, 2026-09-24)

`agent_tool_calls` est AUSSI le grand livre de facturation (commentaire de la migration 0086 : « c est la meme
table, volontairement »). Depuis le lot 6, la remontée des signaux vers l'outil d'un client y écrit ses poussées
RATÉES (`source = 'signaux'`, une ligne par tranche refusée ou par succès partiel ; 401 et 403 suspendent la
remontée au lieu d'écrire une ligne par signal). Ce ne sont PAS des appels d'outil facturables.

- **Le geste** : le jour où une requête de facturation lit cette table, elle exclut `source = 'signaux'`, et un
  test le garde (une ligne `signaux` écrite, relue, et absente du compte facturé).
- ⚠️ **Piège ARMÉ, pas une fuite ouverte** : aucune facturation ne lit la table aujourd'hui, son seul lecteur est
  le journal des erreurs (`PgErreursLivraisonStore.listerEchecsSysteme`).
- ⚠️ **Et la table n'est jamais purgée** : si un espace branché accumule des refus (un `custom_id` refusé par
  l'outil, fiche après fiche), les lignes s'additionnent. À surveiller à la première mise en production d'un
  client branché, pas à anticiper.
```

- [ ] **Step 7 : le voir passer, et les gardes de la doc**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/web-signaux-parite.test.ts tests/aide-proposer.test.ts tests/documentation-hygiene.test.ts && cd web && npx tsc --noEmit
```

Attendu : vert. Puis, après l'annonce d'une suite e2e aux autres sessions, `cd web && npx playwright test e2e/developers-api.spec.ts` (l'e2e du lot 4, qui lit maintenant aussi cette section) : vert. Puis `grep -n -i "batch" features.md documentation.md` sur les SEULES lignes ajoutées par cette tâche : aucune occurrence (la seule tolérée dans `features.md` est l'adresse `/v1/contacts/batch`).

- [ ] **Step 8 : commit (procédure P, avec P' pour `todo.md`), APRÈS le déploiement de l'API (prérequis en tête de tâche)**

Chemins : `web/lib/signaux-dictionnaire.ts web/components/DocSignaux.tsx web/app/developers/api/page.tsx tests/web-signaux-parite.test.ts features.md documentation.md todo.md` (ce dernier par son blob construit depuis `origin/main` ; `features.md` et `documentation.md` aussi, si l'étape 1 de P y montre un hunk étranger). Message : `docs(signaux): Ce que nous remontons, sans nommer aucun outil, et le piege de la facturation au backlog (lot 6)`. Ce push publie la console chez Vercel.

---

### Task 14 : Vérification finale, console publiée, essai réel

**Files:** aucun, sauf `CLAUDE.md` et `docs/JOURNAL-TECHNIQUE.md` par `/sync` à la fin.

- [ ] **Step 1 : suite complète, typage des deux côtés, CI**

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck && npm test && cd web && npx tsc --noEmit
gh run list --limit 5
gh run view <id du dernier run de code> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Attendu : vert partout, chaque job en `success`.

- [ ] **Step 2 : la console publiée**

Ouvrir Paramètres en production avec un compte admin : la carte « Intégrations > Batch » affiche « Non branché ». Ouvrir Developers > Documentation API : la section « Ce que nous remontons » est là, et aucun outil tiers n'y est nommé.

- [ ] **Step 3 : l'essai réel** (section « Essai réel qui clôt le lot »). Sans espace Batch de test, s'arrêter là et le DIRE : le lot est vert, pas éprouvé.

- [ ] **Step 4 : `/revue` sur les tâches 12 à 14, puis `/sync`** (le récit du déploiement et de l'essai dans `docs/JOURNAL-TECHNIQUE.md`, la conclusion généralisable s'il y en a une).

---

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Le lot se branche sur des chemins que la production emprunte à chaque message (accusés Meta sur deux files, rappels RCS, entrants, redirection des liens déjà envoyés, désabonnements) et touche l'abstraction de file partagée par toutes les files ; il fait SORTIR des données de contacts de l'espace vers un tiers, ce qui ne se rattrape pas ; et il porte des invariants qu'aucun compilateur ne voit (zéro requête sur un statut `sent`, jamais le texte d'un message, le résumé seulement si coché et entier, aucun texte vide ni de plus de 300 caractères, la priorité des signaux sur les accusés, un 4xx terminal, l'ordre des consommateurs de `onAnalyzed`) : les critères se testent, mais leur place dans le câblage demande un œil.

L'essai réel qui clôt ce lot, sur un espace Batch de test (prérequis à obtenir de Batch), est décrit dans la section « Essai réel qui clôt le lot » ci-dessous : sans lui, le lot est vert, pas éprouvé.

## Essai réel qui clôt le lot

Repris du § 14, item 6 de la spec. 🔴 **Prérequis : un espace Batch de test, à obtenir de Batch.** Sans lui, le lot 6 reste vert, pas éprouvé, et on le dit.

Avant l'essai, faire confirmer par Batch les trois points ouverts du § 8 : qu'un événement ou un attribut poussé déclenche bien une orchestration ; s'ils rejouent un appel du Universal Channel en cas d'échec ; quelle variable rend un passage unique (pour la clé d'idempotence). Vérifier aussi que l'analyse des conversations est allumée en production (`CONVERSATION_ANALYSIS_ENABLED=true`), sans quoi `em_conversation_analyzed` ne part jamais.

Avec une VRAIE clé, en production, sur le numéro d'essai, en regardant le téléphone, l'Inbox, Paramètres et le profil dans Batch :

1. Paramètres > Intégrations > Batch : brancher les deux clés du projet de test, laisser le résumé décoché. La carte dit « Branché ».
2. Dans Batch, une étape Universal Channel appelle `POST /v1/sends` avec `externalId` (le `custom_id` du profil), `phone` (le numéro d'essai), `consent` et `idempotencyKey` dans le corps, sur un template qui porte un lien suivi soumis APRÈS le 2026-09-02 (seule la forme attribuée `/r/<code>/<jeton>` fait un signal de clic).
3. Le WhatsApp arrive sur le téléphone. On répond en tapant un BOUTON, puis on clique le lien.
4. Sur le profil Batch apparaissent `em_message_delivered`, `em_message_read`, `em_replied` (avec `bouton`, sans texte), `em_link_clicked`, chacun avec son `em_event_id` ; l'attribut `em_contact_id` vaut l'identifiant que la fiche du mini-CRM affiche.
5. Environ une demi-heure après le dernier message, `em_conversation_analyzed` apparaît, SANS `summary_1`. Cocher l'option, refaire une conversation de plusieurs échanges : `summary_1` apparaît (et `summary_2` si le résumé dépasse 300 caractères), et les morceaux recollés redonnent le résumé qu'affiche l'écran d'analyse. Dans Sécurité > Journal des erreurs, AUCUNE ligne de succès partiel pour ce signal (un texte trop long ou vide y en écrirait une).
6. Répondre STOP : `em_opted_out` apparaît avec `canal = whatsapp` et `source = whatsapp_stop`, et `em_whatsapp_optout` passe à vrai. Puis réabonner la fiche, et la désabonner depuis la fiche du mini-CRM : `em_opted_out` arrive SANS `canal`, avec `source = crm`.
7. La priorité est bien partie jusqu'à pg-boss, lue en base en LECTURE SEULE après les étapes 3 et 6 : `select data->'signaux'->0->>'nom' as nom, priority from pgboss.job where name = 'signaux-batch' order by created_on desc limit 10;` rend `priority = 1` pour `em_replied`, `em_link_clicked` et `em_opted_out`, `0` pour les accusés. (Mesurer le retard réel derrière une grosse campagne demanderait des milliers de destinataires : hors essai, c'est ce que la priorité existe pour éviter, et la documentation le dit sans chiffre mesuré.)
8. Négatif : un envoi vers une fiche SANS `externalId` fait monter le compte « signaux non poussés » de la carte. Enregistrer une clé REST fausse : une ligne « Outil branché (Paramètres > Intégrations) : mise à jour des profils », appelant « la remontée des signaux vers votre outil », apparaît dans Sécurité > Journal des erreurs, sans le nom de l'outil nulle part sur la ligne, et la carte annonce la suspension ; remettre la bonne clé la lève.
9. Débrancher : plus aucun signal ne part (vérifier dans Batch après un nouvel envoi).

## Rayon de souffle

Repris du § 17 et complété par la lecture du code :

- **`processStatuses` et `onDlr`, chemins CHAUDS** : le puits est le DERNIER bloc, isolé, best-effort ; sur un statut `sent` il ne lit rien, et tant qu'aucun espace n'a branché d'outil il ne résout même pas le numéro (tests « ne lit RIEN »). Pour un espace branché : deux lectures en cache et un enfilement par accusé `delivered`, `read`, `failed`. Le lot 3 a modifié les mêmes fonctions : relire son bloc de capture des échecs, le puits vient APRÈS lui et ne dépend pas de lui.
- **`webhook` ET `webhook-status`** : les accusés arrivent par les deux files ; le type (`WebhookJobDeps`) exige désormais le puits dans le couple de `delivery`, et `tests/signaux-cablage.test.ts` en compte deux.
- **`processInbound`** : ses dépendances secondaires passent dans un objet NOMMÉ (`DepsEntrants`) ; le puits est appelé APRÈS `recordInbound`, isolé. Qui supposait l'ancienne forme positionnelle : le handler (ligne 146) et `tests/crm-consentement.test.ts`, réécrits sans perdre un cas ; les appels à deux arguments (`tests/detenteur-du-fil.test.ts`, `tests/inbound.test.ts`) ne bougent pas. `WebhookJobDeps` exige le puits avec `inbox` : les appels de `handleWebhookJob` dans les tests portent les fixtures `aucunSignalAccuse` / `aucunSignalReponse`, qui DISENT l'hypothèse.
- **Le `standby`** : un message du CONTACT extrait en `standby` devient une réponse (l'écho de l'agent de Meta vit sous `message_echoes`, que `extractInbound` ne lit pas, test à l'appui) ; une réaction, un type `unsupported`, `system` ou inconnu n'en devient pas une (`TYPES_DE_REPONSE`, liste positive). L'avance de scénario et les automations, elles, continuent de refuser le `standby` : rien ne change pour elles.
- **`PgContactStore` et l'annonce d'opt-out** : la composition appelle l'annonce D'ABORD, inchangée ; une annonce qui lève remonte toujours au dépôt, qui la journalise ; le signal part quand même (`finally`). `tests/optout-poussee.test.ts` ne regarde que le dépôt, il ne bouge pas. Une action en masse de N fiches sur un espace branché fait `N / SIGNAUX_PAR_JOB` enfilements (arrondi au-dessus) dans la requête HTTP, et non N. ⚠️ Le `canal` du signal n'est plus celui du dépôt : il est déduit de la source relue au moment de pousser, et reste absent quand personne n'a écrit STOP.
- **`src/queue/queue.ts`, `pgboss.ts`, `fake.ts`, l'abstraction de TOUTES les files** : `enqueue` gagne une option `priority`, transmise à `boss.send` par une fonction pure (`sendOptions`) qui rend EXACTEMENT l'objet d'avant quand l'option est absente (test « une absence reste une absence »). Aucun appelant existant ne la passe, donc aucune file ne change d'ordre de prise ; seule `signaux-batch` s'en sert. ⚠️ pg-boss trie déjà par `priority desc` à chaque prise (défaut de sa requête), avec une priorité à 0 partout aujourd'hui : l'ordre des autres files est inchangé par construction.
- **Le débit de `signaux-batch`** : un job par espace à la fois. Les accusés d'une grosse campagne s'écoulent un job par accusé, donc peuvent arriver avec du retard, ce que la documentation dit ; réponses, clics, désabonnements et analyses passent devant (priorité 1). Lire la file par lots (`batchSize`) résorberait ce retard mais casserait l'invariant « un job par appel » de `PgBossQueue.work` : hors lot.
- **`contexteDuMessage`** : une troisième sous-requête, sur `campaign_envois` (index `campaign_envois_message_id_idx`, 0134), lue seulement quand `campaign_recipients` ne connaît pas le message : l'accusé d'un étage remplacé d'une chaîne de repli retrouve son envoi. Hors chemin chaud (elle tourne dans le travail de la file).
- **Le STOP RCS** n'écrit pas par le dépôt des contacts (`rcs_optout_at`, `src/rcs/store.pg.ts:191`) : il émet lui-même son signal dans `onMo`. Le désabonnement de l'API du lot 1 doit, lui, passer par le dépôt (tâche 9, étape 5).
- **`makeOnAnalyzed` et la poussée HubSpot** : inchangés. `onAnalyzed` gagne un TROISIÈME consommateur, placé AVANT l'automation parce que celle-ci sort de la fonction (`if (!ctx) return;`) ; chacun garde son `try`.
- **La redirection `/r/`** : nouvelle dépendance requise `signalerClic`, appelée seulement pour un clic attribué et non automatique, LANCÉE SANS ÊTRE ATTENDUE (contrairement à `recordClick`), sa panne journalisée : ni la lecture des espaces actifs ni l'enfilement ne s'ajoutent au chemin du 302 (test « n'ATTEND PAS », mutation 7). Les liens déjà envoyés ne changent pas (porte à sens unique).
- **`agent_tool_calls`** : CHECK relâché pour `signaux`, parité tenue par `tests/sources-appel-parite.test.ts`. La table n'est JAMAIS purgée : un 4xx écrit une ligne par tranche refusée (sauf 401 et 403, qui suspendent). Le jour où la facturation lira cette table (son commentaire de 0086 le promet), elle devra exclure `source = 'signaux'` : consigné dans `todo.md` (tâche 13, étape 6), pas seulement ici.
- **`ErreursSysteme`** : un libellé de plus pour `signaux` (« la remontée des signaux vers votre outil »). Le nom de la ligne (`NOM_APPEL_SIGNAUX`) et le message d'erreur (`BatchApiError`) ne nomment PAS l'outil : la spec (§ 10) réserve ce nom à l'écran de réglage de son adaptateur, et deux tests le gardent (`tests/signaux-types.test.ts`, `tests/signaux-travail-batch.test.ts`).
- **La borne des textes** : 300 caractères et jamais vide, pour un attribut de fiche COMME d'événement ; le résumé part en `summary_1` à `summary_3`. Ce qui supposait l'ancienne forme : la spec (§ 8 et § 13), corrigée dans la tâche 3. Rien dans le code n'écrivait encore `summary`.
- **`ENCRYPTION_KEY`** : vide par défaut, et la configuration ne l'exige que pour d'autres fonctions. La route du réglage rend 503 lisible à qui envoie des clés sur une instance qui ne sait pas chiffrer ; changer la seule option reste permis.
- **`BASE_QUEUES`** : `/ops` montre une file de plus et sa DLQ ; deux sondeurs de plus toutes les 30 s (concurrence 2), au repos comme en charge.
- **Les caches par process** : un branchement fait depuis l'écran n'atteint les signaux émis par le WORKER qu'au plus une minute après ; ceux de l'API tout de suite (invalidation). Les signaux de cette minute sont perdus, pas différés.
- **Le journal d'audit** : trois actions neuves (`integration.branchee`, `.modifiee`, `.debranchee`), sans CHECK en base ; le détail ne porte jamais les clés (garde `CLES_INTERDITES` inchangée).
- **`tests/scope-tenant.test.ts`** couvre le nouveau module sans qu'on l'écrive (registre).
- **La page Paramètres** : les e2e existants rendent `{}` pour une adresse inconnue ; la carte le lit comme « non branché ».
- **`features.md`** : sous-section `###` dans la section de l'API, qui reste sous sa décision `integrateurs` de `SECTIONS_SANS_FICHE`.
- **Sécurité** : clés chiffrées (`secretbox`), jamais relues par un écran ni écrites au journal ; Batch est un hôte fixe (pas de garde d'adresse publique) ; le texte d'un message ne sort jamais ; le résumé seulement si coché ; l'`em_event_id` est opaque ; les jobs portent un `wa_id`, comme les jobs de webhook existants.
- **Isolation** : `tenant_id = $1` sur toutes les lectures de `PgSignauxStore` et de `PgIntegrationBatchStore`, sauf `espacesActifs`, transverse par construction et documentée. Tenu dans les DEUX sens par `tests/signaux-isolation.test.ts` (qui lit les requêtes réelles et se mute en local), et dans le sens vert par le test d'intégration, contre une vraie base ; le sens rouge de ce dernier n'est pas joué, et la tâche 11 dit pourquoi.

## Déploiement

1. **Prérequis** : les lots 1 à 5 sont en production (la colonne `contacts.external_id` existe en base). `gh run list`, puis `gh run view <id> --json jobs` sur le dernier commit de CODE du lot 6 : chaque job en `success`, `integration` compris. `git log <commit déployé>..origin/main` : relire ce qui part.
2. **`/revue-finale`** : la garde de déploiement l'exige avant tout `compose up` et toute migration par `ssh`.
3. **Sur le VPS** : `git pull`, `sudo docker compose build mba-api`, puis `sudo docker compose run --rm --no-deps mba-api npm run migrate`. La migration `<N>_signaux_batch` est additive et relâchante : elle passe AVANT le `up` (le code neuf lit `integration_batch` dès le démarrage, et écrit `signaux` dans le journal).
4. **Relire en base, juste après `migrate`, point par point** :
   - `select name, applied_at from public.schema_migrations order by name desc limit 3;` : `<N>_signaux_batch.sql` en tête ;
   - `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'integration_batch' order by ordinal_position;` : les huit colonnes, `envoyer_resume` à `false` par défaut, `sans_identifiant` à `0` ;
   - `select pg_get_constraintdef(oid) from pg_constraint where conname = 'agent_tool_calls_source_check';` : la liste contient `signaux` ;
   - `select count(*) from integration_batch;` : `0`, donc rien n'a bougé pour personne.
5. **`sudo docker compose up -d --build mba-api mba-worker`** (l'API monte la route et émet ; le worker consomme la file et émet).
6. **Contrôle public des deux portes** : `curl -s -o /dev/null -w '%{http_code}\n' https://api.messagingme.app/health` et `https://mba.messagingme.app/api/backend/health` rendent `200` ; la route du réglage rend `401` sur les deux (`/tenants/00000000-0000-4000-8000-000000000000/integrations/batch`). Un `502` alors que les conteneurs sont `healthy` : `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`, puis recontrôler.
7. **Le worker a bien pris la file** : `sudo docker compose logs --tail 80 mba-worker | grep signaux-batch` montre la file dans la liste de démarrage.
8. **`CLAUDE.md`** : « Dernière appliquée : <N> » avec l'horodatage lu dans `schema_migrations`, et <N> retiré de « écrite et pas encore appliquée ». Procédure P, avec P' pour `CLAUDE.md` (fichier partagé), comme en tâche 1. Message : `docs(migrations): <N> est appliquee, relue en base point par point`.
9. **Seulement ensuite**, tâches 12 et 13 : leur `git push` publie la console chez Vercel (écran du réglage, section de la doc). Pousser l'écran avant le `up` l'aurait fait appeler une route que la production n'avait pas.
10. **Essai réel** (section ci-dessus), puis `/sync`.
