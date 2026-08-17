# Canal RCS, lot 1 : plan d'implémentation

> **Pour les agents :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher.

**But :** faire de mba une application multi-canal, avec le RCS livré de bout en bout derrière un provider
factice, sans dépendre d'aucun compte externe.

**Architecture :** un canal porté en base (`channel`), un adaptateur `RcsProvider` avec une implémentation
factice, un sender RCS branché dans le moteur de campagne par un seam `CampaignSender`, et un bloc de scénario
`rcs_message` à deux sorties dont la branche est résolue par l'executor (le `walk` reste pur).

**Stack :** TypeScript ESM, Fastify 5, Postgres (Supabase), pg-boss, vitest, Next.js 15 App Router,
Tailwind pur.

**Spec :** `docs/superpowers/specs/2026-08-17-canal-rcs-rbm-design.md`

## Contraintes globales

Elles s'appliquent à **toutes** les tâches.

- Branche `main`, commit direct, jamais de worktree ni de branche `claude/*`.
- Aucun secret dans le repo. Rien de sensible dans un bundle client.
- Toute entrée non fiable est validée avec `safeParse`, jamais `parse`, jamais de `as` sur un payload externe.
- Migrations **non auto-appliquées** au déploiement : toute migration qui ajoute une colonne écrite par le
  code doit passer sur le VPS **avant** le déploiement de ce code.
- Frontend : Tailwind pur, pas de shadcn, tokens MM existants (brand/ink/mint/coral/gold/navy).
- Commentaires et messages d'erreur en français, comme le reste du repo.
- Jamais de tiret cadratin ni demi-cadratin dans le code, les commentaires ou les messages.
- Tests : `npx vitest run <fichier>` pour une exécution ciblée, `npm test` pour la suite.
- Valeurs de canal : exactement `'whatsapp'` et `'rcs'`.
- Handles de sortie du bloc RCS : exactement `'sent'` et `'unreachable'`.

## Écart assumé par rapport au spec

Le spec décrit un bloc `rcs_message` à deux sorties sans dire où la branche est décidée. `walk()`
(`src/workflow/engine.ts`) est **pur et synchrone** : il ne peut pas interroger la joignabilité. La branche est
donc résolue par l'executor, via une nouvelle valeur de `WalkRest` : `{ status: 'rcs_send'; nodeId }`. Le walk
reste pur, l'IO reste dans l'executor. Voir tâches 6 et 7.

Second écart : `campaigns.phone_number_id` est `not null` depuis la migration 0003, ce qui n'a aucun sens pour
une campagne RCS. La migration 0056 le rend nullable et ajoute `rcs_agent_id`. Voir tâche 1.

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `db/migrations/0056_channel.sql` | Canal sur conversations, messages, campagnes |
| `db/migrations/0057_rcs.sql` | Agents RCS, opt-out RCS, cache de joignabilité |
| `src/rcs/types.ts` | `RcsOutbound`, `RcsCapabilities`, `RcsProvider` |
| `src/rcs/fake.ts` | `FakeRcsProvider` |
| `src/rcs/reachability.ts` | Joignabilité avec cache et TTL |
| `src/rcs/reachability.pg.ts` | Store Postgres du cache |
| `src/rcs/sender.ts` | `RcsSender` : opt-out, envoi, `messageId` |
| `src/campaign/sender.ts` | Seam `CampaignSender` et sa fabrique par canal |
| `src/workflow/engine.ts` | `WalkRest` + traitement du node dans `walk` |
| `src/workflow/graph.ts` | `rcs_message` dans `WORKFLOW_NODE_TYPES` |
| `src/workflow/executor.ts` | Exécution du bloc, branche `unreachable`, reprise par handle |
| `src/http/campaigns.ts` | Validation du canal à la création |
| `web/` | Sélecteur de canal, bloc dans la palette, badge inbox |

---

### Tâche 1 : Migrations 0056 et 0057

**Fichiers :**
- Créer : `db/migrations/0056_channel.sql`
- Créer : `db/migrations/0057_rcs.sql`

**Interfaces :**
- Produit : les colonnes `channel`, `rcs_agent_id`, `rcs_optout_at` et les tables `rcs_agents`,
  `rcs_capabilities_cache` utilisées par les tâches 3, 4, 5, 8.

- [ ] **Étape 1 : écrire 0056_channel.sql**

```sql
-- 0056_channel.sql : le CANAL devient une dimension de premier ordre.
--
-- `default 'whatsapp'` : tout l'existant reste WhatsApp sans réécriture, la migration est rétrocompatible.
-- L'unique de `conversations` passe à (tenant_id, channel, wa_id) : un même numéro a DEUX fils distincts,
-- un par canal. C'est voulu, ce sont deux conversations différentes pour le contact comme pour l'operateur.
-- `workflow_runs` ne bouge PAS : un run est attaché à un contact, pas à un canal. C'est ce qui permet
-- au bloc RCS de retomber sur un bloc WhatsApp dans le meme scenario.

alter table conversations add column if not exists channel text not null default 'whatsapp';
alter table conversation_messages add column if not exists channel text not null default 'whatsapp';
alter table campaigns add column if not exists channel text not null default 'whatsapp';

alter table conversations drop constraint if exists conversations_tenant_id_wa_id_key;
create unique index if not exists conversations_tenant_channel_wa_idx
  on conversations (tenant_id, channel, wa_id);

-- Une campagne RCS n'a pas de numero Meta. `phone_number_id` etait `not null` depuis 0003.
alter table campaigns alter column phone_number_id drop not null;
```

- [ ] **Étape 2 : écrire 0057_rcs.sql**

```sql
-- 0057_rcs.sql : agents RCS, opt-out par canal, cache de joignabilite.
--
-- Le partenaire RBM est GLOBAL (MessagingMe) : la cle de service account est unique et vit en variable
-- d'environnement serveur. Ce qui isole les tenants, c'est le mapping agent -> tenant de cette table.
-- `client_token_enc` est chiffre avec src/crypto/secretbox.ts : il sert a valider X-Goog-Signature (lot 2).

create table if not exists rcs_agents (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  agent_id         text not null,
  brand_name       text not null,
  webhook_code     text not null unique,
  client_token_enc text not null,
  region           text not null default 'europe',
  status           text not null default 'draft',
  created_at       timestamptz not null default now(),
  unique (tenant_id, agent_id)
);

-- Opt-out PAR CANAL : un contact opte-out du RCS reste joignable en WhatsApp s'il y a consenti.
alter table contacts add column if not exists rcs_optout_at timestamptz;

-- Cache de joignabilite. TTL applicatif de 7 jours : une entree plus vieille est reinterrogee, pas supprimee.
-- Sans ce cache, une campagne de 5 000 numeros ferait 5 000 appels de capacite.
create table if not exists rcs_capabilities_cache (
  agent_id    text not null,
  phone_e164  text not null,
  reachable   boolean not null,
  checked_at  timestamptz not null default now(),
  primary key (agent_id, phone_e164)
);
```

- [ ] **Étape 3 : appliquer les migrations**

Run : `npm run migrate` avec `DATABASE_URL` pointant sur une base de test (Postgres local Docker), sinon sur
Supabase avant tout déploiement de code de ce lot.
Attendu : les deux migrations passent, `schema_migrations` contient `0056` et `0057`.

- [ ] **Étape 4 : commit**

```bash
git add db/migrations/0056_channel.sql db/migrations/0057_rcs.sql
git commit -m "feat(db): canal sur conversations/messages/campagnes + tables RCS (0056, 0057)"
```

---

### Tâche 2 : Modèle de message et adaptateur provider

**Fichiers :**
- Créer : `src/rcs/types.ts`
- Créer : `src/rcs/fake.ts`
- Test : `tests/rcs-fake.test.ts`

**Interfaces :**
- Produit : `RcsOutbound`, `RcsSuggestion`, `RcsCapabilities`, `RcsProvider`, `FakeRcsProvider`.
  Consommés par les tâches 3, 4, 5, 7.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// tests/rcs-fake.test.ts
import { describe, it, expect } from 'vitest';
import { FakeRcsProvider } from '../src/rcs/fake';

describe('FakeRcsProvider', () => {
  it('renvoie null pour un numero declare non joignable', async () => {
    const p = new FakeRcsProvider({ unreachable: new Set(['+33600000001']) });
    expect(await p.capabilities('agent-1', '+33600000001')).toBeNull();
    expect(await p.capabilities('agent-1', '+33600000002')).not.toBeNull();
  });

  it('journalise chaque envoi avec son messageId et le rend tel quel', async () => {
    const p = new FakeRcsProvider();
    const r = await p.send('agent-1', '+33600000002', { kind: 'text', text: 'Bonjour' }, 'msg-42');
    expect(r).toEqual({ messageId: 'msg-42' });
    expect(p.sent).toEqual([
      { agentId: 'agent-1', e164: '+33600000002', msg: { kind: 'text', text: 'Bonjour' }, messageId: 'msg-42' },
    ]);
  });

  it('ignore un messageId deja utilise pour le meme agent (idempotence RBM)', async () => {
    const p = new FakeRcsProvider();
    await p.send('agent-1', '+33600000002', { kind: 'text', text: 'A' }, 'msg-1');
    await p.send('agent-1', '+33600000002', { kind: 'text', text: 'B' }, 'msg-1');
    expect(p.sent).toHaveLength(1);
  });
});
```

- [ ] **Étape 2 : lancer le test pour vérifier qu'il échoue**

Run : `npx vitest run tests/rcs-fake.test.ts`
Attendu : ÉCHEC, `Cannot find module '../src/rcs/fake'`.

- [ ] **Étape 3 : écrire `src/rcs/types.ts`**

```ts
/**
 * Modèle de message RCS et adaptateur provider. PUR : aucun IO, aucun couplage à Google.
 *
 * L'union est FERMÉE et volontairement petite en V1 : ce qui n'est pas ici ne s'envoie pas, plutôt qu'un
 * `unknown` qui laisserait passer n'importe quel payload jusqu'à l'opérateur.
 */
import type { SendResult } from '../meta/types';

export type RcsSuggestion =
  | { kind: 'reply'; text: string; postbackData: string }
  | { kind: 'openUrl'; text: string; url: string; postbackData: string }
  | { kind: 'dial'; text: string; phoneNumber: string; postbackData: string };

export interface RcsCard {
  title: string;
  description?: string;
  mediaUrl?: string;
  suggestions?: RcsSuggestion[];
}

export type RcsOutbound =
  | { kind: 'text'; text: string; suggestions?: RcsSuggestion[] }
  | { kind: 'card'; card: RcsCard }
  | { kind: 'carousel'; cards: RcsCard[] };

/** Ce que l'appareil du destinataire sait faire. Sert à ne pas envoyer un carrousel à un appareil qui ne le
 *  rend pas. En V1 on ne lit que la présence : joignable ou non. */
export interface RcsCapabilities {
  features: string[];
}

export interface RcsProvider {
  /** null = numéro NON joignable en RCS. Ce n'est pas une erreur, c'est une information. */
  capabilities(agentId: string, e164: string): Promise<RcsCapabilities | null>;
  /** `messageId` est fourni par l'appelant : la plateforme RBM ignore un id déjà utilisé pour cet agent,
   *  ce qui rend l'envoi idempotent malgré un rejeu de la file. */
  send(agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult>;
}
```

- [ ] **Étape 4 : écrire `src/rcs/fake.ts`**

```ts
import type { RcsProvider, RcsOutbound, RcsCapabilities } from './types';
import type { SendResult } from '../meta/types';

export interface FakeRcsOptions {
  /** Numéros déclarés non joignables en RCS. */
  unreachable?: Set<string>;
}

export interface FakeSentRecord {
  agentId: string;
  e164: string;
  msg: RcsOutbound;
  messageId: string;
}

/**
 * Provider factice : permet de livrer et de démontrer le canal RCS sans aucun compte ouvert.
 * Reproduit les deux comportements du vrai provider dont le reste du code dépend :
 * la non-joignabilité rendue en `null`, et l'idempotence par `messageId`.
 */
export class FakeRcsProvider implements RcsProvider {
  readonly sent: FakeSentRecord[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly opts: FakeRcsOptions = {}) {}

  async capabilities(_agentId: string, e164: string): Promise<RcsCapabilities | null> {
    if (this.opts.unreachable?.has(e164)) return null;
    return { features: ['RICHCARD_STANDALONE', 'ACTION_CREATE_CALENDAR_EVENT'] };
  }

  async send(agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult> {
    const key = `${agentId}:${messageId}`;
    if (this.seen.has(key)) return { messageId };
    this.seen.add(key);
    this.sent.push({ agentId, e164, msg, messageId });
    return { messageId };
  }
}
```

- [ ] **Étape 5 : lancer le test pour vérifier qu'il passe**

Run : `npx vitest run tests/rcs-fake.test.ts`
Attendu : 3 tests PASS.

- [ ] **Étape 6 : commit**

```bash
git add src/rcs/types.ts src/rcs/fake.ts tests/rcs-fake.test.ts
git commit -m "feat(rcs): modele de message, interface RcsProvider et provider factice"
```

---

### Tâche 3 : Joignabilité avec cache

**Fichiers :**
- Créer : `src/rcs/reachability.ts`
- Créer : `src/rcs/reachability.pg.ts`
- Test : `tests/rcs-reachability.test.ts`

**Interfaces :**
- Consomme : `RcsProvider` (tâche 2).
- Produit : `interface ReachabilityStore { get(agentId, e164): Promise<{reachable: boolean; checkedAt: number} | null>; put(agentId, e164, reachable, atMs): Promise<void> }`
  et `class Reachability { isReachable(agentId, e164): Promise<boolean> }`. Consommés par les tâches 4 et 7.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// tests/rcs-reachability.test.ts
import { describe, it, expect } from 'vitest';
import { Reachability, TTL_MS } from '../src/rcs/reachability';
import type { ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';

class MemStore implements ReachabilityStore {
  readonly rows = new Map<string, { reachable: boolean; checkedAt: number }>();
  async get(agentId: string, e164: string) {
    return this.rows.get(`${agentId}:${e164}`) ?? null;
  }
  async put(agentId: string, e164: string, reachable: boolean, atMs: number) {
    this.rows.set(`${agentId}:${e164}`, { reachable, checkedAt: atMs });
  }
}

describe('Reachability', () => {
  it('interroge le provider une seule fois puis sert le cache', async () => {
    const provider = new FakeRcsProvider();
    let calls = 0;
    const spy = { ...provider, capabilities: async (a: string, p: string) => { calls++; return provider.capabilities(a, p); } };
    const r = new Reachability(spy as typeof provider, new MemStore(), () => 1_000);
    expect(await r.isReachable('agent-1', '+33600000002')).toBe(true);
    expect(await r.isReachable('agent-1', '+33600000002')).toBe(true);
    expect(calls).toBe(1);
  });

  it('reinterroge le provider quand l entree depasse le TTL', async () => {
    const provider = new FakeRcsProvider();
    let calls = 0;
    const spy = { ...provider, capabilities: async (a: string, p: string) => { calls++; return provider.capabilities(a, p); } };
    let now = 1_000;
    const r = new Reachability(spy as typeof provider, new MemStore(), () => now);
    await r.isReachable('agent-1', '+33600000002');
    now = 1_000 + TTL_MS + 1;
    await r.isReachable('agent-1', '+33600000002');
    expect(calls).toBe(2);
  });

  it('met un non joignable en cache aussi', async () => {
    const provider = new FakeRcsProvider({ unreachable: new Set(['+33600000001']) });
    const store = new MemStore();
    const r = new Reachability(provider, store, () => 5_000);
    expect(await r.isReachable('agent-1', '+33600000001')).toBe(false);
    expect(store.rows.get('agent-1:+33600000001')).toEqual({ reachable: false, checkedAt: 5_000 });
  });
});
```

- [ ] **Étape 2 : lancer le test pour vérifier qu'il échoue**

Run : `npx vitest run tests/rcs-reachability.test.ts`
Attendu : ÉCHEC, `Cannot find module '../src/rcs/reachability'`.

- [ ] **Étape 3 : écrire `src/rcs/reachability.ts`**

```ts
import type { RcsProvider } from './types';

/** 7 jours. Un parc mobile ne bascule pas en RCS d'une heure à l'autre, et un appel de capacité par
 *  destinataire sur une campagne de 5 000 numéros est inacceptable. */
export const TTL_MS = 7 * 86_400_000;

export interface ReachabilityStore {
  get(agentId: string, e164: string): Promise<{ reachable: boolean; checkedAt: number } | null>;
  put(agentId: string, e164: string, reachable: boolean, atMs: number): Promise<void>;
}

/** Joignabilité RCS d'un numéro, mise en cache. Une entrée périmée est RÉINTERROGÉE, jamais supprimée :
 *  si le provider tombe, on préfère une réponse un peu vieille à une campagne qui s'arrête. */
export class Reachability {
  constructor(
    private readonly provider: RcsProvider,
    private readonly store: ReachabilityStore,
    private readonly now: () => number = Date.now,
  ) {}

  async isReachable(agentId: string, e164: string): Promise<boolean> {
    const at = this.now();
    const hit = await this.store.get(agentId, e164);
    if (hit && at - hit.checkedAt <= TTL_MS) return hit.reachable;
    try {
      const caps = await this.provider.capabilities(agentId, e164);
      const reachable = caps !== null;
      await this.store.put(agentId, e164, reachable, at);
      return reachable;
    } catch (e) {
      if (hit) return hit.reachable; // périmé mais mieux que rien
      throw e;
    }
  }
}
```

- [ ] **Étape 4 : écrire `src/rcs/reachability.pg.ts`**

```ts
import type { Pool } from 'pg';
import type { ReachabilityStore } from './reachability';

export class PgReachabilityStore implements ReachabilityStore {
  constructor(private readonly pool: Pool) {}

  async get(agentId: string, e164: string): Promise<{ reachable: boolean; checkedAt: number } | null> {
    const r = await this.pool.query<{ reachable: boolean; checked_at: Date }>(
      'select reachable, checked_at from rcs_capabilities_cache where agent_id = $1 and phone_e164 = $2',
      [agentId, e164],
    );
    const row = r.rows[0];
    return row ? { reachable: row.reachable, checkedAt: row.checked_at.getTime() } : null;
  }

  async put(agentId: string, e164: string, reachable: boolean, atMs: number): Promise<void> {
    await this.pool.query(
      `insert into rcs_capabilities_cache (agent_id, phone_e164, reachable, checked_at)
       values ($1, $2, $3, to_timestamp($4 / 1000.0))
       on conflict (agent_id, phone_e164) do update set reachable = excluded.reachable, checked_at = excluded.checked_at`,
      [agentId, e164, reachable, atMs],
    );
  }
}
```

- [ ] **Étape 5 : lancer le test pour vérifier qu'il passe**

Run : `npx vitest run tests/rcs-reachability.test.ts`
Attendu : 3 tests PASS.

- [ ] **Étape 6 : commit**

```bash
git add src/rcs/reachability.ts src/rcs/reachability.pg.ts tests/rcs-reachability.test.ts
git commit -m "feat(rcs): joignabilite avec cache 7 jours et repli sur entree perimee"
```

---

### Tâche 4 : Sender RCS et refus d'opt-out

**Fichiers :**
- Créer : `src/rcs/sender.ts`
- Test : `tests/rcs-sender.test.ts`

**Interfaces :**
- Consomme : `RcsProvider` (tâche 2), `Reachability` (tâche 3).
- Produit :
  `interface RcsOptoutStore { isOptedOut(tenantId: string, e164: string): Promise<boolean> }` et
  `class RcsSender { sendTo(tenantId, agentId, e164, msg, messageId): Promise<SendResult | { skipped: 'not_rcs_reachable' | 'rcs_optout' }> }`.
  Consommés par les tâches 5 et 7.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// tests/rcs-sender.test.ts
import { describe, it, expect } from 'vitest';
import { RcsSender } from '../src/rcs/sender';
import type { RcsOptoutStore } from '../src/rcs/sender';
import { Reachability } from '../src/rcs/reachability';
import type { ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';

class NoStore implements ReachabilityStore {
  async get() { return null; }
  async put() { /* rien */ }
}
class Optout implements RcsOptoutStore {
  constructor(private readonly out: Set<string>) {}
  async isOptedOut(_t: string, e164: string) { return this.out.has(e164); }
}

function make(unreachable: string[] = [], optedOut: string[] = []) {
  const provider = new FakeRcsProvider({ unreachable: new Set(unreachable) });
  const sender = new RcsSender(
    provider,
    new Reachability(provider, new NoStore(), () => 0),
    new Optout(new Set(optedOut)),
  );
  return { provider, sender };
}

describe('RcsSender', () => {
  it('envoie quand le numero est joignable et consentant', async () => {
    const { provider, sender } = make();
    const r = await sender.sendTo('t1', 'agent-1', '+33600000002', { kind: 'text', text: 'Bonjour' }, 'msg-1');
    expect(r).toEqual({ messageId: 'msg-1' });
    expect(provider.sent).toHaveLength(1);
  });

  it('n envoie RIEN a un numero non joignable', async () => {
    const { provider, sender } = make(['+33600000001']);
    const r = await sender.sendTo('t1', 'agent-1', '+33600000001', { kind: 'text', text: 'Bonjour' }, 'msg-1');
    expect(r).toEqual({ skipped: 'not_rcs_reachable' });
    expect(provider.sent).toHaveLength(0);
  });

  it('n envoie RIEN a un contact opte-out, sans meme verifier la joignabilite', async () => {
    const { provider, sender } = make([], ['+33600000002']);
    const r = await sender.sendTo('t1', 'agent-1', '+33600000002', { kind: 'text', text: 'Bonjour' }, 'msg-1');
    expect(r).toEqual({ skipped: 'rcs_optout' });
    expect(provider.sent).toHaveLength(0);
  });
});
```

- [ ] **Étape 2 : lancer le test pour vérifier qu'il échoue**

Run : `npx vitest run tests/rcs-sender.test.ts`
Attendu : ÉCHEC, `Cannot find module '../src/rcs/sender'`.

- [ ] **Étape 3 : écrire `src/rcs/sender.ts`**

```ts
import type { RcsProvider, RcsOutbound } from './types';
import type { Reachability } from './reachability';
import type { SendResult } from '../meta/types';

export interface RcsOptoutStore {
  isOptedOut(tenantId: string, e164: string): Promise<boolean>;
}

export type RcsSendOutcome = SendResult | { skipped: 'not_rcs_reachable' | 'rcs_optout' };

/**
 * Point de passage UNIQUE de tout envoi RCS. Le refus d'opt-out vit ICI, pas chez l'appelant : un appelant
 * qui oublie la vérification est un STOP non respecté, donc un agent suspendu par l'opérateur.
 * L'ordre compte : opt-out d'abord, joignabilité ensuite. Interroger la capacité d'un numéro qui nous a dit
 * STOP est inutile et coûte un appel.
 */
export class RcsSender {
  constructor(
    private readonly provider: RcsProvider,
    private readonly reach: Reachability,
    private readonly optout: RcsOptoutStore,
  ) {}

  async sendTo(
    tenantId: string,
    agentId: string,
    e164: string,
    msg: RcsOutbound,
    messageId: string,
  ): Promise<RcsSendOutcome> {
    if (await this.optout.isOptedOut(tenantId, e164)) return { skipped: 'rcs_optout' };
    if (!(await this.reach.isReachable(agentId, e164))) return { skipped: 'not_rcs_reachable' };
    return this.provider.send(agentId, e164, msg, messageId);
  }
}
```

- [ ] **Étape 4 : lancer le test pour vérifier qu'il passe**

Run : `npx vitest run tests/rcs-sender.test.ts`
Attendu : 3 tests PASS.

- [ ] **Étape 5 : commit**

```bash
git add src/rcs/sender.ts tests/rcs-sender.test.ts
git commit -m "feat(rcs): sender unique avec refus d opt-out puis controle de joignabilite"
```

---

### Tâche 5 : Seam `CampaignSender` et campagne RCS

**Fichiers :**
- Créer : `src/campaign/sender.ts`
- Modifier : `src/campaign/engine.ts` (le site d'envoi, autour de `EngineDeps.sender`)
- Modifier : `src/campaign/types.ts` (ajouter `channel` à `Campaign`)
- Test : `tests/campaign-rcs.test.ts`

**Interfaces :**
- Consomme : `RcsSender` (tâche 4).
- Produit : `interface CampaignSender { sendTo(recipient: Recipient): Promise<SendResult | { skipped: string }> }`.

**Contrainte de non-régression :** `tests/campaign-engine.test.ts` doit continuer à passer sans modification.
Le canal WhatsApp garde exactement le comportement actuel, y compris le quality gate, qui reste WhatsApp
puisque le rating Meta n'a pas d'équivalent RCS.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// tests/campaign-rcs.test.ts
import { describe, it, expect } from 'vitest';
import { makeCampaignSender } from '../src/campaign/sender';
import { RcsSender } from '../src/rcs/sender';
import { Reachability } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';
import type { ReachabilityStore } from '../src/rcs/reachability';

class NoStore implements ReachabilityStore {
  async get() { return null; }
  async put() { /* rien */ }
}

describe('campagne RCS', () => {
  it('envoie le message de la campagne a chaque destinataire joignable', async () => {
    const provider = new FakeRcsProvider({ unreachable: new Set(['+33600000001']) });
    const rcs = new RcsSender(provider, new Reachability(provider, new NoStore(), () => 0), {
      isOptedOut: async () => false,
    });
    const sender = makeCampaignSender({
      channel: 'rcs',
      tenantId: 't1',
      agentId: 'agent-1',
      message: { kind: 'text', text: 'Offre du jour' },
      rcs,
    });

    const ok = await sender.sendTo({ id: 'r1', toE164: '+33600000002' });
    const ko = await sender.sendTo({ id: 'r2', toE164: '+33600000001' });

    expect(ok).toEqual({ messageId: 'r1' });
    expect(ko).toEqual({ skipped: 'not_rcs_reachable' });
    expect(provider.sent.map((s) => s.e164)).toEqual(['+33600000002']);
  });

  it('utilise l id du destinataire comme messageId (idempotence sur rejeu)', async () => {
    const provider = new FakeRcsProvider();
    const rcs = new RcsSender(provider, new Reachability(provider, new NoStore(), () => 0), {
      isOptedOut: async () => false,
    });
    const sender = makeCampaignSender({
      channel: 'rcs', tenantId: 't1', agentId: 'agent-1',
      message: { kind: 'text', text: 'Offre du jour' }, rcs,
    });
    await sender.sendTo({ id: 'r1', toE164: '+33600000002' });
    await sender.sendTo({ id: 'r1', toE164: '+33600000002' });
    expect(provider.sent).toHaveLength(1);
  });
});
```

- [ ] **Étape 2 : lancer le test pour vérifier qu'il échoue**

Run : `npx vitest run tests/campaign-rcs.test.ts`
Attendu : ÉCHEC, `Cannot find module '../src/campaign/sender'`.

- [ ] **Étape 3 : écrire `src/campaign/sender.ts`**

```ts
import type { Recipient } from './types';
import type { SendResult } from '../meta/types';
import type { RcsSender } from '../rcs/sender';
import type { RcsOutbound } from '../rcs/types';

/**
 * Seam d'envoi du moteur de campagne. Le moteur garde TOUS ses garde-fous (fréquence, claim, markResult,
 * recordOutbound) : ils sont déjà canal-agnostiques. Seul l'acte d'envoyer varie, et c'est ce qu'on isole ici
 * plutôt que de dupliquer le moteur par canal.
 *
 * Le `messageId` est l'id du DESTINATAIRE : il est stable d'un rejeu à l'autre, ce qui donne l'idempotence
 * côté opérateur en plus du claim atomique côté base.
 */
export interface CampaignSender {
  sendTo(recipient: Pick<Recipient, 'id' | 'toE164'>): Promise<SendResult | { skipped: string }>;
}

export interface RcsCampaignSenderOpts {
  channel: 'rcs';
  tenantId: string;
  agentId: string;
  message: RcsOutbound;
  rcs: RcsSender;
}

export function makeCampaignSender(o: RcsCampaignSenderOpts): CampaignSender {
  return {
    async sendTo(recipient) {
      return o.rcs.sendTo(o.tenantId, o.agentId, recipient.toE164, o.message, recipient.id);
    },
  };
}
```

- [ ] **Étape 4 : lancer le test pour vérifier qu'il passe**

Run : `npx vitest run tests/campaign-rcs.test.ts`
Attendu : 2 tests PASS.

- [ ] **Étape 5 : ajouter `channel` au type `Campaign`**

Dans `src/campaign/types.ts`, ajouter au type `Campaign` :

```ts
  /** Canal d'envoi. Absent = 'whatsapp' (campagnes créées avant la migration 0056). */
  channel?: 'whatsapp' | 'rcs';
  /** Agent RCS (rcs_agents.agent_id). Requis si channel = 'rcs'. */
  rcsAgentId?: string | null;
  /** Message RCS de la campagne, sérialisé. Requis si channel = 'rcs'. */
  rcsMessage?: unknown;
```

- [ ] **Étape 6 : brancher le seam dans le moteur**

Dans `src/campaign/engine.ts`, ajouter à `EngineDeps` :

```ts
  /** Sender de canal. Présent = le moteur envoie par LUI au lieu de `sender` (chemin WhatsApp historique).
   *  Absent = comportement inchangé, ce qui garantit la non-régression des campagnes existantes. */
  channelSender?: CampaignSender;
```

Au site d'envoi, avant l'appel à `sender.sendMarketing` / `sender.sendTemplate`, insérer :

```ts
      if (deps.channelSender) {
        const out = await deps.channelSender.sendTo(r);
        if ('skipped' in out) {
          await deps.recipients.markResult(r.id, { status: 'skipped', error: out.skipped });
          continue;
        }
        await deps.recipients.markResult(r.id, { status: 'sent', messageId: out.messageId, sentAt: Date.now() });
        continue;
      }
```

- [ ] **Étape 7 : vérifier la non-régression**

Run : `npx vitest run tests/campaign-engine.test.ts tests/campaign-rcs.test.ts`
Attendu : tous PASS, aucun test de `campaign-engine.test.ts` modifié.

- [ ] **Étape 8 : commit**

```bash
git add src/campaign/sender.ts src/campaign/engine.ts src/campaign/types.ts tests/campaign-rcs.test.ts
git commit -m "feat(campagne): seam CampaignSender et envoi de campagne RCS"
```

---

### Tâche 6 : Le bloc `rcs_message` dans le graphe et le walk

**Fichiers :**
- Modifier : `src/workflow/graph.ts:15` (`WORKFLOW_NODE_TYPES`)
- Modifier : `src/workflow/engine.ts` (`WalkRest`, boucle de `walk`)
- Test : `tests/workflow-rcs-node.test.ts`

**Interfaces :**
- Produit : `WalkRest` gagne `{ status: 'rcs_send'; nodeId: string }`. Consommé par la tâche 7.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// tests/workflow-rcs-node.test.ts
import { describe, it, expect } from 'vitest';
import { parseGraph } from '../src/workflow/graph';
import { walk } from '../src/workflow/engine';

const pos = { x: 0, y: 0 };

describe('bloc rcs_message', () => {
  it('est accepte par parseGraph', () => {
    const g = parseGraph({
      nodes: [{ id: 'a', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } }],
      edges: [],
    });
    expect(g?.nodes[0]?.type).toBe('rcs_message');
  });

  it('rend la main a l executor avec le statut rcs_send, sans agir lui-meme', () => {
    const g = parseGraph({
      nodes: [
        { id: 'tag', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'promo' } },
        { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } },
      ],
      edges: [{ id: 'e1', source: 'tag', target: 'r' }],
    })!;
    const res = walk(g, 'tag', { tags: [], fields: {} });
    expect(res.rest).toEqual({ status: 'rcs_send', nodeId: 'r' });
    // Les actions accumulees AVANT le bloc partent quand meme.
    expect(res.actions).toEqual([{ kind: 'tag', tag: 'promo' }]);
  });
});
```

- [ ] **Étape 2 : lancer le test pour vérifier qu'il échoue**

Run : `npx vitest run tests/workflow-rcs-node.test.ts`
Attendu : ÉCHEC, `parseGraph` rend `null` (type de node inconnu).

- [ ] **Étape 3 : déclarer le type de node**

Dans `src/workflow/graph.ts:15`, ajouter `'rcs_message'` à `WORKFLOW_NODE_TYPES` :

```ts
export const WORKFLOW_NODE_TYPES = ['template', 'quick_message', 'inbox', 'flow', 'tag', 'field', 'condition', 'action', 'wait', 'mba_handoff', 'mba_disable', 'rcs_message'] as const;
```

- [ ] **Étape 4 : ajouter le statut au `WalkRest` et le traitement dans `walk`**

Dans `src/workflow/engine.ts`, ajouter à `WalkRest` :

```ts
  | { status: 'rcs_send'; nodeId: string } // envoi RCS : la BRANCHE dépend de la joignabilité, donc d'un IO
```

Dans la boucle de `walk`, juste avant le traitement de `template | flow | quick_message` :

```ts
    if (node.type === 'rcs_message') {
      // `walk` est PUR : il ne peut pas savoir si le numéro est joignable en RCS, c'est un appel réseau.
      // Il rend donc la main à l'executor, qui fera l'IO et reprendra par le handle 'sent' ou 'unreachable'.
      // Les actions déjà accumulées partent maintenant, comme pour un bloc d'attente.
      return { actions, rest: { status: 'rcs_send', nodeId: current } };
    }
```

- [ ] **Étape 5 : lancer les tests pour vérifier qu'ils passent**

Run : `npx vitest run tests/workflow-rcs-node.test.ts tests/workflow-engine.test.ts`
Attendu : PASS. Si un test existant casse sur l'exhaustivité de `WalkRest`, traiter le nouveau cas
explicitement plutôt que d'élargir un type.

- [ ] **Étape 6 : commit**

```bash
git add src/workflow/graph.ts src/workflow/engine.ts tests/workflow-rcs-node.test.ts
git commit -m "feat(scenario): bloc rcs_message et statut de walk rcs_send"
```

---

### Tâche 7 : Exécution du bloc et branche « non joignable »

**Fichiers :**
- Modifier : `src/workflow/executor.ts` (traitement de `rest.status`, et `advance` autour de la ligne 431)
- Test : `tests/workflow-rcs-executor.test.ts`

**Interfaces :**
- Consomme : `WalkRest.rcs_send` (tâche 6), `RcsSender` (tâche 4).
- Produit : `ExecutorDeps.rcs?: { sender: RcsSender; agentIdFor(tenantId: string): Promise<string | null> }`.

Règle de reprise, à respecter exactement :

| Situation | Suite |
|---|---|
| Envoi réussi | Run parqué en `waiting` sur ce bloc. À la réponse du contact, reprise par le handle `'sent'`, repli sur `nextNode` **seulement** si aucune sortie typée n'existe |
| Non joignable | Aucun envoi. Reprise IMMÉDIATE par le handle `'unreachable'`. Si ce handle n'est pas câblé, le run se termine |
| Opt-out | Traité comme non joignable, même branche |
| Aucun agent RCS pour le tenant | Aucun envoi, branche `'unreachable'`, et une ligne de log |

Le repli conditionnel reprend la règle déjà appliquée au bloc `condition` : ne jamais voler l'arête de
l'autre branche quand au moins une sortie typée existe.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// tests/workflow-rcs-executor.test.ts
import { describe, it, expect } from 'vitest';
import { parseGraph } from '../src/workflow/graph';
import { nextNodeByHandle, nextNode } from '../src/workflow/engine';

const pos = { x: 0, y: 0 };

function graph() {
  return parseGraph({
    nodes: [
      { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } },
      { id: 'suite', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'lu' } },
      { id: 'repli', type: 'template', position: pos, data: { templateName: 'relance', language: 'fr' } },
    ],
    edges: [
      { id: 'e1', source: 'r', target: 'suite', sourceHandle: 'sent' },
      { id: 'e2', source: 'r', target: 'repli', sourceHandle: 'unreachable' },
    ],
  })!;
}

describe('branches du bloc rcs_message', () => {
  it('route vers la suite sur le handle sent', () => {
    expect(nextNodeByHandle(graph(), 'r', 'sent')).toBe('suite');
  });

  it('route vers le repli WhatsApp sur le handle unreachable', () => {
    expect(nextNodeByHandle(graph(), 'r', 'unreachable')).toBe('repli');
  });

  it('ne vole PAS l autre branche quand le handle demande n est pas cable', () => {
    const g = parseGraph({
      nodes: [
        { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } },
        { id: 'repli', type: 'template', position: pos, data: { templateName: 'relance', language: 'fr' } },
      ],
      edges: [{ id: 'e2', source: 'r', target: 'repli', sourceHandle: 'unreachable' }],
    })!;
    const hasTyped = g.edges.some((e) => e.source === 'r' && (e.sourceHandle === 'sent' || e.sourceHandle === 'unreachable'));
    const suite = nextNodeByHandle(g, 'r', 'sent') ?? (hasTyped ? null : nextNode(g, 'r'));
    expect(suite).toBeNull();
  });
});
```

- [ ] **Étape 2 : lancer le test pour vérifier qu'il échoue**

Run : `npx vitest run tests/workflow-rcs-executor.test.ts`
Attendu : ÉCHEC sur le premier test (`parseGraph` refuse encore le type si la tâche 6 n'est pas faite),
sinon PASS, ce qui confirme que le routage par handle est déjà fourni par `nextNodeByHandle`.

- [ ] **Étape 3 : ajouter la dépendance RCS à l'executor**

Dans `src/workflow/executor.ts`, ajouter à l'interface de dépendances :

```ts
  /** Canal RCS. Absent = un bloc rcs_message part TOUJOURS sur la branche 'unreachable' (aucun envoi muet). */
  rcs?: {
    sender: RcsSender;
    /** Agent RCS du tenant. null = tenant sans agent configuré. */
    agentIdFor(tenantId: string): Promise<string | null>;
  };
```

- [ ] **Étape 4 : traiter `rest.status === 'rcs_send'` AVANT `restToState`**

Piège à connaître avant d'écrire la ligne : `restToState` (`src/workflow/executor.ts:99`) se termine par un
`return { currentNode: null, status: 'done' }` qui attrape **tout statut non reconnu**. Un `rcs_send` qui
atteindrait `restToState` clôturerait donc le run en silence, sans envoi et sans repli. L'interception doit
venir avant, et `restToState` doit rester inchangé.

Ajouter une méthode privée dans la classe de l'executor :

```ts
  /**
   * Bloc RCS : le seul bloc dont la BRANCHE dépend d'un appel réseau. Le walk a rendu la main ici.
   * Envoi réussi -> on parque le run sur ce bloc comme après un template (statut `waiting`), la suite se
   * jouera dans `advance` par le handle 'sent'. Non joignable, opt-out, agent absent ou bloc non configuré
   * -> aucun envoi, et on repart IMMÉDIATEMENT par le handle 'unreachable'. Handle non câblé -> run terminé.
   */
  private async runRcsNode(
    tenantId: string,
    run: { id: string; workflowId: string },
    waId: string,
    graph: WorkflowGraph,
    nodeId: string,
  ): Promise<boolean> {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const msg = rcsOutboundOf(node);
    const agentId = this.deps.rcs ? await this.deps.rcs.agentIdFor(tenantId) : null;
    let envoye = false;
    if (this.deps.rcs && agentId && msg) {
      const out = await this.deps.rcs.sender.sendTo(tenantId, agentId, waId, msg, `${run.id}:${nodeId}`);
      envoye = !('skipped' in out);
    }
    if (envoye) {
      await this.deps.runs.setState(run.id, restToState({ status: 'waiting', nodeId }, this.now()));
      return true;
    }
    const repli = nextNodeByHandle(graph, nodeId, 'unreachable');
    if (!repli) {
      await this.deps.runs.setState(run.id, { currentNode: null, status: 'done' });
      return false;
    }
    return this.runFrom(tenantId, run, waId, graph, repli);
  }
```

Puis, partout où le résultat de `walk` est transformé en état (avant l'appel à
`this.deps.runs.setState(run.id, restToState(rest, this.now()))`), insérer :

```ts
    if (rest.status === 'rcs_send') return this.runRcsNode(tenantId, run, waId, graph, rest.nodeId);
```

Et la fonction de lecture du bloc, au niveau module :

```ts
/** Message RCS porté par un bloc. null = bloc non configuré : on ne devine pas un contenu, on part en repli. */
function rcsOutboundOf(node: WorkflowNode | undefined): RcsOutbound | null {
  if (!node) return null;
  const text = String(node.data.text ?? '').trim();
  return text ? { kind: 'text', text } : null;
}
```

`runFrom` est la méthode existante qui rejoue le walk depuis un bloc donné : reprendre sa signature exacte
telle qu'elle est dans le fichier au moment de l'implémentation, ne pas la modifier.

Et la fonction de lecture du bloc, dans le même fichier :

```ts
/** Message RCS porté par un bloc. null = bloc non configuré : on ne devine pas un contenu, on part en repli. */
function rcsOutboundOf(node: WorkflowNode | undefined): RcsOutbound | null {
  if (!node) return null;
  const text = String(node.data.text ?? '').trim();
  return text ? { kind: 'text', text } : null;
}
```

- [ ] **Étape 5 : reprendre par le handle `'sent'` dans `advance`**

Dans `advance` (autour de `src/workflow/executor.ts:431`), le bloc courant peut désormais être un
`rcs_message`. Remplacer le calcul de la suite par :

```ts
    const courant = graph.nodes.find((n) => n.id === run.currentNode);
    const handle = courant?.type === 'rcs_message' ? 'sent' : buttonPayload;
    const hasTyped = graph.edges.some(
      (e) => e.source === run.currentNode && (e.sourceHandle === 'sent' || e.sourceHandle === 'unreachable'),
    );
    const suite = (handle ? nextNodeByHandle(graph, run.currentNode, handle) : null)
      ?? (hasTyped ? null : nextNode(graph, run.currentNode));
```

- [ ] **Étape 6 : vérifier qu'aucune garde de fenêtre 24 h ne bloque le bloc**

La fenêtre 24 h est une contrainte Meta, elle n'a pas de sens en RCS. Chercher dans `src/workflow/executor.ts`
les gardes d'ouverture hors fenêtre et confirmer qu'aucune ne s'applique à un `rcs_message` :

Run : `grep -n "fenêtre\|window\|opensOutsideServiceWindow" src/workflow/executor.ts`
Attendu : les gardes trouvées portent sur les envois de template ou sur l'ouverture d'un run de campagne.
Si l'une d'elles couvre tous les blocs d'envoi, la restreindre explicitement au canal WhatsApp et ajouter un
test qui prouve qu'un bloc RCS part hors fenêtre.

- [ ] **Étape 7 : lancer les tests**

Run : `npx vitest run tests/workflow-rcs-executor.test.ts tests/workflow-executor.test.ts`
Attendu : PASS, sans modification des tests d'executor existants.

- [ ] **Étape 8 : commit**

```bash
git add src/workflow/executor.ts tests/workflow-rcs-executor.test.ts
git commit -m "feat(scenario): execution du bloc RCS et branche de repli non joignable"
```

---

### Tâche 8 : Validation du canal à la création de campagne

**Fichiers :**
- Modifier : `src/http/campaigns.ts:98-150`
- Test : `tests/campaign-create.test.ts` (ajouter les cas, ne pas réécrire l'existant)

- [ ] **Étape 1 : écrire les tests qui échouent**

Ajouter dans `tests/campaign-create.test.ts` :

```ts
  it('refuse une campagne RCS sans agent', async () => {
    const r = await post('/tenants/t1/campaigns', {
      channel: 'rcs', name: 'Promo', category: 'marketing', contactIds: ['c1'],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('rcsAgentId');
  });

  it('refuse une campagne RCS qui declenche un scenario (hors perimetre V1)', async () => {
    const r = await post('/tenants/t1/campaigns', {
      channel: 'rcs', name: 'Promo', category: 'marketing', contactIds: ['c1'],
      rcsAgentId: 'agent-1', rcsMessage: { kind: 'text', text: 'Bonjour' }, workflowId: 'w1',
    });
    expect(r.statusCode).toBe(400);
  });

  it('accepte une campagne RCS complete sans phoneNumberId', async () => {
    const r = await post('/tenants/t1/campaigns', {
      channel: 'rcs', name: 'Promo', category: 'marketing', contactIds: ['c1'],
      rcsAgentId: 'agent-1', rcsMessage: { kind: 'text', text: 'Bonjour' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('une campagne sans canal reste WhatsApp et exige phoneNumberId', async () => {
    const r = await post('/tenants/t1/campaigns', {
      name: 'Promo', category: 'marketing', contactIds: ['c1'],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('phoneNumberId');
  });
```

- [ ] **Étape 2 : lancer les tests pour vérifier qu'ils échouent**

Run : `npx vitest run tests/campaign-create.test.ts`
Attendu : les 4 nouveaux cas ÉCHOUENT, les existants passent.

- [ ] **Étape 3 : implémenter la validation**

Dans `src/http/campaigns.ts`, après la validation de `category` et avant celle de `phoneNumberId` :

```ts
    // Canal. Absent = 'whatsapp' : une campagne créée par un client qui ignore le canal garde le comportement
    // historique. Un canal inconnu est rejeté, jamais silencieusement ramené à WhatsApp.
    const channel = b.channel ?? 'whatsapp';
    if (channel !== 'whatsapp' && channel !== 'rcs') {
      return reply.code(400).send({ error: 'channel invalide (whatsapp|rcs)' });
    }
    if (channel === 'rcs') {
      if (!nonEmpty(b.rcsAgentId)) return reply.code(400).send({ error: 'rcsAgentId requis pour une campagne RCS' });
      const msg = rcsOutboundSchema.safeParse(b.rcsMessage);
      if (!msg.success) return reply.code(400).send({ error: 'rcsMessage invalide' });
      if (nonEmpty(b.workflowId)) {
        return reply.code(400).send({ error: "Une campagne RCS envoie un message direct. Le declenchement de scenario par campagne n'est pas disponible sur ce canal." });
      }
    }
```

Et déplacer la validation `phoneNumberId requis` sous une garde `if (channel === 'whatsapp')`.

Ajouter en tête de fichier le schéma zod, avec `safeParse` uniquement :

```ts
const rcsSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), text: z.string().min(1).max(25), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('openUrl'), text: z.string().min(1).max(25), url: z.string().url(), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('dial'), text: z.string().min(1).max(25), phoneNumber: z.string().min(1), postbackData: z.string().min(1) }),
]);
const rcsCardSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  suggestions: z.array(rcsSuggestionSchema).max(4).optional(),
});
const rcsOutboundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(3072), suggestions: z.array(rcsSuggestionSchema).max(11).optional() }),
  z.object({ kind: z.literal('card'), card: rcsCardSchema }),
  z.object({ kind: z.literal('carousel'), cards: z.array(rcsCardSchema).min(2).max(10) }),
]);
```

- [ ] **Étape 4 : lancer les tests**

Run : `npx vitest run tests/campaign-create.test.ts`
Attendu : tous PASS.

- [ ] **Étape 5 : commit**

```bash
git add src/http/campaigns.ts tests/campaign-create.test.ts
git commit -m "feat(api): canal et message RCS a la creation de campagne"
```

---

### Tâche 9 : Interface web

**Fichiers :**
- Modifier : `web/lib/api.ts` (union `WorkflowNodeType` côté front)
- Modifier : `web/lib/nodeMeta.ts` (`NODE_META`, `NODE_ORDER`)
- Modifier : `web/components/WorkflowBuilder.tsx` (rendu du bloc et ses deux poignées)
- Modifier : `web/app/campaigns/page.tsx` (sélecteur de canal)
- Modifier : `web/app/inbox/page.tsx` (badge de canal)

- [ ] **Étape 1 : déclarer le type côté front**

Dans `web/lib/api.ts`, ajouter `'rcs_message'` à l'union `WorkflowNodeType`. Sans cette ligne,
`NODE_META[type]` retombe sur `UNKNOWN_NODE_META` et le bloc s'affiche en « 🧩 Bloc ».

Dans `web/lib/nodeMeta.ts` :

```ts
  rcs_message: { emoji: '📱', label: ['Message RCS', 'RCS message'] },
```

et ajouter `'rcs_message'` à `NODE_ORDER`, juste après `'quick_message'`.

- [ ] **Étape 2 : rendre les deux sorties dans le builder**

Dans `web/components/WorkflowBuilder.tsx`, le bloc `rcs_message` porte deux poignées de sortie :
`sent` (libellé « Envoyé ») et `unreachable` (libellé « Non joignable en RCS »). Reprendre exactement le
patron des poignées `true` / `false` du bloc `condition`, qui résout déjà ce cas.

Son panneau de configuration expose un seul champ en V1 : le texte du message, stocké dans `data.text`.

Tailwind pur, tokens MM existants, aucune dépendance nouvelle.

- [ ] **Étape 3 : ajouter le sélecteur de canal à la création de campagne**

Dans `web/app/campaigns/page.tsx` : deux choix, WhatsApp par défaut. En RCS, masquer le sélecteur de numéro
Meta, afficher le sélecteur d'agent RCS et le champ de message, et masquer le choix de scénario, refusé côté
serveur en V1 (tâche 8). Vérifier aussi `web/lib/campaign-eligibility.ts` : les règles d'éligibilité y sont
écrites pour WhatsApp et ne doivent pas s'appliquer telles quelles à une campagne RCS.

- [ ] **Étape 4 : ajouter le badge de canal dans l'inbox**

Dans `web/app/inbox/page.tsx` : un badge discret sur chaque fil de la liste, puisqu'un même contact peut
désormais avoir deux fils, un par canal.

- [ ] **Étape 5 : vérifier dans le navigateur**

Run : `npm run dev` dans `web/`, puis vérifier les trois écrans.
Attendu : le bloc apparaît avec ses deux sorties et se relie, une campagne RCS se crée sans numéro Meta,
les fils portent leur badge. Aucune erreur en console.

- [ ] **Étape 6 : commit**

```bash
git add web/
git commit -m "feat(web): bloc RCS a deux sorties, canal a la creation de campagne, badge inbox"
```

---

### Tâche 10 : Câblage et vérification de bout en bout

**Fichiers :**
- Modifier : `src/config.ts` (drapeau de provider)
- Modifier : le câblage du serveur et du worker (`src/server.ts`, `src/worker.ts`, `src/workflow/wiring.ts`)

- [ ] **Étape 1 : ajouter le drapeau de provider**

Dans `src/config.ts` :

```ts
  /** Provider RCS actif. 'fake' = provider factice (lot 1, aucun compte requis). 'google' arrive au lot 2. */
  rcsProvider: (process.env.RCS_PROVIDER ?? 'fake') as 'fake' | 'google',
```

Le lot 1 n'accepte que `'fake'`. Toute autre valeur doit lever au démarrage, pas silencieusement retomber
sur le factice : un déploiement qui croit envoyer du vrai RCS et envoie dans le vide est pire qu'un crash.

- [ ] **Étape 2 : câbler `RcsSender` dans le serveur et le worker**

Construire une fois `FakeRcsProvider`, `PgReachabilityStore`, `Reachability`, `RcsSender`, et passer
`deps.rcs` à l'executor ainsi que `channelSender` au lancement d'une campagne dont `channel = 'rcs'`.

- [ ] **Étape 3 : lancer toute la suite**

Run : `npm test`
Attendu : tous les tests passent, y compris les ~380 existants.

- [ ] **Étape 4 : vérification manuelle**

Créer un scénario avec un bloc RCS suivi d'un bloc template WhatsApp sur la sortie « non joignable »,
le déclencher sur un contact, et vérifier dans les logs que le provider factice reçoit l'envoi, puis
que la branche de repli part quand le numéro est déclaré non joignable.

- [ ] **Étape 5 : commit**

```bash
git add src/config.ts src/server.ts src/worker.ts src/workflow/wiring.ts
git commit -m "feat(rcs): cablage du provider factice dans le serveur et le worker"
```

---

## Ce que le lot 1 ne fait pas

Volontairement hors périmètre, traité au lot 2 : `GoogleRbmProvider`, webhook entrant et sa vérification de
signature, traitement du STOP à la réception (seul le refus d'envoi côté sender est fait ici), appareils de
test, vidéo de lancement. Hors périmètre du canal : le SMS, et la cascade automatique pilotée par le moteur.
