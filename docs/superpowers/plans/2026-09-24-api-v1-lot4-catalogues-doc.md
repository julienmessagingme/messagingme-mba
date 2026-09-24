# API publique `/v1`, lot 4 : catalogues et documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** donner à un intégrateur de quoi construire un appel sans ouvrir la console (trois catalogues :
templates approuvés, scénarios publiés, messages RCS), et réécrire la page Developers > Documentation API
pour qu'elle décrive l'API des lots 1 à 3 sans pouvoir mentir sur un corps de requête, et sans nommer aucun
outil tiers.

**Architecture:** un module de routes `src/http/v1-catalogues.ts` (trois `GET`, trois fonctions PURES
exportées qui font tout le tri), monté dans l'entrée `v1` du registre, derrière la même clé d'API et le
droit `sends:create`. L'ouverture d'un scénario vient de `ouvertureApi` (lot 2), la fonction de
`/v1/sends` ; le statut et la catégorie d'un template viennent de `verdictModele` (lot 2), et ce que le
moteur refuserait avant de partir, de `carouselSendBlocker` et `headerMediaSendBlocker` : toujours les
fonctions de l'envoi, jamais une règle voisine. Deux lectures neuves en base (`PgWorkflowStore.listPublies`,
`PgTemplateHintStore.listerParEspace`), aucune migration. La page lit tous ses exemples, ses codes et ses
bornes dans `web/lib/api-exemples.ts`, un module de données SANS import, que `tests/api-exemples.test.ts`
passe aux validateurs des routes (leurs schémas zod et leurs règles de cible, exportés par la tâche 1).

**Tech Stack:** TypeScript, Fastify 5, zod 4 (`safeParse`), pg, Next 15 (console), vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md

---

## Global Constraints

### Préconditions (à vérifier AVANT la tâche 1, et bloquantes)

Ce lot CONSOMME les lots 1 à 3. Rien ne commence tant qu'ils ne sont pas sur `origin/main` :

```bash
cd /c/Users/julie/messagingme-mba && git fetch origin && \
for f in src/api/fiche.ts src/api/erreurs.ts src/api/contacts-v1.ts src/workflow/ouverture-api.ts \
         src/api/modele-envoi.ts src/api/suivi-envoi.ts src/api/variables.ts src/rcs/envoyer-libre.ts \
         src/http/v1-messages-rcs.ts; do \
  git cat-file -e "origin/main:$f" 2>/dev/null && echo "ok      $f" || echo "MANQUE  $f"; done
git grep -n -e "export type CodeApi" -e "export function refuser" -e "export const schemaClesFiche" \
  -e "export function ouvertureApi" -e "export type OuvertureApi" -e "export function verdictModele" \
  -e "export interface SuiviEnvoiApi" -e "export interface FicheApi" -e "export type ResultatFiche" \
  -e "export function destinataireAvecVariablesInterdites" -e "export type TypeDeCible" origin/main -- src
git grep -n "accepterVariables" origin/main -- src/crm/template.ts
git grep -n -e "'/v1/messages/whatsapp'" -e "'/v1/messages/rcs'" -e "rcsMessage" origin/main -- src/http
# Les refus de la GARDE COMMUNE portent leur code (lot 1, tâche 2 de son plan) : la page les documente.
git grep -n "tenant_locked" origin/main -- src/api/erreurs.ts
git grep -n "'unauthorized'" origin/main -- src/auth/api-key.ts src/api/usage-guard.ts
git grep -n "'missing_scope'" origin/main -- src/auth/api-key.ts
git grep -n "'rate_limited'" origin/main -- src/auth/api-key.ts src/api/usage-guard.ts
```

Attendu : un `ok` par fichier ; chaque symbole trouvé ; `accepterVariables` dans `src/crm/template.ts` (la
signature de `validateParamMapping` du lot 3) ; les deux routes et la cible `rcsMessage` ; `tenant_locked`
dans la table des codes ; `'unauthorized'` dans `api-key.ts` ET dans `usage-guard.ts`, `'missing_scope'` dans
`api-key.ts`, `'rate_limited'` dans `api-key.ts` ET dans `usage-guard.ts`. Un `MANQUE` ou une ligne vide
arrête le lot : il consommerait un contrat qui n'existe pas. 🔴 En particulier, si un code de la garde
manque, la page mentirait sur `unauthorized`, `missing_scope` ou `rate_limited` : le signaler à Julien comme
un manque du lot 1 (les refus de la garde commune portent un code), jamais le contourner ici.

### Ce que ce lot ne fait PAS

- **Aucune migration.** Les trois catalogues lisent des tables existantes (`template_param_hints` de 0025,
  `workflows`, `rcs_messages` de 0077). Contrôle : `ls db/migrations | tail -1` rend le même fichier au début
  et à la fin du lot.
- Aucun changement au serveur MCP, aux envois, aux contacts : les routes des lots 1 à 3 ne changent pas de
  comportement. La tâche 1 peut seulement EXPORTER ou NOMMER ce qui existe (voir sa règle).
- **Aucune section « Ce que nous remontons », aucun dictionnaire de signaux.** La spec (§ 12) les range dans
  le lot 6, et un lot ne consomme que ce qu'un lot PRÉCÉDENT produit : ce lot ne peut donc ni attendre le lot 6
  pour se clore, ni lui laisser une parité à écrire. Le plan du lot 6 (tâche 13) ajoute la section à la page
  de ce lot avec son propre module (`web/lib/signaux-dictionnaire.ts`, composant `DocSignaux`) et tient
  lui-même sa parité avec le dictionnaire du serveur (`tests/web-signaux-parite.test.ts`). Ce que le lot 6
  consomme d'ici : `web/app/developers/api/page.tsx` et `web/lib/api-exemples.ts`.
- **Aucun code d'erreur neuf (tranché ici).** Une panne de Meta pendant `GET /v1/templates` remonte au
  gestionnaire d'erreur global, donc en 5xx sans corps `{ error, code }` (et parfois la page d'erreur de
  l'hébergeur). Un code dédié, sous un statut que l'hébergeur ne réécrit pas (424 par exemple), élargirait le
  § 9 et `CodeApi` (lot 1) : c'est une décision de spec, hors de ce lot. La page dit donc l'exception dans sa
  section « Erreurs » au lieu d'affirmer que toute réponse d'échec porte un code.

### Conventions du dépôt, appliquées ici

- `safeParse`, jamais `parse`, jamais de `as` sur une entrée externe. Un jsonb relu pour partir vers un tiers
  repasse par le validateur d'écriture (`parseParamHints`).
- Le tenant vient de `req.auth.tenantId` (posé par la garde de clé d'API), jamais de l'URL ni du corps.
  `tenant_id = $1` sur CHAQUE requête SQL neuve.
- Tout refus rend `{ error, code }` par `refuser` (`src/api/erreurs.ts`, lot 1).
- Un compteur calculable n'est jamais recopié en prose dans `documentation.md` ou `features.md`.
- Rédaction en français, SANS tiret cadratin ni demi-cadratin (virgule, deux-points, parenthèses).
- 🔴 **La page de doc et `web/lib/api-exemples.ts` ne nomment AUCUN outil tiers**, ni dans le texte, ni dans
  les exemples, ni dans les commentaires. Identifiants d'exemple neutres (`crm-7781`). Le nom de l'outil du
  lot 6 n'existe que dans le lot 6 (écran de réglage et adaptateur). ⚠️ Le test du lot 6 relira ces deux
  fichiers avec un motif INSENSIBLE à la casse (`\b(batch|brevo|splio|sfmc|salesforce|hubspot|klaviyo|braze)\b`,
  après avoir retiré `contacts/batch`) : le mot « batch », quelle que soit sa casse, n'y apparaît donc que
  dans l'adresse `/v1/contacts/batch`, et la garde de ce lot le cherche de la même façon.

### Tests

- Unitaire : `npx vitest run <fichier>`. Typage : `npm run typecheck` (racine : `src`, `tests`, `db`,
  `scripts`, et `web/lib/api-exemples.ts` par import). Suite : `npm test`.
- Console : `cd web && npx tsc --noEmit && npm run lint`.
- 🔴 **Les tests d'intégration ne se lancent JAMAIS en local** : le `DATABASE_URL` local est la PRODUCTION.
  Ils s'écrivent, et leur verdict se lit sur le run GitHub, job par job :
  `gh run list --limit 5` puis `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'`. Jamais le
  code de sortie de `gh run watch` (il a rendu 0 sur un run en échec le 2026-09-07).
- **Un test de non-régression se vérifie DANS LES DEUX SENS** : remettre le code fautif, voir l'échec ET son
  symptôme, restaurer, revoir le vert. Chaque mutation d'une garde (droit, tenant) s'ANNONCE aux autres
  sessions avant, et sa restauration se vérifie par `git diff <fichier>` (le diff ne doit porter que les
  lignes du lot).
- Le typecheck et les tests de l'ARBRE peuvent porter le travail d'une autre session : devant une erreur,
  lister les fichiers en cause et vérifier qu'ils sont dans le périmètre du lot avant de conclure.

### Commits (arbre et index partagés par plusieurs sessions)

- 🔴 **Les lots 1 et 2 commitent en PLOMBERIE** (procédure P du lot 1), qui ne fait JAMAIS avancer le `main`
  local : quand ce lot commence, le `main` local est en retard sur `origin/main`, et un « commit ordinaire »
  (`--only` puis `git push origin main`) se poserait sur une base périmée et serait refusé au push, ou
  pousserait les commits locaux non poussés d'une autre session. Contrôle au début de chaque commit :
  `git fetch -q origin && test "$(git rev-parse main)" = "$(git rev-parse origin/main)"`. S'il échoue (le cas
  attendu après les lots 1 à 3), TOUT commit de ce lot passe par la procédure P ci-dessous, avec les mêmes
  chemins et le même message que la commande `--only` écrite dans la tâche, qui ne sert alors plus qu'à les
  donner. Jamais `git pull`, `git merge` ni `git reset` dans l'arbre partagé pour « rattraper » `main`.
- **Commit ordinaire** : relire `git diff -- <chemins>` DANS LE MÊME APPEL que le commit, chercher la ligne
  étrangère (pas seulement le fichier étranger), puis
  `git commit --only <chemins> -m "<sujet>" -m "<corps>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`
  et `git push origin main`. Un fichier NEUF se déclare d'abord par `git add -N <fichier>` (`--only` refuse un
  chemin inconnu de git). Jamais `git add` puis `git commit` nu. Si le hook `rayon-de-souffle` refuse le
  premier commit, RELIRE le diff avant de relancer.
- **Procédure P, commit par plomberie** (OBLIGATOIRE pour `src/server.ts` et `src/index.ts`, et pour tout
  fichier dont le diff porte une ligne d'une autre session).

  🔴 **L'état du shell ne survit PAS d'un appel à l'autre**, et la procédure en compte quatre (l'outil Edit
  s'intercale). Donc : un dossier de travail FIXE, écrit EN TOUTES LETTRES dans chaque appel
  (`C:/Users/julie/AppData/Local/Temp/mba-lot4-procP`, hors du dépôt ; le scratchpad de la session convient
  aussi, à condition d'être écrit en entier et identique dans les quatre appels) ; ce qui doit passer d'un
  appel au suivant est écrit dans un FICHIER de ce dossier ; `set -e` en tête de chaque appel ; et
  `GIT_INDEX_FILE` posé DEVANT chaque commande git qui lit ou écrit l'index, jamais par `export`. Un
  `git read-tree origin/main` lancé sans lui réécrirait l'INDEX PARTAGÉ et effacerait le travail indexé des
  autres sessions.

  **Appel 1, extraction** (une ligne `git show` par fichier PARTAGÉ) :

```bash
set -e
cd /c/Users/julie/messagingme-mba
git fetch origin
rm -rf C:/Users/julie/AppData/Local/Temp/mba-lot4-procP
mkdir -p C:/Users/julie/AppData/Local/Temp/mba-lot4-procP
git rev-parse origin/main > C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/base-origin
git show origin/main:<chemin du fichier partagé> > C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/<nom>
```

  **Appel 2, outil Edit sur chaque copie** : y rejouer MES éditions, avec les mêmes `old_string` /
  `new_string` que dans l'arbre, et rien d'autre.

  **Appel 3, l'arbre du commit, à RELIRE** (une ligne `update-index` par fichier ; blob d'un fichier partagé =
  sa copie éditée, blob d'un fichier que personne d'autre ne touche, diff relu = le fichier de l'arbre) :

```bash
set -e
cd /c/Users/julie/messagingme-mba
GIT_INDEX_FILE=C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/index git read-tree "$(cat C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/base-origin)"
GIT_INDEX_FILE=C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/index git update-index --add --cacheinfo "100644,$(git hash-object -w C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/<nom>),<chemin du fichier partagé>"
GIT_INDEX_FILE=C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/index git update-index --add --cacheinfo "100644,$(git hash-object -w <chemin d'un fichier non partagé>),<chemin d'un fichier non partagé>"
GIT_INDEX_FILE=C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/index git diff --cached "$(cat C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/base-origin)" --stat
GIT_INDEX_FILE=C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/index git diff --cached "$(cat C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/base-origin)"
set -o pipefail
GIT_INDEX_FILE=C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/index git diff --cached "$(cat C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/base-origin)" | gitleaks stdin --no-banner
GIT_INDEX_FILE=C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/index git write-tree > C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/tree
```

  ⚠️ `commit-tree` (appel 4) ne déclenche aucun hook : `gitleaks` est lancé ici, sur EXACTEMENT ce qui part
  (comme au lot 1), et `set -e` arrête l'appel avant `write-tree` s'il trouve un secret.

  Relire la sortie : `--stat` ne liste QUE mes chemins, et le diff ne porte aucune ligne étrangère. Sinon,
  s'arrêter là (rien n'est encore écrit hors du dossier de travail, hormis des blobs inertes).

  **Appel 4, commit et poussée** :

```bash
set -e
cd /c/Users/julie/messagingme-mba
BASE_ORIGIN="$(cat C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/base-origin)"
COMMIT="$(git commit-tree "$(cat C:/Users/julie/AppData/Local/Temp/mba-lot4-procP/tree)" -p "$BASE_ORIGIN" -m "<sujet>" -m "<corps>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")"
# Refusé (non fast-forward) si origin a bougé depuis l'appel 1 : recommencer à l'appel 1, jamais forcer.
git push origin "$COMMIT":main
```

  Le `main` LOCAL n'est jamais avancé (ni `update-ref`, ni `reset`) : même règle que les lots 1, 2 et 6, l'arbre
  et l'index sont partagés avec d'autres sessions.

- **Trois annonces** (ListAgents, puis SendMessage à chaque session locale active sur ce dossier) : avant
  d'éditer `src/server.ts` ou `src/index.ts`, avant de muter une garde, avant une suite e2e. Et après chaque
  poussée : les fichiers communs touchés.
- Tout sur `main`, pas de branche, pas de worktree.

---

## Carte des fichiers

| Fichier | Rôle | Tâche |
|---|---|---|
| `src/http/v1-contacts.ts`, `src/http/v1-sends.ts`, `src/http/v1-messages.ts`, `src/http/v1-messages-rcs.ts` | exporter les validateurs, les règles de cible, le type du rapport et les bornes (aucun comportement) | 1 |
| `tests/api-validateurs.test.ts` (neuf) | les validateurs existent, sont des schémas zod, et ne sont pas permissifs | 1 |
| `src/workflow/store.pg.ts` | `ScenarioPublie`, `listPublies` | 2 |
| `src/crm/template-hints.pg.ts` | `IndiceDuTemplate`, `listerParEspace` | 2 |
| `tests/integration/v1-catalogues.integration.test.ts` (neuf) | les deux lectures, en CI | 2 |
| `src/api/usage-guard.ts` | l'opération `catalogues.read` | 3 |
| `src/http/v1-catalogues.ts` (neuf) | les trois routes et leurs trois fonctions pures | 3 |
| `tests/v1-catalogues.test.ts` (neuf) | tri, parité d'ouverture, garde, isolation, comptage | 3, 4 |
| `src/server.ts`, `src/index.ts` | câblage (procédure P) | 4 |
| `web/lib/api-exemples.ts` (neuf) | exemples, codes, bornes | 5 |
| `tests/api-exemples.test.ts` (neuf) | exemples passés aux validateurs, réponses typées par leurs producteurs, parités, aucun outil tiers | 5, 7 |
| `web/app/developers/api/page.tsx` | la page réécrite | 7 |
| `web/e2e/developers-api.spec.ts` (neuf) | la page rendue | 7 |
| `features.md`, `documentation.md` (`todo.md` relu seulement) | doc du lot | 8 |

---

### Task 1: Nommer et exporter les validateurs des corps `/v1` (précondition du test des exemples)

La spec (§ 10) veut un test qui passe chaque exemple de la page « aux validateurs des routes ». Le contrat
inter-lots ne nomme que `schemaClesFiche` : cette tâche fixe les autres noms, et n'a le droit que
d'EXPORTER ou de NOMMER ce qui existe. Aucune règle de validation ne bouge.

⚠️ Aujourd'hui (`260ba2c6`), `/v1/sends` ne valide pas son corps par zod (`req.body as {...}` et `isObj`,
`src/http/v1-sends.ts:104`) : cette tâche suppose donc les routes RÉÉCRITES par les lots 1 à 3. La colonne
« Source attendue » de la table ci-dessous vient de leurs plans (`docs/superpowers/plans/2026-09-24-api-v1-lot1-*`,
`-lot2-*`, `-lot3-*`) ; l'étape 3 la vérifie dans le code réellement poussé, qui fait foi.

**Files:**
- Create: `tests/api-validateurs.test.ts`
- Modify (seulement si un symbole manque) : `src/http/v1-contacts.ts`, `src/http/v1-sends.ts`,
  `src/http/v1-messages.ts`, `src/http/v1-messages-rcs.ts` (routes réécrites par les lots 1 à 3 : se repérer
  aux symboles de la table, jamais à un numéro de ligne relevé avant eux)

**Interfaces:**
- Consumes : `schemaClesFiche` (`src/api/fiche.ts`, lot 1).
- Produces (noms fixés par ce lot, employés tels quels par les tâches 5 et 7, tous exportés par le fichier
  de la ROUTE, que les tests importent) :

| Symbole | Fichier | Ce qu'il valide ou décrit | Source attendue (plans des lots 1 à 3) |
|---|---|---|---|
| `schemaCorpsContact` | `src/http/v1-contacts.ts` | le corps de `POST /v1/contacts`, et chaque élément de `/batch` | alias de `schemaContactV1` (`src/api/contacts-v1.ts`) |
| `schemaCorpsLot` | `src/http/v1-contacts.ts` | le conteneur de `POST /v1/contacts/batch` | alias de `conteneurDuLot` |
| `MAX_BATCH` | `src/http/v1-contacts.ts` | 500 éléments par lot | `const MAX_BATCH`, `export` ajouté |
| `schemaCorpsRecherche` | `src/http/v1-contacts.ts` | `POST /v1/contacts/search` | alias de `schemaRechercheContactV1` (`src/api/contacts-v1.ts`) |
| `schemaCorpsModification` | `src/http/v1-contacts.ts` | `PATCH /v1/contacts/{contactId}` | alias de `schemaPatchContactV1` (`src/api/contacts-v1.ts`) |
| `schemaCorpsEnvoi` | `src/http/v1-sends.ts` | l'enveloppe de `POST /v1/sends` | alias de `schemaCorps` |
| `schemaDestinataireEnvoi` | `src/http/v1-sends.ts` | un élément de `recipients` (écarté s'il est mal formé, sans faire tomber l'envoi) | alias de `schemaDestinataire` (qui porte `variables` depuis le lot 3) |
| `lireCible` | `src/http/v1-sends.ts` | les règles de cible du corps : `category` refusée sur un template, requise ailleurs ; `params` hors template | `function lireCible(corps, params)`, `export` ajouté |
| `RapportEnvoi` | `src/http/v1-sends.ts` | la réponse 201 de `POST /v1/sends` | `interface RapportEnvoi`, `export` ajouté |
| `MAX_RECIPIENTS`, `MAX_SKIPPED_REPORT` | `src/http/v1-sends.ts` | 50 destinataires, 200 écarts détaillés | `const`, `export` ajouté |
| `schemaMessageWhatsapp` | `src/http/v1-messages.ts` | `POST /v1/messages/whatsapp` | alias de `schemaMessage` |
| `schemaMessageRcs` | `src/http/v1-messages-rcs.ts` | `POST /v1/messages/rcs` | `const schemaMessageRcs`, `export` ajouté |

- [ ] **Step 1: Écrire le test qui exige ces symboles**

```ts
// tests/api-validateurs.test.ts
import { describe, it, expect } from 'vitest';
import { schemaClesFiche } from '../src/api/fiche';
import {
  schemaCorpsContact, schemaCorpsLot, schemaCorpsRecherche, schemaCorpsModification, MAX_BATCH,
} from '../src/http/v1-contacts';
import {
  schemaCorpsEnvoi, schemaDestinataireEnvoi, lireCible, MAX_RECIPIENTS, MAX_SKIPPED_REPORT, type RapportEnvoi,
} from '../src/http/v1-sends';
import { schemaMessageWhatsapp } from '../src/http/v1-messages';
import { schemaMessageRcs } from '../src/http/v1-messages-rcs';

/**
 * LES VALIDATEURS DES CORPS /v1 SONT NOMMÉS ET EXPORTÉS.
 *
 * 🔴 ILS EXISTENT POUR ÊTRE INTERROGÉS DE L'EXTÉRIEUR : `tests/api-exemples.test.ts` leur soumet chaque
 * exemple de la page Documentation API. Une route qui validerait par un schéma anonyme, écrit dans son
 * handler, rendrait ce contrôle impossible, et la page pourrait de nouveau décrire un corps que le serveur
 * refuse (elle l'a fait : `optIn`, des destinataires en chaînes, `/v1/messages` sans accents).
 *
 * ⚠️ Le typage est volontairement LARGE (un `safeParse` qui rend `success`) : ce fichier vérifie qu'ils
 * existent et qu'ils refusent quelque chose, pas ce qu'ils acceptent. Ce qu'ils acceptent, ce sont les
 * exemples de la documentation qui le prouvent.
 */
const SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
  schemaClesFiche,
  schemaCorpsContact,
  schemaCorpsLot,
  schemaCorpsRecherche,
  schemaCorpsModification,
  schemaCorpsEnvoi,
  schemaDestinataireEnvoi,
  schemaMessageWhatsapp,
  schemaMessageRcs,
};

describe('les validateurs des corps de l’API publique', () => {
  it.each(Object.entries(SCHEMAS))('%s est un schéma zod', (_nom, schema) => {
    expect(typeof schema.safeParse).toBe('function');
  });

  it('🔴 aucun n’accepte n’importe quoi : une chaîne nue est refusée partout', () => {
    // La garde de la garde : un `z.unknown()` passerait tous les exemples et ne prouverait rien.
    for (const [nom, schema] of Object.entries(SCHEMAS)) {
      expect(schema.safeParse('texte').success, nom).toBe(false);
    }
  });

  it('les règles de cible de l’envoi sont une fonction exportée', () => {
    expect(typeof lireCible).toBe('function');
  });

  it('le rapport de POST /v1/sends est un type exporté (tenu au typage)', () => {
    const rapport: RapportEnvoi | null = null;
    expect(rapport).toBeNull();
  });

  it('les bornes de lot sont des entiers positifs', () => {
    for (const n of [MAX_BATCH, MAX_RECIPIENTS, MAX_SKIPPED_REPORT]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Le lancer**

Run: `npm run typecheck`
Attendu tant qu'un symbole manque : échec en `TS2305` pour chacun, du type
`error TS2305: Module '"../src/http/v1-sends"' has no exported member 'MAX_RECIPIENTS'.`
(ou `TS2307` si `src/http/v1-messages-rcs.ts` n'existe pas : c'est alors une précondition du lot 3 qui manque,
et le lot s'arrête).

Run: `npx vitest run tests/api-validateurs.test.ts`
Attendu en même temps : FAIL, mais PAS au chargement. Sous vitest, un export nommé absent d'un module
TypeScript vaut `undefined` : le test échoue en `TypeError: Cannot read properties of undefined (reading
'safeParse')`, ou sur une borne (`expected false to be true` pour `Number.isInteger(undefined)`). Seul le
typecheck NOMME le symbole manquant.
Si les deux commandes passent déjà, les lots 1 à 3 ont exporté sous ces noms : aller à l'étape 5.

- [ ] **Step 3: Trouver où vit chaque validateur**

```bash
cd /c/Users/julie/messagingme-mba && \
grep -n "safeParse(" src/http/v1-contacts.ts src/http/v1-sends.ts src/http/v1-messages.ts src/http/v1-messages-rcs.ts ; \
grep -n "schemaContactV1\|schemaRechercheContactV1\|schemaPatchContactV1\|conteneurDuLot" src/http/v1-contacts.ts src/api/contacts-v1.ts ; \
grep -n "const schemaCorps\b\|const schemaDestinataire\b\|function lireCible\|interface RapportEnvoi" src/http/v1-sends.ts ; \
grep -n "const schemaMessage\b" src/http/v1-messages.ts ; \
grep -n "const schemaMessageRcs\b" src/http/v1-messages-rcs.ts ; \
grep -n "MAX_BATCH\|MAX_RECIPIENTS\|MAX_SKIPPED_REPORT" src/http/v1-contacts.ts src/http/v1-sends.ts
```

Chaque ligne de la table doit y trouver sa source. Une source introuvable sous le nom attendu se cherche par
ce qu'elle fait (le `safeParse(req.body)` du handler, le `safeParse(brut)` d'un élément), puis on applique la
règle de l'étape 4 qui correspond.

- [ ] **Step 4: Nommer et exporter, sans rien changer d'autre**

Pour chaque symbole absent, la règle qui s'applique :
1. **Le symbole existe sous CE nom dans le fichier de la route, non exporté** : ajouter `export ` devant, sans
   rien toucher d'autre (`export const MAX_BATCH = 500;`, `export const MAX_RECIPIENTS = 50;`,
   `export const MAX_SKIPPED_REPORT = 200;`, `export function lireCible(`, `export interface RapportEnvoi {`,
   `export const schemaMessageRcs = z.strictObject({`).
2. **Le schéma existe sous un AUTRE nom, dans le fichier de la route OU dans un autre fichier** : ne RIEN
   renommer ni déplacer. Ajouter dans le fichier de la ROUTE, juste au-dessus de `export function register...`,
   un alias exporté, avec son import s'il manque. Les tests importent depuis la route. Renommer toucherait des
   importeurs, et un schéma de `src/api/` peut être partagé avec d'autres chemins (spec § 17 : le webhook
   entrant et l'import de listes). D'après les plans des lots 1 à 3 :

```ts
// src/http/v1-contacts.ts
/** Les validateurs de ces routes, sous les noms que la documentation de l'API éprouve (`tests/api-exemples.test.ts`). */
export const schemaCorpsContact = schemaContactV1;
export const schemaCorpsLot = conteneurDuLot;
export const schemaCorpsRecherche = schemaRechercheContactV1;
export const schemaCorpsModification = schemaPatchContactV1;
```

```ts
// src/http/v1-sends.ts
/** Les validateurs de cette route, sous les noms que la documentation de l'API éprouve (`tests/api-exemples.test.ts`). */
export const schemaCorpsEnvoi = schemaCorps;
export const schemaDestinataireEnvoi = schemaDestinataire;
```

```ts
// src/http/v1-messages.ts
/** Le validateur de cette route, sous le nom que la documentation de l'API éprouve (`tests/api-exemples.test.ts`). */
export const schemaMessageWhatsapp = schemaMessage;
```

   (`schemaContactV1`, `schemaRechercheContactV1` et `schemaPatchContactV1` viennent de `src/api/contacts-v1.ts` :
   compléter l'import existant de la route, `import { ..., schemaContactV1, schemaRechercheContactV1,
   schemaPatchContactV1 } from '../api/contacts-v1';`, si l'un y manque.) Un nom source différent de celui
   des plans se reporte tel quel à droite du `=`.
3. **Le schéma est écrit DANS le handler** (`z.object({...}).safeParse(req.body)`) : déplacer l'expression
   telle quelle juste au-dessus de `export function register...` sous la forme
   `export const <nom> = z.object({...});`, et le handler appelle `<nom>.safeParse(req.body)`.
4. 🔴 **Une route qui ne valide PAS son corps par un schéma zod** : ARRÊTER le lot et le signaler à Julien.
   La spec (§ 10) suppose ce validateur ; l'écrire ici déborderait du lot 4 sur un chemin d'envoi.
5. **La signature de `lireCible` n'est plus `(corps, params)`** : ne pas la changer ; la tâche 5 appelle
   `lireCible` avec la signature de la route (c'est la route qui fait foi), et l'écart se note dans le message
   de commit.

Contrôle d'innocuité, qui doit rester vert à l'identique :

Run: `npm run typecheck && npx vitest run tests/v1-`
(le filtre prend tous les fichiers `tests/v1-*.test.ts` : ils doivent passer exactement comme avant).

- [ ] **Step 5: Voir passer**

Run: `npm run typecheck && npx vitest run tests/api-validateurs.test.ts`
Expected: PASS (chaque schéma, la garde de la garde, `lireCible`, le type du rapport, les bornes).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/julie/messagingme-mba && git add -N tests/api-validateurs.test.ts && \
git diff -- tests/api-validateurs.test.ts src/http/v1-contacts.ts src/http/v1-sends.ts src/http/v1-messages.ts src/http/v1-messages-rcs.ts && \
git commit --only tests/api-validateurs.test.ts src/http/v1-contacts.ts src/http/v1-sends.ts src/http/v1-messages.ts src/http/v1-messages-rcs.ts \
  -m "refactor(api): les validateurs des corps /v1 sont nommes et exportes" \
  -m "Aucune regle ne bouge : export et alias seulement (aucun renommage), pour que le test des exemples de la documentation puisse leur soumettre chaque corps." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

(Ne lister dans `--only` que les fichiers réellement modifiés à l'étape 4 : un chemin inchangé est inoffensif,
mais un chemin qu'une AUTRE session a modifié emporterait son travail. Le diff relu le dit.)

---

### Task 2: Les deux lectures en base (scénarios en ligne, indices de variables de l'espace)

**Files:**
- Modify: `src/workflow/store.pg.ts` (ajout avant `async list(tenantId: string)`, ligne 209 aujourd'hui)
- Modify: `src/crm/template-hints.pg.ts` (ajout après la fin de `get`, ligne 47 à 48 aujourd'hui)
- Create: `tests/integration/v1-catalogues.integration.test.ts`

**Interfaces:**
- Produces :
  - `export interface ScenarioPublie { code: string | null; name: string; publishedAt: string | null; graph: WorkflowGraph }` (`src/workflow/store.pg.ts`)
  - `PgWorkflowStore.listPublies(tenantId: string): Promise<ScenarioPublie[]>`
  - `export interface IndiceDuTemplate extends ParamHint { name: string; language: string }` (`src/crm/template-hints.pg.ts`)
  - `PgTemplateHintStore.listerParEspace(tenantId: string): Promise<IndiceDuTemplate[]>`

- [ ] **Step 1: Écrire le test d'intégration (il ne tournera qu'en CI)**

```ts
// tests/integration/v1-catalogues.integration.test.ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowStore } from '../../src/workflow/store.pg';
import { PgTemplateHintStore } from '../../src/crm/template-hints.pg';
import type { WorkflowGraph } from '../../src/workflow/graph';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES DEUX LECTURES DES CATALOGUES DE L'API PUBLIQUE (lot 4).
 *
 * 🔴 CE QUI SE PROUVE ICI EST DANS LE SQL : « publié » veut dire « le graphe PUBLIÉ porte au moins un
 * bloc », jamais « un brouillon existe » ; et chaque ligne rendue appartient à l'espace demandé. Un faux
 * store rendrait ce qu'on lui fait rendre.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('les lectures des catalogues de l’API publique (Postgres)', () => {
  let pool: Pool;
  let espaceA = '';
  let espaceB = '';
  const graphe: WorkflowGraph = {
    nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }],
    edges: [],
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    espaceA = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-catalogues-a') returning id`)).rows[0]!.id;
    espaceB = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-catalogues-b') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[espaceA, espaceB].filter((x) => x !== '')]);
    await pool.end();
  });

  it('🔴 listPublies : seuls les scénarios EN LIGNE de CET espace, triés par nom', async () => {
    const store = new PgWorkflowStore(pool);
    // Jamais publié : le graphe part en brouillon, le publié reste vide. Un envoi n'aurait rien à jouer.
    await store.insert(espaceA, 'b-brouillon-seul', graphe);
    const enLigne = await store.insert(espaceA, 'a-en-ligne', graphe);
    await store.publish(enLigne.id, espaceA);
    const ailleurs = await store.insert(espaceB, 'c-autre-espace', graphe);
    await store.publish(ailleurs.id, espaceB);

    const lignes = await store.listPublies(espaceA);
    expect(lignes.map((l) => l.name)).toEqual(['a-en-ligne']);
    expect(lignes[0]!.graph.nodes).toHaveLength(1);
    expect(lignes[0]!.publishedAt).not.toBeNull();
    expect(lignes[0]!.code).toMatch(/^scn_/);
  });

  it('🔴 listPublies lit le PUBLIÉ : un brouillon posé par-dessus ne change rien', async () => {
    const store = new PgWorkflowStore(pool);
    const s = await store.insert(espaceA, 'd-en-ligne-avec-brouillon', graphe);
    await store.publish(s.id, espaceA);
    // Un brouillon VIDE : si la lecture prenait le brouillon, le scénario disparaîtrait du catalogue.
    await store.update(s.id, espaceA, { graph: { nodes: [], edges: [] } });
    const ligne = (await store.listPublies(espaceA)).find((l) => l.name === 'd-en-ligne-avec-brouillon');
    expect(ligne?.graph.nodes).toHaveLength(1);
  });

  it('🔴 listerParEspace : tous les indices de l’espace, triés, et aucun d’un autre espace', async () => {
    const indices = new PgTemplateHintStore(pool);
    await indices.save(espaceA, 'confirmation', 'fr', [{ position: 1, source: { type: 'field', key: 'prenom' } }]);
    await indices.save(espaceA, 'confirmation', 'en', [{ position: 2, source: { type: 'attribute', key: 'name' } }]);
    await indices.save(espaceB, 'confirmation', 'fr', [{ position: 1, source: { type: 'literal', value: 'ne doit pas sortir' } }]);

    expect(await indices.listerParEspace(espaceA)).toEqual([
      { name: 'confirmation', language: 'en', position: 2, source: { type: 'attribute', key: 'name' } },
      { name: 'confirmation', language: 'fr', position: 1, source: { type: 'field', key: 'prenom' } },
    ]);
  });
});
```

- [ ] **Step 2: Le voir échouer (au typage, puisqu'il ne tourne pas en local)**

Run: `npm run typecheck`
Expected: FAIL, `error TS2339: Property 'listPublies' does not exist on type 'PgWorkflowStore'` et
`Property 'listerParEspace' does not exist on type 'PgTemplateHintStore'`.

- [ ] **Step 3: `ScenarioPublie` et `listPublies`**

Dans `src/workflow/store.pg.ts`, remplacer `  async list(tenantId: string): Promise<WorkflowRow[]> {` par :

```ts
  /**
   * Les scénarios EN LIGNE, pour le catalogue de l'API publique (`GET /v1/scenarios`).
   *
   * 🔴 « EN LIGNE » VEUT DIRE : LE GRAPHE PUBLIÉ PORTE AU MOINS UN BLOC. Un scénario neuf part en brouillon
   * avec un publié VIDE (`insert`), et un envoi joue le publié : l'annoncer ferait construire à un
   * intégrateur un appel qui ne peut rien jouer. `published_at` ne décide PAS : il vaut null sur les
   * scénarios mis en ligne avant 0095, qui tournent pourtant.
   *
   * ⚠️ Le graphe est transporté parce que l'ouverture se calcule dessus (`ouvertureApi`, lot 2), comme
   * `listResume` le fait pour la console. Il ne sort pas vers l'intégrateur : la route n'en rend que
   * l'ouverture.
   */
  async listPublies(tenantId: string): Promise<ScenarioPublie[]> {
    const res = await this.pool.query<{ code: string | null; name: string; published_at: Date | null; graph: WorkflowGraph }>(
      `select code, name, published_at, graph
         from workflows
        where tenant_id = $1
          and jsonb_array_length(coalesce(graph->'nodes', '[]'::jsonb)) > 0
        order by name, created_at`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      code: r.code,
      name: r.name,
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      graph: r.graph,
    }));
  }

  async list(tenantId: string): Promise<WorkflowRow[]> {
```

Et, juste avant `export interface WorkflowRow {` :

```ts
/** Un scénario EN LIGNE tel que le catalogue de l'API publique le lit : le graphe PUBLIÉ, jamais le brouillon. */
export interface ScenarioPublie {
  code: string | null;
  name: string;
  /** null = mis en ligne avant que la date soit suivie (0095), pas « jamais publié ». */
  publishedAt: string | null;
  graph: WorkflowGraph;
}

```

- [ ] **Step 4: `IndiceDuTemplate` et `listerParEspace`**

Dans `src/crm/template-hints.pg.ts` (lignes 5 à 8 aujourd'hui), remplacer :

```ts
export interface ParamHint {
  position: number;
  source: ParamSource;
}
```

par :

```ts
export interface ParamHint {
  position: number;
  source: ParamSource;
}

/** Un indice de l'espace, avec le template qui le porte : ce que le catalogue de l'API publique lit en UNE fois. */
export interface IndiceDuTemplate extends ParamHint {
  name: string;
  language: string;
}
```

Puis remplacer :

```ts
    return res.rows.map((r) => ({ position: r.position, source: r.source }));
  }
```

par :

```ts
    return res.rows.map((r) => ({ position: r.position, source: r.source }));
  }

  /**
   * TOUS les indices de l'espace, en UNE requête, pour `GET /v1/templates`.
   *
   * ⚠️ UNE requête et pas une par template : le catalogue liste tous les templates approuvés du WABA, et
   * `get` appelé en boucle ferait autant d'allers-retours. La clé primaire commence par `tenant_id`, elle
   * sert donc ce filtre. La source sort telle que stockée : c'est la ROUTE qui la revalide avant de la
   * rendre à un tiers.
   */
  async listerParEspace(tenantId: string): Promise<IndiceDuTemplate[]> {
    const res = await this.pool.query<{ template_name: string; template_language: string; position: number; source: ParamSource }>(
      `select template_name, template_language, position, source from template_param_hints
       where tenant_id = $1 order by template_name, template_language, position`,
      [tenantId],
    );
    return res.rows.map((r) => ({ name: r.template_name, language: r.template_language, position: r.position, source: r.source }));
  }
```

- [ ] **Step 5: Voir passer le typage**

Run: `npm run typecheck`
Expected: PASS (aucune erreur dans `src/workflow/store.pg.ts`, `src/crm/template-hints.pg.ts`,
`tests/integration/v1-catalogues.integration.test.ts`).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/julie/messagingme-mba && git add -N tests/integration/v1-catalogues.integration.test.ts && \
git diff -- src/workflow/store.pg.ts src/crm/template-hints.pg.ts tests/integration/v1-catalogues.integration.test.ts && \
git commit --only src/workflow/store.pg.ts src/crm/template-hints.pg.ts tests/integration/v1-catalogues.integration.test.ts \
  -m "feat(api): lectures des catalogues, scenarios en ligne et indices de variables de l espace" \
  -m "Publie veut dire : le graphe PUBLIE porte au moins un bloc. Une requete par espace pour les indices." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

Le verdict des trois cas se lit sur le job `integration` du run déclenché (`gh run view <id> --json jobs`).

---

### Task 3: Le module des catalogues (`src/http/v1-catalogues.ts`)

**Files:**
- Modify: `src/api/usage-guard.ts` (union `OperationApi`, lignes 23 à 32 aujourd'hui)
- Create: `src/http/v1-catalogues.ts`
- Create: `tests/v1-catalogues.test.ts`

**Interfaces:**
- Consumes : `refuser` (`src/api/erreurs.ts`, lot 1) ; `ouvertureApi`, `OuvertureApi`
  (`src/workflow/ouverture-api.ts`, lot 2) ; `verdictModele(info: ModeleLu | null, langue: string): LectureModele`
  (`src/api/modele-envoi.ts`, lot 2 : le statut et la catégorie d'un template tels que `POST /v1/sends` les
  lit) ; `carouselSendBlocker(cards: OutboundCarouselCard[]): string | null` et
  `headerMediaSendBlocker(headerFormat: string | undefined, mediaId: string | undefined): string | null`
  (`src/meta/template-components.ts:82` et `:106`, ce que le moteur d'envoi refuse avant de partir) ;
  `ScenarioPublie`, `IndiceDuTemplate` (tâche 2) ; `countTemplateVariables`, `parseParamHints`, `ParamSource`
  (`src/crm/template.ts`) ; `variablesDe` (`src/rcs/variables.ts`) ; `TemplateSummary` (`src/meta/templates.ts`) ;
  `compterOuRefuser`, `ApiUsageGuard` (`src/api/usage-guard.ts`).
- Produces :

```ts
export type EnteteTemplate = 'none' | 'text' | 'image' | 'video' | 'document';
export interface VariableDeTemplate { position: number; source: ParamSource | null }
export interface TemplateCatalogue { name: string; language: string; category: 'marketing' | 'utility'; header: EnteteTemplate; variables: VariableDeTemplate[] }
export interface ScenarioCatalogue { code: string | null; name: string; opening: OuvertureApi | null; publishedAt: string | null }
export interface MessageRcsCatalogue { name: string; kind: RcsOutbound['kind']; variables: string[] }
export function catalogueTemplates(templates: readonly TemplateSummary[], indices: readonly IndiceDuTemplate[]): TemplateCatalogue[]
export function catalogueScenarios(lignes: readonly ScenarioPublie[]): ScenarioCatalogue[]
export function catalogueMessagesRcs(messages: ReadonlyArray<{ name: string; content: RcsOutbound | null }>): MessageRcsCatalogue[]
export interface V1CataloguesRouteDeps { usage: ApiUsageGuard; templates(tenantId: string): Promise<TemplateSummary[]>; indicesDeVariables(tenantId: string): Promise<IndiceDuTemplate[]>; scenariosPublies(tenantId: string): Promise<ScenarioPublie[]>; messagesRcs(tenantId: string): Promise<ReadonlyArray<{ name: string; content: RcsOutbound | null }>> }
export function registerV1Catalogues(app: FastifyInstance, deps: V1CataloguesRouteDeps, garde: Guard): void
// Réponses : 200 { templates: TemplateCatalogue[] } | { scenarios: ScenarioCatalogue[] } | { rcsMessages: MessageRcsCatalogue[] }
```

- Et l'opération d'usage `'catalogues.read'` (une unité par appel, non lourde).

- [ ] **Step 1: Écrire les tests**

```ts
// tests/v1-catalogues.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { sha256Hex } from '../src/lib/signature';
import { makeRequireApiKey, requireScope } from '../src/auth/api-key';
import { RateLimiter } from '../src/auth/rate-limit';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import { unitesDe, estLourde } from '../src/api/usage-guard';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { TemplateSummary } from '../src/meta/templates';
import type { OutboundCarouselCard } from '../src/meta/template-components';
import { verdictModele } from '../src/api/modele-envoi';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../src/workflow/graph';
import type { RcsOutbound } from '../src/rcs/types';
import type { IndiceDuTemplate } from '../src/crm/template-hints.pg';
import { canalDOuverture } from '../src/workflow/store.pg';
import type { ScenarioPublie } from '../src/workflow/store.pg';
import { ouvertureApi } from '../src/workflow/ouverture-api';
import type { OuvertureApi } from '../src/workflow/ouverture-api';
import {
  catalogueTemplates, catalogueScenarios, catalogueMessagesRcs, registerV1Catalogues,
} from '../src/http/v1-catalogues';
import type { V1CataloguesRouteDeps } from '../src/http/v1-catalogues';
import { cleApiDeTest } from './aide/cle-api';

/**
 * LES CATALOGUES DE L'API PUBLIQUE (lot 4, spec du 2026-09-24 § 6).
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : chaque ligne d'un catalogue peut partir par `POST /v1/sends`. Un template
 * non approuvé, une catégorie que l'envoi ne connaît pas, un carrousel ou un en-tête que le moteur refuserait
 * avant de partir, un scénario dont l'ouverture diffère de celle que l'envoi calculera : tout cela ferait
 * construire à un intégrateur un appel refusé, sans qu'aucune erreur ne le lui dise avant son premier envoi.
 * Chaque tri est tenu en PARITÉ avec la fonction de l'envoi, jamais avec une règle recopiée.
 */

// --- Fixtures ----------------------------------------------------------------------------------------------

const modele = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: 'tpl-1',
  name: 'confirmation_commande',
  status: 'APPROVED',
  category: 'UTILITY',
  language: 'fr',
  body: 'Bonjour {{1}}, votre commande {{2}} est confirmée.',
  headerFormat: null,
  isCarousel: false,
  editable: true,
  ...over,
});

const noeud = (id: string, type: WorkflowNode['type'], data: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data });
const arete = (source: string, target: string, sourceHandle?: string): WorkflowEdge =>
  ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const graphe = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowGraph => ({ nodes, edges });
const ligne = (graph: WorkflowGraph, name = 'Scénario'): ScenarioPublie =>
  ({ code: 'scn_k3f9qa_01j8z3m4v6x7y8z9a0b1c2d3e4', name, publishedAt: '2026-09-20T08:30:00.000Z', graph });

// --- Templates ---------------------------------------------------------------------------------------------

describe('GET /v1/templates : ce qui entre au catalogue', () => {
  it('🔴 seuls les templates APPROUVÉS entrent', () => {
    const sortie = catalogueTemplates([
      modele({ name: 'a_approuve' }),
      modele({ name: 'b_en_attente', status: 'PENDING' }),
      modele({ name: 'c_refuse', status: 'REJECTED' }),
      modele({ name: 'd_en_pause', status: 'PAUSED' }),
    ], []);
    expect(sortie.map((t) => t.name)).toEqual(['a_approuve']);
  });

  it('🔴 une catégorie que l’envoi ne connaît pas n’entre pas (authentification)', () => {
    const sortie = catalogueTemplates([modele({ name: 'code_otp', category: 'AUTHENTICATION' }), modele()], []);
    expect(sortie.map((t) => t.name)).toEqual(['confirmation_commande']);
    expect(sortie[0]!.category).toBe('utility');
  });

  /**
   * 🔴 LA PARITÉ AVEC `POST /v1/sends` SUR LE STATUT ET LA CATÉGORIE. Les valeurs attendues sont celles de la
   * spec (§ 3 et § 6 : approuvé, et `marketing` ou `utility`), ET chaque cas est comparé à `verdictModele`, la
   * lecture de l'envoi : une règle voisine écrite ici divergerait un jour sans bruit.
   */
  it('🔴 statut et catégorie : un template entre si et seulement si l’envoi l’accepterait', () => {
    const cas: Array<{ over: Partial<TemplateSummary>; entre: boolean }> = [
      { over: { status: 'APPROVED', category: 'MARKETING' }, entre: true },
      { over: { status: 'APPROVED', category: 'UTILITY' }, entre: true },
      { over: { status: 'APPROVED', category: 'AUTHENTICATION' }, entre: false },
      { over: { status: 'APPROVED', category: '' }, entre: false },
      { over: { status: 'PENDING', category: 'UTILITY' }, entre: false },
      { over: { status: 'REJECTED', category: 'MARKETING' }, entre: false },
      { over: { status: '', category: 'UTILITY' }, entre: false },
    ];
    for (const { over, entre } of cas) {
      const t = modele(over);
      const rendu = catalogueTemplates([t], []).length === 1;
      const envoi = verdictModele({ statut: t.status, langue: t.language, category: t.category.toLowerCase() }, t.language);
      expect(rendu, `la valeur de la spec : ${JSON.stringify(over)}`).toBe(entre);
      expect(rendu, `la lecture de /v1/sends : ${JSON.stringify(over)}`).toBe(envoi.statut === 'approuve');
    }
  });

  it('l’en-tête est nommé en minuscules, et un format qu’un envoi ne sait pas remplir n’entre pas', () => {
    const visuel = 'https://exemple.test/visuel.jpg';
    const sortie = catalogueTemplates([
      modele({ name: 'a', headerFormat: null }),
      modele({ name: 'b', headerFormat: 'TEXT' }),
      modele({ name: 'c', headerFormat: 'IMAGE', headerMediaUrl: visuel }),
      modele({ name: 'd', headerFormat: 'VIDEO', headerMediaUrl: visuel }),
      modele({ name: 'e', headerFormat: 'DOCUMENT', headerMediaUrl: visuel }),
      modele({ name: 'f', headerFormat: 'LOCATION' }),
      // Un format inconnu qui porte le nom d'une propriété d'objet : la table est une Map, il ne passe pas.
      modele({ name: 'g', headerFormat: 'toString' }),
    ], []);
    expect(sortie.map((t) => [t.name, t.header])).toEqual([
      ['a', 'none'], ['b', 'text'], ['c', 'image'], ['d', 'video'], ['e', 'document'],
    ]);
  });

  /**
   * 🔴 CE QUE LE MOTEUR D'ENVOI REFUSE AVANT DE PARTIR n'entre pas, jugé par SES fonctions
   * (`carouselSendBlocker`, `headerMediaSendBlocker`) : une carte ou un lien de carte qui porte une variable
   * (rien ne stocke sa valeur), une carte ou un en-tête sans visuel lisible (Meta l'exige à chaque envoi).
   * Annoncés, ils feraient partir un envoi que la campagne refuse en entier.
   */
  it('🔴 un carrousel à variable, une carte sans visuel, un en-tête média sans adresse n’entrent pas', () => {
    const carte = (over: Partial<OutboundCarouselCard> = {}): OutboundCarouselCard => ({
      mediaUrl: 'https://exemple.test/carte.jpg', mediaFormat: 'IMAGE', body: 'Découvrez la collection',
      buttons: [{ type: 'QUICK_REPLY', text: 'Je veux voir' }], ...over,
    });
    const sortie = catalogueTemplates([
      modele({ name: 'a_carrousel', isCarousel: true, carousel: { cards: [carte(), carte()] } }),
      modele({ name: 'b_carte_a_variable', isCarousel: true, carousel: { cards: [carte(), carte({ body: 'Pour {{1}}' })] } }),
      modele({
        name: 'c_lien_a_variable', isCarousel: true,
        carousel: { cards: [carte({ buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.test/p/{{1}}' }] })] },
      }),
      modele({ name: 'd_carte_sans_visuel', isCarousel: true, carousel: { cards: [carte({ mediaUrl: undefined })] } }),
      modele({ name: 'e_image_lisible', headerFormat: 'IMAGE', headerMediaUrl: 'https://exemple.test/visuel.jpg' }),
      modele({ name: 'f_image_sans_adresse', headerFormat: 'IMAGE' }),
    ], []);
    // Un carrousel a ses visuels par carte, sans en-tête de premier niveau : `none`.
    expect(sortie.map((t) => [t.name, t.header])).toEqual([['a_carrousel', 'none'], ['e_image_lisible', 'image']]);
  });

  it('🔴 chaque {{n}} du corps est une variable, avec la source que la console connaît, sinon null', () => {
    const indices: IndiceDuTemplate[] = [
      { name: 'confirmation_commande', language: 'fr', position: 1, source: { type: 'field', key: 'prenom' } },
      // Même template, AUTRE langue : ne doit pas déborder sur le français.
      { name: 'confirmation_commande', language: 'en', position: 2, source: { type: 'attribute', key: 'name' } },
    ];
    const [t] = catalogueTemplates([modele({ body: 'Bonjour {{1}}, commande {{3}}.' })], indices);
    // Corps non contigu : Meta attend 3 paramètres, pas 2 (countTemplateVariables).
    expect(t!.variables).toEqual([
      { position: 1, source: { type: 'field', key: 'prenom' } },
      { position: 2, source: null },
      { position: 3, source: null },
    ]);
  });

  it('🔴 un indice illisible en base ne sort pas : il devient null, jamais une valeur inventée', () => {
    const casse = { name: 'confirmation_commande', language: 'fr', position: 1, source: { type: 'inconnu' } } as unknown as IndiceDuTemplate;
    const [t] = catalogueTemplates([modele()], [casse]);
    expect(t!.variables[0]).toEqual({ position: 1, source: null });
  });

  it('un corps sans variable rend une liste vide, et le catalogue est trié par nom puis langue', () => {
    const sortie = catalogueTemplates([
      modele({ name: 'b', language: 'fr', body: 'Merci.' }),
      modele({ name: 'a', language: 'fr', body: 'Merci.' }),
      modele({ name: 'a', language: 'en', body: 'Thanks.' }),
    ], []);
    expect(sortie.map((t) => `${t.name}/${t.language}`)).toEqual(['a/en', 'a/fr', 'b/fr']);
    expect(sortie.every((t) => t.variables.length === 0)).toBe(true);
  });
});

// --- Scénarios : la parité d'ouverture (spec § 13) ---------------------------------------------------------

/**
 * 🔴 LA PARITÉ D'OUVERTURE, ET C'EST LE CAS LE PLUS IMPORTANT DU FICHIER. Le catalogue, `/v1/sends` et la
 * console doivent dire la même chose d'un même graphe. Les valeurs attendues sont recopiées de la table de la
 * spec (§ 3, « Ce qu'un scénario ou un bloc envoie EN PREMIER »), pas lues dans le code : un test qui lit sa
 * réponse dans l'implémentation ne peut pas échouer.
 */
const CAS_OUVERTURE: Array<{ cas: string; graph: WorkflowGraph; ouverture: OuvertureApi | null }> = [
  { cas: 'template nommé', graph: graphe([noeud('t', 'template', { templateName: 'promo' })]), ouverture: 'whatsapp_template' },
  { cas: 'bloc RCS configuré', graph: graphe([noeud('r', 'rcs_message', { text: 'Bonjour' })]), ouverture: 'rcs' },
  {
    cas: 'RCS, puis template de repli sur la sortie « non joignable »',
    graph: graphe([noeud('r', 'rcs_message', { text: 'Bonjour' }), noeud('t', 'template', { templateName: 'promo' })], [arete('r', 't', 'unreachable')]),
    ouverture: 'rcs',
  },
  { cas: 'message rapide', graph: graphe([noeud('q', 'quick_message', { body: 'Coucou' })]), ouverture: 'whatsapp_session' },
  {
    cas: 'prudence : une branche en session, l’autre en template',
    graph: graphe(
      [noeud('c', 'condition'), noeud('q', 'quick_message', { body: 'Coucou' }), noeud('t', 'template', { templateName: 'promo' })],
      [arete('c', 'q', 'true'), arete('c', 't', 'false')],
    ),
    ouverture: 'whatsapp_session',
  },
  {
    cas: 'attente avant tout envoi',
    graph: graphe([noeud('w', 'wait', { seconds: 60 }), noeud('t', 'template', { templateName: 'promo' })], [arete('w', 't')]),
    ouverture: null,
  },
  {
    cas: 'deux templates différents possibles',
    graph: graphe(
      [noeud('c', 'condition'), noeud('a', 'template', { templateName: 'promo' }), noeud('b', 'template', { templateName: 'relance' })],
      [arete('c', 'a', 'true'), arete('c', 'b', 'false')],
    ),
    ouverture: null,
  },
  { cas: 'template sans nom', graph: graphe([noeud('t', 'template', { templateName: '  ' })]), ouverture: null },
  { cas: 'graphe vide', graph: graphe([]), ouverture: null },
];

/** Ce que la console déduit de la même ouverture : un canal de campagne, et rien pour une ouverture de session. */
const versCanal = (o: OuvertureApi | null): 'whatsapp' | 'rcs' | null =>
  (o === 'whatsapp_template' ? 'whatsapp' : o === 'rcs' ? 'rcs' : null);

describe('GET /v1/scenarios : l’ouverture est celle de l’envoi ET de la console', () => {
  it.each(CAS_OUVERTURE)('$cas', ({ graph, ouverture }) => {
    const [s] = catalogueScenarios([ligne(graph)]);
    expect(s!.opening, 'la valeur de la spec').toBe(ouverture);
    expect(s!.opening, 'la fonction de /v1/sends').toBe(ouvertureApi(graph).ouverture);
    expect(versCanal(s!.opening), 'la règle de la console').toBe(canalDOuverture(graph));
  });

  it('le catalogue rend le code, le nom et la date, jamais le graphe', () => {
    const [s] = catalogueScenarios([ligne(CAS_OUVERTURE[0]!.graph, 'Bienvenue')]);
    expect(Object.keys(s!).sort()).toEqual(['code', 'name', 'opening', 'publishedAt']);
  });
});

// --- Messages RCS ------------------------------------------------------------------------------------------

describe('GET /v1/rcs-messages', () => {
  const texte: RcsOutbound = { kind: 'text', text: 'Bonjour {{prenom}}, rendez-vous le {{date_rdv}}.' };
  const carte: RcsOutbound = { kind: 'card', card: { title: 'Rappel', description: '{{prenom}}, à demain' } };

  it('rend le format et les variables du message, triés par nom', () => {
    expect(catalogueMessagesRcs([{ name: 'b-carte', content: carte }, { name: 'a-texte', content: texte }])).toEqual([
      { name: 'a-texte', kind: 'text', variables: ['prenom', 'date_rdv'] },
      { name: 'b-carte', kind: 'card', variables: ['prenom'] },
    ]);
  });

  it('🔴 un message dont le contenu stocké n’est plus reconnu n’entre pas : il ne partirait pas', () => {
    expect(catalogueMessagesRcs([{ name: 'illisible', content: null }, { name: 'ok', content: texte }]).map((m) => m.name))
      .toEqual(['ok']);
  });
});

// --- Les routes : garde, isolation, comptage ----------------------------------------------------------------

class FaussesCles implements ApiKeyLookup {
  private readonly parEmpreinte = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  ajouter(brute: string, rec: { id: string; tenantId: string; scopes: string[] }): this {
    this.parEmpreinte.set(sha256Hex(brute), rec);
    return this;
  }
  async findActiveByHash(hash: string) { return this.parEmpreinte.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const CLE_ENVOIS = cleApiDeTest('catalogues_envois');
const CLE_CONTACTS = cleApiDeTest('catalogues_contacts');

/** `debitParCle` : le plafond du limiteur par clé (défaut de production : 60 par minute). */
function monter(debitParCle = 60) {
  const appels: string[] = [];
  const usage = new GardeUsageMemoire();
  const cles = new FaussesCles()
    .ajouter(CLE_ENVOIS, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .ajouter(CLE_CONTACTS, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });
  const deps: V1CataloguesRouteDeps = {
    usage,
    templates: async (t) => { appels.push(`templates:${t}`); return [modele(), modele({ name: 'en_attente', status: 'PENDING' })]; },
    indicesDeVariables: async (t) => {
      appels.push(`indices:${t}`);
      return [{ name: 'confirmation_commande', language: 'fr', position: 1, source: { type: 'field', key: 'prenom' } }];
    },
    scenariosPublies: async (t) => { appels.push(`scenarios:${t}`); return [ligne(CAS_OUVERTURE[0]!.graph, 'Bienvenue')]; },
    messagesRcs: async (t) => { appels.push(`rcs:${t}`); return [{ name: 'rappel-rdv', content: { kind: 'text', text: 'Bonjour {{prenom}}' } }]; },
  };
  const app = Fastify({ logger: false });
  // La VRAIE garde de l'entrée /v1 : la clé, puis le droit. C'est elle, pas un faux, qui pose `req.auth`.
  registerV1Catalogues(app, deps, [
    makeRequireApiKey(cles, new RateLimiter(debitParCle, 60_000), new RateLimiter(1000, 60_000)),
    requireScope('sends:create'),
  ]);
  return { app, appels, usage };
}

const avec = (cle: string) => ({ authorization: `Bearer ${cle}` });

describe('les trois routes des catalogues', () => {
  it('🔴 une clé qui a `sends:create` lit les trois, et l’espace vient de la CLÉ', async () => {
    const { app, appels } = monter();
    const tpl = await app.inject({ method: 'GET', url: '/v1/templates', headers: avec(CLE_ENVOIS) });
    const scn = await app.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_ENVOIS) });
    const rcs = await app.inject({ method: 'GET', url: '/v1/rcs-messages', headers: avec(CLE_ENVOIS) });
    expect([tpl.statusCode, scn.statusCode, rcs.statusCode]).toEqual([200, 200, 200]);
    expect(tpl.json()).toEqual({
      templates: [{
        name: 'confirmation_commande', language: 'fr', category: 'utility', header: 'none',
        variables: [{ position: 1, source: { type: 'field', key: 'prenom' } }, { position: 2, source: null }],
      }],
    });
    expect(scn.json()).toEqual({
      scenarios: [{ code: 'scn_k3f9qa_01j8z3m4v6x7y8z9a0b1c2d3e4', name: 'Bienvenue', opening: 'whatsapp_template', publishedAt: '2026-09-20T08:30:00.000Z' }],
    });
    expect(rcs.json()).toEqual({ rcsMessages: [{ name: 'rappel-rdv', kind: 'text', variables: ['prenom'] }] });
    // L'isolation : chaque lecture a reçu l'espace de la clé, et aucun autre.
    expect(appels.sort()).toEqual(['indices:t1', 'rcs:t1', 'scenarios:t1', 'templates:t1']);
    await app.close();
  });

  /**
   * 🔴 LES REFUS DE LA GARDE PORTENT LEUR CODE, pas seulement leur statut : la page Documentation API
   * documente `missing_scope`, `unauthorized` et `rate_limited`, et affirme la forme `{ error, code }`. Un
   * contrôle du seul statut laisserait la page mentir sans qu'aucun test ne le voie.
   */
  it('🔴 une clé SANS `sends:create` est refusée en 403 `missing_scope`, et rien n’est lu', async () => {
    const { app, appels } = monter();
    for (const url of ['/v1/templates', '/v1/scenarios', '/v1/rcs-messages']) {
      const res = await app.inject({ method: 'GET', url, headers: avec(CLE_CONTACTS) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ code: 'missing_scope' });
    }
    expect(appels).toEqual([]);
    await app.close();
  });

  it('🔴 sans clé : 401 `unauthorized`, et rien n’est lu', async () => {
    const { app, appels } = monter();
    const res = await app.inject({ method: 'GET', url: '/v1/templates' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
    expect(appels).toEqual([]);
    await app.close();
  });

  it('au-delà du débit de la clé : 429 `rate_limited`, et la seconde lecture n’a pas lieu', async () => {
    const { app, appels } = monter(1);
    const premier = await app.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_ENVOIS) });
    const second = await app.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_ENVOIS) });
    expect([premier.statusCode, second.statusCode]).toEqual([200, 429]);
    expect(second.json()).toMatchObject({ code: 'rate_limited' });
    expect(appels).toEqual(['scenarios:t1']);
    await app.close();
  });

  it('chaque lecture COMPTE, une unité, sous `catalogues.read`', async () => {
    const { app, usage } = monter();
    for (const url of ['/v1/templates', '/v1/scenarios', '/v1/rcs-messages']) {
      await app.inject({ method: 'GET', url, headers: avec(CLE_ENVOIS) });
    }
    expect(usage.compteurs().find((c) => c.operation === 'catalogues.read')).toMatchObject({ appels: 3, unites: 3 });
    // Une lecture ne réserve pas de place lourde : la soumettre au plafond ferait refuser une consultation
    // pendant qu'un lot écrit.
    expect(unitesDe('catalogues.read')).toBe(1);
    expect(estLourde('catalogues.read')).toBe(false);
    await app.close();
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/v1-catalogues.test.ts`
Expected: FAIL au chargement, `Failed to load url ../src/http/v1-catalogues` (le module n'existe pas).

- [ ] **Step 3: L'opération d'usage**

Dans `src/api/usage-guard.ts`, remplacer :

```ts
  | 'mcp.call'
  | 'mcp.refus';
```

par :

```ts
  // Une lecture de catalogue (`GET /v1/templates`, `/v1/scenarios`, `/v1/rcs-messages`). UNE unité : le
  // travail ne dépend pas de ce que l'appelant envoie. ⚠️ `/v1/templates` interroge Meta (liste paginée du
  // WABA) : c'est la raison de la compter à part, pour voir une boucle de lectures avant qu'elle coûte.
  | 'catalogues.read'
  | 'mcp.call'
  | 'mcp.refus';
```

- [ ] **Step 4: Le module**

```ts
// src/http/v1-catalogues.ts
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { TemplateSummary } from '../meta/templates';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import { countTemplateVariables, parseParamHints } from '../crm/template';
import type { ParamSource } from '../crm/template';
import type { IndiceDuTemplate } from '../crm/template-hints.pg';
import type { ScenarioPublie } from '../workflow/store.pg';
import { ouvertureApi } from '../workflow/ouverture-api';
import type { OuvertureApi } from '../workflow/ouverture-api';
import type { RcsOutbound } from '../rcs/types';
import { variablesDe } from '../rcs/variables';
import { refuser } from '../api/erreurs';
import { verdictModele } from '../api/modele-envoi';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

/**
 * LES CATALOGUES DE L'API PUBLIQUE : ce qu'un intégrateur peut envoyer, lu sans ouvrir la console.
 *
 * 🔴 CHAQUE LIGNE D'UN CATALOGUE PEUT PARTIR PAR `POST /v1/sends`, et c'est ce qui décide de ce qu'on
 * écarte : un template non approuvé ou d'une catégorie que l'envoi ne connaît pas (authentification), un
 * en-tête qu'il ne sait pas remplir (localisation), ce que le moteur refuserait avant de partir (carte ou
 * lien de carte à variable, carte ou en-tête média sans visuel lisible) ; un scénario jamais publié ; un
 * message RCS dont le contenu stocké n'est plus reconnu. Les montrer ferait construire un appel refusé.
 *
 * 🔴 CHAQUE TRI EST CELUI DE L'ENVOI, par SA fonction : `verdictModele` (statut et catégorie, lot 2),
 * `carouselSendBlocker` et `headerMediaSendBlocker` (le moteur, `src/campaign/engine.ts`). ⚠️ Seul reste
 * imprévisible d'ici un visuel dont le re-téléversement échoue le jour de l'envoi.
 *
 * 🔴 L'OUVERTURE D'UN SCÉNARIO VIENT DE `ouvertureApi`, LA FONCTION DE `/v1/sends`, jamais d'un calcul
 * voisin. Deux règles écrites en parallèle divergent un jour, et la divergence serait muette : le catalogue
 * annoncerait un scénario que l'envoi refuse. `tests/v1-catalogues.test.ts` tient la parité avec
 * `ouvertureApi` ET avec la console (`canalDOuverture`), sur les mêmes graphes.
 *
 * ⚠️ Le tenant vient à 100 % de `req.auth` (posé par la garde de clé d'API), jamais de l'URL. Droit
 * attendu : `sends:create`, celui des envois que ces lectures servent à construire.
 */

/** L'en-tête d'un template, tel que le catalogue le nomme. */
export type EnteteTemplate = 'none' | 'text' | 'image' | 'video' | 'document';

/**
 * Les formats d'en-tête qu'un envoi sait porter. Une `Map` et pas un objet littéral : sur un objet,
 * `ENTETES['toString']` rendrait une fonction pour un format que Meta inventerait demain.
 */
const ENTETES: ReadonlyMap<string, EnteteTemplate> = new Map<string, EnteteTemplate>([
  ['TEXT', 'text'], ['IMAGE', 'image'], ['VIDEO', 'video'], ['DOCUMENT', 'document'],
]);

export interface VariableDeTemplate {
  position: number;
  /** Le champ que la console associe à cette variable (`template_param_hints`), `null` s'il n'est pas connu. */
  source: ParamSource | null;
}

export interface TemplateCatalogue {
  name: string;
  language: string;
  category: 'marketing' | 'utility';
  /** ⚠️ Un carrousel a ses visuels PAR CARTE, sans en-tête de premier niveau : il vaut `none`. */
  header: EnteteTemplate;
  variables: VariableDeTemplate[];
}

export interface ScenarioCatalogue {
  code: string | null;
  name: string;
  /** `null` = ce scénario ne peut pas partir par l'API. `whatsapp_session` = il se vise par son premier bloc. */
  opening: OuvertureApi | null;
  publishedAt: string | null;
}

export interface MessageRcsCatalogue {
  name: string;
  kind: RcsOutbound['kind'];
  /** Les `{{nom}}` du message, dans l'ordre de première apparition (`variablesDe`). */
  variables: string[];
}

/** Nom et langue en une clé sans ambiguïté (un nom de template ne peut pas contenir de quoi la casser). */
const cleTemplate = (name: string, language: string): string => JSON.stringify([name, language]);

export function catalogueTemplates(
  templates: readonly TemplateSummary[],
  indices: readonly IndiceDuTemplate[],
): TemplateCatalogue[] {
  const sources = new Map<string, Map<number, ParamSource>>();
  for (const i of indices) {
    // Relu par le MÊME validateur qu'à l'écriture : la colonne est un jsonb, et ce qui en sort part vers un
    // tiers. Un indice illisible devient « aucune source connue », jamais une valeur inventée.
    const [valide] = parseParamHints([{ position: i.position, source: i.source }]) ?? [];
    if (!valide) continue;
    const cle = cleTemplate(i.name, i.language);
    const parPosition = sources.get(cle) ?? new Map<number, ParamSource>();
    parPosition.set(valide.position, valide.source);
    sources.set(cle, parPosition);
  }

  const sortie: TemplateCatalogue[] = [];
  for (const t of templates) {
    // Statut et catégorie : la lecture de `POST /v1/sends` (`verdictModele`), jamais une règle voisine. Meta
    // rend la catégorie en majuscules ; la lecture partagée (`templateVarInfo`) la passe en minuscules.
    const verdict = verdictModele({ statut: t.status, langue: t.language, category: t.category.toLowerCase() }, t.language);
    if (verdict.statut !== 'approuve') continue;
    const header = t.headerFormat === null ? 'none' : ENTETES.get(t.headerFormat);
    if (!header) continue;
    /**
     * Ce que le moteur d'envoi refuse AVANT de partir, par SES fonctions. ⚠️ À l'envoi, chaque visuel est
     * RE-TÉLÉVERSÉ depuis son adresse pour obtenir son identifiant (`prepareCarouselMedia`,
     * `prepareHeaderMedia`) ; le catalogue ne téléverse rien, donc l'adresse tient lieu d'identifiant : sans
     * elle, l'envoi n'en aura jamais.
     */
    if (t.carousel && carouselSendBlocker(t.carousel.cards.map((c) => ({ ...c, mediaId: c.mediaId ?? c.mediaUrl }))) !== null) continue;
    if (headerMediaSendBlocker(t.headerFormat ?? undefined, t.headerMediaUrl) !== null) continue;
    const parPosition = sources.get(cleTemplate(t.name, t.language));
    sortie.push({
      name: t.name,
      language: t.language,
      category: verdict.categorie,
      header,
      // MAX des positions {{n}}, pas leur nombre : un corps `{{1}} … {{3}}` attend trois paramètres.
      variables: Array.from({ length: countTemplateVariables(t.body) }, (_, k) => ({
        position: k + 1,
        source: parPosition?.get(k + 1) ?? null,
      })),
    });
  }
  return sortie.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

export function catalogueScenarios(lignes: readonly ScenarioPublie[]): ScenarioCatalogue[] {
  return lignes.map((l) => ({
    code: l.code,
    name: l.name,
    opening: ouvertureApi(l.graph).ouverture,
    publishedAt: l.publishedAt,
  }));
}

export function catalogueMessagesRcs(
  messages: ReadonlyArray<{ name: string; content: RcsOutbound | null }>,
): MessageRcsCatalogue[] {
  const sortie: MessageRcsCatalogue[] = [];
  for (const m of messages) {
    // `null` = contenu stocké dont la forme n'est plus reconnue (`parseStoredRcsOutbound`) : il ne partirait pas.
    if (!m.content) continue;
    sortie.push({ name: m.name, kind: m.content.kind, variables: variablesDe(m.content) });
  }
  return sortie.sort((a, b) => a.name.localeCompare(b.name));
}

export interface V1CataloguesRouteDeps {
  /** Le garde d'usage, injecté au bootstrap. OBLIGATOIRE, comme sur les autres modules /v1. */
  usage: ApiUsageGuard;
  /** Les templates du WABA de l'espace, tels que Meta les rend. `[]` quand l'espace n'a pas de WABA. */
  templates(tenantId: string): Promise<TemplateSummary[]>;
  /** Tous les indices « variable vers champ » de l'espace, en UNE requête. */
  indicesDeVariables(tenantId: string): Promise<IndiceDuTemplate[]>;
  /** Les scénarios dont le graphe PUBLIÉ porte au moins un bloc. */
  scenariosPublies(tenantId: string): Promise<ScenarioPublie[]>;
  /** La bibliothèque RCS, suppressions douces exclues. */
  messagesRcs(tenantId: string): Promise<ReadonlyArray<{ name: string; content: RcsOutbound | null }>>;
}

/**
 * Guard attendu : `[makeRequireApiKey, requireScope('sends:create')]`, posé par l'entrée `v1` du registre.
 *
 * ⚠️ Une panne de Meta sur `/v1/templates` remonte telle quelle au gestionnaire d'erreur global, donc en 5xx
 * SANS corps `{ error, code }` : le catalogue n'invente pas une liste vide, qui ferait croire à l'intégrateur
 * qu'il n'a aucun template approuvé. Tranché dans le plan du lot 4 : aucun code dédié (le § 9 et `CodeApi`
 * n'en ont pas) ; la page le dit dans sa section « Erreurs ».
 */
export function registerV1Catalogues(app: FastifyInstance, deps: V1CataloguesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/v1/templates', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    if (!await compterOuRefuser(deps.usage, req, reply, 'catalogues.read')) return reply;
    const [templates, indices] = await Promise.all([deps.templates(tenantId), deps.indicesDeVariables(tenantId)]);
    return reply.code(200).send({ templates: catalogueTemplates(templates, indices) });
  });

  app.get('/v1/scenarios', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    if (!await compterOuRefuser(deps.usage, req, reply, 'catalogues.read')) return reply;
    return reply.code(200).send({ scenarios: catalogueScenarios(await deps.scenariosPublies(tenantId)) });
  });

  app.get('/v1/rcs-messages', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    if (!await compterOuRefuser(deps.usage, req, reply, 'catalogues.read')) return reply;
    return reply.code(200).send({ rcsMessages: catalogueMessagesRcs(await deps.messagesRcs(tenantId)) });
  });
}
```

- [ ] **Step 5: Voir passer**

Run: `npx vitest run tests/v1-catalogues.test.ts && npm run typecheck`
Expected: PASS. Si un cas de `CAS_OUVERTURE` échoue sur « la valeur de la spec » ou « la règle de la
console », ou si le cas « statut et catégorie » échoue sur « la valeur de la spec » alors que « la lecture de
/v1/sends » passe, ce n'est PAS ce lot qu'on corrige : c'est un écart entre une fonction du lot 2
(`ouvertureApi`, `verdictModele`) et la spec ou la console. Le signaler à Julien avec le cas, sans affaiblir
l'attente. Un échec sur les codes `missing_scope`, `unauthorized` ou `rate_limited` est un manque du lot 1
(voir les préconditions), pas de ce lot.

- [ ] **Step 6: Vérifier les gardes dans les deux sens** (annoncer d'abord la mutation de la ligne du tenant)

1. Remplacer la ligne `const verdict = verdictModele({ ... }, t.language);` par
   `const verdict = { statut: 'approuve' as const, categorie: 'utility' as const };` : `npx vitest run
   tests/v1-catalogues.test.ts` doit échouer sur « seuls les templates APPROUVÉS entrent » (`b_en_attente`,
   `c_refuse`, `d_en_pause` apparaissent), sur « authentification » et sur la parité avec l'envoi (« la lecture
   de /v1/sends »), et la route rend deux templates. Restaurer.
2. Retirer la ligne `if (t.carousel && carouselSendBlocker(...)) continue;` : le cas « un carrousel à
   variable… » doit échouer (`b_carte_a_variable`, `c_lien_a_variable`, `d_carte_sans_visuel` apparaissent).
   Restaurer. Même geste sur la ligne `headerMediaSendBlocker` : `f_image_sans_adresse` apparaît. Restaurer.
3. Remplacer `opening: ouvertureApi(l.graph).ouverture,` par
   `opening: canalDOuverture(l.graph) === 'whatsapp' ? 'whatsapp_template' : canalDOuverture(l.graph),` (import
   temporaire de `canalDOuverture`) : les cas « message rapide » et « prudence » doivent échouer
   (`whatsapp_session` attendu, `null` reçu). Restaurer, retirer l'import.
4. Remplacer `const tenantId = req.auth.tenantId;` de `/v1/templates` par `const tenantId = 't2';` : le premier
   cas des routes doit échouer (`templates:t2` au lieu de `templates:t1`). Restaurer.

Puis aucune trace des mutations ne doit rester dans le fichier neuf :
`grep -c "canalDOuverture(l.graph)\|tenantId = 't2'\|statut: 'approuve' as const" src/http/v1-catalogues.ts`
rend 0 (le commentaire d'en-tête nomme `canalDOuverture` sans parenthèses, il n'est pas compté),
`grep -c "carouselSendBlocker(t.carousel\|headerMediaSendBlocker(t.headerFormat" src/http/v1-catalogues.ts` rend
2, et la suite repasse au vert.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/julie/messagingme-mba && git add -N src/http/v1-catalogues.ts tests/v1-catalogues.test.ts && \
git diff -- src/api/usage-guard.ts src/http/v1-catalogues.ts tests/v1-catalogues.test.ts && \
git commit --only src/api/usage-guard.ts src/http/v1-catalogues.ts tests/v1-catalogues.test.ts \
  -m "feat(api): catalogues /v1 (templates approuves, scenarios publies, messages RCS)" \
  -m "Chaque ligne peut partir par /v1/sends : statut et categorie par verdictModele, carrousel et en-tete media par les refus du moteur, ouverture par ouvertureApi. Des tests tiennent chaque parite, et les refus de la garde portent leur code. Module non cable a ce stade." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 4: Câbler les catalogues dans l'entrée `/v1` (fichiers de câblage partagés, procédure P)

**Files:**
- Modify: `src/server.ts` (import ligne 56, type `v1` ligne 244, montage ligne 543 aujourd'hui)
- Modify: `src/index.ts` (bloc `v1: {` ligne 3009 à 3010 aujourd'hui)
- Modify: `tests/v1-catalogues.test.ts` (un bloc de plus)

**Interfaces:**
- Consumes : `registerV1Catalogues`, `V1CataloguesRouteDeps` (tâche 3) ; `listPublies`, `listerParEspace`
  (tâche 2) ; `metaFactory.templateClientForTenant`, `repo.getTenantWabaId`, `rcsMessageStore.list`,
  `templateHintStore`, `workflowStore` (déjà construits dans `src/index.ts`, lignes 216, 248, 390, 808 à 809).
- Produces : `ServerDeps['v1']['catalogues']?: Omit<V1CataloguesRouteDeps, 'usage'>`, monté derrière
  `[requireApiKey, requireScope('sends:create')]`, avec le MÊME limiteur que les autres routes `/v1`.

- [ ] **Step 1: Annoncer l'édition de `src/server.ts` et `src/index.ts` aux autres sessions** (ListAgents,
  SendMessage : « lot 4 API, j'édite src/server.ts et src/index.ts, bloc v1, trois lignes chacun »).

- [ ] **Step 2: Écrire le test du montage**

Ajouter à la fin de `tests/v1-catalogues.test.ts` (et `import { buildServer } from '../src/server';`,
`import { FakeQueue } from '../src/queue/fake';` en tête) :

```ts
describe('monté dans l’entrée /v1 du registre', () => {
  function serveur() {
    const cles = new FaussesCles()
      .ajouter(CLE_ENVOIS, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
      .ajouter(CLE_CONTACTS, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });
    return buildServer({
      queue: new FakeQueue(),
      v1: {
        apiKeys: cles,
        // Les routes de contacts sont montées mais jamais appelées ici : ce bloc éprouve le montage des
        // catalogues, pas les contacts (qui ont leurs propres tests).
        contacts: {} as never,
        catalogues: {
          templates: async () => [modele()],
          indicesDeVariables: async () => [],
          scenariosPublies: async () => [],
          messagesRcs: async () => [],
        },
      },
    });
  }

  it('🔴 la route répond derrière la VRAIE garde du registre, droit `sends:create` exigé', async () => {
    const server = serveur();
    const ok = await server.inject({ method: 'GET', url: '/v1/templates', headers: avec(CLE_ENVOIS) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ templates: unknown[] }>().templates).toHaveLength(1);
    const refus = await server.inject({ method: 'GET', url: '/v1/scenarios', headers: avec(CLE_CONTACTS) });
    expect(refus.statusCode).toBe(403);
    await server.close();
  });
});
```

- [ ] **Step 3: Le voir échouer**

Run: `npx vitest run tests/v1-catalogues.test.ts`
Expected: FAIL au typage de vitest ou à l'exécution : `GET /v1/templates` rend 404 (le module n'est pas
monté), et `npm run typecheck` signale `'catalogues' does not exist in type`.

- [ ] **Step 4: Câbler `src/server.ts`** (trois éditions exactes)

Remplacer `import { registerV1Sends } from './http/v1-sends';` par :

```ts
import { registerV1Sends } from './http/v1-sends';
import { registerV1Catalogues } from './http/v1-catalogues';
import type { V1CataloguesRouteDeps } from './http/v1-catalogues';
```

Remplacer `    sends?: Omit<V1SendsRouteDeps, 'usage'>;` par :

```ts
    sends?: Omit<V1SendsRouteDeps, 'usage'>;
    /** Les trois catalogues (`GET /v1/templates`, `/v1/scenarios`, `/v1/rcs-messages`), lot 4 du 2026-09-24. */
    catalogues?: Omit<V1CataloguesRouteDeps, 'usage'>;
```

Remplacer la ligne qui monte `registerV1Sends` (aujourd'hui
`      if (v1.sends) registerV1Sends(app, { ...v1.sends, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);` ;
si le lot 2 l'a changée, prendre sa forme actuelle, la ligne qui contient `registerV1Sends(app,`) par elle-même
suivie de :

```ts
      // Les catalogues : MÊME droit que les envois, qu'ils servent à construire, et MÊME `requireApiKey`, donc
      // le même limiteur par clé. Un droit neuf aurait obligé chaque intégrateur à refabriquer sa clé pour
      // LIRE ce qu'il a déjà le droit d'envoyer.
      if (v1.catalogues) registerV1Catalogues(app, { ...v1.catalogues, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);
```

- [ ] **Step 5: Câbler `src/index.ts`**

Remplacer :

```ts
    v1: {
      apiKeys: apiKeyStore,
```

par :

```ts
    v1: {
      apiKeys: apiKeyStore,
      /**
       * Les catalogues de l'API publique (lot 4 du 2026-09-24). CE BLOC NE FAIT QUE BRANCHER : le tri (ce qui
       * peut partir) vit dans `src/http/v1-catalogues.ts`, testé.
       *
       * ⚠️ `templates` lit la liste COMPLÈTE du WABA chez Meta à chaque appel, sans le cache de
       * `templateVarInfo` (qui est par template) : un catalogue se lit rarement, et un cache de cinq minutes y
       * masquerait un template tout juste approuvé.
       */
      catalogues: {
        templates: async (tenant) => {
          const waba = await repo.getTenantWabaId(tenant);
          return waba ? (await metaFactory.templateClientForTenant(tenant)).list(waba) : [];
        },
        indicesDeVariables: (tenant) => templateHintStore.listerParEspace(tenant),
        scenariosPublies: (tenant) => workflowStore.listPublies(tenant),
        messagesRcs: (tenant) => rcsMessageStore.list(tenant),
      },
```

- [ ] **Step 6: Voir passer**

Run: `npm run typecheck && npx vitest run tests/v1-catalogues.test.ts tests/scope-tenant.test.ts tests/api-usage-observation.test.ts`
Expected: PASS. `tests/scope-tenant.test.ts` reste vert : les routes neuves ne portent pas `:tenantId`, et
l'entrée `v1` est déclarée `cle-api`.

Puis la suite : `npm test`. Expected: PASS (hors échecs de fichiers d'une autre session, à lister et exclure
du périmètre avant de conclure).

- [ ] **Step 7: Vérifier le droit dans les deux sens** (annoncer : mutation d'une garde dans `src/server.ts`)

Dans la ligne ajoutée à `src/server.ts`, remplacer `[requireApiKey, requireScope('sends:create')]` par
`[requireApiKey]` : `npx vitest run tests/v1-catalogues.test.ts` doit échouer sur « droit `sends:create`
exigé » (200 au lieu de 403 pour la clé `contacts:write`). Restaurer, puis `git diff -- src/server.ts` ne
montre que les éditions de l'étape 4, `requireScope('sends:create')` compris.

- [ ] **Step 8: Commit par la procédure P**

Chemins : `src/server.ts`, `src/index.ts` (blobs reconstruits depuis `origin/main` + les éditions des
étapes 4 et 5), `tests/v1-catalogues.test.ts` (`git hash-object -w` direct si son diff ne porte que ce lot).
Sujet : `feat(api): catalogues montes dans l entree /v1 (droit sends:create)`. Puis prévenir les autres
sessions (fichiers communs : `src/server.ts`, `src/index.ts`).

- [ ] **Step 9: Lire la CI du commit**

`gh run list --limit 5`, puis `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'` : tous les
jobs en `success`, dont `integration` (les trois cas de la tâche 2) et l'auto-attaque (qui attaque les trois
routes neuves sans clé, avec une session de console et avec une clé inventée : 401 attendu partout).

---

### Task 5: Le module d'exemples de la documentation (`web/lib/api-exemples.ts`)

Le module n'est rendu par aucune page à ce stade : le pousser ne publie rien. Il ne porte AUCUN
dictionnaire de signaux : celui-là appartient au lot 6 (voir « Ce que ce lot ne fait PAS »).

**Files:**
- Create: `web/lib/api-exemples.ts`
- Create: `tests/api-exemples.test.ts`

**Interfaces:**
- Consumes : les symboles de la tâche 1 (`schemaCorpsContact`, `schemaCorpsLot`, `MAX_BATCH`,
  `schemaCorpsRecherche`, `schemaCorpsModification`, `schemaCorpsEnvoi`, `schemaDestinataireEnvoi`,
  `lireCible`, `RapportEnvoi`, `MAX_RECIPIENTS`, `MAX_SKIPPED_REPORT`, `schemaMessageWhatsapp`,
  `schemaMessageRcs`) ; `CodeApi` (`src/api/erreurs.ts`, lot 1) ; `FicheApi`, `ResultatFiche`
  (`src/api/contacts-v1.ts`, lot 1) ; `SuiviEnvoiApi` (`src/api/suivi-envoi.ts`, lot 2) ;
  `validateParamMapping(raw: unknown, options?: { accepterVariables?: boolean }): TemplateParam[] | null`
  (`src/crm/template.ts`, signature du lot 3) ; `destinataireAvecVariablesInterdites(cible: TypeDeCible,
  destinataires: readonly unknown[]): number | null` (signature exacte du lot 3, qui lit les destinataires
  TELS QUE REÇUS) et `TypeDeCible`
  (`src/api/variables.ts`, lot 3) ; `catalogueTemplates`, `catalogueScenarios`, `catalogueMessagesRcs` (tâche 3).
- Produces (`web/lib/api-exemples.ts`, AUCUN import) :

```ts
export type Bilingue = readonly [fr: string, en: string];
export type RouteAvecCorps = 'POST /v1/contacts' | 'POST /v1/contacts/batch' | 'POST /v1/contacts/search' | 'PATCH /v1/contacts/{contactId}' | 'POST /v1/sends' | 'POST /v1/messages/whatsapp' | 'POST /v1/messages/rcs';
export interface ExempleCorps { readonly route: RouteAvecCorps; readonly corps: unknown }
export const EXEMPLES_CORPS   // contactCreer, contactsLot, contactRechercher, contactModifier, envoiTemplate, envoiScenario, envoiBloc, envoiRcs, messageWhatsapp, messageRcs, outilParContact
export const EXEMPLES_REPONSES // contactEcrit, contactsLot, contactLu, contactTrouve, contactModifie, messageEnvoye, envoiCree, envoiSuivi, templates, scenarios, messagesRcs, erreur
export interface CodeDocumente { readonly code: string; readonly statut: number | null; readonly ecart: boolean; readonly quoi: Bilingue }
export const CODES_DOCUMENTES; export type NomDeCode
export const BORNES
```

- [ ] **Step 1: Écrire le test**

```ts
// tests/api-exemples.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  BORNES, CODES_DOCUMENTES, EXEMPLES_CORPS, EXEMPLES_REPONSES,
  type RouteAvecCorps,
} from '../web/lib/api-exemples';
import { schemaClesFiche } from '../src/api/fiche';
import {
  schemaCorpsContact, schemaCorpsLot, schemaCorpsRecherche, schemaCorpsModification, MAX_BATCH,
} from '../src/http/v1-contacts';
import {
  schemaCorpsEnvoi, schemaDestinataireEnvoi, lireCible, MAX_RECIPIENTS, MAX_SKIPPED_REPORT, type RapportEnvoi,
} from '../src/http/v1-sends';
import { schemaMessageWhatsapp } from '../src/http/v1-messages';
import { schemaMessageRcs } from '../src/http/v1-messages-rcs';
import { validateParamMapping } from '../src/crm/template';
import { destinataireAvecVariablesInterdites, type TypeDeCible } from '../src/api/variables';
import type { CodeApi } from '../src/api/erreurs';
import type { FicheApi, ResultatFiche } from '../src/api/contacts-v1';
import type { SuiviEnvoiApi } from '../src/api/suivi-envoi';
import { catalogueTemplates, catalogueScenarios, catalogueMessagesRcs } from '../src/http/v1-catalogues';

/**
 * LA PAGE DOCUMENTATION API NE PEUT PLUS DÉCRIRE UN CORPS QUE LE SERVEUR REFUSE (spec § 10).
 *
 * 🔴 CHAQUE CORPS D'EXEMPLE PASSE PAR LE VALIDATEUR ZOD DE SA ROUTE. La page a longtemps montré `optIn`, des
 * destinataires en chaînes et `/v1/messages`, bien après que le code eut changé : écrite à la main, elle ne
 * pouvait pas le savoir. Ses exemples vivent désormais dans `web/lib/api-exemples.ts`, que la page affiche et
 * que ce fichier éprouve.
 *
 * ⚠️ DES CONTRÔLES SONT AU TYPAGE, pas à l'exécution : la table des codes égale à `CodeApi` (dans les deux
 * sens), l'exhaustivité des validateurs par route, et les réponses montrées typées par leurs producteurs. Ils
 * tombent à `npm run typecheck`, qui tourne en CI.
 */

type Verdict = { ok: true } | { ok: false; raison: string };
const depuis = (r: { success: true } | { success: false; error: z.ZodError }): Verdict =>
  (r.success ? { ok: true } : { ok: false, raison: r.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ') });

/** Les types de cible de `POST /v1/sends`, pour la règle des variables par destinataire (lot 3). */
const TYPES_DE_CIBLE: readonly TypeDeCible[] = ['template', 'scenario', 'node', 'rcsMessage'];

/**
 * Le validateur de CHAQUE route qui prend un corps. `Record` sur l'union : une route ajoutée à
 * `RouteAvecCorps` sans validateur ne compile pas.
 *
 * 🔴 CE SONT LES RÈGLES DES ROUTES, JAMAIS UNE COPIE : les schémas, `lireCible` et les bornes sont EXPORTÉS par
 * les routes (tâche 1), `validateParamMapping` et `destinataireAvecVariablesInterdites` sont les fonctions
 * qu'elles appellent. Seul l'ORDRE est reproduit ici, et il ne change rien à la question posée (un exemple de
 * la doc doit passer TOUTES les règles).
 *
 * ⚠️ `POST /v1/sends` : un destinataire mal formé est ÉCARTÉ par la route, il ne fait pas tomber l'envoi ;
 * pour la doc, c'est quand même un mensonge (l'exemple montrerait un destinataire qui ne part pas), donc chaque
 * destinataire passe ici le schéma de la route.
 * ⚠️ `POST /v1/contacts/batch` : le lot 1 tient les deux bornes de longueur du lot (vide, plus de `MAX_BATCH`)
 * dans son HANDLER, pas dans son schéma. Elles sont appliquées ici avec SA constante ; seul le lot 1 peut les
 * remonter dans le schéma. Les cas cassés du lot éprouvent donc le conteneur et l'élément, pas ces bornes.
 */
const VALIDATEURS: Record<RouteAvecCorps, (corps: unknown) => Verdict> = {
  'POST /v1/contacts': (c) => depuis(schemaCorpsContact.safeParse(c)),
  'POST /v1/contacts/batch': (c) => {
    const lot = schemaCorpsLot.safeParse(c);
    if (!lot.success) return depuis(lot);
    const { contacts } = lot.data;
    if (contacts.length === 0 || contacts.length > MAX_BATCH) return { ok: false, raison: `contacts : de 1 à ${MAX_BATCH} éléments` };
    for (const [i, el] of contacts.entries()) {
      const v = depuis(schemaCorpsContact.safeParse(el));
      if (!v.ok) return { ok: false, raison: `contacts.${i} : ${v.raison}` };
    }
    return { ok: true };
  },
  'POST /v1/contacts/search': (c) => depuis(schemaCorpsRecherche.safeParse(c)),
  'PATCH /v1/contacts/{contactId}': (c) => depuis(schemaCorpsModification.safeParse(c)),
  'POST /v1/sends': (c) => {
    const lu = schemaCorpsEnvoi.safeParse(c);
    if (!lu.success) return depuis(lu);
    const params = validateParamMapping(lu.data.params ?? [], { accepterVariables: true });
    if (params === null) return { ok: false, raison: 'params : positions 1..N contiguës et sources valides attendues' };
    const cible = lireCible(lu.data, params);
    if ('message' in cible) return { ok: false, raison: cible.message };
    const destinataires: Array<{ variables?: unknown }> = [];
    for (const [i, brut] of lu.data.recipients.entries()) {
      const d = schemaDestinataireEnvoi.safeParse(brut);
      if (!d.success) { const v = depuis(d); return { ok: false, raison: `recipients.${i} : ${v.ok ? '' : v.raison}` }; }
      destinataires.push(d.data);
    }
    const type = TYPES_DE_CIBLE.find((k) => k in lu.data.target);
    if (type === undefined) return { ok: false, raison: 'target : cible inconnue' };
    const fautif = destinataireAvecVariablesInterdites(type, destinataires);
    if (fautif !== null) return { ok: false, raison: `recipients.${fautif}.variables : refusées sur un scénario ou un bloc` };
    return { ok: true };
  },
  'POST /v1/messages/whatsapp': (c) => depuis(schemaMessageWhatsapp.safeParse(c)),
  'POST /v1/messages/rcs': (c) => depuis(schemaMessageRcs.safeParse(c)),
};

/**
 * LES OUTILS TIERS QUE LA DOCUMENTATION NE NOMME PAS (décision de Julien du 2026-09-24) : elle sert à tous
 * les intégrateurs. « batch » est cherché sans égard à la casse et hors d'un chemin, pour laisser passer
 * `/v1/contacts/batch` (même règle que le test du lot 6, qui relira ces fichiers). Les deux derniers motifs
 * sont le vocabulaire propre à un outil, qui le trahirait sans le nommer.
 */
export const OUTILS_TIERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Batch', /(?<![/\w])batch(?!\w)/i],
  ['Brevo', /Brevo/i],
  ['Salesforce', /Salesforce|SFMC/],
  ['Splio', /Splio/i],
  ['HubSpot', /HubSpot/i],
  ['Klaviyo', /Klaviyo/i],
  ['Braze', /Braze/i],
  ['Zapier', /Zapier/i],
  ['smsmode', /smsmode/i],
  ['custom_id', /custom_id/],
  ['Universal Channel', /Universal Channel/i],
];

describe('🔴 chaque corps d’exemple passe le validateur de SA route', () => {
  it.each(Object.entries(EXEMPLES_CORPS))('%s', (_cle, exemple) => {
    const verdict = VALIDATEURS[exemple.route](exemple.corps);
    expect(verdict, `${exemple.route} refuse l’exemple : ${verdict.ok ? '' : verdict.raison}`).toEqual({ ok: true });
  });

  it('chaque route qui prend un corps a au moins un exemple à l’écran', () => {
    const montrees = new Set(Object.values(EXEMPLES_CORPS).map((e) => e.route));
    for (const route of Object.keys(VALIDATEURS)) expect(montrees.has(route as RouteAvecCorps), route).toBe(true);
  });

  /**
   * LA GARDE DE LA GARDE : un validateur qui accepterait tout ferait passer les cas ci-dessus sans rien
   * prouver. Chaque corps cassé ici l'est d'une façon que la SPEC refuse, et chacun est refusé par une règle
   * de la ROUTE (schéma, `lireCible`, règle des variables), jamais par une copie écrite dans ce fichier.
   */
  const CASSES: Array<{ route: RouteAvecCorps; corps: unknown; pourquoi: string }> = [
    { route: 'POST /v1/contacts', corps: { ...EXEMPLES_CORPS.contactCreer.corps, consent: 'oui' }, pourquoi: 'consent vaut opted_in ou opted_out' },
    { route: 'POST /v1/contacts/batch', corps: { contacts: 'crm-7781' }, pourquoi: 'contacts est un tableau (le conteneur de la route)' },
    { route: 'POST /v1/contacts/batch', corps: { contacts: [{ ...EXEMPLES_CORPS.contactCreer.corps, consent: 'oui' }] }, pourquoi: 'chaque élément passe le schéma d’un contact' },
    { route: 'POST /v1/contacts/search', corps: { phone: '+33612345678', externalId: 'crm-7781' }, pourquoi: 'une recherche porte exactement une clé' },
    { route: 'PATCH /v1/contacts/{contactId}', corps: { fields: 'ville=Lyon' }, pourquoi: 'fields est un objet' },
    { route: 'POST /v1/sends', corps: { ...EXEMPLES_CORPS.envoiTemplate.corps, recipients: ['+33612345678'] }, pourquoi: 'un destinataire est un objet, plus un numéro' },
    { route: 'POST /v1/sends', corps: { ...EXEMPLES_CORPS.envoiTemplate.corps, category: 'utility' }, pourquoi: 'la catégorie d’un template est lue chez Meta, jamais donnée' },
    {
      route: 'POST /v1/sends',
      corps: { ...EXEMPLES_CORPS.envoiScenario.corps, recipients: [{ externalId: 'crm-7781', variables: { a: 'b' } }] },
      pourquoi: 'un scénario n’a aucun endroit où ranger des variables',
    },
    { route: 'POST /v1/messages/whatsapp', corps: { externalId: 'crm-7781' }, pourquoi: 'le texte manque' },
    { route: 'POST /v1/messages/rcs', corps: { ...EXEMPLES_CORPS.messageRcs.corps, text: 'a'.repeat(BORNES.texteRcs + 1) }, pourquoi: 'texte trop long' },
  ];
  it.each(CASSES)('refusé : $pourquoi', ({ route, corps }) => {
    expect(VALIDATEURS[route](corps).ok).toBe(false);
  });

  it('aucun exemple ne porte d’apostrophe droite : la commande curl met le corps entre apostrophes', () => {
    for (const [cle, e] of Object.entries(EXEMPLES_CORPS)) expect(JSON.stringify(e.corps).includes("'"), cle).toBe(false);
  });
});

describe('les codes documentés sont ceux du serveur', () => {
  type CodeDocumenteNom = (typeof CODES_DOCUMENTES)[number]['code'];
  /** Chaque code documenté existe côté serveur : sinon cette affectation ne compile pas. */
  const connus: readonly CodeApi[] = CODES_DOCUMENTES.map((c) => c.code);
  /** Et chaque code du serveur est documenté : sinon le type n'est pas `true`, et il NOMME le code oublié. */
  type NonDocumentes = Exclude<CodeApi, CodeDocumenteNom>;
  const exhaustif: [NonDocumentes] extends [never] ? true : NonDocumentes = true;

  it('la parité avec CodeApi tient (au typage), et aucun code n’est documenté deux fois', () => {
    expect(exhaustif).toBe(true);
    expect(new Set(connus).size).toBe(CODES_DOCUMENTES.length);
  });

  it('un code sans statut d’erreur n’existe qu’en motif d’écart', () => {
    for (const c of CODES_DOCUMENTES) if (c.statut === null) expect(c.ecart, c.code).toBe(true);
  });
});

describe('les bornes affichées sont celles des routes', () => {
  it('lot, destinataires, écarts détaillés : les constantes des routes', () => {
    expect(BORNES.contactsParLot).toBe(MAX_BATCH);
    expect(BORNES.destinatairesParEnvoi).toBe(MAX_RECIPIENTS);
    expect(BORNES.ecartsDetailles).toBe(MAX_SKIPPED_REPORT);
  });

  it('longueurs de texte et d’identifiant externe : ce que les validateurs acceptent, pas un caractère de plus', () => {
    const wa = EXEMPLES_CORPS.messageWhatsapp.corps;
    expect(schemaMessageWhatsapp.safeParse({ ...wa, text: 'a'.repeat(BORNES.texteWhatsapp) }).success).toBe(true);
    expect(schemaMessageWhatsapp.safeParse({ ...wa, text: 'a'.repeat(BORNES.texteWhatsapp + 1) }).success).toBe(false);
    const rcs = EXEMPLES_CORPS.messageRcs.corps;
    expect(schemaMessageRcs.safeParse({ ...rcs, text: 'a'.repeat(BORNES.texteRcs) }).success).toBe(true);
    expect(schemaMessageRcs.safeParse({ ...rcs, text: 'a'.repeat(BORNES.texteRcs + 1) }).success).toBe(false);
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(BORNES.externalId) }).success).toBe(true);
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(BORNES.externalId + 1) }).success).toBe(false);
  });

  it('débit et destinataires par envoi : ce que le schéma de l’envoi accepte, pas une unité de plus', () => {
    const corps = EXEMPLES_CORPS.envoiTemplate.corps;
    // Spec § 3 : `ratePerMinute` hors de 1 à 80 rend 400, donc la borne vit dans le schéma de l'envoi.
    expect(schemaCorpsEnvoi.safeParse({ ...corps, ratePerMinute: BORNES.debitParMinute }).success).toBe(true);
    expect(schemaCorpsEnvoi.safeParse({ ...corps, ratePerMinute: BORNES.debitParMinute + 1 }).success).toBe(false);
    expect(schemaCorpsEnvoi.safeParse({ ...corps, ratePerMinute: 0 }).success).toBe(false);
    const un = corps.recipients[0];
    expect(schemaCorpsEnvoi.safeParse({ ...corps, recipients: Array(BORNES.destinatairesParEnvoi).fill(un) }).success).toBe(true);
    expect(schemaCorpsEnvoi.safeParse({ ...corps, recipients: Array(BORNES.destinatairesParEnvoi + 1).fill(un) }).success).toBe(false);
  });
});

/**
 * LES RÉPONSES MONTRÉES ONT LE TYPE DE CE QUE LEURS ROUTES RENDENT (au typage, donc à `npm run typecheck`).
 *
 * `Lecture<T>` : un exemple écrit `as const` est en lecture seule à toute profondeur, on le compare donc au
 * type du producteur rendu en lecture seule. Un champ MANQUANT ou MAL TYPÉ ne compile pas ; `MemesCles`
 * ferme l'autre sens (un champ EN TROP), que l'affectation seule laisserait passer, et nomme la clé fautive.
 *
 * ⚠️ Deux réponses restent sans producteur typé, parce que leurs routes les rendent par un objet littéral :
 * `messageEnvoye` (`{ messageId, conversationId, channel }`) et `contactModifie` (`{ contactId }`). Les
 * réponses de catalogue sont comparées plus bas à ce que produisent les fonctions de la tâche 3.
 */
type Lecture<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<Lecture<U>>
  : T extends object ? { readonly [K in keyof T]: Lecture<T[K]> } : T;
type MemesCles<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
  ? true
  : [enTrop: Exclude<keyof A, keyof B>, manquant: Exclude<keyof B, keyof A>];

const suivi: Lecture<SuiviEnvoiApi> = EXEMPLES_REPONSES.envoiSuivi;
const suiviCles: MemesCles<typeof EXEMPLES_REPONSES.envoiSuivi, SuiviEnvoiApi> = true;
const suiviLigneCles: MemesCles<(typeof EXEMPLES_REPONSES.envoiSuivi.recipients)[number], SuiviEnvoiApi['recipients'][number]> = true;
const cree: Lecture<RapportEnvoi> = EXEMPLES_REPONSES.envoiCree;
const creeCles: MemesCles<typeof EXEMPLES_REPONSES.envoiCree, RapportEnvoi> = true;
const fiche: Lecture<FicheApi> = EXEMPLES_REPONSES.contactLu;
const ficheCles: MemesCles<typeof EXEMPLES_REPONSES.contactLu, FicheApi> = true;
const trouve: Lecture<{ contact: FicheApi | null }> = EXEMPLES_REPONSES.contactTrouve;
const lot: ReadonlyArray<Lecture<ResultatFiche>> = EXEMPLES_REPONSES.contactsLot.results;
const ecrit: Lecture<Pick<Extract<ResultatFiche, { status: 'created' | 'updated' }>, 'contactId' | 'status'>> = EXEMPLES_REPONSES.contactEcrit;

describe('les réponses montrées ont le type de leurs producteurs', () => {
  it('suivi d’un envoi, rapport 201, fiche lue, recherche, lot, écriture (tenus au typage)', () => {
    expect([suiviCles, suiviLigneCles, creeCles, ficheCles]).toEqual([true, true, true, true]);
    expect([suivi, cree, fiche, trouve, lot, ecrit].every((v) => v !== null)).toBe(true);
  });
});

describe('les réponses de catalogue montrées ont EXACTEMENT les champs que la route rend', () => {
  const cles = (o: object): string[] => Object.keys(o).sort();

  it('templates', () => {
    const [rendu] = catalogueTemplates([{
      id: 'x', name: 'a', status: 'APPROVED', category: 'UTILITY', language: 'fr', body: 'Bonjour {{1}}',
      headerFormat: null, isCarousel: false, editable: true,
    }], []);
    expect(cles(EXEMPLES_REPONSES.templates)).toEqual(['templates']);
    expect(cles(EXEMPLES_REPONSES.templates.templates[0])).toEqual(cles(rendu!));
    expect(cles(EXEMPLES_REPONSES.templates.templates[0].variables[0])).toEqual(cles(rendu!.variables[0]!));
  });

  it('scénarios', () => {
    const [rendu] = catalogueScenarios([{ code: 'scn_x', name: 'a', publishedAt: null, graph: { nodes: [], edges: [] } }]);
    expect(cles(EXEMPLES_REPONSES.scenarios)).toEqual(['scenarios']);
    for (const s of EXEMPLES_REPONSES.scenarios.scenarios) expect(cles(s)).toEqual(cles(rendu!));
  });

  it('messages RCS', () => {
    const [rendu] = catalogueMessagesRcs([{ name: 'a', content: { kind: 'text', text: 'Bonjour' } }]);
    expect(cles(EXEMPLES_REPONSES.messagesRcs)).toEqual(['rcsMessages']);
    expect(cles(EXEMPLES_REPONSES.messagesRcs.rcsMessages[0])).toEqual(cles(rendu!));
  });
});

describe('🔴 le module d’exemples ne nomme aucun outil tiers', () => {
  const module = readFileSync(new URL('../web/lib/api-exemples.ts', import.meta.url), 'utf8');
  it.each(OUTILS_TIERS.map(([nom, motif]) => ({ nom, motif })))('$nom', ({ motif }) => {
    expect(module).not.toMatch(motif);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-exemples.test.ts`
Expected: FAIL au chargement, `Failed to load url ../web/lib/api-exemples`.

- [ ] **Step 3: Écrire le module**

```ts
// web/lib/api-exemples.ts
/**
 * LES EXEMPLES DE LA PAGE « Documentation API », ses codes et ses bornes. Rien d'autre.
 *
 * 🔴 UN MODULE, PAS DU TEXTE DANS LA PAGE, et c'est tout son intérêt : `tests/api-exemples.test.ts` passe
 * chaque corps aux règles de SA route (schéma zod, règles de cible). La page ne peut donc plus montrer un corps
 * que le serveur refuse. La même suite tient les codes égaux à ceux du serveur, les bornes égales à ce que
 * les routes acceptent, et les réponses typées par ce que les routes rendent.
 *
 * ⚠️ AUCUN IMPORT : ce fichier est lu par le build de la console ET par la suite de tests racine. Tirer un
 * module serveur ici l'embarquerait dans le bundle du navigateur, et un alias `@/` ne se résout pas depuis
 * la racine.
 *
 * 🔴 AUCUN OUTIL TIERS NOMMÉ, ni ici ni dans la page (décision de Julien du 2026-09-24) : la documentation
 * sert à tous les intégrateurs. Les identifiants d'exemple sont neutres. La suite le vérifie.
 *
 * ⚠️ AUCUNE APOSTROPHE DROITE dans un corps : la page en fait des commandes curl, dont le corps est entre
 * apostrophes. Le français s'écrit ici avec l'apostrophe typographique.
 */

export type Bilingue = readonly [fr: string, en: string];

/** Les routes qui prennent un corps. Chacune a son validateur dans la suite, et au moins un exemple ici. */
export type RouteAvecCorps =
  | 'POST /v1/contacts'
  | 'POST /v1/contacts/batch'
  | 'POST /v1/contacts/search'
  | 'PATCH /v1/contacts/{contactId}'
  | 'POST /v1/sends'
  | 'POST /v1/messages/whatsapp'
  | 'POST /v1/messages/rcs';

export interface ExempleCorps {
  readonly route: RouteAvecCorps;
  readonly corps: unknown;
}

const CONTACT_ID = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const CONTACT_ID_2 = '7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c';
const SEND_ID = '0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d';
const CONVERSATION_ID = 'c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b';
const SCENARIO = 'scn_k3f9qa_01j8z3m4v6x7y8z9a0b1c2d3e4';
const BLOC = 'nod_k3f9qa_01j8z3n5w7x8y9z0a1b2c3d4e5';

export const EXEMPLES_CORPS = {
  contactCreer: {
    route: 'POST /v1/contacts',
    corps: {
      phone: '+33612345678',
      externalId: 'crm-7781',
      name: 'Camille Roy',
      fields: { ville: 'Lyon' },
      tags: ['prospect'],
      consent: 'opted_in',
      consentSource: 'formulaire-site',
    },
  },
  contactsLot: {
    route: 'POST /v1/contacts/batch',
    corps: {
      contacts: [
        { phone: '+33612345678', externalId: 'crm-7781' },
        { phone: '+33698765432', externalId: 'crm-7782', consent: 'opted_out', consentSource: 'desinscription-email' },
      ],
    },
  },
  contactRechercher: {
    route: 'POST /v1/contacts/search',
    corps: { externalId: 'crm-7781' },
  },
  contactModifier: {
    route: 'PATCH /v1/contacts/{contactId}',
    corps: {
      fields: { ville: 'Grenoble', code_promo: null },
      addTags: ['client'],
      removeTags: ['prospect'],
      consent: 'opted_out',
      consentSource: 'centre-de-preferences',
    },
  },
  envoiTemplate: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'confirmation-8412',
      target: { template: { name: 'confirmation_commande', language: 'fr' } },
      recipients: [
        { externalId: 'crm-7781', phone: '+33612345678', consent: 'opted_in', variables: { commande: '8412' } },
        { contactId: CONTACT_ID_2, variables: { commande: '8413' } },
      ],
      params: [
        { position: 1, source: { type: 'field', key: 'prenom' } },
        { position: 2, source: { type: 'variable', key: 'commande' } },
      ],
      ratePerMinute: 20,
    },
  },
  envoiScenario: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'bienvenue-crm-7781-2026-09-24',
      target: { scenario: SCENARIO },
      category: 'marketing',
      recipients: [{ externalId: 'crm-7781' }],
    },
  },
  envoiBloc: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'relance-fenetre-crm-7781-2026-09-24',
      target: { node: BLOC },
      category: 'utility',
      recipients: [{ contactId: CONTACT_ID }],
    },
  },
  envoiRcs: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'rappel-rdv-crm-7781-2026-09-24',
      target: { rcsMessage: 'rappel-rdv' },
      category: 'utility',
      recipients: [{ externalId: 'crm-7781', variables: { date_rdv: 'jeudi 25 septembre à 14 h' } }],
    },
  },
  messageWhatsapp: {
    route: 'POST /v1/messages/whatsapp',
    corps: { externalId: 'crm-7781', text: 'Votre commande 8412 est prête, vous pouvez passer la retirer.' },
  },
  messageRcs: {
    route: 'POST /v1/messages/rcs',
    corps: { phone: '+33612345678', text: 'Votre rendez-vous de jeudi 14 h est confirmé.' },
  },
  outilParContact: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'relance-panier-crm-7781-etape-3-2026-09-24',
      target: { template: { name: 'relance_panier', language: 'fr' } },
      recipients: [{
        externalId: 'crm-7781',
        phone: '+33612345678',
        consent: 'opted_in',
        consentSource: 'outil-marketing',
        variables: { produit: 'Veste en lin' },
      }],
      params: [{ position: 1, source: { type: 'variable', key: 'produit' } }],
    },
  },
} as const satisfies Record<string, ExempleCorps>;

const CONTACT_LU = {
  contactId: CONTACT_ID,
  externalId: 'crm-7781',
  phone: '+33612345678',
  bsuid: null,
  name: 'Camille Roy',
  fields: { ville: 'Lyon' },
  tags: ['prospect'],
  consent: { status: 'opted_in', source: 'formulaire-site', optedOutAt: null },
  rcsOptedOutAt: null,
  blocked: false,
  reachability: { whatsapp: true, rcs: null },
  createdAt: '2026-09-24T10:00:00.000Z',
} as const;

export const EXEMPLES_REPONSES = {
  contactEcrit: { contactId: CONTACT_ID, status: 'created' },
  contactsLot: {
    results: [
      { index: 0, status: 'updated', contactId: CONTACT_ID },
      { index: 1, status: 'created', contactId: CONTACT_ID_2 },
    ],
    created: 1,
    updated: 1,
    errors: 0,
  },
  contactLu: CONTACT_LU,
  contactTrouve: { contact: CONTACT_LU },
  contactModifie: { contactId: CONTACT_ID },
  messageEnvoye: { messageId: 'wamid.exemple-8412', conversationId: CONVERSATION_ID, channel: 'whatsapp' },
  envoiCree: {
    sendId: SEND_ID,
    opening: 'whatsapp_template',
    recipientCount: 1,
    created: 0,
    matched: 2,
    skipped: [{ index: 1, reason: 'opted_out' }],
    skippedTotal: 1,
  },
  envoiSuivi: {
    sendId: SEND_ID,
    status: 'running',
    target: { template: { name: 'confirmation_commande', language: 'fr' } },
    opening: 'whatsapp_template',
    createdAt: '2026-09-24T10:00:00.000Z',
    counts: { pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 },
    recipients: [{
      contactId: CONTACT_ID,
      externalId: 'crm-7781',
      channel: 'whatsapp',
      status: 'sent',
      messageId: 'wamid.exemple-8412',
      delivery: 'delivered',
      error: null,
      sentAt: '2026-09-24T10:00:04.000Z',
    }],
  },
  templates: {
    templates: [{
      name: 'confirmation_commande',
      language: 'fr',
      category: 'utility',
      header: 'none',
      variables: [
        { position: 1, source: { type: 'field', key: 'prenom' } },
        { position: 2, source: null },
      ],
    }],
  },
  scenarios: {
    scenarios: [
      { code: SCENARIO, name: 'Bienvenue', opening: 'whatsapp_template', publishedAt: '2026-09-20T08:30:00.000Z' },
      { code: 'scn_k3f9qa_01j8z3p6x8y9z0a1b2c3d4e5f6', name: 'Relance dans la fenêtre', opening: 'whatsapp_session', publishedAt: null },
    ],
  },
  messagesRcs: {
    rcsMessages: [{ name: 'rappel-rdv', kind: 'card', variables: ['prenom', 'date_rdv'] }],
  },
  erreur: { error: 'fenêtre de 24 h fermée : ce contact n’a pas écrit récemment', code: 'window_closed' },
} as const;

/**
 * Un code d'erreur tel que la page le documente. `statut` null = il n'arrive QUE comme motif d'écart d'un
 * envoi, jamais en erreur. La suite tient cette table égale à `CodeApi` (`src/api/erreurs.ts`) dans les deux
 * sens.
 */
export interface CodeDocumente {
  readonly code: string;
  readonly statut: number | null;
  readonly ecart: boolean;
  readonly quoi: Bilingue;
}

export const CODES_DOCUMENTES = [
  { code: 'invalid_body', statut: 400, ecart: false, quoi: ['Corps mal formé. Le message nomme le champ fautif.', 'Malformed body. The message names the faulty field.'] },
  { code: 'invalid_recipient', statut: 400, ecart: true, quoi: ['Aucune clé de fiche (contactId, externalId, phone, bsuid).', 'No record key (contactId, externalId, phone, bsuid).'] },
  { code: 'invalid_phone', statut: 400, ecart: true, quoi: ['Numéro illisible.', 'Unreadable phone number.'] },
  { code: 'unauthorized', statut: 401, ecart: false, quoi: ['Clé absente, mal formée, inconnue ou révoquée.', 'Key missing, malformed, unknown or revoked.'] },
  { code: 'missing_scope', statut: 403, ecart: false, quoi: ['La clé n’a pas le droit que la route exige.', 'The key lacks the scope the route requires.'] },
  { code: 'tenant_locked', statut: 403, ecart: false, quoi: ['Espace suspendu : la clé est valide, mais l’espace ne peut plus rien lire ni envoyer par l’API. Inutile de refaire une clé.', 'Workspace suspended: the key is valid, but the workspace can no longer read or send through the API. No need to create a new key.'] },
  { code: 'unknown_contact', statut: 404, ecart: true, quoi: ['Aucune fiche ne correspond, et la route n’en crée pas.', 'No record matches, and the route does not create one.'] },
  { code: 'duplicate', statut: null, ecart: true, quoi: ['Le même destinataire figure deux fois dans l’envoi.', 'The same recipient appears twice in the send.'] },
  { code: 'identity_conflict', statut: 409, ecart: true, quoi: ['Les clés données désignent deux fiches différentes, ou cet identifiant externe est déjà porté par une autre fiche. Rien n’est écrit.', 'The keys given designate two different records, or this external id is already carried by another record. Nothing is written.'] },
  { code: 'blocked_contact', statut: 409, ecart: true, quoi: ['Fiche bloquée.', 'Blocked record.'] },
  { code: 'opted_out', statut: 409, ecart: true, quoi: ['Désabonné, en général, ou du RCS pour un envoi RCS.', 'Opted out, in general, or from RCS for an RCS send.'] },
  { code: 'no_consent', statut: 409, ecart: true, quoi: ['Consentement manquant : envoi marketing vers qui n’est pas opted_in, ou RCS libre vers qui n’a ni consenti ni écrit.', 'Missing consent: a marketing send to someone not opted_in, or a free RCS to someone who neither consented nor wrote.'] },
  { code: 'window_closed', statut: 422, ecart: true, quoi: ['Fenêtre de 24 h fermée : seul un template peut partir.', '24-hour window closed: only a template can go out.'] },
  { code: 'missing_variable', statut: null, ecart: true, quoi: ['Une variable manque pour ce destinataire, sans valeur de repli.', 'A variable is missing for this recipient, with no fallback.'] },
  { code: 'no_phone', statut: 422, ecart: true, quoi: ['Fiche sans numéro, alors que le RCS l’exige.', 'Record without a phone number, which RCS requires.'] },
  { code: 'rcs_unreachable', statut: 422, ecart: false, quoi: ['Ce numéro n’est pas joignable en RCS (appris d’un envoi précédent).', 'This number is not reachable over RCS (learned from a previous send).'] },
  { code: 'rcs_not_enabled', statut: 409, ecart: false, quoi: ['Le canal RCS n’est pas actif sur cet espace.', 'The RCS channel is not active on this workspace.'] },
  { code: 'no_whatsapp_number', statut: 409, ecart: false, quoi: ['Aucun numéro WhatsApp sur cet espace.', 'No WhatsApp number on this workspace.'] },
  { code: 'scenario_not_found', statut: 404, ecart: false, quoi: ['Scénario introuvable.', 'Scenario not found.'] },
  { code: 'node_not_found', statut: 404, ecart: false, quoi: ['Bloc introuvable.', 'Block not found.'] },
  { code: 'template_not_found', statut: 404, ecart: false, quoi: ['Template absent, ou pas encore approuvé.', 'Template missing, or not approved yet.'] },
  { code: 'rcs_message_not_found', statut: 404, ecart: false, quoi: ['Message RCS introuvable dans la bibliothèque.', 'RCS message not found in the library.'] },
  { code: 'send_not_found', statut: 404, ecart: false, quoi: ['Envoi inconnu.', 'Unknown send.'] },
  { code: 'scenario_ambiguous', statut: 409, ecart: false, quoi: ['Plusieurs scénarios portent ce nom : utilisez le code scn_.', 'Several scenarios have this name: use the scn_ code.'] },
  { code: 'unsendable_target', statut: 422, ecart: false, quoi: ['La cible ne peut pas partir ainsi. Le message dit pourquoi.', 'The target cannot go out like this. The message says why.'] },
  { code: 'template_category_unknown', statut: 422, ecart: false, quoi: ['Catégorie du template illisible chez Meta : l’envoi est refusé plutôt que deviné.', 'The template category cannot be read at Meta: the send is refused rather than guessed.'] },
  { code: 'idempotency_key_required', statut: 400, ecart: false, quoi: ['Clé d’idempotence absente (en-tête ou corps).', 'Idempotency key missing (header or body).'] },
  { code: 'idempotency_in_progress', statut: 409, ecart: false, quoi: ['Un envoi avec cette clé est en cours.', 'A send with this key is in progress.'] },
  { code: 'idempotency_key_reused', statut: 422, ecart: false, quoi: ['Cette clé a déjà servi pour un AUTRE corps.', 'This key was already used for a DIFFERENT body.'] },
  { code: 'rate_limited', statut: 429, ecart: false, quoi: ['Débit dépassé : attendez la durée de retry-after.', 'Rate limit exceeded: wait for retry-after.'] },
] as const satisfies readonly CodeDocumente[];

export type NomDeCode = (typeof CODES_DOCUMENTES)[number]['code'];

/**
 * Les bornes que la page annonce. Toutes sont tenues par la suite (constantes des routes, et ce que leurs
 * schémas acceptent, `debitParMinute` compris) SAUF les deux dernières : `dureeIdempotenceHeures` vit dans le
 * balayage du worker, `debitParCle` est le défaut de `API_KEY_RATE_LIMIT_MAX` (`src/config.ts`, qu'un test ne
 * charge pas sans environnement). Les relire à la main quand l'une de ces deux valeurs change.
 */
export const BORNES = {
  contactsParLot: 500,
  destinatairesParEnvoi: 50,
  ecartsDetailles: 200,
  texteWhatsapp: 4096,
  texteRcs: 3072,
  externalId: 512,
  debitParMinute: 80,
  dureeIdempotenceHeures: 24,
  debitParCle: 60,
} as const;
```

- [ ] **Step 4: Voir passer**

Run: `npx vitest run tests/api-exemples.test.ts && npm run typecheck && cd web && npx tsc --noEmit`
Expected: PASS aux trois. Un exemple refusé nomme sa route et le chemin fautif : c'est l'EXEMPLE qui se
corrige (selon la spec), jamais le validateur. Un code manquant fait échouer `npm run typecheck` sur
`exhaustif` en nommant le code. Une réponse d'exemple qui ne compile pas contre son producteur (`suivi`,
`cree`, `fiche`…) se corrige de même ; si c'est le PRODUCTEUR qui contredit la spec, le signaler à Julien
comme un écart du lot qui l'écrit, sans toucher à l'exemple.

- [ ] **Step 5: Vérifier dans les deux sens**

1. Dans `contactCreer`, remplacer `consent: 'opted_in'` par `consent: 'oui'` : le cas `contactCreer` échoue
   avec `POST /v1/contacts refuse l’exemple : consent : …`. Restaurer.
2. Dans `envoiScenario`, ajouter `variables: { a: 'b' }` au destinataire : le cas `envoiScenario` échoue avec
   `recipients.0.variables : refusées sur un scénario ou un bloc` (c'est la règle du lot 3 qui refuse, pas une
   copie). Restaurer.
3. Ajouter au commentaire d'en-tête du module la ligne ` * Conçu pour batch.` (minuscule) : le cas « Batch »
   du dernier bloc échoue. Restaurer.
4. Retirer la ligne `rate_limited` de `CODES_DOCUMENTES` : `npm run typecheck` échoue sur `exhaustif`
   (`Type 'true' is not assignable to type '"rate_limited"'`). Restaurer.
5. Ajouter `pays: 'FR',` à `CONTACT_LU` : `npm run typecheck` échoue sur `ficheCles` (le tuple nomme
   `"pays"` en trop). Restaurer.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/julie/messagingme-mba && git add -N web/lib/api-exemples.ts tests/api-exemples.test.ts && \
git diff -- web/lib/api-exemples.ts tests/api-exemples.test.ts && \
git commit --only web/lib/api-exemples.ts tests/api-exemples.test.ts \
  -m "feat(doc-api): module d exemples de la documentation, passe aux validateurs des routes" \
  -m "Exemples passes aux regles des routes, reponses typees par leurs producteurs, codes egaux a CodeApi au typage, bornes tenues par les schemas. Aucune page ne le rend encore : la page suit le deploiement de l API." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

### Task 6: Revue, CI, et déploiement de l'API du lot 4

Aucune ligne de code. Cette tâche existe parce que les deux suivantes n'ont pas le droit de partir avant
elle (la console se publie à chaque `git push`).

- [ ] **Step 1: `/revue`** sur le diff des tâches 1 à 5 (`git log --oneline origin/main` pour les bornes),
  section « Rayon de souffle » comprise (reprendre celle de ce plan). Corriger les 🔴 ET les 🟡 avant de
  continuer.
- [ ] **Step 2: Lire la CI du dernier commit de CODE** (`gh run list --limit 5`, puis
  `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'`) : tous les jobs en `success`, et
  `git log <déployé>..origin/main --oneline` relu.
- [ ] **Step 3: `/revue-finale`**, qui écrit l'attestation que la garde de déploiement exige.
- [ ] **Step 4: Déployer** selon la section « Déploiement » (aucune migration pour ce lot).
- [ ] **Step 5: Contrôle public** : les trois adresses EXISTENT (401 sans clé ; un 404 voudrait dire que la
  route n'est pas déployée) :

```bash
for p in templates scenarios rcs-messages; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://api.messagingme.app/v1/$p"
done
curl -s -o /dev/null -w '%{http_code}\n' https://api.messagingme.app/health
```

Expected : `401` trois fois, `200` pour la santé. Un 502 : `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`
sur le VPS, puis recontrôler.

---

### Task 7: La page Documentation API réécrite (après la tâche 6, jamais avant)

🔴 **Ne pas COMMITER cette tâche avant que l'API des lots 1 à 4 soit déployée et contrôlée (tâche 6)** : un
commit sur `main` finit poussé (par soi ou par un pair), et Vercel publie la console à chaque push. Une page
qui décrit des routes que la production n'a pas tromperait l'intégrateur qui la lit.

**Files:**
- Modify (réécriture complète) : `web/app/developers/api/page.tsx` (280 lignes aujourd'hui)
- Create: `web/e2e/developers-api.spec.ts`
- Modify: `tests/api-exemples.test.ts` (un bloc de plus)

**Interfaces:**
- Consumes : `BORNES`, `CODES_DOCUMENTES`, `EXEMPLES_CORPS`, `EXEMPLES_REPONSES`, `NomDeCode`
  (`@/lib/api-exemples`) ; `BASE` (`@/lib/http`) ; `useT` (`@/lib/i18n`) ; `AppShell`.
- Produces : la page, ses sections d'identifiants stables (`#authentification`, `#debit`, `#identite`,
  `#contacts`, `#message-simple`, `#envoi`, `#catalogues`, `#outil`, `#erreurs`, `#exemples`) et
  `data-testid="code-<code>"` sur chaque ligne de la table des codes.

- [ ] **Step 1: Écrire les tests de la page (source et rendu)**

Ajouter à la fin de `tests/api-exemples.test.ts` :

```ts
describe('la page Documentation API', () => {
  const page = readFileSync(new URL('../web/app/developers/api/page.tsx', import.meta.url), 'utf8');
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 elle n’écrit aucun objet JSON à la main : tout corps et toute réponse viennent du module', () => {
    // Un `{ "clé": …` dans la page est un exemple que la suite ne verrait pas, donc un exemple qui peut mentir.
    expect(code).not.toMatch(/\{\s*\\?"[A-Za-z_]+\\?"\s*:/);
  });

  it('🔴 elle affiche CHAQUE exemple du module', () => {
    for (const cle of Object.keys(EXEMPLES_CORPS)) expect(code, `EXEMPLES_CORPS.${cle} n’est affiché nulle part`).toContain(`EXEMPLES_CORPS.${cle}`);
    for (const cle of Object.keys(EXEMPLES_REPONSES)) expect(code, `EXEMPLES_REPONSES.${cle} n’est affiché nulle part`).toContain(`EXEMPLES_REPONSES.${cle}`);
  });

  it('elle dérive toujours son adresse de BASE (la règle de web/lib/api-base.test.ts)', () => {
    expect(code).toMatch(/const ADRESSE_API = BASE\./);
  });

  it.each(OUTILS_TIERS.map(([nom, motif]) => ({ nom, motif })))('🔴 elle ne nomme pas $nom', ({ motif }) => {
    expect(page).not.toMatch(motif);
  });
});
```

Et créer `web/e2e/developers-api.spec.ts` :

```ts
import { test, expect } from '@playwright/test';
import { CODES_DOCUMENTES } from '../lib/api-exemples';

/**
 * La page Documentation API, RENDUE.
 *
 * La suite racine (`tests/api-exemples.test.ts`) vérifie la SOURCE : exemples validés, aucun JSON écrit à
 * la main, aucun outil tiers nommé. Ici, on vérifie ce qu'un intégrateur VOIT : les familles de routes, la
 * section d'appel par contact, chaque code, et toujours aucun outil tiers dans le texte affiché.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Developers : la documentation de l’API', () => {
  test('🔴 les familles de routes, l’appel par contact et chaque code sont à l’écran', async ({ page }) => {
    await mock(page);
    await page.goto('/developers/api');
    // Borné au CONTENU de la page : la barre latérale de la console a ses propres libellés.
    const doc = page.getByTestId('doc-api');
    for (const titre of [
      'Désigner une personne', 'Contacts', 'Envoyer un message simple', 'Déclencher un envoi',
      'Ce que vous pouvez envoyer', 'Brancher un outil qui appelle par contact', 'Erreurs', 'Exemples complets',
    ]) {
      await expect(doc.getByRole('heading', { name: titre, exact: true })).toBeVisible();
    }
    for (const c of CODES_DOCUMENTES) await expect(doc.getByTestId(`code-${c.code}`)).toBeVisible();
  });

  test('🔴 la page rendue ne nomme aucun outil tiers', async ({ page }) => {
    await mock(page);
    await page.goto('/developers/api');
    const doc = page.getByTestId('doc-api');
    await expect(doc.getByRole('heading', { name: 'Documentation API', exact: true })).toBeVisible();
    // ⚠️ Le CONTENU de la page, pas `body` : la barre latérale nomme d'autres écrans de la console (une
    // intégration CRM y a sa page), ce qui ferait échouer ce cas pour une raison étrangère à la doc.
    const texte = await doc.innerText();
    expect(texte).not.toMatch(/(?<![/\w])batch(?!\w)/i);
    expect(texte).not.toMatch(/custom_id|Universal Channel|Brevo|Salesforce|Splio|HubSpot|Klaviyo|Braze|Zapier|smsmode/i);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-exemples.test.ts`
Expected: FAIL sur « aucun objet JSON à la main » (l'ancienne page porte `{ "contactId": "...", …` et le
corps de `POST /v1/sends` en dur) et sur « CHAQUE exemple » (`EXEMPLES_CORPS.contactCreer n’est affiché nulle
part`).

- [ ] **Step 3: Réécrire la page** (remplacer TOUT le contenu de `web/app/developers/api/page.tsx`)

```tsx
'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { BASE } from '@/lib/http';
import { BORNES, CODES_DOCUMENTES, EXEMPLES_CORPS, EXEMPLES_REPONSES, type NomDeCode } from '@/lib/api-exemples';

/**
 * L'adresse PUBLIQUE de l'API, telle qu'un intégrateur doit la taper.
 *
 * ⚠️ Dérivée de la MÊME source que les appels de la console (`BASE`), jamais réécrite à la main : une adresse
 * en dur, recopiée par un intégrateur après une bascule d'hébergement, l'aurait mené sur un chemin mort qu'il
 * aurait découvert en production, chez lui. `web/lib/api-base.test.ts` le garde.
 *
 * Le repli conserve l'adresse historique tant que la variable n'est pas posée : le préfixe `/api/backend` est
 * alors juste, puisque c'est bien le proxy qui sert l'API.
 */
const ADRESSE_API = BASE.startsWith('http') ? BASE : 'https://mba.messagingme.app/api/backend';

/**
 * Documentation de l'API publique /v1 (réécrite le 2026-09-24, lot 4 de la spec de l'API cohérente).
 *
 * 🔴 LES EXEMPLES NE S'ÉCRIVENT PAS ICI. Chaque corps et chaque réponse vient de `@/lib/api-exemples`, et
 * `tests/api-exemples.test.ts` passe chaque corps au validateur de SA route : la page ne peut plus montrer un
 * corps que le serveur refuse. Le même test refuse un objet JSON écrit en dur dans ce fichier.
 *
 * 🔴 AUCUN OUTIL TIERS NOMMÉ (décision de Julien du 2026-09-24) : cette page sert à tous les intégrateurs. La
 * suite racine le vérifie sur la source, `web/e2e/developers-api.spec.ts` sur la page rendue.
 *
 * ⚠️ Le TEXTE reste écrit à la main à partir des routes (`src/http/v1-*.ts`) : une règle qui change côté
 * serveur ne change pas ici toute seule. Les codes cités passent par `<Code>`, typé sur la table des codes :
 * un code inventé ne compile pas.
 */
export default function ApiDocsPage() {
  return <AppShell active="api-docs">{() => <DocsInner />}</AppShell>;
}

const codeCls = 'overflow-x-auto rounded-lg bg-ink-900 px-4 py-3 font-mono text-xs leading-relaxed text-ink-50';
const inlineCls = 'rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.8em] text-ink-800';
const CLE_EXEMPLE = 'mba_xxxxxxxxxxxxxxxx';

/** Un exemple du module, indenté pour être lu. */
const json = (v: unknown): string => JSON.stringify(v, null, 2);

/**
 * Une commande prête à copier. Le corps part entre apostrophes droites : la suite refuse donc toute
 * apostrophe droite dans un exemple, qui fermerait la chaîne du shell au milieu du JSON.
 */
function curl(chemin: string, corps: unknown): string {
  return [
    `curl -X POST ${ADRESSE_API}${chemin} \\`,
    `  -H "Authorization: Bearer ${CLE_EXEMPLE}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify(corps)}'`,
  ].join('\n');
}

function Section({ id, titre, children }: { id: string; titre: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{titre}</h3>
      <div className="mt-3 space-y-3 text-sm text-ink-700">{children}</div>
    </section>
  );
}

function SousTitre({ children }: { children: React.ReactNode }) {
  return <h4 className="pt-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{children}</h4>;
}

function Verb({ method, path, droit }: { method: 'GET' | 'POST' | 'PATCH'; path: string; droit: string }) {
  return (
    <p className="font-mono text-xs">
      <span className="rounded bg-brand-50 px-1.5 py-0.5 font-semibold text-brand-700">{method}</span>
      <span className="ml-2 text-ink-800">{path}</span>
      <span className="ml-2 text-ink-400">{droit}</span>
    </p>
  );
}

function C({ children }: { children: React.ReactNode }) {
  return <code className={inlineCls}>{children}</code>;
}

/** Un code d'erreur cité dans le texte : typé sur la table des codes, donc un code inventé ne compile pas. */
function Code({ c }: { c: NomDeCode }) {
  return <code className={inlineCls}>{c}</code>;
}

function Bloc({ children }: { children: string }) {
  return <pre className={codeCls}>{children}</pre>;
}

function Tableau({ entetes, lignes }: { entetes: string[]; lignes: Array<{ cle: string; cellules: React.ReactNode[] }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-ink-100">
            {entetes.map((e) => <th key={e} className="py-2 pr-4 text-xs font-semibold text-ink-500">{e}</th>)}
          </tr>
        </thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l.cle} className="border-b border-ink-50 last:border-0">
              {l.cellules.map((c, i) => <td key={i} className="py-2 pr-4 align-top text-ink-700">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocsInner() {
  const t = useT();
  const ecarts = CODES_DOCUMENTES.filter((c) => c.ecart);

  // `doc-api` borne les vérifications de l'e2e au CONTENU de la page : la barre latérale de la console nomme
  // d'autres écrans (dont des intégrations), et ne doit pas faire échouer la règle « aucun outil tiers ».
  return (
    <div className="max-w-3xl space-y-4" data-testid="doc-api">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Documentation API', 'API documentation')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'Une API REST pour tenir vos fiches à jour et faire partir des messages depuis vos propres outils.',
            'A REST API to keep your contact records up to date and send messages from your own tools.',
          )}{' '}
          <Link href="/developers/keys" className="text-brand-600 hover:underline">{t('Gérer les clés', 'Manage keys')}</Link>
        </p>
        <p className="mt-2 text-sm text-ink-500">
          {t(
            'Deux familles de routes : envoyer un message simple (un texte, à une personne, tout de suite), ou déclencher un envoi (un template, un scénario ou un message RCS, vers une liste de destinataires).',
            'Two families of routes: send a plain message (one text, to one person, right away), or trigger a send (a template, a scenario or an RCS message, to a list of recipients).',
          )}
        </p>
      </div>

      <Section id="authentification" titre={t('Adresse et authentification', 'Base URL and authentication')}>
        <p>{t('Toutes les routes sont sous :', 'All routes live under:')}</p>
        <Bloc>{`${ADRESSE_API}/v1`}</Bloc>
        <p>
          {t(
            'Chaque appel porte sa clé dans l’en-tête Authorization. L’espace est déduit de la clé : aucune adresse ne porte d’identifiant d’espace.',
            'Every call carries its key in the Authorization header. The workspace is derived from the key: no URL ever carries a workspace id.',
          )}
        </p>
        <Bloc>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
        <p className="text-ink-500">
          {t(
            'Une valeur qui ne commence pas par mba_ est refusée sans être comparée en base. Clé absente ou invalide : 401',
            'A value not starting with mba_ is refused without being checked against the database. Missing or invalid key: 401',
          )}{' '}
          <Code c="unauthorized" />{t(' ; droit manquant : 403 ', '; missing scope: 403 ')}<Code c="missing_scope" />
          {t(' ; espace suspendu : 403 ', '; workspace suspended: 403 ')}<Code c="tenant_locked" />
          {t(' (la clé reste bonne : inutile d’en refaire une).', ' (the key is still valid: no need to create a new one).')}
        </p>
        <Tableau
          entetes={[t('Droit', 'Scope'), t('Ce qu’il ouvre', 'What it opens')]}
          lignes={[
            { cle: 'contacts:write', cellules: [<C key="d">contacts:write</C>, t('Créer et modifier des fiches : POST /v1/contacts, POST /v1/contacts/batch, PATCH /v1/contacts/{contactId}.', 'Create and update records: POST /v1/contacts, POST /v1/contacts/batch, PATCH /v1/contacts/{contactId}.')] },
            { cle: 'contacts:read', cellules: [<C key="d">contacts:read</C>, t('Lire et retrouver une fiche : GET /v1/contacts/{contactId}, POST /v1/contacts/search.', 'Read and find a record: GET /v1/contacts/{contactId}, POST /v1/contacts/search.')] },
            { cle: 'sends:create', cellules: [<C key="d">sends:create</C>, t('Envoyer, et lire ce qu’on peut envoyer : /v1/messages/whatsapp, /v1/messages/rcs, /v1/sends, /v1/templates, /v1/scenarios, /v1/rcs-messages.', 'Send, and read what can be sent: /v1/messages/whatsapp, /v1/messages/rcs, /v1/sends, /v1/templates, /v1/scenarios, /v1/rcs-messages.')] },
          ]}
        />
        <p className="text-ink-500">
          {t(
            'Les droits d’une clé se fixent à sa création : pour un droit de plus, créez une clé neuve.',
            'A key’s scopes are set when it is created: for an extra scope, create a new key.',
          )}
        </p>
      </Section>

      <Section id="debit" titre={t('Débit', 'Rate limit')}>
        <p>
          {t(
            `Par défaut ${BORNES.debitParCle} requêtes par minute et par clé. Chaque réponse comptée sur votre clé porte l’état de son compteur :`,
            `By default ${BORNES.debitParCle} requests per minute per key. Every response counted against your key carries its counter state:`,
          )}
        </p>
        <Bloc>{`x-ratelimit-limit: ${BORNES.debitParCle}\nx-ratelimit-remaining: 57\nx-ratelimit-reset: 1750000000`}</Bloc>
        <p>
          {t('Au dépassement : 429', 'On overflow: 429')} <Code c="rate_limited" />{' '}
          {t(
            'avec un en-tête retry-after (en secondes). Une clé inconnue (401) ne porte aucun de ces en-têtes. Le compteur est tenu en mémoire du serveur : il repart à zéro à chaque redéploiement.',
            'with a retry-after header (seconds). An unknown key (401) carries none of these headers. The counter is held in server memory: it resets on every redeploy.',
          )}
        </p>
      </Section>

      <Section id="identite" titre={t('Désigner une personne', 'Identifying a person')}>
        <p>
          {t(
            'Une personne est une FICHE. Vous la désignez par ce que vous avez, et ces clés ne servent qu’à la trouver :',
            'A person is a RECORD. You designate it with whatever you have, and these keys only serve to find it:',
          )}
        </p>
        <Tableau
          entetes={[t('Clé', 'Key'), t('Ce que c’est', 'What it is')]}
          lignes={[
            { cle: 'contactId', cellules: [<C key="k">contactId</C>, t('L’identifiant de la fiche, créé avec elle. Il s’affiche sur la fiche du mini-CRM (« Identifiant API », avec un bouton Copier).', 'The record id, created with it. It shows on the mini-CRM record (“API identifier”, with a Copy button).')] },
            { cle: 'externalId', cellules: [<C key="k">externalId</C>, t(`L’identifiant de la personne dans VOTRE outil (CRM, plateforme marketing), gardé sur la fiche. Unique par espace, ${BORNES.externalId} caractères au plus.`, `The person’s id in YOUR tool (CRM, marketing platform), kept on the record. Unique per workspace, ${BORNES.externalId} characters at most.`)] },
            { cle: 'phone', cellules: [<C key="k">phone</C>, t('Le numéro, au format international (+33…). Un numéro sans indicatif est lu comme français.', 'The phone number, in international format (+33…). A number without a country code is read as French.')] },
            { cle: 'bsuid', cellules: [<C key="k">bsuid</C>, t('L’identifiant WhatsApp d’une personne qui écrit sous un nom d’utilisateur, sans numéro visible.', 'The WhatsApp id of a person writing under a username, with no visible number.')] },
          ]}
        />
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('Au moins une clé, sinon', 'At least one key, otherwise')} <Code c="invalid_recipient" />.</li>
          <li>
            {t('Toutes les clés données désignent LA MÊME fiche, sinon', 'All the keys given must designate THE SAME record, otherwise')}{' '}
            <Code c="identity_conflict" /> {t('et rien n’est écrit.', 'and nothing is written.')}
          </li>
          <li>
            {t(
              'Une clé que la fiche ne porte pas encore lui est RATTACHÉE : envoyer votre externalId avec le numéro suffit à le poser. contactId, lui, ne se rattache jamais : il existe, ou il est inconnu.',
              'A key the record does not carry yet is ATTACHED to it: sending your externalId along with the phone number is enough to set it. contactId is never attached: it exists, or it is unknown.',
            )}
          </li>
          <li>
            {t(
              'Aucune fiche trouvée : elle est créée seulement si la route crée, et si un phone ou un bsuid est donné. Sinon',
              'No record found: one is created only if the route creates records, and only if a phone or a bsuid is given. Otherwise',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
          <li>
            {t(
              'L’adresse d’envoi vient toujours de la FICHE, jamais de la clé reçue : en WhatsApp, le numéro, sinon le BSUID ; en RCS, le numéro, toujours (une fiche sans numéro est refusée en',
              'The sending address always comes from the RECORD, never from the key received: on WhatsApp, the phone number, otherwise the BSUID; on RCS, the phone number, always (a record without a number is refused with',
            )}{' '}
            <Code c="no_phone" />).
          </li>
        </ul>
      </Section>

      <Section id="contacts" titre={t('Contacts', 'Contacts')}>
        <Verb method="POST" path="/v1/contacts" droit="contacts:write" />
        <Bloc>{json(EXEMPLES_CORPS.contactCreer.corps)}</Bloc>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'La fiche se trouve par les règles ci-dessus, et cette route CRÉE : une fiche neuve exige phone ou bsuid. Un externalId seul et inconnu rend 404',
              'The record is found by the rules above, and this route CREATES records: a new record requires phone or bsuid. An unknown externalId alone returns 404',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
          <li>{t('fields : adressés par clé technique ou par code fld_. Un champ inconnu est créé en texte.', 'fields: addressed by technical key or by fld_ code. An unknown field is created as text.')}</li>
          <li>{t('tags : ils s’AJOUTENT, n’en retirent jamais (pour retirer, PATCH).', 'tags: they are ADDED, never removed (to remove, use PATCH).')}</li>
          <li>
            {t(
              'consent : opted_in ou opted_out, absent = inchangé. opted_out est un vrai désabonnement (statut, date, trace dans le journal d’audit). opted_in ne lève JAMAIS un STOP : sur une fiche désabonnée, 409 opted_out, et rien n’est modifié ; seul un opérateur ou la personne elle-même peut la réabonner. consentSource dit d’où vient le consentement.',
              'consent: opted_in or opted_out, absent = unchanged. opted_out is a real opt-out (status, date, audit log entry). opted_in NEVER lifts a STOP: on an opted-out contact, 409 opted_out, and nothing is changed; only an operator or the person themselves can re-subscribe them. consentSource says where the consent comes from.',
            )}
          </li>
        </ul>
        <p>{t('Réponse 200 :', '200 response:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.contactEcrit)}</Bloc>

        <Verb method="POST" path="/v1/contacts/batch" droit="contacts:write" />
        <Bloc>{json(EXEMPLES_CORPS.contactsLot.corps)}</Bloc>
        <p>
          {t(
            `${BORNES.contactsParLot} fiches au plus par lot, le même corps par élément. Un élément refusé ne fait pas tomber le lot : chaque résultat porte l’index de son élément. Réponse 200 :`,
            `${BORNES.contactsParLot} records at most per call, the same body per item. A refused item does not sink the others: each result carries its item’s index. 200 response:`,
          )}
        </p>
        <Bloc>{json(EXEMPLES_REPONSES.contactsLot)}</Bloc>

        <Verb method="GET" path="/v1/contacts/{contactId}" droit="contacts:read" />
        <Bloc>{json(EXEMPLES_REPONSES.contactLu)}</Bloc>
        <p>
          {t(
            'reachability : true ou false quand on le sait (un envoi l’a appris), null sinon. Une fiche inconnue ou supprimée rend 404',
            'reachability: true or false when known (a send taught us), null otherwise. An unknown or deleted record returns 404',
          )}{' '}
          <Code c="unknown_contact" />.
        </p>

        <Verb method="POST" path="/v1/contacts/search" droit="contacts:read" />
        <Bloc>{json(EXEMPLES_CORPS.contactRechercher.corps)}</Bloc>
        <p>
          {t(
            'Exactement une clé parmi phone, bsuid, externalId : c’est une recherche, rien n’est rattaché. Le numéro voyage dans le corps, jamais dans l’adresse, qui s’inscrirait dans les journaux d’accès. Réponse 200, contact vaut null quand rien ne correspond :',
            'Exactly one key among phone, bsuid, externalId: it is a lookup, nothing is attached. The phone number travels in the body, never in the URL, which would end up in access logs. 200 response, contact is null when nothing matches:',
          )}
        </p>
        <Bloc>{json(EXEMPLES_REPONSES.contactTrouve)}</Bloc>

        <Verb method="PATCH" path="/v1/contacts/{contactId}" droit="contacts:write" />
        <Bloc>{json(EXEMPLES_CORPS.contactModifier.corps)}</Bloc>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('Tout est optionnel : name, fields, addTags, removeTags, consent, consentSource, externalId.', 'Everything is optional: name, fields, addTags, removeTags, consent, consentSource, externalId.')}</li>
          <li>{t('Dans fields, une valeur null VIDE le champ ; les autres se fusionnent.', 'In fields, a null value CLEARS the field; the others are merged.')}</li>
          <li>
            {t('externalId se pose ou se remplace ; déjà porté par une autre fiche : 409', 'externalId is set or replaced; already carried by another record: 409')}{' '}
            <Code c="identity_conflict" />.
          </li>
          <li>{t('Le numéro et le BSUID ne se modifient pas ici : ils portent les conversations.', 'The phone number and BSUID cannot be changed here: they carry the conversations.')}</li>
        </ul>
        <p>{t('Réponse 200 :', '200 response:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.contactModifie)}</Bloc>
      </Section>

      <Section id="message-simple" titre={t('Envoyer un message simple', 'Send a plain message')}>
        <p>
          {t(
            'Un TEXTE, à UNE personne, tout de suite. Le message apparaît dans l’Inbox, et écrire PREND le fil : le scénario cesse d’avancer seul, l’agent de Meta cesse de répondre. La personne doit déjà avoir une fiche : ces routes n’en créent pas. Pas de clé d’idempotence : rejouer l’appel envoie un second message.',
            'One TEXT, to ONE person, right away. The message shows in the Inbox, and writing TAKES the thread: the scenario stops advancing on its own, the Meta agent stops replying. The person must already have a record: these routes do not create one. No idempotency key: replaying the call sends a second message.',
          )}
        </p>
        <p>{t('Réponse 200 des deux routes :', '200 response of both routes:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.messageEnvoye)}</Bloc>

        <SousTitre>WhatsApp</SousTitre>
        <Verb method="POST" path="/v1/messages/whatsapp" droit="sends:create" />
        <Bloc>{json(EXEMPLES_CORPS.messageWhatsapp.corps)}</Bloc>
        <p>
          {t(
            `Une clé de fiche, et un texte de ${BORNES.texteWhatsapp} caractères au plus. Les refus, dans l’ordre : fiche inconnue 404`,
            `A record key, and a text of ${BORNES.texteWhatsapp} characters at most. Refusals, in order: unknown record 404`,
          )}{' '}
          <Code c="unknown_contact" />, {t('bloquée 409', 'blocked 409')} <Code c="blocked_contact" />,{' '}
          {t('désabonnée 409', 'opted out 409')} <Code c="opted_out" />, {t('espace sans numéro WhatsApp 409', 'workspace without a WhatsApp number 409')}{' '}
          <Code c="no_whatsapp_number" />, {t('fenêtre de 24 h fermée 422', '24-hour window closed 422')} <Code c="window_closed" />.
        </p>
        <p className="text-ink-500">
          {t(
            'La fenêtre de 24 h est une règle de Meta : elle s’ouvre quand la personne vous écrit et se referme 24 h après son dernier message. Hors fenêtre, le seul chemin est un template (POST /v1/sends).',
            'The 24-hour window is a Meta rule: it opens when the person writes to you and closes 24 hours after their last message. Outside it, the only path is a template (POST /v1/sends).',
          )}
        </p>

        <SousTitre>RCS</SousTitre>
        <Verb method="POST" path="/v1/messages/rcs" droit="sends:create" />
        <Bloc>{json(EXEMPLES_CORPS.messageRcs.corps)}</Bloc>
        <p>
          {t(
            `Même corps, texte de ${BORNES.texteRcs} caractères au plus, et pas de fenêtre. Les conditions, dans l’ordre :`,
            `Same body, text of ${BORNES.texteRcs} characters at most, and no window. The conditions, in order:`,
          )}
        </p>
        <Tableau
          entetes={[t('Condition', 'Condition'), t('Sinon', 'Otherwise')]}
          lignes={[
            { cle: 'fiche', cellules: [t('La fiche existe', 'The record exists'), <span key="r">404 <Code c="unknown_contact" /></span>] },
            { cle: 'numero', cellules: [t('Elle porte un numéro', 'It carries a phone number'), <span key="r">422 <Code c="no_phone" /></span>] },
            { cle: 'bloque', cellules: [t('Elle n’est pas bloquée', 'It is not blocked'), <span key="r">409 <Code c="blocked_contact" /></span>] },
            { cle: 'desabonne', cellules: [t('Elle n’est pas désabonnée, ni en général ni du RCS', 'It is not opted out, neither in general nor from RCS'), <span key="r">409 <Code c="opted_out" /></span>] },
            { cle: 'consentement', cellules: [t('Elle a consenti (opted_in), ou elle vous a déjà écrit', 'It consented (opted_in), or it already wrote to you'), <span key="r">409 <Code c="no_consent" /></span>] },
            { cle: 'canal', cellules: [t('Le canal RCS est actif sur l’espace', 'The RCS channel is active on the workspace'), <span key="r">409 <Code c="rcs_not_enabled" /></span>] },
            { cle: 'joignable', cellules: [t('Elle n’est pas connue comme injoignable en RCS', 'It is not known as unreachable over RCS'), <span key="r">422 <Code c="rcs_unreachable" /></span>] },
          ]}
        />
        <p className="text-ink-500">
          {t(
            'La joignabilité RCS ne se connaît qu’après coup : le premier message vers un numéro sans RCS est accepté, son échec est enregistré (visible dans Sécurité > Journal des erreurs), et le suivant est refusé en',
            'RCS reachability is only known afterwards: the first message to a number without RCS is accepted, its failure is recorded (visible in Security > Error log), and the next one is refused with',
          )}{' '}
          <Code c="rcs_unreachable" />.
        </p>
      </Section>

      <Section id="envoi" titre={t('Déclencher un envoi', 'Trigger a send')}>
        <p>
          {t(
            `Un envoi est un LOT : ${BORNES.destinatairesParEnvoi} destinataires au plus, asynchrone, idempotent, visible dans Campagnes, et suivi par GET /v1/sends/{sendId}.`,
            `A send is a LIST: ${BORNES.destinatairesParEnvoi} recipients at most, asynchronous, idempotent, visible in Campaigns, and followed with GET /v1/sends/{sendId}.`,
          )}
        </p>
        <Verb method="POST" path="/v1/sends" droit="sends:create" />
        <Bloc>{json(EXEMPLES_CORPS.envoiTemplate.corps)}</Bloc>

        <SousTitre>{t('La cible, et le canal qu’elle donne', 'The target, and the channel it gives')}</SousTitre>
        <Tableau
          entetes={[t('Cible', 'Target'), t('Désignée par', 'Designated by'), t('Canal', 'Channel')]}
          lignes={[
            { cle: 'template', cellules: [<C key="c">template</C>, t('le nom et la langue d’un template approuvé', 'the name and language of an approved template'), 'WhatsApp'] },
            { cle: 'scenario', cellules: [<C key="c">scenario</C>, t('son code scn_ ou son nom', 'its scn_ code or its name'), t('celui de son premier envoi', 'that of its first send')] },
            { cle: 'node', cellules: [<C key="c">node</C>, t('le code nod_ d’un bloc (Contenu > Blocs)', 'the nod_ code of a block (Content > Blocks)'), t('celui de son premier envoi', 'that of its first send')] },
            { cle: 'rcsMessage', cellules: [<C key="c">rcsMessage</C>, t('le nom d’un message de Contenu > Messages RCS', 'the name of a message in Content > RCS messages'), 'RCS'] },
          ]}
        />

        <SousTitre>{t('Ce qu’un scénario ou un bloc envoie en premier', 'What a scenario or a block sends first')}</SousTitre>
        <p>
          {t(
            'Ce n’est pas le type du bloc visé qui compte, c’est le PREMIER message qu’il fait partir. La réponse le rend dans opening :',
            'What counts is not the type of the targeted block, it is the FIRST message it sends. The response returns it in opening:',
          )}
        </p>
        <Tableau
          entetes={[t('Premier envoi atteint', 'First send reached'), 'opening', t('Règle', 'Rule')]}
          lignes={[
            { cle: 'template', cellules: [t('un template', 'a template'), <C key="o">whatsapp_template</C>, t('part vers quelqu’un qui n’a pas écrit', 'goes to someone who has not written')] },
            { cle: 'rcs', cellules: [t('un bloc RCS', 'an RCS block'), <C key="o">rcs</C>, <span key="r">{t('part vers quelqu’un qui n’a pas écrit ; une fiche sans numéro est écartée', 'goes to someone who has not written; a record without a number is skipped')} <Code c="no_phone" /></span>] },
            { cle: 'session', cellules: [t('un message rapide, une question, un formulaire, un agent', 'a quick message, a question, a form, an agent'), <C key="o">whatsapp_session</C>, <span key="r">{t('fenêtre de 24 h exigée pour chaque destinataire, sinon', '24-hour window required for each recipient, otherwise')} <Code c="window_closed" /></span>] },
            { cle: 'aucun', cellules: [t('une attente avant tout envoi, rien, plusieurs templates possibles, un template sans nom', 'a wait before any send, nothing, several possible templates, an unnamed template'), t('(aucun)', '(none)'), <span key="r">{t('refusé avant l’envoi : 422', 'refused before sending: 422')} <Code c="unsendable_target" />{t(', la raison dans le message', ', the reason in the message')}</span>] },
          ]}
        />
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'Un SCÉNARIO dont l’ouverture est whatsapp_session est refusé : pour parler à quelqu’un dans sa fenêtre, visez son premier bloc (node). Un scénario jamais publié est refusé aussi : un envoi joue la version publiée.',
              'A SCENARIO whose opening is whatsapp_session is refused: to talk to someone within their window, target its first block (node). A never-published scenario is refused too: a send plays the published version.',
            )}
          </li>
          <li>{t('Un BLOC admet les trois ouvertures.', 'A BLOCK accepts all three openings.')}</li>
          <li>{t('Prudence : si UNE branche peut envoyer un message de session, la fenêtre est exigée pour tous.', 'Caution: if ONE branch can send a session message, the window is required for everyone.')}</li>
        </ul>

        <SousTitre>{t('Les destinataires', 'Recipients')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              `recipients : ${BORNES.destinatairesParEnvoi} au plus, chacun avec ses clés de fiche (contactId, externalId, phone, bsuid), et en option consent, consentSource et variables.`,
              `recipients: ${BORNES.destinatairesParEnvoi} at most, each with its record keys (contactId, externalId, phone, bsuid), and optionally consent, consentSource and variables.`,
            )}
          </li>
          <li>
            {t(
              'L’envoi CRÉE la fiche d’un destinataire inconnu qui porte un phone (un template ou un RCS part vers quelqu’un qui n’a pas écrit), sauf pour une ouverture whatsapp_session, où il est écarté faute de fenêtre possible. Un inconnu qui ne porte qu’un bsuid est écarté aussi :',
              'The send CREATES the record of an unknown recipient carrying a phone (a template or an RCS goes to someone who has not written), except for a whatsapp_session opening, where it is skipped since no window is possible. An unknown recipient carrying only a bsuid is skipped too:',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
          <li>
            {t(
              'consent par destinataire : écrit sur la fiche AVANT le tri, avec le même sens que sur /v1/contacts. Un opted_out désabonne et écarte ce destinataire. consentSource absent vaut api.',
              'Per-recipient consent: written on the record BEFORE filtering, with the same meaning as on /v1/contacts. An opted_out opts the record out and skips this recipient. A missing consentSource defaults to api.',
            )}
          </li>
          <li>
            {t('Un destinataire mal formé est écarté (', 'A malformed recipient is skipped (')}<Code c="invalid_recipient" />, <Code c="invalid_phone" />
            {t('), il ne fait pas tomber l’envoi.', '), it does not sink the send.')}
          </li>
          <li>
            {t(
              'Aucune perte silencieuse : chaque destinataire écarté l’est avec son motif et son index dans recipients. Les motifs :',
              'No silent loss: every skipped recipient comes with its reason and its index in recipients. The reasons:',
            )}{' '}
            {ecarts.map((c, i) => <span key={c.code}>{i > 0 ? ', ' : ''}<Code c={c.code} /></span>)}.
          </li>
        </ul>

        <SousTitre>{t('Les variables par destinataire', 'Per-recipient variables')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('variables : un objet clé vers texte, propre à ce destinataire, jamais écrit sur la fiche.', 'variables: a key to text object, specific to this recipient, never written on the record.')}</li>
          <li>
            {t('Template : la source de paramètre', 'Template: the parameter source')}{' '}
            <C>{JSON.stringify(EXEMPLES_CORPS.envoiTemplate.corps.params[1].source)}</C>{' '}
            {t('lit variables.commande. Absente et sans fallback, le destinataire est écarté', 'reads variables.commande. Missing and without a fallback, the recipient is skipped with')}{' '}
            <Code c="missing_variable" />.
          </li>
          <li>
            {t('Message RCS :', 'RCS message:')} <C>{'{{commande}}'}</C>{' '}
            {t('prend variables.commande en priorité, puis le champ de fiche du même nom.', 'takes variables.commande first, then the record field of the same name.')}
          </li>
          <li>
            {t('Scénario et bloc : variables et params sont refusés (400', 'Scenario and block: variables and params are refused (400')} <Code c="invalid_body" />
            {t(') : un parcours n’a pas d’endroit où les ranger.', '): a journey has nowhere to store them.')}
          </li>
        </ul>

        <SousTitre>{t('Catégorie, numéro, débit', 'Category, number, throughput')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t('Template : la catégorie est lue chez Meta, vous ne la donnez pas (le champ category est refusé). Illisible : 422', 'Template: the category is read at Meta, you do not give it (the category field is refused). Unreadable: 422')}{' '}
            <Code c="template_category_unknown" />. {t('Template absent ou non approuvé : 404', 'Template missing or not approved: 404')} <Code c="template_not_found" />.
          </li>
          <li>
            {t(
              'Scénario, bloc, message RCS : category (marketing ou utility) est obligatoire. marketing écarte tout destinataire qui n’est pas opted_in',
              'Scenario, block, RCS message: category (marketing or utility) is required. marketing skips every recipient who is not opted_in',
            )}{' '}
            (<Code c="no_consent" />){t(' ; utility n’écarte que les désabonnés.', '; utility only skips opted-out recipients.')}
          </li>
          <li>
            {t(
              'Numéro WhatsApp : phoneNumberId est optionnel, absent c’est le numéro par défaut de l’espace. Un template, un scénario ou un bloc exige un numéro WhatsApp ; un message RCS part de l’agent RCS de l’espace et n’en demande pas (un phoneNumberId donné avec une cible rcsMessage est ignoré).',
              'WhatsApp number: phoneNumberId is optional, when absent the workspace’s default number is used. A template, a scenario or a block requires a WhatsApp number; an RCS message goes out from the workspace’s RCS agent and needs none (a phoneNumberId given with an rcsMessage target is ignored).',
            )}
          </li>
          <li>
            {t(
              `ratePerMinute : un entier de 1 à ${BORNES.debitParMinute}, sinon 400. Le plafond réel du canal s’applique ensuite, il peut être plus bas.`,
              `ratePerMinute: an integer from 1 to ${BORNES.debitParMinute}, otherwise 400. The channel’s real cap applies afterwards, and may be lower.`,
            )}
          </li>
        </ul>

        <SousTitre>{t('Idempotence', 'Idempotency')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'La clé est OBLIGATOIRE, en en-tête (Idempotency-Key) OU dans le corps (idempotencyKey). Les deux présentes et différentes : 400',
              'The key is REQUIRED, as a header (Idempotency-Key) OR in the body (idempotencyKey). Both present and different: 400',
            )}{' '}
            <Code c="invalid_body" />. {t('Sans clé : 400', 'No key: 400')} <Code c="idempotency_key_required" />.
          </li>
          <li>
            {t(
              'La même clé avec le même corps rend le rapport du premier appel sans rien renvoyer : un nouvel essai réseau est sans danger. La même clé avec un AUTRE corps : 422',
              'The same key with the same body returns the first call’s report without sending anything again: a network retry is safe. The same key with a DIFFERENT body: 422',
            )}{' '}
            <Code c="idempotency_key_reused" />. {t('Pendant que le premier appel s’exécute : 409', 'While the first call is running: 409')}{' '}
            <Code c="idempotency_in_progress" />.
          </li>
          <li>
            {t(
              `Une clé vit ${BORNES.dureeIdempotenceHeures} h (parfois un peu plus, jamais moins).`,
              `A key lives ${BORNES.dureeIdempotenceHeures} h (sometimes a little longer, never less).`,
            )}
          </li>
        </ul>
        <Bloc>{`Idempotency-Key: ${EXEMPLES_CORPS.envoiTemplate.corps.idempotencyKey}`}</Bloc>

        <SousTitre>{t('La réponse 201', 'The 201 response')}</SousTitre>
        <Bloc>{json(EXEMPLES_REPONSES.envoiCree)}</Bloc>
        <p>
          {t(
            `Chaque écart porte l’index du destinataire dans recipients, quelle que soit la clé utilisée. La liste est tronquée à ${BORNES.ecartsDetailles} entrées ; skippedTotal donne le compte réel.`,
            `Each skip carries the recipient’s index in recipients, whatever key was used. The list is capped at ${BORNES.ecartsDetailles} entries; skippedTotal gives the real count.`,
          )}
        </p>

        <Verb method="GET" path="/v1/sends/{sendId}" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.envoiSuivi)}</Bloc>
        <p>
          {t(
            'Le statut de l’envoi, ses compteurs, et une ligne par destinataire. error vaut un objet message et metaCode quand un envoi a échoué. Pour un scénario ou un bloc, la ligne décrit le DÉPART du parcours et channel son canal d’ouverture ; la suite se lit dans la console. Envoi inconnu : 404',
            'The send’s status, its counters, and one row per recipient. error is an object with message and metaCode when a send failed. For a scenario or a block, the row describes the START of the journey and channel its opening channel; the rest is read in the console. Unknown send: 404',
          )}{' '}
          <Code c="send_not_found" />.
        </p>

        <SousTitre>{t('Les autres cibles', 'The other targets')}</SousTitre>
        <p>{t('Un scénario, un bloc dans la fenêtre, un message RCS de la bibliothèque :', 'A scenario, a block within the window, an RCS message from the library:')}</p>
        <Bloc>{json(EXEMPLES_CORPS.envoiScenario.corps)}</Bloc>
        <Bloc>{json(EXEMPLES_CORPS.envoiBloc.corps)}</Bloc>
        <Bloc>{json(EXEMPLES_CORPS.envoiRcs.corps)}</Bloc>
      </Section>

      <Section id="catalogues" titre={t('Ce que vous pouvez envoyer', 'What you can send')}>
        <p>
          {t(
            'Trois lectures, droit sends:create, pour construire un appel sans ouvrir la console. Chaque ligne rendue peut partir par POST /v1/sends.',
            'Three reads, sends:create scope, to build a call without opening the console. Every row returned can go out through POST /v1/sends.',
          )}
        </p>
        <Verb method="GET" path="/v1/templates" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.templates)}</Bloc>
        <p>
          {t(
            'Les templates WhatsApp APPROUVÉS qu’un envoi sait faire partir. N’y figurent pas ceux qu’un envoi refuserait : une catégorie autre que marketing ou utility, un carrousel dont une carte ou un lien porte une variable, un visuel (d’en-tête ou de carte) que nous ne pouvons pas relire. variables liste chaque variable du corps ; source est le champ que la console lui associe quand elle le connaît (null sinon), et il se recopie tel quel dans params. Un carrousel a ses visuels par carte : son header vaut none.',
            'The APPROVED WhatsApp templates a send can deliver. Those a send would refuse are left out: a category other than marketing or utility, a carousel whose card or link carries a variable, a visual (header or card) we cannot read back. variables lists each variable of the body; source is the field the console associates with it when known (null otherwise), and it can be copied as is into params. A carousel has its visuals per card: its header is none.',
          )}
        </p>
        <Verb method="GET" path="/v1/scenarios" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.scenarios)}</Bloc>
        <p>
          {t(
            'Les scénarios PUBLIÉS. opening est calculé par la même règle que POST /v1/sends : null veut dire que ce scénario ne peut pas partir par l’API, whatsapp_session qu’il se vise par son premier bloc (node). publishedAt vaut null pour un scénario mis en ligne avant que cette date soit suivie.',
            'The PUBLISHED scenarios. opening is computed by the same rule as POST /v1/sends: null means this scenario cannot go out through the API, whatsapp_session that it is targeted through its first block (node). publishedAt is null for a scenario put online before that date was tracked.',
          )}
        </p>
        <Verb method="GET" path="/v1/rcs-messages" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.messagesRcs)}</Bloc>
        <p>
          {t(
            'Les messages de Contenu > Messages RCS, désignés par leur nom dans la cible rcsMessage. kind vaut text, card ou carousel ; variables liste les noms entre doubles accolades qu’ils utilisent.',
            'The messages of Content > RCS messages, designated by their name in the rcsMessage target. kind is text, card or carousel; variables lists the names between double braces they use.',
          )}
        </p>
      </Section>

      <Section id="outil" titre={t('Brancher un outil qui appelle par contact', 'Connecting a tool that calls per contact')}>
        <p>
          {t(
            'Une plateforme d’orchestration, un CRM ou un outil marketing appelle souvent un service UNE FOIS PAR CONTACT, avec un corps rempli par les données du profil. Voici l’appel type.',
            'An orchestration platform, a CRM or a marketing tool often calls a service ONCE PER CONTACT, with a body filled from the profile data. Here is the typical call.',
          )}
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('Adresse :', 'URL:')} <C>{`POST ${ADRESSE_API}/v1/sends`}</C></li>
          <li>
            {t('En-tête :', 'Header:')} <C>{`Authorization: Bearer ${CLE_EXEMPLE}`}</C>
            {t(', avec le droit sends:create. Il est le même pour tous les contacts.', ', with the sends:create scope. It is the same for every contact.')}
          </li>
          <li>
            {t(
              'Corps : un destinataire par appel, désigné par VOTRE identifiant (externalId) et son numéro. Nous gardons l’identifiant sur la fiche : c’est lui qui la retrouve aux appels suivants.',
              'Body: one recipient per call, designated by YOUR id (externalId) and their phone number. We keep the id on the record: it is what finds the record on later calls.',
            )}
          </li>
        </ul>
        <Bloc>{json(EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
        <p>{t('Trois points à régler une fois :', 'Three things to set up once:')}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'La clé d’idempotence va dans le CORPS (idempotencyKey) : beaucoup d’outils remplissent le corps contact par contact, pas les en-têtes. Composez-la de l’identifiant du contact ET de ce qui rend CE passage unique (l’étape, la date d’entrée dans le parcours). Faite du seul identifiant du contact, elle ferait prendre le second passage légitime d’un même contact pour un rejeu : il ne partirait pas.',
              'The idempotency key goes in the BODY (idempotencyKey): many tools fill the body per contact, not the headers. Build it from the contact id AND whatever makes THIS pass unique (the step, the journey entry date). Built from the contact id alone, it would make a second legitimate pass of the same contact look like a replay: it would not go out.',
            )}
          </li>
          <li>
            {t(
              'Le consentement vit souvent dans votre outil : passez-le à chaque appel (consent, consentSource). Il est écrit sur la fiche avant le tri ; un opted_out désabonne la fiche et écarte l’envoi.',
              'Consent often lives in your tool: pass it on every call (consent, consentSource). It is written on the record before filtering; an opted_out opts the record out and skips the send.',
            )}
          </li>
          <li>
            {t(
              'variables porte ce qui est propre à ce contact (un numéro de commande, un produit). Rien n’en est écrit sur la fiche.',
              'variables carries what is specific to this contact (an order number, a product). None of it is written on the record.',
            )}
          </li>
        </ul>
        <p>
          {t(
            'Un refus (destinataire écarté, cible introuvable) se lit dans la réponse 201 ou dans le code d’erreur. Si votre outil ne lit pas les réponses, éprouvez l’appel une fois à la main :',
            'A refusal (skipped recipient, target not found) shows in the 201 response or in the error code. If your tool does not read responses, try the call once by hand:',
          )}
        </p>
        <Bloc>{curl('/v1/sends', EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
      </Section>

      <Section id="erreurs" titre={t('Erreurs', 'Errors')}>
        <p>{t('Tout refus de l’API a la même forme :', 'Every refusal from the API has the same shape:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.erreur)}</Bloc>
        <p className="text-ink-500">
          {t(
            'Une seule exception : une PANNE (une réponse 5xx, par exemple quand Meta ne répond pas pendant la lecture de GET /v1/templates) n’a pas ce corps, et peut arriver sous la forme d’une page d’erreur générique. Réessayez dans un instant ; un envoi se rejoue avec la même clé d’idempotence.',
            'One exception only: an OUTAGE (a 5xx response, for instance when Meta does not answer while GET /v1/templates is being read) does not have this body, and may come as a generic error page. Retry in a moment; a send is replayed with the same idempotency key.',
          )}
        </p>
        <p>
          {t(
            'error est une phrase en français, pour un humain ; code est un identifiant stable, pour un programme. Un même refus porte le même code partout, qu’il arrive en erreur ou en motif d’écart d’un envoi. Un défaut de forme est toujours invalid_body, avec le champ fautif dans le message.',
            'error is a sentence in French, for a human; code is a stable identifier, for a program. The same refusal carries the same code everywhere, whether it comes as an error or as a skip reason in a send. A shape defect is always invalid_body, with the faulty field in the message.',
          )}
        </p>
        <p className="text-ink-500">
          {t(
            'Les statuts : 400 corps invalide ; 401 et 403 la clé ; 404 introuvable ; 409 l’état de la fiche ou de l’espace l’interdit ; 422 la demande est juste mais ne peut pas partir ainsi ; 429 le débit.',
            'Statuses: 400 invalid body; 401 and 403 the key; 404 not found; 409 the state of the record or workspace forbids it; 422 the request is valid but cannot go out like this; 429 rate limit.',
          )}
        </p>
        <Tableau
          entetes={[t('Code', 'Code'), t('Erreur', 'Error'), t('Motif d’écart', 'Skip reason'), t('Ce que ça veut dire', 'Meaning')]}
          lignes={CODES_DOCUMENTES.map((c) => ({
            cle: c.code,
            cellules: [
              <code key="c" data-testid={`code-${c.code}`} className={inlineCls}>{c.code}</code>,
              c.statut === null ? '' : String(c.statut),
              c.ecart ? t('oui', 'yes') : '',
              t(c.quoi[0], c.quoi[1]),
            ],
          }))}
        />
      </Section>

      <Section id="exemples" titre={t('Exemples complets', 'Full examples')}>
        <SousTitre>{t('Un message WhatsApp dans la fenêtre', 'A WhatsApp message within the window')}</SousTitre>
        <Bloc>{curl('/v1/messages/whatsapp', EXEMPLES_CORPS.messageWhatsapp.corps)}</Bloc>
        <SousTitre>{t('Un message RCS', 'An RCS message')}</SousTitre>
        <Bloc>{curl('/v1/messages/rcs', EXEMPLES_CORPS.messageRcs.corps)}</Bloc>
        <SousTitre>{t('Un template, avec une variable par destinataire', 'A template, with one variable per recipient')}</SousTitre>
        <Bloc>{curl('/v1/sends', EXEMPLES_CORPS.envoiTemplate.corps)}</Bloc>
        <SousTitre>{t('Un message RCS de la bibliothèque', 'An RCS message from the library')}</SousTitre>
        <Bloc>{curl('/v1/sends', EXEMPLES_CORPS.envoiRcs.corps)}</Bloc>
      </Section>
    </div>
  );
}
```

- [ ] **Step 4: Voir passer (source)**

Run: `npx vitest run tests/api-exemples.test.ts && npm run typecheck && cd web && npx tsc --noEmit && npm run lint && npx vitest run lib/api-base.test.ts`
Expected: PASS partout (`lib/api-base.test.ts` relit la page : `ADRESSE_API` dérivée de `BASE`, aucune adresse
d'API en dur).

- [ ] **Step 5: Voir passer (rendu)**

Annoncer la suite e2e aux autres sessions (deux builds Next concurrents empoisonnent `web/.next`), puis :

Run: `cd web && npx playwright test e2e/developers-api.spec.ts`
Expected: 2 passed. Un `ENOENT` dans `.next` puis « Timed out waiting 180000ms from config.webServer » n'est
pas un défaut du code : `rm -rf web/.next`, puis `npm run build` à la main dans `web/`, puis relancer.

- [ ] **Step 6: Vérifier dans les deux sens**

1. Ajouter dans la page, sous le `<Bloc>` de `/v1/contacts`, la ligne
   `<Bloc>{'{ "phone": "+33612345678" }'}</Bloc>` : le cas « aucun objet JSON à la main » échoue. Retirer.
2. Remplacer, dans le texte d'introduction de « Brancher un outil qui appelle par contact », `un outil
   marketing` par `Batch` : le cas « elle ne nomme pas Batch » échoue, et l'e2e « aucun outil tiers » aussi.
   Restaurer. Même geste avec `batch` en minuscules : les deux échouent encore (le test du lot 6 cherche sans
   égard à la casse). Restaurer.

- [ ] **Step 7: `/revue`, puis `/revue-finale`, AVANT le commit**

Ce commit est un DÉPLOIEMENT : Vercel publie la console à chaque `git push`, et la garde de déploiement ne le
voit pas (`pushDeploie` à `false`). La spec (§ 15) veut `/revue-finale` avant chaque déploiement.
1. `/revue` sur le diff de `web/app/developers/api/page.tsx`, `web/e2e/developers-api.spec.ts` et
   `tests/api-exemples.test.ts`, section « Rayon de souffle » comprise (reprendre celle de ce plan, dont la
   relecture de la page par `web/lib/api-base.test.ts` et par le test du lot 6). Corriger les 🔴 ET les 🟡,
   relancer les étapes 4 et 5.
2. `/revue-finale` sur ce qui part (le diff de ces trois fichiers), puisque le push publie la console.

- [ ] **Step 8: Commit** (seulement si la tâche 6 est close : API déployée et contrôlée, et l'étape 7 faite)

```bash
cd /c/Users/julie/messagingme-mba && git add -N web/e2e/developers-api.spec.ts && \
git diff -- web/app/developers/api/page.tsx web/e2e/developers-api.spec.ts tests/api-exemples.test.ts && \
git commit --only web/app/developers/api/page.tsx web/e2e/developers-api.spec.ts tests/api-exemples.test.ts \
  -m "feat(doc-api): page Documentation API reecrite, exemples tires du module et verifies" \
  -m "Deux familles, designation d une personne, chaque parametre, table des codes (tenant_locked compris), exemples RCS, appel par contact, et l exception des pannes 5xx dite. Aucun outil tiers nomme. Poussee apres le deploiement de l API des lots 1 a 4." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

Puis lire le run `CI front` (`gh run view <id> --json jobs`) : build, lint, typecheck, vitest front, e2e.

---

### Task 8: `features.md`, `documentation.md` (et `todo.md` relu, pas écrit)

**Files:**
- Modify: `features.md` (section `## API publique \`/v1\` (intégrateurs externes)`, lignes 1653 à 1717
  aujourd'hui)
- Modify: `documentation.md` (table « Front » de la § 13, ligne 1549 aujourd'hui)
- Lecture seule : `todo.md`. L'entrée « L'API publique v1 ne sait pas dire « désabonné » » appartient au
  lot 1 (sa tâche 13, étape 3, la retire) : ce lot vérifie seulement qu'elle est partie.

🔴 **Le titre de la section de `features.md` ne change PAS d'un caractère** : `tests/aide-proposer.test.ts`
le liste dans `SECTIONS_SANS_FICHE` (motif `integrateurs`). Le renommer ferait échouer « la liste des sections
sans fiche ne cite aucune section MORTE ».

- [ ] **Step 1: Relire la section actuelle et repérer ce qui n'est pas de l'API**

Run: `awk '/^## API publique `\/v1`/,/^## Brancher vos systèmes/' features.md`
Aujourd'hui, une seule puce étrangère à l'API y vit : « Les fonctions HubSpot disparaissent quand aucun
portail n'est relié » (2026-09-23). Le script ci-dessous la RECOPIE telle quelle ; si la relecture en
trouve une autre, l'ajouter au texte neuf avant de lancer le script.

- [ ] **Step 2: Écrire le texte neuf de la section**

⚠️ L'état du shell ne survit pas d'un appel à l'autre : le dossier de brouillon est un chemin FIXE, écrit en
toutes lettres à chaque étape, hors du dépôt : `C:/Users/julie/AppData/Local/Temp/mba-lot4-doc` (le
scratchpad de la session convient aussi, écrit en entier et identique aux étapes 2 à 4). Le créer
(`mkdir -p C:/Users/julie/AppData/Local/Temp/mba-lot4-doc`), puis écrire avec l'outil Write le fichier
`C:/Users/julie/AppData/Local/Temp/mba-lot4-doc/features-api.md`, EXACTEMENT :

```markdown
## API publique `/v1` (intégrateurs externes)

- ✅ **Clés d'API** (2026-07-17) : un admin crée des clés depuis la console (nom + droits). La clé n'est
  **montrée qu'une fois** à la création (seule son empreinte est stockée). Révocable. Les droits de l'API
  publique : « Écrire des contacts » (`contacts:write`), « Lire les contacts » (`contacts:read`, 2026-09-24) et
  « Déclencher des envois » (`sends:create`, qui couvre aussi les messages simples et les catalogues). Une clé
  peut aussi porter les droits du serveur MCP, décrits dans leur propre section (« Serveur MCP : brancher un
  assistant sur la console »).
  ⚠️ Les droits d'une clé se fixent à sa création et ne s'éditent pas : pour un droit de plus, on crée une clé.
- ✅ **Une personne est une FICHE** (2026-09-24). L'intégrateur la désigne par ce qu'il a : l'identifiant de
  fiche (`contactId`, affiché sur la fiche du mini-CRM sous « Identifiant API » avec un bouton Copier), SON
  identifiant (`externalId`, gardé sur la fiche, unique par espace), le numéro ou le BSUID. Plusieurs clés
  peuvent venir ensemble ; si elles désignent deux fiches différentes, rien n'est écrit (`identity_conflict`).
  Une clé que la fiche ne porte pas encore lui est rattachée. **L'adresse d'envoi vient toujours de la
  fiche**, jamais de la clé reçue : un seul fil par personne.
- ✅ **Contacts** : créer ou compléter une fiche (`POST /v1/contacts`, ou par lots), la lire
  (`GET /v1/contacts/{contactId}`), la retrouver par numéro, BSUID ou identifiant externe
  (`POST /v1/contacts/search`, le numéro voyage dans le corps et jamais dans l'adresse), la modifier
  (`PATCH`, qui sait VIDER un champ et RETIRER une étiquette). Le consentement se dit en clair :
  `consent: "opted_in"` ou `"opted_out"`, et un `opted_out` est un vrai désabonnement (statut, date, trace dans
  le journal d'audit). La lecture rend aussi la joignabilité WhatsApp et RCS quand elle est connue.
  🔴 Un contact mal formé dans un lot est refusé À SA LIGNE, les autres passent, et la réponse nomme le champ
  fautif.
- ✅ **Envoyer un message simple** : un texte, à une personne, tout de suite, visible dans l'Inbox. Deux routes,
  parce que leurs règles n'ont presque rien en commun : `POST /v1/messages/whatsapp` (dans la fenêtre de 24 h)
  et `POST /v1/messages/rcs` (sans fenêtre, mais seulement vers quelqu'un qui a consenti ou qui vous a déjà
  écrit). Écrire PREND le fil : le scénario cesse d'avancer seul, l'agent de Meta cesse de répondre.
  ⚠️ Ces routes ne créent pas de fiche : un message simple ne fonde pas une relation.
  ⚠️ **La joignabilité RCS ne se sait qu'après coup** : le premier RCS libre vers un numéro sans RCS est
  accepté, son échec apparaît dans Sécurité > Journal des erreurs, et le suivant est refusé
  (`rcs_unreachable`). Plus largement, l'échec de livraison d'un message LIBRE (réponse de l'Inbox, RCS libre,
  message de l'API, message d'un scénario) s'y lit désormais, origine comprise (2026-09-24) : il n'était
  écrit nulle part.
- ✅ **Déclencher un envoi** (`POST /v1/sends`) : un LOT de destinataires vers un template WhatsApp, un
  scénario, un bloc précis d'un scénario, ou un message RCS de la bibliothèque (2026-09-24). Le canal se lit
  dans la cible, jamais dans un paramètre. Chaque destinataire porte ses propres clés, son consentement (écrit
  sur la fiche AVANT le tri) et ses propres **variables** (un numéro de commande, un produit), qui ne sont pas
  écrites sur la fiche.
  🔴 **Ce qu'un scénario ou un bloc envoie EN PREMIER décide de tout** : un template ou un bloc RCS part vers
  quelqu'un qui n'a pas écrit, un message de session exige la fenêtre de 24 h, et une cible qui ne peut pas
  partir (attente avant tout envoi, template sans nom, plusieurs templates possibles) est refusée AVANT
  l'envoi. C'est la même règle que la console.
  🔴 **Aucun destinataire perdu en silence** : chaque écarté l'est avec son motif et sa position dans la liste
  (bloqué, désabonné, sans consentement, hors fenêtre, variable manquante, sans numéro pour le RCS...).
  ⚠️ La catégorie d'un template est lue chez Meta, jamais déclarée par l'appelant.
  ⚠️ **Idempotence** : une clé obligatoire, en en-tête OU dans le corps (pour les outils qui remplissent leur
  corps contact par contact). La même clé avec un autre corps est refusée au lieu de rejouer en silence.
  `GET /v1/sends/{sendId}` rend un contrat écrit et stable : statut, compteurs, une ligne par destinataire
  (canal, statut, identifiant de message, état de livraison, erreur).
- ✅ **Les catalogues** (2026-09-24) : `GET /v1/templates` (les templates WhatsApp APPROUVÉS qu'un envoi sait
  faire partir, leur catégorie, leur en-tête et, pour chaque variable, le champ que la console lui associe),
  `GET /v1/scenarios` (les scénarios PUBLIÉS et leur ouverture, calculée par la même règle que les envois) et
  `GET /v1/rcs-messages` (les messages RCS de la bibliothèque, leur format et leurs variables). Un intégrateur
  construit ainsi son appel sans ouvrir la console.
- ✅ **Des erreurs qu'un programme peut traiter** : tout refus rend `{ error, code }`, une phrase en français
  et un code stable en anglais, refus de la clé compris (clé absente, droit manquant, espace suspendu,
  débit), et un même refus porte le même code partout, qu'il arrive en erreur ou en motif d'écart d'un envoi.
  ⚠️ Une panne (réponse 5xx, par exemple Meta muet pendant la lecture des templates) n'a pas ce corps, et
  la documentation le dit.
@@PUCE_HUBSPOT@@

- L'espace client est **toujours déduit de la clé** (jamais de l'URL) : une clé ne peut voir ou toucher que les
  données de son espace. Débit borné par clé.
- ✅ **Menu « Developers »** (2026-07-20), en bas de la barre latérale de l'onglet **Console**, réservé aux
  admins : **Documentation API** et **Clés d'API** (créer avec un nom et des droits, lister avec date de
  création et dernier appel, révoquer ; la clé en clair ne s'affiche qu'une fois, avec un bouton Copier ; une
  clé révoquée reste dans la liste, marquée comme telle).
  🔴 **La Documentation API a été réécrite le 2026-09-24** : les deux familles séparées, la désignation d'une
  personne, chaque paramètre, la table des codes, des exemples RCS, et une section « Brancher un outil qui
  appelle par contact » (plateforme d'orchestration, CRM, outil marketing). **Ses exemples ne peuvent plus
  mentir** : ils vivent dans un module que la page affiche et qu'un test passe aux validateurs des routes.
  ⚠️ Elle ne nomme aucun outil tiers : elle sert à tous les intégrateurs.

```

- [ ] **Step 3: Remplacer la section par un script qui CALCULE avant d'écrire**

```bash
set -e
cat > C:/Users/julie/AppData/Local/Temp/mba-lot4-doc/remplacer-section-api.cjs <<'EOF'
const fs = require('fs');
const [fichier, neufChemin] = process.argv.slice(2);
const src = fs.readFileSync(fichier, 'utf8');
const TITRE = '## API publique `/v1` (intégrateurs externes)\n';
const SUIVANT = '\n## Brancher vos systèmes : les connecteurs API';
const debut = src.indexOf(TITRE);
const fin = src.indexOf(SUIVANT, debut);
if (debut < 0 || fin < 0) throw new Error('bornes de section introuvables');
const section = src.slice(debut, fin);
const PUCE = '- ✅ **Les fonctions HubSpot disparaissent';
const d = section.indexOf(PUCE);
if (d < 0) throw new Error('puce HubSpot introuvable : relire la section a la main');
const reste = section.slice(d + PUCE.length);
const m = reste.search(/\n\n?- /);
const puce = (m < 0 ? section.slice(d) : section.slice(d, d + PUCE.length + m)).replace(/\s+$/, '');
const neuf = fs.readFileSync(neufChemin, 'utf8').replace('@@PUCE_HUBSPOT@@', puce);
if (neuf.includes('@@')) throw new Error('marqueur non remplace');
const sortie = src.slice(0, debut) + neuf.trimEnd() + '\n\n' + src.slice(fin + 1);
fs.writeFileSync(fichier, sortie);
console.log('section remplacee, puce HubSpot recopiee (' + puce.split('\n').length + ' lignes)');
EOF
cd /c/Users/julie/messagingme-mba && node C:/Users/julie/AppData/Local/Temp/mba-lot4-doc/remplacer-section-api.cjs features.md C:/Users/julie/AppData/Local/Temp/mba-lot4-doc/features-api.md
```

Expected : `section remplacee, puce HubSpot recopiee (9 lignes)`. Relire :
`awk '/^## API publique `\/v1`/,/^## Brancher vos systèmes/' features.md`.

- [ ] **Step 4: Vérifier que l'entrée de `todo.md` est partie (lot 1, tâche 13, étape 3)**

Run: `cd /c/Users/julie/messagingme-mba && git fetch -q origin && git show origin/main:todo.md | grep -c "## L'API publique v1 ne sait pas dire"`
Expected: `0`. Un autre compte : le lot 1 ne l'a pas retirée, ce qui est un manque DU LOT 1. Le signaler à
Julien ; ce lot ne l'écrit pas à sa place (une exigence, un seul lot).

- [ ] **Step 5: `documentation.md`, le module partagé du front**

Remplacer :

```markdown
| `web/lib/campaign-eligibility.ts` | 🔴 le MIROIR de l'analyse d'ouverture serveur, tenu par un test de parité |
```

par :

```markdown
| `web/lib/campaign-eligibility.ts` | 🔴 le MIROIR de l'analyse d'ouverture serveur, tenu par un test de parité |
| `web/lib/api-exemples.ts` | les exemples (corps et réponses), les codes d'erreur et les bornes de la page Documentation API. 🔴 La page n'écrit aucun JSON à la main : `tests/api-exemples.test.ts` passe chaque corps aux règles de sa route (schéma zod, règles de cible), type chaque réponse par ce que sa route rend, tient la table des codes égale à `CodeApi` (au typecheck) et refuse tout nom d'outil tiers. ⚠️ Aucun import : il est lu par la console ET par la suite racine |
```

- [ ] **Step 6: Voir passer ce qui lit ces fichiers**

Run: `npx vitest run tests/aide-proposer.test.ts`
Expected: PASS (le titre de section est intact, aucune fiche ne cite cette section).

- [ ] **Step 7: Commit**

Relire `git diff -- features.md documentation.md`. Si une ligne étrangère apparaît dans un de ces fichiers,
passer ce fichier par la procédure P (blob = `origin/main` + le seul script de l'étape 3 ou 5 rejoué sur la
copie). Sinon :

```bash
cd /c/Users/julie/messagingme-mba && git diff -- features.md documentation.md && \
git commit --only features.md documentation.md \
  -m "docs(api): features et manuel du lot 4 (catalogues et documentation)" \
  -m "Section API publique reecrite pour les lots 1 a 4, module d exemples au manuel." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main
```

---

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Les quatre questions : la production emprunte ce
chemin (trois routes publiques neuves derrière la clé d'API, et la page qui EST le contrat de tout
intégrateur) ; c'est réversible (lectures seules, aucune migration) ; les critères sont en grande partie
testables (tri, parité, exemples validés), mais la justesse de la page se juge à l'œil ; et le code touché
porte des invariants invisibles (l'ouverture, le statut et la catégorie d'un template, les refus du moteur
doivent rester ceux de `/v1/sends` et de la console ; le tenant vient de la clé ; deux fichiers de câblage
partagés ; une page qui ne doit partir qu'après son API). Deux oui en haut : revue humaine du diff. `/revue`
puis `/revue-finale` avant le déploiement de l'API (tâche 6), et de nouveau avant le push de la page
(tâche 7, étape 7), parce que ce push publie la console chez Vercel.

L'essai réel qui clôt ce lot, le geste en production sans lequel il n'est que vert et pas éprouvé, est décrit dans la section « Essai réel qui clôt le lot » ci-dessous.

## Essai réel qui clôt le lot

Avec une VRAIE clé (droit `sends:create`), en production, en regardant la console et le téléphone d'essai :

1. `GET /v1/templates` : la liste est celle des templates APPROUVÉS de Contenu > Templates (un template en
   attente n'y est pas ; un carrousel dont une carte porte une variable non plus), et pour un template créé
   avec le sélecteur de champ, la `source` de sa variable est le champ choisi à la création. Puis une clé
   sans `sends:create` : 403 avec `"code": "missing_scope"` dans le corps.
2. `GET /v1/scenarios` : un scénario publié y est avec son `opening` ; un scénario seulement en brouillon n'y
   est pas ; un scénario qui commence par un message rapide rend `whatsapp_session`.
3. `GET /v1/rcs-messages` : les messages de Contenu > Messages RCS, avec leur format et leurs `{{variables}}`.
4. Ouvrir Developers > Documentation API sur `engageme.messagingme.app`, la lire en entier, puis copier la
   commande « Un template, avec une variable par destinataire » en n'y changeant que la clé, le template (pris
   au catalogue de l'étape 1) et le numéro d'essai : le message arrive, la variable est remplie (§ 14.2 de la
   spec). Rejouer la MÊME commande : 201 avec le même `sendId`, rien n'arrive (idempotence DANS le corps). Même
   geste avec « Un message RCS de la bibliothèque ».
5. Chercher dans la page affichée (Ctrl+F) le nom d'un outil tiers : aucun. Et « batch » n'y apparaît que
   dans l'adresse `/v1/contacts/batch`.

Le lot se clôt sur ces gestes, sans attendre aucun lot suivant : la section « Ce que nous remontons » et
son essai appartiennent au lot 6.

## Rayon de souffle

Repris du § 17 de la spec pour ce lot, complété par la lecture du code :

- **`ouvertureApi` (lot 2) gagne un quatrième consommateur**, le catalogue. Toute évolution de cette fonction
  change désormais ce que `GET /v1/scenarios` annonce : c'est voulu, et `tests/v1-catalogues.test.ts` tient la
  parité avec la spec et avec `canalDOuverture` (qui sert la console, la liste des scénarios, le sélecteur de
  l'Inbox et l'éditeur). Un écart y apparaît comme un échec du lot 4 alors que sa cause est dans le lot 2.
- **`verdictModele` (lot 2), `carouselSendBlocker` et `headerMediaSendBlocker` gagnent un consommateur**, le
  catalogue des templates. Durcir l'un d'eux retire des lignes de `GET /v1/templates` : c'est voulu, c'est la
  parité. ⚠️ Ce que ces fonctions SUPPOSENT, et que le catalogue ne fournit pas comme l'envoi : les deux
  refus du moteur attendent un identifiant de média re-téléversé ; le catalogue leur passe l'ADRESSE du
  visuel, qui est ce que l'envoi utilise pour l'obtenir. Si le moteur se mettait à exiger autre chose qu'un
  identifiant non vide, relire cet appel. Et `verdictModele` compare la catégorie en minuscules : le catalogue
  la passe en minuscules, comme `templateVarInfo`.
- **Les codes des refus de la garde commune** (`unauthorized`, `missing_scope`, `tenant_locked`,
  `rate_limited`) sont posés par le lot 1 ; ce lot les documente et les éprouve sur ses trois routes. Un
  changement de la garde qui retirerait un code fait échouer `tests/v1-catalogues.test.ts`, et c'est voulu :
  la page mentirait.
- **Les validateurs exportés par la tâche 1** (alias, `export` ajouté) : aucun comportement ne bouge, mais ils
  deviennent un contrat avec `tests/api-exemples.test.ts`. Un lot qui renommerait un schéma de route doit
  garder l'alias ; un lot qui déplacerait une règle de forme hors du schéma (dans le handler) la ferait
  disparaître du contrôle des exemples, sans erreur. ⚠️ Les deux bornes de longueur de `/v1/contacts/batch`
  sont DÉJÀ dans le handler du lot 1 : le test les applique avec `MAX_BATCH`, la constante de la route.
- **`OperationApi` gagne `catalogues.read`** : union fermée, lue par `/ops/usage`. Aucun test existant ne
  liste l'union entière ; `tests/api-usage-observation.test.ts` n'énumère que les opérations qu'il appelle.
- **`ServerDeps.v1.catalogues` est optionnel** : les appelants existants de `buildServer` (tests, câblage)
  sont inchangés. `scripts/auto-attaque.mts` monte `v1` avec un proxy qui rend toute dépendance vraie : les
  trois routes neuves sont donc attaquées en CI (sans clé, session de console, clé inventée : 401 attendu).
  `tests/scope-tenant.test.ts` : aucune adresse neuve ne porte `:tenantId`, et l'entrée reste `cle-api`.
- **`PgWorkflowStore` et `PgTemplateHintStore` gagnent une méthode** chacun ; `listResume`, `list`, `get`
  ne changent pas. « Publié » y veut dire « graphe publié non vide », pas `published_at` (null sur les
  scénarios antérieurs à 0095) : le lot 2 juge « jamais publié » sur le même graphe (`ouvertureApi` d'un graphe
  vide rend `null`), donc le catalogue et l'envoi ne peuvent pas se contredire sur ce point.
- **Charge chez Meta** : chaque `GET /v1/templates` relit la liste complète du WABA (jusqu'à 20 pages),
  bornée par le débit par clé. Une panne de Meta y rend une 5xx sans corps `{ error, code }` (et parfois la
  page d'erreur de l'hébergeur), jamais une liste vide. Tranché : pas de code dédié dans ce lot (il faudrait
  élargir le § 9 et `CodeApi`, lot 1) ; la section « Erreurs » de la page dit l'exception.
- **`web/lib/api-base.test.ts`** relit la page : `const ADRESSE_API = BASE.` est conservée mot pour mot, et
  aucune adresse d'API n'est écrite en dur.
- **`tests/aide-proposer.test.ts`** : le titre de la section de `features.md` est inchangé ; la puce HubSpot
  qui y vit est recopiée par le script, pas réécrite.
- **Vercel publie la console à chaque `git push`** : la tâche 7 ne se commite qu'après le déploiement de
  l'API (tâche 6) et après sa propre `/revue-finale`. Le module de la tâche 5 part plus tôt sans risque :
  aucune page ne le rend avant la tâche 7.
- **Lot 6 (plan `2026-09-24-api-v1-lot6-signaux-batch.md`, tâche 13), qui lit ce que ce lot produit** : il
  ajoute la section « Ce que nous remontons » à `web/app/developers/api/page.tsx` (`<DocSignaux />`, dernière
  section de `DocsInner`, donc après « Exemples complets »), avec son propre dictionnaire
  (`web/lib/signaux-dictionnaire.ts`) et sa propre parité (`tests/web-signaux-parite.test.ts`). Et son test
  relit la page ET `web/lib/api-exemples.ts` avec un motif d'outils tiers insensible à la casse, après avoir
  retiré `contacts/batch` : ce lot n'écrit donc « batch » nulle part ailleurs dans ces deux fichiers, et sa
  propre garde cherche de la même façon. ⚠️ Le texte de cette section, qui renvoie à Paramètres >
  Intégrations, est au lot 6 de le tenir neutre : dire que les remontées passent par les connecteurs proposés
  dans cet écran, sans les nommer, qu'un outil absent de cette liste ne reçoit rien, et ne jamais laisser
  croire à un webhook générique (spec § 18).
- **Serveur MCP, envois, contacts** : non touchés (la tâche 1 n'exporte ou ne nomme que des symboles
  existants, et le vérifie par les suites `v1-*` inchangées).

## Déploiement

1. **Préalable** : les lots 1, 2 et 3 sont déployés (leurs migrations appliquées et relues en base, leur essai
   réel passé). Ce lot n'a AUCUNE migration : `ls db/migrations | tail -1` est le même avant et après.
2. **API** (tâche 6), après `gh run view <id> --json jobs` tout vert et l'attestation de `/revue-finale` :

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS
cd /home/ubuntu/mba && git pull && sudo docker compose up -d --build
```

   `up -d --build` reconstruit `mba-api` ET `mba-worker` (deux images distinctes). Puis le contrôle public des
   deux portes et des trois routes (tâche 6, étape 5) ; un 502 alors que les conteneurs sont `healthy` se règle
   par `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`.
3. **Console, page réécrite** (tâche 7) : `/revue` puis `/revue-finale` (tâche 7, étape 7), puis commit et
   `git push` APRÈS l'étape 2, jamais avant. Vercel publie `engageme.messagingme.app` au push ; l'ancienne
   console du VPS (`mba.`) la prendra à son prochain `up -d --build`.
4. Après chaque poussée : prévenir les autres sessions (fichiers communs : `src/server.ts`, `src/index.ts`,
   `features.md`, `documentation.md`).
