# API publique v1, lot 1 (identité et contacts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une personne se désigne par sa FICHE dans `/v1/contacts` : une fonction partagée la trouve par `contactId`, `externalId`, `phone` ou `bsuid`, l'API sait créer, compléter, lire, retrouver, modifier et désabonner une fiche, toute erreur porte un `code`, le droit `contacts:read` existe, et la fiche du mini-CRM montre l'identifiant que l'API appelle `contactId`.

**Architecture:** Trois modules partagés naissent dans `src/api/` et serviront aux lots suivants : `erreurs.ts` (la table des codes et la forme `{ error, code }`), `fiche.ts` (`resoudreFiche`, la règle multi-clés du § 1) et `consentement.ts` (`appliquerConsentement`, l'écriture d'un consentement par une machine, audit compris). Le dépôt des contacts gagne `external_id` (migration hors transaction, index unique partiel créé `CONCURRENTLY`) et des méthodes étroites, chacune en UNE requête filtrée par `tenant_id = $1` et `deleted_at is null` (dont `editerFicheApi`, l'écriture des champs, étiquettes et nom, qui remplace sur ce chemin la transaction de `applyEdits`) ; un service `src/api/contacts-v1.ts` compose le tout pour les cinq routes `/v1/contacts`. `upsertContactsFromApi` ne sert plus `/v1` : il garde ses autres appelants (webhook entrant, création à la main dans la console) et son comportement, sa préparation des champs étant seulement extraite pour être partagée.

**Tech Stack:** TypeScript (Node 22, ESM, `verbatimModuleSyntax`), Fastify 5, zod 4, pg (Postgres Supabase), vitest, Next.js et Playwright pour la console (`web/`).

**Spec:** `docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md` (ce lot : § 1, § 2, § 9, § 10 pour la fiche et les clés, § 11 pour `external_id`, § 13 à § 17 pour ce qui le concerne).

## Global Constraints

- Rédaction en français, dans le code, les commentaires, les tests, la doc et les messages de commit. **Aucun tiret cadratin ni demi-cadratin** : virgule, deux-points, parenthèses, point. Jamais le nom de l'infrastructure sous-jacente (règle du `CLAUDE.md` global : l'éditeur, c'est SmartLink).
- 🔴 **Aucun outil tiers nommé** dans ce que ce lot écrit (code, commentaires, tests, `documentation.md`, `todo.md`) : l'API sert tous les intégrateurs. On écrit « l'outil du client », « un outil qui appelle par contact ». Identifiants d'exemple neutres : `crm-7781`.
- Toute erreur de l'API publique a la forme `{ "error": "<phrase en français>", "code": "<code>" }`, avec un code de `STATUT_PAR_CODE` (`src/api/erreurs.ts`). Un défaut de FORME est `invalid_body`, le champ fautif nommé dans le message.
- Entrées externes : zod `safeParse`, jamais `parse`, jamais `as` sur un corps ou des paramètres reçus (les paramètres de route se typent par le générique de Fastify, `app.get<{ Params: { contactId: string } }>`).
- Chaque requête SQL neuve porte `tenant_id = $1` (le pooler est superuser, la RLS est contournée : ce filtre est le seul contrôle) et `deleted_at is null` quand elle lit une fiche active.
- Une dépendance de sécurité n'est jamais optionnelle : l'audit de `DepsConsentement` est REQUIS, les deux gardes de `registerV1Contacts` aussi.
- `externalId` : 512 caractères au plus, unique PAR ESPACE, jamais obligatoire, jamais une adresse. Une chaîne vide ou blanche vaut ABSENCE pour les quatre clés, ET pour `name`, `consent` et `consentSource` (un outil qui remplit son corps avec les variables d'un profil envoie `""` pour une variable absente : ce n'est ni une valeur ni une erreur). Sur `PATCH`, seul `null` VIDE le nom.
- Une fiche PURGÉE n'est jamais réécrite par l'API, et une fiche SUPPRIMÉE ne l'est que par la résurrection voulue de `creerFicheApi` (par son numéro ou son BSUID, comportement de l'upsert d'avant, gardé) : toute AUTRE écriture du service (`rattacherCles`, `editerFicheApi`, `poserExternalId`, `ecrireConsentementParId`) porte `deleted_at is null` dans son `where`. C'est pourquoi le service n'emprunte PAS `applyEdits` (la fiche de la console), qui verrouille sans ce filtre.
- Aucun chemin de l'API n'émet d'événement d'automation (invariant « aucun chemin de masse n'émet ») : le service n'appelle jamais `emitTagAdded`.
- Commandes : `npx vitest run <fichier>` (unitaire), `npm run typecheck`, `npm test`, et pour la console `cd web && npx tsc --noEmit`. 🔴 **Les tests d'intégration ne se lancent JAMAIS en local** : le `DATABASE_URL` du `.env` est la PRODUCTION. Ils s'écrivent, se poussent, et leur verdict se lit sur le run GitHub : `gh run list --limit 5`, puis `gh run view <id> --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'`, job par job (le code de sortie de `gh run watch` a déjà menti).
- 🔴 **Un test de non-régression se vérifie DANS LES DEUX SENS** : remettre le code fautif, voir l'échec ET son symptôme, restaurer, revoir le vert. Borner la mutation au périmètre du correctif.
- Ne jamais recopier en prose un compteur calculable (nombre de routes, de méthodes, de tests, de migrations) : pointer la source.
- Migration : numéro pris AU MOMENT D'ÉCRIRE (le dossier et `origin` tranchent sur ce qui est pris), additive, appliquée en production AVANT tout push de code qui la lit, relue en base juste après `migrate`. La ligne du compteur de `CLAUDE.md` s'écrit DANS le commit qui prend le numéro.
- **Quatre annonces aux autres sessions** (outil `ListAgents` puis `SendMessage`, un message, pas de verrou) : avant d'éditer `src/server.ts` ou `src/index.ts`, avant tout `git checkout -- <fichier>` (à éviter), avant de lancer une suite e2e, et avant d'AFFAIBLIR, pour une vérification dans les deux sens, une garde d'accès (clé, droit, filtre `tenant_id`) ou la validation d'un corps reçu de l'extérieur sur une route MONTÉE (l'arbre est partagé : le temps de la mesure, une image construite depuis lui partirait sans la garde ; c'est la « quatrième annonce » du `CLAUDE.md` du dépôt). Une mutation se restaure puis se PROUVE restaurée par comparaison (`git diff origin/main -- <fichier>` ou un `grep -c` sur la ligne voulue), jamais à l'œil.
- Après toute tâche non triviale : `/revue` (correctness, cas limites, sécurité, perf, style, tests, rayon de souffle). On corrige 🔴 et 🟡 dans la foulée.

### Procédure de commit P (TOUS les commits de ce lot)

🔴 L'arbre de travail est PARTAGÉ par plusieurs sessions, qui ont parfois des commits locaux non poussés. Un `git commit` local suivi de `git push origin main` pousserait LEURS commits ; un `git commit --only` commite le contenu de l'arbre à l'instant T, qui peut porter une ligne d'une autre session. Tous les commits de ce lot se construisent donc sur `origin/main`, par un index temporaire, sans toucher ni l'index partagé ni l'arbre. (Règle du `CLAUDE.md` du dépôt, section « Règles spécifiques au projet », et mémoire « arbre de travail partagé entre sessions ».)

1. Relire SES hunks, dans le même appel que la suite, et chercher l'INTRUS dans le diff (pas dans la liste des chemins) :

```bash
cd /c/Users/julie/messagingme-mba && git fetch -q origin && git diff origin/main -- <chemins de la tâche> && git status --porcelain -- <chemins de la tâche>
```

Si un hunk n'est pas de ce lot : s'arrêter et appliquer P' à ce fichier.

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

⚠️ `commit-tree` ne déclenche aucun hook : `gitleaks` est donc lancé à la main ci-dessus, sur EXACTEMENT ce qui part (le diff de l'index temporaire contre `origin/main`), et le commit n'est construit que si ce balayage sort à 0. 🔴 Pas `gitleaks git --staged` : il compare l'index au HEAD LOCAL, que les poussées par plomberie ne font jamais avancer et qui porte les commits non poussés d'autres sessions ; il balaierait leurs travaux et ne verrait pas une ligne secrète déjà dans ce HEAD. Le hook `rayon-de-souffle` ne tourne pas, la section « Rayon de souffle » de ce plan et `/revue` en tiennent lieu. Le dépôt local ne bouge pas : ne pas faire `git reset`, `git checkout` ni `update-ref` sur l'arbre partagé. Après le push : `gh run list --limit 3`, puis lire le run job par job.

### Procédure P' (fichier que d'autres sessions modifient aussi : `CLAUDE.md`, `todo.md`, ou tout fichier dont `git diff origin/main` montre un hunk étranger)

1. Faire SA modification dans l'arbre (outil Edit, le plus petit remplacement possible), pour qu'un commit ultérieur de l'autre session la porte aussi.
2. Construire le blob depuis `origin` : `B="$(cygpath -m "$(mktemp)")" && git show origin/main:<fichier> > "$B"`, appliquer LE MÊME remplacement à `"$B"` (outil Edit sur ce chemin absolu), puis, dans la boucle de P, remplacer la ligne du fichier par `git update-index --add --cacheinfo "100644,$(git hash-object -w --path=<fichier> "$B"),<fichier>"`.
3. Relire `git diff origin/main --cached -- <fichier>` (avec `GIT_INDEX_FILE` exporté) : il ne doit montrer QUE son remplacement.

## Carte des fichiers

| Fichier | Rôle | Tâche |
|---|---|---|
| `src/api/erreurs.ts` (neuf) | `STATUT_PAR_CODE`, `CodeApi`, `refuser` | 1 |
| `src/auth/api-key.ts`, `src/auth/rate-limit.ts`, `src/api/usage-guard.ts` | les refus de la garde commune portent un code | 2 |
| `db/migrations/<N>_contacts_external_id.sql` (neuf) | `contacts.external_id` et son index unique partiel | 3 |
| `tests/migration-directives.test.ts` | la règle `CONCURRENTLY` couvre aussi un index UNIQUE | 3 |
| `src/crm/contact-store.pg.ts` | `externalId` sur `ContactRow`, les méthodes de l'API (dont `editerFicheApi`), purge | 4, 5 |
| `src/api/fiche.ts` (neuf) | `resoudreFiche`, `schemaClesFiche`, `normaliserCles` | 6 |
| `tests/aide/fiches-memoire.ts` (neuf) | un répertoire de fiches EN MÉMOIRE, aux règles de la base | 6 |
| `src/api/consentement.ts` (neuf) | `appliquerConsentement` | 7 |
| `src/api/contacts-upsert.ts` | `preparateurDeChamps` extrait, schémas partagés, messages de validation | 8 |
| `src/api/contacts-v1.ts` (neuf), `src/rcs/reachability.ts` | le service des fiches, `joignabiliteRcsConnue` | 9 |
| `src/http/v1-contacts.ts` (réécrit), `src/server.ts`, `src/index.ts`, `src/http/api-keys.ts` | les cinq routes, les deux gardes, le câblage, le droit serveur | 10 |
| `web/lib/api/integrations.ts`, `web/app/developers/keys/page.tsx` | le droit `contacts:read` dans la console | 11 |
| `web/lib/api/contacts.ts`, `web/components/ContactDetail.tsx` | l'identifiant API et l'identifiant externe sur la fiche | 12 |
| `documentation.md`, `todo.md` | l'état actuel, et l'entrée de backlog qui se ferme | 13 |

---

### Task 1: Le vocabulaire d'erreur de l'API publique

**Files:**
- Create: `src/api/erreurs.ts`
- Test: `tests/api-erreurs.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `export const STATUT_PAR_CODE: { readonly invalid_body: 400; ...; readonly duplicate: null; ... }` (chaque code du § 9, plus `tenant_locked`, avec son statut HTTP, `null` pour un code qui n'est qu'un motif d'écart)
  - `export type CodeApi = keyof typeof STATUT_PAR_CODE`
  - `export function refuser(reply: FastifyReply, statut: number, code: CodeApi, message: string): FastifyReply` (corps `{ error: message, code }`)

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/api-erreurs.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { STATUT_PAR_CODE, refuser } from '../src/api/erreurs';

/**
 * LE VOCABULAIRE D'ERREUR DE L'API PUBLIQUE (spec du 2026-09-24, § 9).
 *
 * 🔴 UN MÊME REFUS PORTE LE MÊME CODE PARTOUT, qu'il sorte en erreur d'une route ou en motif d'écart d'un
 * envoi. C'est la TABLE qui le garantit, pas la mémoire de celui qui écrit la route suivante.
 */
describe('les codes d’erreur de l’API publique', () => {
  it('🔴 la table porte les codes du § 9, plus `tenant_locked` que la garde rendait déjà', () => {
    expect(new Set(Object.keys(STATUT_PAR_CODE))).toEqual(new Set([
      'invalid_body', 'invalid_recipient', 'invalid_phone', 'unauthorized', 'missing_scope', 'unknown_contact',
      'duplicate', 'identity_conflict', 'blocked_contact', 'opted_out', 'no_consent', 'window_closed',
      'missing_variable', 'no_phone', 'rcs_unreachable', 'rcs_not_enabled', 'no_whatsapp_number',
      'scenario_not_found', 'node_not_found', 'template_not_found', 'rcs_message_not_found', 'send_not_found',
      'scenario_ambiguous', 'unsendable_target', 'template_category_unknown', 'idempotency_key_required',
      'idempotency_in_progress', 'idempotency_key_reused', 'rate_limited', 'tenant_locked',
    ]));
  });

  it('les statuts sont ceux du § 9 ; `duplicate` et `missing_variable` ne sont que des motifs d’écart', () => {
    expect(STATUT_PAR_CODE.duplicate).toBeNull();
    expect(STATUT_PAR_CODE.missing_variable).toBeNull();
    expect(STATUT_PAR_CODE.invalid_body).toBe(400);
    expect(STATUT_PAR_CODE.invalid_recipient).toBe(400);
    expect(STATUT_PAR_CODE.unauthorized).toBe(401);
    expect(STATUT_PAR_CODE.missing_scope).toBe(403);
    expect(STATUT_PAR_CODE.tenant_locked).toBe(403);
    expect(STATUT_PAR_CODE.unknown_contact).toBe(404);
    expect(STATUT_PAR_CODE.identity_conflict).toBe(409);
    expect(STATUT_PAR_CODE.window_closed).toBe(422);
    expect(STATUT_PAR_CODE.rate_limited).toBe(429);
  });

  it('chaque code est un identifiant anglais en snake_case : il est lu par des programmes', () => {
    for (const code of Object.keys(STATUT_PAR_CODE)) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('🔴 `refuser` rend `{ error, code }` avec le statut demandé', async () => {
    const app = Fastify();
    app.get('/x', async (_req, reply) => refuser(reply, 409, 'identity_conflict', 'deux fiches différentes'));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'deux fiches différentes', code: 'identity_conflict' });
    await app.close();
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-erreurs.test.ts`
Expected: FAIL, `Failed to resolve import "../src/api/erreurs"`.

- [ ] **Step 3: Écrire le module**

```ts
// src/api/erreurs.ts
import type { FastifyReply } from 'fastify';

/**
 * LES CODES D'ERREUR DE L'API PUBLIQUE, et le statut HTTP de chacun (spec du 2026-09-24, § 9).
 *
 * 🔴 UN CODE PAR SITUATION QU'UN PROGRAMME PEUT TRAITER. Un défaut de FORME est toujours `invalid_body`, le
 * champ fautif nommé dans le message : un code par champ ferait un vocabulaire que personne ne lirait.
 *
 * ⚠️ `null` = le code n'existe qu'en MOTIF D'ÉCART d'un destinataire (`/v1/sends`), jamais en erreur de route.
 * ⚠️ `tenant_locked` est absent de la table de la spec : la garde de clé le rendait avant elle, et la
 * documentation de l'API doit le lister avec les autres.
 */
export const STATUT_PAR_CODE = {
  invalid_body: 400,
  invalid_recipient: 400,
  invalid_phone: 400,
  unauthorized: 401,
  missing_scope: 403,
  tenant_locked: 403,
  unknown_contact: 404,
  duplicate: null,
  identity_conflict: 409,
  blocked_contact: 409,
  opted_out: 409,
  no_consent: 409,
  window_closed: 422,
  missing_variable: null,
  no_phone: 422,
  rcs_unreachable: 422,
  rcs_not_enabled: 409,
  no_whatsapp_number: 409,
  scenario_not_found: 404,
  node_not_found: 404,
  template_not_found: 404,
  rcs_message_not_found: 404,
  send_not_found: 404,
  scenario_ambiguous: 409,
  unsendable_target: 422,
  template_category_unknown: 422,
  idempotency_key_required: 400,
  idempotency_in_progress: 409,
  idempotency_key_reused: 422,
  rate_limited: 429,
} as const satisfies Record<string, number | null>;

export type CodeApi = keyof typeof STATUT_PAR_CODE;

/**
 * Refuse une requête de l'API publique : `{ error, code }` avec le statut donné.
 *
 * ⚠️ Le statut reste un PARAMÈTRE : c'est la route qui sait si son refus est un 404 ou un 409 (un
 * `unknown_contact` n'a pas le même sens pour une lecture et pour un envoi), la table ne sert que de défaut
 * à qui relaie le code d'un service (`STATUT_PAR_CODE[code] ?? 400`).
 */
export function refuser(reply: FastifyReply, statut: number, code: CodeApi, message: string): FastifyReply {
  return reply.code(statut).send({ error: message, code });
}
```

- [ ] **Step 4: Le voir passer**

Run: `npx vitest run tests/api-erreurs.test.ts && npm run typecheck`
Expected: PASS (4 tests), typecheck sans erreur.

- [ ] **Step 5: Commit (procédure P)**

Chemins : `src/api/erreurs.ts tests/api-erreurs.test.ts`. Message : `feat(api): le vocabulaire d erreur de l API publique (table des codes, forme { error, code })`.

---

### Task 2: Les refus de la garde commune portent un code

**Files:**
- Modify: `src/auth/rate-limit.ts:1` (import), `:139-160` (`consommerAvecEntetes`), `:170-179` (`consommerEnSilence`), `:181-184` (`refuserTropDeRequetes`)
- Modify: `src/auth/api-key.ts:1-6` (import), `:83`, `:110`, `:141`, `:147`, `:154`, `:168`, `:180-186`
- Modify: `src/api/usage-guard.ts:1` (import), `:166`, `:219`, `:235`
- Test: `tests/api-garde-codes.test.ts`

**Interfaces:**
- Consumes: `refuser`, `CodeApi` (Task 1).
- Produces: `consommerAvecEntetes(limiteur, cle, reply, message?, code?: CodeApi): Promise<boolean>` et `consommerEnSilence(limiteur, cle, reply, message?, code?: CodeApi): Promise<boolean>` (le code est FACULTATIF : seule la surface `/v1` et `/mcp` le passe). Les refus de `makeRequireApiKey` rendent `unauthorized` (401), `rate_limited` (429), `tenant_locked` (403) ; `requireScope` rend `missing_scope` (403) ; `compterOuRefuser` rend `unauthorized` (401) et `rate_limited` (429). Statuts et en-têtes inchangés.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/api-garde-codes.test.ts
import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeRequireApiKey, requireScope } from '../src/auth/api-key';
import { RateLimiter, consommerAvecEntetes } from '../src/auth/rate-limit';
import { compterOuRefuser, type ApiUsageGuard } from '../src/api/usage-guard';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest } from './aide/cle-api';

/**
 * LES REFUS DE LA GARDE COMMUNE PORTENT UN CODE (spec du 2026-09-24, § 9).
 *
 * 🔴 ELLE EST PARTAGÉE (`/v1`, `/mcp`, le relais de l'agent de Meta) : lui ajouter un `code` ne doit changer
 * NI ses statuts NI ses en-têtes (`retry-after`, `x-ratelimit-*`). Et la console, qui passe par les mêmes
 * limiteurs, garde ses refus `{ error }` seuls : le code est un paramètre FACULTATIF.
 */
class FauxCles implements ApiKeyLookup {
  constructor(private readonly brut: string) {}
  async findActiveByHash(hash: string) { return hash === sha256Hex(this.brut) ? { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] } : null; }
  async touchLastUsed() { /* sans objet ici */ }
}

function fauxReply() {
  const state: { statusCode: number | null; body: unknown; headers: Record<string, string> } = { statusCode: null, body: undefined, headers: {} };
  const reply = {
    code(c: number) { state.statusCode = c; return reply; },
    header(k: string, v: string) { state.headers[k.toLowerCase()] = v; return reply; },
    async send(b: unknown) { state.body = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

const CLE = cleApiDeTest('garde_codes');
const large = (): RateLimiter => new RateLimiter(1000, 60_000);
const requete = (h?: string): FastifyRequest => ({ headers: h ? { authorization: h } : {} }) as unknown as FastifyRequest;

describe('la garde de clé', () => {
  it('🔴 clé absente, mal formée ou inconnue : 401 `unauthorized`', async () => {
    const garde = makeRequireApiKey(new FauxCles(CLE), large(), large());
    for (const h of [undefined, 'Bearer jwt', `Bearer ${cleApiDeTest('inconnue')}`]) {
      const { reply, state } = fauxReply();
      await garde(requete(h), reply);
      expect(state.statusCode).toBe(401);
      expect(state.body).toMatchObject({ code: 'unauthorized' });
    }
  });

  it('🔴 droit manquant : 403 `missing_scope`, et le message nomme le droit', async () => {
    const { reply, state } = fauxReply();
    await requireScope('contacts:read')({ apiScopes: ['contacts:write'] } as unknown as FastifyRequest, reply);
    expect(state.statusCode).toBe(403);
    expect(state.body).toEqual({ error: 'scope requis : contacts:read', code: 'missing_scope' });
  });

  it('🔴 plafond par clé : 429 `rate_limited`, avec les MÊMES en-têtes qu’avant', async () => {
    const garde = makeRequireApiKey(new FauxCles(CLE), new RateLimiter(1, 60_000), large());
    await garde(requete(`Bearer ${CLE}`), fauxReply().reply);
    const { reply, state } = fauxReply();
    await garde(requete(`Bearer ${CLE}`), reply);
    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(state.headers['retry-after'])).toBeGreaterThan(0);
    expect(state.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('budget spéculatif épuisé : 429 `rate_limited`, et toujours AUCUN en-tête x-ratelimit', async () => {
    const garde = makeRequireApiKey(new FauxCles(CLE), large(), new RateLimiter(1, 60_000));
    await garde(requete(`Bearer ${cleApiDeTest('sonde_a')}`), fauxReply().reply);
    const { reply, state } = fauxReply();
    await garde(requete(`Bearer ${cleApiDeTest('sonde_b')}`), reply);
    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({ code: 'rate_limited' });
    expect(Object.keys(state.headers).filter((k) => k.startsWith('x-ratelimit'))).toEqual([]);
  });
});

describe('la console garde ses refus sans code', () => {
  it('⚠️ un refus de débit SANS code demandé reste `{ error }` seul', async () => {
    const limiteur = new RateLimiter(1, 60_000);
    await consommerAvecEntetes(limiteur, 'u1', fauxReply().reply);
    const { reply, state } = fauxReply();
    expect(await consommerAvecEntetes(limiteur, 'u1', reply)).toBe(false);
    expect(state.body).toEqual({ error: 'trop de requêtes, patientez un instant' });
  });
});

describe('le garde d’usage', () => {
  it('🔴 401 `unauthorized` sans authentification, 429 `rate_limited` sur un quota ou une place lourde', async () => {
    const refusant: ApiUsageGuard = {
      demander: () => ({ accepte: false, raison: 'quota d’essai atteint' }),
      compteurs: () => [],
      entrerLourde: () => null,
      noterRefus: () => {},
    };
    const sansAuth = fauxReply();
    expect(await compterOuRefuser(refusant, requete(), sansAuth.reply, 'contacts.upsert')).toBe(false);
    expect(sansAuth.state).toMatchObject({ statusCode: 401, body: { code: 'unauthorized' } });

    const authentifiee = { headers: {}, auth: { userId: 'apikey:k1', tenantId: 't1', role: 'api' }, apiKeyId: 'k1' } as unknown as FastifyRequest;
    const quota = fauxReply();
    expect(await compterOuRefuser(refusant, authentifiee, quota.reply, 'contacts.upsert')).toBe(false);
    expect(quota.state).toMatchObject({ statusCode: 429, body: { error: 'quota d’essai atteint', code: 'rate_limited' } });

    const lourde = fauxReply();
    expect(await compterOuRefuser(refusant, authentifiee, lourde.reply, 'contacts.batch', 10)).toBe(false);
    expect(lourde.state).toMatchObject({ statusCode: 429, body: { code: 'rate_limited' } });
    expect(lourde.state.headers['retry-after']).toBe('2');
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-garde-codes.test.ts`
Expected: FAIL, les `toMatchObject({ code: ... })` échouent (`code` absent du corps), le cas de la console passe déjà.

- [ ] **Step 3: `src/auth/rate-limit.ts`, le code facultatif**

Ajouter l'import en tête (après la ligne 1) :

```ts
import type { CodeApi } from '../api/erreurs';
```

Remplacer la signature et la fin de `consommerAvecEntetes` (l. 139-160) :

```ts
export async function consommerAvecEntetes(
  limiteur: RateLimiter,
  cle: string,
  reply: FastifyReply,
  message = 'trop de requêtes, patientez un instant',
  /**
   * ⚠️ FACULTATIF, et c'est délibéré : seule la surface PUBLIQUE (`/v1`, `/mcp`) le passe (spec de l'API,
   * § 9). La console, les webhooks entrants et les rappels RCS gardent `{ error }` seul.
   */
  code?: CodeApi,
): Promise<boolean> {
  // Désactivé : aucun en-tête. Annoncer `x-ratelimit-limit: 0` sur un appel ACCEPTÉ ferait croire à un
  // intégrateur qu'il est à bout de quota alors qu'il n'y en a aucun.
  if (limiteur.desactive) return true;
  const etat = limiteur.remaining(cle);
  reply.header('x-ratelimit-limit', String(etat.limit));
  reply.header('x-ratelimit-remaining', String(Math.max(0, etat.remaining - 1)));
  reply.header('x-ratelimit-reset', String(Math.ceil(etat.resetAt / 1000)));
  if (limiteur.take(cle)) return true;
  reply.header('x-ratelimit-remaining', '0');
  await refuserTropDeRequetes(reply, etat.attenteMs, message, code);
  return false;
}
```

Remplacer `consommerEnSilence` et `refuserTropDeRequetes` (l. 170-184) :

```ts
export async function consommerEnSilence(
  limiteur: RateLimiter,
  cle: string,
  reply: FastifyReply,
  message = 'trop de requêtes, patientez un instant',
  code?: CodeApi,
): Promise<boolean> {
  if (limiteur.take(cle)) return true;
  await refuserTropDeRequetes(reply, limiteur.remaining(cle).attenteMs, message, code);
  return false;
}

async function refuserTropDeRequetes(reply: FastifyReply, attenteMs: number, message: string, code?: CodeApi): Promise<void> {
  reply.header('retry-after', String(Math.max(1, Math.ceil(attenteMs / 1000))));
  await reply.code(429).send(code ? { error: message, code } : { error: message });
}
```

- [ ] **Step 4: `src/auth/api-key.ts`, les codes de la surface publique**

Ajouter l'import (après la ligne 6) :

```ts
import { refuser } from '../api/erreurs';
```

Remplacer chaque refus, sans toucher au reste :
- l. 83 : `await reply.code(401).send({ error: 'clé d’API requise' });` devient `await refuser(reply, 401, 'unauthorized', 'clé d’API requise');`
- l. 110 : `consommerEnSilence(prefiltre, CLE_BUDGET_SPECULATIF, reply, 'trop de requêtes')` devient `consommerEnSilence(prefiltre, CLE_BUDGET_SPECULATIF, reply, 'trop de requêtes', 'rate_limited')`
- l. 141 et l. 154 : `consommerAvecEntetes(limiteurMetier, empreinte, reply, 'trop de requêtes')` devient `consommerAvecEntetes(limiteurMetier, empreinte, reply, 'trop de requêtes', 'rate_limited')`
- l. 147 : `await reply.code(401).send({ error: 'clé d’API invalide ou révoquée' });` devient `await refuser(reply, 401, 'unauthorized', 'clé d’API invalide ou révoquée');`
- l. 168 : `await reply.code(403).send({ error: 'espace suspendu', code: 'tenant_locked' });` devient `await refuser(reply, 403, 'tenant_locked', 'espace suspendu');`
- l. 183 (dans `requireScope`), le refus devient :

```ts
      await refuser(reply, 403, 'missing_scope', `scope requis : ${scope}`);
```

- [ ] **Step 5: `src/api/usage-guard.ts`, sans dépendance d'exécution**

Le docblock de `demanderOuRefuser` exige des imports de TYPE seulement : on n'importe pas `refuser`, on écrit le code dans le corps. Ajouter après la ligne 1 :

```ts
import type { CodeApi } from './erreurs';
```

- l. 166 : `await reply.code(429).send({ error: verdict.raison ?? 'quota d’usage atteint' });` devient `await reply.code(429).send({ error: verdict.raison ?? 'quota d’usage atteint', code: 'rate_limited' satisfies CodeApi });`
- l. 219 : `await reply.code(429).send({ error: 'trop d’opérations lourdes en cours sur cette instance, réessayez dans un instant' });` devient `await reply.code(429).send({ error: 'trop d’opérations lourdes en cours sur cette instance, réessayez dans un instant', code: 'rate_limited' satisfies CodeApi });`
- l. 235 : `await reply.code(401).send({ error: 'clé d’API requise' });` devient `await reply.code(401).send({ error: 'clé d’API requise', code: 'unauthorized' satisfies CodeApi });`

- [ ] **Step 6: Le voir passer, et ne rien casser à côté**

Run: `npx vitest run tests/api-garde-codes.test.ts tests/api-key-middleware.test.ts tests/api-key-prefiltre.test.ts tests/rate-limit-utilisateur.test.ts tests/api-usage-guard.test.ts tests/api-usage-observation.test.ts tests/api-arret-urgence.test.ts tests/mcp-serveur.test.ts && npm run typecheck`
Expected: PASS partout. ⚠️ `tests/rate-limit-utilisateur.test.ts` affirme `toEqual({ error: ... })` sur un refus de la CONSOLE : il doit rester vert, c'est la preuve que le code n'y fuit pas.

- [ ] **Step 7: Vérifier dans les deux sens**

Retirer `'missing_scope'` de `requireScope` (remettre l'ancien `reply.code(403).send({ error: ... })`), relancer `npx vitest run tests/api-garde-codes.test.ts` : le cas « droit manquant » échoue sur `code`. Restaurer, revoir le vert.

- [ ] **Step 8: Commit (procédure P)**

Chemins : `src/auth/rate-limit.ts src/auth/api-key.ts src/api/usage-guard.ts tests/api-garde-codes.test.ts`. Message : `feat(api): les refus de la garde commune portent un code (unauthorized, missing_scope, rate_limited)`.

---

### Task 3: La migration `contacts.external_id`, appliquée AVANT tout code qui la lit

**Files:**
- Create: `db/migrations/<N>_contacts_external_id.sql` (`<N>` pris à l'étape 1)
- Modify: `tests/migration-directives.test.ts:48-67` (la boucle sur les migrations réelles) et ajouts dans les deux `describe`
- Modify: `CLAUDE.md:97-99` (ligne du compteur, procédure P')

**Interfaces:**
- Consumes: rien.
- Produces: colonne `contacts.external_id text` nullable sans défaut ; index `contacts_tenant_external_id_uidx` unique `(tenant_id, external_id) where external_id is not null`.

- [ ] **Step 1: Prendre le numéro (le dossier ET `origin` tranchent sur ce qui est pris)**

```bash
cd /c/Users/julie/messagingme-mba && git fetch -q origin && { ls db/migrations; git ls-tree --name-only origin/main db/migrations/ | sed 's#.*/##'; } | grep -E '^[0-9]{4}_' | sort | tail -1
```

`<N>` = ce numéro + 1, sur quatre chiffres. Le fichier s'appelle `db/migrations/<N>_contacts_external_id.sql`.

- [ ] **Step 2: Élargir la garde des migrations hors transaction (test d'abord)**

Dans `tests/migration-directives.test.ts`, après `sansCommentaires` (l. 16), ajouter :

```ts
/**
 * Le SQL construit-il un index CONCURRENTLY, UNIQUE OU NON ?
 *
 * 🔴 LA RÈGLE NE VOYAIT PAS `create unique index concurrently` : son motif exigeait `index` juste après
 * `create`. Une migration d'index unique sans la directive aurait échoué au déploiement, migration à moitié
 * passée, sans que ce test ne dise rien.
 */
const construitConcurrently = (corps: string): boolean => /create\s+(unique\s+)?index\s+concurrently/i.test(corps);
const concurrentlySansGarde = (corps: string): boolean => /create\s+(unique\s+)?index\s+concurrently\s+(?!if\s+not\s+exists)/i.test(corps);
```

Dans la boucle du cas « les migrations RÉELLES » (l. 58 et l. 63), remplacer `const concurrently = /create\s+index\s+concurrently/i.test(corps);` par `const concurrently = construitConcurrently(corps);` et `const nonIdempotent = /create\s+index\s+concurrently\s+(?!if\s+not\s+exists)/i.test(corps);` par `const nonIdempotent = concurrentlySansGarde(corps);`.

Ajouter, dans le premier `describe`, après le cas « ignore une directive enfouie » :

```ts
  it('🔴 un index UNIQUE construit CONCURRENTLY est soumis à la même règle', () => {
    expect(construitConcurrently('create unique index concurrently if not exists x on t (a)')).toBe(true);
    expect(concurrentlySansGarde('create unique index concurrently x on t (a)')).toBe(true);
    expect(concurrentlySansGarde('create unique index concurrently if not exists x on t (a)')).toBe(false);
  });
```

Ajouter, dans le `describe` du découpage, après le cas de la 0096 :

```ts
  it('la migration de `contacts.external_id` se découpe en DEUX instructions : la colonne, puis l’index unique', () => {
    const f = readdirSync(MIGRATIONS).find((x) => x.endsWith('_contacts_external_id.sql'));
    expect(f, 'la migration existe').toBeDefined();
    const instructions = decouperInstructions(readFileSync(new URL(f!, MIGRATIONS), 'utf8'));
    expect(instructions).toHaveLength(2);
    expect(instructions[0]!.toLowerCase()).toContain('alter table contacts add column if not exists external_id text');
    expect(instructions[1]!.toLowerCase()).toContain('create unique index concurrently if not exists contacts_tenant_external_id_uidx');
    expect(instructions[1]!.toLowerCase()).toContain('where external_id is not null');
  });
```

- [ ] **Step 3: Le voir échouer**

Run: `npx vitest run tests/migration-directives.test.ts`
Expected: FAIL sur « la migration de `contacts.external_id` se découpe… » (`la migration existe`, `undefined`), les autres cas passent.

- [ ] **Step 4: Écrire la migration**

```sql
-- migrate: no-transaction
-- <N>_contacts_external_id.sql : l'identifiant de l'outil du client, garde sur la fiche (API publique, lot 1).
--
-- POURQUOI. Un outil qui appelle l'API par contact designe ses profils par SON identifiant, et envoie
-- souvent le numero ET cet identifiant dans le meme corps. La fiche doit pouvoir etre retrouvee par lui,
-- et une reponse doit pouvoir le rendre a l'outil qui l'a donne. external_id n'est PAS une adresse : aucun
-- message ne part vers lui.
--
-- UNIQUE PAR ESPACE, ET PARTIEL : null est l'etat de presque toutes les fiches, et deux fiches sans
-- identifiant externe ne sont pas en conflit. C'est un CONTRAT avec la requete de chercherParCles
-- (external_id = $3, dont l'egalite implique is not null) : en sortir ne produirait aucune erreur, seulement
-- un balayage de contacts.
--
-- AUCUNE BORNE DE LONGUEUR EN BASE : la seule ecriture est l'API publique, qui refuse au-dela de 512
-- caracteres (MAX_EXTERNAL_ID, src/api/fiche.ts). Un CHECK sur cette table se paierait d'un balayage pour une
-- garde qui existe deja a la porte.
--
-- ADDITIVE : l'ancien code ne lit pas la colonne. Elle passe AVANT tout deploiement du code qui la lit : les
-- select de contacts la nomment, et sans elle la liste du mini-CRM, la fiche et findByPhone rendraient 42703.
--
-- HORS TRANSACTION (CREATE INDEX CONCURRENTLY) : l'index se construit sans bloquer les ecritures de contacts,
-- qui est sur le chemin de chaque message entrant. Aucun filet : un echec a mi-parcours laisse un index
-- invalid, et la migration rejouee le SAUTE (if not exists). La verification apres coup n'est pas facultative :
--   select indisvalid from pg_index where indexrelid = 'contacts_tenant_external_id_uidx'::regclass;
-- false -> drop index concurrently contacts_tenant_external_id_uidx; puis rejouer. Precedent : 0115.
--
-- La purge RGPD remet la colonne a null (PgContactStore.purgeMany) : l'identifiant du client ne survit pas a
-- l'effacement, et il ne bloque pas la recreation d'une fiche avec le meme identifiant.

alter table contacts add column if not exists external_id text;

create unique index concurrently if not exists contacts_tenant_external_id_uidx
  on contacts (tenant_id, external_id)
  where external_id is not null;
```

- [ ] **Step 5: Le voir passer, puis vérifier dans les deux sens**

Run: `npx vitest run tests/migration-directives.test.ts`
Expected: PASS.

Mutation : retirer la ligne `-- migrate: no-transaction` de la migration, relancer : le cas « les migrations RÉELLES » échoue avec `<N>_contacts_external_id.sql : CONCURRENTLY sans la directive -> échec au déploiement`. Remettre l'ancienne regex `/create\s+index\s+concurrently/i` dans la boucle avec la directive toujours absente : le test PASSE à tort (c'est le trou fermé). Tout restaurer, revoir le vert.

- [ ] **Step 6: La ligne du compteur, DANS le commit qui prend le numéro (procédure P')**

Dans `CLAUDE.md`, section Déploiement, remplacer la fin du paragraphe « **Dernière appliquée : … » (aujourd'hui « **Prochaine libre = 0172**, et le dossier `db/migrations/` s'arrête à 0171. », à relire sur `origin` au moment de l'écrire) par :

```md
**ÉCRITE ET PAS ENCORE APPLIQUÉE : <N>** (`contacts_external_id`, l'identifiant de l'outil du client sur
la fiche, lot 1 de l'API publique : une colonne nullable et un index unique partiel `CONCURRENTLY`, donc
hors transaction ; AVANT tout push du code qui la lit). **Prochaine libre = <N+1>**, et le dossier
`db/migrations/` s'arrête à <N>.
```

- [ ] **Step 7: Commit (procédure P, avec P' pour `CLAUDE.md`)**

Chemins : `db/migrations/<N>_contacts_external_id.sql tests/migration-directives.test.ts CLAUDE.md`. Message : `feat(db): <N> contacts.external_id et son index unique partiel (CONCURRENTLY)`. Prévenir les autres sessions (`SendMessage`) : numéro pris, prochain libre `<N+1>`, et « ne déployez pas `origin/main` avant que <N> soit appliquée ».

- [ ] **Step 8: Appliquer en production AVANT de pousser la tâche 4**

🔴 Dès que la tâche 4 est poussée, `origin/main` contient des `select` qui nomment `external_id` ; une autre session qui déploie `origin/main` avant la migration mettrait `42703` sur la liste du mini-CRM, la fiche et `findByPhone`. La migration passe donc MAINTENANT, seule, sans `up` (aucun code de production ne la lit encore).

1. `/revue-finale` sur le commit de la migration (la garde `.claude/deploy.json` exige une revue finale attestée pour un `npm run migrate` par `ssh`).
2. Sur le VPS (adresse : `brain/INFRA.md`) :

```bash
cd /home/ubuntu/mba && git pull && sudo docker compose build mba-api
sudo docker compose run --rm --no-deps --entrypoint sh mba-api -c 'ls db/migrations | tail -4'
```

3. Lire ce que `migrate` appliquera : comparer la liste ci-dessus à `select name from public.schema_migrations order by name desc limit 5;` (relecture en LECTURE seule, par le moyen habituel, par exemple `execute_sql` du connecteur Supabase). 🔴 Si une AUTRE migration que `<N>` est en attente, s'arrêter et demander à Julien (précédent : 0159 mise de côté avant le build).
4. `sudo docker compose run --rm --no-deps mba-api npm run migrate`
5. Relire en base, point par point, juste après :

```sql
select name, applied_at from public.schema_migrations order by name desc limit 2;
select data_type, is_nullable, column_default from information_schema.columns
 where table_schema = 'public' and table_name = 'contacts' and column_name = 'external_id';
select indexdef from pg_indexes where indexname = 'contacts_tenant_external_id_uidx';
select indisvalid from pg_index where indexrelid = 'contacts_tenant_external_id_uidx'::regclass;
select count(*) from contacts where external_id is not null;
```

Attendu : `<N>` en tête ; `text`, `YES`, `null` ; `... USING btree (tenant_id, external_id) WHERE (external_id IS NOT NULL)` ; `true` ; `0`. Si `indisvalid` vaut `false` : `drop index concurrently contacts_tenant_external_id_uidx;` puis rejouer `migrate`.

6. Mettre à jour la ligne du compteur (procédure P' sur `CLAUDE.md`) : « **Dernière appliquée : <N>**, le <date> à <heure> UTC (`contacts_external_id`), AVANT le push du code qui la lit, relue en base point par point (`indisvalid = true`, zéro fiche ne porte d'identifiant externe). » Message : `docs(migrations): <N> est appliquee, relue en base point par point`.

---

### Task 4: Le dépôt des contacts connaît l'identifiant externe

**Files:**
- Modify: `src/crm/contact-store.pg.ts:6-27` (`ContactRow`), `:290-300` (`findByPhone`), `:709-733` (`rowToContact`, `SELECT_ONE`), `:834-850` (le `select` de `query`), `:1170-1181` (anonymisation de `purgeMany`) ; méthodes neuves insérées après `waIdOfContact` (fin l. 707)
- Modify: `tests/contacts.test.ts:20-24` et `tests/http-import.test.ts:66,69` (fixtures `ContactRow`)
- Modify: `tests/integration/purge-rgpd.integration.test.ts` (`beforeAll` et le cas « plus AUCUNE trace »)
- Test: `tests/contacts-identite-store.test.ts` (unitaire), `tests/integration/contacts-identite.integration.test.ts` (CI seulement)

**Interfaces:**
- Consumes: la colonne de la Task 3.
- Produces (dans `src/crm/contact-store.pg.ts`) :
  - `ContactRow.externalId: string | null`
  - `export interface FicheIdentite { id: string; externalId: string | null; phoneE164: string | null; bsuid: string | null }`
  - `export interface ClesNormalisees { contactId?: string; externalId?: string; phoneE164?: string; bsuid?: string }`
  - `export type CreationFiche = (FicheIdentite & { created: boolean }) | 'conflit'`
  - `export interface FicheApiLigne { id; externalId; phoneE164; bsuid; profileName; fields: Record<string, unknown>; tags: string[]; optInStatus: string; optInSource: string | null; optOutAt: string | null; rcsOptoutAt: string | null; blockedAt: string | null; whatsappJoignable: boolean | null; whatsappJoignableLe: string | null; createdAt: string }`
  - `export interface EditionFicheApi { fields: Record<string, string>; removeFields: string[]; addTags: string[]; removeTags: string[]; profileName?: string | null }`
  - `editerFicheApi(tenantId: string, contactId: string, e: EditionFicheApi): Promise<boolean>` (`false` = fiche absente, supprimée ou purgée : rien n'est écrit)
  - `chercherParCles(tenantId: string, cles: ClesNormalisees): Promise<FicheIdentite[]>`
  - `creerFicheApi(tenantId: string, cles: { phoneE164?: string; bsuid?: string; externalId?: string }): Promise<CreationFiche>`
  - `rattacherCles(tenantId: string, contactId: string, cles: { externalId?: string; phoneE164?: string; bsuid?: string }): Promise<'ok' | 'conflit' | 'absente'>`
  - `poserExternalId(tenantId: string, contactId: string, externalId: string): Promise<'ok' | 'conflit' | 'absente'>`
  - `lireFicheApi(tenantId: string, contactId: string): Promise<FicheApiLigne | null>`

- [ ] **Step 1: Écrire le test unitaire qui échoue**

```ts
// tests/contacts-identite-store.test.ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';

/**
 * LES MÉTHODES D'IDENTITÉ DU DÉPÔT (API publique, lot 1), sur un faux pool.
 *
 * Ce qui se vérifie ici sans base : la FORME des requêtes (l'espace en $1, les fiches supprimées exclues,
 * l'index visé par chaque `on conflict`) et la traduction des refus de la base (`23505` -> « conflit », jamais
 * une 500 que Cloudflare remplacerait par sa page). Ce que la base fait vraiment de ces requêtes est dans
 * `tests/integration/contacts-identite.integration.test.ts`, en CI.
 */
const T = '11111111-1111-4111-8111-111111111111';
const ID = '00000000-0000-4000-8000-000000000001';

function pool(reponse: (sql: string) => { rows: unknown[]; rowCount: number } | Error) {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const p = {
    query: async (sql: string, params: unknown[] = []) => {
      appels.push({ sql, params });
      const r = reponse(sql);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { p: p as unknown as Pool, appels };
}
const unicite = (): Error => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

describe('chercherParCles', () => {
  it('sans aucune clé, ne va même pas en base', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 0 }));
    expect(await new PgContactStore(p).chercherParCles(T, {})).toEqual([]);
    expect(appels).toHaveLength(0);
  });

  it('🔴 l’espace est en $1, les fiches supprimées sont exclues, et chaque clé a son paramètre', async () => {
    const { p, appels } = pool(() => ({ rows: [{ id: ID, external_id: 'crm-7781', phone_e164: '+33612345678', bsuid: null }], rowCount: 1 }));
    const r = await new PgContactStore(p).chercherParCles(T, { externalId: 'crm-7781', phoneE164: '+33612345678' });
    expect(r).toEqual([{ id: ID, externalId: 'crm-7781', phoneE164: '+33612345678', bsuid: null }]);
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and deleted_at is null/);
    expect(appels[0]!.params).toEqual([T, null, 'crm-7781', '+33612345678', null]);
  });
});

describe('creerFicheApi', () => {
  it('par numéro, le conflit vise l’index du NUMÉRO ; sans numéro, celui du BSUID', async () => {
    const { p, appels } = pool(() => ({ rows: [{ id: ID, created: true, external_id: null, phone_e164: '+33612345678', bsuid: null }], rowCount: 1 }));
    const s = new PgContactStore(p);
    await s.creerFicheApi(T, { phoneE164: '+33612345678' });
    await s.creerFicheApi(T, { bsuid: 'BSUID-1' });
    expect(appels[0]!.sql).toMatch(/on conflict \(tenant_id, phone_e164\) where phone_e164 is not null/);
    expect(appels[1]!.sql).toMatch(/on conflict \(tenant_id, bsuid\) where bsuid is not null/);
  });

  it('🔴 une violation d’unicité (identifiant externe ou BSUID pris par une autre fiche) rend « conflit »', async () => {
    const { p } = pool(() => unicite());
    expect(await new PgContactStore(p).creerFicheApi(T, { phoneE164: '+33612345678', externalId: 'crm-7781' })).toBe('conflit');
  });

  it('une autre panne remonte telle quelle', async () => {
    const { p } = pool(() => new Error('connexion perdue'));
    await expect(new PgContactStore(p).creerFicheApi(T, { phoneE164: '+33612345678' })).rejects.toThrow('connexion perdue');
  });

  it('refuse d’être appelée sans numéro ni BSUID : la base exige l’un des deux', async () => {
    const { p } = pool(() => ({ rows: [], rowCount: 0 }));
    await expect(new PgContactStore(p).creerFicheApi(T, { externalId: 'crm-7781' })).rejects.toThrow(/numéro ou un BSUID/);
  });
});

describe('rattacherCles', () => {
  it('🔴 une clé que la fiche porte déjà AUTREMENT rend « conflit » : on rattache, on ne remplace pas', async () => {
    const { p } = pool(() => ({ rows: [{ external_id: 'crm-autre', phone_e164: '+33612345678', bsuid: null }], rowCount: 1 }));
    expect(await new PgContactStore(p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('conflit');
  });

  it('clé posée : « ok » ; fiche disparue : « absente » ; unicité violée : « conflit »', async () => {
    const pose = pool(() => ({ rows: [{ external_id: 'crm-7781', phone_e164: null, bsuid: 'B' }], rowCount: 1 }));
    expect(await new PgContactStore(pose.p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('ok');
    expect(pose.appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(await new PgContactStore(pool(() => ({ rows: [], rowCount: 0 })).p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('absente');
    expect(await new PgContactStore(pool(() => unicite()).p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('conflit');
  });
});

describe('poserExternalId', () => {
  it('remplace ; fiche absente : « absente » ; déjà porté ailleurs : « conflit »', async () => {
    expect(await new PgContactStore(pool(() => ({ rows: [], rowCount: 1 })).p).poserExternalId(T, ID, 'crm-9')).toBe('ok');
    expect(await new PgContactStore(pool(() => ({ rows: [], rowCount: 0 })).p).poserExternalId(T, ID, 'crm-9')).toBe('absente');
    expect(await new PgContactStore(pool(() => unicite()).p).poserExternalId(T, ID, 'crm-9')).toBe('conflit');
  });
});

describe('editerFicheApi', () => {
  it('🔴 UNE requête, dans l’espace, sur une fiche ACTIVE : pas de transaction ni de client dédié par élément', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 1 }));
    const e = { fields: { ville: 'Lyon' }, removeFields: ['age'], addTags: ['vip'], removeTags: ['froid'], profileName: 'Camille' };
    expect(await new PgContactStore(p).editerFicheApi(T, ID, e)).toBe(true);
    expect(appels).toHaveLength(1);
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(appels[0]!.params).toEqual([T, ID, '{"ville":"Lyon"}', ['age'], ['vip'], ['froid'], true, 'Camille']);
  });

  it('🔴 fiche absente, supprimée ou purgée entre la résolution et l’écriture : `false`, et rien n’est réécrit', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 0 }));
    expect(await new PgContactStore(p).editerFicheApi(T, ID, { fields: {}, removeFields: [], addTags: ['a'], removeTags: [] })).toBe(false);
    // Nom non fourni : le drapeau dit « on n'y touche pas », la valeur est nulle et n'est pas lue.
    expect(appels[0]!.params.slice(6)).toEqual([false, null]);
  });
});

describe('lireFicheApi', () => {
  it('🔴 exclut les fiches supprimées et rend les dates en ISO', async () => {
    const { p, appels } = pool(() => ({
      rows: [{
        id: ID, external_id: 'crm-7781', phone_e164: '+33612345678', bsuid: null, profile_name: 'Camille Roy',
        fields: { ville: 'Lyon' }, tags: ['prospect'], opt_in_status: 'opted_out', opt_in_source: 'api',
        opt_out_at: new Date('2026-09-24T10:00:00.000Z'), rcs_optout_at: null, blocked_at: null,
        whatsapp_joignable: null, whatsapp_joignable_le: null, created_at: new Date('2026-09-01T00:00:00.000Z'),
      }],
      rowCount: 1,
    }));
    const f = await new PgContactStore(p).lireFicheApi(T, ID);
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(f).toMatchObject({ id: ID, externalId: 'crm-7781', optInStatus: 'opted_out', optOutAt: '2026-09-24T10:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', blockedAt: null });
  });
});

describe('ContactRow porte l’identifiant externe', () => {
  it('lu par getById ; absent de la ligne, il vaut null et non undefined', async () => {
    const ligne = {
      id: ID, phone_e164: '+33612345678', bsuid: null, profile_name: null, opt_in_status: 'unknown', fields: {},
      tags: [], created_at: new Date('2026-09-01T00:00:00.000Z'), blocked_at: null, whatsapp_joignable: null, whatsapp_joignable_le: null,
    };
    const avec = await new PgContactStore(pool(() => ({ rows: [{ ...ligne, external_id: 'crm-7781' }], rowCount: 1 })).p).getById(T, ID);
    expect(avec?.externalId).toBe('crm-7781');
    const sans = await new PgContactStore(pool(() => ({ rows: [ligne], rowCount: 1 })).p).getById(T, ID);
    expect(sans?.externalId).toBeNull();
  });
});

describe('la purge', () => {
  it('🔴 efface l’identifiant externe avec le numéro et le nom', async () => {
    const sqls: string[] = [];
    const client = { query: async (sql: string) => { sqls.push(sql); return { rows: [], rowCount: 0 }; }, release: () => {} };
    const store = new PgContactStore({ connect: async () => client } as unknown as Pool);
    await store.purgeMany(T, [ID]);
    const anonymisation = sqls.find((s) => /anonymized_at = now\(\)/.test(s));
    expect(anonymisation, 'la requête d’anonymisation').toBeDefined();
    expect(anonymisation).toMatch(/external_id = null/);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/contacts-identite-store.test.ts`
Expected: FAIL, `chercherParCles is not a function` (et consorts), `externalId` indéfini, `external_id = null` absent de la purge.

- [ ] **Step 3: Les types, en tête de `src/crm/contact-store.pg.ts`**

Dans `ContactRow` (l. 6-27), après `bsuid: string | null;`, ajouter :

```ts
  /**
   * L'identifiant de l'OUTIL DU CLIENT (migration <N>), posé par l'API publique. `null` = aucun.
   * Il sert à RETROUVER la fiche et à réécrire dans l'outil qui l'a donné, jamais d'adresse d'envoi.
   */
  externalId: string | null;
```

Après la fermeture de `ContactRow` (l. 27), ajouter :

```ts
/** Ce qu'il faut d'une fiche pour savoir QUELLES clés elle porte (`resoudreFiche`, `src/api/fiche.ts`). */
export interface FicheIdentite {
  id: string;
  externalId: string | null;
  phoneE164: string | null;
  bsuid: string | null;
}

/** Les clés d'une fiche, NORMALISÉES (numéro en E.164). L'appelant en donne au moins une. */
export interface ClesNormalisees {
  contactId?: string;
  externalId?: string;
  phoneE164?: string;
  bsuid?: string;
}

/** Une fiche créée ou retrouvée par l'index du numéro ou du BSUID, ou le refus d'un index d'unicité. */
export type CreationFiche = (FicheIdentite & { created: boolean }) | 'conflit';

/** Tout ce que `GET /v1/contacts/{contactId}` rend, lu en UNE requête. Dates en ISO. */
export interface FicheApiLigne {
  id: string;
  externalId: string | null;
  phoneE164: string | null;
  bsuid: string | null;
  profileName: string | null;
  fields: Record<string, unknown>;
  tags: string[];
  optInStatus: string;
  optInSource: string | null;
  optOutAt: string | null;
  rcsOptoutAt: string | null;
  blockedAt: string | null;
  whatsappJoignable: boolean | null;
  whatsappJoignableLe: string | null;
  createdAt: string;
}

/**
 * Ce que l'API publique écrit sur une fiche déjà résolue (`editerFicheApi`). `profileName` : `undefined` = on
 * n'y touche pas, `null` = vider.
 */
export interface EditionFicheApi {
  fields: Record<string, string>;
  removeFields: string[];
  addTags: string[];
  removeTags: string[];
  profileName?: string | null;
}

/** Une violation d'index unique : un refus de SAISIE, pas une panne. */
const estUnicite = (err: unknown): boolean => (err as { code?: string }).code === '23505';
```

- [ ] **Step 4: `external_id` dans les trois lectures qui alimentent `ContactRow`**

- `findByPhone` (l. 290-300) : la liste de colonnes devient `select id, external_id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at, blocked_at,`.
- `SELECT_ONE` (l. 730-733) : `select id, external_id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at, blocked_at,`.
- `query` (l. 843-844) : `select id, external_id, phone_e164, bsuid, profile_name, opt_in_status, fields, tags, created_at, blocked_at,`.
- `rowToContact` (l. 709-729) : ajouter `external_id?: string | null;` au type du paramètre, et `externalId: r.external_id ?? null,` après `id: r.id,` dans l'objet rendu (le `?? null` a la même raison que celui de `whatsappJoignable`, commentée juste en dessous).

- [ ] **Step 5: Les méthodes d'identité, après `waIdOfContact` (fin l. 707)**

```ts
  /**
   * LES FICHES ACTIVES QUE DÉSIGNE CHACUNE DES CLÉS DONNÉES, en UNE requête (API publique, `resoudreFiche`).
   *
   * Chaque clé est unique par espace (clé primaire, `contacts_tenant_phone_uidx`, `contacts_tenant_bsuid_uidx`,
   * `contacts_tenant_external_id_uidx`) : au plus une fiche par clé, donc au plus quatre lignes. C'est
   * `resoudreFiche` qui juge si elles désignent la même personne, pas ce `select`.
   *
   * ⚠️ `contactId` DOIT avoir la forme d'un UUID (l'appelant le garantit) : sinon le cast lève `22P02`.
   * ⚠️ Égalité EXACTE sur le numéro : l'API le normalise en E.164 avant de chercher, comme il est stocké.
   */
  async chercherParCles(tenantId: string, cles: ClesNormalisees): Promise<FicheIdentite[]> {
    if (!cles.contactId && !cles.externalId && !cles.phoneE164 && !cles.bsuid) return [];
    const res = await this.pool.query<{ id: string; external_id: string | null; phone_e164: string | null; bsuid: string | null }>(
      `select id, external_id, phone_e164, bsuid from contacts
        where tenant_id = $1 and deleted_at is null
          and (id = $2::uuid or external_id = $3 or phone_e164 = $4 or bsuid = $5)
        limit 4`,
      [tenantId, cles.contactId ?? null, cles.externalId ?? null, cles.phoneE164 ?? null, cles.bsuid ?? null],
    );
    return res.rows.map((r) => ({ id: r.id, externalId: r.external_id, phoneE164: r.phone_e164, bsuid: r.bsuid }));
  }

  /**
   * CRÉE UNE FICHE NUE pour l'API publique, par son numéro ou, à défaut, son BSUID.
   *
   * 🔴 `on conflict ... do update`, et pas `do nothing` : une fiche SUPPRIMÉE qui porte encore ce numéro (une
   * suppression douce d'avant l'anonymisation) est RESSUSCITÉE, exactement comme le faisait l'upsert de l'API
   * (`upsertByPhoneReturningId`, `deleted_at = null`). Les clés déjà portées sont GARDÉES (`coalesce`) :
   * l'appelant compare ce qui est rendu à ce qu'il a demandé, et conclut au conflit si elles diffèrent.
   *
   * ⚠️ Une violation d'un AUTRE index unique (l'identifiant externe ou le BSUID pris par une autre fiche) rend
   * « conflit » : `resoudreFiche` relit alors la base, qui dit laquelle.
   */
  async creerFicheApi(tenantId: string, cles: { phoneE164?: string; bsuid?: string; externalId?: string }): Promise<CreationFiche> {
    if (!cles.phoneE164 && !cles.bsuid) throw new Error('creerFicheApi : un numéro ou un BSUID est requis');
    const conflit = cles.phoneE164
      ? 'on conflict (tenant_id, phone_e164) where phone_e164 is not null'
      : 'on conflict (tenant_id, bsuid) where bsuid is not null';
    try {
      const res = await this.pool.query<{ id: string; created: boolean; external_id: string | null; phone_e164: string | null; bsuid: string | null }>(
        `insert into contacts (tenant_id, phone_e164, bsuid, external_id)
         values ($1, $2, $3, $4)
         ${conflit}
         do update set
           external_id = coalesce(contacts.external_id, excluded.external_id),
           bsuid = coalesce(contacts.bsuid, excluded.bsuid),
           deleted_at = null,
           updated_at = now()
         returning id, (xmax = 0) as created, external_id, phone_e164, bsuid`,
        [tenantId, cles.phoneE164 ?? null, cles.bsuid ?? null, cles.externalId ?? null],
      );
      const r = res.rows[0];
      if (!r) throw new Error('creerFicheApi : aucune ligne rendue');
      return { id: r.id, created: r.created, externalId: r.external_id, phoneE164: r.phone_e164, bsuid: r.bsuid };
    } catch (err) {
      if (estUnicite(err)) return 'conflit';
      throw err;
    }
  }

  /**
   * RATTACHE à une fiche les clés qu'elle ne porte PAS ENCORE. Ne remplace jamais une clé portée.
   *
   * `coalesce`, puis relecture de ce qui est rendu : si la fiche portait déjà une AUTRE valeur (ou qu'une
   * écriture concurrente l'a posée entre-temps), la clé demandée n'y est pas, et c'est un « conflit ».
   * ⚠️ Rattacher un numéro à une fiche qui n'avait qu'un BSUID change son adresse WhatsApp (`waIdOf` préfère
   * le numéro) : aucune fiche n'est dans ce cas tant qu'aucun BSUID n'a été reçu.
   */
  async rattacherCles(
    tenantId: string,
    contactId: string,
    cles: { externalId?: string; phoneE164?: string; bsuid?: string },
  ): Promise<'ok' | 'conflit' | 'absente'> {
    try {
      const res = await this.pool.query<{ external_id: string | null; phone_e164: string | null; bsuid: string | null }>(
        `update contacts
            set external_id = coalesce(external_id, $3),
                phone_e164 = coalesce(phone_e164, $4),
                bsuid = coalesce(bsuid, $5),
                updated_at = now()
          where tenant_id = $1 and id = $2 and deleted_at is null
          returning external_id, phone_e164, bsuid`,
        [tenantId, contactId, cles.externalId ?? null, cles.phoneE164 ?? null, cles.bsuid ?? null],
      );
      const r = res.rows[0];
      if (!r) return 'absente';
      const tient = (voulu: string | undefined, porte: string | null): boolean => voulu === undefined || voulu === porte;
      return tient(cles.externalId, r.external_id) && tient(cles.phoneE164, r.phone_e164) && tient(cles.bsuid, r.bsuid) ? 'ok' : 'conflit';
    } catch (err) {
      if (estUnicite(err)) return 'conflit';
      throw err;
    }
  }

  /** POSE ou REMPLACE l'identifiant externe (`PATCH /v1/contacts/{contactId}`). Porté ailleurs : « conflit ». */
  async poserExternalId(tenantId: string, contactId: string, externalId: string): Promise<'ok' | 'conflit' | 'absente'> {
    try {
      const res = await this.pool.query(
        `update contacts set external_id = $3, updated_at = now()
          where tenant_id = $1 and id = $2 and deleted_at is null`,
        [tenantId, contactId, externalId],
      );
      return (res.rowCount ?? 0) > 0 ? 'ok' : 'absente';
    } catch (err) {
      if (estUnicite(err)) return 'conflit';
      throw err;
    }
  }

  /**
   * ÉCRIT CE QUE L'API PUBLIQUE A DEMANDÉ SUR UNE FICHE DÉJÀ RÉSOLUE, en UNE requête : fusion des champs
   * (une clé absente n'est jamais écrasée), retrait des clés vidées, union puis retrait des étiquettes, nom.
   *
   * 🔴 `deleted_at is null` DANS LE `where`, et c'est la raison de cette méthode. `applyEdits` (la fiche de la
   * console) verrouille sans ce filtre : une purge passée entre `resoudreFiche` et l'écriture ferait réécrire
   * un nom et des champs sur une fiche ANONYMISÉE. Ici, elle rend `false`, donc `unknown_contact`.
   * 🔴 ET UNE SEULE REQUÊTE, sans transaction ni client dédié : `/v1/contacts/batch` en lance
   * `ECRITURES_EN_VOL` à la fois, et une transaction par élément (connexion, `begin`, verrou, jusqu'à trois
   * mises à jour, relecture, `commit`) retiendrait autant de connexions d'un pool que l'Inbox partage. L'ordre
   * de `applyEdits` est gardé : on fusionne puis on retire, on ajoute puis on retire (une étiquette présente
   * dans les deux listes n'est pas sur la fiche à la fin).
   * ⚠️ Aucun événement d'automation n'en part : l'API n'émet jamais (invariant « aucun chemin de masse n'émet »).
   */
  async editerFicheApi(tenantId: string, contactId: string, e: EditionFicheApi): Promise<boolean> {
    const res = await this.pool.query(
      `update contacts
          set fields = (coalesce(fields, '{}'::jsonb) || $3::jsonb) - $4::text[],
              -- Sans etiquette a ajouter ni a retirer, la liste n est pas reecrite (ni triee, ni dedoublonnee),
              -- comme applyEdits qui n y touche pas dans ce cas.
              tags = case when cardinality($5::text[]) + cardinality($6::text[]) = 0 then tags
                          else (select coalesce(array_agg(distinct t), '{}')
                                  from unnest(coalesce(tags, '{}') || $5::text[]) t
                                 where t <> all($6::text[]))
                     end,
              profile_name = case when $7::boolean then $8::text else profile_name end,
              updated_at = now()
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [
        tenantId, contactId, JSON.stringify(e.fields), e.removeFields, e.addTags, e.removeTags,
        e.profileName !== undefined, e.profileName ?? null,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * TOUT CE QUE L'API REND D'UNE FICHE, en une requête. Une fiche supprimée n'existe plus : `null`, donc 404.
   * ⚠️ `contactId` doit avoir la forme d'un UUID : l'appelant le vérifie avant (`estUuid`).
   */
  async lireFicheApi(tenantId: string, contactId: string): Promise<FicheApiLigne | null> {
    const res = await this.pool.query<{
      id: string; external_id: string | null; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      fields: Record<string, unknown> | null; tags: string[] | null; opt_in_status: string; opt_in_source: string | null;
      opt_out_at: Date | null; rcs_optout_at: Date | null; blocked_at: Date | null;
      whatsapp_joignable: boolean | null; whatsapp_joignable_le: Date | null; created_at: Date;
    }>(
      `select id, external_id, phone_e164, bsuid, profile_name, fields, tags, opt_in_status, opt_in_source,
              opt_out_at, rcs_optout_at, blocked_at, whatsapp_joignable, whatsapp_joignable_le, created_at
         from contacts
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [tenantId, contactId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
    return {
      id: r.id, externalId: r.external_id, phoneE164: r.phone_e164, bsuid: r.bsuid, profileName: r.profile_name,
      fields: r.fields ?? {}, tags: r.tags ?? [], optInStatus: r.opt_in_status, optInSource: r.opt_in_source,
      optOutAt: iso(r.opt_out_at), rcsOptoutAt: iso(r.rcs_optout_at), blockedAt: iso(r.blocked_at),
      whatsappJoignable: r.whatsapp_joignable, whatsappJoignableLe: iso(r.whatsapp_joignable_le),
      createdAt: r.created_at.toISOString(),
    };
  }
```

(Le commentaire SQL d'`editerFicheApi` est SANS accents graves ni apostrophes, comme les autres commentaires SQL du fichier : il vit dans un gabarit de chaîne TypeScript, qu'un accent grave fermerait.)

- [ ] **Step 6: La purge efface l'identifiant externe (l. 1170-1181)**

Dans le `set` de l'anonymisation, après `jeton_public = null,`, ajouter :

```sql
                -- L IDENTIFIANT EXTERNE part aussi : il designe cette personne dans l outil du client, et il
                -- bloquerait la recreation d une fiche avec le meme identifiant (index unique par espace).
                external_id = null,
```

(Commentaire SANS accents graves : il vit dans un gabarit de chaîne TypeScript, un accent grave le fermerait.)

- [ ] **Step 7: Les fixtures de `ContactRow`**

- `tests/contacts.test.ts:20-24` : ajouter `externalId: null,` dans `CONTACT`.
- `tests/http-import.test.ts:66` et `:69` : ajouter `externalId: null,` dans les deux objets.

- [ ] **Step 8: Le voir passer**

Run: `npx vitest run tests/contacts-identite-store.test.ts tests/contacts.test.ts tests/http-import.test.ts tests/optout-poussee.test.ts && npm run typecheck`
Expected: PASS, typecheck sans erreur.

- [ ] **Step 9: Vérifier dans les deux sens (purge, fiche active)**

1. Retirer `external_id = null,` de la purge, relancer `npx vitest run tests/contacts-identite-store.test.ts` : « efface l’identifiant externe » échoue sur `toMatch(/external_id = null/)`. Restaurer.
2. Noter AVANT la mutation le résultat de `grep -c 'where tenant_id = \$1 and id = \$2 and deleted_at is null' src/crm/contact-store.pg.ts`. Dans `editerFicheApi`, retirer ` and deleted_at is null` du `where` : « UNE requête, dans l’espace, sur une fiche ACTIVE » échoue sur le `toMatch`. Restaurer ; la même commande `grep -c` rend le MÊME nombre qu'avant (la restauration se prouve, elle ne se regarde pas). Revoir le vert.

- [ ] **Step 10: Le test d'intégration (CI seulement, jamais en local)**

```ts
// tests/integration/contacts-identite.integration.test.ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';

/**
 * L'IDENTITÉ D'UNE FICHE CONTRE UNE VRAIE BASE (API publique, lot 1). Espaces jetables, créés et détruits ici.
 *
 * Ce qu'un faux ne peut pas dire : que l'index partiel existe et est VALIDE, que l'unicité est bien PAR
 * ESPACE, que `coalesce` ne remplace jamais une clé portée, et qu'une fiche supprimée disparaît des lectures.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('identité des fiches : external_id et les clés de l’API publique', () => {
  let pool: Pool;
  let store: PgContactStore;
  let tenantId = '';
  let autreTenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgContactStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-identite') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-identite-voisin') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  const creer = async (t: string, cles: { phoneE164?: string; bsuid?: string; externalId?: string }) => {
    const c = await store.creerFicheApi(t, cles);
    if (c === 'conflit') throw new Error(`création refusée : ${JSON.stringify(cles)}`);
    return c;
  };

  it('🔴 l’index d’external_id existe, est VALIDE, et porte son prédicat partiel', async () => {
    const def = await pool.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'contacts_tenant_external_id_uidx'`);
    expect(def.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(tenant_id, external_id\) WHERE \(external_id IS NOT NULL\)/);
    const valide = await pool.query<{ indisvalid: boolean }>(`select indisvalid from pg_index where indexrelid = 'contacts_tenant_external_id_uidx'::regclass`);
    expect(valide.rows[0]?.indisvalid).toBe(true);
  });

  it('une fiche créée par numéro se retrouve par CHACUNE de ses clés, et seulement dans son espace', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000701', externalId: 'itest-ext-701' });
    expect(c.created).toBe(true);
    for (const cles of [{ contactId: c.id }, { externalId: 'itest-ext-701' }, { phoneE164: '+33600000701' }]) {
      expect((await store.chercherParCles(tenantId, cles)).map((f) => f.id)).toEqual([c.id]);
    }
    expect(await store.chercherParCles(autreTenantId, { externalId: 'itest-ext-701' })).toEqual([]);
    expect((await store.findByPhone(tenantId, '+33600000701'))?.externalId).toBe('itest-ext-701');
  });

  it('🔴 un identifiant externe est unique PAR ESPACE', async () => {
    await creer(tenantId, { phoneE164: '+33600000702', externalId: 'itest-ext-702' });
    expect(await store.creerFicheApi(tenantId, { phoneE164: '+33600000703', externalId: 'itest-ext-702' })).toBe('conflit');
    const ailleurs = await creer(autreTenantId, { phoneE164: '+33600000702', externalId: 'itest-ext-702' });
    expect(ailleurs.created).toBe(true);
  });

  it('rattacherCles pose une clé manquante et ne REMPLACE jamais une clé portée', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000704' });
    expect(await store.rattacherCles(tenantId, c.id, { externalId: 'itest-ext-704' })).toBe('ok');
    expect(await store.rattacherCles(tenantId, c.id, { externalId: 'itest-ext-autre' })).toBe('conflit');
    expect((await store.lireFicheApi(tenantId, c.id))?.externalId).toBe('itest-ext-704');
  });

  it('poserExternalId remplace, et refuse une valeur portée par une autre fiche de l’espace', async () => {
    const a = await creer(tenantId, { phoneE164: '+33600000705', externalId: 'itest-ext-705' });
    const b = await creer(tenantId, { phoneE164: '+33600000706' });
    expect(await store.poserExternalId(tenantId, a.id, 'itest-ext-705-bis')).toBe('ok');
    expect(await store.poserExternalId(tenantId, b.id, 'itest-ext-705-bis')).toBe('conflit');
    expect((await store.lireFicheApi(tenantId, b.id))?.externalId).toBeNull();
  });

  it('🔴 editerFicheApi : fusion, retrait, étiquettes et nom en une requête ; une fiche SUPPRIMÉE n’est pas réécrite', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000714' });
    expect(await store.editerFicheApi(tenantId, c.id, { fields: { ville: 'Lyon', age: '42' }, removeFields: [], addTags: ['a', 'b'], removeTags: [], profileName: 'Camille' })).toBe(true);
    // Une étiquette ajoutée ET retirée dans le même appel n'est pas sur la fiche à la fin (ordre d'`applyEdits`).
    expect(await store.editerFicheApi(tenantId, c.id, { fields: { prenom: 'Camille' }, removeFields: ['age'], addTags: ['c', 'a'], removeTags: ['b', 'c'] })).toBe(true);
    const lue = await store.lireFicheApi(tenantId, c.id);
    expect(lue?.fields).toEqual({ ville: 'Lyon', prenom: 'Camille' });
    expect(lue?.tags).toEqual(['a']);
    expect(lue?.profileName).toBe('Camille');
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(await store.editerFicheApi(tenantId, c.id, { fields: { ville: 'Paris' }, removeFields: [], addTags: [], removeTags: [], profileName: 'Intrus' })).toBe(false);
    const brute = await pool.query<{ fields: Record<string, string>; profile_name: string | null }>('select fields, profile_name from contacts where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(brute.rows[0]?.fields).toEqual({ ville: 'Lyon', prenom: 'Camille' });
    expect(brute.rows[0]?.profile_name).toBe('Camille');
  });

  it('une fiche supprimée disparaît des lectures de l’API', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000707', externalId: 'itest-ext-707' });
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(await store.lireFicheApi(tenantId, c.id)).toBeNull();
    expect(await store.chercherParCles(tenantId, { contactId: c.id })).toEqual([]);
  });

  it('une création BSUID seul vise l’index du BSUID', async () => {
    const c = await creer(tenantId, { bsuid: 'itest-bsuid-708', externalId: 'itest-ext-708' });
    expect(c).toMatchObject({ created: true, phoneE164: null, bsuid: 'itest-bsuid-708', externalId: 'itest-ext-708' });
    expect((await creer(tenantId, { bsuid: 'itest-bsuid-708' })).id).toBe(c.id);
  });
});
```

- [ ] **Step 11: La purge, contre la base**

Dans `tests/integration/purge-rgpd.integration.test.ts`, à la fin du `beforeAll` (après l'insertion dans `arrivees_pub`), ajouter :

```ts
    // L'identifiant de l'outil du client (migration <N>) : il désigne cette personne chez le client.
    await pool.query(`update contacts set external_id = 'itest-ext-purge' where id = $1`, [contactId]);
```

Dans le cas « plus AUCUNE trace du numéro ni du nom sur la fiche », ajouter `external_id` au `select` et au type (`external_id: string | null`), puis :

```ts
    expect(row.external_id).toBeNull();
    // Et l'identifiant est LIBÉRÉ : une fiche neuve peut le reprendre (index unique par espace).
    const reprise = await store.creerFicheApi(tenantId, { phoneE164: '+33600000902', externalId: 'itest-ext-purge' });
    expect(reprise).not.toBe('conflit');
```

- [ ] **Step 12: Commit (procédure P), puis lire la CI**

Chemins : `src/crm/contact-store.pg.ts tests/contacts-identite-store.test.ts tests/contacts.test.ts tests/http-import.test.ts tests/integration/contacts-identite.integration.test.ts tests/integration/purge-rgpd.integration.test.ts`. Message : `feat(crm): la fiche connait l identifiant externe (lectures, creation, rattachement, edition, purge)`. 🔴 Pré-requis : la Task 3, étape 8, est FAITE (colonne en production). Lire le job `integration` du run.

---

### Task 5: Écrire un consentement sur une fiche désignée par son identifiant

**Files:**
- Modify: `src/crm/contact-store.pg.ts` (méthode neuve après `setOptInByWaId`, fin l. 371 ; docblock du constructeur l. 118-131 ; docblock de `BulkEdits.setOptIn` l. 102-107)
- Modify: `tests/optout-poussee.test.ts:219` (`METHODES_QUI_ANNONCENT`)
- Modify: `tests/integration/contacts-identite.integration.test.ts` (deux cas)
- Test: `tests/contacts-consentement-store.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces: `ecrireConsentementParId(tenantId: string, contactId: string, statut: 'opted_in' | 'opted_out', source: string): Promise<'change' | 'inchange' | 'absente'>`. N'écrit que si le statut CHANGE ; pose `opt_out_at` en se désabonnant, le remet à `null` en se réabonnant (0138) ; annonce l'opt-out APRÈS l'écriture.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/contacts-consentement-store.test.ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';

/**
 * LE CONSENTEMENT ÉCRIT PAR L'API PUBLIQUE, sur une fiche désignée par son IDENTIFIANT.
 *
 * 🔴 IL N'ÉCRIT QUE SI LE STATUT CHANGE. Un outil qui renvoie `opted_out` à chaque appel ne doit ni repousser
 * la date du désabonnement (elle répond à « depuis quand ? »), ni annoncer dix fois le même refus au connecteur
 * du client, ni écrire une ligne d'audit par appel.
 */
const T = '11111111-1111-4111-8111-111111111111';
const ID = '00000000-0000-4000-8000-000000000001';

function monter(opts: { touche: boolean; existe: boolean }) {
  const evenements: string[] = [];
  const sqls: string[] = [];
  const annonces: string[][] = [];
  const pool = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (/^\s*update contacts set opt_in_status/i.test(sql)) {
        evenements.push('ecriture');
        return opts.touche ? { rows: [{ phone_e164: '+33600000001', bsuid: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/select 1 from contacts/i.test(sql)) return { rows: opts.existe ? [{}] : [], rowCount: opts.existe ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const store = new PgContactStore(pool, async (_t, waIds) => { evenements.push('annonce'); annonces.push(waIds); });
  return { store, evenements, sqls, annonces };
}

describe('ecrireConsentementParId', () => {
  it('🔴 un désabonnement qui CHANGE le statut s’écrit PUIS s’annonce', async () => {
    const { store, evenements, annonces } = monter({ touche: true, existe: true });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_out', 'api')).toBe('change');
    expect(evenements).toEqual(['ecriture', 'annonce']);
    expect(annonces).toEqual([['33600000001']]);
  });

  it('⚠️ un statut identique n’écrit rien et n’annonce rien', async () => {
    const { store, evenements } = monter({ touche: false, existe: true });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_out', 'api')).toBe('inchange');
    expect(evenements).toEqual(['ecriture']);
  });

  it('une fiche absente ou supprimée rend « absente »', async () => {
    const { store } = monter({ touche: false, existe: false });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_in', 'api')).toBe('absente');
  });

  it('un réabonnement s’écrit et n’annonce rien : ce n’est pas un refus', async () => {
    const { store, evenements } = monter({ touche: true, existe: true });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_in', 'formulaire-site')).toBe('change');
    expect(evenements).toEqual(['ecriture']);
  });

  it('🔴 la requête ne touche la ligne QUE si le statut change, dans l’espace, sur une fiche active', async () => {
    const { store, sqls } = monter({ touche: true, existe: true });
    await store.ecrireConsentementParId(T, ID, 'opted_out', 'api');
    expect(sqls[0]).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null and opt_in_status is distinct from \$3/);
    expect(sqls[0]).toMatch(/opt_out_at = case when \$3 = 'opted_out' then now\(\) else null end/);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/contacts-consentement-store.test.ts`
Expected: FAIL, `store.ecrireConsentementParId is not a function`.

- [ ] **Step 3: La méthode, après `setOptInByWaId` (fin l. 371)**

```ts
  /**
   * LE CONSENTEMENT POSÉ PAR L'API PUBLIQUE, sur une fiche désignée par son IDENTIFIANT (`appliquerConsentement`).
   *
   * 🔴 IL N'ÉCRIT QUE SI LE STATUT CHANGE (`is distinct from`). Un outil qui renvoie le même consentement à chaque
   * appel ne repousse pas la date d'un désabonnement, et n'annonce pas dix fois le même refus.
   * `opt_out_at` suit le statut dans les deux sens, comme sur les autres chemins (migration 0138).
   *
   * ⚠️ `inchange` et `absente` ne se distinguent qu'en relisant : la seconde requête ne part que si la première
   * n'a rien touché, c'est-à-dire presque jamais sur un premier appel.
   */
  async ecrireConsentementParId(
    tenantId: string,
    contactId: string,
    statut: 'opted_in' | 'opted_out',
    source: string,
  ): Promise<'change' | 'inchange' | 'absente'> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null }>(
      `update contacts set opt_in_status = $3, opt_in_source = $4, updated_at = now(),
              opt_out_at = case when $3 = 'opted_out' then now() else null end
        where tenant_id = $1 and id = $2 and deleted_at is null and opt_in_status is distinct from $3
        returning phone_e164, bsuid`,
      [tenantId, contactId, statut, source],
    );
    const r = res.rows[0];
    if (r) {
      // APRÈS l'écriture, jamais avant : ce qui part vers le système du client décrit ce qui est enregistré.
      if (statut === 'opted_out') await this.annoncer(tenantId, [waIdOf(r.phone_e164, r.bsuid)]);
      return 'change';
    }
    const existe = await this.pool.query(
      'select 1 from contacts where tenant_id = $1 and id = $2 and deleted_at is null',
      [tenantId, contactId],
    );
    return (existe.rowCount ?? 0) > 0 ? 'inchange' : 'absente';
  }
```

- [ ] **Step 4: Les commentaires qui comptaient les chemins d'opt-out**

- Constructeur (l. 124-125) : « Posée ici, elle couvre par CONSTRUCTION les trois méthodes capables d'écrire `opted_out`, et » devient « Posée ici, elle couvre par CONSTRUCTION toutes les méthodes capables d'écrire `opted_out`, et ».
- `BulkEdits.setOptIn` (l. 102-107), remplacer le docblock par :

```ts
  /**
   * Bascule du consentement marketing depuis le mini-CRM, en masse. L'upsert d'import ne fait JAMAIS
   * régresser un statut (unknown -> opted_in seulement, cf. `upsertByPhone`) : un refus s'écrit par une
   * méthode dédiée, celle-ci, la fiche (`applyEdits`), le mot-clé entrant (`setOptInByWaId`) ou l'API
   * publique (`ecrireConsentementParId`). La liste qui fait foi est dérivée par `tests/optout-poussee.test.ts`.
   */
```

- [ ] **Step 5: La liste dérivée des chemins qui annoncent**

`tests/optout-poussee.test.ts:219` : `const METHODES_QUI_ANNONCENT = ['setOptInByWaId', 'applyEdits', 'applyEditsMany'];` devient `const METHODES_QUI_ANNONCENT = ['setOptInByWaId', 'applyEdits', 'applyEditsMany', 'ecrireConsentementParId'];`

Run avant ce remplacement : `npx vitest run tests/optout-poussee.test.ts` doit ÉCHOUER (le balayage trouve la nouvelle méthode, absente de la liste) : c'est la preuve que la garde voit ce chemin. Puis appliquer le remplacement.

- [ ] **Step 6: Le voir passer, et vérifier dans les deux sens**

Run: `npx vitest run tests/contacts-consentement-store.test.ts tests/optout-poussee.test.ts && npm run typecheck`
Expected: PASS.

Mutation : retirer la ligne `if (statut === 'opted_out') await this.annoncer(...)`, relancer : « s’écrit PUIS s’annonce » échoue (`['ecriture']` au lieu de `['ecriture', 'annonce']`). Retirer `and opt_in_status is distinct from $3` : le dernier cas échoue. Restaurer, revoir le vert.

- [ ] **Step 7: Deux cas d'intégration**

Ajouter à `tests/integration/contacts-identite.integration.test.ts` :

```ts
  it('🔴 le consentement par identifiant : la date du premier désabonnement est GARDÉE', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000709' });
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_out', 'api')).toBe('change');
    const premiere = (await store.lireFicheApi(tenantId, c.id))?.optOutAt;
    expect(premiere).not.toBeNull();
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_out', 'api')).toBe('inchange');
    expect((await store.lireFicheApi(tenantId, c.id))?.optOutAt).toBe(premiere);
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_in', 'formulaire-site')).toBe('change');
    expect(await store.lireFicheApi(tenantId, c.id)).toMatchObject({ optInStatus: 'opted_in', optInSource: 'formulaire-site', optOutAt: null });
  });

  it('le consentement d’une fiche d’un AUTRE espace est « absente »', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000710' });
    expect(await store.ecrireConsentementParId(autreTenantId, c.id, 'opted_out', 'api')).toBe('absente');
  });
```

- [ ] **Step 8: Commit (procédure P), puis lire la CI**

Chemins : `src/crm/contact-store.pg.ts tests/contacts-consentement-store.test.ts tests/optout-poussee.test.ts tests/integration/contacts-identite.integration.test.ts`. Message : `feat(crm): le consentement par identifiant de fiche, qui n ecrit que s il change`.

---

### Task 6: `resoudreFiche`, la règle d'identité partagée

**Files:**
- Create: `src/api/fiche.ts`
- Create: `tests/aide/fiches-memoire.ts`
- Modify: `tests/integration/contacts-identite.integration.test.ts` (deux cas)
- Test: `tests/api-fiche.test.ts`

**Interfaces:**
- Consumes: `FicheIdentite`, `ClesNormalisees`, `PgContactStore.chercherParCles | creerFicheApi | rattacherCles` (Task 4), `normalizePhone` (`src/crm/phone.ts`), `estUuid` (`src/http/scope.ts`).
- Produces (dans `src/api/fiche.ts`) :
  - `export const MAX_EXTERNAL_ID = 512`
  - `export const videEnAbsent: (v: unknown) => unknown`
  - `export const schemaClesFiche` (zod : `contactId` GUID, `externalId` <= 512, `phone` <= 64, `bsuid` <= 200, toutes optionnelles, chaîne vide = absente)
  - `export interface ClesFiche { contactId?: string; externalId?: string; phone?: string; bsuid?: string }`
  - `export type ModeCreation = 'jamais' | 'phone' | 'phone_ou_bsuid'`
  - `export type CodeResolution = 'invalid_recipient' | 'invalid_phone' | 'unknown_contact' | 'identity_conflict'`
  - `export type ResolutionFiche = { ok: true; contactId: string; cree: boolean } | { ok: false; code: CodeResolution }`
  - `export type DepsFiche = Pick<PgContactStore, 'chercherParCles' | 'creerFicheApi' | 'rattacherCles'>`
  - `export const MESSAGE_RESOLUTION: Record<CodeResolution, string>`
  - `export function normaliserCles(cles: ClesFiche, pays?: CountryCode): { ok: true; cles: ClesNormalisees } | { ok: false; code: 'invalid_recipient' | 'invalid_phone' }`
  - `export async function resoudreFiche(deps: DepsFiche, tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>`
  - `tests/aide/fiches-memoire.ts` : `class FichesMemoire` (les méthodes du dépôt que l'API utilise, `editerFicheApi` compris, aux règles de la base), `uuidDeTest(): string`.

- [ ] **Step 1: Le répertoire en mémoire des tests**

```ts
// tests/aide/fiches-memoire.ts
import type { ClesNormalisees, CreationFiche, EditionFicheApi, FicheApiLigne, FicheIdentite } from '../../src/crm/contact-store.pg';

/**
 * UN RÉPERTOIRE DE FICHES EN MÉMOIRE, AUX RÈGLES DE LA BASE.
 *
 * Il reproduit ce que le dépôt fait pour l'API publique : unicité PAR ESPACE du numéro, du BSUID et de
 * l'identifiant externe (fiches supprimées comprises, comme un index), `coalesce` au rattachement,
 * résurrection d'une fiche supprimée par la CRÉATION (numéro ou BSUID), et par elle seule : aucune autre
 * écriture ne touche une fiche supprimée, consentement qui n'écrit que s'il change. Ce que la base
 * fait VRAIMENT de ces règles est vérifié à part (`tests/integration/contacts-identite.integration.test.ts`).
 *
 * ⚠️ `ecritures` journalise chaque écriture : c'est ce qui permet d'affirmer « rien n'a été écrit ».
 */
export interface FicheMemoire {
  id: string;
  tenantId: string;
  externalId: string | null;
  phoneE164: string | null;
  bsuid: string | null;
  profileName: string | null;
  fields: Record<string, string>;
  tags: string[];
  optInStatus: 'opted_in' | 'opted_out' | 'unknown';
  optInSource: string | null;
  optOutAt: string | null;
  supprimee: boolean;
}

let compteur = 0;
/** Un identifiant au FORMAT d'un vrai : `estUuid` refuse « c1 » avant même d'aller chercher. */
export function uuidDeTest(): string {
  compteur += 1;
  return `00000000-0000-4000-8000-${String(compteur).padStart(12, '0')}`;
}

type Cle = 'externalId' | 'phoneE164' | 'bsuid';

export class FichesMemoire {
  readonly fiches: FicheMemoire[] = [];
  readonly ecritures: string[] = [];
  appelsChercher = 0;

  ajouter(tenantId: string, f: Partial<Omit<FicheMemoire, 'tenantId'>> = {}): FicheMemoire {
    const fiche: FicheMemoire = {
      id: f.id ?? uuidDeTest(), tenantId, externalId: f.externalId ?? null, phoneE164: f.phoneE164 ?? null,
      bsuid: f.bsuid ?? null, profileName: f.profileName ?? null, fields: f.fields ?? {}, tags: f.tags ?? [],
      optInStatus: f.optInStatus ?? 'unknown', optInSource: f.optInSource ?? null, optOutAt: f.optOutAt ?? null,
      supprimee: f.supprimee ?? false,
    };
    this.fiches.push(fiche);
    return fiche;
  }

  private actives(tenantId: string): FicheMemoire[] {
    return this.fiches.filter((f) => f.tenantId === tenantId && !f.supprimee);
  }

  private prise(tenantId: string, sauf: string | null, cle: Cle, valeur: string): boolean {
    return this.fiches.some((f) => f.tenantId === tenantId && f.id !== sauf && f[cle] === valeur);
  }

  private identite(f: FicheMemoire): FicheIdentite {
    return { id: f.id, externalId: f.externalId, phoneE164: f.phoneE164, bsuid: f.bsuid };
  }

  async chercherParCles(tenantId: string, c: ClesNormalisees): Promise<FicheIdentite[]> {
    this.appelsChercher += 1;
    return this.actives(tenantId)
      .filter((f) => (c.contactId !== undefined && f.id === c.contactId)
        || (c.externalId !== undefined && f.externalId === c.externalId)
        || (c.phoneE164 !== undefined && f.phoneE164 === c.phoneE164)
        || (c.bsuid !== undefined && f.bsuid === c.bsuid))
      .map((f) => this.identite(f));
  }

  async creerFicheApi(tenantId: string, c: { phoneE164?: string; bsuid?: string; externalId?: string }): Promise<CreationFiche> {
    const cle: Cle = c.phoneE164 !== undefined ? 'phoneE164' : 'bsuid';
    const valeur = c.phoneE164 ?? c.bsuid;
    if (valeur === undefined) throw new Error('creerFicheApi : un numéro ou un BSUID est requis');
    const existante = this.fiches.find((f) => f.tenantId === tenantId && f[cle] === valeur);
    if (existante) {
      if (c.externalId !== undefined && existante.externalId === null && this.prise(tenantId, existante.id, 'externalId', c.externalId)) return 'conflit';
      if (c.bsuid !== undefined && existante.bsuid === null && this.prise(tenantId, existante.id, 'bsuid', c.bsuid)) return 'conflit';
      existante.externalId ??= c.externalId ?? null;
      existante.bsuid ??= c.bsuid ?? null;
      existante.supprimee = false;
      this.ecritures.push(`maj:${existante.id}`);
      return { ...this.identite(existante), created: false };
    }
    if (c.externalId !== undefined && this.prise(tenantId, null, 'externalId', c.externalId)) return 'conflit';
    if (c.bsuid !== undefined && this.prise(tenantId, null, 'bsuid', c.bsuid)) return 'conflit';
    const f = this.ajouter(tenantId, { phoneE164: c.phoneE164 ?? null, bsuid: c.bsuid ?? null, externalId: c.externalId ?? null });
    this.ecritures.push(`creation:${f.id}`);
    return { ...this.identite(f), created: true };
  }

  async rattacherCles(tenantId: string, contactId: string, c: { externalId?: string; phoneE164?: string; bsuid?: string }): Promise<'ok' | 'conflit' | 'absente'> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return 'absente';
    for (const cle of ['externalId', 'phoneE164', 'bsuid'] as const) {
      const v = c[cle];
      if (v !== undefined && f[cle] === null && this.prise(tenantId, f.id, cle, v)) return 'conflit';
    }
    f.externalId ??= c.externalId ?? null;
    f.phoneE164 ??= c.phoneE164 ?? null;
    f.bsuid ??= c.bsuid ?? null;
    this.ecritures.push(`rattachement:${f.id}`);
    const tient = (voulu: string | undefined, porte: string | null): boolean => voulu === undefined || voulu === porte;
    return tient(c.externalId, f.externalId) && tient(c.phoneE164, f.phoneE164) && tient(c.bsuid, f.bsuid) ? 'ok' : 'conflit';
  }

  /** Comme la base : une fiche supprimée (ou purgée) n'est PAS éditée, `false`. */
  async editerFicheApi(tenantId: string, contactId: string, e: EditionFicheApi): Promise<boolean> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return false;
    Object.assign(f.fields, e.fields);
    for (const k of e.removeFields) delete f.fields[k];
    if (e.profileName !== undefined) f.profileName = e.profileName;
    f.tags = [...new Set([...f.tags, ...e.addTags])].filter((t) => !e.removeTags.includes(t));
    this.ecritures.push(`edition:${f.id}`);
    return true;
  }

  async poserExternalId(tenantId: string, contactId: string, externalId: string): Promise<'ok' | 'conflit' | 'absente'> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return 'absente';
    if (this.prise(tenantId, f.id, 'externalId', externalId)) return 'conflit';
    f.externalId = externalId;
    this.ecritures.push(`externalId:${f.id}`);
    return 'ok';
  }

  async lireFicheApi(tenantId: string, contactId: string): Promise<FicheApiLigne | null> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return null;
    return {
      id: f.id, externalId: f.externalId, phoneE164: f.phoneE164, bsuid: f.bsuid, profileName: f.profileName,
      fields: { ...f.fields }, tags: [...f.tags], optInStatus: f.optInStatus, optInSource: f.optInSource,
      optOutAt: f.optOutAt, rcsOptoutAt: null, blockedAt: null, whatsappJoignable: null, whatsappJoignableLe: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
  }

  async ecrireConsentementParId(tenantId: string, contactId: string, statut: 'opted_in' | 'opted_out', source: string): Promise<'change' | 'inchange' | 'absente'> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return 'absente';
    if (f.optInStatus === statut) return 'inchange';
    f.optInStatus = statut;
    f.optInSource = source;
    f.optOutAt = statut === 'opted_out' ? new Date().toISOString() : null;
    this.ecritures.push(`consentement:${f.id}:${statut}`);
    return 'change';
  }
}
```

- [ ] **Step 2: Écrire le test qui échoue**

```ts
// tests/api-fiche.test.ts
import { describe, it, expect } from 'vitest';
import { resoudreFiche, schemaClesFiche, normaliserCles } from '../src/api/fiche';
import { waIdOf } from '../src/crm/identity';
import { FichesMemoire } from './aide/fiches-memoire';

/**
 * TROUVER LA FICHE D'UNE PERSONNE (spec de l'API publique, § 1 et § 13 « Identité »).
 *
 * 🔴 TOUTES LES CLÉS DONNÉES DOIVENT DÉSIGNER LA MÊME FICHE, sinon rien n'est écrit. Et une clé que la
 * fiche ne porte pas encore lui est RATTACHÉE : un outil envoie naturellement le numéro ET son propre
 * identifiant dans le même corps.
 */
const T = 't1';

describe('resoudreFiche : retrouver', () => {
  it('🔴 chaque clé, seule ou avec les autres, retrouve la MÊME fiche, sans rien écrire', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-7781', bsuid: 'BSUID-1' });
    const cas = [
      { contactId: f.id }, { externalId: 'crm-7781' }, { phone: '+33612345678' }, { phone: '06 12 34 56 78' },
      { bsuid: 'BSUID-1' }, { contactId: f.id, externalId: 'crm-7781', phone: '0612345678', bsuid: 'BSUID-1' },
    ];
    for (const cles of cas) {
      expect(await resoudreFiche(r, T, cles, { creer: 'jamais' }), JSON.stringify(cles)).toEqual({ ok: true, contactId: f.id, cree: false });
    }
    expect(r.ecritures).toEqual([]);
  });

  it('🔴 l’adresse WhatsApp d’une fiche à numéro ET BSUID reste le numéro, quelle que soit la clé reçue', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', bsuid: 'BSUID-1' });
    const res = await resoudreFiche(r, T, { bsuid: 'BSUID-1' }, { creer: 'jamais' });
    expect(res).toEqual({ ok: true, contactId: f.id, cree: false });
    // La résolution rend une FICHE, jamais une adresse : l'adresse se calcule sur la fiche.
    expect(waIdOf(f.phoneE164, f.bsuid)).toBe('33612345678');
  });

  it('une fiche d’un autre espace n’existe pas', async () => {
    const r = new FichesMemoire();
    r.ajouter('t2', { externalId: 'crm-7781', phoneE164: '+33612345678' });
    expect(await resoudreFiche(r, T, { externalId: 'crm-7781' }, { creer: 'jamais' })).toEqual({ ok: false, code: 'unknown_contact' });
  });
});

describe('resoudreFiche : les refus', () => {
  it('aucune clé : `invalid_recipient` ; un numéro illisible : `invalid_phone`', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, {}, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'invalid_recipient' });
    expect(await resoudreFiche(r, T, { phone: '  ', externalId: '' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'invalid_recipient' });
    expect(await resoudreFiche(r, T, { phone: 'pas-un-numero' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'invalid_phone' });
  });

  it('un `contactId` mal formé ne va pas jusqu’à la base : `unknown_contact`', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, { contactId: 'c1' }, { creer: 'jamais' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(r.appelsChercher).toBe(0);
  });

  it('🔴 deux clés sur deux fiches : `identity_conflict`, et RIEN n’est écrit', async () => {
    const r = new FichesMemoire();
    r.ajouter(T, { phoneE164: '+33612345678' });
    r.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-7781' });
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-7781' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(r.ecritures).toEqual([]);
  });

  it('🔴 une clé que la fiche porte déjà AUTREMENT : `identity_conflict`, on ne remplace pas', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-ancien' });
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-7781' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(f.externalId).toBe('crm-ancien');
    expect(r.ecritures).toEqual([]);
  });

  it('🔴 un `contactId` inconnu ne crée JAMAIS rien, même accompagné d’un numéro', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, { contactId: '00000000-0000-4000-8000-999999999999', phone: '+33612345678' }, { creer: 'phone_ou_bsuid' }))
      .toEqual({ ok: false, code: 'unknown_contact' });
    expect(r.fiches).toHaveLength(0);
  });
});

describe('resoudreFiche : rattacher et créer', () => {
  it('🔴 une clé neuve est RATTACHÉE à la fiche trouvée', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678' });
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-7781' }, { creer: 'jamais' })).toEqual({ ok: true, contactId: f.id, cree: false });
    expect(f.externalId).toBe('crm-7781');
    expect(await resoudreFiche(r, T, { externalId: 'crm-7781' }, { creer: 'jamais' })).toEqual({ ok: true, contactId: f.id, cree: false });
  });

  it('création selon le mode : `jamais` ne crée pas, `phone` exige un numéro, `phone_ou_bsuid` accepte un BSUID', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, { phone: '+33612345678' }, { creer: 'jamais' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(await resoudreFiche(r, T, { bsuid: 'BSUID-1' }, { creer: 'phone' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(await resoudreFiche(r, T, { externalId: 'crm-7781' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(r.fiches).toHaveLength(0);

    const parNumero = await resoudreFiche(r, T, { phone: '06 12 34 56 78', externalId: 'crm-7781' }, { creer: 'phone' });
    expect(parNumero).toMatchObject({ ok: true, cree: true });
    expect(r.fiches[0]).toMatchObject({ phoneE164: '+33612345678', externalId: 'crm-7781' });
    expect(await resoudreFiche(r, T, { bsuid: 'BSUID-2' }, { creer: 'phone_ou_bsuid' })).toMatchObject({ ok: true, cree: true });
  });

  it('🔴 une course sur l’identifiant externe finit en `identity_conflict`, jamais en seconde fiche', async () => {
    const r = new FichesMemoire();
    const autre = r.ajouter(T, { phoneE164: '+33698765432' });
    const creer = r.creerFicheApi.bind(r);
    let premier = true;
    // Entre la lecture et la création, une autre écriture pose le même identifiant sur une autre fiche.
    r.creerFicheApi = async (t, c) => {
      if (premier) { premier = false; autre.externalId = 'crm-course'; }
      return creer(t, c);
    };
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-course' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(r.fiches).toHaveLength(1);
  });

  it('le numéro d’une fiche supprimée la ressuscite (comportement de l’upsert d’avant, gardé)', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', supprimee: true });
    expect(await resoudreFiche(r, T, { phone: '+33612345678' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: true, contactId: f.id, cree: false });
    expect(f.supprimee).toBe(false);
  });
});

describe('schemaClesFiche et normaliserCles', () => {
  it('une chaîne vide ou blanche vaut ABSENCE, une valeur est rognée', () => {
    const r = schemaClesFiche.safeParse({ phone: '', externalId: '  crm-7781  ', bsuid: '   ' });
    expect(r.success && r.data).toEqual({ externalId: 'crm-7781' });
  });

  it('les bornes : identifiant externe de 512 caractères au plus, `contactId` au format UUID', () => {
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(512) }).success).toBe(true);
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(513) }).success).toBe(false);
    expect(schemaClesFiche.safeParse({ contactId: 'c1' }).success).toBe(false);
    expect(schemaClesFiche.safeParse({ bsuid: 'b'.repeat(201) }).success).toBe(false);
  });

  it('le numéro se normalise en E.164, la France par défaut', () => {
    expect(normaliserCles({ phone: '06 12 34 56 78' })).toEqual({ ok: true, cles: { phoneE164: '+33612345678' } });
  });
});
```

- [ ] **Step 3: Le voir échouer**

Run: `npx vitest run tests/api-fiche.test.ts`
Expected: FAIL, `Failed to resolve import "../src/api/fiche"`.

- [ ] **Step 4: Écrire le module**

```ts
// src/api/fiche.ts
import { z } from 'zod';
import type { CountryCode } from 'libphonenumber-js';
import { normalizePhone } from '../crm/phone';
import { estUuid } from '../http/scope';
import type { ClesNormalisees, FicheIdentite, PgContactStore } from '../crm/contact-store.pg';

/**
 * TROUVER LA FICHE D'UNE PERSONNE À PARTIR DE CE QUE L'INTÉGRATEUR A (spec de l'API publique, § 1).
 *
 * 🔴 UNE SEULE FONCTION pour `/v1/contacts`, et demain pour les destinataires d'un envoi et les messages
 * simples. Une seconde résolution divergerait sur la règle multi-clés, et une personne aurait deux fiches.
 *
 * La règle :
 *  - au moins une clé parmi `contactId`, `externalId`, `phone`, `bsuid`, sinon `invalid_recipient` ;
 *  - toutes les clés données désignent LA MÊME fiche, sinon `identity_conflict`, et rien n'est écrit ;
 *  - une clé que la fiche ne porte pas encore lui est RATTACHÉE ; une clé qu'elle porte AUTREMENT est un
 *    conflit (on ne remplace jamais une identité ici, `PATCH` le fait pour l'identifiant externe seul) ;
 *  - `contactId` ne se rattache jamais : il existe, ou il est inconnu ;
 *  - aucune fiche : création SEULEMENT si le mode le permet et qu'un `phone` (ou un `bsuid`, selon le mode)
 *    est donné, la base exigeant l'un des deux. Sinon `unknown_contact`.
 *
 * ⚠️ ELLE REND UNE FICHE, JAMAIS UNE ADRESSE : l'adresse d'envoi se calcule sur la fiche (`waIdOf` pour
 * WhatsApp), pas sur la clé reçue. C'est ce qui garde un seul fil par personne.
 */

/** La borne de l'identifiant externe (celle des outils qui en ont une, la plus stricte connue). */
export const MAX_EXTERNAL_ID = 512;

/**
 * Une chaîne vide ou blanche vaut ABSENCE. Un outil qui remplit son corps avec les variables d'un profil
 * envoie `""` pour une variable que le profil n'a pas, et ce n'est pas une clé.
 */
export const videEnAbsent = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const schemaClesFiche = z.object({
  contactId: z.preprocess(videEnAbsent, z.guid().optional()),
  externalId: z.preprocess(videEnAbsent, z.string().trim().max(MAX_EXTERNAL_ID).optional()),
  phone: z.preprocess(videEnAbsent, z.string().trim().max(64).optional()),
  // Refusé au-delà de 200 plutôt que tronqué : un BSUID coupé serait l'identité d'un AUTRE compte.
  bsuid: z.preprocess(videEnAbsent, z.string().trim().max(200).optional()),
});

export interface ClesFiche {
  contactId?: string;
  externalId?: string;
  phone?: string;
  bsuid?: string;
}

export type ModeCreation = 'jamais' | 'phone' | 'phone_ou_bsuid';
export type CodeResolution = 'invalid_recipient' | 'invalid_phone' | 'unknown_contact' | 'identity_conflict';
export type ResolutionFiche = { ok: true; contactId: string; cree: boolean } | { ok: false; code: CodeResolution };
export type DepsFiche = Pick<PgContactStore, 'chercherParCles' | 'creerFicheApi' | 'rattacherCles'>;

export const MESSAGE_RESOLUTION: Record<CodeResolution, string> = {
  invalid_recipient: 'désignez la personne par au moins une clé : « contactId », « externalId », « phone » ou « bsuid »',
  invalid_phone: '« phone » : numéro de téléphone illisible',
  unknown_contact: 'aucune fiche ne correspond à ces clés',
  identity_conflict: 'ces clés désignent des fiches différentes, ou une clé que la fiche porte déjà avec une autre valeur : rien n’a été écrit',
};

/** Rogne les clés, écarte les vides, normalise le numéro. */
export function normaliserCles(
  cles: ClesFiche,
  pays: CountryCode = 'FR',
): { ok: true; cles: ClesNormalisees } | { ok: false; code: 'invalid_recipient' | 'invalid_phone' } {
  const propre = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== '' ? v.trim() : undefined);
  const contactId = propre(cles.contactId);
  const externalId = propre(cles.externalId);
  const phone = propre(cles.phone);
  const bsuid = propre(cles.bsuid);
  if (!contactId && !externalId && !phone && !bsuid) return { ok: false, code: 'invalid_recipient' };
  let phoneE164: string | undefined;
  if (phone) {
    const p = normalizePhone(phone, pays);
    if (!p.e164) return { ok: false, code: 'invalid_phone' };
    phoneE164 = p.e164;
  }
  return {
    ok: true,
    cles: {
      ...(contactId ? { contactId } : {}),
      ...(externalId ? { externalId } : {}),
      ...(phoneE164 ? { phoneE164 } : {}),
      ...(bsuid ? { bsuid } : {}),
    },
  };
}

type AttacherCles = { externalId?: string; phoneE164?: string; bsuid?: string };
type Verdict =
  | { type: 'refus'; code: CodeResolution }
  | { type: 'trouvee'; id: string; aRattacher: AttacherCles }
  | { type: 'aucune' };

function juger(c: ClesNormalisees, trouvees: FicheIdentite[]): Verdict {
  const par = {
    contactId: c.contactId !== undefined ? trouvees.find((f) => f.id === c.contactId) : undefined,
    externalId: c.externalId !== undefined ? trouvees.find((f) => f.externalId === c.externalId) : undefined,
    phone: c.phoneE164 !== undefined ? trouvees.find((f) => f.phoneE164 === c.phoneE164) : undefined,
    bsuid: c.bsuid !== undefined ? trouvees.find((f) => f.bsuid === c.bsuid) : undefined,
  };
  if (c.contactId !== undefined && !par.contactId) return { type: 'refus', code: 'unknown_contact' };
  const ids = new Set([par.contactId, par.externalId, par.phone, par.bsuid].filter((f): f is FicheIdentite => f !== undefined).map((f) => f.id));
  if (ids.size > 1) return { type: 'refus', code: 'identity_conflict' };
  const fiche = trouvees.find((f) => ids.has(f.id));
  if (!fiche) return { type: 'aucune' };
  const aRattacher: AttacherCles = {};
  if (c.externalId !== undefined && !par.externalId) {
    if (fiche.externalId !== null) return { type: 'refus', code: 'identity_conflict' };
    aRattacher.externalId = c.externalId;
  }
  if (c.phoneE164 !== undefined && !par.phone) {
    if (fiche.phoneE164 !== null) return { type: 'refus', code: 'identity_conflict' };
    aRattacher.phoneE164 = c.phoneE164;
  }
  if (c.bsuid !== undefined && !par.bsuid) {
    if (fiche.bsuid !== null) return { type: 'refus', code: 'identity_conflict' };
    aRattacher.bsuid = c.bsuid;
  }
  return { type: 'trouvee', id: fiche.id, aRattacher };
}

function peutCreer(c: ClesNormalisees, mode: ModeCreation): boolean {
  if (mode === 'jamais') return false;
  if (mode === 'phone') return c.phoneE164 !== undefined;
  return c.phoneE164 !== undefined || c.bsuid !== undefined;
}

/**
 * ⚠️ DEUX PASSES AU PLUS. Une écriture concurrente peut prendre une clé entre la lecture et l'écriture (la
 * base rend alors « conflit », ou « absente » pour une fiche purgée entre-temps) : on relit UNE fois, et la
 * seconde lecture dit la vérité. Au-delà, c'est un conflit, jamais une boucle.
 */
const PASSES = 2;

export async function resoudreFiche(
  deps: DepsFiche,
  tenantId: string,
  cles: ClesFiche,
  opts: { creer: ModeCreation },
): Promise<ResolutionFiche> {
  const n = normaliserCles(cles);
  if (!n.ok) return n;
  const c = n.cles;
  // Un identifiant mal formé ne désigne rien : on ne le laisse pas atteindre la base, où le cast lèverait.
  if (c.contactId !== undefined && !estUuid(c.contactId)) return { ok: false, code: 'unknown_contact' };

  for (let passe = 0; passe < PASSES; passe += 1) {
    const verdict = juger(c, await deps.chercherParCles(tenantId, c));
    if (verdict.type === 'refus') return { ok: false, code: verdict.code };
    if (verdict.type === 'trouvee') {
      if (Object.keys(verdict.aRattacher).length === 0) return { ok: true, contactId: verdict.id, cree: false };
      const r = await deps.rattacherCles(tenantId, verdict.id, verdict.aRattacher);
      if (r === 'ok') return { ok: true, contactId: verdict.id, cree: false };
      if (r === 'absente') continue;
      return { ok: false, code: 'identity_conflict' };
    }
    if (!peutCreer(c, opts.creer)) return { ok: false, code: 'unknown_contact' };
    const creation = await deps.creerFicheApi(tenantId, {
      ...(c.phoneE164 ? { phoneE164: c.phoneE164 } : {}),
      ...(c.bsuid ? { bsuid: c.bsuid } : {}),
      ...(c.externalId ? { externalId: c.externalId } : {}),
    });
    if (creation === 'conflit') continue;
    const tient = (voulu: string | undefined, porte: string | null): boolean => voulu === undefined || voulu === porte;
    if (!tient(c.externalId, creation.externalId) || !tient(c.bsuid, creation.bsuid) || !tient(c.phoneE164, creation.phoneE164)) {
      return { ok: false, code: 'identity_conflict' };
    }
    return { ok: true, contactId: creation.id, cree: creation.created };
  }
  return { ok: false, code: 'identity_conflict' };
}
```

- [ ] **Step 5: Le voir passer**

Run: `npx vitest run tests/api-fiche.test.ts && npm run typecheck`
Expected: PASS, typecheck sans erreur (le typecheck prouve aussi que `FichesMemoire` satisfait `DepsFiche`).

- [ ] **Step 6: Vérifier dans les deux sens**

1. Dans `juger`, remplacer `if (ids.size > 1) return { type: 'refus', code: 'identity_conflict' };` par rien : « deux clés sur deux fiches » échoue (la fiche du numéro est rendue, un rattachement est tenté). Restaurer.
2. Dans `juger`, retirer `if (c.contactId !== undefined && !par.contactId) return ...` : « un `contactId` inconnu ne crée JAMAIS rien » échoue (une fiche est créée). Restaurer, revoir le vert.

- [ ] **Step 7: Deux cas d'intégration (résolution multi-clés contre la base)**

Ajouter l'import `import { resoudreFiche } from '../../src/api/fiche';` en tête de `tests/integration/contacts-identite.integration.test.ts`, puis :

```ts
  it('🔴 résolution contre la base : deux clés sur deux fiches, `identity_conflict`, et rien n’est écrit', async () => {
    const a = await creer(tenantId, { phoneE164: '+33600000711' });
    await creer(tenantId, { phoneE164: '+33600000712', externalId: 'itest-ext-712' });
    expect(await resoudreFiche(store, tenantId, { phone: '+33600000711', externalId: 'itest-ext-712' }, { creer: 'phone_ou_bsuid' }))
      .toEqual({ ok: false, code: 'identity_conflict' });
    expect((await store.lireFicheApi(tenantId, a.id))?.externalId).toBeNull();
  });

  it('résolution contre la base : une clé neuve est rattachée, et chaque clé retrouve ensuite la fiche', async () => {
    const a = await creer(tenantId, { phoneE164: '+33600000713' });
    expect(await resoudreFiche(store, tenantId, { phone: '0600000713', externalId: 'itest-ext-713' }, { creer: 'jamais' }))
      .toEqual({ ok: true, contactId: a.id, cree: false });
    expect(await resoudreFiche(store, tenantId, { externalId: 'itest-ext-713' }, { creer: 'jamais' }))
      .toEqual({ ok: true, contactId: a.id, cree: false });
  });
```

- [ ] **Step 8: Commit (procédure P), puis lire la CI**

Chemins : `src/api/fiche.ts tests/aide/fiches-memoire.ts tests/api-fiche.test.ts tests/integration/contacts-identite.integration.test.ts`. Message : `feat(api): resoudreFiche, la regle d identite multi-cles partagee`.

---

### Task 7: `appliquerConsentement`, le consentement posé par une machine

**Files:**
- Create: `src/api/consentement.ts`
- Test: `tests/api-consentement.test.ts`

**Interfaces:**
- Consumes: `AuditSink` (`src/audit/journal.ts`), le contrat de `PgContactStore.ecrireConsentementParId` (Task 5).
- Produces:
  - `export type ConsentementApi = 'opted_in' | 'opted_out'`
  - `export interface DepsConsentement { ecrireConsentementParId(tenantId: string, contactId: string, statut: ConsentementApi, source: string): Promise<'change' | 'inchange' | 'absente'>; audit: AuditSink }`
  - `export async function appliquerConsentement(deps: DepsConsentement, tenantId: string, contactId: string, consent: 'opted_in' | 'opted_out', source: string): Promise<void>`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/api-consentement.test.ts
import { describe, it, expect } from 'vitest';
import { appliquerConsentement, type DepsConsentement } from '../src/api/consentement';
import type { AuditSink } from '../src/audit/journal';

/**
 * LE CONSENTEMENT POSÉ PAR UNE MACHINE (`/v1/contacts`, et demain chaque destinataire d'un envoi).
 *
 * 🔴 UN CHANGEMENT S'ÉCRIT ET SE JOURNALISE ; UNE RÉPÉTITION NE LAISSE AUCUNE TRACE. Et le journal est
 * BEST-EFFORT : une panne d'écriture de log ne doit pas empêcher d'enregistrer un refus.
 */
function monter(issue: 'change' | 'inchange' | 'absente', auditLeve = false) {
  const ecrits: Array<{ contactId: string; statut: string; source: string }> = [];
  const audits: Array<{ acteur: unknown; action: string; cible: { kind: string; id: string }; detail: unknown }> = [];
  const audit: AuditSink = async (_t, acteur, action, cible, detail) => {
    if (auditLeve) throw new Error('journal indisponible');
    audits.push({ acteur, action, cible, detail });
  };
  const deps: DepsConsentement = {
    ecrireConsentementParId: async (_t, contactId, statut, source) => { ecrits.push({ contactId, statut, source }); return issue; },
    audit,
  };
  return { deps, ecrits, audits };
}
const ID = '00000000-0000-4000-8000-000000000001';

describe('appliquerConsentement', () => {
  it('🔴 un désabonnement qui change : écrit, puis une ligne `contact.optout` (source api, sans acteur humain)', async () => {
    const { deps, ecrits, audits } = monter('change');
    await appliquerConsentement(deps, 't1', ID, 'opted_out', 'formulaire-site');
    expect(ecrits).toEqual([{ contactId: ID, statut: 'opted_out', source: 'formulaire-site' }]);
    expect(audits).toEqual([{
      acteur: { userId: null, email: null }, action: 'contact.optout',
      cible: { kind: 'contact', id: ID }, detail: { source: 'api', consentSource: 'formulaire-site' },
    }]);
  });

  it('un consentement qui change : `contact.optin`', async () => {
    const { deps, audits } = monter('change');
    await appliquerConsentement(deps, 't1', ID, 'opted_in', 'api');
    expect(audits.map((a) => a.action)).toEqual(['contact.optin']);
  });

  it('⚠️ inchangé ou fiche absente : aucune ligne d’audit', async () => {
    for (const issue of ['inchange', 'absente'] as const) {
      const { deps, audits } = monter(issue);
      await appliquerConsentement(deps, 't1', ID, 'opted_out', 'api');
      expect(audits, issue).toEqual([]);
    }
  });

  it('🔴 un journal en panne ne fait pas échouer l’écriture du consentement', async () => {
    const { deps, ecrits } = monter('change', true);
    await expect(appliquerConsentement(deps, 't1', ID, 'opted_out', 'api')).resolves.toBeUndefined();
    expect(ecrits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-consentement.test.ts`
Expected: FAIL, `Failed to resolve import "../src/api/consentement"`.

- [ ] **Step 3: Écrire le module**

```ts
// src/api/consentement.ts
import type { AuditSink } from '../audit/journal';

/**
 * LE CONSENTEMENT POSÉ PAR UNE MACHINE (spec de l'API publique, § 2 et § 3).
 *
 * 🔴 L'UPSERT NE SAIT QUE PROMOUVOIR, et c'est une bonne garde qu'on garde (un import n'écrase jamais un
 * consentement) : un refus s'écrit donc par une écriture DÉDIÉE, sur l'identifiant de la fiche, comme la
 * route `PATCH` de la fiche dans la console. Les deux sens passent par elle, parce que la fiche peut avoir
 * été trouvée par un identifiant externe, sans numéro.
 *
 * ⚠️ `audit` EST REQUIS : un consentement posé par une machine sans trace ne se justifie plus. Il reste
 * BEST-EFFORT à l'appel, comme partout : une panne d'écriture de log n'empêche pas d'enregistrer un refus.
 */
export type ConsentementApi = 'opted_in' | 'opted_out';

export interface DepsConsentement {
  ecrireConsentementParId(
    tenantId: string,
    contactId: string,
    statut: ConsentementApi,
    source: string,
  ): Promise<'change' | 'inchange' | 'absente'>;
  audit: AuditSink;
}

export async function appliquerConsentement(
  deps: DepsConsentement,
  tenantId: string,
  contactId: string,
  consent: 'opted_in' | 'opted_out',
  source: string,
): Promise<void> {
  const issue = await deps.ecrireConsentementParId(tenantId, contactId, consent, source);
  // Rien n'a bougé (même statut, ou fiche purgée entre-temps) : rien à consigner.
  if (issue !== 'change') return;
  try {
    await deps.audit(
      tenantId,
      // Une clé d'API n'est pas un compte : l'acteur reste vide, la SOURCE dit d'où vient la décision.
      { userId: null, email: null },
      consent === 'opted_in' ? 'contact.optin' : 'contact.optout',
      { kind: 'contact', id: contactId },
      { source: 'api', consentSource: source },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('audit du consentement ignoré:', err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 4: Le voir passer**

Run: `npx vitest run tests/api-consentement.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Vérifier dans les deux sens**

Remplacer `if (issue !== 'change') return;` par `if (issue === 'absente') return;` : « inchangé ou fiche absente » échoue (une ligne pour `inchange`). Restaurer, revoir le vert.

- [ ] **Step 6: Commit (procédure P)**

Chemins : `src/api/consentement.ts tests/api-consentement.test.ts`. Message : `feat(api): appliquerConsentement, le consentement pose par une machine et son audit`.

---

### Task 8: La préparation des champs, partagée sans rien changer

**Files:**
- Modify: `src/api/contacts-upsert.ts:41-47` (`valeurDeChamp` exporté), `:62-77` (`schemaContactApi` bâti sur `schemaChamps` et `schemaTags`), `:99-121` (`raisonDeValidation`), `:130-131` (`normalizeTags` exporté), `:151-255` (`upsertContactsFromApi` : la boucle des champs devient `preparateurDeChamps`)
- Test: `tests/api-preparation-champs.test.ts`

**Interfaces:**
- Consumes: `MAX_EXTERNAL_ID` (Task 6).
- Produces (dans `src/api/contacts-upsert.ts`) :
  - `export const valeurDeChamp` (zod, texte, nombre ou booléen, converti en texte)
  - `export const schemaChamps` (le record de champs borné) et `export const schemaTags` (le tableau borné)
  - `export const normalizeTags: (v: unknown) => string[]`
  - `export type ChampsPrepares = { ok: true; valeurs: Record<string, string> } | { ok: false; raison: string }`
  - `export async function preparateurDeChamps(tenantId: string, deps: { fields: UserFieldStore; maxChampsParEspace?: number }): Promise<(champs: Record<string, string> | undefined) => Promise<ChampsPrepares>>`
  - `raisonDeValidation` connaît `contactId`, `externalId`, `consent`, `consentSource`, `addTags`, `removeTags`, les clés refusées (`z.never`) et le message d'un `refine` à la racine.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/api-preparation-champs.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { preparateurDeChamps, raisonDeValidation } from '../src/api/contacts-upsert';
import type { UserFieldDef } from '../src/crm/types';

/**
 * LA PRÉPARATION DES CHAMPS D'UN CONTACT, extraite pour être PARTAGÉE (l'upsert d'import et le service des
 * fiches de l'API publique). Ce qui compte : le cache des définitions est chargé UNE fois et grossit au fil
 * des appels, donc un champ auto-créé par le premier contact n'est pas recréé par le second, et le plafond
 * par espace se compte sur ce cache vivant.
 */
const champ = (key: string): UserFieldDef => ({ key, label: key, type: 'text' } as UserFieldDef);

function fields(defs: UserFieldDef[]) {
  const etat = { listes: 0, crees: [] as string[] };
  const store = {
    list: async () => { etat.listes += 1; return defs; },
    upsert: async (_t: string, d: UserFieldDef) => { etat.crees.push(d.key); },
  };
  return { store, etat };
}

describe('preparateurDeChamps', () => {
  it('🔴 un champ créé par un appel est CONNU du suivant : il n’est pas recréé', async () => {
    const { store, etat } = fields([champ('prenom')]);
    const preparer = await preparateurDeChamps('t1', { fields: store, maxChampsParEspace: 0 });
    expect(await preparer({ prenom: 'Marc', ville: 'Lyon' })).toEqual({ ok: true, valeurs: { prenom: 'Marc', ville: 'Lyon' } });
    expect(await preparer({ ville: 'Paris' })).toEqual({ ok: true, valeurs: { ville: 'Paris' } });
    expect(etat.crees).toEqual(['ville']);
  });

  it('au plafond, un champ INCONNU est refusé en le disant, et rien n’est créé', async () => {
    const { store, etat } = fields([champ('prenom')]);
    const preparer = await preparateurDeChamps('t1', { fields: store, maxChampsParEspace: 1 });
    const r = await preparer({ nouveau: 'x' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.raison).toMatch(/plafond de 1 champs personnalisés/);
    expect(etat.crees).toEqual([]);
  });

  it('un code `fld_` inconnu est refusé : un code ne se devine pas', async () => {
    const { store } = fields([]);
    const preparer = await preparateurDeChamps('t1', { fields: store, maxChampsParEspace: 0 });
    expect(await preparer({ fld_inexistant: 'x' })).toEqual({ ok: false, raison: 'champ inconnu : fld_inexistant' });
  });

  it('aucun champ : aucune valeur, et c’est un succès', async () => {
    const { store } = fields([]);
    expect(await (await preparateurDeChamps('t1', { fields: store }))(undefined)).toEqual({ ok: true, valeurs: {} });
  });
});

describe('raisonDeValidation : les clés de l’API des fiches', () => {
  const echec = (schema: z.ZodType, corps: unknown): string => {
    const r = schema.safeParse(corps);
    if (r.success) throw new Error('attendu un échec');
    return raisonDeValidation(r.error);
  };

  it('🔴 l’ancienne clé `optIn` est REFUSÉE en nommant celle qui la remplace', () => {
    expect(echec(z.object({ optIn: z.never().optional() }), { optIn: true })).toMatch(/consent/);
  });

  it('`phone` refusé sur une modification dit pourquoi', () => {
    expect(echec(z.object({ phone: z.never().optional() }), { phone: '+33612345678' })).toMatch(/ne se modifie pas/);
  });

  it('les bornes nomment le champ : `contactId`, `externalId`, `consent`, `consentSource`', () => {
    expect(echec(z.object({ contactId: z.guid() }), { contactId: 'c1' })).toMatch(/« contactId » : un identifiant de fiche/);
    expect(echec(z.object({ externalId: z.string().max(512) }), { externalId: 'x'.repeat(513) })).toMatch(/« externalId » : texte de 512 caractères au plus/);
    expect(echec(z.object({ consent: z.enum(['opted_in', 'opted_out']) }), { consent: 'oui' })).toMatch(/« consent » : « opted_in » ou « opted_out »/);
    expect(echec(z.object({ consentSource: z.string().max(100) }), { consentSource: 'x'.repeat(101) })).toMatch(/« consentSource » : 100 caractères au plus/);
  });

  it('le message d’un `refine` à la racine est rendu TEL QUEL (il est écrit par nous, en français)', () => {
    const s = z.object({ a: z.string().optional() }).refine(() => false, { message: 'donnez exactement une clé' });
    expect(echec(s, {})).toBe('donnez exactement une clé');
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-preparation-champs.test.ts`
Expected: FAIL, `preparateurDeChamps is not a function`, et les messages attendus absents.

- [ ] **Step 3: Exports et schémas partagés**

Dans `src/api/contacts-upsert.ts` :
- l. 4, l'import existant devient `import { validateFieldValue, canonicalizeFieldValue, ensureFieldByKey, type UserFieldStore } from '../crm/fields';`, et ajouter `import { MAX_EXTERNAL_ID } from './fiche';` ;
- l. 47 : `const valeurDeChamp = ...` devient `export const valeurDeChamp = ...` ;
- avant `schemaContactApi` (l. 62), ajouter :

```ts
/** Les champs d'un contact : clé bornée, valeur texte, et pas plus de `MAX_CHAMPS_PAR_CONTACT` par contact. */
export const schemaChamps = z.record(z.string().max(MAX_CLE_CHAMP), valeurDeChamp)
  .refine((r) => Object.keys(r).length <= MAX_CHAMPS_PAR_CONTACT);

/** Des étiquettes : le tableau démesuré est refusé, pas tronqué (cf. la note de `schemaContactApi`). */
export const schemaTags = z.array(z.union([z.string(), z.number()]).transform(String)).max(MAX_TAGS_PAR_CONTACT);
```

- dans `schemaContactApi`, `fields: z.record(...).refine(...).optional(),` devient `fields: schemaChamps.optional(),` et la ligne `tags: z.array(...).max(MAX_TAGS_PAR_CONTACT).optional(),` devient `tags: schemaTags.optional(),` (leurs commentaires restent au-dessus) ;
- l. 130 : `const normalizeTags = ...` devient `export const normalizeTags = ...`.

- [ ] **Step 4: `raisonDeValidation` (l. 99-121)**

Avant la fonction, ajouter :

```ts
/** Les clés qu'un schéma REFUSE (`z.never`), et ce qu'on dit à qui les envoie. */
const CLES_REFUSEES: Record<string, string> = {
  optIn: '« optIn » n’existe plus : utilisez « consent » (« opted_in » ou « opted_out »)',
  optInSource: '« optInSource » n’existe plus : utilisez « consentSource »',
  phone: '« phone » ne se modifie pas : le numéro porte les conversations de la fiche',
  bsuid: '« bsuid » ne se modifie pas : il porte les conversations de la fiche',
};
```

Dans la fonction, remplacer la ligne `if (chemin === '') return 'chaque contact doit être un objet';` par :

```ts
  // Un `refine` posé à la racine porte un message écrit par nous, en français : on le rend tel quel.
  if (chemin === '' && i.code === 'custom') return i.message;
  if (chemin === '') return 'chaque contact doit être un objet';
  if (i.code === 'invalid_type' && i.expected === 'never') return CLES_REFUSEES[chemin] ?? `« ${chemin} » : clé non acceptée ici`;
  if (chemin === 'contactId') return '« contactId » : un identifiant de fiche (UUID) est attendu';
  if (chemin === 'externalId') return `« externalId » : texte de ${MAX_EXTERNAL_ID} caractères au plus`;
  if (chemin === 'consent') return '« consent » : « opted_in » ou « opted_out » est attendu';
  if (chemin === 'consentSource') return `« consentSource » : ${MAX_OPT_IN_SOURCE} caractères au plus`;
  if (chemin === 'addTags' || chemin === 'removeTags') return `« ${chemin} » : une liste de ${MAX_TAGS_PAR_CONTACT} étiquettes au plus, en texte`;
```

(Les branches existantes, `invalid_key`, `fields`, `phone`, `optInSource`, `tags`, restent en dessous, inchangées.)

- [ ] **Step 5: Extraire `preparateurDeChamps`**

Juste avant `upsertContactsFromApi`, ajouter :

```ts
/** Ce que rend la préparation des champs d'UN contact : les valeurs canoniques, ou la raison du refus. */
export type ChampsPrepares = { ok: true; valeurs: Record<string, string> } | { ok: false; raison: string };

/**
 * PRÉPARER LES CHAMPS D'UN CONTACT : résoudre chaque référence (clé technique OU code, D-2), auto-créer en
 * texte un champ inconnu dans la limite du plafond, valider et canonicaliser chaque valeur.
 *
 * Les définitions sont chargées UNE fois, et le cache GROSSIT au fil des appels : un champ auto-créé par un
 * contact est connu du suivant sans relire la base.
 *
 * 🔴 LE PLAFOND SE COMPTE SUR `defs`, QUI GROSSIT AU FIL DU LOT, et c'est ce qui en fait une borne.
 * Compté sur la seule photo d'avant, un unique appel de 500 contacts portant 500 clés distinctes
 * passerait entièrement : le plafond ne serait qu'un compteur d'historique.
 *
 * ⚠️ IL VAUT POUR TOUS LES CHEMINS QUI PRÉPARENT DES CHAMPS PAR ICI : l'API publique, le webhook entrant
 * (`src/webhook-entrant/chemin.ts`) et la création à la main de la console. C'est voulu, l'amplification
 * est la même ; et le webhook y est le moins exposé, puisque ses clés de champs viennent d'un mapping qu'un
 * ADMIN de l'espace a configuré, pas du payload d'un tiers.
 *
 * ⚠️ ET IL NE REFUSE QUE LA CRÉATION. Un contact qui n'utilise que des champs DÉJÀ déclarés passe, même
 * au plafond, y compris dans le lot où un autre contact vient d'être refusé. Un plafond qui bloquerait
 * l'espace entier une fois atteint changerait une protection en panne.
 */
export async function preparateurDeChamps(
  tenantId: string,
  deps: { fields: UserFieldStore; maxChampsParEspace?: number },
): Promise<(champs: Record<string, string> | undefined) => Promise<ChampsPrepares>> {
  const defs = await deps.fields.list(tenantId);
  const cache: FieldLister = { list: async () => defs };
  const ensured = new Set<string>();
  const plafondEspace = deps.maxChampsParEspace ?? config.API_MAX_CHAMPS_PAR_ESPACE;
  const plafondAtteint = (): boolean => plafondEspace > 0 && defs.length >= plafondEspace;
  return async (champs) => {
    const valeurs: Record<string, string> = {};
    for (const [ref, rawVal] of Object.entries(champs ?? {})) {
      const resolved = await resolveFieldKey(tenantId, ref, cache);
      if (!resolved.ok) return { ok: false, raison: `champ inconnu : ${ref}` };
      if (!resolved.known && !ensured.has(resolved.key)) {
        if (plafondAtteint()) {
          // La raison NOMME le geste qui débloque : l'intégrateur ne peut pas deviner qu'un champ se crée
          // aussi depuis la console, et un refus sans issue se transforme en ticket de support.
          return { ok: false, raison: `« ${resolved.key} » : cet espace a atteint son plafond de ${plafondEspace} champs personnalisés. Créez-le depuis la console, puis relancez.` };
        }
        await ensureFieldByKey(deps.fields, tenantId, resolved.key, resolved.key, 'text');
        ensured.add(resolved.key);
        defs.push({ key: resolved.key, label: resolved.key, type: 'text' } as UserFieldDef);
      }
      const val = String(rawVal);
      if (!validateFieldValue(resolved.type, val)) {
        // Une date refusée dit POURQUOI : ambiguë, sans heure, ou illisible.
        const detail = resolved.type === 'date' || resolved.type === 'datetime'
          ? raisonDateLisible((normaliserDate(val, resolved.type) as { raison: 'ambigu' | 'sans_heure' | 'illisible' }).raison)
          : `valeur invalide (${resolved.type})`;
        return { ok: false, raison: `« ${resolved.key} » : ${detail}` };
      }
      valeurs[resolved.key] = canonicalizeFieldValue(resolved.type, val);
    }
    return { ok: true, valeurs };
  };
}
```

Dans `upsertContactsFromApi`, supprimer les lignes 167-188 (le chargement de `defs`, `cache`, `ensured`, le docblock du plafond, `plafondEspace`, `plafondAtteint`) et les remplacer par :

```ts
  // La préparation des champs est PARTAGÉE avec l'API publique (`preparateurDeChamps`) : mêmes règles de
  // résolution, d'auto-création et de plafond, un seul cache par appel.
  const preparer = await preparateurDeChamps(tenantId, deps);
```

Puis remplacer tout le bloc de la boucle des champs (de `const fieldValues: Record<string, string> = {};` jusqu'à la fin du `if (fieldError) { ... continue; }`, l. 207-238) par :

```ts
    const prep = await preparer(item.fields);
    if (!prep.ok) {
      out.push({ index: i, status: 'error', reason: prep.raison });
      continue;
    }
```

et, dans l'objet `upsert`, `fields: fieldValues,` devient `fields: prep.valeurs,`. L'ordre reste le même : le numéro d'abord, les champs ensuite, les écritures par vagues ensuite.

- [ ] **Step 6: Le voir passer, et prouver que l'upsert n'a pas bougé**

Run: `npx vitest run tests/api-preparation-champs.test.ts tests/api-contacts-upsert.test.ts tests/api-champs-bornes.test.ts tests/v1-contacts.test.ts tests/v1-contacts-hostile.test.ts && npm run typecheck && npm test`
Expected: PASS partout. `tests/api-contacts-upsert.test.ts` et `tests/api-champs-bornes.test.ts` sont les témoins du comportement inchangé (source du consentement, écritures bornées à 4 en vol, ordre des résultats, plafond).

- [ ] **Step 7: Vérifier dans les deux sens**

Dans `preparateurDeChamps`, retirer `ensured.add(resolved.key);` ET `defs.push(...)` : le premier cas de `tests/api-preparation-champs.test.ts` échoue (`crees` vaut `['ville', 'ville']`). Restaurer, revoir le vert.

- [ ] **Step 8: Commit (procédure P)**

Chemins : `src/api/contacts-upsert.ts tests/api-preparation-champs.test.ts`. Message : `refactor(api): la preparation des champs d un contact est partagee (aucun changement de comportement)`.

---

### Task 9: Le service des fiches de l'API publique

**Files:**
- Create: `src/api/contacts-v1.ts`
- Modify: `src/rcs/reachability.ts` (fonction ajoutée après `TTL_MS`, l. 5)
- Modify: `tests/integration/contacts-identite.integration.test.ts` (un cas)
- Test: `tests/api-contacts-v1.test.ts`

**Interfaces:**
- Consumes: Tasks 4 à 8 ; `verdictWhatsApp` (`src/contacts/joignabilite.ts`) ; `resolveFieldKey` (`src/ids/resolve.ts`) ; `estUuid`.
- Produces (dans `src/api/contacts-v1.ts`) :
  - `schemaContactV1` (clés + `name`, `fields`, `tags`, `consent`, `consentSource` ; `optIn` et `optInSource` refusés ; `name`, `consent` et `consentSource` vides ou blancs valent absence) et `type ContactV1`
  - `schemaPatchContactV1` (`name` texte ou `null`, `fields` valeur ou `null`, `addTags`, `removeTags`, `consent`, `consentSource`, `externalId` ; `phone` et `bsuid` refusés ; une chaîne vide ou blanche vaut absence, seul `null` vide le nom) et `type PatchContactV1`
  - `schemaRechercheContactV1` (exactement une clé parmi `phone`, `bsuid`, `externalId`) et `type RechercheContactV1`
  - `type ResultatFiche = { index: number; status: 'created' | 'updated'; contactId: string } | { index: number; status: 'error'; code: CodeApi; reason: string }`
  - `interface FicheApi` (le contrat de `GET /v1/contacts/{contactId}`, § 2)
  - `function formaterFicheApi(l: FicheApiLigne, rcs: boolean | null, maintenant: Date): FicheApi`
  - `interface ServiceContactsV1 { ecrireFiches(tenantId, items: ContactV1[]): Promise<ResultatFiche[]>; lireFiche(tenantId, contactId): Promise<FicheApi | null>; chercherFiche(tenantId, recherche: RechercheContactV1): Promise<ResultatRecherche>; modifierFiche(tenantId, contactId, patch: PatchContactV1): Promise<ResultatModification> }`
  - `interface DepsServiceContactsV1` et `function creerServiceContactsV1(deps: DepsServiceContactsV1): ServiceContactsV1`
  - dans `src/rcs/reachability.ts` : `export function joignabiliteRcsConnue(entree: { reachable: boolean; checkedAt: number } | null, maintenantMs: number): boolean | null`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/api-contacts-v1.test.ts
import { describe, it, expect } from 'vitest';
import {
  creerServiceContactsV1, formaterFicheApi, schemaContactV1, schemaPatchContactV1, schemaRechercheContactV1,
  type ResultatFiche,
} from '../src/api/contacts-v1';
import { joignabiliteRcsConnue, TTL_MS } from '../src/rcs/reachability';
import type { AuditSink } from '../src/audit/journal';
import type { FicheApiLigne } from '../src/crm/contact-store.pg';
import type { UserFieldDef } from '../src/crm/types';
import { FichesMemoire } from './aide/fiches-memoire';

/**
 * LE SERVICE DES FICHES DE L'API PUBLIQUE (spec du 2026-09-24, § 2), sur un répertoire en mémoire aux règles
 * de la base. Ce qui est éprouvé ici : la résolution multi-clés, l'ordre « champs validés AVANT toute
 * création », le consentement dans les deux sens, et les contrats de lecture.
 */
const T = 't1';
const MAINTENANT = new Date('2026-09-24T12:00:00.000Z');

function monter(opts: { defs?: UserFieldDef[]; max?: number; rcs?: boolean | null } = {}) {
  const repertoire = new FichesMemoire();
  const audits: Array<{ action: string; id: string; detail: unknown }> = [];
  const audit: AuditSink = async (_t, _a, action, cible, detail) => { audits.push({ action, id: cible.id, detail }); };
  const defs = [...(opts.defs ?? [])];
  const creees: string[] = [];
  const rcsDemandes: string[] = [];
  const service = creerServiceContactsV1({
    contacts: repertoire,
    fields: { list: async () => defs, upsert: async (_t, d) => { creees.push(d.key); } },
    audit,
    joignabiliteRcs: async (_t, e164) => { rcsDemandes.push(e164); return opts.rcs ?? null; },
    maxChampsParEspace: opts.max ?? 0,
    maintenant: () => MAINTENANT,
  });
  return { service, repertoire, audits, creees, rcsDemandes };
}

function idDe(r: ResultatFiche | undefined): string {
  if (!r || r.status === 'error') throw new Error(`attendu un succès, reçu ${JSON.stringify(r)}`);
  return r.contactId;
}

describe('ecrireFiches : créer ou compléter', () => {
  it('🔴 crée par numéro, puis une écriture par identifiant externe SEUL complète la MÊME fiche', async () => {
    const { service, repertoire } = monter();
    const [r1] = await service.ecrireFiches(T, [{ phone: '+33612345678', externalId: 'crm-7781' }]);
    expect(r1).toMatchObject({ status: 'created' });
    const id = idDe(r1);
    const [r2] = await service.ecrireFiches(T, [{ externalId: 'crm-7781', name: 'Camille Roy', fields: { ville: 'Lyon' }, tags: ['prospect'] }]);
    expect(r2).toEqual({ index: 0, status: 'updated', contactId: id });
    expect(repertoire.fiches.find((f) => f.id === id)).toMatchObject({ profileName: 'Camille Roy', fields: { ville: 'Lyon' }, tags: ['prospect'] });
  });

  it('🔴 un identifiant externe seul et INCONNU : `unknown_contact`, et aucune fiche', async () => {
    const { service, repertoire } = monter();
    const [r] = await service.ecrireFiches(T, [{ externalId: 'crm-7781' }]);
    expect(r).toMatchObject({ status: 'error', code: 'unknown_contact' });
    expect(repertoire.fiches).toHaveLength(0);
  });

  it('un BSUID seul suffit : cette route crée', async () => {
    const { service } = monter();
    expect((await service.ecrireFiches(T, [{ bsuid: 'BSUID-1' }]))[0]).toMatchObject({ status: 'created' });
  });

  it('🔴 deux clés sur deux fiches : `identity_conflict`, et RIEN n’est écrit, pas même le nom', async () => {
    const { service, repertoire } = monter();
    const a = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    repertoire.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-7781' });
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', externalId: 'crm-7781', name: 'Intrus' }]);
    expect(r).toMatchObject({ status: 'error', code: 'identity_conflict' });
    expect(repertoire.ecritures).toEqual([]);
    expect(a.profileName).toBeNull();
  });

  it('🔴 un champ refusé ne crée PAS de fiche : les champs sont validés avant toute création', async () => {
    const { service, repertoire, creees } = monter({ defs: [{ key: 'prenom', label: 'prenom', type: 'text' } as UserFieldDef], max: 1 });
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', fields: { nouveau: 'x' } }]);
    expect(r).toMatchObject({ status: 'error', code: 'invalid_body' });
    expect(repertoire.fiches).toHaveLength(0);
    expect(creees).toEqual([]);
  });

  it('deux éléments du même numéro dans un lot : UNE seule fiche', async () => {
    const { service, repertoire } = monter();
    const res = await service.ecrireFiches(T, [{ phone: '+33612345678' }, { phone: '06 12 34 56 78', name: 'Marc' }]);
    expect(res.map((r) => r.index)).toEqual([0, 1]);
    expect(new Set(res.map(idDe)).size).toBe(1);
    expect(res.map((r) => r.status).sort()).toEqual(['created', 'updated']);
    expect(repertoire.fiches).toHaveLength(1);
  });

  it('aucune clé : `invalid_recipient` ; numéro illisible : `invalid_phone` ; chaque erreur à SON index', async () => {
    const { service } = monter();
    const res = await service.ecrireFiches(T, [{ name: 'sans clé' }, { phone: '+33612345678' }, { phone: 'n-importe-quoi' }]);
    expect(res.map((r) => (r.status === 'error' ? r.code : r.status))).toEqual(['invalid_recipient', 'created', 'invalid_phone']);
  });

  it('🔴 un élément sans clé ou au numéro illisible ne fait naître AUCUNE définition de champ', async () => {
    // Les clés d'abord, les champs ensuite, comme l'upsert d'avant : une définition est durable et compte
    // dans le plafond de l'espace, un élément refusé ne doit pas en laisser.
    const { service, repertoire, creees } = monter();
    const res = await service.ecrireFiches(T, [{ name: 'x', fields: { nouveau: 'v' } }, { phone: 'n-importe-quoi', fields: { autre: 'v' } }]);
    expect(res.map((r) => (r.status === 'error' ? r.code : r.status))).toEqual(['invalid_recipient', 'invalid_phone']);
    expect(creees).toEqual([]);
    expect(repertoire.fiches).toHaveLength(0);
  });

  it('🔴 le coût d’un élément complet : UNE recherche et UNE écriture, pas une transaction de plusieurs allers-retours', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    await service.ecrireFiches(T, [{ phone: '+33612345678', name: 'Marc', fields: { ville: 'Lyon' }, tags: ['vip'] }]);
    expect(repertoire.appelsChercher).toBe(1);
    expect(repertoire.ecritures).toEqual([`edition:${f.id}`]);
  });

  it('🔴 une fiche PURGÉE entre la résolution et l’écriture n’est pas réécrite : `unknown_contact`', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    const chercher = repertoire.chercherParCles.bind(repertoire);
    // La résolution voit la fiche active, puis une purge passe avant l'écriture.
    repertoire.chercherParCles = async (t, c) => { const r = await chercher(t, c); f.supprimee = true; return r; };
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', name: 'Intrus', fields: { ville: 'Lyon' } }]);
    expect(r).toMatchObject({ status: 'error', code: 'unknown_contact' });
    expect(f.profileName).toBeNull();
    expect(f.fields).toEqual({});
  });
});

describe('ecrireFiches : le consentement', () => {
  it('🔴 `consent: opted_out` : statut, date, et une ligne `contact.optout` (source api)', async () => {
    const { service, repertoire, audits } = monter();
    const id = idDe((await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_out' }]))[0]);
    expect(repertoire.fiches[0]).toMatchObject({ optInStatus: 'opted_out', optInSource: 'api' });
    expect(repertoire.fiches[0]!.optOutAt).not.toBeNull();
    expect(audits).toEqual([{ action: 'contact.optout', id, detail: { source: 'api', consentSource: 'api' } }]);
  });

  it('🔴 une écriture SANS `consent` ne rétrograde jamais un désabonné', async () => {
    const { service, repertoire, audits } = monter();
    repertoire.ajouter(T, { phoneE164: '+33612345678', optInStatus: 'opted_out', optInSource: 'crm' });
    await service.ecrireFiches(T, [{ phone: '+33612345678', name: 'Marc' }]);
    expect(repertoire.fiches[0]).toMatchObject({ optInStatus: 'opted_out', optInSource: 'crm' });
    expect(audits).toEqual([]);
  });

  it('⚠️ un `opted_out` répété garde la date du premier et ne journalise qu’une fois', async () => {
    const { service, repertoire, audits } = monter();
    await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_out' }]);
    const date = repertoire.fiches[0]!.optOutAt;
    await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_out' }]);
    expect(repertoire.fiches[0]!.optOutAt).toBe(date);
    expect(audits).toHaveLength(1);
  });

  it('`consentSource` est la source écrite', async () => {
    const { service, repertoire } = monter();
    await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_in', consentSource: 'formulaire-site' }]);
    expect(repertoire.fiches[0]).toMatchObject({ optInStatus: 'opted_in', optInSource: 'formulaire-site' });
  });
});

describe('lire et chercher', () => {
  const LIGNE: FicheApiLigne = {
    id: '00000000-0000-4000-8000-000000000009', externalId: 'crm-7781', phoneE164: '+33612345678', bsuid: null,
    profileName: 'Camille Roy', fields: { ville: 'Lyon' }, tags: ['prospect'], optInStatus: 'opted_in',
    optInSource: 'formulaire-site', optOutAt: null, rcsOptoutAt: null, blockedAt: null,
    whatsappJoignable: true, whatsappJoignableLe: '2026-09-20T10:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z',
  };

  it('🔴 le contrat de lecture du § 2, champ pour champ', () => {
    expect(formaterFicheApi(LIGNE, null, MAINTENANT)).toEqual({
      contactId: LIGNE.id, externalId: 'crm-7781', phone: '+33612345678', bsuid: null, name: 'Camille Roy',
      fields: { ville: 'Lyon' }, tags: ['prospect'],
      consent: { status: 'opted_in', source: 'formulaire-site', optedOutAt: null },
      rcsOptedOutAt: null, blocked: false, reachability: { whatsapp: true, rcs: null },
      createdAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('⚠️ une mesure WhatsApp PÉRIMÉE redevient inconnue (`null`, jamais `false`) ; un statut illisible vaut `unknown`', () => {
    const f = formaterFicheApi({ ...LIGNE, whatsappJoignable: false, whatsappJoignableLe: '2026-05-01T10:00:00.000Z', optInStatus: 'bizarre', blockedAt: '2026-09-02T00:00:00.000Z' }, false, MAINTENANT);
    expect(f.reachability).toEqual({ whatsapp: null, rcs: false });
    expect(f.consent.status).toBe('unknown');
    expect(f.blocked).toBe(true);
  });

  it('la joignabilité RCS connue : une entrée périmée ne dit plus rien', () => {
    const now = MAINTENANT.getTime();
    expect(joignabiliteRcsConnue(null, now)).toBeNull();
    expect(joignabiliteRcsConnue({ reachable: false, checkedAt: now - 1000 }, now)).toBe(false);
    expect(joignabiliteRcsConnue({ reachable: true, checkedAt: now - TTL_MS - 1 }, now)).toBeNull();
  });

  it('lireFiche : identifiant mal formé ou fiche supprimée, `null` ; sans numéro, le RCS n’est même pas demandé', async () => {
    const { service, repertoire, rcsDemandes } = monter({ rcs: true });
    expect(await service.lireFiche(T, 'c1')).toBeNull();
    const supprimee = repertoire.ajouter(T, { phoneE164: '+33612345678', supprimee: true });
    expect(await service.lireFiche(T, supprimee.id)).toBeNull();
    const sansNumero = repertoire.ajouter(T, { bsuid: 'BSUID-1' });
    expect((await service.lireFiche(T, sansNumero.id))?.reachability).toEqual({ whatsapp: null, rcs: null });
    expect(rcsDemandes).toEqual([]);
    const avecNumero = repertoire.ajouter(T, { phoneE164: '+33698765432' });
    expect((await service.lireFiche(T, avecNumero.id))?.reachability.rcs).toBe(true);
    expect(rcsDemandes).toEqual(['+33698765432']);
  });

  it('chercherFiche : par numéro (même écrit en national), par identifiant externe ; inconnu : `null`', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-7781' });
    expect(await service.chercherFiche(T, { phone: '06 12 34 56 78' })).toMatchObject({ ok: true, fiche: { contactId: f.id } });
    expect(await service.chercherFiche(T, { externalId: 'crm-7781' })).toMatchObject({ ok: true, fiche: { contactId: f.id } });
    expect(await service.chercherFiche(T, { bsuid: 'inconnu' })).toEqual({ ok: true, fiche: null });
    expect(await service.chercherFiche(T, { phone: 'n-importe-quoi' })).toMatchObject({ ok: false, code: 'invalid_phone' });
  });

  it('la recherche exige EXACTEMENT une clé, et n’accepte pas `contactId` (c’est `GET`)', () => {
    expect(schemaRechercheContactV1.safeParse({ phone: '+33612345678' }).success).toBe(true);
    expect(schemaRechercheContactV1.safeParse({ phone: '+33612345678', externalId: 'crm-7781' }).success).toBe(false);
    expect(schemaRechercheContactV1.safeParse({}).success).toBe(false);
    expect(schemaRechercheContactV1.safeParse({ contactId: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
  });
});

describe('modifierFiche', () => {
  it('🔴 `fields` : `null` VIDE le champ, les autres se fusionnent', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', fields: { ville: 'Lyon', age: '42' } });
    expect(await service.modifierFiche(T, f.id, { fields: { ville: null, prenom: 'Camille' } })).toEqual({ ok: true, contactId: f.id });
    expect(f.fields).toEqual({ age: '42', prenom: 'Camille' });
  });

  it('🔴 `externalId` se pose et se remplace ; porté ailleurs : `identity_conflict`, et le reste n’est pas écrit', async () => {
    const { service, repertoire } = monter();
    const a = repertoire.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-1' });
    repertoire.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-2' });
    expect(await service.modifierFiche(T, a.id, { externalId: 'crm-3' })).toEqual({ ok: true, contactId: a.id });
    expect(a.externalId).toBe('crm-3');
    expect(await service.modifierFiche(T, a.id, { externalId: 'crm-2', name: 'Intrus' })).toMatchObject({ ok: false, code: 'identity_conflict' });
    expect(a.externalId).toBe('crm-3');
    expect(a.profileName).toBeNull();
  });

  it('🔴 un champ refusé n’écrit RIEN, pas même l’identifiant externe demandé dans le même appel', async () => {
    const { service, repertoire } = monter();
    const a = repertoire.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-1' });
    expect(await service.modifierFiche(T, a.id, { externalId: 'crm-9', fields: { fld_inconnu: 'x' } })).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(a.externalId).toBe('crm-1');
    expect(repertoire.ecritures).toEqual([]);
  });

  it('étiquettes ajoutées et retirées, nom vidé par `null`, consentement', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', profileName: 'Marc', tags: ['a', 'b'] });
    await service.modifierFiche(T, f.id, { addTags: ['c'], removeTags: ['a'], name: null, consent: 'opted_out' });
    expect(f).toMatchObject({ tags: ['b', 'c'], profileName: null, optInStatus: 'opted_out' });
    expect(audits.map((a) => a.action)).toEqual(['contact.optout']);
  });

  it('rien à modifier : `invalid_body` ; fiche inconnue ou mal désignée : `unknown_contact`', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    expect(await service.modifierFiche(T, f.id, {})).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(await service.modifierFiche(T, '00000000-0000-4000-8000-999999999999', { name: 'x' })).toMatchObject({ ok: false, code: 'unknown_contact' });
    expect(await service.modifierFiche(T, 'c1', { name: 'x' })).toMatchObject({ ok: false, code: 'unknown_contact' });
  });

  it('le numéro et le BSUID ne se modifient pas ici', () => {
    expect(schemaPatchContactV1.safeParse({ phone: '+33612345678' }).success).toBe(false);
    expect(schemaPatchContactV1.safeParse({ bsuid: 'B' }).success).toBe(false);
  });
});

describe('schemaContactV1', () => {
  it('🔴 `optIn` est refusé : il est remplacé par `consent`', () => {
    expect(schemaContactV1.safeParse({ phone: '+33612345678', optIn: true }).success).toBe(false);
    expect(schemaContactV1.safeParse({ phone: '+33612345678', consent: 'opted_in', consentSource: 'formulaire-site' }).success).toBe(true);
  });

  it('🔴 une chaîne vide ou blanche vaut ABSENCE pour `name`, `consent` et `consentSource`, comme pour les clés', () => {
    // Un outil qui remplit son corps avec les variables d'un profil envoie `""` pour une variable absente :
    // refuser l'élément entier pour ça serait refuser précisément le cas d'usage de la règle.
    const r = schemaContactV1.safeParse({ phone: '+33612345678', name: '', consent: '', consentSource: ' ' });
    expect(r.success).toBe(true);
    expect(r.success && [r.data.name, r.data.consent, r.data.consentSource]).toEqual([undefined, undefined, undefined]);
    const p = schemaPatchContactV1.safeParse({ name: ' ', consent: '', consentSource: '' });
    expect(p.success && [p.data.name, p.data.consent, p.data.consentSource]).toEqual([undefined, undefined, undefined]);
    // `null` reste le geste explicite qui VIDE le nom.
    const vider = schemaPatchContactV1.safeParse({ name: null });
    expect(vider.success && vider.data.name).toBeNull();
    // Une valeur fausse reste refusée : l'absence ne couvre que le vide.
    expect(schemaContactV1.safeParse({ phone: '+33612345678', consent: 'oui' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-contacts-v1.test.ts`
Expected: FAIL, `Failed to resolve import "../src/api/contacts-v1"`.

- [ ] **Step 3: `joignabiliteRcsConnue`, dans `src/rcs/reachability.ts` après `TTL_MS` (l. 5)**

```ts
/**
 * Ce que le cache DIT de la joignabilité RCS d'un numéro, sans jamais interroger le fournisseur (lecture de
 * fiche par l'API). `null` = inconnu : aucune entrée, ou une entrée PÉRIMÉE, qui ne vaut plus une mesure.
 * ⚠️ L'envoi, lui, garde sa propre règle (`Reachability.isReachable` sert une vieille réponse si le
 * fournisseur tombe) : ce n'est pas la même question.
 */
export function joignabiliteRcsConnue(entree: { reachable: boolean; checkedAt: number } | null, maintenantMs: number): boolean | null {
  if (!entree) return null;
  return maintenantMs - entree.checkedAt <= TTL_MS ? entree.reachable : null;
}
```

- [ ] **Step 4: Le service**

```ts
// src/api/contacts-v1.ts
import { z } from 'zod';
import type { AuditSink } from '../audit/journal';
import type { FicheApiLigne, PgContactStore } from '../crm/contact-store.pg';
import type { UserFieldStore } from '../crm/fields';
import { verdictWhatsApp } from '../contacts/joignabilite';
import { estUuid } from '../http/scope';
import { resolveFieldKey } from '../ids/resolve';
import {
  ECRITURES_EN_VOL, MAX_CHAMPS_PAR_CONTACT, MAX_CLE_CHAMP, MAX_OPT_IN_SOURCE,
  normalizeTags, preparateurDeChamps, schemaChamps, schemaTags, valeurDeChamp,
} from './contacts-upsert';
import { appliquerConsentement, type DepsConsentement } from './consentement';
import type { CodeApi } from './erreurs';
import { MAX_EXTERNAL_ID, MESSAGE_RESOLUTION, normaliserCles, resoudreFiche, schemaClesFiche, videEnAbsent } from './fiche';

/**
 * LES FICHES DE L'API PUBLIQUE (`/v1/contacts`, spec du 2026-09-24, § 2).
 *
 * 🔴 UNE PERSONNE EST UNE FICHE : elle se désigne par ce que l'intégrateur a, et `resoudreFiche` la trouve.
 * Ce service n'écrit qu'APRÈS : champs validés, fiche résolue (ou créée), puis édition, puis consentement.
 * Un champ refusé ne crée donc jamais de fiche, et un conflit d'identité n'écrit rien.
 *
 * ⚠️ `upsertContactsFromApi` N'EST PLUS SUR CE CHEMIN : il désigne un contact par son numéro seul, et ne sait
 * que promouvoir un consentement. Il reste celui du webhook entrant et de la création à la main.
 */

// Une chaîne vide ou blanche vaut ABSENCE, comme pour les quatre clés (`videEnAbsent`) : un outil qui remplit
// son corps avec les variables d'un profil envoie `""` pour une variable absente, et refuser l'élément entier
// pour un consentement vide serait refuser précisément ce cas. Une valeur FAUSSE (« oui ») reste refusée.
const consent = z.preprocess(videEnAbsent, z.enum(['opted_in', 'opted_out']).optional());
const consentSource = z.preprocess(videEnAbsent, z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional());

export const schemaContactV1 = schemaClesFiche.extend({
  name: z.preprocess(videEnAbsent, z.string().optional()),
  fields: schemaChamps.optional(),
  tags: schemaTags.optional(),
  consent,
  consentSource,
  // REFUSÉES, pas ignorées : elles décrivaient le consentement avant `consent`, et un intégrateur qui les
  // enverrait encore croirait avoir consigné un opt-in qui n'existerait nulle part.
  optIn: z.never().optional(),
  optInSource: z.never().optional(),
});
export type ContactV1 = z.infer<typeof schemaContactV1>;

export const schemaPatchContactV1 = z.object({
  // Seul `null` VIDE le nom : une chaîne blanche est une variable absente, pas une demande d'effacement.
  name: z.preprocess(videEnAbsent, z.union([z.string(), z.null()]).optional()),
  fields: z.record(z.string().max(MAX_CLE_CHAMP), z.union([valeurDeChamp, z.null()]))
    .refine((r) => Object.keys(r).length <= MAX_CHAMPS_PAR_CONTACT)
    .optional(),
  addTags: schemaTags.optional(),
  removeTags: schemaTags.optional(),
  consent,
  consentSource,
  externalId: z.preprocess(videEnAbsent, z.string().trim().max(MAX_EXTERNAL_ID).optional()),
  // Ils portent les conversations : les changer couperait la fiche de son historique.
  phone: z.never().optional(),
  bsuid: z.never().optional(),
});
export type PatchContactV1 = z.infer<typeof schemaPatchContactV1>;

/** Une RECHERCHE, pas un rattachement : exactement une clé, et jamais le numéro dans l'adresse. */
export const schemaRechercheContactV1 = schemaClesFiche.omit({ contactId: true }).refine(
  (c) => [c.phone, c.bsuid, c.externalId].filter((v) => v !== undefined).length === 1,
  { message: 'donnez exactement une clé : « phone », « bsuid » ou « externalId »' },
);
export type RechercheContactV1 = z.infer<typeof schemaRechercheContactV1>;

export type ResultatFiche =
  | { index: number; status: 'created' | 'updated'; contactId: string }
  | { index: number; status: 'error'; code: CodeApi; reason: string };

export type ResultatRecherche = { ok: true; fiche: FicheApi | null } | { ok: false; code: 'invalid_phone'; reason: string };
export type ResultatModification = { ok: true; contactId: string } | { ok: false; code: CodeApi; reason: string };

/** Le contrat de `GET /v1/contacts/{contactId}` (§ 2). `null` = inconnu, jamais « faux » par défaut. */
export interface FicheApi {
  contactId: string;
  externalId: string | null;
  phone: string | null;
  bsuid: string | null;
  name: string | null;
  fields: Record<string, unknown>;
  tags: string[];
  consent: { status: 'opted_in' | 'opted_out' | 'unknown'; source: string | null; optedOutAt: string | null };
  rcsOptedOutAt: string | null;
  blocked: boolean;
  reachability: { whatsapp: boolean | null; rcs: boolean | null };
  createdAt: string;
}

export function formaterFicheApi(l: FicheApiLigne, rcs: boolean | null, maintenant: Date): FicheApi {
  // La règle de péremption est celle du mini-CRM (`verdictWhatsApp`), jamais une seconde définition.
  const whatsapp = verdictWhatsApp(l.whatsappJoignable, l.whatsappJoignableLe ? new Date(l.whatsappJoignableLe) : null, maintenant);
  const status = l.optInStatus === 'opted_in' || l.optInStatus === 'opted_out' ? l.optInStatus : 'unknown';
  return {
    contactId: l.id,
    externalId: l.externalId,
    phone: l.phoneE164,
    bsuid: l.bsuid,
    name: l.profileName,
    fields: l.fields,
    tags: l.tags,
    consent: { status, source: l.optInSource, optedOutAt: l.optOutAt },
    rcsOptedOutAt: l.rcsOptoutAt,
    blocked: l.blockedAt !== null,
    reachability: { whatsapp: whatsapp === 'inconnu' ? null : whatsapp === 'oui', rcs },
    createdAt: l.createdAt,
  };
}

export interface ServiceContactsV1 {
  ecrireFiches(tenantId: string, items: ContactV1[]): Promise<ResultatFiche[]>;
  lireFiche(tenantId: string, contactId: string): Promise<FicheApi | null>;
  chercherFiche(tenantId: string, recherche: RechercheContactV1): Promise<ResultatRecherche>;
  modifierFiche(tenantId: string, contactId: string, patch: PatchContactV1): Promise<ResultatModification>;
}

export interface DepsServiceContactsV1 {
  // `editerFicheApi` et pas `applyEdits` : une requête filtrée par `deleted_at is null`, pas une transaction
  // par élément qui verrouille sans ce filtre (cf. son docblock dans `src/crm/contact-store.pg.ts`).
  contacts: Pick<PgContactStore, 'chercherParCles' | 'creerFicheApi' | 'rattacherCles' | 'editerFicheApi' | 'poserExternalId' | 'lireFicheApi' | 'ecrireConsentementParId'>;
  fields: UserFieldStore;
  /** REQUIS : le consentement posé par l'API se journalise (`appliquerConsentement`). */
  audit: AuditSink;
  /** La joignabilité RCS CONNUE d'un numéro pour l'agent de l'espace. `null` = inconnue, ou pas de canal RCS. */
  joignabiliteRcs(tenantId: string, phoneE164: string): Promise<boolean | null>;
  maxChampsParEspace?: number;
  maintenant?: () => Date;
}

const INCONNUE_POUR_ECRIRE = 'aucune fiche ne correspond, et il faut un « phone » ou un « bsuid » pour en créer une (un « contactId » ne crée jamais de fiche)';

export function creerServiceContactsV1(deps: DepsServiceContactsV1): ServiceContactsV1 {
  const maintenant = deps.maintenant ?? ((): Date => new Date());
  const consentement: DepsConsentement = {
    ecrireConsentementParId: (t, id, statut, source) => deps.contacts.ecrireConsentementParId(t, id, statut, source),
    audit: deps.audit,
  };
  const optsChamps = {
    fields: deps.fields,
    ...(deps.maxChampsParEspace === undefined ? {} : { maxChampsParEspace: deps.maxChampsParEspace }),
  };

  async function lireFiche(tenantId: string, contactId: string): Promise<FicheApi | null> {
    if (!estUuid(contactId)) return null;
    const ligne = await deps.contacts.lireFicheApi(tenantId, contactId);
    if (!ligne) return null;
    const rcs = ligne.phoneE164 ? await deps.joignabiliteRcs(tenantId, ligne.phoneE164) : null;
    return formaterFicheApi(ligne, rcs, maintenant());
  }

  async function ecrireUne(tenantId: string, index: number, item: ContactV1, valeurs: Record<string, string>): Promise<ResultatFiche> {
    const r = await resoudreFiche(deps.contacts, tenantId, item, { creer: 'phone_ou_bsuid' });
    if (!r.ok) {
      return { index, status: 'error', code: r.code, reason: r.code === 'unknown_contact' ? INCONNUE_POUR_ECRIRE : MESSAGE_RESOLUTION[r.code] };
    }
    const nom = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim().slice(0, 200) : undefined;
    const tags = normalizeTags(item.tags);
    if (Object.keys(valeurs).length > 0 || tags.length > 0 || nom !== undefined) {
      // `false` : la fiche a été supprimée ou purgée depuis la résolution, rien n'a été écrit.
      const ecrit = await deps.contacts.editerFicheApi(tenantId, r.contactId, {
        fields: valeurs, removeFields: [], addTags: tags, removeTags: [], ...(nom !== undefined ? { profileName: nom } : {}),
      });
      if (!ecrit) return { index, status: 'error', code: 'unknown_contact', reason: MESSAGE_RESOLUTION.unknown_contact };
    }
    if (item.consent) await appliquerConsentement(consentement, tenantId, r.contactId, item.consent, item.consentSource ?? 'api');
    return { index, status: r.cree ? 'created' : 'updated', contactId: r.contactId };
  }

  return {
    async ecrireFiches(tenantId, items) {
      // DEUX TEMPS, comme l'upsert d'import : la préparation des champs est SÉQUENTIELLE (elle partage un
      // cache et peut créer une définition), les écritures partent par vagues bornées (le pool n'est pas à nous).
      //
      // 🔴 LES CLÉS D'ABORD, LES CHAMPS ENSUITE, comme l'upsert d'avant (le numéro, puis les champs) : un élément
      // sans clé ou au numéro illisible sort à son index sans avoir fait naître la moindre définition de champ.
      // Une définition est durable et compte dans le plafond de l'espace.
      // ⚠️ CE QUI RESTE, ET QUI EST ASSUMÉ : un élément aux clés LISIBLES qui finit en `unknown_contact` ou en
      // `identity_conflict` a pu créer une définition, parce que la préparation passe avant la résolution
      // (c'est ce qui garantit qu'un champ refusé ne crée jamais de fiche). Une définition est un nom de champ,
      // sans valeur ni personne.
      const preparer = await preparateurDeChamps(tenantId, optsChamps);
      const out: ResultatFiche[] = [];
      const aEcrire: Array<{ index: number; item: ContactV1; valeurs: Record<string, string> }> = [];
      for (const [index, item] of items.entries()) {
        const cles = normaliserCles(item);
        if (!cles.ok) { out.push({ index, status: 'error', code: cles.code, reason: MESSAGE_RESOLUTION[cles.code] }); continue; }
        const prep = await preparer(item.fields);
        if (!prep.ok) { out.push({ index, status: 'error', code: 'invalid_body', reason: prep.raison }); continue; }
        aEcrire.push({ index, item, valeurs: prep.valeurs });
      }
      for (let d = 0; d < aEcrire.length; d += ECRITURES_EN_VOL) {
        const vague = aEcrire.slice(d, d + ECRITURES_EN_VOL);
        out.push(...await Promise.all(vague.map((e) => ecrireUne(tenantId, e.index, e.item, e.valeurs))));
      }
      // Le contrat du lot : un résultat par index, dans l'ordre reçu.
      return out.sort((a, b) => a.index - b.index);
    },

    lireFiche,

    async chercherFiche(tenantId, recherche) {
      const n = normaliserCles(recherche);
      if (!n.ok) {
        return n.code === 'invalid_phone'
          ? { ok: false, code: 'invalid_phone', reason: MESSAGE_RESOLUTION.invalid_phone }
          : { ok: true, fiche: null };
      }
      const [trouvee] = await deps.contacts.chercherParCles(tenantId, n.cles);
      return { ok: true, fiche: trouvee ? await lireFiche(tenantId, trouvee.id) : null };
    },

    async modifierFiche(tenantId, contactId, patch) {
      const champs = Object.entries(patch.fields ?? {});
      const addTags = normalizeTags(patch.addTags);
      const removeTags = normalizeTags(patch.removeTags);
      if (patch.name === undefined && champs.length === 0 && addTags.length === 0 && removeTags.length === 0
        && patch.consent === undefined && patch.externalId === undefined) {
        return { ok: false, code: 'invalid_body', reason: 'rien à modifier : name, fields, addTags, removeTags, consent ou externalId' };
      }
      const r = await resoudreFiche(deps.contacts, tenantId, { contactId }, { creer: 'jamais' });
      if (!r.ok) return { ok: false, code: r.code, reason: r.code === 'unknown_contact' ? 'fiche inconnue' : MESSAGE_RESOLUTION[r.code] };

      // Les champs d'abord : un refus ici ne doit rien laisser d'écrit, pas même l'identifiant externe.
      // ⚠️ La contrepartie, assumée : une définition de champ née ici survit si `poserExternalId` finit en
      // conflit juste après. C'est un nom de champ, sans valeur ni personne.
      const aVider: string[] = [];
      const aPoser: Record<string, string> = {};
      for (const [ref, valeur] of champs) {
        if (valeur !== null) { aPoser[ref] = valeur; continue; }
        const cle = await resolveFieldKey(tenantId, ref, deps.fields);
        if (!cle.ok) return { ok: false, code: 'invalid_body', reason: `champ inconnu : ${ref}` };
        aVider.push(cle.key);
      }
      let valeurs: Record<string, string> = {};
      if (Object.keys(aPoser).length > 0) {
        const prep = await (await preparateurDeChamps(tenantId, optsChamps))(aPoser);
        if (!prep.ok) return { ok: false, code: 'invalid_body', reason: prep.raison };
        valeurs = prep.valeurs;
      }

      if (patch.externalId !== undefined) {
        const e = await deps.contacts.poserExternalId(tenantId, r.contactId, patch.externalId);
        if (e === 'conflit') return { ok: false, code: 'identity_conflict', reason: 'cet identifiant externe est déjà porté par une autre fiche de cet espace' };
        if (e === 'absente') return { ok: false, code: 'unknown_contact', reason: 'fiche inconnue' };
      }

      // Seul `null` VIDE le nom ; une chaîne blanche vaut absence (le schéma l'a déjà écartée, on ne la
      // retransforme pas en effacement ici).
      const nom = patch.name === null
        ? null
        : typeof patch.name === 'string' && patch.name.trim() !== '' ? patch.name.trim().slice(0, 200) : undefined;
      if (Object.keys(valeurs).length > 0 || aVider.length > 0 || addTags.length > 0 || removeTags.length > 0 || nom !== undefined) {
        const ecrit = await deps.contacts.editerFicheApi(tenantId, r.contactId, {
          fields: valeurs, removeFields: aVider, addTags, removeTags, ...(nom !== undefined ? { profileName: nom } : {}),
        });
        if (!ecrit) return { ok: false, code: 'unknown_contact', reason: 'fiche inconnue' };
      }
      if (patch.consent) await appliquerConsentement(consentement, tenantId, r.contactId, patch.consent, patch.consentSource ?? 'api');
      return { ok: true, contactId: r.contactId };
    },
  };
}
```

- [ ] **Step 5: Le voir passer**

Run: `npx vitest run tests/api-contacts-v1.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Vérifier dans les deux sens**

1. Dans `ecrireFiches`, déplacer la préparation des champs APRÈS la résolution (appeler `preparer(item.fields)` dans `ecrireUne`, après `resoudreFiche`) : « un champ refusé ne crée PAS de fiche » échoue (une fiche existe). Restaurer.
2. Dans `modifierFiche`, déplacer le bloc `if (patch.externalId !== undefined) { ... }` AVANT la boucle des champs : « un champ refusé n’écrit RIEN » échoue (`a.externalId` vaut `crm-9`). Restaurer.
3. Dans `ecrireFiches`, retirer les deux lignes `const cles = normaliserCles(item);` et `if (!cles.ok) { ... continue; }` : « un élément sans clé ou au numéro illisible ne fait naître AUCUNE définition » échoue (`creees` vaut `['nouveau', 'autre']`, les codes restent justes : c'est bien la définition, et elle seule, que ce cas garde). Restaurer.
4. Dans `ecrireUne`, retirer la ligne `if (!ecrit) return { index, status: 'error', code: 'unknown_contact', ... };` : « une fiche PURGÉE entre la résolution et l’écriture » échoue (`updated` au lieu de `unknown_contact`). Restaurer.
5. Dans `schemaContactV1`, remettre `consent: z.enum(['opted_in', 'opted_out']).optional(),` à la place de `consent,` : « une chaîne vide ou blanche vaut ABSENCE pour `name`, `consent` et `consentSource` » échoue (`r.success` faux). Restaurer, revoir le vert.

- [ ] **Step 7: Un cas d'intégration (service contre la base : recherche puis modification)**

Ajouter les imports `import { creerServiceContactsV1 } from '../../src/api/contacts-v1';` et `import { PgUserFieldStore } from '../../src/crm/field-store.pg';`, puis :

```ts
  it('🔴 service contre la base : écrire, chercher, modifier (null vide un champ, externalId se remplace)', async () => {
    const actions: string[] = [];
    const service = creerServiceContactsV1({
      contacts: store,
      fields: new PgUserFieldStore(pool),
      audit: async (_t, _a, action) => { actions.push(action); },
      joignabiliteRcs: async () => null,
    });
    const [r] = await service.ecrireFiches(tenantId, [{ phone: '+33600000721', externalId: 'itest-ext-721', fields: { ville: 'Lyon', age: '42' }, consent: 'opted_in' }]);
    expect(r).toMatchObject({ status: 'created' });
    const trouvee = await service.chercherFiche(tenantId, { externalId: 'itest-ext-721' });
    if (!trouvee.ok || !trouvee.fiche) throw new Error('fiche introuvable');
    const id = trouvee.fiche.contactId;
    expect(trouvee.fiche).toMatchObject({ phone: '+33600000721', fields: { ville: 'Lyon', age: '42' }, consent: { status: 'opted_in' } });
    expect(await service.modifierFiche(tenantId, id, { fields: { ville: null }, externalId: 'itest-ext-721-bis', consent: 'opted_out' })).toEqual({ ok: true, contactId: id });
    const relue = await service.lireFiche(tenantId, id);
    expect(relue).toMatchObject({ externalId: 'itest-ext-721-bis', fields: { age: '42' }, consent: { status: 'opted_out' } });
    expect(relue?.consent.optedOutAt).not.toBeNull();
    expect(actions).toEqual(['contact.optin', 'contact.optout']);
  });
```

- [ ] **Step 8: Commit (procédure P), puis lire la CI**

Chemins : `src/api/contacts-v1.ts src/rcs/reachability.ts tests/api-contacts-v1.test.ts tests/integration/contacts-identite.integration.test.ts`. Message : `feat(api): le service des fiches de l API publique (ecrire, lire, chercher, modifier)`. Corps (le coût, écrit dans le commit) : « Un élément de lot coûte une recherche et une écriture, deux requêtes sans transaction ni client dédié (tenu par "le coût d'un élément complet" et par le test d'`editerFicheApi`), plus la création, le rattachement ou le consentement et son audit quand ils ont lieu ; l'upsert d'avant en coûtait une. Au plus `ECRITURES_EN_VOL` éléments en vol. »

---

### Task 10: Les cinq routes `/v1/contacts`, leurs deux gardes, et le câblage

**Files:**
- Rewrite: `src/http/v1-contacts.ts` (l. 1-94)
- Modify: `src/api/usage-guard.ts:22-32` (`OperationApi` gagne `contacts.read`), `:106-107`, `:148`, `:187-188` (docblocks : le chemin lourd et le compte « six » des routes)
- Modify: `src/http/api-keys.ts:17` (`VALID_API_SCOPES`)
- Modify: `src/server.ts:542` (annonce avant, fichier de câblage partagé)
- Modify: `src/index.ts` : import l. 38, stores l. 390-391, commentaires l. 202-204, l. 763-764, l. 2170, câblage l. 3083-3085 (annonce avant, fichier de câblage partagé)
- Modify (commentaires devenus faux) : `src/api/contacts-upsert.ts:133-139`, `src/http/contacts.ts:87-88` et `:535-536`, `src/webhook-entrant/mapping.ts:70-71`, `src/http/webhook-entrant.ts:53-55`, `tests/api-contacts-upsert.test.ts:8`
- Create: `tests/aide/contacts-v1.ts`
- Rewrite: `tests/v1-contacts.test.ts`, `tests/v1-contacts-hostile.test.ts`
- Modify: `tests/api-usage-observation.test.ts:12,22,56,62,84-107,179,183,192,212,230,254,282-287,347`, `tests/http-mba-relais.test.ts:74`, `tests/api-arret-urgence.test.ts:44`, `tests/mcp-serveur.test.ts:75`, `tests/v1-messages.test.ts:78`, `tests/v1-sends.test.ts:67`, `tests/api-usage-guard.test.ts:32-38,205-215`

**Interfaces:**
- Consumes: `ServiceContactsV1`, `schemaContactV1`, `schemaPatchContactV1`, `schemaRechercheContactV1`, `ResultatFiche`, `creerServiceContactsV1` (Task 9) ; `refuser`, `STATUT_PAR_CODE` (Task 1) ; `raisonDeValidation` (Task 8) ; `joignabiliteRcsConnue` (Task 9).
- Produces:
  - `export interface V1ContactsRouteDeps extends ServiceContactsV1 { usage: ApiUsageGuard }`
  - `export interface GardesContactsV1 { ecrire: Guard; lire: Guard }`
  - `export function registerV1Contacts(app: FastifyInstance, deps: V1ContactsRouteDeps, gardes: GardesContactsV1): void`
  - routes : `POST /v1/contacts`, `POST /v1/contacts/batch` (`contacts:write`) ; `GET /v1/contacts/:contactId`, `POST /v1/contacts/search` (`contacts:read`) ; `PATCH /v1/contacts/:contactId` (`contacts:write`)
  - `OperationApi` : `'contacts.read'` (lecture, une unité, pas lourde)
  - `VALID_API_SCOPES = ['contacts:write', 'contacts:read', 'sends:create', 'mcp:read', 'mcp:write']`
  - `tests/aide/contacts-v1.ts` : `contactsV1Muets(over?: Partial<ServiceContactsV1>): ServiceContactsV1`

- [ ] **Step 1: Annoncer, puis le double de test partagé**

Annoncer aux autres sessions (`ListAgents`, `SendMessage`) : « j'édite `src/server.ts` (montage de `/v1/contacts`) et `src/index.ts` (câblage `v1.contacts`, un `PgReachabilityStore`, trois commentaires) ».

```ts
// tests/aide/contacts-v1.ts
import type { ServiceContactsV1 } from '../../src/api/contacts-v1';

/**
 * UN SERVICE DE FICHES QUI NE FAIT RIEN, pour les tests qui montent `/v1` sans éprouver les contacts
 * (envois, messages, MCP, usage, arrêt d'urgence). Écrire rend « créé » pour chaque élément, lire et
 * chercher ne trouvent rien, modifier réussit. Un test qui éprouve une route de contacts remplace la
 * méthode qui l'intéresse.
 */
export function contactsV1Muets(over: Partial<ServiceContactsV1> = {}): ServiceContactsV1 {
  return {
    ecrireFiches: async (_t, items) => items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` })),
    lireFiche: async () => null,
    chercherFiche: async () => ({ ok: true as const, fiche: null }),
    modifierFiche: async (_t, contactId) => ({ ok: true as const, contactId }),
    ...over,
  };
}
```

- [ ] **Step 2: Écrire les tests de route qui échouent**

```ts
// tests/v1-contacts.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { ContactV1, FicheApi, ServiceContactsV1 } from '../src/api/contacts-v1';
import { contactsV1Muets } from './aide/contacts-v1';
import { cleApiDeTest } from './aide/cle-api';

/** Fake du lookup de clé : mappe des clés claires -> {tenantId, scopes} via leur hash sha256. */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  touched: string[] = [];
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(id: string) { this.touched.push(id); }
}

const ECRITURE = cleApiDeTest('valide');
const LECTURE = cleApiDeTest('lecture');
const NOSCOPE = cleApiDeTest('sans_scope');
const ID = '00000000-0000-4000-8000-000000000001';

const FICHE: FicheApi = {
  contactId: ID, externalId: 'crm-7781', phone: '+33612345678', bsuid: null, name: 'Camille Roy',
  fields: { ville: 'Lyon' }, tags: ['prospect'], consent: { status: 'opted_in', source: 'formulaire-site', optedOutAt: null },
  rcsOptedOutAt: null, blocked: false, reachability: { whatsapp: true, rcs: null }, createdAt: '2026-09-24T10:00:00.000Z',
};

function app(over: Partial<ServiceContactsV1> = {}) {
  const cap = { ecrits: [] as Array<{ tenant: string; items: ContactV1[] }>, lus: [] as Array<{ tenant: string; id: string }> };
  const keys = new FakeApiKeys()
    .add(ECRITURE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write', 'sends:create'] })
    .add(LECTURE, { id: 'k3', tenantId: 't1', scopes: ['contacts:read'] })
    .add(NOSCOPE, { id: 'k2', tenantId: 't1', scopes: ['sends:create'] });
  const contacts = contactsV1Muets({
    ecrireFiches: async (tenant, items) => { cap.ecrits.push({ tenant, items }); return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` })); },
    lireFiche: async (tenant, id) => { cap.lus.push({ tenant, id }); return id === ID ? FICHE : null; },
    ...over,
  });
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts } }), cap, keys };
}
const auth = (key: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });

describe('POST /v1/contacts', () => {
  it('clé valide + droit : 200, espace issu de la clé, touchLastUsed', async () => {
    const { server, cap, keys } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(ECRITURE), payload: { phone: '+33612345678', externalId: 'crm-7781', name: 'Marc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contactId: 'c0', status: 'created' });
    expect(cap.ecrits[0]!.tenant).toBe('t1');
    expect(cap.ecrits[0]!.items[0]).toMatchObject({ phone: '+33612345678', externalId: 'crm-7781' });
    expect(keys.touched).toEqual(['k1']);
    await server.close();
  });

  it('🔴 sans clé, préfixe étranger ou clé inconnue : 401 `unauthorized` ; droit d’écriture manquant : 403 `missing_scope`, même avec le droit de lecture', async () => {
    const { server } = app();
    const sans = await server.inject({ method: 'POST', url: '/v1/contacts', headers: { 'content-type': 'application/json' }, payload: { phone: '+33612345678' } });
    expect(sans.statusCode).toBe(401);
    expect(sans.json()).toMatchObject({ code: 'unauthorized' });
    // Les deux cas d'origine de ce fichier, GARDÉS (réécrire un test conserve ses cas) : une clé qui n'a pas
    // le préfixe des nôtres, et une clé au bon format que personne n'a émise.
    for (const cle of ['jwt_or_whatever', cleApiDeTest('inconnue')]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(cle), payload: { phone: '+33612345678' } });
      expect(res.statusCode, cle).toBe(401);
      expect(res.json()).toMatchObject({ code: 'unauthorized' });
    }
    for (const cle of [NOSCOPE, LECTURE]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(cle), payload: { phone: '+33612345678' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'missing_scope' });
    }
    await server.close();
  });

  it('corps mal formé : 400 `invalid_body` qui nomme le champ ; en-têtes x-ratelimit-* posés', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(ECRITURE), payload: { phone: '+33612345678', consent: 'oui' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toMatch(/consent/);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(cap.ecrits).toHaveLength(0);
    await server.close();
  });

  it('🔴 un refus du service sort avec SON code et le statut de la table', async () => {
    const cas = [
      { code: 'invalid_recipient', statut: 400 },
      // Le cas d'origine « téléphone invalide côté service -> 400 », gardé, avec son code désormais.
      { code: 'invalid_phone', statut: 400 },
      { code: 'unknown_contact', statut: 404 },
      { code: 'identity_conflict', statut: 409 },
    ] as const;
    for (const c of cas) {
      const { server } = app({ ecrireFiches: async () => [{ index: 0, status: 'error', code: c.code, reason: 'motif' }] });
      const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(ECRITURE), payload: { externalId: 'crm-7781' } });
      expect(res.statusCode, c.code).toBe(c.statut);
      expect(res.json()).toEqual({ error: 'motif', code: c.code });
      await server.close();
    }
  });
});

describe('POST /v1/contacts/batch', () => {
  it('lot : 200 avec compteurs, un résultat par index', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(ECRITURE), payload: { contacts: [{ phone: '+33611' }, { externalId: 'crm-1' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 2, updated: 0, errors: 0 });
    expect(cap.ecrits[0]!.items).toHaveLength(2);
    await server.close();
  });

  it('conteneur absent, vide, ou au-delà de 500 : 400 `invalid_body`', async () => {
    const { server } = app();
    for (const payload of [{}, { contacts: [] }, { contacts: 'x' }, { contacts: Array.from({ length: 501 }, () => ({ phone: '+33611' })) }]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(ECRITURE), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_body' });
    }
    await server.close();
  });
});

describe('GET /v1/contacts/:contactId', () => {
  it('🔴 avec `contacts:read` : 200 et la fiche, espace issu de la clé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'GET', url: `/v1/contacts/${ID}`, ...auth(LECTURE) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FICHE);
    expect(cap.lus).toEqual([{ tenant: 't1', id: ID }]);
    await server.close();
  });

  it('🔴 une clé qui ÉCRIT sans lire : 403 `missing_scope`', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: `/v1/contacts/${ID}`, ...auth(ECRITURE) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'missing_scope' });
    await server.close();
  });

  it('fiche inconnue : 404 `unknown_contact`', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/v1/contacts/00000000-0000-4000-8000-999999999999', ...auth(LECTURE) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown_contact' });
    await server.close();
  });
});

describe('POST /v1/contacts/search', () => {
  it('🔴 le numéro voyage dans le CORPS ; la réponse est `{ contact }`', async () => {
    const vus: unknown[] = [];
    const { server } = app({ chercherFiche: async (_t, r) => { vus.push(r); return { ok: true, fiche: FICHE }; } });
    const res = await server.inject({ method: 'POST', url: '/v1/contacts/search', ...auth(LECTURE), payload: { phone: '+33612345678' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contact: FICHE });
    expect(vus).toEqual([{ phone: '+33612345678' }]);
    await server.close();
  });

  it('deux clés ou aucune : 400 `invalid_body` ; numéro illisible : 400 `invalid_phone`', async () => {
    const { server } = app({ chercherFiche: async () => ({ ok: false, code: 'invalid_phone', reason: 'illisible' }) });
    for (const payload of [{ phone: '+33612345678', externalId: 'crm-7781' }, {}]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts/search', ...auth(LECTURE), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_body' });
    }
    const illisible = await server.inject({ method: 'POST', url: '/v1/contacts/search', ...auth(LECTURE), payload: { phone: 'n-importe-quoi' } });
    expect(illisible.statusCode).toBe(400);
    expect(illisible.json()).toEqual({ error: 'illisible', code: 'invalid_phone' });
    await server.close();
  });
});

describe('PATCH /v1/contacts/:contactId', () => {
  it('200 `{ contactId }`', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(ECRITURE), payload: { consent: 'opted_out' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contactId: ID });
    await server.close();
  });

  it('🔴 le numéro ne se modifie pas : 400 `invalid_body` qui le dit', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(ECRITURE), payload: { phone: '+33698765432' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; code: string }>()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toMatch(/ne se modifie pas/);
    await server.close();
  });

  it('un refus du service : son code et son statut ; une clé de lecture seule : 403', async () => {
    const { server } = app({ modifierFiche: async () => ({ ok: false, code: 'identity_conflict', reason: 'déjà porté' }) });
    const conflit = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(ECRITURE), payload: { externalId: 'crm-2' } });
    expect(conflit.statusCode).toBe(409);
    expect(conflit.json()).toEqual({ error: 'déjà porté', code: 'identity_conflict' });
    const lecture = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(LECTURE), payload: { name: 'x' } });
    expect(lecture.statusCode).toBe(403);
    await server.close();
  });
});
```

Réécrire `tests/v1-contacts-hostile.test.ts` en GARDANT chacun de ses cas (règle du dépôt : réécrire un test conserve son cas) :

```ts
// tests/v1-contacts-hostile.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { ContactV1 } from '../src/api/contacts-v1';
import { contactsV1Muets } from './aide/contacts-v1';
import { cleApiDeTest } from './aide/cle-api';

/**
 * CE QU'UN CORPS HOSTILE OU MALADROIT PROVOQUE SUR `/v1/contacts`, ET CE QU'IL DOIT PROVOQUER.
 *
 * 🔴 LE CONSTAT DE L'AUDIT DU 2026-09-13 TIENT TOUJOURS : la route castait le lot sans le valider, et quatre
 * gestes ordinaires d'un intégrateur faisaient des dégâts (un `null` emportait le lot en 500, `fields` en
 * chaîne créait un champ par caractère, un objet imbriqué était stocké « [object Object] », un tableau de
 * numéros répondait « téléphone invalide » au lieu de dire que la FORME est fausse).
 *
 * 🔴 CE QUI NE DOIT PAS CHANGER, ET QUI EST LE CONTRAT DE `/v1/contacts/batch` : un conteneur malformé rend 400, mais un
 * ÉLÉMENT malformé rend son erreur À SON INDEX pendant que les autres passent.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() { /* sans objet ici */ }
}

const VALID = cleApiDeTest('valide');

function app() {
  const cap = { calls: [] as Array<{ tenant: string; items: ContactV1[] }> };
  const keys = new FakeApiKeys().add(VALID, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
  // ⚠️ CE FAUX REMPLACE LE SERVICE : il rend « created » pour tout ce qu'il reçoit, donc tout élément hostile
  // qui l'atteindrait produirait un succès, et le test rougirait.
  const contacts = contactsV1Muets({
    ecrireFiches: async (tenant, items) => { cap.calls.push({ tenant, items }); return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` })); },
  });
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts } }), cap };
}
const auth = { headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID}` } };

type Resultat = { results: Array<{ index: number; status: string; code?: string; reason?: string }>; created: number; updated: number; errors: number };
const envoyer = async (contacts: unknown[]) => {
  const { server, cap } = app();
  const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth, payload: { contacts } });
  const corps = res.statusCode === 200 ? res.json<Resultat>() : null;
  await server.close();
  return { code: res.statusCode, corps, recus: cap.calls[0]?.items ?? [] };
};

describe('POST /v1/contacts/batch : les formes hostiles', () => {
  it('🔴 un `null` au milieu du lot n’emporte plus le lot entier', async () => {
    const { code, corps, recus } = await envoyer([{ phone: '+33611' }, null, { phone: '+33622' }]);
    expect(code).toBe(200);
    expect(corps!.errors).toBe(1);
    expect(corps!.created).toBe(2);
    expect(corps!.results.find((r) => r.index === 1)).toMatchObject({ status: 'error', code: 'invalid_body' });
    expect(recus).toHaveLength(2);
    expect(recus.every((i) => typeof i === 'object' && i !== null)).toBe(true);
  });

  it('🔴 `fields` en CHAÎNE est refusé : plus un champ personnalisé par caractère', async () => {
    const { code, corps, recus } = await envoyer([{ phone: '+33611', fields: 'prenom=Marc' }]);
    expect(code).toBe(200);
    expect(corps!.errors).toBe(1);
    expect(corps!.results[0]!.reason).toMatch(/fields/i);
    expect(recus).toHaveLength(0);
  });

  it('🔴 une valeur de `fields` imbriquée est refusée, au lieu d’être stockée « [object Object] »', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', fields: { adresse: { rue: 'x' } } }]);
    expect(corps!.errors).toBe(1);
    expect(corps!.results[0]!.reason).toMatch(/adresse/);
    expect(recus).toHaveLength(0);
  });

  it('🔴 un élément qui est une CHAÎNE dit que la FORME est fausse', async () => {
    const { corps, recus } = await envoyer(['+33612345678', 42, true]);
    expect(corps!.errors).toBe(3);
    for (const r of corps!.results) expect(r.reason).toMatch(/objet/i);
    expect(recus).toHaveLength(0);
  });

  it('une clé de champ démesurée est refusée', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', fields: { ['k'.repeat(500)]: 'v' } }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('un contact qui porte cent champs est refusé', async () => {
    const fields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`champ_${i}`, 'v']));
    const { corps, recus } = await envoyer([{ phone: '+33611', fields }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('une liste d’étiquettes démesurée est refusée', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', tags: Array.from({ length: 5000 }, (_, i) => `t${i}`) }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('⚠️ mais une liste un peu bavarde passe : on refuse le démesuré, pas le verbeux', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', tags: Array.from({ length: 60 }, (_, i) => `t${i}`) }]);
    expect(corps!.errors).toBe(0);
    expect(recus).toHaveLength(1);
  });

  it('⚠️ une clé démesurée ne revient pas EN ENTIER dans la réponse', async () => {
    const { corps } = await envoyer([{ phone: '+33611', fields: { ['k'.repeat(5000)]: 'v' } }]);
    expect(corps!.results[0]!.reason!.length).toBeLessThan(200);
  });

  it('un `consentSource` démesuré est refusé : il justifie un consentement, il ne se tronque pas', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', consent: 'opted_in', consentSource: 'x'.repeat(5000) }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('🔴 l’ancienne clé `optIn` est REFUSÉE en nommant `consent`, plus jamais ignorée en silence', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', optIn: true }]);
    expect(corps!.errors).toBe(1);
    expect(corps!.results[0]!.reason).toMatch(/consent/);
    expect(recus).toHaveLength(0);
  });

  it('un identifiant externe de plus de 512 caractères, ou un `contactId` qui n’est pas un UUID, est refusé', async () => {
    const { corps, recus } = await envoyer([{ externalId: 'x'.repeat(513) }, { contactId: 'c1' }]);
    expect(corps!.errors).toBe(2);
    expect(recus).toHaveLength(0);
  });

  it('🔴 mélange de valides et d’invalides : chaque erreur À SON INDEX, les autres passent', async () => {
    const { code, corps, recus } = await envoyer([
      { phone: '+33611' },
      { phone: '+33622', fields: 'cassé' },
      { phone: '+33633' },
      null,
      { phone: '+33644' },
    ]);
    expect(code).toBe(200);
    expect(corps!.results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(corps!.results.map((r) => r.status)).toEqual(['created', 'error', 'created', 'error', 'created']);
    expect(corps!).toMatchObject({ created: 3, errors: 2, updated: 0 });
    expect(recus.map((i) => i.phone)).toEqual(['+33611', '+33633', '+33644']);
  });
});

describe('POST /v1/contacts/batch : ce qui doit continuer de passer', () => {
  it('un lot normal traverse INCHANGÉ', async () => {
    const { code, corps, recus } = await envoyer([
      { phone: '+33612345678', externalId: 'crm-7781', name: 'Marc', fields: { prenom: 'Marc', ville: 'Lyon' }, tags: ['vip'], consent: 'opted_in', consentSource: 'formulaire' },
      { phone: '+33698765432' },
    ]);
    expect(code).toBe(200);
    expect(corps!).toMatchObject({ created: 2, errors: 0 });
    expect(recus).toHaveLength(2);
    expect(recus[0]).toMatchObject({
      phone: '+33612345678', externalId: 'crm-7781', name: 'Marc', fields: { prenom: 'Marc', ville: 'Lyon' }, tags: ['vip'], consent: 'opted_in', consentSource: 'formulaire',
    });
  });

  it('⚠️ une valeur de champ NUMÉRIQUE ou BOOLÉENNE reste acceptée, convertie en texte', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', fields: { age: 42, vip: true } }]);
    expect(corps!.errors).toBe(0);
    expect(recus[0]!.fields).toEqual({ age: '42', vip: 'true' });
  });

  it('une clé inconnue dans le corps est ignorée, pas refusée', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', internalId: 'abc', extra: { x: 1 } }]);
    expect(corps!.errors).toBe(0);
    expect(recus[0]).not.toHaveProperty('internalId');
  });

  it('une clé vide (variable absente d’un profil) vaut absence, pas erreur', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', externalId: '', bsuid: '  ' }]);
    expect(corps!.errors).toBe(0);
    // ⚠️ `toBeUndefined`, pas `not.toHaveProperty` : zod 4 GARDE la clé, avec la valeur `undefined`, quand un
    // `preprocess` a rendu `undefined` (mesuré sur zod 4.4.3).
    expect(recus[0]!.externalId).toBeUndefined();
    expect(recus[0]!.bsuid).toBeUndefined();
  });

  it('🔴 un consentement vide (même cause) vaut absence : l’élément passe, et le service ne reçoit AUCUN consentement', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', consent: '', consentSource: ' ' }]);
    expect(corps!.errors).toBe(0);
    expect(recus).toHaveLength(1);
    expect(recus[0]!.consent).toBeUndefined();
    expect(recus[0]!.consentSource).toBeUndefined();
  });
});

describe('POST /v1/contacts (unitaire) : la même garde', () => {
  it('🔴 `fields` en chaîne rend 400 `invalid_body`, comme dans le lot (`/v1/contacts/batch`)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth, payload: { phone: '+33611', fields: 'prenom=Marc' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toMatch(/fields/i);
    expect(cap.calls).toHaveLength(0);
    await server.close();
  });

  it('un contact normal passe toujours', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth, payload: { phone: '+33612345678', fields: { prenom: 'Marc' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.calls[0]!.items[0]).toMatchObject({ phone: '+33612345678', fields: { prenom: 'Marc' } });
    await server.close();
  });
});
```

- [ ] **Step 3: Les voir échouer**

Run: `npx vitest run tests/v1-contacts.test.ts tests/v1-contacts-hostile.test.ts`
Expected: FAIL À L'EXÉCUTION (vitest ne vérifie pas les types, aucune erreur de typage n'est donc attendue ici) : les `POST /v1/contacts` et `/batch` bien formés répondent 500 (`deps.upsertContacts is not a function` : l'ancienne route appelle une méthode que le double neuf n'a pas), `GET /v1/contacts/:contactId`, `PATCH` et `POST /v1/contacts/search` rendent le 404 de Fastify (routes absentes), et les corps d'erreur n'ont pas de `code`. Si l'erreur est `Failed to resolve import "./aide/contacts-v1"`, le pas 1 n'est pas fait. Le typage n'a qu'un juge, `npm run typecheck`, au pas 10.

- [ ] **Step 4: `OperationApi` et le droit serveur**

- `src/api/usage-guard.ts`, dans `OperationApi` (l. 22-32), après `| 'contacts.batch'`, ajouter :

```ts
  // Lire une fiche (`GET /v1/contacts/{contactId}`, `POST /v1/contacts/search`) : une unité, et PAS lourde.
  | 'contacts.read'
```

- `src/http/api-keys.ts:17` : `export const VALID_API_SCOPES = ['contacts:write', 'sends:create', 'mcp:read', 'mcp:write'] as const;` devient `export const VALID_API_SCOPES = ['contacts:write', 'contacts:read', 'sends:create', 'mcp:read', 'mcp:write'] as const;`
- `tests/api-usage-guard.test.ts` : dans « le plancher est 1 », ajouter `expect(unitesDe('contacts.read')).toBe(1);` ; dans « seules les écritures de masse sont LOURDES », ajouter `expect(estLourde('contacts.read')).toBe(false);`.

- [ ] **Step 5: Réécrire `src/http/v1-contacts.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { raisonDeValidation } from '../api/contacts-upsert';
import {
  schemaContactV1, schemaPatchContactV1, schemaRechercheContactV1,
  type ContactV1, type ResultatFiche, type ServiceContactsV1,
} from '../api/contacts-v1';
import { refuser, STATUT_PAR_CODE } from '../api/erreurs';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

export interface V1ContactsRouteDeps extends ServiceContactsV1 {
  /**
   * Le garde d'usage, injecté au bootstrap.
   *
   * 🔴 OBLIGATOIRE, comme le pré-filtre des clés : optionnel, il manquerait un jour à une route et le
   * compteur de cette route disparaîtrait sans bruit. Ce qu'on veut voir est précisément ce qu'on oublie.
   */
  usage: ApiUsageGuard;
}

/** Les DEUX gardes : lire une fiche n'est pas écrire, et une clé ne porte que ce qu'on lui a donné. */
export interface GardesContactsV1 {
  ecrire: Guard;
  lire: Guard;
}

const MAX_BATCH = 500;
const conteneurDuLot = z.object({ contacts: z.array(z.unknown()) });

/**
 * LE TRI DU LOT : ce qui est bien formé d'un côté, ce qui ne l'est pas de l'autre, AVEC SON INDEX.
 *
 * 🔴 L'INDEX RENDU EST CELUI DU CORPS ENVOYÉ, jamais celui de la liste filtrée : le service numérote ce
 * qu'IL reçoit, et sans ce report l'erreur de la ligne 3 serait rendue sur la ligne 1.
 * 🔴 ET UN ÉLÉMENT REFUSÉ NE FAIT PAS TOMBER LE LOT : seul un CONTENEUR malformé rend 400.
 */
function trierLeLot(bruts: unknown[]): { valides: Array<{ index: number; contact: ContactV1 }>; refus: ResultatFiche[] } {
  const valides: Array<{ index: number; contact: ContactV1 }> = [];
  const refus: ResultatFiche[] = [];
  bruts.forEach((brut, index) => {
    const r = schemaContactV1.safeParse(brut);
    if (r.success) valides.push({ index, contact: r.data });
    else refus.push({ index, status: 'error', code: 'invalid_body', reason: raisonDeValidation(r.error) });
  });
  return { valides, refus };
}

/**
 * Les routes publiques des FICHES (spec de l'API publique, § 2). L'espace vient à 100 % de `req.auth`, posé
 * par la garde de clé : aucun `:tenantId` dans l'adresse. Toute erreur a la forme `{ error, code }`.
 *
 * ⚠️ `PATCH` compte sous `contacts.upsert` : c'est une écriture d'UNE fiche, du même poids.
 */
export function registerV1Contacts(app: FastifyInstance, deps: V1ContactsRouteDeps, gardes: GardesContactsV1): void {
  const ecrire = { preHandler: gardes.ecrire };
  const lire = { preHandler: gardes.lire };

  app.post('/v1/contacts', ecrire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const valide = schemaContactV1.safeParse(req.body);
    if (!valide.success) return refuser(reply, 400, 'invalid_body', raisonDeValidation(valide.error));
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.upsert')) return reply;
    const [r] = await deps.ecrireFiches(req.auth.tenantId, [valide.data]);
    if (!r) throw new Error('ecrireFiches : aucun résultat pour un élément');
    if (r.status === 'error') return refuser(reply, STATUT_PAR_CODE[r.code] ?? 400, r.code, r.reason);
    return reply.code(200).send({ contactId: r.contactId, status: r.status });
  });

  app.post('/v1/contacts/batch', ecrire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const conteneur = conteneurDuLot.safeParse(req.body);
    if (!conteneur.success || conteneur.data.contacts.length === 0) {
      return refuser(reply, 400, 'invalid_body', '« contacts » : un tableau non vide est attendu');
    }
    const bruts = conteneur.data.contacts;
    if (bruts.length > MAX_BATCH) return refuser(reply, 400, 'invalid_body', `« contacts » : ${MAX_BATCH} éléments au plus par lot`);
    // ⚠️ LE TRAVAIL EST COMPTÉ SUR CE QUE L'APPELANT DEMANDE, pas sur ce qui survit à la validation.
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.batch', bruts.length)) return reply;

    const { valides, refus } = trierLeLot(bruts);
    const ecrits = valides.length === 0
      ? []
      : (await deps.ecrireFiches(req.auth.tenantId, valides.map((v) => v.contact)))
        // Le service numérote SA liste : on reporte chaque résultat sur l'index d'origine.
        .map((r) => ({ ...r, index: valides[r.index]?.index ?? r.index }));
    const results = [...refus, ...ecrits].sort((a, b) => a.index - b.index);
    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    // ⚠️ LES REFUS DE VALIDATION COMPTENT DANS `errors`, comme les refus du service : un seul compteur.
    const errors = results.filter((r) => r.status === 'error').length;
    return reply.code(200).send({ results, created, updated, errors });
  });

  /**
   * 🔴 LE NUMÉRO VOYAGE DANS LE CORPS, JAMAIS DANS L'ADRESSE : `/v1/contacts/+33…` l'inscrirait dans les
   * journaux d'accès du proxy et de Cloudflare.
   */
  app.post('/v1/contacts/search', lire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const valide = schemaRechercheContactV1.safeParse(req.body);
    if (!valide.success) return refuser(reply, 400, 'invalid_body', raisonDeValidation(valide.error));
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.read')) return reply;
    const r = await deps.chercherFiche(req.auth.tenantId, valide.data);
    if (!r.ok) return refuser(reply, 400, r.code, r.reason);
    return reply.code(200).send({ contact: r.fiche });
  });

  app.get<{ Params: { contactId: string } }>('/v1/contacts/:contactId', lire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.read')) return reply;
    const fiche = await deps.lireFiche(req.auth.tenantId, req.params.contactId);
    if (!fiche) return refuser(reply, 404, 'unknown_contact', 'fiche inconnue');
    return reply.code(200).send(fiche);
  });

  app.patch<{ Params: { contactId: string } }>('/v1/contacts/:contactId', ecrire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const valide = schemaPatchContactV1.safeParse(req.body ?? {});
    if (!valide.success) return refuser(reply, 400, 'invalid_body', raisonDeValidation(valide.error));
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.upsert')) return reply;
    const r = await deps.modifierFiche(req.auth.tenantId, req.params.contactId, valide.data);
    if (!r.ok) return refuser(reply, STATUT_PAR_CODE[r.code] ?? 400, r.code, r.reason);
    return reply.code(200).send({ contactId: r.contactId });
  });
}
```

- [ ] **Step 6: Le montage, `src/server.ts:542`**

Relire `git diff origin/main -- src/server.ts` AVANT d'éditer (aucun hunk étranger attendu). Remplacer :

```ts
      registerV1Contacts(app, { ...v1.contacts, usage: usageApi }, [requireApiKey, requireScope('contacts:write')]);
```

par :

```ts
      // DEUX droits, et une clé ne porte que ceux qu'on lui a donnés : lire une fiche (numéro, consentement,
      // joignabilité) n'est pas le droit d'en écrire une, ni l'inverse.
      registerV1Contacts(app, { ...v1.contacts, usage: usageApi }, {
        ecrire: [requireApiKey, requireScope('contacts:write')],
        lire: [requireApiKey, requireScope('contacts:read')],
      });
```

- [ ] **Step 7: Le câblage, `src/index.ts`**

Relire `git diff origin/main -- src/index.ts` AVANT d'éditer ; tout hunk étranger impose la procédure P' au commit.

- l. 38, à côté de l'import de `upsertContactsFromApi` (qui reste : webhook entrant et création à la main), ajouter :

```ts
import { creerServiceContactsV1 } from './api/contacts-v1';
import { PgReachabilityStore } from './rcs/reachability.pg';
import { joignabiliteRcsConnue } from './rcs/reachability';
```

- après `const rcsMediaStore = new PgRcsMediaStore(pool);` (l. 391), ajouter :

```ts
  // Le cache de joignabilité RCS, en LECTURE (fiche de l'API publique). L'envoi a le sien dans `rcsStack`.
  const rcsJoignabilite = new PgReachabilityStore(pool);
```

- l. 3083-3085, remplacer :

```ts
      contacts: {
        upsertContacts: (tenant, items) => upsertContactsFromApi(tenant, items, { contacts: contactStore, fields: fieldStore }),
      },
```

par :

```ts
      // Les fiches de l'API publique : identité multi-clés, consentement journalisé, lecture (spec § 2).
      contacts: creerServiceContactsV1({
        contacts: contactStore,
        fields: fieldStore,
        audit: auditSink,
        joignabiliteRcs: async (tenant, e164) => {
          const agentId = await workflowRuntime.rcsStack.agents.agentIdForTenant(tenant);
          if (!agentId) return null;
          return joignabiliteRcsConnue(await rcsJoignabilite.get(agentId, e164), Date.now());
        },
      }),
```

- commentaires devenus faux : l. 202-204, « Elle couvre par CONSTRUCTION les trois méthodes capables d'écrire `opted_out` (mot-clé entrant, fiche contact, action en masse) » devient « Elle couvre par CONSTRUCTION toutes les méthodes du dépôt capables d'écrire `opted_out` (la liste qui fait foi est dérivée par `tests/optout-poussee.test.ts`) » ; l. 763-764, « l'écriture du contact passe par le MÊME chemin partagé que l'API publique et l'import CSV. » devient « l'écriture du contact passe par `upsertContactsFromApi`, le chemin partagé avec la création à la main de la console. » ; l. 2170, « Création à la main : MÊME upsert que l'API publique et l'import, avec le pays par défaut du tenant. » devient « Création à la main : MÊME upsert que le webhook entrant, avec le pays par défaut du tenant. ».

- [ ] **Step 8: Les autres commentaires qui disaient que l'API passe par l'upsert**

- `src/api/contacts-upsert.ts:133-139` (docblock de `upsertContactsFromApi`) : remplacer « Upsert d'un lot de contacts poussés par l'API (upsert-then, D-3). » par « Upsert d'un lot de contacts désignés par leur NUMÉRO (webhook entrant, création à la main de la console). L'API publique ne passe plus par ici : elle désigne une fiche par plusieurs clés (`src/api/contacts-v1.ts`). ».
- `src/http/contacts.ts:87-88` : « Délègue au MÊME upsert que l'API publique et l'import : un second chemin de création divergerait sur la normalisation du numéro, l'opt-in ou les champs. » devient « Délègue au MÊME upsert que le webhook entrant, dont la préparation des champs est aussi celle de l'API publique : un second chemin divergerait sur la normalisation du numéro, l'opt-in ou les champs. ».
- `src/http/contacts.ts:535-536` : « Seul chemin capable de poser `opted_out` : l'import et l'API publique ne font jamais régresser un statut. C'est donc ici qu'un « ne m'envoyez plus rien » devient exécutoire pour les campagnes. » devient « L'import ne fait jamais régresser un statut : c'est ici, sur la fiche, par le mot-clé entrant ou par l'API publique (`consent`) qu'un « ne m'envoyez plus rien » devient exécutoire pour les campagnes. ».
- `src/webhook-entrant/mapping.ts:70-71` : « c'est `upsertContactsFromApi` qui les fait, comme pour l'API publique et l'import. */ » devient « c'est `upsertContactsFromApi` qui les fait (sa préparation des champs est aussi celle de l'API publique). */ ».
- `tests/api-contacts-upsert.test.ts:8` : « Le CHEMIN D'ÉCRITURE PARTAGÉ (API publique, import de liste, webhook entrant). » devient « Le CHEMIN D'ÉCRITURE PAR NUMÉRO (webhook entrant, création à la main de la console). ».
- `src/http/webhook-entrant.ts:53-55` (docblock d'`ecrireContact`), remplacer les trois lignes par :

```ts
   * Écrit le contact par le CHEMIN PARTAGÉ (`upsertContactsFromApi`) : mêmes règles que la création à la main
   * de la console ; sa préparation des champs (`preparateurDeChamps`) est aussi celle de l'API publique. Le
   * redériver ici créerait un second contact pour la même personne le jour où l'une des deux versions changerait.
```

- `src/api/usage-guard.ts:106-107` (docblock d'`entrerLourde`) : « API**, et `upsertContactsFromApi` en demande jusqu'à 4 par requête. Rien ne comptait les requêtes » devient, sur deux lignes : « API**, et `ecrireFiches` (`src/api/contacts-v1.ts`, le chemin de `/v1/contacts/batch`) en demande jusqu'à » puis « `ECRITURES_EN_VOL` à la fois par requête. Rien ne comptait les requêtes » (la suite du paragraphe, « lourdes EN VOL : dix lots… », reste vraie).
- `src/api/usage-guard.ts:148` : « 🔴 POINT DE PASSAGE UNIQUE DES SIX ROUTES. Recopié six fois, le couple « compter puis refuser » » devient « 🔴 POINT DE PASSAGE UNIQUE DES ROUTES PUBLIQUES. Recopié dans chacune, le couple « compter puis refuser » ». Le compte des routes ne s'écrit pas en prose : il bouge à chaque lot qui ajoute une route, celui-ci compris.
- `src/api/usage-guard.ts:187-188` : « 🔴 ELLE EXISTE PARCE QUE LES SIX ROUTES RECOPIAIENT LE MÊME OBJET (relevé en revue), dont le repli » devient « 🔴 ELLE EXISTE PARCE QUE LES ROUTES PUBLIQUES RECOPIAIENT LE MÊME OBJET (relevé en revue), dont le repli », et « `req.apiKeyId ?? 'inconnue'`. Six copies d'un repli, c'est six endroits où il peut diverger, et surtout » devient « `req.apiKeyId ?? 'inconnue'`. Une copie du repli par route, c'est autant d'endroits où il peut diverger, et surtout ».

- [ ] **Step 9: Les tests qui montent `/v1` avec l'ancienne dépendance**

Ajouter `import { contactsV1Muets } from './aide/contacts-v1';` dans chacun, puis :
- `tests/api-usage-observation.test.ts` : l. 62 (le `upsertContacts` qui rend un « créé » par élément), l. 192, 212, 230 et 254 (ceux qui rendent `[{ index: 0, ... }]`) deviennent tous `contacts: contactsV1Muets()` (le double rend déjà un « créé » par élément). Les deux doubles qui ATTENDENT `enVol` (l. 282-287 sur plusieurs lignes, l. 347 sur une) deviennent :

```ts
        contacts: contactsV1Muets({
          ecrireFiches: async (_t, items) => {
            await enVol;
            return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` }));
          },
        }),
```

- `tests/api-usage-observation.test.ts`, 🔴 LE SEUL TEST QUI PROUVE QUE CHAQUE ROUTE PUBLIQUE COMPTE : il doit voir les trois routes neuves, sinon une route qui oublierait `compterOuRefuser` resterait verte.
  - l. 56 (`monter`) : la clé porte aussi la lecture, `scopes: ['contacts:write', 'sends:create']` devient `scopes: ['contacts:write', 'contacts:read', 'sends:create']`.
  - l. 84-107 : le cas « les six routes comptent » devient :

```ts
  it('🔴 chaque route publique compte, sous son opération', async () => {
    const { server, usage } = monter();
    const FICHE = '00000000-0000-4000-8000-000000000001';

    await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });
    await server.inject({ method: 'POST', url: '/v1/contacts/batch', headers: entetes, payload: { contacts: [{ phone: '+33612345678' }, { phone: '+33698765432' }] } });
    // Les routes de fiche : une lecture, une recherche (le double ne trouve rien, la route compte quand même),
    // une modification.
    await server.inject({ method: 'GET', url: `/v1/contacts/${FICHE}`, headers: entetes });
    await server.inject({ method: 'POST', url: '/v1/contacts/search', headers: entetes, payload: { phone: '+33612345678' } });
    await server.inject({ method: 'PATCH', url: `/v1/contacts/${FICHE}`, headers: entetes, payload: { name: 'Camille' } });
    await server.inject({
      method: 'POST', url: '/v1/sends',
      headers: { ...entetes, 'idempotency-key': 'idem-1' },
      payload: { category: 'utility', target: { scenario: 'inconnu' }, recipients: [{ phone: '+33612345678' }, { phone: '+33698765432' }, { phone: '+33755667788' }] },
    });
    await server.inject({ method: 'GET', url: '/v1/sends/send-inconnu', headers: entetes });
    await server.inject({ method: 'POST', url: '/mcp', headers: entetes, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    await server.inject({ method: 'GET', url: '/mcp', headers: entetes });

    const parOperation = Object.fromEntries(usage.compteurs().map((c) => [c.operation, c]));
    expect(Object.keys(parOperation).sort()).toEqual(
      ['contacts.batch', 'contacts.read', 'contacts.upsert', 'mcp.call', 'mcp.refus', 'sends.create', 'sends.read'],
    );
    // 🔴 LE TRAVAIL, PAS L'APPEL : un lot de 2 contacts coûte 2, un envoi de 3 destinataires coûte 3.
    expect(parOperation['contacts.batch']).toMatchObject({ appels: 1, unites: 2 });
    expect(parOperation['sends.create']).toMatchObject({ appels: 1, unites: 3 });
    // `POST /v1/contacts` et `PATCH` : deux écritures d'UNE fiche, sous la même opération.
    expect(parOperation['contacts.upsert']).toMatchObject({ appels: 2, unites: 2 });
    // `GET` et `search` : deux lectures, une unité chacune.
    expect(parOperation['contacts.read']).toMatchObject({ appels: 2, unites: 2 });
    await server.close();
  });
```

  - Les libellés qui comptaient les routes perdent leur nombre (il bouge à chaque lot) : l. 12 « ce que les six routes publiques comptent » devient « ce que les routes publiques comptent » ; l. 22 « ⚠️ LES SIX ROUTES SONT EXERCÉES POUR DE VRAI » devient « ⚠️ LES ROUTES SONT EXERCÉES POUR DE VRAI » ; l. 179 « rouvrir les six routes, » devient « rouvrir chaque route, » ; l. 183 « un double maison suffit aux six routes : » devient « un double maison suffit à toutes les routes : ».
  - Vérifier dans les deux sens, au pas 11 (point 3).
- `tests/http-mba-relais.test.ts:74` : `contacts: { upsertContacts: ... },` devient `contacts: contactsV1Muets(),`.
- `tests/api-arret-urgence.test.ts:44` : `contacts: { upsertContacts: async () => [...] },` devient `contacts: contactsV1Muets(),`.
- `tests/mcp-serveur.test.ts:75`, `tests/v1-messages.test.ts:78`, `tests/v1-sends.test.ts:67` : `contacts: { upsertContacts: async () => [] }` devient `contacts: contactsV1Muets()`.
- `tests/api-garde-codes.test.ts` ne monte pas `/v1` : rien à faire.

- [ ] **Step 10: Le voir passer**

Run: `npx vitest run tests/v1-contacts.test.ts tests/v1-contacts-hostile.test.ts tests/api-usage-observation.test.ts tests/api-usage-guard.test.ts tests/http-mba-relais.test.ts tests/api-arret-urgence.test.ts tests/mcp-serveur.test.ts tests/v1-messages.test.ts tests/v1-sends.test.ts tests/scope-tenant.test.ts && npm run typecheck && npm test && npm run auto-attaque`
Expected: PASS partout. `npm run auto-attaque` attaque les routes neuves avec une clé inventée (sonde de la classe `cle-api`) : zéro trouvaille. Une erreur hors du périmètre du lot se vérifie dans un fichier d'une autre session avant de conclure à une régression.

- [ ] **Step 11: Vérifier dans les deux sens**

Les points 1 et 2 AFFAIBLISSENT une garde et une validation sur des routes montées, dans un arbre partagé (quatrième annonce des contraintes globales) : les ANNONCER aux autres sessions (`ListAgents`, `SendMessage` : « je mute pour quelques minutes la garde de lecture de `/v1/contacts` dans `src/server.ts` et la validation du lot dans `src/http/v1-contacts.ts` ; ne construisez pas d'image depuis l'arbre d'ici là »), puis annoncer la fin, restauration PROUVÉE.

1. Dans `src/server.ts`, donner à `lire` le même droit que `ecrire` (`requireScope('contacts:write')`) : « une clé qui ÉCRIT sans lire : 403 » et « avec `contacts:read` : 200 » échouent. Restaurer, puis PROUVER la restauration par comparaison : `git diff origin/main -- src/server.ts` ne montre QUE le hunk voulu du pas 6 (le montage à deux gardes, `lire: [requireApiKey, requireScope('contacts:read')]`), et `grep -c "requireScope('contacts:read')" src/server.ts` rend 1.
2. Dans `trierLeLot`, remplacer `schemaContactV1.safeParse(brut)` par un passage sans validation (`{ success: true, data: brut as ContactV1 }`) : les cas hostiles échouent (le service reçoit le `null` et la chaîne). Restaurer, puis PROUVER la restauration : `grep -c 'schemaContactV1.safeParse(brut)' src/http/v1-contacts.ts` rend 1 et `grep -c 'as ContactV1' src/http/v1-contacts.ts` rend 0.
3. Dans la route `GET /v1/contacts/:contactId`, retirer la ligne `if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.read')) return reply;` : « chaque route publique compte, sous son opération » échoue (`contacts.read` à 1 appel au lieu de 2). Restaurer, revoir le vert.

- [ ] **Step 12: Commit (procédure P ; P' pour `src/index.ts` si un hunk étranger y est)**

Relire `git diff origin/main -- src/server.ts src/index.ts` DANS le même appel que la construction du commit. Chemins : `src/http/v1-contacts.ts src/api/usage-guard.ts src/http/api-keys.ts src/server.ts src/index.ts src/api/contacts-upsert.ts src/http/contacts.ts src/webhook-entrant/mapping.ts src/http/webhook-entrant.ts tests/aide/contacts-v1.ts tests/v1-contacts.test.ts tests/v1-contacts-hostile.test.ts tests/api-usage-observation.test.ts tests/api-usage-guard.test.ts tests/http-mba-relais.test.ts tests/api-arret-urgence.test.ts tests/mcp-serveur.test.ts tests/v1-messages.test.ts tests/v1-sends.test.ts tests/api-contacts-upsert.test.ts`. Message : `feat(api): les fiches de l API publique (POST, batch, GET, search, PATCH) et le droit contacts:read`. Prévenir les autres sessions de la poussée (fichiers de câblage touchés). Lire le run job par job, `integration` compris.

---

### Task 11: Le droit `contacts:read` dans la console

🔴 **À pousser APRÈS le déploiement de l'API** (section Déploiement) : Vercel publie la console à chaque push, et une clé créée avec `contacts:read` avant que l'API connaisse ce droit rendrait 400 « scope(s) inconnu(s) ».

**Files:**
- Modify: `web/lib/api/integrations.ts:16-17` (`API_SCOPES`)
- Modify: `web/app/developers/keys/page.tsx:6` (import) et `:45-50` (`SCOPE_LABEL`)
- Test: `tests/api-droits-parite.test.ts`

**Interfaces:**
- Consumes: `VALID_API_SCOPES` (Task 10).
- Produces: `API_SCOPES = ['contacts:write', 'contacts:read', 'sends:create', 'mcp:read', 'mcp:write']` ; `API_SCOPES_PAR_DEFAUT` inchangé.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/api-droits-parite.test.ts
import { describe, it, expect } from 'vitest';
import { VALID_API_SCOPES } from '../src/http/api-keys';
import { API_SCOPES, API_SCOPES_PAR_DEFAUT } from '../web/lib/api/integrations';

/**
 * LES DROITS D'UNE CLÉ D'API, DES DEUX CÔTÉS (spec de l'API publique, § 10).
 *
 * 🔴 LA LISTE VIT EN DEUX ENDROITS : l'écran qui propose les cases, le serveur qui accepte les droits. Un
 * écran qui propose un droit que le serveur refuse rend 400 à la création ; un droit que l'écran ne propose
 * pas n'est attribuable par personne. Le commentaire « doit rester aligné » ne tenait rien : ce test, si.
 */
describe('parité des droits d’une clé d’API', () => {
  it('🔴 l’écran propose EXACTEMENT les droits que le serveur accepte', () => {
    expect([...API_SCOPES].sort()).toEqual([...VALID_API_SCOPES].sort());
  });

  it('⚠️ lire les fiches n’est pas coché d’avance : ce sont des données personnelles, on le choisit', () => {
    expect(API_SCOPES_PAR_DEFAUT).not.toContain('contacts:read');
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `npx vitest run tests/api-droits-parite.test.ts`
Expected: FAIL, `contacts:read` présent côté serveur, absent de l'écran.

- [ ] **Step 3: L'écran**

- `web/lib/api/integrations.ts:16-17` :

```ts
/** Droits reconnus. La parité avec `VALID_API_SCOPES` (`src/http/api-keys.ts`) est tenue par `tests/api-droits-parite.test.ts`. */
export const API_SCOPES = ['contacts:write', 'contacts:read', 'sends:create', 'mcp:read', 'mcp:write'] as const;
```

- `web/app/developers/keys/page.tsx:6` : ajouter `type ApiScope` à l'import depuis `@/lib/api`.
- `web/app/developers/keys/page.tsx:45-50`, remplacer `SCOPE_LABEL` par :

```tsx
  // Typé sur `ApiScope` : un droit ajouté à la liste sans libellé ne compile pas.
  const SCOPE_LABEL: Record<ApiScope, string> = {
    'contacts:write': t('Créer et mettre à jour des contacts', 'Create and update contacts'),
    'contacts:read': t('Lire les contacts', 'Read contacts'),
    'sends:create': t('Déclencher des envois', 'Trigger sends'),
    'mcp:read': t('MCP : lire les conversations et les contacts', 'MCP: read conversations and contacts'),
    'mcp:write': t('MCP : répondre, taguer, affecter', 'MCP: reply, tag, assign'),
  };
```

- [ ] **Step 4: Le voir passer**

Run: `npx vitest run tests/api-droits-parite.test.ts && npm run typecheck && cd web && npx tsc --noEmit`
Expected: PASS, les deux typechecks sans erreur.

- [ ] **Step 5: Vérifier dans les deux sens**

Retirer `'contacts:read'` de `API_SCOPES` : le test de parité échoue, et `cd web && npx tsc --noEmit` signale la clé en trop dans `SCOPE_LABEL`. Restaurer, revoir le vert.

- [ ] **Step 6: Commit (procédure P), APRÈS le déploiement de l'API**

Chemins : `web/lib/api/integrations.ts web/app/developers/keys/page.tsx tests/api-droits-parite.test.ts`. Message : `feat(console): le droit contacts:read a la creation d une cle d API`. Lire les deux runs (`ci.yml` et `ci-web.yml`).

---

### Task 12: L'identifiant API et l'identifiant externe sur la fiche du mini-CRM

**Files:**
- Modify: `web/lib/api/contacts.ts:14-38` (`Contact`)
- Modify: `web/components/ContactDetail.tsx:195-199` (état) et, dans la grille `fiche-champs-base`, juste avant la ligne `{t('Consentement', 'Consent')}`
- Test: `web/e2e/contact-identifiant-api.spec.ts`

**Interfaces:**
- Consumes: `ContactRow.externalId` rendu par la console (Task 4).
- Produces: `Contact.externalId?: string | null` ; `data-testid` `fiche-identifiant-api`, `fiche-copier-identifiant`, `fiche-identifiant-externe`.

- [ ] **Step 1: Écrire le test e2e qui échoue**

```ts
// web/e2e/contact-identifiant-api.spec.ts
import { test, expect } from '@playwright/test';
import { TREIZE_POUCES } from './aide/largeur';

/**
 * L'IDENTIFIANT DE FICHE SUR LA FICHE DU MINI-CRM (spec de l'API publique, § 10).
 *
 * 🔴 C'EST LA VALEUR QUE L'API APPELLE `contactId` : un intégrateur qui cherche « quel identifiant passer ? »
 * doit la trouver là où il regarde la personne, et la copier sans la ressaisir. L'identifiant externe
 * s'affiche quand il existe, et sa ligne DISPARAÎT quand il n'existe pas (une ligne vide se lirait « à
 * remplir », alors qu'il ne se remplit que par l'API).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const BASE = { bsuid: null, optInStatus: 'opted_in', tags: [], fields: {}, createdAt: '2026-01-01T00:00:00Z', whatsappJoignable: null, whatsappJoignableLe: null };
const AVEC = { ...BASE, id: '5f0c1b2e-7d4a-4c8e-9b1a-2f3e4d5c6b7a', profileName: 'Camille Externe', phoneE164: '+33600000011', externalId: 'crm-7781' };
const SANS = { ...BASE, id: '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d', profileName: 'Bruno Interne', phoneE164: '+33600000012', externalId: null };
const CONTACTS = [AVEC, SANS];

async function mock(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/contacts')) return json({ contacts: CONTACTS, total: CONTACTS.length });
    if (chemin.endsWith('/user-fields')) return json({ fields: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Fiche contact : identifiant API et identifiant externe', () => {
  test.use({ viewport: TREIZE_POUCES, permissions: ['clipboard-read', 'clipboard-write'] });

  test('🔴 la fiche montre l’identifiant que l’API appelle contactId, et le copie', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Camille Externe').first().click();
    await expect(page.getByTestId('fiche-identifiant-api')).toHaveText(AVEC.id);
    await page.getByTestId('fiche-copier-identifiant').click();
    await expect(page.getByTestId('fiche-copier-identifiant')).toHaveText('Copié');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(AVEC.id);
  });

  test('l’identifiant externe s’affiche quand la fiche en porte un', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Camille Externe').first().click();
    await expect(page.getByTestId('fiche-identifiant-externe')).toHaveText('crm-7781');
  });

  test('⚠️ une fiche sans identifiant externe n’affiche pas de ligne vide', async ({ page }) => {
    await mock(page);
    await page.goto('/contacts');
    await page.getByText('Bruno Interne').first().click();
    await expect(page.getByTestId('fiche-identifiant-api')).toHaveText(SANS.id);
    await expect(page.getByTestId('fiche-identifiant-externe')).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Le voir échouer (annoncer la suite e2e aux autres sessions avant)**

Run: `cd web && npx playwright test e2e/contact-identifiant-api.spec.ts`
Expected: FAIL, `fiche-identifiant-api` introuvable. ⚠️ Deux suites e2e concurrentes empoisonnent `web/.next` (`ENOENT`, puis « Timed out waiting 180000ms from config.webServer ») : la sortie est `rm -rf web/.next` PUIS `npm run build` à la main dans `web/`.

- [ ] **Step 3: Le type `Contact`**

Dans `web/lib/api/contacts.ts`, après `bsuid: string | null;` (l. 18) :

```ts
  /**
   * L'identifiant de l'outil du client, posé par l'API publique (`externalId`). `null` ou absent = aucun.
   * Il sert à retrouver la fiche, jamais d'adresse d'envoi.
   */
  externalId?: string | null;
```

- [ ] **Step 4: La fiche**

Dans `web/components/ContactDetail.tsx`, après `const [newTag, setNewTag] = useState('');` (l. 199) :

```tsx
  // « Copié » pendant deux secondes : sans retour, on reclique en croyant que rien ne s'est passé.
  const [idCopie, setIdCopie] = useState(false);
```

Dans la grille `fiche-champs-base`, juste AVANT `<span className="text-ink-400">{t('Consentement', 'Consent')}</span>`, insérer :

```tsx
          {/* L'IDENTIFIANT API : la valeur que l'API publique appelle `contactId` (spec du 2026-09-24, § 10).
              Toujours affiché, avec un bouton Copier : c'est ce qu'un intégrateur vient chercher ici. */}
          <span className="text-ink-400">{t('Identifiant API', 'API ID')}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span data-testid="fiche-identifiant-api" className="truncate font-mono text-xs text-ink-900" title={t('La valeur que l’API appelle « contactId ».', 'The value the API calls “contactId”.')}>
              {contact.id}
            </span>
            <button
              type="button"
              data-testid="fiche-copier-identifiant"
              onClick={() => {
                void navigator.clipboard?.writeText(contact.id)
                  .then(() => { setIdCopie(true); setTimeout(() => setIdCopie(false), 2000); })
                  .catch(() => {});
              }}
              className="shrink-0 text-xs text-brand-600 underline decoration-dotted transition hover:text-brand-700"
            >
              {idCopie ? t('Copié', 'Copied') : t('Copier', 'Copy')}
            </button>
          </span>
          {/* L'IDENTIFIANT EXTERNE n'apparaît que s'il existe : il ne se remplit que par l'API, une ligne vide
              se lirait « à remplir ». */}
          {contact.externalId ? (
            <>
              <span className="text-ink-400">{t('Identifiant externe', 'External ID')}</span>
              <span data-testid="fiche-identifiant-externe" className="break-all font-mono text-xs text-ink-900" title={t('L’identifiant de cette personne dans l’outil qui appelle l’API.', 'This person’s identifier in the tool that calls the API.')}>
                {contact.externalId}
              </span>
            </>
          ) : null}
```

- [ ] **Step 5: Le voir passer**

Run: `cd web && npx tsc --noEmit && npx playwright test e2e/contact-identifiant-api.spec.ts e2e/contact-joignabilite.spec.ts e2e/inbox-fiche-contact.spec.ts e2e/contacts-suppression-consentement.spec.ts`
Expected: PASS. Les trois spécifications voisines ouvrent la même fiche avec des contacts SANS `externalId` : elles prouvent que rien n'a bougé pour eux.

- [ ] **Step 6: Vérifier dans les deux sens**

Remplacer `{contact.externalId ? (` par `{true ? (` : le troisième cas échoue (une ligne vide `fiche-identifiant-externe` apparaît). Restaurer, revoir le vert.

- [ ] **Step 7: Commit (procédure P)**

Chemins : `web/lib/api/contacts.ts web/components/ContactDetail.tsx web/e2e/contact-identifiant-api.spec.ts`. Message : `feat(console): l identifiant API et l identifiant externe sur la fiche du mini-CRM`. (Ne dépend d'aucune route neuve : l'identifiant de fiche existe déjà, l'identifiant externe reste masqué tant que l'API ne le rend pas.)

---

### Task 13: La documentation de l'état actuel

**Files:**
- Modify: `documentation.md:647-655` (section « Contacts ») et `:1497-1540` (table « Modules partagés », Backend)
- Modify: `todo.md:1730-1752` (procédure P')

**Interfaces:**
- Consumes: tout le lot.
- Produces: rien de code.

- [ ] **Step 1: `documentation.md`, section « Contacts »**

Après la puce qui décrit la table `contacts` (« `fields jsonb` (merge qui n'écrase jamais une clé absente) … », l. 649-650), ajouter :

```md
- 🔴 **L'API publique désigne une personne par sa FICHE, et UNE fonction la trouve** : `resoudreFiche`
  (`src/api/fiche.ts`). Quatre clés, `contactId`, `externalId`, `phone`, `bsuid` : toutes celles qu'on donne
  doivent désigner la même fiche (sinon `identity_conflict`, et rien n'est écrit) ; une clé que la fiche ne
  porte pas encore lui est RATTACHÉE, jamais substituée ; `contactId` ne crée jamais rien. Elle rend une
  fiche, jamais une adresse : l'adresse d'envoi se calcule sur la fiche. `contacts.external_id` est unique
  PAR ESPACE (index partiel `contacts_tenant_external_id_uidx`), et la purge l'efface avec le numéro.
  ⚠️ Rattacher un numéro à une fiche qui n'avait qu'un BSUID change son adresse WhatsApp (`waIdOf` préfère
  le numéro).
- 🔴 **L'API écrit champs, étiquettes et nom par `editerFicheApi`, jamais par `applyEdits`** : une requête
  filtrée par `deleted_at is null`, sans transaction ni client dédié. Une fiche purgée entre la résolution et
  l'écriture n'est donc pas réécrite (`unknown_contact`), et un lot ne retient pas une connexion par élément.
  `applyEdits` (la fiche de la console) verrouille sans ce filtre.
- 🔴 **Un consentement posé par l'API passe par `ecrireConsentementParId`**, qui n'écrit RIEN quand la valeur
  ne change pas : un outil qui renvoie `opted_out` à chaque appel ne repousse pas la date du désabonnement et
  n'écrit pas une ligne d'audit par appel. L'opt-out s'annonce au connecteur du client comme sur les autres
  chemins, et l'audit porte `contact.optin` ou `contact.optout` avec la source `api`.
```

- [ ] **Step 2: `documentation.md`, « Modules partagés » (Backend)**

Après la ligne de `src/crm/identity.ts`, ajouter :

```md
| `src/api/fiche.ts` -> `resoudreFiche` | 🔴 trouver la fiche d'une personne à partir des clés reçues par l'API publique. Une seconde résolution divergerait sur la règle multi-clés, et une personne aurait deux fiches |
| `src/api/consentement.ts` -> `appliquerConsentement` | le consentement écrit par une machine, et sa ligne d'audit |
| `src/api/erreurs.ts` | `STATUT_PAR_CODE` et `refuser` : la forme `{ error, code }` de toute erreur de l'API publique |
```

- [ ] **Step 3: `todo.md`, l'entrée qui se ferme (procédure P')**

Retirer la section entière « ## L'API publique v1 ne sait pas dire « désabonné » (reste du 5.1, 2026-08-29) », de son titre jusqu'au paragraphe « **Ce n'est pas une brèche de conformité** … C'est un trou d'intégration. » inclus : `consent: "opted_out"` sur `POST` et `PATCH /v1/contacts` en est la réponse, avec la seconde écriture et l'audit qu'elle demandait. Le récit daté se fait par `/sync` en fin de session (`docs/JOURNAL-TECHNIQUE.md`).

- [ ] **Step 4: Vérifier le texte**

Run: `cd /c/Users/julie/messagingme-mba && git diff origin/main -- documentation.md | LC_ALL=C.UTF-8 grep -nP '^\+.*[\x{2013}\x{2014}]'; echo "tirets longs ajoutés : code $?"; npm test`
Expected: le `grep` ne sort AUCUNE ligne et rend le code 1 (aucune ligne AJOUTÉE ne porte de tiret cadratin ni demi-cadratin). `todo.md` n'est pas balayé ici : ce lot n'y ajoute aucune ligne (il retire une section), et son diff porte les hunks d'autres sessions, qui rendraient un faux positif. `npm test` vert (des tests lisent des fichiers de doc). ⚠️ `LC_ALL=C.UTF-8` est obligatoire sous Git Bash : sans lui, `grep -P` refuse `\x{2014}` (« character value in \x{} or \o{} is too large ») et le contrôle ne vérifie rien.

- [ ] **Step 5: Commit (procédure P, P' pour `todo.md`)**

Chemins : `documentation.md todo.md`. Message : `docs: l identite des fiches de l API publique, et l entree desabonnement qui se ferme`.

---

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Deux oui en haut des quatre questions : la production emprunte ce chemin (les `select` de la liste et de la fiche du mini-CRM, `findByPhone` qui sert l'API d'envoi et le serveur MCP, et une écriture de consentement qui s'annonce au connecteur du client, donc un refus qui part chez un tiers ne se rappelle pas), et le code touché porte des invariants invisibles (l'upsert qui ne sait que promouvoir, l'index partiel de chaque identité, la date d'un désabonnement qui suit le statut, l'annonce APRÈS l'écriture, le plafond de champs compté sur un cache vivant). Les critères sont testables, mais la moitié ne se voit qu'avec une base, donc en CI. `/revue` après chaque tâche de code, `/revue-finale` avant la migration puis avant le déploiement. Et aucune de ces vérifications ne remplace l'essai réel qui clôt le lot, décrit juste en dessous : une vraie clé, en production, sur le numéro d'essai, en regardant la console.

## Essai réel qui clôt le lot

Avec une VRAIE clé, en production, sur le numéro d'essai, en regardant la console (repris du § 14 de la spec, pas 1 et 5, pour ce que ce lot livre) :

1. Dans Developers > Clés d'API, créer une clé avec `contacts:write` ET `contacts:read` (la case « Lire les contacts » existe et n'est pas cochée d'avance). Puis, avec une clé qui n'a que `contacts:write`, `GET /v1/contacts/<id>` rend 403 `missing_scope`.
2. `GET` d'abord la fiche du numéro d'essai (par `POST /v1/contacts/search` `{ "phone": "<numéro d'essai>" }`) et NOTER son consentement.
3. `POST https://api.messagingme.app/v1/contacts` `{ "phone": "<numéro d'essai>", "externalId": "essai-lot1-<date>", "name": "Essai lot 1" }` : 200 et un `contactId`. Puis `GET /v1/contacts/<contactId>`, `search` par numéro, `search` par `externalId` : la MÊME fiche, et ce `contactId` est celui qu'affiche la fiche du mini-CRM sous « Identifiant API », avec « Identifiant externe » à `essai-lot1-<date>` ; le bouton Copier copie la bonne valeur.
4. `POST /v1/contacts` `{ "externalId": "essai-lot1-<date>", "fields": { "ville": "Lyon" } }` : 200 `updated`, même `contactId`, la ville apparaît sur la fiche.
5. `POST /v1/contacts` `{ "externalId": "essai-lot1-<date>", "phone": "<numéro d'une AUTRE fiche de l'espace>" }` : 409 `identity_conflict`, et aucune des deux fiches n'a bougé.
6. `PATCH /v1/contacts/<contactId>` `{ "consent": "opted_out" }` : 200 ; `GET` rend `consent.status = opted_out` avec `optedOutAt` ; la ligne `contact.optout` (source `api`) est dans Sécurité > Journal des actions ; un second `PATCH` identique ne crée PAS de seconde ligne et ne change pas `optedOutAt`.
7. Remettre le consentement du numéro d'essai à la valeur notée au pas 2 (`PATCH` `consent`) ; s'il était `unknown`, le dire à Julien, qui choisit (aucun chemin ne réécrit « inconnu »).

La preuve « un envoi est ensuite écarté `opted_out` » appartient au lot 2 (envois refondus).

## Rayon de souffle

Repris du § 17 de la spec et complété par la lecture du code :

- **`upsertContactsFromApi`** quitte `/v1` et garde ses appelants : le webhook entrant (`src/index.ts`, `ecrireContact`) et la création à la main de la console (`createOneContact`). Sa préparation des champs est EXTRAITE sans changement (`preparateurDeChamps`) ; `tests/api-contacts-upsert.test.ts` et `tests/api-champs-bornes.test.ts` en sont les témoins. `schemaContactApi` reste la source du type `ApiContactInput`, que ces appelants construisent encore avec `optIn`. Les commentaires qui disaient que l'API passe par l'upsert sont corrigés (Task 10, pas 7 et 8).
- **`ContactRow.externalId`** : ajouté aux `select` de `findByPhone`, `getById` (donc `applyEdits`, la fiche de la console) et `query` (la liste du mini-CRM, `chercherContacts` du serveur MCP). Le serveur MCP projette par `contactPublic` et n'expose donc rien de plus. `findContactByPhone` de `/v1/sends` ne lit que l'`id`. 🔴 Ces lectures échoueraient en `42703` sans la colonne : la migration passe en production AVANT le push de la Task 4.
- **La purge** remet `external_id` à `null` : sinon l'identifiant du client survivrait à l'effacement et bloquerait la recréation d'une fiche (index unique par espace).
- **`tests/optout-poussee.test.ts`** dérive les méthodes qui posent `opt_out_at = now()` : la nouvelle y entre, avec la preuve qu'elle annonce APRÈS l'écriture. Les docblocks qui comptaient « trois méthodes » (constructeur du dépôt, `src/index.ts`) et « le SEUL chemin » (`BulkEdits`, `src/http/contacts.ts`) sont réécrits sans compte.
- **La garde commune** (`makeRequireApiKey`, `requireScope`, `compterOuRefuser`) sert `/v1`, `/mcp` et le relais de l'agent de Meta : chacun gagne un `code`, sans changer ni statut ni en-tête. `consommerAvecEntetes` et `consommerEnSilence` servent AUSSI la console, les webhooks entrants et les rappels RCS : le code y est un paramètre facultatif qu'ils ne passent pas (`tests/rate-limit-utilisateur.test.ts` affirme `toEqual({ error })` et doit rester vert).
- **`registerV1Contacts`** change de signature (deux gardes) : seul `src/server.ts` l'appelle. **`V1ContactsRouteDeps`** change de forme : les tests qui montent `/v1` passent par `contactsV1Muets` ; `scripts/auto-attaque.mts` monte `v1` sur un mandataire (`inconnu('v1')`) et attaque les routes neuves sans rien changer.
- **`OperationApi`** gagne `contacts.read` : `/ops/usage` le montre ; ce n'est pas une opération lourde. `tests/api-usage-observation.test.ts`, le seul qui prouve que chaque route publique compte, exerce les trois routes neuves ; les libellés et docblocks qui comptaient « six routes » (ce test, `src/api/usage-guard.ts`) perdent leur nombre, et le docblock de la place lourde cite `ecrireFiches` au lieu de `upsertContactsFromApi`.
- **Une chaîne vide vaut absence** aussi pour `name`, `consent` et `consentSource` : un outil qui envoie `consent: ""` (variable de profil absente) voit l'élément passer SANS consentement, au lieu d'un refus de l'élément entier ; sur `PATCH`, `name: ""` ne vide pas le nom, seul `null` le fait.
- **`VALID_API_SCOPES` et `API_SCOPES`** : un test de parité naît ; `tests/mcp-serveur.test.ts` (chaque droit d'outil est attribuable) n'est pas touché ; `API_SCOPES_PAR_DEFAUT` ne coche pas la lecture.
- **La page Documentation API** (`web/app/developers/api/page.tsx`) décrit encore `optIn` jusqu'au lot 4 : une requête qui l'envoie reçoit désormais 400 `invalid_body` en nommant `consent`, au lieu d'être ignorée. Personne n'est branché (spec, « Le problème »).
- **Automations** : l'API écrit les étiquettes par `editerFicheApi`, qui ne rend même pas les étiquettes ajoutées, et n'appelle JAMAIS `emitTagAdded` (invariant « aucun chemin de masse n'émet »).
- **`applyEdits` n'est PAS touché, et l'API ne l'emprunte pas.** Il verrouille par `where id = $1 and tenant_id = $2`, SANS `deleted_at is null` : sur le chemin de l'API, une purge RGPD passée entre `resoudreFiche` et l'écriture aurait fait réécrire un nom et des champs sur une fiche ANONYMISÉE. Ajouter le filtre à `applyEdits` changerait la fiche de la console (route `PATCH /tenants/:tenantId/contacts/:contactId`, `tests/contacts.test.ts`), ce que ce lot ne décide pas : l'API a donc sa propre écriture, `editerFicheApi`, qui porte le filtre.
- **Le coût de `/v1/contacts/batch`** : un élément coûtait UNE requête `on conflict` ; il en coûte deux (recherche, écriture), plus la création, le rattachement ou le consentement et son audit quand ils ont lieu. Aucune transaction ni client dédié par élément (c'est ce qu'`applyEdits` aurait coûté : connexion, `begin`, verrou, jusqu'à trois mises à jour, relecture, `commit`, soit une connexion retenue par élément en vol sur un pool de 8 partagé avec l'Inbox). `ECRITURES_EN_VOL` reste la borne. Le compte est tenu par deux tests (« le coût d'un élément complet », Task 9 ; « UNE requête », Task 4). ⚠️ `scripts/banc-charge.mts` ne sait pas mesurer ce chemin (il sème des campagnes et des webhooks sur un Postgres jetable) : aucune mesure de durée n'est prétendue ici.
- **Les définitions de champs** : un élément aux clés illisibles n'en crée plus aucune (clés d'abord). Un élément aux clés lisibles qui finit en `unknown_contact` ou `identity_conflict` a pu en créer une (préparation avant résolution, pour qu'un champ refusé ne crée jamais de fiche) ; même chose pour un `PATCH` dont `externalId` finit en conflit. Assumé et écrit dans le code, une définition est un nom de champ sans valeur ni personne, mais elle compte dans le plafond de l'espace.
- **La fiche de la console** : les e2e voisins (`contact-joignabilite`, `inbox-fiche-contact`, `contacts-suppression-consentement`) servent des contacts SANS `externalId` : la ligne reste masquée, rien ne bouge pour eux.
- **Une fiche SUPPRIMÉE** qui porte encore un numéro (suppression douce antérieure à l'anonymisation) est ressuscitée par une création par ce numéro, comme le faisait l'upsert de l'API ; une fiche PURGÉE ne l'est pas (numéro `anon:`).
- **`features.md`** n'est pas touché par ce lot : le lot 4 le réécrit, et une section modifiée périme l'empreinte des fiches du bot d'aide (`tests/aide-proposer.test.ts`).
- **Hors de ce lot, et qui supposera ce qu'il produit** : les destinataires de `/v1/sends` et `/v1/messages/*` passeront par `resoudreFiche` (mode `phone` pour un envoi, `jamais` pour un message simple) et `appliquerConsentement` au lot 2.

## Déploiement

1. **La migration d'abord, seule** (Task 3, pas 8) : `/revue-finale` sur le commit de la migration, puis sur le VPS `git pull`, `sudo docker compose build mba-api`, contrôle que SEULE `<N>` est en attente, `sudo docker compose run --rm --no-deps mba-api npm run migrate`, relecture en base (`indisvalid = true` compris). **Pas de `up`** : aucun code de production ne la lit encore. Ligne du compteur dans `CLAUDE.md` mise à jour.
2. **Les tâches 4 à 10 se poussent ensuite** (backend). Après chaque push, le run GitHub job par job, `integration` compris.
3. **`/revue-finale` du lot**, `gh run list` sur le dernier commit DE CODE, `git log <déployé>..origin/main` relu, puis sur le VPS : `git pull`, `sudo docker compose build mba-api`, `sudo docker compose run --rm --no-deps mba-api npm run migrate` (qui doit répondre « à jour » : `<N>` est déjà passée), `sudo docker compose up -d --build`, attente de `healthy`, `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`, puis `node scripts/fumee.mjs` depuis le poste (le 502 par IP périmée de NPM est intermittent).
4. **Puis la console** : push de la Task 11 (le droit `contacts:read`) APRÈS le pas 3, sinon une clé créée avec ce droit rendrait 400 ; la Task 12 (fiche) et la Task 13 (doc) ne dépendent d'aucune route neuve et suivent. Vercel publie à chaque push ; lire `ci-web.yml`.
5. **L'essai réel** ci-dessus clôt le lot. Tant qu'il n'a pas eu lieu, le lot est vert, pas éprouvé.
