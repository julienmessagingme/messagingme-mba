# Node « Envoi de mail » (SMTP) : plan d'implémentation

> **Pour les agents :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher.

**But :** ajouter un node « Envoi de mail » aux Scénarios, qui envoie via une boîte SMTP connectée par le
client (plusieurs possibles), avec des modèles d'email (basique + HTML, variables `{{champ}}`) rédigés dans
Contenu et un destinataire libre (adresse en dur ou variable d'un champ contact).

**Architecture :** deux tables chiffrées/scopées par tenant (`email_accounts`, `email_templates`) calquées sur
`waba_credentials` ; un client SMTP `nodemailer` derrière un résolveur à cache calqué sur
`MetaCredentialsResolver` ; un type de node `email` greffé sur les quatre couches du moteur (graph -> engine ->
executor -> wiring), l'envoi réel étant fait au seul endroit partagé api+worker (`wiring.ts`). Le node est une
action synchrone, non bloquante, best-effort : un envoi raté est journalisé mais n'arrête jamais le parcours.

**Stack :** TypeScript ESM, Fastify 5, Postgres (Supabase), pg-boss, `nodemailer`, vitest, Next.js App Router,
Tailwind pur.

**Spec :** `docs/superpowers/specs/2026-08-18-node-email-smtp-design.md`

## Contraintes globales

Elles s'appliquent à **toutes** les tâches.

- Branche `main`, commit direct, jamais de worktree ni de branche `claude/*`.
- Aucun secret dans le repo, rien de sensible dans un bundle client. Le mot de passe SMTP n'est JAMAIS renvoyé
  au client (ni en clair ni chiffré).
- Toute entrée non fiable (corps de requête HTTP) validée avec `safeParse`, jamais `parse`, jamais de `as` sur
  un payload externe.
- Chiffrement au repos via `src/crypto/secretbox.ts` : `encryptSecret(plaintext, config.ENCRYPTION_KEY)` /
  `decryptSecret(payload, config.ENCRYPTION_KEY)` (mêmes helpers que `waba_credentials`).
- Écritures admin-only + scoping tenant : `scopeTenant(req)` (403 si null) puis `forbidNonAdmin(req, reply)`,
  patron identique à `src/http/workflows.ts:65`. `tenant_id = $1` sur chaque requête.
- Migrations **non auto-appliquées** au déploiement : 0060 doit passer sur le VPS **avant** le déploiement du
  code qui l'attend (cf `DEPLOY.md`).
- Frontend : Tailwind pur, pas de shadcn, tokens MM existants (brand/ink/mint/coral/gold/navy), i18n FR/EN via
  `useT` comme le reste de `web/`.
- Commentaires et messages d'erreur en français.
- Jamais de tiret cadratin « — » ni demi-cadratin « – » dans le code, les commentaires ou les messages.
- Tests : `npx vitest run <fichier>` en ciblé, `npm test` pour la suite ; E2E `npx playwright test <fichier>`.

## Valeurs verrouillées (mêmes chaînes partout)

- Type de node : exactement `'email'`.
- Format de modèle : exactement `'basic'` et `'html'`.
- Destinataire : `to.kind` exactement `'literal'` et `'field'`.

## Écarts assumés par rapport au spec

1. **Le `data` du node reste opaque** (comme les autres types) : `parseGraph` ne le valide pas. La validation
   se fait défensivement dans `actionOf` (rend `null` si incomplet). Le `safeParse` de la contrainte globale
   porte sur les corps de requête des routes `email/*`, pas sur le graphe.
2. **Résolution du destinataire par variable** : elle réutilise l'identité de contact déjà résolue pour l'envoi
   de template (téléphone ou BSUID), pas un nouveau chemin par téléphone.

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `db/migrations/0060_email.sql` | Tables `email_accounts` et `email_templates` |
| `src/email/types.ts` | Types `EmailAccount`, `DecryptedEmailAccount`, `EmailTemplate`, entrées |
| `src/email/account-store.pg.ts` | `PgEmailAccountStore` (CRUD, chiffrement, soft-delete) |
| `src/email/template-store.pg.ts` | `PgEmailTemplateStore` (CRUD, soft-delete) |
| `src/email/smtp.ts` | `buildTransport`, `sendSmtpEmail`, `SmtpMessage` (nodemailer) |
| `src/email/resolver.ts` | `EmailAccountResolver` (cache transport par boîte, invalidation) |
| `src/crm/render.ts` | `renderText` + `escapeHtml` + `contactVars` (substitution `{{champ}}`) |
| `src/http/email.ts` | Routes admin-only : comptes, modèles, test d'envoi |
| `src/workflow/graph.ts` | `'email'` dans `WORKFLOW_NODE_TYPES` |
| `src/workflow/engine.ts` | Action `sendEmail`, `actionOf`, branche non bloquante dans `walk` |
| `src/workflow/executor.ts` | Dep `sendEmail` + dispatch best-effort dans `apply` |
| `src/workflow/wiring.ts` | Implémentation IO de `sendEmail` dans `buildWorkflowRuntime` |
| `src/workflow/node-list.ts` | Résumé du node `email` (Contenu > Blocs) |
| `web/lib/api.ts` | `'email'` dans `WorkflowNodeType` + client comptes/modèles |
| `web/lib/nodeMeta.ts` | Métadonnées du node `email` (gaté) |
| `web/components/AccountMenu.tsx` | Entrée « Boîtes email » (admin) |
| `web/app/settings/email/page.tsx` | Écran de connexions SMTP |
| `web/app/contenu/.../EmailTemplates.tsx` | Section « Modèles d'email » dans Contenu |
| `web/components/WorkflowBuilder.tsx` | Config du node `email` + gating |
| `web/app/workflows/page.tsx` | Passe `emailEnabled` (au moins une boîte) |

---

### Task 1 : Migration 0060 (tables email)

**Fichiers :**
- Créer : `db/migrations/0060_email.sql`

**Interfaces :**
- Produit : les tables `email_accounts` et `email_templates` utilisées par les tâches 2, 3, 6, 8.

- [ ] **Étape 1 : écrire `0060_email.sql`**

```sql
-- 0060_email.sql : boîtes SMTP et modèles d'email par tenant, pour le node « Envoi de mail ».
-- password_enc chiffré au repos (AES-256-GCM, clé ENCRYPTION_KEY) via src/crypto/secretbox.ts, comme
-- waba_credentials. Suppression douce (deleted_at) pour ne pas casser un node qui référence une boîte/modèle
-- retiré : le node devient inerte, le graphe reste valide.
create table if not exists email_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  label         text not null,
  host          text not null,
  port          integer not null,
  secure        boolean not null default true,
  username      text not null,
  password_enc  text not null,
  from_address  text not null,
  from_name     text,
  reply_to      text,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists email_accounts_tenant_label
  on email_accounts (tenant_id, label) where deleted_at is null;
create index if not exists email_accounts_tenant
  on email_accounts (tenant_id) where deleted_at is null;

create table if not exists email_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  format      text not null check (format in ('basic', 'html')),
  subject     text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists email_templates_tenant_name
  on email_templates (tenant_id, name) where deleted_at is null;
create index if not exists email_templates_tenant
  on email_templates (tenant_id) where deleted_at is null;
```

- [ ] **Étape 2 : vérifier le numéro libre**

Run : `ls db/migrations | tail -5`
Attendu : `0059_drop_return_behavior.sql` est le dernier. Si un autre `0060_*` est apparu (autre session),
renuméroter en `0061` et propager le nom dans tout le plan avant de continuer.

- [ ] **Étape 3 : appliquer sur une base de dev et vérifier**

Run : `npm run migrate` (ou la commande de migration du repo, cf `DEPLOY.md`)
Attendu : `0060_email` appliquée, aucune erreur, les deux tables et leurs index existent.

- [ ] **Étape 4 : commit**

```bash
git add db/migrations/0060_email.sql
git commit -m "feat(email): migration 0060, tables email_accounts et email_templates"
```

---

### Task 2 : Types + PgEmailAccountStore

**Fichiers :**
- Créer : `src/email/types.ts`
- Créer : `src/email/account-store.pg.ts`
- Test : `tests/email-account-store.test.ts` (intégration Postgres)

**Interfaces :**
- Consomme : table `email_accounts` (Task 1), `encryptSecret`/`decryptSecret` (`src/crypto/secretbox.ts`),
  `config.ENCRYPTION_KEY`.
- Produit :
  - `EmailAccount`, `DecryptedEmailAccount`, `EmailAccountInput`, `EmailAccountUpdate` (types.ts).
  - `PgEmailAccountStore` avec :
    `list(tenantId): Promise<EmailAccount[]>` ·
    `getById(tenantId, id): Promise<EmailAccount | null>` ·
    `getDecrypted(tenantId, id): Promise<DecryptedEmailAccount | null>` ·
    `create(tenantId, input: EmailAccountInput): Promise<EmailAccount>` ·
    `update(tenantId, id, patch: EmailAccountUpdate): Promise<EmailAccount | null>` ·
    `softDelete(tenantId, id): Promise<boolean>` ·
    `markVerified(tenantId, id): Promise<void>`.

- [ ] **Étape 1 : écrire les types**

```ts
// src/email/types.ts
export interface EmailAccount {
  id: string;
  tenantId: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** En mémoire uniquement, jamais sérialisé vers le client. */
export interface DecryptedEmailAccount extends EmailAccount {
  password: string;
}

export interface EmailAccountInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
}

/** Mise à jour : le mot de passe n'est re-chiffré que s'il est fourni. */
export type EmailAccountUpdate = Partial<EmailAccountInput>;
```

- [ ] **Étape 2 : écrire le test d'intégration (échoue d'abord)**

Réutiliser le harnais Postgres des autres stores (pool de test + tenant jetable ; voir un
`tests/*-store.test.ts` existant pour le `beforeAll`/`afterAll`).

```ts
// tests/email-account-store.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgEmailAccountStore } from '../src/email/account-store.pg';
// ... importer le pool de test + créer un tenant jetable comme les autres stores

describe('PgEmailAccountStore', () => {
  it('crée une boîte, chiffre le mot de passe, ne le rend jamais en clair au list/getById', async () => {
    const store = new PgEmailAccountStore(pool);
    const acc = await store.create(tenantId, {
      label: 'support', host: 'ssl0.ovh.net', port: 465, secure: true,
      username: 'support@exemple.fr', password: 's3cr3t', fromAddress: 'support@exemple.fr',
    });
    expect(acc.id).toBeTruthy();
    expect((acc as Record<string, unknown>).password).toBeUndefined();
    const row = await pool.query('select password_enc from email_accounts where id=$1', [acc.id]);
    expect(row.rows[0].password_enc).not.toContain('s3cr3t');
    const dec = await store.getDecrypted(tenantId, acc.id);
    expect(dec?.password).toBe('s3cr3t');
  });

  it('isole par tenant et masque les supprimés', async () => {
    const store = new PgEmailAccountStore(pool);
    const a = await store.create(tenantId, baseInput('a'));
    await store.softDelete(tenantId, a.id);
    expect(await store.getById(tenantId, a.id)).toBeNull();
    expect(await store.getById(otherTenantId, a.id)).toBeNull();
  });
});
```

Run : `npx vitest run tests/email-account-store.test.ts`
Attendu : FAIL (`PgEmailAccountStore` introuvable).

- [ ] **Étape 3 : écrire le store**

```ts
// src/email/account-store.pg.ts
import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import { config } from '../config';
import type { EmailAccount, DecryptedEmailAccount, EmailAccountInput, EmailAccountUpdate } from './types';

const COLS = `id, tenant_id, label, host, port, secure, username, from_address, from_name, reply_to,
  verified_at, created_at`;

function toAccount(r: Record<string, unknown>): EmailAccount {
  return {
    id: r.id as string, tenantId: r.tenant_id as string, label: r.label as string,
    host: r.host as string, port: r.port as number, secure: r.secure as boolean,
    username: r.username as string, fromAddress: r.from_address as string,
    fromName: (r.from_name as string) ?? null, replyTo: (r.reply_to as string) ?? null,
    verifiedAt: r.verified_at ? new Date(r.verified_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export class PgEmailAccountStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<EmailAccount[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from email_accounts where tenant_id=$1 and deleted_at is null order by created_at desc`,
      [tenantId],
    );
    return rows.map(toAccount);
  }

  async getById(tenantId: string, id: string): Promise<EmailAccount | null> {
    const { rows } = await this.pool.query(
      `select ${COLS} from email_accounts where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async getDecrypted(tenantId: string, id: string): Promise<DecryptedEmailAccount | null> {
    const { rows } = await this.pool.query(
      `select ${COLS}, password_enc from email_accounts where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    if (!rows[0]) return null;
    return { ...toAccount(rows[0]), password: decryptSecret(rows[0].password_enc as string, config.ENCRYPTION_KEY) };
  }

  async create(tenantId: string, input: EmailAccountInput): Promise<EmailAccount> {
    const { rows } = await this.pool.query(
      `insert into email_accounts
         (tenant_id, label, host, port, secure, username, password_enc, from_address, from_name, reply_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${COLS}`,
      [tenantId, input.label, input.host, input.port, input.secure, input.username,
       encryptSecret(input.password, config.ENCRYPTION_KEY), input.fromAddress,
       input.fromName ?? null, input.replyTo ?? null],
    );
    return toAccount(rows[0]);
  }

  async update(tenantId: string, id: string, patch: EmailAccountUpdate): Promise<EmailAccount | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const push = (col: string, v: unknown): void => { sets.push(`${col}=$${i++}`); vals.push(v); };
    if (patch.label !== undefined) push('label', patch.label);
    if (patch.host !== undefined) push('host', patch.host);
    if (patch.port !== undefined) push('port', patch.port);
    if (patch.secure !== undefined) push('secure', patch.secure);
    if (patch.username !== undefined) push('username', patch.username);
    if (patch.password !== undefined) push('password_enc', encryptSecret(patch.password, config.ENCRYPTION_KEY));
    if (patch.fromAddress !== undefined) push('from_address', patch.fromAddress);
    if (patch.fromName !== undefined) push('from_name', patch.fromName);
    if (patch.replyTo !== undefined) push('reply_to', patch.replyTo);
    if (sets.length === 0) return this.getById(tenantId, id);
    sets.push('updated_at=now()');
    vals.push(tenantId, id);
    const { rows } = await this.pool.query(
      `update email_accounts set ${sets.join(', ')}
        where tenant_id=$${i++} and id=$${i} and deleted_at is null returning ${COLS}`,
      vals,
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async softDelete(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update email_accounts set deleted_at=now() where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async markVerified(tenantId: string, id: string): Promise<void> {
    await this.pool.query(
      `update email_accounts set verified_at=now() where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
  }
}
```

- [ ] **Étape 4 : lancer le test, il passe**

Run : `npx vitest run tests/email-account-store.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
git add src/email/types.ts src/email/account-store.pg.ts tests/email-account-store.test.ts
git commit -m "feat(email): store des boîtes SMTP, mot de passe chiffré, scopé tenant"
```

---

### Task 3 : PgEmailTemplateStore

**Fichiers :**
- Créer : `src/email/template-store.pg.ts`
- Test : `tests/email-template-store.test.ts` (intégration Postgres)

**Interfaces :**
- Consomme : table `email_templates` (Task 1), types (Task 2 pour le style, mais ajouter ici) :
  ajouter à `src/email/types.ts` : `EmailTemplateFormat = 'basic' | 'html'`, `EmailTemplate`,
  `EmailTemplateInput`, `EmailTemplateUpdate = Partial<EmailTemplateInput>`.
- Produit : `PgEmailTemplateStore` avec `list/getById/create/update/softDelete` (mêmes signatures que le store
  de comptes, sans chiffrement).

- [ ] **Étape 1 : ajouter les types de modèle à `src/email/types.ts`**

```ts
export type EmailTemplateFormat = 'basic' | 'html';
export interface EmailTemplate {
  id: string; tenantId: string; name: string; format: EmailTemplateFormat;
  subject: string; body: string; createdAt: string; updatedAt: string;
}
export interface EmailTemplateInput { name: string; format: EmailTemplateFormat; subject: string; body: string; }
export type EmailTemplateUpdate = Partial<EmailTemplateInput>;
```

- [ ] **Étape 2 : test d'intégration (échoue d'abord)**

```ts
// tests/email-template-store.test.ts
import { describe, it, expect } from 'vitest';
import { PgEmailTemplateStore } from '../src/email/template-store.pg';
// ... même harnais Postgres + tenant jetable

describe('PgEmailTemplateStore', () => {
  it('crée, liste, isole par tenant, masque les supprimés', async () => {
    const store = new PgEmailTemplateStore(pool);
    const t = await store.create(tenantId, { name: 'Confirmation', format: 'basic', subject: 'Bonjour {{prenom}}', body: 'Merci.' });
    expect(t.format).toBe('basic');
    expect((await store.list(tenantId)).some((x) => x.id === t.id)).toBe(true);
    await store.softDelete(tenantId, t.id);
    expect(await store.getById(tenantId, t.id)).toBeNull();
    expect(await store.getById(otherTenantId, t.id)).toBeNull();
  });
});
```

Run : `npx vitest run tests/email-template-store.test.ts`
Attendu : FAIL (`PgEmailTemplateStore` introuvable).

- [ ] **Étape 3 : écrire le store** (même forme que `PgEmailAccountStore`, sans chiffrement)

```ts
// src/email/template-store.pg.ts
import type { Pool } from 'pg';
import type { EmailTemplate, EmailTemplateInput, EmailTemplateUpdate } from './types';

const COLS = `id, tenant_id, name, format, subject, body, created_at, updated_at`;

function toTemplate(r: Record<string, unknown>): EmailTemplate {
  return {
    id: r.id as string, tenantId: r.tenant_id as string, name: r.name as string,
    format: r.format as EmailTemplate['format'], subject: r.subject as string, body: r.body as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export class PgEmailTemplateStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<EmailTemplate[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from email_templates where tenant_id=$1 and deleted_at is null order by created_at desc`,
      [tenantId],
    );
    return rows.map(toTemplate);
  }

  async getById(tenantId: string, id: string): Promise<EmailTemplate | null> {
    const { rows } = await this.pool.query(
      `select ${COLS} from email_templates where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return rows[0] ? toTemplate(rows[0]) : null;
  }

  async create(tenantId: string, input: EmailTemplateInput): Promise<EmailTemplate> {
    const { rows } = await this.pool.query(
      `insert into email_templates (tenant_id, name, format, subject, body)
       values ($1,$2,$3,$4,$5) returning ${COLS}`,
      [tenantId, input.name, input.format, input.subject, input.body],
    );
    return toTemplate(rows[0]);
  }

  async update(tenantId: string, id: string, patch: EmailTemplateUpdate): Promise<EmailTemplate | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const push = (col: string, v: unknown): void => { sets.push(`${col}=$${i++}`); vals.push(v); };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.format !== undefined) push('format', patch.format);
    if (patch.subject !== undefined) push('subject', patch.subject);
    if (patch.body !== undefined) push('body', patch.body);
    if (sets.length === 0) return this.getById(tenantId, id);
    sets.push('updated_at=now()');
    vals.push(tenantId, id);
    const { rows } = await this.pool.query(
      `update email_templates set ${sets.join(', ')}
        where tenant_id=$${i++} and id=$${i} and deleted_at is null returning ${COLS}`,
      vals,
    );
    return rows[0] ? toTemplate(rows[0]) : null;
  }

  async softDelete(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update email_templates set deleted_at=now() where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return (rowCount ?? 0) > 0;
  }
}
```

- [ ] **Étape 4 : lancer le test, il passe**

Run : `npx vitest run tests/email-template-store.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
git add src/email/template-store.pg.ts tests/email-template-store.test.ts src/email/types.ts
git commit -m "feat(email): store des modèles d'email, scopé tenant, soft-delete"
```

---

### Task 4 : Substitution de variables `renderText`

**Fichiers :**
- Créer : `src/crm/render.ts`
- Test : `tests/render.test.ts` (unitaire, pur)

**Interfaces :**
- Consomme : `ResolvableContact` de `src/crm/template.ts`.
- Produit :
  - `escapeHtml(s: string): string`
  - `renderText(text: string, vars: Record<string, string | null | undefined>, opts: { html: boolean }): string`
  - `contactVars(contact: ResolvableContact): Record<string, string | null>` (attributs système + `fields`).

- [ ] **Étape 1 : test unitaire (échoue d'abord)**

```ts
// tests/render.test.ts
import { describe, it, expect } from 'vitest';
import { renderText, escapeHtml } from '../src/crm/render';

describe('renderText', () => {
  it('remplace les variables présentes et vide les absentes', () => {
    expect(renderText('Bonjour {{prenom}} {{nom}}', { prenom: 'Léa' }, { html: false }))
      .toBe('Bonjour Léa ');
  });
  it('échappe les valeurs en HTML mais pas le corps du modèle', () => {
    expect(renderText('<b>{{v}}</b>', { v: '<script>x</script>' }, { html: true }))
      .toBe('<b>&lt;script&gt;x&lt;/script&gt;</b>');
  });
  it('n’échappe pas en mode texte', () => {
    expect(renderText('{{v}}', { v: 'a & b' }, { html: false })).toBe('a & b');
  });
  it('tolère les espaces dans les accolades', () => {
    expect(renderText('{{ prenom }}', { prenom: 'Léa' }, { html: false })).toBe('Léa');
  });
});
```

Run : `npx vitest run tests/render.test.ts`
Attendu : FAIL (`renderText` introuvable).

- [ ] **Étape 2 : écrire `render.ts`**

```ts
// src/crm/render.ts
import type { ResolvableContact } from './template';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Remplace les {{clef}} par la valeur fournie. Valeur absente -> chaîne vide. En HTML, la valeur est échappée. */
export function renderText(
  text: string,
  vars: Record<string, string | null | undefined>,
  opts: { html: boolean },
): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const raw = vars[key];
    if (raw == null) return '';
    return opts.html ? escapeHtml(raw) : raw;
  });
}

/** Table des variables d'un contact : attributs système + champs libres. Aligner les clés système sur le
 * sélecteur de variables du builder (mêmes noms que pour les templates WhatsApp). */
export function contactVars(contact: ResolvableContact): Record<string, string | null> {
  const out: Record<string, string | null> = {
    phone: contact.phone_e164 ?? null,
    phone_e164: contact.phone_e164 ?? null,
    bsuid: contact.bsuid ?? null,
    profile_name: contact.profile_name ?? null,
  };
  for (const [k, v] of Object.entries(contact.fields ?? {})) {
    out[k] = v == null ? null : String(v);
  }
  return out;
}
```

- [ ] **Étape 3 : lancer le test, il passe**

Run : `npx vitest run tests/render.test.ts`
Attendu : PASS.

- [ ] **Étape 4 : commit**

```bash
git add src/crm/render.ts tests/render.test.ts
git commit -m "feat(email): substitution de variables {{champ}} avec échappement HTML"
```

---

### Task 5 : Client SMTP + résolveur (nodemailer)

**Fichiers :**
- Modifier : `package.json` (dépendance `nodemailer` + `@types/nodemailer`)
- Créer : `src/email/smtp.ts`
- Créer : `src/email/resolver.ts`
- Test : `tests/email-smtp.test.ts` (unitaire, transport injecté)

**Interfaces :**
- Consomme : `DecryptedEmailAccount` (Task 2).
- Produit :
  - `SmtpMessage { to; subject; text?; html? }`
  - `buildTransport(account: DecryptedEmailAccount): Transporter`
  - `sendSmtpEmail(transport: Transporter, account: DecryptedEmailAccount, msg: SmtpMessage): Promise<void>`
  - `EmailAccountResolver` avec `getTransport(tenantId, accountId): Promise<{ transport: Transporter; account: DecryptedEmailAccount } | null>` et `invalidate(accountId: string): void`.

- [ ] **Étape 1 : ajouter la dépendance**

Run : `npm i nodemailer && npm i -D @types/nodemailer`
Attendu : `nodemailer` dans `dependencies`, `@types/nodemailer` dans `devDependencies`.

- [ ] **Étape 2 : test unitaire (échoue d'abord)**

```ts
// tests/email-smtp.test.ts
import { describe, it, expect, vi } from 'vitest';
import { sendSmtpEmail } from '../src/email/smtp';
import { EmailAccountResolver } from '../src/email/resolver';

const account = {
  id: 'a1', tenantId: 't1', label: 'support', host: 'h', port: 465, secure: true,
  username: 'u', password: 'p', fromAddress: 'support@ex.fr', fromName: 'Support',
  replyTo: 'rep@ex.fr', verifiedAt: null, createdAt: 'now',
};

describe('sendSmtpEmail', () => {
  it('compose le from avec nom, le replyTo, et transmet corps texte/html', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await sendSmtpEmail({ sendMail } as never, account, { to: 'x@ex.fr', subject: 'S', html: '<b>h</b>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: 'Support', address: 'support@ex.fr' },
      to: 'x@ex.fr', replyTo: 'rep@ex.fr', subject: 'S', html: '<b>h</b>',
    }));
  });
});

describe('EmailAccountResolver', () => {
  it('met en cache le transport par boîte et l’invalide', async () => {
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });
    await r.getTransport('t1', 'a1');
    await r.getTransport('t1', 'a1');
    expect(build).toHaveBeenCalledTimes(1);
    r.invalidate('a1');
    await r.getTransport('t1', 'a1');
    expect(build).toHaveBeenCalledTimes(2);
  });
});
```

Run : `npx vitest run tests/email-smtp.test.ts`
Attendu : FAIL (`smtp`/`resolver` introuvables).

- [ ] **Étape 3 : écrire `smtp.ts`**

```ts
// src/email/smtp.ts
import nodemailer, { type Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';

export interface SmtpMessage { to: string; subject: string; text?: string; html?: string; }

export function buildTransport(account: DecryptedEmailAccount): Transporter {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: account.password },
  });
}

export async function sendSmtpEmail(
  transport: Transporter,
  account: DecryptedEmailAccount,
  msg: SmtpMessage,
): Promise<void> {
  await transport.sendMail({
    from: account.fromName ? { name: account.fromName, address: account.fromAddress } : account.fromAddress,
    to: msg.to,
    replyTo: account.replyTo ?? undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
```

- [ ] **Étape 4 : écrire `resolver.ts`**

```ts
// src/email/resolver.ts
import type { Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';

export interface EmailAccountResolverDeps {
  getDecrypted(tenantId: string, accountId: string): Promise<DecryptedEmailAccount | null>;
  buildTransport(account: DecryptedEmailAccount): Transporter;
}

/** Cache le transport par boîte (une connexion SMTP réutilisable). Invalidation explicite à chaque
 * écriture/suppression de la boîte. */
export class EmailAccountResolver {
  private readonly cache = new Map<string, { transport: Transporter; account: DecryptedEmailAccount }>();
  constructor(private readonly deps: EmailAccountResolverDeps) {}

  async getTransport(
    tenantId: string,
    accountId: string,
  ): Promise<{ transport: Transporter; account: DecryptedEmailAccount } | null> {
    const hit = this.cache.get(accountId);
    if (hit) return hit;
    const account = await this.deps.getDecrypted(tenantId, accountId);
    if (!account) return null;
    const entry = { transport: this.deps.buildTransport(account), account };
    this.cache.set(accountId, entry);
    return entry;
  }

  invalidate(accountId: string): void {
    const hit = this.cache.get(accountId);
    if (hit) { try { (hit.transport as { close?: () => void }).close?.(); } catch { /* best-effort */ } }
    this.cache.delete(accountId);
  }
}
```

- [ ] **Étape 5 : lancer le test, il passe**

Run : `npx vitest run tests/email-smtp.test.ts`
Attendu : PASS.

- [ ] **Étape 6 : commit**

```bash
git add package.json package-lock.json src/email/smtp.ts src/email/resolver.ts tests/email-smtp.test.ts
git commit -m "feat(email): client SMTP nodemailer + résolveur de transport à cache"
```

---

### Task 6 : Routes HTTP (comptes, modèles, test d'envoi)

**Fichiers :**
- Créer : `src/http/email.ts`
- Modifier : le point de montage des routes (là où `workflowsRoutes` est enregistré ; voir `src/http/workflows.ts`
  et son `register` dans l'app, typiquement `src/index.ts`)
- Modifier : `src/index.ts` (instancier `PgEmailAccountStore`, `PgEmailTemplateStore`, `EmailAccountResolver`)
- Test : `tests/http-email.test.ts` (intégration : RBAC, isolation, masquage du mot de passe)

**Interfaces :**
- Consomme : stores (Tasks 2, 3), `EmailAccountResolver` (Task 5), `sendSmtpEmail` (Task 5),
  `scopeTenant` (`src/http/scope.ts`), `forbidNonAdmin` (`src/auth/middleware.ts`).
- Produit : routes montées sous `/tenants/:t/email/*` :
  - `GET/POST /accounts`, `PATCH/DELETE /accounts/:id`, `POST /accounts/:id/test`
  - `GET/POST /templates`, `PATCH/DELETE /templates/:id`

- [ ] **Étape 1 : test d'intégration (échoue d'abord)**

Réutiliser le harnais Fastify des autres tests de routes (`buildApp` + jetons admin/agent ; voir
`tests/http-mba.test.ts` ou `tests/http-workflows*` pour le montage et les jetons).

```ts
// tests/http-email.test.ts
import { describe, it, expect } from 'vitest';
// ... buildApp + tokens admin/agent + tenant jetable

describe('routes email', () => {
  it('un agent (non-admin) ne peut pas créer une boîte (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/tenants/${tenantId}/email/accounts`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { label: 'x', host: 'h', port: 465, secure: true, username: 'u', password: 'p', fromAddress: 'a@b.fr' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('crée puis liste sans jamais renvoyer le mot de passe', async () => {
    const create = await app.inject({
      method: 'POST', url: `/tenants/${tenantId}/email/accounts`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { label: 'support', host: 'h', port: 465, secure: true, username: 'u', password: 'p', fromAddress: 'a@b.fr' },
    });
    expect(create.statusCode).toBe(200);
    const body = create.json();
    expect(body.password).toBeUndefined();
    expect(body.password_enc).toBeUndefined();
    expect(body.hasPassword).toBe(true);
  });

  it('rejette un corps invalide en 400 (safeParse)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/tenants/${tenantId}/email/accounts`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { label: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

Run : `npx vitest run tests/http-email.test.ts`
Attendu : FAIL (routes non montées -> 404).

- [ ] **Étape 2 : écrire `src/http/email.ts`**

```ts
// src/http/email.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scopeTenant } from './scope';
import { forbidNonAdmin } from '../auth/middleware';
import type { PgEmailAccountStore } from '../email/account-store.pg';
import type { PgEmailTemplateStore } from '../email/template-store.pg';
import type { EmailAccountResolver } from '../email/resolver';
import { sendSmtpEmail } from '../email/smtp';
import type { EmailAccount } from '../email/types';

const accountCreate = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1),
  fromAddress: z.string().email(),
  fromName: z.string().nullish(),
  replyTo: z.string().email().nullish(),
});
const accountPatch = accountCreate.partial();
const templateCreate = z.object({
  name: z.string().min(1),
  format: z.enum(['basic', 'html']),
  subject: z.string().min(1),
  body: z.string().min(1),
});
const templatePatch = templateCreate.partial();
const testBody = z.object({ to: z.string().email() });

/** La boîte renvoyée au client ne porte JAMAIS le secret. */
function publicAccount(a: EmailAccount): EmailAccount & { hasPassword: true } {
  return { ...a, hasPassword: true };
}

export interface EmailRoutesDeps {
  accounts: PgEmailAccountStore;
  templates: PgEmailTemplateStore;
  resolver: EmailAccountResolver;
}

export function registerEmailRoutes(app: FastifyInstance, deps: EmailRoutesDeps): void {
  // ---- Boîtes SMTP ----
  app.get('/tenants/:t/email/accounts', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    return (await deps.accounts.list(tenantId)).map(publicAccount);
  });

  app.post('/tenants/:t/email/accounts', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    if (forbidNonAdmin(req, reply)) return reply;
    const parsed = accountCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalide', details: parsed.error.flatten() });
    return publicAccount(await deps.accounts.create(tenantId, parsed.data));
  });

  app.patch('/tenants/:t/email/accounts/:id', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    if (forbidNonAdmin(req, reply)) return reply;
    const parsed = accountPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalide', details: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    const updated = await deps.accounts.update(tenantId, id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'introuvable' });
    deps.resolver.invalidate(id);
    return publicAccount(updated);
  });

  app.delete('/tenants/:t/email/accounts/:id', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    if (forbidNonAdmin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const ok = await deps.accounts.softDelete(tenantId, id);
    deps.resolver.invalidate(id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'introuvable' });
  });

  app.post('/tenants/:t/email/accounts/:id/test', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    if (forbidNonAdmin(req, reply)) return reply;
    const parsed = testBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalide' });
    const { id } = req.params as { id: string };
    const resolved = await deps.resolver.getTransport(tenantId, id);
    if (!resolved) return reply.code(404).send({ error: 'introuvable' });
    try {
      await sendSmtpEmail(resolved.transport, resolved.account, {
        to: parsed.data.to, subject: 'Test MessagingMe', text: 'Ceci est un test de votre boîte SMTP.',
      });
      await deps.accounts.markVerified(tenantId, id);
      return { ok: true };
    } catch (err) {
      // 422 (pas 5xx) : Cloudflare remplacerait le corps d'un 5xx par sa page d'erreur.
      req.log.warn({ err, accountId: id }, 'test SMTP échoué');
      return reply.code(422).send({ ok: false, error: 'envoi échoué', detail: (err as Error).message });
    }
  });

  // ---- Modèles ----
  app.get('/tenants/:t/email/templates', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    return deps.templates.list(tenantId);
  });

  app.post('/tenants/:t/email/templates', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    if (forbidNonAdmin(req, reply)) return reply;
    const parsed = templateCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalide', details: parsed.error.flatten() });
    return deps.templates.create(tenantId, parsed.data);
  });

  app.patch('/tenants/:t/email/templates/:id', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    if (forbidNonAdmin(req, reply)) return reply;
    const parsed = templatePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalide', details: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    const updated = await deps.templates.update(tenantId, id, parsed.data);
    return updated ?? reply.code(404).send({ error: 'introuvable' });
  });

  app.delete('/tenants/:t/email/templates/:id', async (req, reply) => {
    const tenantId = scopeTenant(req); if (!tenantId) return reply.code(403).send({ error: 'tenant' });
    if (forbidNonAdmin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const ok = await deps.templates.softDelete(tenantId, id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'introuvable' });
  });
}
```

Note : vérifier la vraie signature de `forbidNonAdmin` (`src/auth/middleware.ts:26`). S'il renvoie déjà la
réponse et un booléen « bloqué », le motif `if (forbidNonAdmin(req, reply)) return reply;` est correct ; sinon
l'aligner sur l'usage dans `src/http/workflows.ts`.

- [ ] **Étape 3 : monter les routes + instancier dans `src/index.ts`**

Au même endroit que `registerWorkflowsRoutes` (ou équivalent) :

```ts
import { PgEmailAccountStore } from './email/account-store.pg';
import { PgEmailTemplateStore } from './email/template-store.pg';
import { EmailAccountResolver } from './email/resolver';
import { buildTransport } from './email/smtp';
import { registerEmailRoutes } from './http/email';

const emailAccounts = new PgEmailAccountStore(pool);
const emailTemplates = new PgEmailTemplateStore(pool);
const emailResolver = new EmailAccountResolver({
  getDecrypted: (t, id) => emailAccounts.getDecrypted(t, id),
  buildTransport,
});
registerEmailRoutes(app, { accounts: emailAccounts, templates: emailTemplates, resolver: emailResolver });
```

Garder `emailTemplates` et `emailResolver` accessibles pour le câblage du moteur (Task 8).

- [ ] **Étape 4 : lancer le test, il passe**

Run : `npx vitest run tests/http-email.test.ts`
Attendu : PASS (403 agent, 200 admin sans mot de passe, 400 sur corps invalide).

- [ ] **Étape 5 : commit**

```bash
git add src/http/email.ts src/index.ts tests/http-email.test.ts
git commit -m "feat(email): routes admin-only comptes/modèles + test d'envoi (4xx, pas 5xx)"
```

---

### Task 7 : Intégration au moteur (graph, engine, résumé)

**Fichiers :**
- Modifier : `src/workflow/graph.ts:16` (`WORKFLOW_NODE_TYPES`)
- Modifier : `src/workflow/engine.ts` (union d'actions `:16-23`, `actionOf` `:260-330`, `walk` `:367-431`)
- Modifier : `src/workflow/node-list.ts:23-69` (résumé)
- Test : `tests/workflow-email-node.test.ts` (unitaire, pur)

**Interfaces :**
- Produit :
  - `EmailRecipient = { kind: 'literal'; value: string } | { kind: 'field'; field: string }`
  - Action `SendEmailAction = { kind: 'sendEmail'; emailAccountId: string; templateId: string; to: EmailRecipient }`
    (exportée depuis `engine.ts`, consommée par l'executor Task 8).
  - `actionOf` rend `SendEmailAction` pour un node `'email'` complet, `null` sinon.
  - `walk` traite `'email'` comme action synchrone non bloquante.

- [ ] **Étape 1 : test unitaire (échoue d'abord)**

```ts
// tests/workflow-email-node.test.ts
import { describe, it, expect } from 'vitest';
import { actionOf } from '../src/workflow/engine';

const node = (data: unknown) => ({ id: 'n1', type: 'email', position: { x: 0, y: 0 }, data });

describe('node email', () => {
  it('actionOf rend l’action quand tout est configuré', () => {
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } })))
      .toEqual({ kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } });
  });
  it('actionOf rend null si un champ manque', () => {
    expect(actionOf(node({ emailAccountId: 'a1', to: { kind: 'literal', value: 'x@ex.fr' } }))).toBeNull();
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1' }))).toBeNull();
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'field', field: '' } }))).toBeNull();
  });
});
```

Run : `npx vitest run tests/workflow-email-node.test.ts`
Attendu : FAIL.

- [ ] **Étape 2 : `graph.ts` — enregistrer le type**

Ajouter `'email'` à `WORKFLOW_NODE_TYPES` (`src/workflow/graph.ts:16`) :

```ts
export const WORKFLOW_NODE_TYPES = [
  'template', 'quick_message', 'inbox', 'flow', 'tag', 'field', 'condition',
  'action', 'wait', 'mba_handoff', 'mba_disable', 'rcs_message', 'email',
] as const;
```

- [ ] **Étape 3 : `engine.ts` — action + `actionOf`**

Ajouter les types et le cas `'email'` dans `actionOf` (lecture défensive de `node.data`) :

```ts
// dans engine.ts
export type EmailRecipient =
  | { kind: 'literal'; value: string }
  | { kind: 'field'; field: string };

export interface SendEmailAction {
  kind: 'sendEmail';
  emailAccountId: string;
  templateId: string;
  to: EmailRecipient;
}
// ... ajouter SendEmailAction à l'union WorkflowAction existante (engine.ts:16-23)

function emailRecipientOf(to: unknown): EmailRecipient | null {
  if (!to || typeof to !== 'object') return null;
  const t = to as Record<string, unknown>;
  if (t.kind === 'literal' && typeof t.value === 'string' && t.value.trim()) return { kind: 'literal', value: t.value };
  if (t.kind === 'field' && typeof t.field === 'string' && t.field.trim()) return { kind: 'field', field: t.field };
  return null;
}

// dans actionOf(node), brancher le cas 'email' :
if (node.type === 'email') {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const to = emailRecipientOf(d.to);
  if (typeof d.emailAccountId === 'string' && d.emailAccountId &&
      typeof d.templateId === 'string' && d.templateId && to) {
    return { kind: 'sendEmail', emailAccountId: d.emailAccountId, templateId: d.templateId, to };
  }
  return null;
}
```

- [ ] **Étape 4 : `walk` — action synchrone non bloquante**

Dans `walk` (`engine.ts:367-431`), le node `'email'` suit la même branche que `tag`/`field`/`action` : on
empile l'action (si `actionOf` la rend) et on continue vers `nextNode`, jamais `waiting`. Vérifier que le
`switch`/chaîne de `walk` ne met PAS `'email'` dans la liste des types bloquants (comme `template`). Aucun
handle de sortie spécial : sortie unique par défaut.

- [ ] **Étape 5 : `node-list.ts` — résumé**

Dans `summarize` (`src/workflow/node-list.ts:23-69`), cas `'email'` :

```ts
case 'email': {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const dest = (d.to as { kind?: string; value?: string; field?: string } | undefined);
  const cible = dest?.kind === 'field' ? `{{${dest.field}}}` : (dest?.value ?? '—non défini—');
  return `Mail vers ${cible}`;
}
```

(remplacer le tiret par un texte sans cadratin, ex. « non défini »).

- [ ] **Étape 6 : lancer le test, il passe**

Run : `npx vitest run tests/workflow-email-node.test.ts && npx vitest run tests/workflow*`
Attendu : PASS, aucune régression sur les tests workflow existants.

- [ ] **Étape 7 : commit**

```bash
git add src/workflow/graph.ts src/workflow/engine.ts src/workflow/node-list.ts tests/workflow-email-node.test.ts
git commit -m "feat(email): type de node email dans le moteur (action synchrone non bloquante)"
```

---

### Task 8 : Executor + wiring (envoi réel, best-effort)

**Fichiers :**
- Modifier : `src/workflow/executor.ts` (`WorkflowExecutorDeps` `:27-109`, `apply` `:180-225`)
- Modifier : `src/workflow/wiring.ts` (`buildWorkflowRuntime` `:169-353`)
- Test : `tests/workflow-email-exec.test.ts` (unitaire, dep injectée)

**Interfaces :**
- Consomme : `SendEmailAction` (Task 7), `EmailAccountResolver` + `sendSmtpEmail` (Task 5),
  `PgEmailTemplateStore` (Task 3), `renderText`/`contactVars` (Task 4), `ResolvableContact`.
- Produit : dep `sendEmail(action: SendEmailAction, contact: ResolvableContact): Promise<void>` dans
  `WorkflowExecutorDeps`, dispatchée dans `apply`, best-effort.

- [ ] **Étape 1 : test unitaire best-effort, dans les DEUX sens (échoue d'abord)**

```ts
// tests/workflow-email-exec.test.ts
import { describe, it, expect, vi } from 'vitest';
// Construire un executor minimal avec des deps factices (comme les tests d'executor existants).
// Un graphe : [email] -> [tag]. La dep sendEmail LÈVE. On vérifie que le run atteint quand même le tag.

describe('executor : le node email est best-effort', () => {
  it('un envoi qui échoue n’arrête pas le parcours (le node suivant est appliqué)', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('SMTP down'));
    const tag = vi.fn().mockResolvedValue(undefined);
    // ... start() sur un graphe email -> tag avec ces deps
    // await executor.start(...)
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tag).toHaveBeenCalledTimes(1); // le parcours a continué malgré l'échec
  });
});
```

Run : `npx vitest run tests/workflow-email-exec.test.ts`
Attendu : FAIL (dep `sendEmail` inexistante).

- [ ] **Étape 2 : `executor.ts` — dep + dispatch best-effort**

Ajouter à `WorkflowExecutorDeps` :

```ts
sendEmail(action: SendEmailAction, contact: ResolvableContact): Promise<void>;
```

Dans `apply` (`:180-225`), dispatcher l'action `'sendEmail'` en best-effort. Ne PAS l'inscrire dans
`aBesoinFenetre`. Le try/catch est la garantie testée à l'étape 1 :

```ts
case 'sendEmail':
  try {
    await this.deps.sendEmail(action, contact);
  } catch (err) {
    this.deps.log?.warn?.({ err, nodeKind: 'email' }, 'envoi mail échoué, on continue le parcours');
  }
  break;
```

(aligner `contact` sur l'objet contact déjà disponible dans `apply` pour `sendTemplate`, et `this.deps.log`
sur le logger réel de l'executor.)

- [ ] **Étape 3 : `wiring.ts` — implémenter la dep `sendEmail`**

Dans `buildWorkflowRuntime` (`:169-353`), à côté de la construction de `sendTemplate` (`:223`), construire
la dep `sendEmail`. Elle est tenant-scopée comme le reste du runtime :

```ts
// dans buildWorkflowRuntime(tenantId, ...), avec emailTemplates + emailResolver injectés (depuis index.ts/worker.ts)
const sendEmail = async (action: SendEmailAction, contact: ResolvableContact): Promise<void> => {
  const template = await emailTemplates.getById(tenantId, action.templateId);
  if (!template) { log.warn({ templateId: action.templateId }, 'modèle email introuvable, skip'); return; }
  const resolved = await emailResolver.getTransport(tenantId, action.emailAccountId);
  if (!resolved) { log.warn({ accountId: action.emailAccountId }, 'boîte email introuvable, skip'); return; }

  const vars = contactVars(contact);
  const to = action.to.kind === 'literal' ? action.to.value : (vars[action.to.field] ?? '');
  if (!to) { log.warn('destinataire email vide, skip'); return; }

  const html = template.format === 'html';
  await sendSmtpEmail(resolved.transport, resolved.account, {
    to,
    subject: renderText(template.subject, vars, { html: false }),
    ...(html
      ? { html: renderText(template.body, vars, { html: true }) }
      : { text: renderText(template.body, vars, { html: false }) }),
  });
};
```

Brancher `sendEmail` dans les deps passées à l'executor (là où `sendTemplate` l'est déjà). `emailTemplates` et
`emailResolver` sont ceux instanciés en Task 6 : les faire remonter jusqu'à `buildWorkflowRuntime` par le même
chemin que les autres dépendances du runtime (api dans `src/index.ts`, worker dans `src/worker.ts`).

- [ ] **Étape 4 : lancer le test, il passe**

Run : `npx vitest run tests/workflow-email-exec.test.ts`
Attendu : PASS (sendEmail appelé, tag appelé malgré l'échec).

- [ ] **Étape 5 : vérifier le test dans l'autre sens (règle de non-régression Julien)**

Retirer temporairement le try/catch autour de `this.deps.sendEmail` dans `apply`.
Run : `npx vitest run tests/workflow-email-exec.test.ts`
Attendu : **FAIL** (le rejet remonte, le tag n'est pas atteint). Cela prouve que le test garde bien la
propriété best-effort. Remettre le try/catch, relancer : PASS.

- [ ] **Étape 6 : commit**

```bash
git add src/workflow/executor.ts src/workflow/wiring.ts src/index.ts src/worker.ts tests/workflow-email-exec.test.ts
git commit -m "feat(email): envoi réel du node dans wiring, dispatch best-effort dans l'executor"
```

---

### Task 9 : Front, écran de connexions SMTP + entrée menu

**Fichiers :**
- Modifier : `web/lib/api.ts` (client comptes : `listEmailAccounts`, `createEmailAccount`, `updateEmailAccount`,
  `deleteEmailAccount`, `testEmailAccount`)
- Modifier : `web/components/AccountMenu.tsx` (entrée admin « Boîtes email »)
- Créer : `web/app/settings/email/page.tsx`
- Test : `web/e2e/email-accounts.spec.ts` (parcours admin : créer, tester, supprimer)

**Interfaces :**
- Consomme : routes de la Task 6.
- Produit : type front `EmailAccount` (miroir sans secret) + les fonctions client ci-dessus.

- [ ] **Étape 1 : client API**

```ts
// web/lib/api.ts (ajouts)
export interface EmailAccount {
  id: string; label: string; host: string; port: number; secure: boolean; username: string;
  fromAddress: string; fromName: string | null; replyTo: string | null;
  verifiedAt: string | null; createdAt: string; hasPassword: boolean;
}
export interface EmailAccountInput {
  label: string; host: string; port: number; secure: boolean; username: string;
  password?: string; fromAddress: string; fromName?: string | null; replyTo?: string | null;
}
export const listEmailAccounts = (t: string) => api<EmailAccount[]>(`/tenants/${t}/email/accounts`);
export const createEmailAccount = (t: string, b: EmailAccountInput) =>
  api<EmailAccount>(`/tenants/${t}/email/accounts`, { method: 'POST', body: b });
export const updateEmailAccount = (t: string, id: string, b: Partial<EmailAccountInput>) =>
  api<EmailAccount>(`/tenants/${t}/email/accounts/${id}`, { method: 'PATCH', body: b });
export const deleteEmailAccount = (t: string, id: string) =>
  api<{ ok: true }>(`/tenants/${t}/email/accounts/${id}`, { method: 'DELETE' });
export const testEmailAccount = (t: string, id: string, to: string) =>
  api<{ ok: boolean; error?: string }>(`/tenants/${t}/email/accounts/${id}/test`, { method: 'POST', body: { to } });
```

(aligner sur le helper `api()` réel du repo et sa signature.)

- [ ] **Étape 2 : entrée dans le menu**

Dans `web/components/AccountMenu.tsx`, bloc `isAdmin` (après « Compte & équipe », ligne ~90) :

```tsx
<Link href="/settings/email" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">{t('Boîtes email', 'Email accounts')}</Link>
```

- [ ] **Étape 3 : écran `web/app/settings/email/page.tsx`**

Liste + formulaire d'ajout/édition + suppression + « Envoyer un test ». Tailwind pur, tokens MM, `useT`. Le
champ mot de passe est vide à l'édition (écrit seulement s'il est rempli). S'inspirer d'une page de liste
existante (ex. la gestion d'équipe `/admin`) pour le style. Squelette :

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { listEmailAccounts, createEmailAccount, updateEmailAccount, deleteEmailAccount, testEmailAccount, type EmailAccount, type EmailAccountInput } from '@/lib/api';
// ... récupérer tenantId depuis la session comme les autres pages admin

const EMPTY: EmailAccountInput = { label: '', host: '', port: 465, secure: true, username: '', password: '', fromAddress: '', fromName: '', replyTo: '' };

export default function EmailAccountsPage() {
  const t = useT();
  const [items, setItems] = useState<EmailAccount[]>([]);
  const [form, setForm] = useState<EmailAccountInput>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const reload = async () => setItems(await listEmailAccounts(tenantId));
  useEffect(() => { void reload(); }, []);

  const save = async () => {
    if (editing) { const { password, ...rest } = form; await updateEmailAccount(tenantId, editing, password ? form : rest); }
    else await createEmailAccount(tenantId, form);
    setForm(EMPTY); setEditing(null); await reload();
  };
  const runTest = async (id: string) => {
    const r = await testEmailAccount(tenantId, id, testTo);
    setMsg(r.ok ? t('Test envoyé', 'Test sent') : `${t('Échec', 'Failed')} : ${r.error ?? ''}`);
    await reload();
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-lg font-semibold text-ink-900">{t('Boîtes email (SMTP)', 'Email accounts (SMTP)')}</h1>
      {/* liste : label, from, pastille vérifiée, boutons éditer/supprimer/tester */}
      {/* formulaire : label, host, port, secure(toggle), username, password, fromAddress, fromName, replyTo */}
      {/* zone de test : input email + bouton, affiche msg */}
    </div>
  );
}
```

Compléter les champs de formulaire et la liste en Tailwind pur (mêmes classes que `AccountMenu`/pages admin).
Ne jamais pré-remplir le mot de passe (`hasPassword` sert d'indice « déjà défini »).

- [ ] **Étape 4 : E2E parcours admin**

```ts
// web/e2e/email-accounts.spec.ts
import { test, expect } from '@playwright/test';
// se connecter en admin (helper e2e existant), aller sur /settings/email
test('un admin crée une boîte SMTP et la voit listée', async ({ page }) => {
  // ... login admin
  await page.goto('/settings/email');
  await page.getByLabel('Libellé').fill('Support');
  await page.getByLabel('Hôte').fill('ssl0.ovh.net');
  await page.getByLabel('Port').fill('465');
  await page.getByLabel('Identifiant').fill('support@ex.fr');
  await page.getByLabel('Mot de passe').fill('secret');
  await page.getByLabel("Adresse d'envoi").fill('support@ex.fr');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Support')).toBeVisible();
});
```

Run : `npx playwright test web/e2e/email-accounts.spec.ts`
Attendu : PASS. Ajuster les libellés `getByLabel` sur ceux réellement rendus.

- [ ] **Étape 5 : vérifier build + types**

Run : `cd web && npm run build`
Attendu : build OK, types propres.

- [ ] **Étape 6 : commit**

```bash
git add web/lib/api.ts web/components/AccountMenu.tsx web/app/settings/email/page.tsx web/e2e/email-accounts.spec.ts
git commit -m "feat(email): écran de connexions SMTP (menu admin) + client API + E2E"
```

---

### Task 10 : Front, section « Modèles d'email » dans Contenu

**Fichiers :**
- Modifier : `web/lib/api.ts` (client modèles : `listEmailTemplates`, `createEmailTemplate`,
  `updateEmailTemplate`, `deleteEmailTemplate`)
- Créer/Modifier : la page Contenu pour y ajouter une section « Modèles d'email » (à côté des Blocs). Repérer
  la page Contenu existante (celle qui liste Blocs/Tags/Champs/Formulaires) et y greffer un onglet/section.
- Test : `web/e2e/email-templates.spec.ts`

**Interfaces :**
- Consomme : routes modèles (Task 6).
- Produit : type front `EmailTemplate` + fonctions client.

- [ ] **Étape 1 : client API**

```ts
// web/lib/api.ts (ajouts)
export type EmailTemplateFormat = 'basic' | 'html';
export interface EmailTemplate { id: string; name: string; format: EmailTemplateFormat; subject: string; body: string; createdAt: string; updatedAt: string; }
export interface EmailTemplateInput { name: string; format: EmailTemplateFormat; subject: string; body: string; }
export const listEmailTemplates = (t: string) => api<EmailTemplate[]>(`/tenants/${t}/email/templates`);
export const createEmailTemplate = (t: string, b: EmailTemplateInput) => api<EmailTemplate>(`/tenants/${t}/email/templates`, { method: 'POST', body: b });
export const updateEmailTemplate = (t: string, id: string, b: Partial<EmailTemplateInput>) => api<EmailTemplate>(`/tenants/${t}/email/templates/${id}`, { method: 'PATCH', body: b });
export const deleteEmailTemplate = (t: string, id: string) => api<{ ok: true }>(`/tenants/${t}/email/templates/${id}`, { method: 'DELETE' });
```

- [ ] **Étape 2 : section « Modèles d'email » dans Contenu**

Ajouter une section (onglet ou bloc) « Modèles d'email » : liste (nom, format, sujet) + éditeur avec bascule
`basic`/`html`, champ sujet, champ corps (zone de texte ; en HTML, zone de HTML brut). Réutiliser le sélecteur
de variables du builder si présent pour insérer `{{champ}}`. Composant dédié (ex.
`web/app/contenu/EmailTemplates.tsx`) importé dans la page Contenu.

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { listEmailTemplates, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate, type EmailTemplate, type EmailTemplateInput } from '@/lib/api';

const EMPTY: EmailTemplateInput = { name: '', format: 'basic', subject: '', body: '' };

export function EmailTemplates({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [items, setItems] = useState<EmailTemplate[]>([]);
  const [form, setForm] = useState<EmailTemplateInput>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const reload = async () => setItems(await listEmailTemplates(tenantId));
  useEffect(() => { void reload(); }, []);
  const save = async () => {
    if (editing) await updateEmailTemplate(tenantId, editing, form);
    else await createEmailTemplate(tenantId, form);
    setForm(EMPTY); setEditing(null); await reload();
  };
  return (
    <div>
      {/* liste + éditeur : name, toggle format basic/html, subject, body ; bouton Enregistrer/Supprimer */}
    </div>
  );
}
```

- [ ] **Étape 3 : E2E**

```ts
// web/e2e/email-templates.spec.ts
import { test, expect } from '@playwright/test';
test('un admin crée un modèle basique', async ({ page }) => {
  // ... login admin, aller sur la page Contenu, onglet Modèles d'email
  await page.getByLabel('Nom').fill('Confirmation');
  await page.getByLabel('Sujet').fill('Bonjour {{prenom}}');
  await page.getByLabel('Corps').fill('Merci de votre message.');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Confirmation')).toBeVisible();
});
```

Run : `npx playwright test web/e2e/email-templates.spec.ts`
Attendu : PASS.

- [ ] **Étape 4 : build + commit**

```bash
cd web && npm run build && cd ..
git add web/lib/api.ts web/app/contenu web/e2e/email-templates.spec.ts
git commit -m "feat(email): section Modèles d'email (basique + HTML, variables) dans Contenu"
```

---

### Task 11 : Front, le node dans le builder + gating

**Fichiers :**
- Modifier : `web/lib/api.ts:1063` (`WorkflowNodeType` : ajouter `'email'`)
- Modifier : `web/lib/nodeMeta.ts` (`NODE_META` + liste d'ordre gatée `EMAIL_NODE_ORDER` ou intégration à
  `NODE_ORDER` selon gating)
- Modifier : `web/components/WorkflowBuilder.tsx` (`initialDataFor:36`, `summaryOf:42`, branche `ConfigPanel`,
  palette gatée, prop `emailEnabled`)
- Modifier : `web/app/workflows/page.tsx` (calcul `emailEnabled` = au moins une boîte, passé au builder)
- Test : `web/e2e/workflow-email-node.spec.ts`

**Interfaces :**
- Consomme : `listEmailAccounts`, `listEmailTemplates` (Tasks 9, 10) ; `WorkflowNodeType`.
- Produit : node `email` configurable (boîte + modèle + destinataire), grisé si aucune boîte.

- [ ] **Étape 1 : `WorkflowNodeType` + `NODE_META`**

```ts
// web/lib/api.ts:1063
export type WorkflowNodeType =
  | 'template' | 'quick_message' | 'inbox' | 'flow' | 'tag' | 'field' | 'condition'
  | 'action' | 'wait' | 'mba_handoff' | 'mba_disable' | 'rcs_message' | 'email';
```

```ts
// web/lib/nodeMeta.ts : entrée forcée par TS
email: { label: t('Envoi de mail', 'Send email'), icon: '✉️', color: 'brand' },
```

(respecter la forme exacte des autres entrées `NODE_META`, et la palette gatée : mettre `'email'` dans une
liste type `RCS_NODE_ORDER` pour qu'il soit grisé tant que `emailEnabled` est faux.)

- [ ] **Étape 2 : builder — création, résumé, config**

```ts
// initialDataFor (WorkflowBuilder.tsx:36)
if (type === 'email') return { emailAccountId: '', templateId: '', to: { kind: 'literal', value: '' } };
```

```ts
// summaryOf (WorkflowBuilder.tsx:42)
if (n.data?.wfType === 'email') {
  const to = n.data.to;
  return `Mail vers ${to?.kind === 'field' ? `{{${to.field}}}` : (to?.value || 'non défini')}`;
}
```

Branche `ConfigPanel` (zone `:838-1011`) pour `wfType === 'email'` : liste déroulante des boîtes
(`listEmailAccounts`), liste déroulante des modèles (`listEmailTemplates`), et le destinataire (bascule
« adresse » / « variable » -> `to.kind` `'literal'`/`'field'`, réutiliser le sélecteur de variables existant
pour le mode `field`). Une seule sortie en bas (aucun handle spécial).

- [ ] **Étape 3 : gating**

```ts
// web/app/workflows/page.tsx : emailEnabled = (await listEmailAccounts(tenantId)).length > 0
// passer emailEnabled au WorkflowBuilder, comme rcsEnabled/mbaEnabled ; node grisé + aide si faux.
```

- [ ] **Étape 4 : E2E**

```ts
// web/e2e/workflow-email-node.spec.ts
import { test, expect } from '@playwright/test';
test('le node email est grisé sans boîte, actif avec une boîte', async ({ page }) => {
  // ... login admin sans boîte : ouvrir un scénario, vérifier le node email grisé + aide
  // ... créer une boîte via /settings/email, revenir : le node email est cliquable, config boîte+modèle+destinataire
});
```

Run : `npx playwright test web/e2e/workflow-email-node.spec.ts`
Attendu : PASS.

- [ ] **Étape 5 : build + commit**

```bash
cd web && npm run build && cd ..
git add web/lib/api.ts web/lib/nodeMeta.ts web/components/WorkflowBuilder.tsx web/app/workflows/page.tsx web/e2e/workflow-email-node.spec.ts
git commit -m "feat(email): node Envoi de mail dans le builder (boîte+modèle+destinataire), gaté"
```

---

### Task 12 : Intégration finale + déploiement

**Fichiers :** aucun nouveau ; vérifications transverses.

- [ ] **Étape 1 : suite complète**

Run : `npm test && cd web && npm run build && npx playwright test && cd ..`
Attendu : unitaires + intégration verts, build web OK, E2E verts.

- [ ] **Étape 2 : bout-en-bout local (sandbox SMTP)**

Configurer une boîte SMTP de test (ex. un service de capture type Mailpit/Ethereal), créer un modèle basique
avec `{{prenom}}`, poser un node email dans un scénario derrière un node qui pose le champ email, lancer sur
un contact de test, vérifier que le mail arrive avec la variable substituée et que le parcours continue.

- [ ] **Étape 3 : déploiement (ordre strict)**

```bash
# 1) migrations AVANT le code (règle ferme, cf DEPLOY.md)
git log <dernier-commit-déployé>..HEAD --oneline   # n'embarquer que ce chantier
# appliquer 0060 sur le VPS, vérifier « rien d'autre en attente »
# 2) build + up
cd /home/ubuntu/mba && git pull && sudo docker compose up -d --build
# 3) vérifier : /health ok, 3 conteneurs Up, routes /tenants/:t/email/* répondent 401 sans jeton
```

- [ ] **Étape 4 : mettre à jour la doc**

`features.md` (usage : boîtes email, modèles, node), `documentation.md` (§Email : tables, wiring, résolveur),
`wip.md` (basculer l'entrée du 2026-08-18 en « LIVE » avec le commit et les migrations vérifiées).

- [ ] **Étape 5 : revue de code** (`/revue`) sur l'ensemble du lot : correctness, sécurité (fuite de secret,
  isolation tenant), best-effort, escaping HTML. Corriger 🔴 ET 🟡 dans la foulée (zéro dette cumulée).

## Auto-revue du plan (couverture du spec)

- Connexions SMTP multiples par tenant : Tasks 1, 2, 6, 9. ✓
- Modèles basique + HTML avec variables : Tasks 1, 3, 4, 10. ✓
- Node destinataire libre (littéral/variable) : Tasks 7, 8, 11. ✓
- Best-effort non bloquant + test dans les deux sens : Task 8. ✓
- Setup dans le menu haut-droite, admin-only : Tasks 6, 9. ✓
- Sécurité (secret chiffré, jamais renvoyé, RBAC, tenant) : Tasks 2, 6. ✓
- Migration 0060 avant déploiement : Tasks 1, 12. ✓
- Hors périmètre (Resend, domaine, Gmail OAuth, générateur HTML, tracking) : non planifié, conforme au spec. ✓
