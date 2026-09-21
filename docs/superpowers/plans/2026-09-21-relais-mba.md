# Relais du Meta Business Agent : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** l'agent de Meta appelle Engage Me, qui fait l'appel déclaré dans Tools > Connecteurs API avec les
valeurs du mini-CRM, au lieu d'appeler lui-même le système du client.

**Architecture :** une route `POST /mba/relais/outils/:outilId`, montée avec l'API publique (même autorité,
même limiteur), authentifiée par une clé d'API de l'espace portant le droit `mba:relais`. Elle retrouve
l'outil et le contact, valide les valeurs du modèle et appelle `creerAppelConnecteur` avec un mode de lecture
`entier`. La publication chez Meta ne pousse plus un connecteur par source mais un connecteur `EngageMe` par
espace, dont chaque outil lie un en-tête à la macro `WHATSAPP_PHONE_NUMBER`.

**Tech Stack :** TypeScript, Fastify, Zod 4, Postgres (pg), vitest, Next.js 15 (console), Playwright.

**Spec :** [docs/superpowers/specs/2026-09-21-relais-mba-design.md](../specs/2026-09-21-relais-mba-design.md)

## Global Constraints

- Aucun tiret cadratin ni demi-cadratin, dans le code comme dans les textes.
- 🔴 Jamais `npm run test:integration` en local : le `DATABASE_URL` local est la PRODUCTION. Les tests
  d'intégration tournent en CI ; les lire avec `gh run view <id> --json jobs`, jamais `gh run watch`.
- Commits : `git add -- <fichier neuf>` puis `git commit --only <liste>`, la liste construite depuis ce qu'on
  a touché, jamais depuis `git status`.
- Zod en `safeParse` sur tout corps entrant, jamais `as` sur un payload externe.
- Isolation : `tenant_id` filtré sur CHAQUE lecture ; l'espace du relais vient de la CLÉ, jamais de l'adresse.
- L'outil d'écriture convertit les séquences d'échappement en octets de contrôle : aucune barre oblique
  inverse dans ce qui est écrit (regex comprises), et contrôle des octets avant chaque commit.
- Migration : la base tranche le numéro (`select name from public.schema_migrations order by name desc`).
  `CLAUDE.md` porte le compteur, mis à jour APRÈS l'application.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff** (exécuté en direct dans la session, un lot après
l'autre). Raison : une porte publique neuve, une publication chez un tiers et des appels au système du
client, avec un invariant d'isolation entre espaces que seule une lecture du diff garantit.

**L'essai réel qui clôt la feature** (Task 10) : Julien réassigne `add_tag` à l'agent de Meta, clique
« Envoyer », puis demande sur WhatsApp « ajoute-moi l'étiquette X » ; l'étiquette apparaît sur sa fiche UChat
et l'appel dans le journal sous l'appelant `mba`. Un second « Envoyer » ne produit aucun geste.

## Structure des fichiers

| Fichier | Rôle |
|---|---|
| `db/migrations/0161_relais_mba.sql` (neuf) | CHECK du journal élargi à `mba`, colonne `tenant_settings.mba_relais_cle_id` |
| `src/agent/catalog.ts` | `SourceAppel` gagne `'mba'` |
| `src/agent/resolvers/http.ts` | lecture `{ nature: 'entier' }` |
| `src/mba/relais.ts` (neuf) | PUR : nom de l'en-tête, lecture du numéro, forme mesurée, validation des valeurs du modèle |
| `src/http/mba-relais.ts` (neuf) | la route du relais |
| `src/server.ts` | montage dans l'entrée `v1` |
| `src/index.ts` | câblage du relais et de la publication |
| `src/mba/publication.ts` | plan PUR : connecteur unique, corps d'outil, comparaison |
| `src/mba/cle-relais.ts` (neuf) | cycle de vie de la clé posée chez Meta |
| `src/http/mba-publication.ts` | routes de publication, corps du connecteur |
| `src/auth/api-key-store.pg.ts` | `estActive` |
| `src/settings/store.pg.ts` | `mbaRelaisCleId`, `setMbaRelaisCleId` |
| `src/mba/client.ts` | type de `request_definition` élargi |
| `web/...` | libellés, formulaire, retrait du bloc « Pas envoyés chez Meta » |

---

# LOT 1 : le relais, que personne n'appelle encore

### Task 1 : migration 0161 et appelant `mba`

**Files :**
- Create : `db/migrations/0161_relais_mba.sql`
- Modify : `src/agent/catalog.ts:27-29`
- Modify : `web/components/ErreursLivraison.tsx:201-206`, `web/lib/api/inbox.ts:342`
- Test : `tests/integration/relais-mba.integration.test.ts` (neuf)

**Interfaces :**
- Produces : `SourceAppel = 'agent' | 'scenario' | 'optout' | 'mba'` ; colonne `tenant_settings.mba_relais_cle_id uuid null`.

- [ ] **Step 1 : vérifier le numéro libre en base**, en lecture seule (sonde `tsx` en `default_transaction_read_only = on`) :
  `select name from public.schema_migrations order by name desc limit 3`. Attendu : `0160_...` en tête.

- [ ] **Step 2 : écrire la migration**

```sql
-- 0161 : le relais du Meta Business Agent (spec docs/superpowers/specs/2026-09-21-relais-mba-design.md).
--
-- 1) Le journal des appels de connecteur accepte un QUATRIÈME appelant, `mba` : l'agent de Meta, dont les
-- appels passent désormais par notre relais. On RELÂCHE un CHECK : l'ancien code y survit, donc la
-- migration passe AVANT le déploiement sans rien casser.
alter table agent_tool_calls drop constraint if exists agent_tool_calls_source_check;
alter table agent_tool_calls add constraint agent_tool_calls_source_check
  check (source in ('agent', 'scenario', 'optout', 'mba'));

-- 2) La clé d'API actuellement posée chez Meta pour le connecteur `EngageMe` de l'espace.
--
-- 🔴 UN SECRET NE SE COMPARE PAS, IL SE SOUVIENT (même principe que 0129) : Meta ne rend jamais la clé, et
-- nous n'en gardons que l'empreinte. Sans cette colonne, on ne saurait pas qu'une clé révoquée par le client
-- doit être remplacée chez Meta. `on delete set null` : une clé supprimée redevient « aucune clé posée »,
-- et la publication suivante en pose une neuve. Nullable, sans défaut : aucun espace n'a de relais.
alter table tenant_settings add column if not exists mba_relais_cle_id uuid
  references api_keys(id) on delete set null;
```

- [ ] **Step 3 : l'appelant `mba` dans le type**, `src/agent/catalog.ts` :

```ts
export type SourceAppel = 'agent' | 'scenario' | 'optout' | 'mba';

export const SOURCES_APPEL: readonly SourceAppel[] = ['agent', 'scenario', 'optout', 'mba'];
```

- [ ] **Step 4 : le libellé à l'écran**, `web/components/ErreursLivraison.tsx`, dans `quiAppelait`, après la ligne `optout` :

```tsx
    if (source === 'mba') return t('l’agent de Meta', 'Meta’s agent');
```

et `web/lib/api/inbox.ts:342` : `source: 'agent' | 'scenario' | 'optout' | 'mba' | string;`

- [ ] **Step 5 : le test d'intégration** (CI seulement), `tests/integration/relais-mba.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgJournalAppels } from '../../src/agent/catalog.pg';
import { PgApiKeyStore } from '../../src/auth/api-key-store.pg';
import { PgTenantSettingsStore } from '../../src/settings/store.pg';

const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('migration 0161 : le relais du MBA', () => {
  let pool: Pool;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-relais-mba') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 le journal accepte un appel de l’agent de Meta, sans session', async () => {
    const journal = new PgJournalAppels(pool);
    const id = await journal.ouvrir({
      tenantId, sessionId: null, toolId: null, toolName: 'add_tag', origin: 'http', argsRediges: {}, source: 'mba',
    });
    const r = await pool.query<{ source: string }>('select source from agent_tool_calls where id = $1', [id]);
    expect(r.rows[0]!.source).toBe('mba');
  });

  it('🔴 une clé supprimée remet la clé retenue à null, sans casser le réglage', async () => {
    const cles = new PgApiKeyStore(pool);
    const reglages = new PgTenantSettingsStore(pool);
    const { id } = await cles.create(tenantId, 'Agent de Meta', ['mba:relais']);
    await reglages.setMbaRelaisCleId(tenantId, id);
    expect(await reglages.mbaRelaisCleId(tenantId)).toBe(id);
    await pool.query('delete from api_keys where id = $1', [id]);
    expect(await reglages.mbaRelaisCleId(tenantId)).toBeNull();
  });
});
```

⚠️ Ce test appelle `mbaRelaisCleId` / `setMbaRelaisCleId`, écrits à la Task 6. Il est ajouté ici et
passe au vert au lot 2 ; au lot 1, on commite seulement le premier cas (le second est ajouté à la Task 6).

- [ ] **Step 6 : vérifier** : `npx tsc --noEmit -p .`, `(cd web && npx tsc --noEmit -p .)`, `npx vitest run tests/journal-appels-connecteur.test.ts`. Attendu : vert.
- [ ] **Step 7 : commit** (`git add -- db/migrations/0161_relais_mba.sql tests/integration/relais-mba.integration.test.ts` puis `git commit --only` sur les six fichiers).

### Task 2 : la lecture « réponse entière »

**Files :**
- Modify : `src/agent/resolvers/http.ts` (type `lecture` vers la ligne 142, étape 2 vers 226, après l'étape 9bis vers 418)
- Test : `tests/agent-resolveur-http-entier.test.ts` (neuf)

**Interfaces :**
- Produces : `AppelConnecteur.lecture` accepte `{ nature: 'entier' }` ; succès = `{ contenu: { reponse: unknown }, httpStatus }`, où `reponse` est le JSON lu, le texte brut s'il n'est pas du JSON, ou `null` pour un corps vide.

- [ ] **Step 1 : le test qui échoue**, `tests/agent-resolveur-http-entier.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { creerAppelConnecteur, type AppelConnecteur } from '../src/agent/resolvers/http';
import type { SourceAppel } from '../src/agent/sources';
import type { RequeteConnecteur } from '../src/agent/requetes';

const SOURCE: SourceAppel = {
  id: 'src1', kind: 'http', baseUrl: 'https://api.client.fr', authKind: 'bearer', authHeaderName: null,
  authSecret: 'S', status: 'active',
};
const REQUETE: RequeteConnecteur = {
  id: 'rq1', tenantId: 't1', sourceId: 'src1', label: 'Ajouter une étiquette', methode: 'POST',
  chemin: '/subscriber/add-tag', parametres: [], entetes: [],
  corps: { mode: 'json', gabarit: '{"user_ns":"{{user}}"}' },
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
  outputPaths: [], valeursTest: {}, outils: 1, updatedAt: '2026-09-21T00:00:00.000Z',
};

function appelAvec(reponse: { status: number; body: string }) {
  const appel = creerAppelConnecteur({
    sources: { pourAppel: async () => SOURCE, marquerEpreuve: async () => {} },
    requetes: { parId: async () => REQUETE },
    fetchImpl: (async () => new Response(reponse.body, { status: reponse.status })) as unknown as typeof fetch,
    verifierResolution: async () => ({ ok: true }),
  });
  const p: AppelConnecteur = {
    tenantId: 't1', waId: '33600', contact: { nom: 'J', tags: [], champs: {} }, requestId: 'rq1',
    maxBytes: 16_384, args: { user: 'u1' }, signal: AbortSignal.timeout(5_000), journal: null,
    lecture: { nature: 'entier' },
  };
  return appel(p);
}

describe('lecture « entier » : la réponse du client, telle quelle', () => {
  it('🔴 rend le JSON ENTIER, même sans aucun champ déclaré', async () => {
    // Un `integre` sans champ est REFUSÉ ; `entier` est le mode du relais, qui transmet tout (arbitrage de
    // Julien du 2026-09-21 : un modèle qui ne voit rien risque de conclure à un échec).
    const r = await appelAvec({ status: 200, body: '{"success":true,"data":{"tag":"vip"}}' });
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toEqual({ reponse: { success: true, data: { tag: 'vip' } } });
  });

  it('un corps vide (204) rend `null`, pas une erreur', async () => {
    const r = await appelAvec({ status: 204, body: '' });
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toEqual({ reponse: null });
  });

  it('un corps qui n’est pas du JSON est rendu en TEXTE', async () => {
    const r = await appelAvec({ status: 200, body: 'OK' });
    expect(r.contenu).toEqual({ reponse: 'OK' });
  });

  it('🔴 un 4xx du client garde le message SÛR, jamais son corps brut', async () => {
    const r = await appelAvec({ status: 422, body: '{"trace":"/srv/app/secret.php"}' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.contenu)).not.toContain('secret.php');
  });
});
```

- [ ] **Step 2 : lancer** `npx vitest run tests/agent-resolveur-http-entier.test.ts`. Attendu : ÉCHEC de compilation ou d'assertion (`entier` inconnu).

- [ ] **Step 3 : l'implémentation.** Dans le type `lecture` de `AppelConnecteur` :

```ts
  lecture:
    | { nature: 'pousse' }
    | { nature: 'integre'; champs: readonly string[] | null }
    /**
     * LA RÉPONSE ENTIÈRE, bornée à `maxBytes` : le mode du relais du Meta Business Agent (2026-09-21).
     * Julien a choisi de tout transmettre à l'agent de Meta : un modèle qui ne voit rien risque de conclure
     * à un échec et de transférer à un humain. Les échecs gardent leur message SÛR (étape 8).
     */
    | { nature: 'entier' };
```

Juste après le bloc 9bis (`if (p.lecture.nature === 'pousse') { ... }`) :

```ts
    // 9ter. LA RÉPONSE ENTIÈRE (relais du MBA). Déjà bornée à `maxBytes` par la lecture en flux.
    if (p.lecture.nature === 'entier') {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
      let reponse: unknown = null;
      if (brut !== '') {
        try { reponse = JSON.parse(brut) as unknown; } catch { reponse = brut; }
      }
      return { contenu: { reponse }, httpStatus: res.status };
    }
```

L'étape 2 (`champsLus`) ne change pas : elle ne refuse que `integre`.

- [ ] **Step 4 : lancer** le test neuf puis `npx vitest run tests/agent-resolver-http.test.ts tests/agent-resolveur-http-nature.test.ts`. Attendu : vert.
- [ ] **Step 5 : mutation** : retirer le bloc 9ter, constater l'échec du premier cas, restaurer.
- [ ] **Step 6 : commit** (`src/agent/resolvers/http.ts`, test neuf).

### Task 3 : le module pur du relais

**Files :**
- Create : `src/mba/relais.ts`
- Test : `tests/mba-relais.test.ts`

**Interfaces :**
- Produces :
  - `ENTETE_CONTACT_META = 'X-Contact-WhatsApp'` (nom publié chez Meta) ; Fastify le lit en minuscules.
  - `waIdDepuisEntete(brut: unknown): string | null`
  - `formeEntete(brut: unknown): string` (longueur, `+`, chiffres seuls ; jamais la valeur)
  - `lireValeursModele(variables: readonly VariableDeclaree[], corps: unknown): { ok: true; valeurs: Record<string, unknown> } | { ok: false; erreur: string }`
  - `texteErreur(contenu: unknown): string`

- [ ] **Step 1 : le test qui échoue**, `tests/mba-relais.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { waIdDepuisEntete, formeEntete, lireValeursModele, texteErreur } from '../src/mba/relais';
import type { VariableDeclaree } from '../src/agent/requetes';

describe('le numéro que Meta remplit', () => {
  it('se ramène à ses chiffres, avec ou sans +, espaces ou tirets', () => {
    expect(waIdDepuisEntete('+33 6 12-34-56-78')).toBe('33612345678');
    expect(waIdDepuisEntete('33612345678')).toBe('33612345678');
  });
  it('🔴 absent, vide, trop court ou d’un mauvais type : aucun contact', () => {
    for (const v of [undefined, null, '', '   ', '+12', 42, ['336']]) expect(waIdDepuisEntete(v)).toBeNull();
  });
  it('une valeur qui n’a pas la forme d’un numéro est gardée : c’est peut-être un BSUID', () => {
    expect(waIdDepuisEntete('FR.abc123')).toBe('FR.abc123');
  });
  it('🔴 la forme mesurée ne contient JAMAIS le numéro', () => {
    const f = formeEntete('+33612345678');
    expect(f).toBe('len=12 plus=true chiffres=true');
    expect(f).not.toContain('612345678');
    expect(formeEntete(undefined)).toBe('absent');
  });
});

const VARS: VariableDeclaree[] = [
  { nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true },
  { nom: 'couleur', type: 'string', origine: { type: 'modele' }, enum: ['rouge', 'vert'] },
  { nom: 'qte', type: 'integer', origine: { type: 'modele' } },
  { nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true },
];

describe('les valeurs que le modèle de Meta envoie', () => {
  it('ne garde que les variables d’origine modèle', () => {
    const r = lireValeursModele(VARS, { user: 'u1', tag: 'PIRATE', inconnu: 1 });
    expect(r).toEqual({ ok: true, valeurs: { user: 'u1' } });
  });
  it('🔴 une variable CHAMP ne peut pas être imposée par le modèle', () => {
    const r = lireValeursModele(VARS, { user: 'u1', tag: 'PIRATE' });
    expect(r.ok && 'tag' in r.valeurs).toBe(false);
  });
  it('refuse une requise absente, une valeur hors liste, un mauvais type, en les NOMMANT', () => {
    expect(lireValeursModele(VARS, {})).toEqual({ ok: false, erreur: 'valeur manquante ou invalide pour : user' });
    expect(lireValeursModele(VARS, { user: 'u', couleur: 'bleu' })).toEqual({ ok: false, erreur: 'valeur manquante ou invalide pour : couleur' });
    expect(lireValeursModele(VARS, { user: 'u', qte: 1.5 })).toEqual({ ok: false, erreur: 'valeur manquante ou invalide pour : qte' });
  });
  it('un corps qui n’est pas un objet est refusé en le disant', () => {
    expect(lireValeursModele(VARS, 'texte')).toEqual({ ok: false, erreur: 'le corps de la requête doit être un objet JSON' });
  });
  it('aucune variable modèle : un corps absent passe', () => {
    expect(lireValeursModele([VARS[3]!], undefined)).toEqual({ ok: true, valeurs: {} });
  });
});

describe('le message d’échec rendu à Meta', () => {
  it('reprend le message SÛR du point de passage', () => {
    expect(texteErreur({ erreur: 'le système du client est indisponible' })).toBe('le système du client est indisponible');
    expect(texteErreur(null)).toBe('l’appel a échoué');
  });
});
```

- [ ] **Step 2 : lancer** `npx vitest run tests/mba-relais.test.ts`. Attendu : ÉCHEC (module absent).

- [ ] **Step 3 : l'implémentation**, `src/mba/relais.ts` :

```ts
/**
 * Le RELAIS du Meta Business Agent, sa moitié PURE (spec 2026-09-21-relais-mba-design.md).
 *
 * 🔴 POURQUOI UN RELAIS. Meta appelle le système du client en direct et ne lit pas notre mini-CRM : il ne
 * remplit une valeur que par son modèle, une constante ou trois macros. Un outil qui envoie un champ du
 * contact (`tag_ns` chez UChat) était donc impossible. Meta nous appelle désormais, et nous faisons l'appel
 * déclaré dans Tools > Connecteurs API, avec les gardes et le journal d'un agent IA.
 */

import { z } from 'zod';
import type { VariableDeclaree } from '../agent/requetes';

/**
 * L'en-tête que Meta remplit avec la macro `WHATSAPP_PHONE_NUMBER`. Publié sous ce nom, lu en minuscules
 * (Fastify normalise les en-têtes).
 */
export const ENTETE_CONTACT_META = 'X-Contact-WhatsApp';

/**
 * Le numéro rempli par Meta, ramené à ce que `getContactStateByWaId` sait chercher.
 *
 * ⚠️ SON FORMAT N'EST PAS DOCUMENTÉ (avec ou sans `+` ?) : on accepte les deux, et la recherche de contact
 * sait déjà trouver `+33...`, `33...` et un BSUID. Une valeur qui n'a pas la forme d'un numéro est gardée
 * telle quelle, bornée : c'est peut-être l'identifiant d'un client qui n'a qu'un nom d'utilisateur.
 */
export function waIdDepuisEntete(brut: unknown): string | null {
  if (typeof brut !== 'string') return null;
  const v = brut.trim();
  if (v === '') return null;
  if (/^[0-9+ ()-]+$/.test(v)) {
    const chiffres = v.replace(/[^0-9]/g, '');
    return chiffres.length >= 7 && chiffres.length <= 15 ? chiffres : null;
  }
  return v.length <= 128 ? v : null;
}

/**
 * La FORME de l'en-tête, jamais sa valeur : ce qu'on journalise tant que le format réel de la macro n'est
 * pas mesuré. Un numéro de téléphone dans un journal serre une donnée personnelle là où personne ne la cherche.
 */
export function formeEntete(brut: unknown): string {
  if (typeof brut !== 'string') return 'absent';
  const v = brut.trim();
  const sansPlus = v.startsWith('+') ? v.slice(1) : v;
  return `len=${v.length} plus=${v.startsWith('+')} chiffres=${/^[0-9]+$/.test(sansPlus)}`;
}

function schemaVariable(v: VariableDeclaree): z.ZodType<unknown> {
  if (v.type === 'string') {
    return v.enum && v.enum.length > 0 ? z.enum(v.enum as [string, ...string[]]) : z.string().max(2000);
  }
  if (v.type === 'integer') return z.number().int();
  if (v.type === 'number') return z.number();
  return z.boolean();
}

/**
 * Les valeurs que le modèle de Meta envoie, validées contre les variables `modele` DÉCLARÉES.
 *
 * 🔴 SEULES LES VARIABLES `modele` SONT LUES. Une variable `champ` ou `contact` vient du mini-CRM : si le
 * modèle pouvait l'imposer, il enverrait l'étiquette ou l'identifiant de son choix au système du client.
 * Toute autre clé du corps est ignorée.
 */
export function lireValeursModele(
  variables: readonly VariableDeclaree[],
  corps: unknown,
): { ok: true; valeurs: Record<string, unknown> } | { ok: false; erreur: string } {
  const modele = variables.filter((v) => v.origine.type === 'modele');
  const brut = corps === undefined || corps === null ? {} : corps;
  if (typeof brut !== 'object' || Array.isArray(brut)) {
    return { ok: false, erreur: 'le corps de la requête doit être un objet JSON' };
  }
  const forme: Record<string, z.ZodType<unknown>> = {};
  for (const v of modele) forme[v.nom] = v.requis === true ? schemaVariable(v) : schemaVariable(v).nullish();
  const r = z.object(forme).safeParse(brut);
  if (!r.success) {
    const noms = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')))].filter((n) => n !== '').sort();
    return { ok: false, erreur: `valeur manquante ou invalide pour : ${noms.join(', ')}` };
  }
  const valeurs: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(r.data)) if (val !== undefined && val !== null) valeurs[k] = val;
  return { ok: true, valeurs };
}

/** Le message d'échec rendu à Meta : celui, SÛR, que le point de passage a déjà écrit pour un modèle. */
export function texteErreur(contenu: unknown): string {
  if (contenu !== null && typeof contenu === 'object' && typeof (contenu as { erreur?: unknown }).erreur === 'string') {
    return (contenu as { erreur: string }).erreur;
  }
  return 'l’appel a échoué';
}
```

- [ ] **Step 4 : lancer** le test. Attendu : vert. Contrôler les octets du fichier (aucun octet de contrôle).
- [ ] **Step 5 : mutations** : (a) retirer le filtre `origine.type === 'modele'` : le cas « champ imposé » doit tomber ; (b) remplacer `formeEntete` par la valeur brute : le cas « jamais le numéro » doit tomber. Restaurer.
- [ ] **Step 6 : commit** (`git add --` des deux fichiers neufs, puis `--only`).

### Task 4 : la route du relais, son montage et son câblage

**Files :**
- Create : `src/http/mba-relais.ts`
- Modify : `src/server.ts` (type `v1` vers 226, entrée `v1` vers 489)
- Modify : `src/index.ts` (objet `v1:` vers 2622, imports)
- Test : `tests/http-mba-relais.test.ts`

**Interfaces :**
- Consumes : `creerAppelConnecteur` et `AppelConnecteur` (Task 2), `waIdDepuisEntete`, `formeEntete`, `lireValeursModele`, `texteErreur`, `ENTETE_CONTACT_META` (Task 3), `consommateurMba` (`src/agent/consommateur.ts`), `SortieResolveur` (`src/agent/executor.ts`), `JournalAppels` et `OutilDefini` (`src/agent/catalog.ts`).
- Produces : `MbaRelaisDeps`, `registerMbaRelais(app, deps, gardes)`, `ServerDeps.v1.mbaRelais?`.

- [ ] **Step 1 : le test qui échoue**, `tests/http-mba-relais.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { MbaRelaisDeps } from '../src/http/mba-relais';
import type { AppelConnecteur } from '../src/agent/resolvers/http';

const CLE_RELAIS = `mba_${'r'.repeat(43)}`;
const CLE_CONTACTS = `mba_${'c'.repeat(43)}`;
const CLE_AUTRE_ESPACE = `mba_${'a'.repeat(43)}`;

const OUTIL = { id: 'o1', name: 'add_tag', origin: 'http' as const, requestId: 'rq1', timeoutMs: 5_000, maxBytes: 16_384 };

function monter(over: Partial<MbaRelaisDeps> = {}) {
  const appels: AppelConnecteur[] = [];
  const cles = new Map([
    [sha256Hex(CLE_RELAIS), { id: 'k1', tenantId: 't1', scopes: ['mba:relais'] }],
    [sha256Hex(CLE_CONTACTS), { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] }],
    [sha256Hex(CLE_AUTRE_ESPACE), { id: 'k3', tenantId: 't2', scopes: ['mba:relais'] }],
  ]);
  const mbaRelais: MbaRelaisDeps = {
    numeroDuTenant: async (t) => (t === 't1' ? 'pn1' : 'pn2'),
    // Le faux REFUSE ce que le vrai refuse : il ne rend les outils que de l'espace et du consommateur demandés.
    outilsActifs: async (t, c) => (t === 't1' && c === 'mba:pn1' ? [OUTIL] : []),
    requete: async (t, id) => (t === 't1' && id === 'rq1'
      ? { variables: [
          { nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true },
          { nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true },
        ] }
      : null),
    contact: async (t, waId) => (t === 't1' && waId === '33612345678' ? { nom: 'Julien', tags: [], champs: { tag_ns: 'vip' } } : null),
    appeler: async (p) => { appels.push(p); return { contenu: { reponse: { success: true } }, httpStatus: 200 }; },
    journal: { ouvrir: async () => 'l1', clore: async () => {} } as unknown as MbaRelaisDeps['journal'],
    ...over,
  };
  const app = buildServer({
    queue: new FakeQueue(),
    v1: {
      apiKeys: { findActiveByHash: async (h) => cles.get(h) ?? null, touchLastUsed: async () => {} },
      contacts: { upsertContacts: async () => ({ created: 0, updated: 0, errors: [] }) as never },
      mbaRelais,
    },
  });
  return { app, appels };
}

const poster = (app: ReturnType<typeof monter>['app'], cle: string, corps: unknown, entete: string | null = '+33612345678', outil = 'o1') =>
  app.inject({
    method: 'POST', url: `/mba/relais/outils/${outil}`,
    headers: { authorization: `Bearer ${cle}`, 'content-type': 'application/json', ...(entete === null ? {} : { 'x-contact-whatsapp': entete }) },
    payload: JSON.stringify(corps),
  });

describe('le relais du Meta Business Agent', () => {
  it('🔴 appelle le système du client pour le bon contact, avec les valeurs du modèle et le journal `mba`', async () => {
    const { app, appels } = monter();
    const res = await poster(app, CLE_RELAIS, { user: 'u1', tag: 'PIRATE' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: true, statut: 200, reponse: { success: true } });
    expect(appels).toHaveLength(1);
    expect(appels[0]!).toMatchObject({
      tenantId: 't1', waId: '33612345678', requestId: 'rq1', args: { user: 'u1' },
      lecture: { nature: 'entier' }, journal: { source: 'mba', nom: 'add_tag', sessionId: null, toolId: 'o1' },
    });
    // La valeur CHAMP ne vient jamais du modèle.
    expect(appels[0]!.args).not.toHaveProperty('tag');
  });

  it('🔴 sans clé, ou sans le droit `mba:relais`, rien ne part', async () => {
    const { app, appels } = monter();
    expect((await app.inject({ method: 'POST', url: '/mba/relais/outils/o1', payload: {} })).statusCode).toBe(401);
    expect((await poster(app, CLE_CONTACTS, { user: 'u1' })).statusCode).toBe(403);
    expect(appels).toHaveLength(0);
  });

  it('🔴 une clé d’un AUTRE espace n’atteint pas l’outil de celui-ci', async () => {
    const { app, appels } = monter();
    const res = await poster(app, CLE_AUTRE_ESPACE, { user: 'u1' });
    expect(res.json()).toEqual({ succes: false, erreur: 'cet outil n’est pas proposé à l’agent de Meta' });
    expect(appels).toHaveLength(0);
  });

  it('un outil non exposé, un numéro absent ou un contact inconnu : refus lisible, aucun appel', async () => {
    const { app, appels } = monter();
    expect((await poster(app, CLE_RELAIS, { user: 'u1' }, '+33612345678', 'autre')).json().succes).toBe(false);
    expect((await poster(app, CLE_RELAIS, { user: 'u1' }, null)).json())
      .toEqual({ succes: false, erreur: 'le client n’est pas identifié : son numéro WhatsApp manque' });
    expect((await poster(app, CLE_RELAIS, { user: 'u1' }, '+33700000000')).json())
      .toEqual({ succes: false, erreur: 'ce client est introuvable dans le carnet de contacts' });
    expect(appels).toHaveLength(0);
  });

  it('une valeur du modèle invalide est refusée en la nommant', async () => {
    const { app, appels } = monter();
    expect((await poster(app, CLE_RELAIS, {})).json()).toEqual({ succes: false, erreur: 'valeur manquante ou invalide pour : user' });
    expect(appels).toHaveLength(0);
  });

  it('un échec du système du client revient en `succes: false`, avec le message sûr', async () => {
    const { app } = monter({ appeler: async () => ({ ok: false, contenu: { erreur: 'le système du client est indisponible' }, erreur: 'indispo' }) });
    expect((await poster(app, CLE_RELAIS, { user: 'u1' })).json())
      .toEqual({ succes: false, erreur: 'le système du client est indisponible' });
  });

  it('🔴 la clé du relais n’ouvre PAS l’API publique', async () => {
    const { app } = monter();
    const res = await app.inject({
      method: 'POST', url: '/v1/contacts', headers: { authorization: `Bearer ${CLE_RELAIS}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ contacts: [] }),
    });
    expect(res.statusCode).toBe(403);
  });
});
```

⚠️ Avant d'écrire le test, relire `tests/v1-contacts.test.ts` : la forme exacte du corps `/v1/contacts` et le
type de retour de `upsertContacts` ; ajuster les deux fixtures ci-dessus à ce qu'elles y trouvent, sans
changer ce que les cas vérifient.

- [ ] **Step 2 : lancer** `npx vitest run tests/http-mba-relais.test.ts`. Attendu : ÉCHEC (module absent).

- [ ] **Step 3 : la route**, `src/http/mba-relais.ts` :

```ts
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { OutilDefini, JournalAppels } from '../agent/catalog';
import type { RequeteConnecteur } from '../agent/requetes';
import type { AppelConnecteur } from '../agent/resolvers/http';
import type { SortieResolveur } from '../agent/executor';
import { consommateurMba } from '../agent/consommateur';
import { ENTETE_CONTACT_META, waIdDepuisEntete, formeEntete, lireValeursModele, texteErreur } from '../mba/relais';

/**
 * LA ROUTE DU RELAIS : Meta l'appelle à la place du système du client (spec 2026-09-21-relais-mba-design.md).
 *
 * 🔴 L'ESPACE VIENT DE LA CLÉ, JAMAIS DE L'ADRESSE. La clé `mba:relais` est posée chez Meta par la
 * publication ; son porteur peut appeler les outils de l'espace au nom de n'importe lequel de ses contacts
 * (c'est l'en-tête qui désigne le contact), d'où un droit qu'aucun écran ne sait attribuer.
 *
 * ⚠️ UN ÉCHEC MÉTIER SORT EN 200 `{ succes: false, erreur }` : le modèle de Meta doit pouvoir dire au client
 * ce qui ne va pas. Un 4xx ou un 5xx risquerait d'être lu comme une panne de transport (non documenté chez
 * Meta, à mesurer au premier essai). Seule l'authentification sort en 401 / 403, par la garde existante.
 */
export interface MbaRelaisDeps {
  numeroDuTenant(tenantId: string): Promise<string | null>;
  outilsActifs(tenantId: string, consommateur: string): Promise<Array<Pick<OutilDefini, 'id' | 'name' | 'origin' | 'requestId' | 'timeoutMs' | 'maxBytes'>>>;
  requete(tenantId: string, id: string): Promise<Pick<RequeteConnecteur, 'variables'> | null>;
  /** La PROJECTION du contact `{nom, tags, champs}`, ou `null` s'il est inconnu. */
  contact(tenantId: string, waId: string): Promise<Record<string, unknown> | null>;
  appeler(p: AppelConnecteur): Promise<SortieResolveur>;
  journal: JournalAppels;
  /** La FORME de l'en-tête du numéro, tant que la macro n'est pas mesurée. Jamais sa valeur. */
  journaliserForme?(forme: string): void;
}

export function registerMbaRelais(app: FastifyInstance, deps: MbaRelaisDeps, gardes: preHandlerHookHandler[]): void {
  app.post<{ Params: { outilId: string } }>('/mba/relais/outils/:outilId', { preHandler: gardes }, async (req, reply) => {
    const tenant = req.auth?.tenantId;
    if (!tenant) return reply.code(401).send({ error: 'clé d’API requise' });
    const refus = (erreur: string) => reply.code(200).send({ succes: false, erreur });

    const pn = await deps.numeroDuTenant(tenant);
    const outil = pn === null
      ? undefined
      : (await deps.outilsActifs(tenant, consommateurMba(pn))).find((o) => o.id === req.params.outilId);
    if (!outil || outil.origin !== 'http' || !outil.requestId) return refus('cet outil n’est pas proposé à l’agent de Meta');

    const brut = req.headers[ENTETE_CONTACT_META.toLowerCase()];
    const valeur = Array.isArray(brut) ? brut[0] : brut;
    deps.journaliserForme?.(formeEntete(valeur));
    const waId = waIdDepuisEntete(valeur);
    if (waId === null) return refus('le client n’est pas identifié : son numéro WhatsApp manque');
    const contact = await deps.contact(tenant, waId);
    if (contact === null) return refus('ce client est introuvable dans le carnet de contacts');

    const requete = await deps.requete(tenant, outil.requestId);
    if (requete === null) return refus('cet outil n’est pas configuré');
    const lu = lireValeursModele(requete.variables, req.body);
    if (!lu.ok) return refus(lu.erreur);

    const sortie = await deps.appeler({
      tenantId: tenant, waId, contact, requestId: outil.requestId, maxBytes: outil.maxBytes, args: lu.valeurs,
      signal: AbortSignal.timeout(outil.timeoutMs),
      journal: { journal: deps.journal, source: 'mba', nom: outil.name, sessionId: null, toolId: outil.id },
      lecture: { nature: 'entier' },
    });
    if (sortie.ok === false) return refus(texteErreur(sortie.contenu));
    const reponse = (sortie.contenu as { reponse?: unknown } | null)?.reponse ?? null;
    return reply.code(200).send({ succes: true, statut: sortie.httpStatus ?? null, reponse });
  });
}
```

⚠️ Relire le type `PreHandler` utilisé par `registerV1Contacts` (`src/http/v1-contacts.ts`) et prendre le
MÊME pour `gardes`, plutôt que `preHandlerHookHandler` si le dépôt en a un à lui.

- [ ] **Step 4 : le montage**, `src/server.ts`. Dans le type `v1` :

```ts
    /** Le relais du Meta Business Agent : même autorité et même limiteur que /v1 (spec 2026-09-21). */
    mbaRelais?: MbaRelaisDeps;
```

Dans l'entrée `v1`, après la ligne `registerMcp` :

```ts
      // Le relais du MBA : MÊME `requireApiKey`, donc même limiteur par clé, et un droit que seule la
      // publication attribue. Monté ici et pas à part, pour ne pas ouvrir une seconde autorité.
      if (v1.mbaRelais) registerMbaRelais(app, v1.mbaRelais, [requireApiKey, requireScope('mba:relais')]);
```

avec `import { registerMbaRelais, type MbaRelaisDeps } from './http/mba-relais';`.

- [ ] **Step 5 : le câblage**, `src/index.ts`, dans l'objet `v1:` :

```ts
      /**
       * Le relais du Meta Business Agent. Le MÊME point de passage que l'agent IA (`creerAppelConnecteur`),
       * construit avec les mêmes lectures paresseuses : un appel du MBA passe par les mêmes gardes.
       */
      mbaRelais: {
        numeroDuTenant: (t) => repo.getTenantPhoneNumberId(t),
        outilsActifs: (t, c) => toolCatalog.listActifsConsommateur(t, c),
        requete: (t, id) => agentRequetes.parId(t, id),
        // 🔴 PROJECTION, jamais la ligne brute : même règle que `lireContact` du worker.
        contact: async (t, waId) => {
          const etat = await contactStore.getContactStateByWaId(t, waId);
          return etat ? { nom: etat.name ?? '', tags: etat.tags, champs: etat.fields } : null;
        },
        appeler: creerAppelConnecteur({
          sources: agentSources,
          requetes: agentRequetes,
          derniereSaisie: (t, waId) => inboxStore.derniereSaisieDuContact(t, waId),
          fuseau: async (t) => (await settingsStore.get(t)).timezone,
        }),
        journal: new PgJournalAppels(pool),
        // ⚠️ TEMPORAIRE : la forme de l'en-tête, jamais sa valeur, jusqu'à la mesure du premier essai réel.
        // eslint-disable-next-line no-console
        journaliserForme: (f) => console.info(`mba-relais: en-tete du numero ${f}`),
      },
```

Imports : `creerAppelConnecteur` depuis `./agent/resolvers/http`, `PgJournalAppels` depuis `./agent/catalog.pg`.

- [ ] **Step 6 : lancer** `npx vitest run tests/http-mba-relais.test.ts tests/scope-tenant.test.ts tests/v1-contacts.test.ts` puis `npx tsc --noEmit -p .`. Attendu : vert.
- [ ] **Step 7 : mutations** : (a) retirer `requireScope('mba:relais')` : le cas 403 tombe ; (b) remplacer `consommateurMba(pn)` par une liste de tous les outils de l'espace : le cas « outil non exposé » tombe ; (c) passer `args: req.body` au lieu de `lu.valeurs` : le cas « la valeur CHAMP ne vient jamais du modèle » tombe. Restaurer.
- [ ] **Step 8 : `npm test` complet**, puis commit (`git add --` des deux fichiers neufs, `--only` sur les quatre).
- [ ] **Step 9 : pousser, lire la CI job par job.** Le lot 1 est déployable seul : personne n'appelle le relais.

---

# LOT 2 : la publication traduite

### Task 5 : le plan de publication (pur)

**Files :**
- Modify : `src/mba/publication.ts` (types, `planifierPublication`, `aChange` ; retrait de `pertesChezMeta`, `OutilNonPubliable`, `SourceAPublier`, `authTypeMeta`)
- Modify : `src/http/mba-publication.ts` (`corpsOutilMeta`, `corpsConnecteurRelais`)
- Modify : `src/mba/client.ts:323-345` (type `request_definition` en `Record<string, unknown>`)
- Test : `tests/mba-publication.test.ts` (réécrit)

**Interfaces :**
- Consumes : `ENTETE_CONTACT_META` (Task 3), `VariableDeclaree`.
- Produces :

```ts
export const NOM_CONNECTEUR_RELAIS = 'EngageMe';
export interface RelaisAPublier { baseUrl: string; cleAJour: boolean }
export interface OutilAPublier { id: string; name: string; description: string; nePasUtiliser: string; variables: VariableDeclaree[] }
export type Geste =
  | { type: 'connecteur_creer'; nom: string }
  | { type: 'connecteur_modifier'; connecteurId: string; nom: string }
  | { type: 'connecteur_supprimer'; connecteurId: string; nom: string; oublierCle: boolean }
  | { type: 'outil_creer'; outilId: string; nom: string }
  | { type: 'outil_modifier'; outilMetaId: string; outilId: string; nom: string }
  | { type: 'outil_supprimer'; connecteurId: string; outilMetaId: string; nom: string };
export function planifierPublication(relais: RelaisAPublier, outils: OutilAPublier[], meta: EtatMeta): Geste[];
export function corpsOutilMeta(o: OutilAPublier): CorpsOutilMeta;
export function corpsConnecteurRelais(baseUrl: string, cle: string): { name: string; description: string; base_url: string; auth_type: 'API_KEY'; auth_config: unknown };
```

⚠️ **Écart assumé avec la spec** : pas de geste `cle_poser` séparé. Meta exige `auth_config` à CHAQUE
modification du connecteur, et nous ne gardons que l'empreinte de la clé : toute modification porte donc une
clé NEUVE, et « la clé n'est plus active » produit simplement un `connecteur_modifier`. La spec est corrigée
dans le même commit.

- [ ] **Step 1 : les tests qui échouent.** Réécrire `tests/mba-publication.test.ts` autour de :

```ts
import { describe, it, expect } from 'vitest';
import {
  planifierPublication, descriptionPourMeta, NOM_CONNECTEUR_RELAIS, nomPubliableChezMeta,
  type OutilAPublier, type EtatMeta,
} from '../src/mba/publication';
import { corpsOutilMeta, corpsConnecteurRelais } from '../src/http/mba-publication';

const RELAIS = { baseUrl: 'https://api.messagingme.app/mba/relais', cleAJour: true };
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Le client demande à rajouter une étiquette.', nePasUtiliser: '',
  variables: [
    { nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true, description: 'Identifiant UChat' },
    { nom: 'couleur', type: 'string', origine: { type: 'modele' }, enum: ['rouge', 'vert'] },
    { nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true },
  ],
};
const VIDE: EtatMeta = { connecteurs: [], outilsParConnecteur: {} };
/** L'état chez Meta qui correspond EXACTEMENT à `RELAIS` + `ADD_TAG`. */
const ALIGNE: EtatMeta = {
  connecteurs: [{ id: 'c1', name: NOM_CONNECTEUR_RELAIS, base_url: RELAIS.baseUrl, auth_type: 'API_KEY' }],
  outilsParConnecteur: { c1: [{ id: 't1', ...corpsOutilMeta(ADD_TAG) }] },
};

describe('le corps d’un outil chez Meta', () => {
  it('🔴 appelle le relais, avec l’en-tête du numéro lié à la macro', () => {
    const rd = corpsOutilMeta(ADD_TAG).request_definition as Record<string, unknown>;
    expect(rd.method).toBe('POST');
    expect(rd.path).toBe('/outils/o1');
    expect(rd.headers).toEqual({ 'X-Contact-WhatsApp': {
      type: 'string', description: expect.any(String), binding: { kind: 'macro', macro: 'WHATSAPP_PHONE_NUMBER' },
    } });
  });
  it('🔴 ne déclare QUE les variables du modèle ; les valeurs permises vont dans la description', () => {
    const body = (corpsOutilMeta(ADD_TAG).request_definition as { body: { params: Record<string, { description: string }>; required?: string[] } }).body;
    expect(Object.keys(body.params).sort()).toEqual(['couleur', 'user']);
    expect(body.required).toEqual(['user']);
    expect(body.params.couleur!.description).toContain('Valeurs possibles : rouge, vert.');
  });
  it('sans variable du modèle, aucun corps', () => {
    const rd = corpsOutilMeta({ ...ADD_TAG, variables: [ADD_TAG.variables[2]!] }).request_definition as Record<string, unknown>;
    expect(rd).not.toHaveProperty('body');
  });
});

describe('le plan', () => {
  it('un espace sans connecteur : créer EngageMe, puis ses outils', () => {
    expect(planifierPublication(RELAIS, [ADD_TAG], VIDE).map((g) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
  });
  it('🔴 PUBLIER DEUX FOIS DE SUITE NE PRODUIT AUCUN GESTE', () => {
    expect(planifierPublication(RELAIS, [ADD_TAG], ALIGNE)).toEqual([]);
  });
  it('🔴 l’ancien connecteur d’une source (qui porte le secret du client) s’en va, ses outils d’abord', () => {
    const avecAncien: EtatMeta = {
      connecteurs: [...ALIGNE.connecteurs, { id: 'c0', name: 'testUCHAT', base_url: 'https://ai.messagingme.app/api', auth_type: 'API_KEY' }],
      outilsParConnecteur: { ...ALIGNE.outilsParConnecteur, c0: [{ id: 't0', name: 'add_tag' }] },
    };
    expect(planifierPublication(RELAIS, [ADD_TAG], avecAncien)).toEqual([
      { type: 'outil_supprimer', connecteurId: 'c0', outilMetaId: 't0', nom: 'add_tag' },
      { type: 'connecteur_supprimer', connecteurId: 'c0', nom: 'testUCHAT', oublierCle: false },
    ]);
  });
  it('🔴 une clé qui n’est plus active fait MODIFIER le connecteur (qui porte une clé neuve)', () => {
    expect(planifierPublication({ ...RELAIS, cleAJour: false }, [ADD_TAG], ALIGNE))
      .toEqual([{ type: 'connecteur_modifier', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS }]);
  });
  it('une adresse de relais qui a bougé fait modifier le connecteur', () => {
    expect(planifierPublication({ ...RELAIS, baseUrl: 'https://autre/mba/relais' }, [ADD_TAG], ALIGNE).map((g) => g.type))
      .toEqual(['connecteur_modifier']);
  });
  it('🔴 plus aucun outil exposé : le relais part, et sa clé est oubliée', () => {
    expect(planifierPublication(RELAIS, [], ALIGNE)).toEqual([
      { type: 'outil_supprimer', connecteurId: 'c1', outilMetaId: 't1', nom: 'add_tag' },
      { type: 'connecteur_supprimer', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS, oublierCle: true },
    ]);
  });
  it('un outil modifié chez nous (description, variables) est modifié chez Meta', () => {
    expect(planifierPublication(RELAIS, [{ ...ADD_TAG, description: 'Autre.' }], ALIGNE).map((g) => g.type)).toEqual(['outil_modifier']);
    expect(planifierPublication(RELAIS, [{ ...ADD_TAG, variables: [] }], ALIGNE).map((g) => g.type)).toEqual(['outil_modifier']);
  });
  it('⚠️ un champ `null` rendu par Meta vaut un champ absent (pas de geste pour rien)', () => {
    const avecNull: EtatMeta = { ...ALIGNE, outilsParConnecteur: { c1: [{ ...ALIGNE.outilsParConnecteur.c1![0]!, request_definition: {
      ...(corpsOutilMeta(ADD_TAG).request_definition as Record<string, unknown>), query_parameters: null,
    } }] } };
    expect(planifierPublication(RELAIS, [ADD_TAG], avecNull)).toEqual([]);
  });
  it('un doublon d’outil chez Meta : on en garde un, on supprime la copie', () => {
    const enDouble: EtatMeta = { ...ALIGNE, outilsParConnecteur: { c1: [ALIGNE.outilsParConnecteur.c1![0]!, { ...ALIGNE.outilsParConnecteur.c1![0]!, id: 't2' }] } };
    expect(planifierPublication(RELAIS, [ADD_TAG], enDouble)).toEqual([
      { type: 'outil_supprimer', connecteurId: 'c1', outilMetaId: 't1', nom: 'add_tag' },
    ]);
  });
});

describe('le connecteur du relais', () => {
  it('porte la clé en bearer, dans le corps (Meta l’exige)', () => {
    expect(corpsConnecteurRelais(RELAIS.baseUrl, 'mba_CLE')).toMatchObject({
      name: NOM_CONNECTEUR_RELAIS, base_url: RELAIS.baseUrl, auth_type: 'API_KEY',
      auth_config: { api_key: { headers: [{ field_name: 'Authorization', value: 'mba_CLE', prefix: 'Bearer ' }] } },
    });
    expect(nomPubliableChezMeta(NOM_CONNECTEUR_RELAIS)).toBe(true);
  });
});

describe('descriptionPourMeta', () => {
  it('concatène la clause « ne pas utiliser »', () => {
    const d = descriptionPourMeta({ description: 'A.', nePasUtiliser: 'B.' });
    expect(d.startsWith('A.')).toBe(true);
    expect(d).toContain('Ne pas l');
    expect(d.endsWith('B.')).toBe(true);
  });
});
```

⚠️ Aucune séquence d'échappement dans ces tests : l'outil d'écriture les convertit en octets de contrôle.
⚠️ Le cas « doublon » attend la suppression de `t1` et pas `t2` : la `Map` par nom garde la DERNIÈRE entrée.
Vérifier ce que rend l'implémentation et garder le cas tel qu'il est aujourd'hui (on en supprime UN).

- [ ] **Step 2 : lancer** `npx vitest run tests/mba-publication.test.ts`. Attendu : ÉCHEC.

- [ ] **Step 3 : l'implémentation**, `src/mba/publication.ts` (garder `descriptionPourMeta`, `authConfigMeta`,
  `NOM_CONNECTEUR_META_RE`, `nomPubliableChezMeta`, `ConnecteurChezMeta`, `EtatMeta` ; `OutilChezMeta.request_definition`
  devient `Record<string, unknown>`) :

```ts
/** Le nom du connecteur unique d'un espace chez Meta. Il passe `NOM_CONNECTEUR_META_RE`. */
export const NOM_CONNECTEUR_RELAIS = 'EngageMe';

export interface RelaisAPublier {
  /** `PUBLIC_API_URL` suivi de `/mba/relais`. */
  baseUrl: string;
  /** La clé retenue (`tenant_settings.mba_relais_cle_id`) est-elle toujours active ? */
  cleAJour: boolean;
}

export interface OutilAPublier {
  id: string;
  name: string;
  description: string;
  nePasUtiliser: string;
  /** Les variables de la requête : seules celles d'origine `modele` partent chez Meta. */
  variables: VariableDeclaree[];
}

export function planifierPublication(relais: RelaisAPublier, outils: OutilAPublier[], meta: EtatMeta): Geste[] {
  const gestes: Geste[] = [];
  const doitExister = outils.length > 0;
  const retenu = doitExister ? meta.connecteurs.find((c) => c.name === NOM_CONNECTEUR_RELAIS) : undefined;

  // 1. Tout connecteur qui n'est pas LE relais retenu s'en va, ses outils d'abord : les anciens (un par
  //    source, qui portaient le secret du client), les doublons du relais, et le relais lui-même quand plus
  //    aucun outil n'est exposé (sa clé est alors oubliée).
  for (const c of meta.connecteurs) {
    if (retenu && c.id === retenu.id) continue;
    for (const o of meta.outilsParConnecteur[c.id] ?? []) {
      gestes.push({ type: 'outil_supprimer', connecteurId: c.id, outilMetaId: o.id, nom: o.name });
    }
    gestes.push({ type: 'connecteur_supprimer', connecteurId: c.id, nom: c.name, oublierCle: c.name === NOM_CONNECTEUR_RELAIS && !doitExister });
  }
  if (!doitExister) return gestes;

  // 2. Le relais : créé, ou modifié (toute modification porte une clé NEUVE, cf. `cle-relais.ts`).
  if (!retenu) gestes.push({ type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS });
  else if (retenu.base_url !== relais.baseUrl || retenu.auth_type !== 'API_KEY' || !relais.cleAJour) {
    gestes.push({ type: 'connecteur_modifier', connecteurId: retenu.id, nom: NOM_CONNECTEUR_RELAIS });
  }

  // 3. Les outils du relais.
  const dejaLa = retenu ? (meta.outilsParConnecteur[retenu.id] ?? []) : [];
  const parNom = new Map(dejaLa.map((o) => [o.name, o]));
  for (const o of outils) {
    const existant = parNom.get(o.name);
    if (!existant) gestes.push({ type: 'outil_creer', outilId: o.id, nom: o.name });
    else if (aChange(existant, corpsOutilMeta(o))) {
      gestes.push({ type: 'outil_modifier', outilMetaId: existant.id, outilId: o.id, nom: o.name });
    }
  }
  const nosNoms = new Set(outils.map((o) => o.name));
  for (const o of dejaLa) {
    if (!nosNoms.has(o.name) || parNom.get(o.name)?.id !== o.id) {
      gestes.push({ type: 'outil_supprimer', connecteurId: retenu!.id, outilMetaId: o.id, nom: o.name });
    }
  }
  return gestes;
}

/** Une valeur ramenée à ses seules clés non nulles, triées : deux formes équivalentes deviennent égales. */
function normaliser(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normaliser);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== null && x !== undefined) out[k] = normaliser(x);
    }
    return out;
  }
  return v;
}

/**
 * 🔴 ON COMPARE TOUTE LA DÉFINITION QUE NOUS ENVOYONS, normalisée. Comparer méthode et chemin seulement
 * laisserait une variable ajoutée chez nous invisible chez Meta pour toujours. ⚠️ La forme que Meta RENVOIE
 * n'est pas garantie (« roundtripped ») : l'idempotence se vérifie aussi à l'essai réel.
 */
function aChange(chezMeta: OutilChezMeta, attendu: CorpsOutilMeta): boolean {
  if (chezMeta.description !== attendu.description) return true;
  if (!chezMeta.request_definition) return true;
  return JSON.stringify(normaliser(chezMeta.request_definition)) !== JSON.stringify(normaliser(attendu.request_definition));
}
```

`corpsOutilMeta` vit dans `src/mba/publication.ts` (le plan en a besoin, pur) et `src/http/mba-publication.ts`
le ré-exporte :

```ts
export interface CorpsOutilMeta {
  name: string; description: string; request_definition: Record<string, unknown>; user_auth_required: false;
}

/**
 * Le corps d'un outil chez Meta : un appel au RELAIS, jamais au système du client.
 *
 * 🔴 L'EN-TÊTE DU NUMÉRO EST LIÉ À LA MACRO : Meta le remplit, son modèle ne peut ni le choisir ni
 * l'inventer. C'est ce qui permet au relais de retrouver le contact sans faire confiance au modèle.
 * ⚠️ SEULES LES VARIABLES `modele` sont déclarées : les autres viennent du mini-CRM, chez nous. Meta n'a pas
 * de champ pour une liste de valeurs permises : elle s'écrit dans la description, et le relais la vérifie.
 */
export function corpsOutilMeta(o: OutilAPublier): CorpsOutilMeta {
  const modele = o.variables.filter((v) => v.origine.type === 'modele');
  const params: Record<string, { type: string; description: string }> = {};
  for (const v of modele) {
    const base = (v.description ?? '').trim() || v.nom;
    const permises = v.enum && v.enum.length > 0 ? ` Valeurs possibles : ${v.enum.join(', ')}.` : '';
    params[v.nom] = { type: v.type, description: `${base}${permises}` };
  }
  const requises = modele.filter((v) => v.requis === true).map((v) => v.nom);
  return {
    name: o.name,
    description: descriptionPourMeta(o),
    request_definition: {
      method: 'POST',
      path: `/outils/${o.id}`,
      headers: {
        [ENTETE_CONTACT_META]: {
          type: 'string',
          description: 'Le numéro WhatsApp du client, rempli par WhatsApp.',
          binding: { kind: 'macro', macro: 'WHATSAPP_PHONE_NUMBER' },
        },
      },
      ...(modele.length > 0
        ? { body: { content_type: 'application/json', params, ...(requises.length > 0 ? { required: requises } : {}) } }
        : {}),
    },
    user_auth_required: false,
  };
}
```

`src/http/mba-publication.ts` : remplacer `corpsConnecteurMeta` par

```ts
/** Le connecteur unique de l'espace chez Meta : l'adresse du relais, et la clé dans son corps (Meta l'exige). */
export function corpsConnecteurRelais(baseUrl: string, cle: string) {
  return {
    name: NOM_CONNECTEUR_RELAIS,
    description: 'Engage Me : les outils de cet espace, appelés avec les valeurs de son carnet de contacts.',
    base_url: baseUrl,
    auth_type: 'API_KEY' as const,
    auth_config: authConfigMeta({ authKind: 'bearer', authHeaderName: null }, cle),
  };
}
```

- [ ] **Step 4 : lancer** le test, puis `npx tsc --noEmit -p .` : les erreurs restantes sont dans la route et
  `src/index.ts` (Task 7), pas dans ce qu'on vient d'écrire.
- [ ] **Step 5 : mutations** : (a) retirer la liaison `binding` : le premier cas tombe ; (b) ne plus filtrer
  `origine.type === 'modele'` : le second tombe ; (c) `aChange` sans `normaliser` : le cas « `null` rendu par Meta » tombe.
- [ ] **Step 6 : pas de commit seul** : Task 5 à 7 forment un commit, le dépôt ne compile qu'à la fin de la Task 7.

### Task 6 : la clé posée chez Meta

**Files :**
- Create : `src/mba/cle-relais.ts`
- Modify : `src/auth/api-key-store.pg.ts` (`estActive`), `src/settings/store.pg.ts` (`mbaRelaisCleId`, `setMbaRelaisCleId`)
- Test : `tests/mba-cle-relais.test.ts`, et le second cas de `tests/integration/relais-mba.integration.test.ts`

**Interfaces :**
- Produces :

```ts
export interface DepsCleRelais {
  creerCle(tenantId: string): Promise<{ id: string; key: string }>;
  revoquer(tenantId: string, id: string): Promise<boolean>;
  cleRetenue(tenantId: string): Promise<string | null>;
  retenir(tenantId: string, id: string | null): Promise<void>;
  estActive(tenantId: string, id: string): Promise<boolean>;
}
export async function cleAJour(deps: DepsCleRelais, tenantId: string): Promise<boolean>;
export async function poserCleNeuve(deps: DepsCleRelais, tenantId: string, ecrireChezMeta: (cle: string) => Promise<void>): Promise<void>;
export async function oublierCle(deps: DepsCleRelais, tenantId: string): Promise<void>;
```

- [ ] **Step 1 : le test qui échoue**, `tests/mba-cle-relais.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { cleAJour, poserCleNeuve, oublierCle, type DepsCleRelais } from '../src/mba/cle-relais';

function faux(depart: string | null = 'k0') {
  const journal: string[] = [];
  let retenue = depart;
  const actives = new Set(depart ? [depart] : []);
  let n = 0;
  const deps: DepsCleRelais = {
    creerCle: async () => { n += 1; const id = `k${n}`; actives.add(id); journal.push(`creer ${id}`); return { id, key: `mba_${id}` }; },
    revoquer: async (_t, id) => { journal.push(`revoquer ${id}`); return actives.delete(id); },
    cleRetenue: async () => retenue,
    retenir: async (_t, id) => { journal.push(`retenir ${id}`); retenue = id; },
    estActive: async (_t, id) => actives.has(id),
  };
  return { deps, journal, retenue: () => retenue };
}

describe('la clé posée chez Meta', () => {
  it('🔴 dans l’ordre : créer, écrire chez Meta, retenir APRÈS son accusé, révoquer l’ancienne', async () => {
    const f = faux('k0');
    await poserCleNeuve(f.deps, 't1', async (cle) => { f.journal.push(`meta ${cle}`); });
    expect(f.journal).toEqual(['creer k1', 'meta mba_k1', 'retenir k1', 'revoquer k0']);
  });

  it('🔴 Meta refuse : la clé neuve est révoquée, l’ancienne reste retenue, l’erreur remonte', async () => {
    const f = faux('k0');
    await expect(poserCleNeuve(f.deps, 't1', async () => { throw new Error('400'); })).rejects.toThrow('400');
    expect(f.journal).toEqual(['creer k1', 'revoquer k1']);
    expect(f.retenue()).toBe('k0');
  });

  it('à jour seulement si une clé est retenue ET active', async () => {
    expect(await cleAJour(faux('k0').deps, 't1')).toBe(true);
    expect(await cleAJour(faux(null).deps, 't1')).toBe(false);
    const revoquee = faux('k0');
    await revoquee.deps.revoquer('t1', 'k0');
    expect(await cleAJour(revoquee.deps, 't1')).toBe(false);
  });

  it('oublier : révoquer la clé retenue et vider la colonne', async () => {
    const f = faux('k0');
    await oublierCle(f.deps, 't1');
    expect(f.journal).toEqual(['revoquer k0', 'retenir null']);
  });
});
```

- [ ] **Step 2 : lancer**, attendu ÉCHEC.

- [ ] **Step 3 : l'implémentation**, `src/mba/cle-relais.ts` :

```ts
/**
 * LA CLÉ QUE META PRÉSENTE AU RELAIS : une clé d'API de l'espace, droit `mba:relais`, visible dans sa liste
 * sous le nom « Agent de Meta » (arbitrage de Julien, 2026-09-21).
 *
 * 🔴 UN SECRET NE SE COMPARE PAS, IL SE SOUVIENT. Meta ne rend jamais la clé et nous n'en gardons que
 * l'empreinte : `tenant_settings.mba_relais_cle_id` dit laquelle est chez Meta. Meta exige `auth_config` à
 * chaque modification du connecteur, donc toute modification pose une clé NEUVE.
 *
 * 🔴 L'ORDRE NE LAISSE RIEN D'ORPHELIN : créer, écrire chez Meta, retenir APRÈS son accusé, puis révoquer
 * l'ancienne. Si Meta refuse, la neuve est révoquée tout de suite et l'ancienne reste la bonne.
 */
export const NOM_CLE_RELAIS = 'Agent de Meta';
export const DROIT_RELAIS = 'mba:relais';

export interface DepsCleRelais {
  creerCle(tenantId: string): Promise<{ id: string; key: string }>;
  revoquer(tenantId: string, id: string): Promise<boolean>;
  cleRetenue(tenantId: string): Promise<string | null>;
  retenir(tenantId: string, id: string | null): Promise<void>;
  estActive(tenantId: string, id: string): Promise<boolean>;
}

export async function cleAJour(deps: DepsCleRelais, tenantId: string): Promise<boolean> {
  const id = await deps.cleRetenue(tenantId);
  return id !== null && (await deps.estActive(tenantId, id));
}

export async function poserCleNeuve(
  deps: DepsCleRelais, tenantId: string, ecrireChezMeta: (cle: string) => Promise<void>,
): Promise<void> {
  const ancienne = await deps.cleRetenue(tenantId);
  const neuve = await deps.creerCle(tenantId);
  try {
    await ecrireChezMeta(neuve.key);
  } catch (err) {
    await deps.revoquer(tenantId, neuve.id).catch(() => false);
    throw err;
  }
  await deps.retenir(tenantId, neuve.id);
  if (ancienne !== null && ancienne !== neuve.id) await deps.revoquer(tenantId, ancienne).catch(() => false);
}

export async function oublierCle(deps: DepsCleRelais, tenantId: string): Promise<void> {
  const id = await deps.cleRetenue(tenantId);
  if (id !== null) await deps.revoquer(tenantId, id).catch(() => false);
  await deps.retenir(tenantId, null);
}
```

`src/auth/api-key-store.pg.ts` :

```ts
  /** La clé existe-t-elle, pour CET espace, sans être révoquée ? */
  async estActive(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from api_keys where id = $1 and tenant_id = $2 and revoked_at is null`, [id, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }
```

`src/settings/store.pg.ts`, deux méthodes HORS de `get()` (les fixtures de réglages n'ont pas à bouger) :

```ts
  /** La clé d'API posée chez Meta pour le relais (migration 0161), ou `null`. */
  async mbaRelaisCleId(tenantId: string): Promise<string | null> {
    const r = await this.pool.query<{ id: string | null }>(
      `select mba_relais_cle_id as id from tenant_settings where tenant_id = $1`, [tenantId],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Retient la clé posée chez Meta. Upsert ciblé : n'écrase aucun autre réglage. */
  async setMbaRelaisCleId(tenantId: string, id: string | null): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mba_relais_cle_id, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mba_relais_cle_id = excluded.mba_relais_cle_id, updated_at = now()`,
      [tenantId, id],
    );
  }
```

- [ ] **Step 4 : lancer**, attendu vert. Ajouter le second cas du test d'intégration (Task 1, Step 5).
- [ ] **Step 4bis : le droit n'est pas attribuable.** Dans `tests/http-api-keys.test.ts`, un cas : `POST
  /tenants/:tenantId/api-keys` avec `scopes: ['mba:relais']` est REFUSÉ (400) et ne crée rien. Il doit passer
  sans toucher au code (`VALID_API_SCOPES` ne le contient pas) ; le muter en ajoutant `mba:relais` à
  `VALID_API_SCOPES` doit le faire tomber.
- [ ] **Step 5 : mutations** : (a) `retenir` AVANT `ecrireChezMeta` : le premier cas tombe ; (b) retirer la révocation dans le `catch` : le second tombe.

### Task 7 : les routes de publication et le câblage

**Files :**
- Modify : `src/http/mba-publication.ts` (deps, GET, POST), `src/index.ts` (`mbaPublication`), `web/lib/api-agent-tools.ts` (`GestePublication`)
- Test : `tests/http-mba-publication.test.ts` (réécrit)

**Interfaces :**
- Consumes : Task 5 et Task 6.
- Produces : `MbaPublicationDeps = { numeroDuTenant; relais(tenantId): Promise<RelaisAPublier | null>; outilsExposes(tenantId, pn): Promise<OutilAPublier[]>; etatMeta; appliquer }`. `relais` rend `null` quand `PUBLIC_API_URL` est vide.

- [ ] **Step 1 : les tests.** Dans `tests/http-mba-publication.test.ts`, remplacer `sources` par `relais: async () => RELAIS` et `OUT` par `ADD_TAG` (Task 5) ; retirer les cas `nonPubliables` et `OutilNonPubliable` ; garder « aperçu sans écrire », « ordre », « arrêt au premier échec », « 409 jamais 500 », « sans numéro », « sans jeton ». Ajouter :

```ts
  it('🔴 sans adresse publique réglée, l’aperçu comme la publication REFUSENT en le disant', async () => {
    const { app, appliques } = monter({ relais: null });
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({ method, url: `/tenants/${TENANT}/mba-publication`, ...h() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/adresse publique/);
    }
    expect(appliques).toEqual([]);
  });
```

(`monter` gagne une option `relais?: RelaisAPublier | null`, `undefined` = `RELAIS`.)

- [ ] **Step 2 : les routes.** Dans `registerMbaPublication`, `planifier` rend `Geste[]` :

```ts
  async function planifier(tenantId: string, pn: string): Promise<Geste[] | null> {
    const relais = await deps.relais(tenantId);
    if (relais === null) return null;
    const [outils, meta] = await Promise.all([deps.outilsExposes(tenantId, pn), deps.etatMeta(tenantId, pn)]);
    return planifierPublication(relais, outils, meta);
  }
  const SANS_ADRESSE = 'L’adresse publique de l’API n’est pas réglée : l’agent de Meta ne saurait pas où appeler.';
```

GET : `const gestes = await planifier(tenant, pn); if (gestes === null) return reply.code(409).send({ error: SANS_ADRESSE }); return reply.code(200).send({ gestes, phoneNumberId: pn });`
POST : idem avant la boucle ; la boucle et son `catch` redeviennent ceux d'avant le 2026-09-21 (plus de
`OutilNonPubliable`, plus de `nonPubliables` dans les réponses).

- [ ] **Step 3 : le câblage**, `src/index.ts`, objet `mbaPublication` :

```ts
    mbaPublication: {
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      relais: async (tenant) => {
        const base = config.PUBLIC_API_URL.trim().replace(/[/]+$/, '');
        if (base === '') return null;
        return { baseUrl: `${base}/mba/relais`, cleAJour: await cleAJour(depsCleRelais, tenant) };
      },
      outilsExposes: async (tenant, pn) => {
        const actifs = await toolCatalog.listActifsConsommateur(tenant, consommateurMba(pn));
        const sortie = [];
        for (const o of actifs) {
          if (o.origin !== 'http' || !o.requestId) continue;
          const req = await agentRequetes.parId(tenant, o.requestId);
          if (!req) continue;
          sortie.push({ id: o.id, name: o.name, description: o.description, nePasUtiliser: o.nePasUtiliser, variables: req.variables });
        }
        return sortie;
      },
      etatMeta: /* inchangé */,
      appliquer: async (tenant, pn, geste, ctx) => {
        const client = await metaFactory.mbaClientForTenant(tenant);
        const base = `${config.PUBLIC_API_URL.trim().replace(/[/]+$/, '')}/mba/relais`;
        const idDuRelais = async (): Promise<string | null> => {
          let vus = ctx.get('connecteurs') as Array<{ id: string; name: string }> | undefined;
          if (!vus) { vus = await client.listConnectors(pn); ctx.set('connecteurs', vus); }
          return vus.find((c) => c.name === NOM_CONNECTEUR_RELAIS)?.id ?? null;
        };
        if (geste.type === 'connecteur_creer') {
          await poserCleNeuve(depsCleRelais, tenant, (cle) => client.createConnector(pn, corpsConnecteurRelais(base, cle)).then(() => {}));
          ctx.delete('connecteurs');
          return;
        }
        if (geste.type === 'connecteur_modifier') {
          await poserCleNeuve(depsCleRelais, tenant, (cle) => client.updateConnector(pn, geste.connecteurId, corpsConnecteurRelais(base, cle)).then(() => {}));
          return;
        }
        if (geste.type === 'connecteur_supprimer') {
          await client.deleteConnector(pn, geste.connecteurId);
          if (geste.oublierCle) await oublierCle(depsCleRelais, tenant);
          ctx.delete('connecteurs');
          return;
        }
        if (geste.type === 'outil_creer' || geste.type === 'outil_modifier') {
          const cid = await idDuRelais();
          if (!cid) throw new Error('le connecteur EngageMe est introuvable chez Meta');
          const o = (await mbaPublicationOutils(tenant, pn)).find((x) => x.id === geste.outilId);
          if (!o) throw new Error(`l’outil « ${geste.nom} » n’est plus exposé`);
          const corps = corpsOutilMeta(o);
          if (geste.type === 'outil_creer') await client.createConnectorTool(pn, cid, corps);
          else await client.updateConnectorTool(pn, cid, geste.outilMetaId, corps);
          return;
        }
        if (geste.type === 'outil_supprimer') await client.deleteConnectorTool(pn, geste.connecteurId, geste.outilMetaId);
      },
    },
```

avec, plus haut dans `main` : `const depsCleRelais: DepsCleRelais = { creerCle: (t) => apiKeyStore.create(t, NOM_CLE_RELAIS, [DROIT_RELAIS]), revoquer: (t, id) => apiKeyStore.revoke(t, id), cleRetenue: (t) => settingsStore.mbaRelaisCleId(t), retenir: (t, id) => settingsStore.setMbaRelaisCleId(t, id), estActive: (t, id) => apiKeyStore.estActive(t, id) };`
et `outilsExposes` extrait en une fonction locale `mbaPublicationOutils(tenant, pn)` réutilisée par `appliquer`.

⚠️ Un outil qui n'est plus trouvable LÈVE au lieu de `return` en silence : le POST s'arrête en 409 et le
dit, au lieu d'annoncer « Publié » pour un geste qui n'a rien fait (c'est le défaut de l'ancien câblage).
⚠️ Vérifier que `createConnector` / `updateConnector` du client acceptent le corps de `corpsConnecteurRelais`
(type d'entrée de `src/mba/client.ts`) ; élargir leur type d'entrée s'il nomme encore `SourceAPublier`.

- [ ] **Step 4 : `web/lib/api-agent-tools.ts`** : `GestePublication.type` perd `secret_poser` ; retirer
  `NonPubliable` et les champs `nonPubliables?` (le front de la Task 8 ne les lit plus).
- [ ] **Step 5 : `npx tsc --noEmit -p .`, `(cd web && npx tsc --noEmit -p .)`, `npm test`.** Attendu : vert.
- [ ] **Step 6 : relire le diff des Tasks 5 à 7 d'un bloc** (rayon de souffle : qui lisait `SourceAPublier`,
  `authTypeMeta`, `corpsConnecteurMeta`, `pertesChezMeta` ? `grep -rn` sur chacun, `src` et `tests`).
- [ ] **Step 7 : corriger la spec** (le geste `cle_poser` n'existe pas, cf. l'écart assumé de la Task 5 ; la
  comparaison NORMALISE au lieu de projeter : une clé non nulle que Meta ajouterait produirait un geste à chaque
  publication, ce que l'essai réel montrera), puis
  UN commit pour les Tasks 5 à 7 (`git add --` des fichiers neufs, `--only`).

---

# LOT 3 : l'écran et la documentation

### Task 8 : l'écran

**Files :**
- Modify : `web/components/BibliothequeOutils.tsx`, `web/app/developers/keys/page.tsx`
- Test : `web/e2e/mba-onglet-outils.spec.ts`

- [ ] **Step 1 : `BibliothequeOutils.tsx`** :
  - retirer l'état `nonPubliables`, la fonction `raison`, le bloc `publication-non-publiables` et les deux textes
    conditionnels (« Publié, sauf... », « Rien d'autre... ») ; retirer `secret_poser` de `LIBELLE_GESTE` et y
    libeller `connecteur_modifier` : `t('renouveler la clé du connecteur Engage Me', 'renew the Engage Me connector key')`.
  - dans `OutilPourMba`, réécrire le commentaire « Meta appelle le système du client EN DIRECT » : c'est Engage Me
    qu'il appelle désormais, et la réponse entière lui est rendue (arbitrage du 2026-09-21).
  - sous le choix de l'appel, afficher ce qu'Engage Me remplira et ce que l'agent de Meta demandera au client :

```tsx
{requeteChoisie && (
  <p className="mt-2 text-xs text-ink-600" data-testid="outil-mba-valeurs">
    {(() => {
      const remplies = requeteChoisie.variables.filter((v) => v.origine.type !== 'modele').map((v) => v.nom);
      const demandees = requeteChoisie.variables.filter((v) => v.origine.type === 'modele').map((v) => v.nom);
      return [
        remplies.length > 0 ? t(`Engage Me remplira lui-même : ${remplies.join(', ')}.`, `Engage Me fills in: ${remplies.join(', ')}.`) : '',
        demandees.length > 0 ? t(` L’agent de Meta les obtiendra du client : ${demandees.join(', ')}.`, ` Meta’s agent gets these from the customer: ${demandees.join(', ')}.`) : '',
      ].join('');
    })()}
  </p>
)}
```

  (`requeteChoisie` = la `RequeteApi` sélectionnée dans le formulaire ; reprendre le nom de la variable d'état
  existante du composant.)
- [ ] **Step 2 : `developers/keys/page.tsx`** : dans la liste, afficher `mba:relais` comme
  `t('relais de l’agent de Meta', 'Meta agent relay')` ; NE PAS l'ajouter à `API_SCOPES` (les cases de création).
- [ ] **Step 3 : e2e** : retirer le test « un outil écarté est NOMMÉ » ; ajouter un cas qui choisit un appel
  portant une variable `champ` et une variable `modele` et vérifie `outil-mba-valeurs`.
- [ ] **Step 4 : `npx playwright test e2e/mba-onglet-outils.spec.ts`** en local (sans base), mutation d'un texte,
  restauration, commit.

### Task 9 : la documentation

- [ ] `features.md` § « Publier chez Meta » : un connecteur Engage Me par espace, les valeurs du mini-CRM
  remplies par Engage Me, la clé « Agent de Meta » visible et révocable, la réponse entière transmise ; retirer
  le paragraphe « Un outil que Meta recevrait incomplet n'est PAS envoyé ».
- [ ] `documentation.md` : remplacer le paragraphe `pertesChezMeta` par l'invariant du relais (espace par la
  clé, en-tête lié à la macro, variables `modele` seules chez Meta, droit non attribuable, clé retenue).
- [ ] `wip.md` : l'état du chantier et l'essai réel dû. `todo.md` : la contrainte de nom des sources
  (`nomPubliableChezMeta` sur l'écran des connecteurs) n'a plus de raison d'être ; la retirer est un chantier à part.
- [ ] Fiche d'aide : `grep -rln "publi" docs/aide/fiches` ; si une fiche décrit la publication chez Meta, la
  corriger et régénérer son empreinte (`npm run aide:carte` si la navigation a bougé).
- [ ] Contrôle des tirets et des octets, commit `--only`.

### Task 10 : déploiement et essai réel

- [ ] `gh run view <id> --json jobs` sur le dernier commit de code : vert, job par job.
- [ ] VPS : `git pull`, `sudo docker compose build mba-api`, `ls` de `0161` DANS l'image, `migrate`, relecture
  en base (`schema_migrations`, `pg_constraint` du CHECK avec `mba`, la colonne dans `information_schema` avec
  son `on delete set null`), PUIS `up -d --build`, conteneurs sains, rechargement NPM, contrôle public
  (`/health`, et `POST /mba/relais/outils/x` sans clé : 401).
- [ ] `CLAUDE.md` : dernière appliquée 0161, prochaine libre 0162, relue en base.
- [ ] **Essai réel par Julien** : réassigner `add_tag` ; corriger au passage sa variable `user` en « champ
  `user_ns` » (elle est aujourd'hui « modèle ») ; « Envoyer » : la confirmation montre la suppression de
  `testUCHAT` et la création d'`EngageMe` ; sur WhatsApp, « ajoute-moi l'étiquette X » ; l'étiquette apparaît
  dans UChat, l'appel dans le journal sous `mba` ; un second « Envoyer » ne produit aucun geste.
- [ ] Lire dans les journaux de `mba-api` la forme de l'en-tête (`mba-relais: en-tete du numero ...`), la
  consigner dans `docs/MBA-API-REFERENCE.md` (format mesuré de `WHATSAPP_PHONE_NUMBER`), puis retirer
  `journaliserForme` du câblage.
