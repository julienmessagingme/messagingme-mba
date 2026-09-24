# Intentions de commerce en ligne (lot 5 de l'API publique) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'analyse des conversations sait classer `achat`, `suivi_commande` et `retour`, la base l'accepte, et chaque écran, export et statistique qui nomme une intention les connaît, sans reclasser les analyses passées.

**Architecture:** `INTENTS` (`src/analysis/schema.ts`) reste la seule liste qui fait foi. Une migration RELÂCHE le CHECK posé en ligne par 0027 ; le prompt, les statistiques et le filtre de la route DÉRIVENT de `INTENTS` ; la console, qui n'importe jamais `src/`, porte UNE copie dans un module partagé par ses deux écrans (`web/lib/intentions.ts`) et tolère une API plus ancienne qui ne connaît pas les valeurs neuves. Un test de parité à la racine (`tests/intentions-parite.test.ts`) exige que la base, le prompt, le SQL des statistiques et la console nomment exactement les valeurs de `INTENTS`.

**Tech Stack:** TypeScript, zod 4, Fastify, Postgres (migrations SQL maison, `db/migrate.ts`), vitest (racine et `web/`), Next.js (console), Playwright (e2e intercepté).

**Spec:** `docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md` (§ 7, § 11 dernière puce, § 13 « Intentions », § 16, § 17).

## Global Constraints

- Spec § 7, mot pour mot : « La liste `INTENTS` (`src/analysis/schema.ts`) gagne trois valeurs : `achat` (le client veut acheter), `suivi_commande` (où en est ma commande), `retour` (retour ou échange d'un produit). »
- Spec § 7 : « Le prompt de l'analyse (`src/analysis/engine.ts`) décrit chacune, pour que le modèle sache les distinguer de `demande_devis`, `sav` et `reclamation`. »
- Spec § 7 : « Les analyses passées ne sont PAS reclassées : elles gardent leur intention d'origine. » Aucune instruction de ce lot ne met à jour une ligne existante de `conversation_analysis` ou d'`analyse_jour`.
- Spec § 7 : si 0027 contraint l'intention, « une migration la RELÂCHE avant le déploiement (l'ancien code y survit) ». C'est le cas (tâche 1).
- Spec § 13 : « la liste de `schema.ts`, le prompt et les libellés des écrans nomment les MÊMES valeurs (dérivé, pas relu à la main) ».
- Ce lot ne consomme RIEN des lots 1 à 4 : il vient après eux par l'ordre des lots, pas par une dépendance de code. Le lot 6 consomme ce qu'il produit.
- Rédaction (code, commentaires, commits, docs) : aucun tiret cadratin ni demi-cadratin ; jamais le nom de l'infrastructure de messagerie sous-jacente.
- Aucun outil tiers nommé dans ce qui se lit hors de l'équipe : la page de doc API (que ce lot ne touche pas) et `features.md`. Le journal technique (`docs/JOURNAL-TECHNIQUE.md`), interne, PEUT nommer notre connecteur HubSpot (`mm-hubspot`) et sa propriété `mm_last_intent` : c'est le fait technique vérifié à la tâche 1, et le taire le rendrait invérifiable.
- Tests d'INTÉGRATION : écrits ici, JAMAIS lancés en local (le `DATABASE_URL` du `.env` local est la PRODUCTION). Leur verdict se lit sur le run GitHub, job par job : `gh run view <id> --json jobs`, jamais le code de sortie de `gh run watch`.
- Commandes unitaires : `npx vitest run <fichier>` (racine), `cd web && npx vitest run <fichier>` (console), `npm run typecheck`, `npm test`.
- Commits : `git commit --only <chemins touchés par la tâche>`, JAMAIS `git add` puis `git commit` nu ; la liste se construit depuis ce que la tâche a touché, jamais depuis `git status`. Relire `git diff <ces chemins>` juste avant de commiter : l'arbre est partagé par d'autres sessions. Si le hook `rayon-de-souffle` refuse le premier commit pour afficher sa liste, relire `git diff <chemins>` AVANT de relancer. Pas de branche, pas de worktree, push par `git push origin main`.
- 🔴 **Les lots 1 et 2 commitent en PLOMBERIE, et les lots 3 et 4 après eux** (procédure P du lot 1, `docs/superpowers/plans/2026-09-24-api-v1-lot1-identite-contacts.md`, § « Procédure de commit P »), qui ne fait JAMAIS avancer le `main` local. Quand ce lot commence, le `main` local est donc en retard sur `origin/main` : un `git commit --only` s'y poserait sur une base périmée, et `git push origin main` serait refusé (ou pousserait les commits locaux non poussés d'une autre session). Contrôle au début de chaque commit : `git fetch -q origin && test "$(git rev-parse main)" = "$(git rev-parse origin/main)"`. S'il échoue (le cas attendu après les lots précédents), le commit de la tâche passe par la procédure P du lot 1 (et P' pour `CLAUDE.md`), avec les MÊMES chemins et le MÊME message que la commande `--only` écrite dans la tâche, qui ne sert alors plus qu'à les donner. Jamais `git pull`, `git merge` ni `git reset` dans l'arbre partagé pour « rattraper » `main`.
- Ce lot ne touche AUCUN fichier de câblage partagé (`src/index.ts`, `src/server.ts`, `src/worker.ts`).
- Migration : numéro pris AU MOMENT D'ÉCRIRE (`ls db/migrations | tail -1`, le dossier tranche sur ce qui est pris), additive, appliquée AVANT le `up` de l'API, relue en base juste après `migrate`.
- Un test de non-régression se vérifie DANS LES DEUX SENS : remettre le code fautif, voir l'échec ET son symptôme, restaurer, revoir vert.
- Zod : `safeParse`, jamais `parse` ni `as` sur une entrée externe. `tenant_id = $1` sur chaque requête (aucune requête neuve ici n'en manque).
- Ne jamais recopier un compteur calculable en prose (nombre de tests, de valeurs, de migrations).
- 🔴 La console (tâches 5 et 6) ne se POUSSE qu'APRÈS le déploiement de l'API (étape A du Déploiement) : voir la section Déploiement pour la raison.

## Carte des fichiers

| Fichier | Rôle dans ce lot |
|---|---|
| `src/analysis/schema.ts` | `INTENTS` gagne trois valeurs, et un type `Intent` exporté |
| `db/migrations/<N>_intentions_commerce.sql` | relâche `conversation_analysis_intent_check` |
| `src/analysis/engine.ts` | `DESCRIPTIONS_INTENTION`, et la ligne `- intent :` dérivée de `INTENTS` |
| `src/analysis/store.pg.ts` | un commentaire qui cite 0027 comme seule garde de l'énumération |
| `src/stats/conversation-stats.pg.ts` | l'agrégat journalier et la synthèse comptent les trois valeurs, `intent: Record<Intent, number>` |
| `src/http/stats.ts` | le filtre `?intent=` dérive de `INTENTS` |
| `web/lib/intentions.ts` (nouveau) | la copie de la console : liste, ordre d'affichage, libellés, repli à zéro |
| `web/components/CarteIntentions.tsx`, `web/components/ConversationAnalysisCard.tsx` | consomment `web/lib/intentions.ts` au lieu de leurs copies |
| `web/lib/api/stats.ts` | `intent` devient `Partial<Record<Intention, number>>` |
| `web/lib/quali-export.ts` | **inchangé**, vérifié : il ne nomme aucune intention, le libellé lui est INJECTÉ (`libelles.intent`) par `ConversationAnalysisCard` |
| `tests/intentions-parite.test.ts` (nouveau) | la parité dérivée : base, prompt, SQL, console, et aucune copie restante dans les deux écrans |
| `tests/integration/intentions.integration.test.ts` (nouveau) | le CHECK et les statistiques contre un vrai Postgres (CI seulement) |
| `features.md`, `docs/JOURNAL-TECHNIQUE.md`, `CLAUDE.md` | la liste affichée, le récit daté, le compteur de migrations |

---

### Task 1: Les deux lectures préalables (faites à l'écriture du plan, revérifiées avant la tâche 2)

**Files:**
- Lecture seule : `db/migrations/0027_conversation_analysis.sql:18`, la base de production (`pg_constraint`), le dépôt `C:/Users/julie/mm-hubspot` (AUCUNE écriture, AUCUNE commande git qui écrit).
- Aucun fichier modifié, aucun commit.

**Interfaces:**
- Consumes : rien.
- Produces : deux verdicts, inscrits ici, dont dépendent la tâche 2 (une migration est nécessaire, sous ce nom de contrainte) et le Déploiement (aucun déploiement du connecteur HubSpot avant).

**Résultats constatés le 2026-09-24, en lecture seule :**

**(a) OUI, 0027 contraint l'intention.** Ligne 18 de `db/migrations/0027_conversation_analysis.sql` :
`intent text not null check (intent in ('demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre')),`.
Aucune migration postérieure ne la touche (`grep -n "check (intent" db/migrations/*.sql` ne rend que 0027 ; 0155 parle des intentions en commentaire, et sa table `analyse_jour` les range dans un `jsonb` SANS contrainte). Lu EN BASE (`pg_constraint`, lecture seule) : un seul CHECK sur l'intention, nommé automatiquement `conversation_analysis_intent_check`, défini `CHECK ((intent = ANY (ARRAY['demande_devis'::text, 'sav'::text, 'reclamation'::text, 'information'::text, 'prise_rdv'::text, 'autre'::text])))`. Répartition des analyses existantes : `information` 11, `autre` 4, `prise_rdv` 1. `schema_migrations` était alors en tête à `0171_pubs_brouillons.sql`.
Conséquence : la tâche 2 écrit une migration qui RELÂCHE ce CHECK, appliquée AVANT le `up`. Sans elle, l'INSERT d'une analyse classée `achat` échoue en 23514 dans `PgConversationAnalysisStore.save` (`src/analysis/store.pg.ts:98-150`), l'erreur remonte de `analyzeConversationJob` (`src/analysis/job.ts:53`), pg-boss rejoue le job ENTIER, appel au modèle compris, jusqu'à la DLQ.

**(b) NON, le connecteur HubSpot ne valide pas l'intention strictement.** Dépôt `mm-hubspot`, HEAD `8ee305b` :
- `src/ingest/event.ts:23` : `analysis: z.record(z.string(), z.unknown()),` (l'enveloppe est validée, le contenu est opaque, et le commentaire des lignes 8 à 13 l'assume) ;
- `src/crm/mapping.ts:33` : `set('mm_last_intent', str(a['intent']));` (recopie la chaîne, ni `switch`, ni table de correspondance) ;
- `src/hubspot/properties.ts:46` : `mm_last_intent` est `type: 'string', fieldType: 'text'`, PAS une énumération HubSpot, donc aucune option à provisionner ;
- `src/card/view.ts:42` et `hubspot-app/src/app/cards/AnalyseCard.jsx:143` affichent la valeur brute ;
- ses migrations (`db/migrations/0001` à `0008`) ne nomment pas l'intention ; ses tests poussent déjà des valeurs hors liste (`'devis'`, `'info'`) et passent.
Conséquence : AUCUNE tâche dans `mm-hubspot`, rien à y déployer avant ce lot.

- [ ] **Step 1: Revérifier qu'aucun CHECK d'intention n'est apparu depuis**

Run: `cd /c/Users/julie/messagingme-mba && grep -n "check (intent" db/migrations/*.sql`
Expected: UNE seule ligne, `db/migrations/0027_conversation_analysis.sql:18:  intent ...`. Deux lignes ou plus : une autre session a déjà touché la contrainte, STOP, prévenir Julien avant la tâche 2.

- [ ] **Step 2: Relire le nom et la définition de la contrainte EN BASE (lecture seule)**

Run:
```bash
cd /c/Users/julie/messagingme-mba && npx tsx -e "import 'dotenv/config'; import { Pool } from 'pg'; import { pgSsl } from './src/db/ssl'; const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgSsl(), max: 1 }); p.query(\"select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.conversation_analysis'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%intent%'\").then((r) => { console.log(JSON.stringify(r.rows, null, 1)); return p.query('select intent, count(*)::int as n from public.conversation_analysis group by 1 order by 1'); }).then((r) => { console.log(JSON.stringify(r.rows)); return p.end(); });"
```
Expected: une seule ligne `conversation_analysis_intent_check` avec les six valeurs, puis la répartition du jour. Garde les chiffres de la répartition : la tâche 2 les écrit dans le commentaire de la migration. Un autre nom, ou deux CHECK : STOP, le `drop constraint if exists` de la tâche 2 viserait à côté.

- [ ] **Step 3: Revérifier le connecteur HubSpot (lecture seule)**

Run:
```bash
cd /c/Users/julie/mm-hubspot && git log --oneline -1 && grep -n "analysis:" src/ingest/event.ts && grep -rn --exclude-dir=node_modules "intent" src hubspot-app/src --include=*.ts --include=*.jsx
```
Expected: `analysis: z.record(z.string(), z.unknown()),`, puis exactement les lignes citées en (b) (mapping, propriété texte, carte, vue, note). Si `analysis` est devenu un objet strict, ou si une énumération d'intentions apparaît (`z.enum`, `switch` sur l'intention, propriété `mm_last_intent` en `enumeration`) : STOP. Le spec (§ 7 et § 16) exige alors une tâche dans `mm-hubspot`, déployée AVANT, que ce plan ne contient pas ; le signaler à Julien.

---

### Task 2: La liste et sa contrainte en base

**Files:**
- Modify: `src/analysis/schema.ts:4` (la ligne `INTENTS`)
- Create: `db/migrations/<N>_intentions_commerce.sql` (`<N>` = numéro rendu par `ls db/migrations | tail -1`, plus un, sur quatre chiffres)
- Modify: `src/analysis/store.pg.ts:200` (commentaire)
- Modify: `CLAUDE.md` (section Déploiement, phrase « Prochaine libre »)
- Create: `tests/intentions-parite.test.ts`
- Modify: `tests/analysis-engine.test.ts` (juste après le cas `it('enum hors liste -> null', ...)`)
- Create: `tests/integration/intentions.integration.test.ts`

**Interfaces:**
- Consumes : `parseLlmOutput(raw: string): LlmOutput | null` (`src/analysis/engine.ts:88`) ; `PgConversationAnalysisStore.save(conversationId: string, tenantId: string, a: ConversationAnalysis, model: { provider: string; model: string }, windowEnd: string | null): Promise<void>` (`src/analysis/store.pg.ts:98`).
- Produces :
  - `export const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre'] as const;`
  - `export type Intent = (typeof INTENTS)[number];` (dans `src/analysis/schema.ts`)
  - la contrainte `conversation_analysis_intent_check` aux neuf valeurs ;
  - `tests/intentions-parite.test.ts`, avec ses aides `lire(chemin)` et `dernierCheckIntention()`, que les tâches 3, 4 et 5 complètent.

- [ ] **Step 1: Écrire le test qui échoue (le schéma accepte les trois valeurs)**

Dans `tests/analysis-engine.test.ts`, juste après le cas `it('enum hors liste -> null', ...)`, dans le bloc `describe` qui teste `parseLlmOutput`, ajouter :

```ts
  it('🔴 les intentions de commerce en ligne sont ACCEPTÉES (spec du 2026-09-24, § 7)', () => {
    // Refusées par le schéma, elles feraient perdre l'analyse ENTIÈRE : `safeParse` échoue sur l'objet, le
    // job rappelle le modèle une fois puis marque la conversation en échec, et « veut acheter » n'arrive
    // jamais sur aucun écran.
    for (const intent of ['achat', 'suivi_commande', 'retour']) {
      expect(parseLlmOutput(JSON.stringify({ ...valid, intent }))?.intent, intent).toBe(intent);
    }
  });
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/analysis-engine.test.ts`
Expected: FAIL sur ce cas, `achat: expected undefined to be 'achat'`.

- [ ] **Step 3: Étendre `INTENTS`**

Dans `src/analysis/schema.ts`, remplacer la ligne 4 :

```ts
export const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre'] as const;
```

par :

```ts
/**
 * Les intentions d'une conversation. CETTE LISTE FAIT FOI : le prompt (`src/analysis/engine.ts`), le CHECK en
 * base (dernière migration qui pose `conversation_analysis_intent_check`), les statistiques et la copie de la
 * console (`web/lib/intentions.ts`) la suivent, et `tests/intentions-parite.test.ts` exige qu'ils nomment
 * exactement les mêmes valeurs.
 *
 * `achat`, `suivi_commande` et `retour` (spec du 2026-09-24, § 7) : les six premières étaient celles des
 * services et de l'assurance, aucune ne disait « veut acheter ». Insérées AVANT `autre`, qui reste le dernier
 * recours du modèle et la dernière barre des écrans.
 *
 * 🔴 AJOUTER UNE VALEUR DEMANDE UNE MIGRATION qui relâche le CHECK, appliquée AVANT le déploiement : sans
 * elle, l'INSERT de l'analyse échoue en 23514 et le job la rejoue, appel au modèle compris, jusqu'à la DLQ.
 */
export const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre'] as const;
export type Intent = (typeof INTENTS)[number];
```

- [ ] **Step 4: Le voir passer**

Run: `npx vitest run tests/analysis-engine.test.ts`
Expected: PASS, tous les cas.

- [ ] **Step 5: Écrire le test de parité base / schéma, qui échoue**

Créer `tests/intentions-parite.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INTENTS } from '../src/analysis/schema';

/**
 * LES INTENTIONS : UNE LISTE QUI FAIT FOI, ET TOUT CE QUI LA NOMME.
 *
 * 🔴 CE QUE CE FICHIER TIENT, ET QU'AUCUN COMPILATEUR NE VOIT. `INTENTS` (`src/analysis/schema.ts`) est
 * nommée ailleurs sous des formes qu'aucun type ne relie : le CHECK en base, le texte du prompt, le SQL des
 * statistiques, la copie de la console (qui n'importe jamais `src/`). Chacune est plausible seule, c'est
 * leur ÉGALITÉ qui porte l'invariant. Une valeur que le schéma accepte et que le CHECK refuse fait échouer
 * l'INSERT de l'analyse, et le job la rejoue, appel au modèle compris, jusqu'à la DLQ.
 *
 * ⚠️ TOUT EST DÉRIVÉ DE `INTENTS`, rien n'est recopié ici : une liste écrite dans ce test ne ferait que
 * déplacer la dérive d'un fichier à l'autre.
 *
 * ⚠️ IL VIT À LA RACINE, et pas dans `web/` : seul `ci.yml` tourne sur un changement de `src/`
 * (`tests/ci-decoupage.test.ts`), et c'est justement quand `INTENTS` change qu'il a quelque chose à dire.
 */

const RACINE = resolve(__dirname, '..');
/** Fins de ligne normalisées : les fichiers sont en CRLF sur le poste de travail. */
const lire = (chemin: string): string => readFileSync(resolve(RACINE, chemin), 'utf8').split('\r\n').join('\n');
/** Le SQL sans ses commentaires de ligne : une migration peut PARLER d'un CHECK sans le poser. */
const sansCommentaires = (sql: string): string => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/**
 * Les valeurs du DERNIER CHECK d'intention écrit dans `db/migrations`, fichiers pris dans l'ordre de leur
 * nom, qui est l'ordre d'application du runner : c'est celui que la base porte une fois tout appliqué.
 */
function dernierCheckIntention(): { fichier: string; valeurs: string[] } | null {
  const fichiers = readdirSync(resolve(RACINE, 'db', 'migrations')).filter((n) => n.endsWith('.sql')).sort();
  let dernier: { fichier: string; valeurs: string[] } | null = null;
  for (const fichier of fichiers) {
    const sql = sansCommentaires(lire(`db/migrations/${fichier}`));
    for (const m of sql.matchAll(/check\s*\(\s*intent\s+in\s*\(([^)]*)\)\s*\)/gi)) {
      dernier = { fichier, valeurs: [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((v) => v[1]!) };
    }
  }
  return dernier;
}

describe('les intentions : la base accepte exactement ce que le schéma accepte', () => {
  it('🔴 le DERNIER CHECK écrit porte les valeurs de INTENTS, ni plus ni moins', () => {
    const check = dernierCheckIntention();
    // Sans cette ligne, un CHECK reformaté rendrait `null` et le test passerait en ne comparant rien.
    expect(check, 'aucun CHECK d’intention lu dans db/migrations : ce test ne garde plus rien').not.toBeNull();
    expect([...check!.valeurs].sort(), `CHECK lu dans ${check!.fichier}`).toEqual([...INTENTS].sort());
  });
});
```

- [ ] **Step 6: Le voir échouer**

Run: `npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL, `CHECK lu dans 0027_conversation_analysis.sql`, le tableau lu a six valeurs, l'attendu en a neuf (`achat`, `retour`, `suivi_commande` manquent).

- [ ] **Step 7: Prendre le numéro et écrire la migration**

Run: `cd /c/Users/julie/messagingme-mba && ls db/migrations | tail -1`
Le numéro rendu, plus un, sur quatre chiffres, est `<N>`. Créer `db/migrations/<N>_intentions_commerce.sql` (commentaires sans accents, comme les migrations récentes ; les chiffres de la mesure sont ceux relus à l'étape 2 de la tâche 1, remplace ceux-ci s'ils ont bougé) :

```sql
-- <N>_intentions_commerce.sql : trois intentions de plus pour l'analyse des conversations.
--
-- POURQUOI. Les six intentions de 0027 sont celles des services et de l'assurance : aucune ne dit « le
-- client veut acheter », ni « ou en est ma commande », ni « je veux renvoyer ce produit ». Chez un client de
-- commerce en ligne, ces conversations tombaient en `information`, `sav` ou `autre`, et le signal le plus
-- commercial de tous se perdait. Spec du 2026-09-24 (API publique coherente), paragraphe 7 : `achat`,
-- `suivi_commande`, `retour`.
--
-- 🔴 ELLE RELACHE, DONC L'ANCIEN CODE Y SURVIT, et elle passe AVANT le deploiement. La question n'est pas
-- « ajoute ou retire » mais « l'ancien code survit-il a ce changement ? » (regle corrigee au lot 0128) : le
-- code deploye continue d'ecrire les six valeurs d'hier, que le CHECK elargi accepte toujours. L'inverse
-- serait BLOQUANT et PAYANT : deployer d'abord ferait echouer en 23514 l'INSERT de toute analyse classee dans
-- une valeur neuve, et le job `analyze-conversation` la rejouerait, appel au modele compris, jusqu'a la DLQ.
--
-- 🔴 LE NOM DE LA CONTRAINTE A ETE LU EN BASE, pas devine (lecon de 0122, deja appliquee en 0166) :
-- `pg_constraint` sur `conversation_analysis` ne porte qu'UN CHECK sur l'intention,
-- `conversation_analysis_intent_check`, cree EN LIGNE par 0027 avec ses six valeurs. Un nom a cote
-- laisserait l'ancienne contrainte en place ET ajouterait la neuve, donc refuserait `achat` en silence : un
-- `if exists` ne protege que de l'absence, jamais de l'erreur de nom.
--
-- ⚠️ MESURE AVANT D'ECRIRE (2026-09-24, production) : 16 analyses, en information (11), autre (4),
-- prise_rdv (1). Le CHECK elargi contient l'ancien, donc aucune ligne ne peut faire echouer son ajout, et la
-- validation qu'il declenche parcourt une table minuscule.
--
-- ⚠️ AUCUNE LIGNE N'EST TOUCHEE : les analyses passees gardent leur intention d'origine (meme paragraphe
-- de la spec). La liste fait foi dans `INTENTS` (`src/analysis/schema.ts`), et
-- `tests/intentions-parite.test.ts` exige que le DERNIER CHECK ecrit dans ce dossier porte exactement ses
-- valeurs.

alter table conversation_analysis drop constraint if exists conversation_analysis_intent_check;
alter table conversation_analysis add constraint conversation_analysis_intent_check
  check (intent in ('demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre'));
```

- [ ] **Step 8: Le voir passer**

Run: `npx vitest run tests/intentions-parite.test.ts tests/migration-directives.test.ts`
Expected: PASS (le second garde la forme des migrations, la nôtre reste transactionnelle).

- [ ] **Step 9: Vérifier le test de parité dans les deux sens**

Retirer `'retour', ` du CHECK de `db/migrations/<N>_intentions_commerce.sql`, puis
Run: `npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL, `CHECK lu dans <N>_intentions_commerce.sql`, `retour` manquant.
Remettre `'retour', ` à sa place, puis
Run: `grep -c "'retour'" db/migrations/<N>_intentions_commerce.sql && npx vitest run tests/intentions-parite.test.ts`
Expected: `1`, puis PASS.

- [ ] **Step 10: Corriger le commentaire qui cite 0027 comme seule garde**

Dans `src/analysis/store.pg.ts`, remplacer la ligne 200 :

```ts
    // Les CHECK SQL (0027) garantissent des valeurs d'enum valides -> cast direct vers les unions du schéma.
```

par :

```ts
    // Les CHECK SQL (0027, et <N> pour l'intention) garantissent des valeurs d'enum valides -> cast direct
    // vers les unions du schéma. `tests/intentions-parite.test.ts` tient l'égalité du CHECK et de `INTENTS`.
```

(`<N>` : le numéro réel pris à l'étape 7.)

- [ ] **Step 11: Écrire le test d'intégration (JAMAIS lancé en local)**

Créer `tests/integration/intentions.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationAnalysisStore } from '../../src/analysis/store.pg';
import type { ConversationAnalysis } from '../../src/analysis/schema';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES INTENTIONS DE COMMERCE EN LIGNE, CONTRE UN VRAI POSTGRES (lot 5 de l'API publique).
 *
 * 🔴 POURQUOI EN INTÉGRATION : `tests/intentions-parite.test.ts` relit le TEXTE des migrations, il ne peut
 * pas dire que la base, une fois tout appliqué, accepte vraiment `achat`. Ici l'écriture passe par le VRAI
 * chemin (`PgConversationAnalysisStore.save`), celui du job d'analyse.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('les intentions de commerce en ligne, en base', () => {
  let pool: Pool;
  let tenantId: string;
  let numero = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-intentions-commerce') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    // Les conversations et leurs analyses partent en cascade avec l'espace.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const conversation = async (): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, analysis_status) values ($1, $2, now(), 'queued') returning id`,
      [tenantId, `3361700${String(++numero).padStart(4, '0')}`],
    )).rows[0]!.id;

  const base: ConversationAnalysis = {
    sentiment: 'neutre', intent: 'achat', topic: 'commande pack pro', resolved: false, entities: {},
    action_suggestion: 'rappeler', confidence: 0.8, justification: 'veut commander', handled_by: 'humain',
    exchanges_count: 2, abusive: false,
  };

  it('🔴 le CHECK accepte les trois intentions neuves, par le VRAI chemin d’écriture', async () => {
    const store = new PgConversationAnalysisStore(pool);
    for (const intent of ['achat', 'suivi_commande', 'retour'] as const) {
      const c = await conversation();
      await store.save(c, tenantId, { ...base, intent }, { provider: 'itest', model: 'itest' }, new Date().toISOString());
      const lu = await pool.query<{ intent: string }>('select intent from conversation_analysis where conversation_id = $1', [c]);
      expect(lu.rows[0]?.intent, intent).toBe(intent);
    }
  });

  it('⚠️ le CHECK reste un CHECK : une valeur hors liste est toujours refusée', async () => {
    // Élargir ne doit pas vouloir dire retirer : sans contrainte, une sortie de modèle mal validée
    // écrirait n'importe quoi, et les compteurs par intention cesseraient de retomber sur le total.
    const c = await conversation();
    await expect(pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model)
       values ($1, $2, 'neutre', 'nawak', 's', true, 'humain', 1, 'aucune', 0.5, 'j', 'itest', 'itest')`,
      [c, tenantId],
    )).rejects.toMatchObject({ code: '23514' });
  });
});
```

⚠️ **Ces deux cas ne se vérifient PAS dans les deux sens, et c'est assumé ici par écrit.** Les remettre en défaut exigerait de les jouer contre une base, or la seule joignable depuis le poste est la PRODUCTION, et pousser une migration volontairement fausse rendrait `main` rouge pour toutes les sessions. Ce qui tient la même propriété dans les deux sens, côté TEXTE, est `tests/intentions-parite.test.ts`, vérifié à l'étape 9 (un CHECK amputé de `retour` le fait échouer, sa remise le fait passer). Le job `integration` ajoute la preuve que Postgres, une fois toutes les migrations appliquées, accepte vraiment les trois valeurs par le vrai chemin d'écriture.

- [ ] **Step 12: Typecheck et suite unitaire**

Run: `npm run typecheck && npm test`
Expected: aucune erreur de type, suite verte. (Aucun `switch` exhaustif sur l'intention n'existe dans `src/`, vérifié par `grep -rn "intent" src` : l'union qui grandit ne casse rien.)

- [ ] **Step 13: Écrire la ligne du compteur DANS le commit qui prend le numéro**

Run: `cd /c/Users/julie/messagingme-mba && grep -n "Prochaine libre" CLAUDE.md && git diff --stat CLAUDE.md`
Dans le paragraphe « Dernière appliquée » de la section Déploiement, AJOUTER (sans retirer les phrases « ÉCRITE ET PAS ENCORE APPLIQUÉE » d'autres lots qui y seraient encore) :

```markdown
**ÉCRITE ET PAS ENCORE APPLIQUÉE : <N>** (`intentions_commerce`, lot 5 de l'API publique : le CHECK de
`conversation_analysis.intent` élargi à `achat`, `suivi_commande` et `retour` ; il RELÂCHE, donc AVANT le `up`).
```

et remplacer la phrase « **Prochaine libre = ...** » existante par :

```markdown
**Prochaine libre = <N+1>**, et le dossier `db/migrations/` s'arrête à <N>.
```

- [ ] **Step 14: Commit**

Run:
```bash
cd /c/Users/julie/messagingme-mba && ls db/migrations | tail -3 && git diff CLAUDE.md src/analysis/schema.ts src/analysis/store.pg.ts tests/analysis-engine.test.ts
```
Expected : `<N>_intentions_commerce.sql` est le seul fichier à porter `<N>` (sinon une autre session l'a pris entre-temps : renuméroter, y compris dans le commentaire de `store.pg.ts` et `CLAUDE.md`) ; le diff de `CLAUDE.md` ne montre QUE tes deux phrases. S'il montre aussi le travail d'une autre session (le fichier était déjà modifié par une autre session à l'écriture de ce plan), NE PAS commiter : l'annoncer à cette session (`ListAgents`, puis `SendMessage`) et attendre qu'elle ait commité le sien, parce que `--only` emporte le fichier ENTIER.
Puis :
```bash
cd /c/Users/julie/messagingme-mba && git commit --only src/analysis/schema.ts db/migrations/<N>_intentions_commerce.sql src/analysis/store.pg.ts CLAUDE.md tests/intentions-parite.test.ts tests/analysis-engine.test.ts tests/integration/intentions.integration.test.ts -m "$(cat <<'EOF'
feat(analyse): trois intentions de commerce en ligne, et le CHECK qui les accepte

achat, suivi_commande et retour rejoignent INTENTS. La migration <N> relache
conversation_analysis_intent_check (nom lu en base) : elle passe AVANT le up.
Un test de parite exige que le dernier CHECK ecrit porte exactement INTENTS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
Puis annoncer aux sessions qui partagent l'arbre que ce commit porte une migration à appliquer AVANT tout `up` de l'API : `git pull` sur le VPS emporte tout `main`, donc n'importe quel déploiement de l'API après le push de ce commit doit suivre la séquence build, `migrate`, `up`.

---

### Task 3: Le prompt propose et décrit chaque intention

**Files:**
- Modify: `src/analysis/engine.ts:1` (import) et `:49-54` (déclaration avant `SYSTEM_INSTRUCTIONS`, ligne `- intent :`)
- Modify: `tests/intentions-parite.test.ts` (un import en tête, un bloc `describe` en fin)

**Interfaces:**
- Consumes : `INTENTS`, `type Intent` (tâche 2) ; `buildPrompt(transcript: string): { system: string; user: string }` (`src/analysis/engine.ts:80`).
- Produces : `export const DESCRIPTIONS_INTENTION: Record<Intent, string>` dans `src/analysis/engine.ts` ; un prompt dont la ligne `- intent :` énumère `INTENTS` dans leur ordre, suivie d'une ligne `  - <intention> : <description>.` par valeur.

- [ ] **Step 1: Écrire le test qui échoue**

En tête de `tests/intentions-parite.test.ts`, sous les imports existants, ajouter :

```ts
import { buildPrompt } from '../src/analysis/engine';
```

En fin de fichier, ajouter :

```ts
describe('les intentions : le modèle se voit proposer exactement INTENTS', () => {
  const lignes = buildPrompt('Client: bonjour').system.split('\n');

  it('🔴 la ligne « - intent : » énumère INTENTS, dans leur ordre', () => {
    const ligne = lignes.find((l) => l.startsWith('- intent :'));
    expect(ligne, 'la ligne « - intent : » a disparu du prompt : ce test ne garde plus rien').toBeDefined();
    expect([...ligne!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...INTENTS]);
  });

  it('🔴 chaque intention est DÉCRITE sur sa propre ligne', () => {
    // Une liste de noms seule laisse le modèle deviner la frontière entre `achat` et `demande_devis`, ou
    // entre `suivi_commande` et `reclamation`, et il la placerait différemment d'une conversation à l'autre.
    for (const i of INTENTS) {
      const prefixe = `  - ${i} : `;
      const ligne = lignes.find((l) => l.startsWith(prefixe));
      expect(ligne, `l’intention ${i} n’est pas décrite au modèle`).toBeDefined();
      expect(ligne!.length - prefixe.length, `la description de ${i} est vide`).toBeGreaterThan(20);
    }
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL sur les deux cas neufs : la ligne rend six valeurs au lieu de neuf, et `l’intention demande_devis n’est pas décrite au modèle`.

- [ ] **Step 3: Dériver la ligne et poser les descriptions**

Dans `src/analysis/engine.ts`, remplacer la ligne 1 :

```ts
import { llmOutputSchema, NOTE_MIN, NOTE_MAX, type LlmOutput, type HandledBy } from './schema';
```

par :

```ts
import { llmOutputSchema, INTENTS, NOTE_MIN, NOTE_MAX, type Intent, type LlmOutput, type HandledBy } from './schema';
```

Juste AVANT `const SYSTEM_INSTRUCTIONS = [` (ligne 49 ; la constante doit exister avant, sinon la construction du tableau tombe dans la zone morte de `const`), ajouter :

```ts
/**
 * CE QUE VEUT DIRE CHAQUE INTENTION, TEL QU'ON LE DIT AU MODÈLE.
 *
 * 🔴 UN `Record<Intent, string>`, ET C'EST LA GARDE : une valeur ajoutée à `INTENTS` sans sa description ne
 * compile pas. Une intention que le schéma accepte mais que le prompt ne propose pas ne serait jamais rendue,
 * et l'écran montrerait une barre toujours vide sans que rien ne dise pourquoi.
 *
 * ⚠️ ÉCRITES POUR SÉPARER LES VOISINES (spec du 2026-09-24, § 7) : `achat` contre `demande_devis`,
 * `suivi_commande` contre `reclamation`, `retour` contre `sav`. Sans ces frontières, le modèle placerait la
 * limite différemment d'une conversation à l'autre, et la répartition ne voudrait plus rien dire.
 */
export const DESCRIPTIONS_INTENTION: Record<Intent, string> = {
  demande_devis: "le client demande un prix ou un devis chiffré AVANT de s'engager (quantité, prestation sur mesure)",
  sav: "le client a besoin d'aide sur un produit ou un service qu'il a déjà et qu'il GARDE (panne, réglage, mode d'emploi, garantie)",
  reclamation: "le client se plaint d'un préjudice (retard, erreur, produit abîmé, facturation) et attend une réparation ou un geste",
  information: 'question générale, sans démarche en cours (horaires, conditions, disponibilité, tarifs affichés)',
  prise_rdv: 'le client veut fixer, déplacer ou annuler un rendez-vous',
  achat: 'le client veut acheter MAINTENANT un produit ou une offre identifiée (commander, payer, réserver un article), sans demander de devis',
  suivi_commande: "le client demande où en est une commande DÉJÀ passée (expédition, livraison, délai, numéro de suivi), sans s'en plaindre",
  retour: 'le client veut retourner, échanger ou se faire rembourser un produit reçu',
  autre: 'aucune des intentions ci-dessus',
};

```

Puis remplacer la ligne 54 :

```ts
  '- intent : "demande_devis" | "sav" | "reclamation" | "information" | "prise_rdv" | "autre".',
```

par :

```ts
  // La liste ET ses descriptions sont DÉRIVÉES de `INTENTS` : écrites à la main ici, elles feraient une copie
  // de plus, et c'est celle qu'on oublie qui fait qu'une intention n'est jamais proposée au modèle.
  `- intent : ${INTENTS.map((i) => `"${i}"`).join(' | ')}.`,
  ...INTENTS.map((i) => `  - ${i} : ${DESCRIPTIONS_INTENTION[i]}.`),
  '  Entre deux voisines : une commande en retard dont le client se PLAINT est reclamation, la même question',
  "  posée sans reproche est suivi_commande ; un produit qu'il veut RENVOYER ou échanger est retour, un produit",
  "  qu'il garde mais qui ne marche pas est sav ; une commande à passer est achat, un prix demandé avant de",
  '  décider est demande_devis.',
```

- [ ] **Step 4: Le voir passer**

Run: `npx vitest run tests/intentions-parite.test.ts tests/analysis-engine.test.ts`
Expected: PASS (le cas existant « le PROMPT demande les deux notes avec leurs bornes » reste vert : ses lignes n'ont pas bougé).

- [ ] **Step 5: Vérifier le test dans les deux sens**

Remettre temporairement la ligne 54 d'origine (la ligne écrite à la main, six valeurs) à la place de la ligne dérivée, puis
Run: `npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL, `expected [ 'demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre' ] to deeply equal [ ... 'achat', 'suivi_commande', 'retour', 'autre' ]`.
Restaurer la ligne dérivée, puis
Run: `git diff --stat src/analysis/engine.ts && npx vitest run tests/intentions-parite.test.ts`
Expected: le diff ne montre que les changements de cette tâche, puis PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: aucune erreur.

- [ ] **Step 7: Commit**

Run:
```bash
cd /c/Users/julie/messagingme-mba && git diff src/analysis/engine.ts tests/intentions-parite.test.ts && git commit --only src/analysis/engine.ts tests/intentions-parite.test.ts -m "$(cat <<'EOF'
feat(analyse): le prompt propose et decrit chaque intention, derivee de INTENTS

Chaque intention porte une description qui la separe de ses voisines
(achat / demande_devis, suivi_commande / reclamation, retour / sav). Un
Record<Intent, string> refuse de compiler une valeur sans description.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Les statistiques du serveur comptent et filtrent chaque intention

**Files:**
- Modify: `src/stats/conversation-stats.pg.ts:1-4` (import), `:36-38` (commentaire), `:48-56` (`AGREGAT_JOUR_SQL`), `:77` (type), `:236` (type de ligne), `:258-259` (SQL de `getSummary`), `:299-300` (commentaire), `:352-355` (mise en forme)
- Modify: `src/http/stats.ts:16-21`
- Modify: `tests/agregats-jour.test.ts:1-4` (import) et `:76-83` (cas des intentions)
- Modify: `tests/http-stats-settings.test.ts:1-10` (import), `:58` (fixture), après `:160` (cas neuf)
- Modify: `tests/intentions-parite.test.ts` (bloc en fin)
- Modify: `tests/integration/intentions.integration.test.ts` (import et cas neuf)

**Interfaces:**
- Consumes : `INTENTS`, `type Intent` (tâche 2) ; `AGREGAT_JOUR_SQL` (`src/stats/conversation-stats.pg.ts:43`), `PgConversationStatsStore.getSummary(tenantId: string, range: DateRange): Promise<ConversationAnalysisSummary>`, `.listAnalyzed(tenantId: string, range: DateRange, filters: AnalyzedConversationsFilter)`, `.ecrireAgregats(range: DateRange, tenantId: string | null = null): Promise<number>`.
- Produces : `ConversationAnalysisSummary['intent']` devient `Record<Intent, number>` (la réponse de `GET /tenants/:tenantId/stats/conversations` porte donc neuf clés) ; `AGREGAT_JOUR_SQL` compte les neuf ; `?intent=` de `/stats/conversations/list` accepte les neuf.

- [ ] **Step 1: Réécrire le cas de l'agrégat pour qu'il DÉRIVE de `INTENTS` (il échoue)**

Dans `tests/agregats-jour.test.ts`, sous la ligne 4 (`import { AGREGAT_JOUR_SQL } ...`), ajouter :

```ts
import { INTENTS } from '../src/analysis/schema';
```

Remplacer le cas des lignes 76 à 83 :

```ts
  it('🔴 les SIX intentions sont comptees, et le compte n’est pas ecrit a la main ailleurs', () => {
    // L'enumeration est FERMEE (`src/analysis/schema.ts`). Si une septieme apparait un jour, ce test le
    // signale ici plutot que de la laisser disparaitre silencieusement de l'agregat, ou une journee
    // agregee compterait moins de conversations que la meme journee lue en direct.
    for (const intent of ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']) {
      expect(AGREGAT_JOUR_SQL, `l’intention ${intent} n’est pas comptee`).toContain(`'${intent}', count(*)`);
    }
  });
```

par (le cas d'origine est CONSERVÉ : les six valeurs d'hier font partie de `INTENTS`, et l'assertion est plus stricte) :

```ts
  it('🔴 CHAQUE intention du schema est comptee, et aucune de plus', () => {
    // La liste est DERIVEE de `INTENTS` (`src/analysis/schema.ts`), plus recopiee. La version d'avant
    // enumerait six valeurs a la main : une intention ajoutee au schema passait la validation de l'analyse,
    // puis disparaissait en silence de la repartition agregee, qui ne retombait plus sur le total du jour.
    for (const intent of INTENTS) {
      expect(AGREGAT_JOUR_SQL, `l’intention ${intent} n’est pas comptee`)
        .toContain(`'${intent}', count(*) filter (where ca.intent = '${intent}')`);
    }
    const comptees = AGREGAT_JOUR_SQL.split('count(*) filter (where ca.intent = ').length - 1;
    expect(comptees, 'une intention comptee que le schema ne connait pas').toBe(INTENTS.length);
  });
```

- [ ] **Step 2: Écrire le cas de la route (il échoue)**

Dans `tests/http-stats-settings.test.ts`, sous la ligne 10 (`import type { SettingsRouteDeps } ...`), ajouter :

```ts
import { INTENTS } from '../src/analysis/schema';
```

Après le cas `it('GET /stats/conversations/list -> quali + filtres enum valides seulement, inboxHref', ...)` (qui se termine ligne 160), ajouter :

```ts
  it('🔴 le filtre accepte CHAQUE intention du schéma, les neuves comprises', async () => {
    // La liste admise était une copie en dur des six premières : `?intent=achat` y aurait été ignoré, et la
    // route aurait rendu TOUTES les conversations sous un filtre « Achat » affiché à l'écran. Elle DÉRIVE
    // désormais de INTENTS.
    const captured: AnalyzedConversationsFilter[] = [];
    const a = app({ stats: { listAnalyzedConversations: async (_t, _r, f) => { captured.push(f); return []; } } });
    for (const i of INTENTS) {
      await a.inject({ method: 'GET', url: `/tenants/t1/stats/conversations/list?days=30&intent=${i}`, ...h(adminTok) });
    }
    expect(captured.map((f) => f.intent)).toEqual([...INTENTS]);
    await a.close();
  });
```

- [ ] **Step 3: Écrire le cas de parité de la synthèse (il échoue)**

En fin de `tests/intentions-parite.test.ts`, ajouter :

```ts
describe('les intentions : la synthèse du serveur compte chacune', () => {
  const source = lire('src/stats/conversation-stats.pg.ts');

  it('🔴 getSummary compte chaque intention, et aucune de plus', () => {
    // L'agrégat journalier a son propre cas (`tests/agregats-jour.test.ts`). Ici, la requête de la synthèse,
    // dont les colonnes sont écrites une par une : une valeur oubliée rendrait sa barre vide à l'écran.
    for (const i of INTENTS) {
      expect(source, `getSummary ne compte pas ${i}`).toContain(`count(*) filter (where intent = '${i}')::int as`);
    }
    expect(source.split("count(*) filter (where intent = '").length - 1, 'une intention comptée que le schéma ne connaît pas')
      .toBe(INTENTS.length);
  });
});
```

- [ ] **Step 4: Les voir échouer**

Run: `npx vitest run tests/agregats-jour.test.ts tests/http-stats-settings.test.ts tests/intentions-parite.test.ts`
Expected: FAIL sur les trois cas neufs : `l’intention achat n’est pas comptee` ; `captured` rend `undefined` à la place de `achat`, `suivi_commande` et `retour` ; `getSummary ne compte pas achat`.

- [ ] **Step 5: Compter les intentions neuves dans `conversation-stats.pg.ts`**

Sous la ligne 4 (`import { retentionEffective } from '../inbox/retention';`), ajouter :

```ts
import type { Intent } from '../analysis/schema';
```

Remplacer les lignes 36 à 38 :

```ts
 * ⚠️ LES SIX INTENTIONS SONT COMPTEES UNE PAR UNE, et pas par un `jsonb_object_agg` : celui-ci echouerait
 * sur des cles dupliquees, et l enumeration est FERMEE de toute facon (`src/analysis/schema.ts`). Une
 * septieme valeur ferait echouer la validation de l analyse bien avant d arriver ici.
```

par :

```ts
 * ⚠️ LES INTENTIONS SONT COMPTEES UNE PAR UNE, et pas par un `jsonb_object_agg` : celui-ci echouerait sur
 * des cles dupliquees. L enumeration est FERMEE (`INTENTS`, `src/analysis/schema.ts`), mais une valeur
 * ajoutee la-bas PASSE la validation de l analyse : oubliee ici, elle disparaitrait en silence de la
 * repartition agregee, qui ne retomberait plus sur le total du jour. `tests/agregats-jour.test.ts` derive
 * la liste de `INTENTS` et les exige toutes.
```

Dans `AGREGAT_JOUR_SQL`, remplacer :

```sql
           'prise_rdv', count(*) filter (where ca.intent = 'prise_rdv'),
           'autre', count(*) filter (where ca.intent = 'autre')
```

par (aucun commentaire SQL dans ce gabarit : un accent grave y fermerait la chaîne) :

```sql
           'prise_rdv', count(*) filter (where ca.intent = 'prise_rdv'),
           'achat', count(*) filter (where ca.intent = 'achat'),
           'suivi_commande', count(*) filter (where ca.intent = 'suivi_commande'),
           'retour', count(*) filter (where ca.intent = 'retour'),
           'autre', count(*) filter (where ca.intent = 'autre')
```

Remplacer la ligne 77 :

```ts
  intent: { demande_devis: number; sav: number; reclamation: number; information: number; prise_rdv: number; autre: number };
```

par :

```ts
  /** Une clé par valeur de `INTENTS` : un `Record` et pas un objet écrit à la main, pour qu'une intention
   *  ajoutée au schéma sans son compte ne compile pas. */
  intent: Record<Intent, number>;
```

Remplacer la ligne 236 :

```ts
      i_devis: string; i_sav: string; i_recl: string; i_info: string; i_rdv: string; i_autre: string;
```

par :

```ts
      i_devis: string; i_sav: string; i_recl: string; i_info: string; i_rdv: string;
      i_achat: string; i_suivi: string; i_retour: string; i_autre: string;
```

Dans la requête de `getSummary`, remplacer :

```sql
         count(*) filter (where intent = 'prise_rdv')::int as i_rdv,
         count(*) filter (where intent = 'autre')::int as i_autre,
```

par :

```sql
         count(*) filter (where intent = 'prise_rdv')::int as i_rdv,
         count(*) filter (where intent = 'achat')::int as i_achat,
         count(*) filter (where intent = 'suivi_commande')::int as i_suivi,
         count(*) filter (where intent = 'retour')::int as i_retour,
         count(*) filter (where intent = 'autre')::int as i_autre,
```

Remplacer les lignes 299 et 300 :

```ts
     * 🔴 CE QUE CE REGROUPEMENT REND VISIBLE, ET QUI EST LE VRAI SUJET. Les six intentions sont une
     * énumération FERMÉE : le modèle ne peut pas en inventer une septième. Le `topic`, lui, est du texte
```

par :

```ts
     * 🔴 CE QUE CE REGROUPEMENT REND VISIBLE, ET QUI EST LE VRAI SUJET. Les intentions sont une
     * énumération FERMÉE (`INTENTS`) : le modèle ne peut pas en inventer d'autres. Le `topic`, lui, est du texte
```

Remplacer, dans la mise en forme du résultat (lignes 352 à 355) :

```ts
      intent: {
        demande_devis: Number(r.i_devis), sav: Number(r.i_sav), reclamation: Number(r.i_recl),
        information: Number(r.i_info), prise_rdv: Number(r.i_rdv), autre: Number(r.i_autre),
      },
```

par :

```ts
      intent: {
        demande_devis: Number(r.i_devis), sav: Number(r.i_sav), reclamation: Number(r.i_recl),
        information: Number(r.i_info), prise_rdv: Number(r.i_rdv), achat: Number(r.i_achat),
        suivi_commande: Number(r.i_suivi), retour: Number(r.i_retour), autre: Number(r.i_autre),
      },
```

- [ ] **Step 6: Dériver le filtre de la route**

Dans `src/http/stats.ts`, sous la ligne 16 (`import type { CompteurClic } from '../links/mesures';`), ajouter :

```ts
import { INTENTS as INTENTS_ANALYSE } from '../analysis/schema';
```

Remplacer les lignes 18 à 21 :

```ts
// Valeurs d'enum admises pour les filtres de la liste quali (miroir de src/analysis/schema.ts). On ne passe au
// store QUE des valeurs valides -> pas d'injection de filtre arbitraire, et le NULL = « pas de filtre ».
const SENTIMENTS = new Set(['positif', 'neutre', 'negatif']);
const INTENTS = new Set(['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']);
```

par :

```ts
// Valeurs d'enum admises pour les filtres de la liste quali. On ne passe au store QUE des valeurs valides ->
// pas d'injection de filtre arbitraire, et le NULL = « pas de filtre ».
// 🔴 LES INTENTIONS DÉRIVENT DU SCHÉMA DE L'ANALYSE : une copie en dur aurait ignoré `?intent=achat` et rendu
// TOUTES les conversations sous un filtre « Achat » affiché (lot 5 de l'API publique). Sentiments et actions
// restent des miroirs de `src/analysis/schema.ts`.
const SENTIMENTS = new Set(['positif', 'neutre', 'negatif']);
const INTENTS = new Set<string>(INTENTS_ANALYSE);
```

- [ ] **Step 7: Mettre la fixture de synthèse au nouveau contrat**

Dans `tests/http-stats-settings.test.ts`, remplacer la ligne 58 :

```ts
      intent: { demande_devis: 2, sav: 1, reclamation: 0, information: 0, prise_rdv: 0, autre: 0 },
```

par :

```ts
      intent: { demande_devis: 2, sav: 1, reclamation: 0, information: 0, prise_rdv: 0, achat: 0, suivi_commande: 0, retour: 0, autre: 0 },
```

- [ ] **Step 8: Les voir passer, typecheck compris**

Run: `npx vitest run tests/agregats-jour.test.ts tests/http-stats-settings.test.ts tests/intentions-parite.test.ts && npm run typecheck`
Expected: PASS, aucune erreur de type (sans l'étape 7, le typecheck refuse la fixture : c'est le `Record<Intent, number>` qui fait son travail).

- [ ] **Step 9: Vérifier les trois tests de non-régression dans les deux sens**

(a) Dans `src/http/stats.ts`, remettre temporairement `const INTENTS = new Set(['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']);`, puis
Run: `npx vitest run tests/http-stats-settings.test.ts`
Expected: FAIL sur « le filtre accepte CHAQUE intention », `undefined` à la place des trois valeurs neuves. Restaurer la ligne dérivée.
(b) Dans `AGREGAT_JOUR_SQL`, retirer temporairement la ligne `'achat', count(*) ...`, puis
Run: `npx vitest run tests/agregats-jour.test.ts`
Expected: FAIL, `l’intention achat n’est pas comptee`. Restaurer.
(c) Dans la requête de `getSummary`, retirer temporairement la ligne `count(*) filter (where intent = 'achat')::int as i_achat,`, puis
Run: `npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL, `getSummary ne compte pas achat`. Restaurer.
Run: `npx vitest run tests/agregats-jour.test.ts tests/http-stats-settings.test.ts tests/intentions-parite.test.ts && git diff src/http/stats.ts src/stats/conversation-stats.pg.ts`
Expected: PASS, et le diff ne montre que les changements voulus de cette tâche.

- [ ] **Step 10: Compléter le test d'intégration (JAMAIS lancé en local)**

Dans `tests/integration/intentions.integration.test.ts`, sous l'import de `PgConversationAnalysisStore`, ajouter :

```ts
import { PgConversationStatsStore } from '../../src/stats/conversation-stats.pg';
```

et, en fin du bloc `describe` (après le cas « le CHECK reste un CHECK »), ajouter :

```ts
  it('🔴 la synthèse, la liste filtrée et l’agrégat du jour comptent les intentions neuves', async () => {
    // Dépend du premier cas, qui a écrit une analyse de chaque intention neuve (les cas d'un fichier
    // s'exécutent dans l'ordre). Plage hier..demain : les analyses datent de `now()`, aucun bord de fuseau.
    const stats = new PgConversationStatsStore(pool, true, 90);
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const plage = { from: iso(new Date(Date.now() - 86_400_000)), to: iso(new Date(Date.now() + 86_400_000)) };

    const s = await stats.getSummary(tenantId, plage);
    expect(s.intent).toMatchObject({ achat: 1, suivi_commande: 1, retour: 1 });

    const liste = await stats.listAnalyzed(tenantId, plage, { intent: 'suivi_commande' });
    expect(liste.map((l) => l.intent)).toEqual(['suivi_commande']);

    await stats.ecrireAgregats(plage, tenantId);
    const jours = await pool.query<{ conversations: number; intentions: Record<string, number> }>(
      'select conversations, intentions from analyse_jour where tenant_id = $1', [tenantId],
    );
    const total = jours.rows.reduce((t, r) => t + r.conversations, 0);
    const reparties = jours.rows.reduce((t, r) => t + Object.values(r.intentions).reduce((a, b) => a + b, 0), 0);
    // L'invariant que l'agrégat promet : sa répartition par intention retombe EXACTEMENT sur son total.
    expect(reparties, 'la répartition par intention ne retombe pas sur le total du jour').toBe(total);
    expect(jours.rows.reduce((t, r) => t + (r.intentions['achat'] ?? 0), 0)).toBe(1);
  });
```

⚠️ **Ce cas ne se vérifie PAS dans les deux sens hors CI, et c'est assumé ici par écrit**, pour la même raison qu'à la tâche 2 (la seule base joignable du poste est la PRODUCTION). Les défauts qu'il garde sont tenus dans les deux sens, côté TEXTE, par les tests unitaires vérifiés à l'étape 9 : `tests/agregats-jour.test.ts` pour `AGREGAT_JOUR_SQL` (b), `tests/intentions-parite.test.ts` pour les colonnes de `getSummary` (c), `tests/http-stats-settings.test.ts` pour le filtre `?intent=` que `listAnalyzed` reçoit (a). Le job `integration` ajoute la preuve que ces requêtes rendent les bons comptes sur un vrai Postgres.

- [ ] **Step 11: Suite complète et typecheck**

Run: `npm run typecheck && npm test`
Expected: vert.

- [ ] **Step 12: Commit**

Run:
```bash
cd /c/Users/julie/messagingme-mba && git diff src/stats/conversation-stats.pg.ts src/http/stats.ts tests/agregats-jour.test.ts tests/http-stats-settings.test.ts tests/intentions-parite.test.ts tests/integration/intentions.integration.test.ts && git commit --only src/stats/conversation-stats.pg.ts src/http/stats.ts tests/agregats-jour.test.ts tests/http-stats-settings.test.ts tests/intentions-parite.test.ts tests/integration/intentions.integration.test.ts -m "$(cat <<'EOF'
feat(stats): la synthese, l agregat du jour et le filtre connaissent les intentions neuves

getSummary et AGREGAT_JOUR_SQL comptent achat, suivi_commande et retour ;
intent devient Record<Intent, number>. Le filtre ?intent= derive de INTENTS au
lieu d une copie qui aurait ignore les valeurs neuves.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 13: Revue du backend, puis push**

Lancer `/revue` sur le diff des tâches 2 à 4 (`git diff <commit parent de la tâche 2>..HEAD -- src db tests CLAUDE.md`), avec sa section « Rayon de souffle » (voir la section de ce plan). Corriger les 🔴 ET les 🟡 dans la foulée, commits `--only`.
Run: `cd /c/Users/julie/messagingme-mba && git log --oneline origin/main..HEAD && git push origin main`
Expected : le `git log` montre ce que le push emporte (l'arbre est partagé : si des commits d'autres sessions y figurent, le dire dans l'annonce). Puis lire le run : `gh run list --limit 5`, repérer celui du dernier commit de code, `gh run view <id> --json jobs` : `unit`, `integration` et `securite` en `success`, et le job `integration` a bien exécuté `tests/integration/intentions.integration.test.ts` (`gh run view <id> --log | grep intentions.integration`).

---

🔴 **POINT D'ARRÊT : l'étape A du Déploiement (l'API) se joue ICI, avant la tâche 5.** La console ne doit pas proposer « Achat » dans un filtre que l'API déployée ignorerait (section Déploiement). Ne commencer la tâche 5 qu'une fois l'étape A terminée, contrôles compris.

---

### Task 5: Le module des intentions de la console

**Files:**
- Create: `web/lib/intentions.ts`
- Create: `web/lib/intentions.test.ts`
- Modify: `tests/intentions-parite.test.ts` (un import en tête, un bloc en fin)

**Interfaces:**
- Consumes : rien du serveur (la console n'importe jamais `src/`) ; la parité avec `INTENTS` est tenue par `tests/intentions-parite.test.ts`.
- Produces (`web/lib/intentions.ts`) :
  - `export const INTENTIONS: readonly ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre']` (`as const`) ;
  - `export type Intention = (typeof INTENTIONS)[number];`
  - `export function estIntention(v: string): v is Intention`
  - `export function libelleIntention(i: string, t: (fr: string, en?: string) => string): string`
  - `export function comptesParIntention(intent: Partial<Record<Intention, number>> | null | undefined): Array<{ intention: Intention; n: number }>`
  - Le lot 6 n'en refait pas de copie : sa section « Ce que nous remontons » ne liste pas les intentions, elle renvoie aux valeurs de l'écran d'analyse, et `intent` traverse son adaptateur tel quel (plan du lot 6, « Ce que ce lot consomme, et d'où »). Ce module reste donc la seule copie de la console.

- [ ] **Step 1: Écrire le test unitaire de la console, qui échoue**

Créer `web/lib/intentions.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { INTENTIONS, comptesParIntention, estIntention, libelleIntention } from './intentions';

const T = (fr: string): string => fr;

describe('intentions : ce que la console affiche', () => {
  it('🔴 une API plus ANCIENNE, qui ne connaît pas les intentions neuves, rend des ZÉROS et pas des trous', () => {
    // La réponse exacte d'une API d'avant le 2026-09-24 : six clés. La console part sur Vercel à chaque push,
    // l'API se déploie à la main : cette forme arrive VRAIMENT, le temps d'un déploiement.
    const ancienne = { demande_devis: 2, sav: 1, reclamation: 0, information: 0, prise_rdv: 0, autre: 0 };
    const comptes = comptesParIntention(ancienne);
    expect(comptes.map((c) => c.intention)).toEqual([...INTENTIONS]);
    expect(comptes.find((c) => c.intention === 'achat')?.n).toBe(0);
    expect(comptes.find((c) => c.intention === 'demande_devis')?.n).toBe(2);
    expect(comptes.every((c) => Number.isFinite(c.n))).toBe(true);
  });

  it('un corps sans aucune intention rend des zéros, dans l’ordre d’affichage', () => {
    expect(comptesParIntention(undefined).map((c) => c.n)).toEqual(INTENTIONS.map(() => 0));
  });

  it('⚠️ une intention INCONNUE (API plus récente) s’affiche telle quelle, jamais vide', () => {
    expect(libelleIntention('nouvelle_intention', T)).toBe('nouvelle_intention');
  });

  it('les trois intentions de commerce ont leur libellé', () => {
    expect(libelleIntention('achat', T)).toBe('Achat');
    expect(libelleIntention('suivi_commande', T)).toBe('Suivi de commande');
    expect(libelleIntention('retour', T)).toBe('Retour ou échange');
  });

  it('estIntention refuse une valeur bricolée dans l’adresse', () => {
    expect(estIntention('suivi_commande')).toBe(true);
    expect(estIntention('nawak')).toBe(false);
  });
});
```

En tête de `tests/intentions-parite.test.ts`, sous les imports existants, ajouter :

```ts
import { INTENTIONS, libelleIntention } from '../web/lib/intentions';
```

En fin de fichier, ajouter :

```ts
describe('les intentions : la console connaît les mêmes, et sait les nommer', () => {
  it('🔴 la copie de la console est INTENTS, dans le même ordre', () => {
    // L'ordre compte : c'est l'ordre FIXE des barres. Un ordre différent ne casserait rien, il ferait
    // seulement diverger deux listes qu'on croirait identiques.
    expect([...INTENTIONS]).toEqual([...INTENTS]);
  });

  it('🔴 chaque intention a un libellé français ET anglais, jamais sa clé brute', () => {
    const fr = (f: string): string => f;
    const en = (f: string, e?: string): string => e ?? f;
    for (const i of INTENTS) {
      expect(libelleIntention(i, fr), `pas de libellé français pour ${i}`).not.toBe(i);
      expect(libelleIntention(i, en), `pas de libellé anglais pour ${i}`).not.toBe(i);
    }
  });

  it('⚠️ aucun libellé pour une intention que le schéma ne connaît pas', () => {
    // Un `case` orphelin est le reste d'une valeur retirée : il ne casse rien, mais il ment sur la liste.
    const cases = [...lire('web/lib/intentions.ts').matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    expect([...cases].sort()).toEqual([...INTENTS].sort());
  });
});
```

- [ ] **Step 2: Les voir échouer**

Run: `cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/intentions.test.ts; cd .. && npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL des deux côtés, le module `./intentions` (et `../web/lib/intentions`) est introuvable.

- [ ] **Step 3: Écrire le module**

Créer `web/lib/intentions.ts` (AUCUN import : la racine l'importe dans ses tests, et un alias `@/` n'y serait pas résolu) :

```ts
/**
 * LES INTENTIONS D'UNE CONVERSATION ANALYSÉE, CÔTÉ CONSOLE : la liste, l'ordre d'affichage et les libellés.
 *
 * 🔴 MIROIR DE `INTENTS` (`src/analysis/schema.ts`), ET C'EST UN TEST QUI LE TIENT, PAS CE COMMENTAIRE. La
 * console n'importe jamais `src/` (`tests/ci-decoupage.test.ts`) : la liste existe donc en deux exemplaires,
 * et `tests/intentions-parite.test.ts` (à la RACINE, parce que seul `ci.yml` tourne sur un changement de
 * `src/`) exige qu'ils soient identiques, dans le même ordre, et que chaque valeur ait son libellé.
 *
 * ⚠️ L'ORDRE EST CELUI DE L'AFFICHAGE, ET IL EST FIXE : un classement par volume ferait danser les barres
 * d'une période à l'autre, et l'œil prendrait ce mouvement pour une information. `autre` reste la dernière.
 *
 * Un seul module pour les deux écrans qui les nomment (la carte du Performance Lab et l'Analyse des
 * conversations) : chacun portait sa copie de la liste et des libellés.
 */
export const INTENTIONS = [
  'demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre',
] as const;
export type Intention = (typeof INTENTIONS)[number];

type Tr = (fr: string, en?: string) => string;

/** Une valeur venue d'une adresse ou du réseau est-elle une intention connue de CETTE console ? */
export function estIntention(v: string): v is Intention {
  return (INTENTIONS as readonly string[]).includes(v);
}

/**
 * Le libellé d'une intention.
 *
 * ⚠️ Une valeur INCONNUE (une API plus récente que la console) s'affiche telle quelle, jamais vide : un vide
 * passerait pour une donnée manquante.
 */
export function libelleIntention(i: string, t: Tr): string {
  switch (i) {
    case 'demande_devis': return t('Demande de devis', 'Quote request');
    case 'sav': return t('SAV', 'After-sales');
    case 'reclamation': return t('Réclamation', 'Complaint');
    case 'information': return t('Information', 'Information');
    case 'prise_rdv': return t('Prise de RDV', 'Appointment');
    case 'achat': return t('Achat', 'Purchase');
    case 'suivi_commande': return t('Suivi de commande', 'Order tracking');
    case 'retour': return t('Retour ou échange', 'Return or exchange');
    case 'autre': return t('Autre', 'Other');
    default: return i;
  }
}

/**
 * Les comptes par intention, dans l'ordre d'affichage, une intention absente valant ZÉRO.
 *
 * 🔴 L'ABSENCE EST UN CAS RÉEL : la console part sur Vercel à chaque push quand l'API se déploie à la main
 * sur le VPS. Une API plus ancienne ne connaît pas les intentions ajoutées depuis, et sans ce repli l'Analyse
 * des conversations tomberait en entier : `Math.max` rendrait NaN, puis `fmtNum(undefined)` lèverait une
 * TypeError pendant le rendu.
 */
export function comptesParIntention(
  intent: Partial<Record<Intention, number>> | null | undefined,
): Array<{ intention: Intention; n: number }> {
  return INTENTIONS.map((intention) => ({ intention, n: intent?.[intention] ?? 0 }));
}
```

- [ ] **Step 4: Les voir passer**

Run: `cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/intentions.test.ts; cd .. && npx vitest run tests/intentions-parite.test.ts tests/ci-decoupage.test.ts && npm run typecheck`
Expected: PASS partout (`ci-decoupage` confirme que la console n'importe toujours pas `src/` ; le typecheck de la racine compile `web/lib/intentions.ts` à travers l'import du test).

- [ ] **Step 5: Vérifier le repli dans les deux sens**

Dans `web/lib/intentions.ts`, remplacer temporairement `n: intent?.[intention] ?? 0` par `n: intent?.[intention] as number`, puis
Run: `cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/intentions.test.ts`
Expected: FAIL, `expected undefined to be 0` sur `achat`.
Restaurer, puis
Run: `cd /c/Users/julie/messagingme-mba && git diff --stat web/lib/intentions.ts; cd web && npx vitest run lib/intentions.test.ts`
Expected: aucun diff (fichier neuf non suivi : `git status --short web/lib/intentions.ts` rend `??`), puis PASS.

- [ ] **Step 6: Commit**

Run:
```bash
cd /c/Users/julie/messagingme-mba && git diff tests/intentions-parite.test.ts && git commit --only web/lib/intentions.ts web/lib/intentions.test.ts tests/intentions-parite.test.ts -m "$(cat <<'EOF'
feat(console): un seul module pour les intentions, et son repli a zero

web/lib/intentions.ts porte la liste, l ordre d affichage, les libelles et
comptesParIntention, qui ramene a zero une intention qu une API plus ancienne
ne connait pas. La parite avec INTENTS est tenue a la racine.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Les deux écrans passent par le module, et tolèrent une API plus ancienne

**Files:**
- Modify: `web/components/CarteIntentions.tsx:7` (import), `:12-14` (commentaire), `:34-48` (copie locale retirée, du commentaire `/** L'ordre d'affichage, et il est FIXE` jusqu'à l'accolade `}` qui ferme `function libelle`), `:55`, `:68`, `:101-102`, `:116` et `:129` (`libelle(i, t)`)
- Modify: `web/components/ConversationAnalysisCard.tsx:23` (import), `:45`, `:57-67`, `:186-188`, `:215-216`, `:297`, `:361`, `:520`, `:572`, `:645`
- Modify: `web/lib/api/stats.ts:11` (import) et `:310`
- Modify: `web/e2e/performance-intentions.spec.ts:1`, `:6-7`, `:20`, `:58-66`, `:123`, et un cas neuf
- Modify: `web/e2e/analytics-quali-actionnable.spec.ts` (un cas neuf en fin de `describe`)
- Modify: `tests/intentions-parite.test.ts` (un bloc `describe` en fin : les écrans n'ont plus de copie)

**Interfaces:**
- Consumes : `INTENTIONS`, `type Intention`, `estIntention`, `libelleIntention`, `comptesParIntention` (tâche 5) ; `ConversationAnalysisSummary` (`web/lib/api/stats.ts:299`).
- Produces : `ConversationAnalysisSummary['intent']` côté console = `Partial<Record<Intention, number>>` ; `data-testid="quali-intentions"` sur le bloc « Par intention » de l'Analyse des conversations.

- [ ] **Step 1: Annoncer la suite e2e aux sessions qui partagent l'arbre**

`ListAgents`, puis `SendMessage` à chaque session du dépôt : « je lance une suite e2e dans `web/` (build Next dans `web/.next`) ». Deux suites concurrentes empoisonnent `web/.next` (`CLAUDE.md` du dépôt). Vérifier que le port 3000 est libre, sinon Playwright RÉUTILISE un serveur existant et teste un autre bundle :
Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000 || true`
Expected: `000`.

- [ ] **Step 2: Écrire les cas qui échouent (e2e, et la garde des copies dans le test de parité)**

Dans `web/e2e/analytics-quali-actionnable.spec.ts`, en fin du `test.describe(...)` (avant sa dernière ligne `});`), ajouter :

```ts
  test('🔴 une API qui ne connait pas les intentions neuves ne fait pas tomber la page', async ({ page }) => {
    // RESUME ne porte que les six intentions d avant le 2026-09-24 : c est exactement la reponse d une API
    // plus ancienne que la console. Sans repli a zero, `Math.max` rendrait NaN et `fmtNum(undefined)`
    // leverait une TypeError : la page entiere tomberait, pas seulement une barre.
    const appels: string[] = [];
    await mock(page, appels);
    await page.goto('/dashboard/quali');
    const bloc = page.getByTestId('quali-intentions');
    await expect(bloc).toContainText('Demande de devis');
    await expect(bloc).toContainText('Suivi de commande');
    await expect(bloc).not.toContainText('NaN');
  });
```

Dans `web/e2e/performance-intentions.spec.ts` :
- ligne 1, ajouter en dessous : `import { INTENTIONS } from '../lib/intentions';`
- lignes 6 et 7, remplacer `Les six intentions sont une` / `enumeration FERMEE : elles n enflent pas.` par `Les intentions sont une` / `enumeration FERMEE : elles n enflent pas.` (même découpage de lignes) ;
- ligne 20, remplacer la ligne `intent` de `RESUME` par :

```ts
  intent: { demande_devis: 0, sav: 0, reclamation: 0, information: 9, prise_rdv: 2, achat: 0, suivi_commande: 0, retour: 0, autre: 3 },
```

- remplacer le cas des lignes 58 à 66 :

```ts
  test('les six intentions sont la, dans un ordre FIXE', async ({ page }) => {
    // Un classement par volume ferait danser les barres d une periode a l autre, et l oeil prendrait ce
    // mouvement pour une information.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('carte-intentions')).toBeVisible();
    for (const i of ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']) {
      await expect(page.getByTestId(`intention-${i}`)).toBeVisible();
    }
  });
```

par (le cas d'origine est conservé : ses six valeurs font partie de `INTENTIONS`) :

```ts
  test('toutes les intentions sont la, dans un ordre FIXE', async ({ page }) => {
    // Un classement par volume ferait danser les barres d une periode a l autre, et l oeil prendrait ce
    // mouvement pour une information. La liste vient du module de la console, lui-meme tenu egal a INTENTS.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('carte-intentions')).toBeVisible();
    for (const i of INTENTIONS) {
      await expect(page.getByTestId(`intention-${i}`)).toBeVisible();
    }
  });
```

- juste après le cas `'⚠️ une API plus ANCIENNE, sans les sujets par intention, ne casse pas la carte'`, ajouter :

```ts
  test('🔴 une API plus ANCIENNE, qui ne connait pas les intentions ajoutees depuis, montre des barres a zero', async ({ page }) => {
    // Entre le push de la console et le deploiement de l API, `intent` ne porte pas les cles neuves. Leur
    // barre doit exister, a zero et non cliquable, et rien ne doit afficher NaN.
    await mock(page, { ...RESUME, intent: { demande_devis: 0, sav: 0, reclamation: 0, information: 9, prise_rdv: 2, autre: 3 } });
    await page.goto('/performance');
    await expect(page.getByTestId('intention-ouvrir-achat')).toBeDisabled();
    await expect(page.getByTestId('intention-ouvrir-information')).toBeEnabled();
    await expect(page.getByTestId('carte-intentions')).not.toContainText('NaN');
  });
```

- ligne 123, renommer `'aucune conversation analysee -> une phrase, pas six barres a zero'` en `'aucune conversation analysee -> une phrase, pas des barres a zero'`.

En fin de `tests/intentions-parite.test.ts` (après le bloc ajouté à la tâche 5), ajouter :

```ts
describe('les intentions : les écrans n’en portent plus de copie', () => {
  // 🔴 LA PARITÉ DU MODULE NE VOIT QUE LE MODULE. Les deux écrans portaient chacun leur liste et leurs
  // libellés, et c'est ainsi qu'une intention ajoutée au schéma n'arrivait sur aucun des deux. Une copie
  // réintroduite dans un écran repasserait sans que le bloc précédent la voie : celui-ci la refuse.
  const ECRANS = ['web/components/CarteIntentions.tsx', 'web/components/ConversationAnalysisCard.tsx'];

  for (const ecran of ECRANS) {
    it(`🔴 ${ecran} lit la liste et les libellés dans web/lib/intentions.ts`, () => {
      const source = lire(ecran);
      expect(source, `${ecran} n’importe pas @/lib/intentions`).toContain("from '@/lib/intentions'");
      for (const i of INTENTS) {
        expect(source, `${ecran} porte son propre libellé pour ${i}`).not.toContain(`case '${i}'`);
      }
      expect(source, `${ecran} porte sa propre liste d’intentions`).not.toContain("'prise_rdv'");
      expect(source, `${ecran} porte sa propre liste d’intentions`).not.toMatch(/const INTENTS\b/);
    });
  }
});
```

- [ ] **Step 3: Les voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL sur les deux cas neufs, `web/components/CarteIntentions.tsx n’importe pas @/lib/intentions` et la même chose pour `ConversationAnalysisCard.tsx` ; les autres cas du fichier restent verts.
Run: `cd /c/Users/julie/messagingme-mba/web && npx playwright test e2e/performance-intentions.spec.ts e2e/analytics-quali-actionnable.spec.ts`
Expected: FAIL sur les cas neufs et sur « toutes les intentions sont la » : `getByTestId('intention-achat')` et `getByTestId('quali-intentions')` introuvables (le build prend plusieurs minutes, c'est le webServer de Playwright).

- [ ] **Step 4: Le type réseau de la synthèse**

Dans `web/lib/api/stats.ts`, sous la ligne 11 (`import { request } from '../http';`), ajouter :

```ts
import type { Intention } from '../intentions';
```

Remplacer la ligne 310 :

```ts
  intent: { demande_devis: number; sav: number; reclamation: number; information: number; prise_rdv: number; autre: number };
```

par :

```ts
  /**
   * ⚠️ PARTIEL A LA LECTURE, comme `topicsParIntention` plus bas et pour la meme raison de RESEAU : une API
   * plus ancienne que la console ne connait pas les intentions ajoutees depuis, et une cle absente n est pas
   * un zero que l API aurait envoye. Le type oblige chaque lecteur a passer par `comptesParIntention`
   * (`web/lib/intentions.ts`), qui la ramene a zero.
   */
  intent: Partial<Record<Intention, number>>;
```

- [ ] **Step 5: La carte du Performance Lab**

Dans `web/components/CarteIntentions.tsx` :

Sous la ligne 7 (`import { useT, useLocale } from '@/lib/i18n';`), ajouter :

```ts
import { comptesParIntention, libelleIntention, type Intention } from '@/lib/intentions';
```

Remplacer les lignes 12 à 14 :

```ts
 * 🔴 DEUX NIVEAUX, ET LE SECOND EST LE VRAI SUJET DE CETTE CARTE. Les six intentions sont une énumération
 * FERMÉE (`src/analysis/schema.ts`) : le modèle ne peut pas en inventer une septième, donc elles
 * n'enflent pas. Le `topic`, lui, est du texte LIBRE, et c'est là que vit l'inflation que Julien redoutait
```

par :

```ts
 * 🔴 DEUX NIVEAUX, ET LE SECOND EST LE VRAI SUJET DE CETTE CARTE. Les intentions sont une énumération
 * FERMÉE (`src/analysis/schema.ts`, copiée dans `web/lib/intentions.ts`) : le modèle ne peut pas en
 * inventer d'autres, donc elles n'enflent pas. Le `topic`, lui, est du texte LIBRE, et c'est là que vit
 * l'inflation que Julien redoutait
```

Remplacer les lignes 34 à 48, c'est-à-dire ce bloc exact (le commentaire d'ordre, `INTENTS`, `type Intent` et la fonction `libelle`, jusqu'à l'accolade qui la ferme ; la ligne vide 33 et la ligne vide 49 restent) :

```ts
/** L'ordre d'affichage, et il est FIXE : un classement par volume ferait danser les barres d'une période
 *  à l'autre, et l'œil prendrait ce mouvement pour une information. */
const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre'] as const;
type Intent = (typeof INTENTS)[number];

function libelle(i: Intent, t: (fr: string, en?: string) => string): string {
  switch (i) {
    case 'demande_devis': return t('Demande de devis', 'Quote request');
    case 'sav': return t('SAV', 'After-sales');
    case 'reclamation': return t('Réclamation', 'Complaint');
    case 'information': return t('Information', 'Information');
    case 'prise_rdv': return t('Prise de RDV', 'Appointment');
    case 'autre': return t('Autre', 'Other');
  }
}
```

par :

```ts
/** La liste, son ordre FIXE d'affichage et les libellés vivent dans `@/lib/intentions`, partagés avec
 *  l'Analyse des conversations. */
```

Remplacer `useState<Intent | null>(null)` par `useState<Intention | null>(null)` (ligne 55) et `const versAnalyse = (i: Intent): void => {` par `const versAnalyse = (i: Intention): void => {` (ligne 68).

Remplacer les lignes 101 et 102 :

```tsx
          {INTENTS.map((i) => {
            const n = resume.intent[i] ?? 0;
```

par :

```tsx
          {comptesParIntention(resume.intent).map(({ intention: i, n }) => {
```

Enfin remplacer TOUTES les occurrences de `libelle(i, t)` par `libelleIntention(i, t)` (trois : les deux de l'`aria-label` du chevron, celle du nom).

- [ ] **Step 6: L'Analyse des conversations**

Dans `web/components/ConversationAnalysisCard.tsx` :

Sous la ligne 23 (`import { entetesQuali, ligneQuali } from '@/lib/quali-export';`), ajouter :

```ts
import { INTENTIONS, comptesParIntention, estIntention, libelleIntention } from '@/lib/intentions';
```

Remplacer la ligne 45 :

```ts
const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre'] as const;
```

par :

```ts
// Les intentions vivent dans `@/lib/intentions` (liste, ordre, libellés), partagées avec la carte du Performance Lab.
```

Supprimer la fonction `intentLabel` (lignes 57 à 67) :

```ts
function intentLabel(i: string, t: Tr): string {
  switch (i) {
    case 'demande_devis': return t('Demande de devis', 'Quote request');
    case 'sav': return t('SAV', 'After-sales');
    case 'reclamation': return t('Réclamation', 'Complaint');
    case 'information': return t('Information', 'Information');
    case 'prise_rdv': return t('Prise de RDV', 'Appointment');
    case 'autre': return t('Autre', 'Other');
    default: return i;
  }
}
```

Remplacer les lignes 186 à 188 :

```tsx
  // Intentions triées par volume décroissant (demande_devis remonte = signal commercial).
  const intents = INTENTS.map((k) => ({ key: k, label: intentLabel(k, t), value: summary.intent[k] }))
    .sort((a, b) => b.value - a.value);
```

par :

```tsx
  // Intentions triées par volume décroissant (demande_devis remonte = signal commercial). `comptesParIntention`
  // ramène à zéro une intention qu'une API plus ancienne ne connaît pas : sans lui, `Math.max` rendrait NaN
  // et `fmtNum(undefined)` ferait tomber toute la page.
  const intents = comptesParIntention(summary.intent)
    .map(({ intention, n }) => ({ key: intention, label: libelleIntention(intention, t), value: n }))
    .sort((a, b) => b.value - a.value);
```

Remplacer les lignes 215 et 216 :

```tsx
          <div className={SECTION_LABEL}>{t('Par intention', 'By intent')}</div>
          <div className="space-y-2">
```

par :

```tsx
          <div className={SECTION_LABEL}>{t('Par intention', 'By intent')}</div>
          <div className="space-y-2" data-testid="quali-intentions">
```

Remplacer la ligne 520 :

```tsx
    intentionInitiale && (INTENTS as readonly string[]).includes(intentionInitiale) ? intentionInitiale : '',
```

par :

```tsx
    intentionInitiale && estIntention(intentionInitiale) ? intentionInitiale : '',
```

Remplacer la ligne 572 :

```tsx
          {INTENTS.map((i) => <option key={i} value={i}>{intentLabel(i, t)}</option>)}
```

par :

```tsx
          {INTENTIONS.map((i) => <option key={i} value={i}>{libelleIntention(i, t)}</option>)}
```

Enfin remplacer TOUTES les occurrences restantes de `intentLabel(` par `libelleIntention(` (l'export CSV `intent: (v: string) => ...`, le champ de la fiche, la cellule du tableau). Vérifier :
Run: `cd /c/Users/julie/messagingme-mba && grep -n "intentLabel\|INTENTS\b" web/components/ConversationAnalysisCard.tsx web/components/CarteIntentions.tsx`
Expected: aucune ligne.

- [ ] **Step 7: Build, types, lint, tests unitaires de la console**

Run: `cd /c/Users/julie/messagingme-mba/web && npm run build && npx tsc --noEmit && npm run lint && npm test`
Expected: vert (le build régénère `.next/types`, sans lequel `tsc` voit des types fantômes).
Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/intentions-parite.test.ts tests/ci-decoupage.test.ts && npm run typecheck`
Expected: PASS, les deux cas « lit la liste et les libellés dans web/lib/intentions.ts » compris.

- [ ] **Step 8: Vérifier la garde des copies dans les deux sens**

Dans `web/components/CarteIntentions.tsx`, juste sous le commentaire qui a remplacé la copie locale à l'étape 5 (`/** La liste, son ordre FIXE d'affichage et les libellés vivent dans ...`), remettre temporairement la ligne :

```ts
const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre'] as const;
```

puis
Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/intentions-parite.test.ts`
Expected: FAIL sur le seul cas de `CarteIntentions.tsx`, `web/components/CarteIntentions.tsx porte sa propre liste d’intentions` ; le cas de `ConversationAnalysisCard.tsx` reste vert.
Retirer la ligne, puis
Run: `cd /c/Users/julie/messagingme-mba && grep -c "const INTENTS" web/components/CarteIntentions.tsx; npx vitest run tests/intentions-parite.test.ts`
Expected: `0`, puis PASS.

- [ ] **Step 9: Les e2e passent**

Run: `cd /c/Users/julie/messagingme-mba/web && npx playwright test e2e/performance-intentions.spec.ts e2e/analytics-quali-actionnable.spec.ts e2e/analyse-conversations-jours.spec.ts`
Expected: PASS (le troisième spec sert encore une synthèse à six clés : il doit rester vert tel quel).

- [ ] **Step 10: Vérifier le cas qui fait tomber la page, dans les deux sens**

Dans `web/lib/intentions.ts`, remplacer temporairement `n: intent?.[intention] ?? 0` par `n: intent?.[intention] as number`, puis (le port 3000 étant libre, le webServer RECONSTRUIT le bundle ; restaurer une source ne restaure pas ce qui est servi, d'où cette précaution)
Run: `cd /c/Users/julie/messagingme-mba/web && npx playwright test e2e/analytics-quali-actionnable.spec.ts -g "intentions neuves"`
Expected: FAIL, `getByTestId('quali-intentions')` introuvable : la page est tombée (TypeError dans `fmtNum`).
Restaurer, puis
Run: `cd /c/Users/julie/messagingme-mba && git diff --stat web/lib/intentions.ts && cd web && npx playwright test e2e/analytics-quali-actionnable.spec.ts -g "intentions neuves"`
Expected: aucun diff, puis PASS.

- [ ] **Step 11: Revue, commit**

Lancer `/revue` sur le diff de la console (`git diff -- web tests/intentions-parite.test.ts`). Corriger les 🔴 ET les 🟡.
Run:
```bash
cd /c/Users/julie/messagingme-mba && git diff web/components/CarteIntentions.tsx web/components/ConversationAnalysisCard.tsx web/lib/api/stats.ts web/e2e/performance-intentions.spec.ts web/e2e/analytics-quali-actionnable.spec.ts tests/intentions-parite.test.ts && git commit --only web/components/CarteIntentions.tsx web/components/ConversationAnalysisCard.tsx web/lib/api/stats.ts web/e2e/performance-intentions.spec.ts web/e2e/analytics-quali-actionnable.spec.ts tests/intentions-parite.test.ts -m "$(cat <<'EOF'
feat(console): les ecrans d analyse nomment les intentions neuves

La carte du Performance Lab et l Analyse des conversations passent par
web/lib/intentions.ts : barres, filtre, fiche et export CSV connaissent achat,
suivi de commande et retour. intent devient partiel a la lecture, et une API
plus ancienne rend des barres a zero au lieu de faire tomber la page. Le test
de parite refuse desormais qu un ecran reprenne sa propre copie de la liste.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
Le push de ce commit PUBLIE la console chez Vercel : il se fait à l'étape B du Déploiement, pas ici.

---

### Task 7: La documentation

**Files:**
- Modify: `features.md:1458`
- Modify: `docs/JOURNAL-TECHNIQUE.md:7` (entrée datée, en tête, sous l'avertissement)

**Interfaces:**
- Consumes : les faits mesurés aux étapes A et B du Déploiement (date, relecture en base, sonde).
- Produces : rien pour le code.

- [ ] **Step 1: `features.md`**

Remplacer, ligne 1458, le fragment :

```markdown
négatif), barres par **intention** (demande de devis, SAV, réclamation, info, prise de RDV, autre) et par
```

par :

```markdown
négatif), barres par **intention** (demande de devis, SAV, réclamation, info, prise de RDV, achat, suivi de
commande, retour ou échange, autre ; les trois intentions de commerce en ligne existent depuis le <date de
l'étape A, AAAA-MM-JJ>, et une conversation analysée avant garde son intention d'origine) et par
```

(Aucun outil tiers nommé : `features.md` se lit hors de l'équipe, voir les Global Constraints.)

- [ ] **Step 2: `docs/JOURNAL-TECHNIQUE.md`**

Sous l'avertissement d'en-tête (ligne 7), avant la première entrée `## 2026-09-23 (nuit) ...`, ajouter une entrée rédigée avec les faits RÉELLEMENT constatés aux étapes A et B (date, numéro de migration, heure de `migrate`, sortie de la relecture, sortie de la sonde). Le journal est interne : il nomme notre connecteur HubSpot et sa propriété, comme le permettent les Global Constraints.

```markdown
## <date> : trois intentions de commerce en ligne (lot 5 de l'API publique)

`achat`, `suivi_commande` et `retour` rejoignent `INTENTS`. La migration <N> relâche
`conversation_analysis_intent_check` (nom lu en base avant d'écrire, comme en 0166), appliquée AVANT le `up`
parce qu'elle relâche : l'ancien code y survit, l'inverse aurait rejoué chaque analyse neuve jusqu'à la DLQ,
appel au modèle compris. Relue en base juste après `migrate` : <sortie de la relecture>. Sonde du chemin
chaud par le vrai code (`getSummary` sur les espaces réels) : <sortie>.

Le connecteur HubSpot n'a pas bougé, et c'est vérifié, pas supposé : il reçoit l'analyse en `z.record`
opaque et écrit l'intention dans une propriété TEXTE (`mm_last_intent`).

La console a été poussée APRÈS l'API : avec l'ancienne route, un filtre « Achat » aurait été ignoré et la
liste aurait rendu toutes les conversations sous ce filtre. Et elle tolère quand même une API plus ancienne
(`comptesParIntention`) : sans ce repli, l'Analyse des conversations tombait en entier sur `fmtNum(undefined)`,
constaté par la vérification dans les deux sens du test e2e.

La parité (base, prompt, SQL de la synthèse et de l'agrégat, copie de la console) est DÉRIVÉE de `INTENTS`
dans `tests/intentions-parite.test.ts` et `tests/agregats-jour.test.ts`.
```

- [ ] **Step 3: Commit et push (des `.md` seuls ne déclenchent aucun run de CI)**

Run:
```bash
cd /c/Users/julie/messagingme-mba && git diff features.md docs/JOURNAL-TECHNIQUE.md && git commit --only features.md docs/JOURNAL-TECHNIQUE.md -m "$(cat <<'EOF'
docs(analyse): les trois intentions de commerce en ligne

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)" && git push origin main
```

---

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** La production emprunte ce chemin à chaque conversation analysée (l'INSERT de l'analyse passe par le CHECK, et un refus fait rejouer un appel payant au modèle jusqu'à la DLQ), le code touché porte des invariants invisibles (un CHECK nommé automatiquement par 0027, l'ordre migration puis `up`, un fragment SQL partagé entre la lecture en direct et l'agrégat qui précède la seule purge irréversible du dépôt), et si la parité se teste mécaniquement, la qualité du classement par le modèle ne se juge qu'à l'œil, sur de vraies conversations. Réversible tant qu'aucune analyse neuve n'existe, plus après : un retour arrière du CHECK exigerait alors de reclasser ces lignes. Pas de feature-loop, pas de workflow multi-agents. Ce qui clôt le lot n'est aucun test vert mais l'essai réel décrit plus bas : trois vraies conversations sur le numéro d'essai, une par intention neuve, suivies de la barre du Performance Lab jusqu'à la ligne en base.

## Essai réel qui clôt le lot

Le § 14 de la spec ne contient aucun geste propre aux intentions : celui-ci le complète. En production, sur le numéro d'essai, APRÈS les étapes A et B du Déploiement, en regardant le téléphone et la console :

1. Depuis le téléphone d'essai, écrire au numéro WhatsApp d'essai : « Bonjour, où en est ma commande 8412 ? Elle devait partir hier. » Puis ne plus rien écrire pendant 30 minutes (25 minutes d'inactivité, `CONVERSATION_INACTIVITY_MS`, plus le passage du balayage, toutes les 5 minutes).
2. Performance Lab, carte « Conversations par intention » : la barre « Suivi de commande » vaut 1. La cliquer : `/dashboard/quali?intention=suivi_commande` liste CETTE conversation, le filtre affiche « Suivi de commande », la fiche dit « Intention : Suivi de commande », l'export CSV porte « Suivi de commande » dans la colonne Intention.
3. En base, lecture seule : `select intent, created_at from public.conversation_analysis where conversation_id = '<id de la conversation>'` rend `suivi_commande`.
4. Recommencer sur la même conversation (une nouvelle analyse REMPLACE la précédente, donc vérifier chaque étape avant la suivante) : « Je voudrais renvoyer les chaussures reçues hier, elles sont trop petites, je peux les échanger ? », attendre, constater `retour` ; puis « Je veux commander le pack pro tout de suite, comment je paie ? », attendre, constater `achat`.
5. Côté VPS : aucun 23514 et aucune analyse en échec depuis le déploiement, `sudo docker compose logs --since 3h mba-worker | grep -E "23514|analyze-conversation"` ; la DLQ d'`analyze-conversation` est vide dans `/ops`.
6. Si la poussée vers le connecteur HubSpot est active sur l'espace d'essai : sur la fiche du contact dans le portail de test, « MM - Dernier intent » prend la valeur de chaque analyse, et `sudo docker logs --since 3h mm-hubspot-worker 2>&1 | grep -iE "error|4[0-9]{2}"` ne rend rien de lié à l'ingestion. Si elle n'est pas active, le dire : le connecteur est alors vérifié par lecture de son code (tâche 1), pas par l'essai.

Le lot est clos quand chacune des trois intentions a été vue UNE fois sur une vraie conversation. Si le modèle en classe une autrement (par exemple la commande en retard en `information` ou en `reclamation`), le lot n'est PAS clos : c'est une question de prompt à porter à Julien avec le champ `justification` de l'analyse, pas une raison de réécrire le message jusqu'à obtenir le bon verdict.

## Rayon de souffle

Repris du § 17 de la spec (« Les intentions (§ 7), et le connecteur HubSpot qui les reçoit ») et complété par la lecture du code :

- **Le chemin d'écriture de l'analyse** : `parseLlmOutput` (`src/analysis/engine.ts:88`) valide contre `INTENTS`, puis `analyzeConversation` (`src/analysis/analyzer.ts:30`), puis `analyzeConversationJob` (`src/analysis/job.ts:27`), puis `PgConversationAnalysisStore.save` (`src/analysis/store.pg.ts:98`), qui écrit sous le CHECK. C'est pourquoi la migration passe AVANT le `up`.
- **La relecture vers le connecteur** : `getStored` (`src/analysis/store.pg.ts:187`) caste `r.intent` vers l'union du schéma, `buildEvent` (`src/analysis/connector-push.ts:25`) l'étale dans `analysis`. Le connecteur HubSpot (`mm-hubspot`) la reçoit en `z.record` opaque, l'écrit dans une propriété TEXTE et l'affiche brute (tâche 1) : rien à changer. ⚠️ Son `src/ingest/event.ts` annonce un futur schéma zod strict (« bloc 5 ») : le jour où il est écrit, il doit accepter les neuf valeurs, et ce sera une COPIE de `INTENTS`, le connecteur n'important pas ce dépôt.
- **Le prompt** : plus long d'une douzaine de lignes, donc quelques centaines de jetons d'entrée de plus par analyse. La correction après sortie invalide (`analyzer.ts:36`) reprend le même système, inchangée.
- **La taxonomie change à une date** : les analyses passées ne sont pas reclassées, donc une période qui chevauche le déploiement mélange deux découpages (des conversations d'achat d'avant sont en `information` ou `autre`). `features.md` le dit. Une conversation ancienne qui reçoit un message APRÈS le déploiement est analysée à nouveau sur ses messages neufs, et cette analyse REMPLACE la ligne : ce n'est pas un reclassement du passé, c'est la mécanique d'upsert existante.
- **`AGREGAT_JOUR_SQL`** est lu par DEUX requêtes, `parJour` (lecture en direct) et `ecrireAgregats` (le balayage qui précède la purge) : les deux comptent les neuf valeurs d'un coup, puisqu'elles citent le même fragment. Les journées déjà agrégées gardent un `jsonb` à six clés, les suivantes en portent neuf ; aucun écran ne lit `analyse_jour.intentions` aujourd'hui. La garde `where excluded.conversations >= analyse_jour.conversations` n'est pas touchée.
- **Le contrat réseau de la synthèse** (`GET /tenants/:tenantId/stats/conversations`) gagne trois clés : l'ancienne console les ignore (fenêtre entre les étapes A et B : le tableau de détail y affiche la clé brute, `intentLabel` rendant la valeur inconnue telle quelle), la nouvelle tolère leur absence.
- **Le filtre `?intent=`** dérive de `INTENTS` ; `SENTIMENTS` et `ACTIONS` de `src/http/stats.ts`, comme les copies de la console dans `ConversationAnalysisCard.tsx`, restent des miroirs écrits à la main (hors lot, même risque le jour où ces listes bougeront).
- **`ContactHistoryPanel.tsx:241`** affiche la valeur BRUTE de l'intention quand le sujet est vide, comme il le fait déjà du sentiment et de `handledBy` : inchangé, `suivi_commande` y apparaîtra brut comme `demande_devis` aujourd'hui.
- **Fixtures** : `web/e2e/analyse-conversations-jours.spec.ts` et `web/e2e/analytics-quali-actionnable.spec.ts` servent une synthèse à six clés et restent valides grâce au repli ; `tests/http-stats-settings.test.ts` est mise au contrat (le `Record` l'impose) ; `tests/agregats-jour.test.ts` est réécrit en conservant son cas.
- **`web/lib/quali-export.ts`** ne nomme aucune intention (le libellé lui est injecté) : inchangé, mais l'export passe désormais par `libelleIntention`.
- **Ce qui ne bouge pas, vérifié** : `docs/aide/fiches/lire-mes-resultats.md` et `documentation.md` n'énumèrent pas les valeurs ; le serveur MCP n'expose pas l'intention ; `src/aide/recap.pg.ts` ne lit que le sujet ; `0155_analyse_jour.sql` dit « six valeurs » en commentaire, mais une migration appliquée ne se réécrit pas ; aucun fichier de câblage partagé n'est touché (`src/index.ts:1432` câble `getSummary` tel quel).
- **Le lot 6 (signaux sortants)** transporte `intent` tel quel (attribut `em_last_intent`, champ `intent` de `em_conversation_analyzed`) et sa section « Ce que nous remontons » renvoie aux valeurs de l'écran d'analyse sans les recopier : il ne doit pas en refaire une copie, ni côté serveur ni côté console.
- **`main` est partagé** : après le push de la tâche 2, n'importe quel déploiement de l'API par n'importe quelle session emporte ce code ; il doit suivre build, `migrate`, `up` (d'où l'annonce de la tâche 2).

## Déploiement

🔴 **L'ordre est API d'abord, console ensuite, et il ne se discute pas.** Avec l'ancienne API, la console neuve proposerait « Achat » dans le filtre de l'Analyse des conversations ; la route déployée ignore une valeur qu'elle ne connaît pas (`inSet`) et rendrait TOUTES les conversations sous un filtre « Achat » affiché. Les commits de la console ne peuvent pas « attendre » localement : l'arbre et la branche `main` sont partagés, le push d'une autre session les emporterait. C'est pourquoi les tâches 5 et 6 ne S'ÉCRIVENT qu'après l'étape A. Le connecteur HubSpot n'a RIEN à déployer avant (tâche 1, (b)).

**Étape A, après la tâche 4 : l'API.**

1. `gh run list --limit 5`, puis `gh run view <id> --json jobs` sur le run du dernier commit de code : `unit`, `integration`, `securite` en `success`, jamais le code de sortie de `gh run watch`.
2. Revérifier le connecteur HubSpot (tâche 1, étape 3) : inchangé.
3. `/revue-finale` : la garde de déploiement exige son attestation pour le `migrate` et le `up` par `ssh`.
4. Savoir ce qui part : sur le VPS `git -C /home/ubuntu/mba rev-parse HEAD`, puis en local `git log --oneline <ce sha>..origin/main`. Tout ce qui y figure part avec ce lot (y compris le travail d'autres sessions et leurs migrations) : l'annoncer aux sessions concernées avant de continuer.
5. Sur le VPS (`ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS`, adresse dans `brain/INFRA.md`) :
   ```bash
   cd /home/ubuntu/mba && git pull && sudo docker compose build mba-api
   sudo docker compose run --rm --no-deps mba-api sh -c 'ls db/migrations | tail -3'   # <N>_intentions_commerce.sql DANS l'image
   sudo docker compose run --rm --no-deps mba-api npm run migrate
   ```
6. Relire la base JUSTE APRÈS `migrate`, depuis le poste, en lecture seule :
   ```bash
   cd /c/Users/julie/messagingme-mba && npx tsx -e "import 'dotenv/config'; import { Pool } from 'pg'; import { pgSsl } from './src/db/ssl'; const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgSsl(), max: 1 }); p.query('select name, applied_at from public.schema_migrations order by name desc limit 3').then((r) => { console.log(JSON.stringify(r.rows)); return p.query(\"select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.conversation_analysis'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%intent%'\"); }).then((r) => { console.log(JSON.stringify(r.rows, null, 1)); return p.query('select intent, count(*)::int as n from public.conversation_analysis group by 1 order by 1'); }).then((r) => { console.log(JSON.stringify(r.rows)); return p.end(); });"
   ```
   Expected : `<N>_intentions_commerce.sql` dans `schema_migrations` avec son horodatage ; UN seul CHECK sur l'intention, `conversation_analysis_intent_check`, aux neuf valeurs ; la répartition identique à celle de la tâche 1 (aucune ligne n'a bougé). (`applied_at` est la colonne d'horodatage que `db/migrate.ts` crée.)
7. Basculer, puis contrôler les deux portes :
   ```bash
   sudo docker compose up -d --build
   until [ "$(sudo docker inspect -f '{{.State.Health.Status}}' mba-api)" = healthy ]; do sleep 2; done
   sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload
   sudo docker run --rm --network mcp-robot_default curlimages/curl -s -o /dev/null -w '%{http_code}\n' http://mba-api:8095/health
   curl -s -o /dev/null -w '%{http_code}\n' https://api.messagingme.app/health
   curl -s -o /dev/null -w '%{http_code}\n' https://mba.messagingme.app/api/backend/health
   ```
   Expected : `200` trois fois. Un 502 public avec un 200 interne : NPM tient l'ancienne adresse, refaire le `nginx -s reload`.
8. Sonde du chemin chaud PAR LE VRAI CODE, en lecture seule :
   ```bash
   cd /c/Users/julie/messagingme-mba && npx tsx -e "import 'dotenv/config'; import { Pool } from 'pg'; import { pgSsl } from './src/db/ssl'; import { PgConversationStatsStore } from './src/stats/conversation-stats.pg'; const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgSsl(), max: 1 }); const s = new PgConversationStatsStore(p, true, 90); p.query('select distinct tenant_id from public.conversation_analysis').then(async (r) => { for (const { tenant_id } of r.rows) console.log(tenant_id, JSON.stringify((await s.getSummary(tenant_id, { from: '2026-01-01', to: '2026-12-31' })).intent)); await p.end(); });"
   ```
   Expected : pour chaque espace, un objet à neuf clés, toutes des NOMBRES (les trois neuves à `0`), jamais `undefined` ni `null`.
9. `sudo docker compose logs --since 15m mba-worker | grep -E "23514|analyze-conversation"` : aucun 23514.
10. Mettre `CLAUDE.md` à jour (section Déploiement) : « **Dernière appliquée : <N>**, le <date> à <heure> UTC (`intentions_commerce`, le CHECK de l'intention élargi) », relue en base point par point (les faits de l'étape 6), et retirer ta phrase « ÉCRITE ET PAS ENCORE APPLIQUÉE : <N> ». Même précaution qu'à la tâche 2 : `git diff CLAUDE.md` ne doit montrer QUE ton changement, sinon attendre l'autre session. Puis `git commit --only CLAUDE.md` et `git push origin main`.

**Étape B, après la tâche 6 : la console.**

1. Tout est déjà vérifié en local à la tâche 6 (build, `tsc`, lint, vitest, e2e) : Vercel publie AU PUSH, avant que la CI ait fini, donc rien ne part sans ces vérifications locales.
2. `git log --oneline origin/main..HEAD` : savoir ce que le push emporte (l'arbre est partagé ; des commits d'autres sessions y figurent peut-être, les annoncer).
3. `/revue-finale` sur `git diff origin/main..HEAD -- web tests/intentions-parite.test.ts` (les tâches 5 et 6). Ce `git push` EST un déploiement (Vercel met en production la console refondue : deux écrans, le type réseau, les fixtures e2e), et la spec (§ 15) exige `/revue-finale` avant chaque déploiement. La garde de déploiement ne couvre PAS ce push (`pushDeploie` à `false`) : rien de mécanique ne rattrape l'oubli. Ne pousser qu'avec une revue finale sans 🔴 ; ses 🟡 se corrigent et se poussent APRÈS, relus par la revue suivante.
4. `git push origin main`.
5. `gh run list --limit 5` puis `gh run view <id> --json jobs` sur le run `ci-web` ET sur le run `ci` (des tests de la racine lisent `web/`) : tout en `success`.
6. Ouvrir `engageme.messagingme.app` : la carte « Conversations par intention » du Performance Lab et l'Analyse des conversations montrent les neuf intentions, le filtre les propose, rien n'affiche NaN.

**Étape C, après l'essai réel : la tâche 7** (documentation, `.md` seuls).
