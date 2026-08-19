import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgEmailAccountStore } from '../src/email/account-store.pg';
import { config } from '../src/config';
import { encryptSecret } from '../src/crypto/secretbox';
import type { EmailAccountInput } from '../src/email/types';

/**
 * Test UNITAIRE avec fake pool (aucune base réelle), patron tests/ids-store.test.ts : un fake pool capture
 * les requêtes SQL et leurs params, on inspecte les deux plutôt que de taper une vraie Postgres.
 *
 * config.ENCRYPTION_KEY est vide par défaut hors production (src/config.ts, superRefine scopé à
 * NODE_ENV==='production') : le store lit config.ENCRYPTION_KEY à CHAQUE appel (pas de cache), donc poser une
 * clé de test valide sur le singleton importé, avant les tests, suffit (config n'est pas gelé par zod). Pas
 * besoin de variable d'environnement réelle ni d'astuce d'ordre d'import.
 */
const TEST_KEY = 'a'.repeat(64); // 32 octets hex, même convention que tests/secretbox.test.ts
config.ENCRYPTION_KEY = TEST_KEY;

const TENANT = 't1';
const OTHER_TENANT = 't2';

function baseInput(label: string): EmailAccountInput {
  return {
    label,
    host: 'ssl0.ovh.net',
    port: 465,
    secure: true,
    username: `${label}@exemple.fr`,
    password: 's3cr3t',
    fromAddress: `${label}@exemple.fr`,
  };
}

/** Ligne `email_accounts` par défaut renvoyée par le fake pool (RETURNING / SELECT). `created_at`/`verified_at`
 *  en `Date` (jamais en string) : c'est ce que le driver `pg` rend réellement pour un `timestamptz`, et
 *  account-store.pg.ts appelle `.toISOString()` dessus directement (cf EmailAccountRow, sans repasser par
 *  `new Date(...)`) : une string ici ferait planter toAccount() au lieu de prouver quoi que ce soit sur le store. */
function fakeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'acc-1', tenant_id: TENANT, label: 'support', host: 'ssl0.ovh.net', port: 465, secure: true,
    username: 'support@exemple.fr', password_enc: 'v1.iv.tag.data', from_address: 'support@exemple.fr',
    from_name: null, reply_to: null, verified_at: null, created_at: new Date(0),
    ...overrides,
  };
}

interface FakePoolOpts {
  /** Ligne rendue par INSERT...RETURNING, UPDATE...RETURNING et par les SELECT scopés à un id. `null` = aucune
   *  ligne (introuvable). */
  row?: Record<string, unknown> | null;
  /** Lignes rendues par le SELECT de list(). Par défaut : [row]. */
  rows?: Array<Record<string, unknown>>;
  /** rowCount des UPDATE sans RETURNING (softDelete, markVerified). */
  rowCount?: number;
}

/** Fake pool : capture les requêtes SQL + params, répond selon la forme du SQL (patron tests/ids-store.test.ts). */
function fakePool(opts: FakePoolOpts = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });

      if (/^insert into email_accounts/i.test(sql)) {
        return { rows: [opts.row === undefined ? fakeRow() : opts.row].filter((r) => r !== null), rowCount: 1 };
      }
      // softDelete() : deleted_at=now() seul dans le SET, pas de RETURNING.
      if (/^update email_accounts set deleted_at=now\(\)/i.test(sql)) {
        return { rows: [], rowCount: opts.rowCount ?? 1 };
      }
      // markVerified() : verified_at=now() seul dans le SET, pas de RETURNING.
      if (/^update email_accounts set verified_at=now\(\)/i.test(sql)) {
        return { rows: [], rowCount: opts.rowCount ?? 1 };
      }
      // update() : liste de colonnes VARIABLE (dépend du patch fourni), reconnue par le RETURNING final
      // (seule des 3 formes d'UPDATE du store à en avoir un) plutôt que par un SET figé.
      if (/^update email_accounts set/i.test(sql) && /returning/i.test(sql)) {
        return { rows: [opts.row === undefined ? fakeRow() : opts.row].filter((r) => r !== null), rowCount: 1 };
      }
      // list() : where tenant_id=$1 and deleted_at is null, suivi de « order by » (pas de id=$2).
      // Flag « s » (dotAll) INDISPENSABLE : COLS est un template littéral multi-lignes, `.` ne traverse pas
      // un \n sans lui, et la requête réelle ne matchait alors jamais (repéré en faisant échouer ce test).
      if (/^select .* from email_accounts where tenant_id=\$1 and deleted_at is null order by/is.test(sql)) {
        const rows = opts.rows ?? (opts.row === null ? [] : [opts.row ?? fakeRow()]);
        return { rows, rowCount: rows.length };
      }
      // getById() / getDecrypted() : where tenant_id=$1 and id=$2 and deleted_at is null.
      if (/^select .* from email_accounts where tenant_id=\$1 and id=\$2 and deleted_at is null/is.test(sql)) {
        const row = opts.row === null ? null : (opts.row ?? fakeRow());
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

describe('PgEmailAccountStore (fake pool, sans base réelle)', () => {
  it('create() chiffre le mot de passe dans l’INSERT : jamais le clair, format v1. de secretbox', async () => {
    const { pool, queries } = fakePool();
    const store = new PgEmailAccountStore(pool);
    const acc = await store.create(TENANT, baseInput('support'));

    const ins = queries.find((q) => /insert into email_accounts/i.test(q.sql));
    expect(ins).toBeTruthy();
    // Ordre des params de l'INSERT (cf plan) :
    // (tenant_id, label, host, port, secure, username, password_enc, from_address, from_name, reply_to)
    const passwordEnc = ins!.params[6] as string;
    expect(passwordEnc).not.toBe('s3cr3t');
    expect(passwordEnc).not.toContain('s3cr3t');
    expect(passwordEnc.startsWith('v1.')).toBe(true);
    expect(ins!.params).not.toContain('s3cr3t'); // le clair ne fuit dans AUCUN autre slot

    // L'objet rendu à l'appelant ne porte jamais le secret (ni en clair, ni chiffré).
    expect((acc as unknown as Record<string, unknown>).password).toBeUndefined();
    expect((acc as unknown as Record<string, unknown>).passwordEnc).toBeUndefined();
  });

  it('getDecrypted() : round-trip, un password_enc chiffré connu redonne le mot de passe en clair', async () => {
    const encrypted = encryptSecret('s3cr3t', TEST_KEY);
    const { pool } = fakePool({ row: fakeRow({ password_enc: encrypted }) });
    const store = new PgEmailAccountStore(pool);

    const dec = await store.getDecrypted(TENANT, 'acc-1');
    expect(dec?.password).toBe('s3cr3t');
    expect(dec?.id).toBe('acc-1');
  });

  it('getById()/list() ne sélectionnent jamais password_enc (seule getDecrypted() le lit)', async () => {
    const { pool, queries } = fakePool();
    const store = new PgEmailAccountStore(pool);

    const one = await store.getById(TENANT, 'acc-1');
    const list = await store.list(TENANT);

    expect(queries).toHaveLength(2);
    for (const q of queries) expect(q.sql).not.toMatch(/password/i); // ni password ni password_enc
    expect((one as Record<string, unknown> | null)?.password).toBeUndefined();
    expect(list.length).toBeGreaterThan(0);
    for (const a of list) expect((a as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  describe('update()', () => {
    it('met password_enc dans le SET seulement si password est fourni dans le patch', async () => {
      const withPassword = fakePool();
      await new PgEmailAccountStore(withPassword.pool).update(TENANT, 'acc-1', { label: 'nouveau-label', password: 'n0uv3auMdp' });
      const q1 = withPassword.queries[0]!;
      // Ordre des `if` du store : label avant password -> label=$1, password_enc=$2.
      expect(q1.sql).toMatch(/password_enc\s*=\s*\$2/i);
      const passwordEnc = q1.params[1] as string;
      expect(passwordEnc).not.toBe('n0uv3auMdp');
      expect(passwordEnc).not.toContain('n0uv3auMdp');
      expect(passwordEnc.startsWith('v1.')).toBe(true);
      expect(q1.params).not.toContain('n0uv3auMdp'); // le clair ne fuit dans AUCUN slot

      const withoutPassword = fakePool();
      await new PgEmailAccountStore(withoutPassword.pool).update(TENANT, 'acc-1', { label: 'sans-mdp' });
      const q2 = withoutPassword.queries[0]!;
      expect(q2.sql).not.toMatch(/password_enc/i); // patch sans password -> colonne absente du SET
    });

    it('construit un SET correct sur patch partiel : ordre des $n stable, tenant_id/id en fin, updated_at=now()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailAccountStore(pool).update(TENANT, 'acc-1', { host: 'smtp.exemple.fr', port: 587 });

      const upd = queries[0]!;
      // 2 champs du patch (déclarés host puis port dans le store) -> $1, $2 ; updated_at=now() SANS placeholder ;
      // puis WHERE tenant_id=$3 and id=$4 (poussés en dernier dans vals, cf. account-store.pg.ts).
      expect(upd.sql).toMatch(/set\s+host\s*=\s*\$1\s*,\s*port\s*=\s*\$2\s*,\s*updated_at\s*=\s*now\(\)/i);
      expect(upd.sql).toMatch(/where\s+tenant_id\s*=\s*\$3\s+and\s+id\s*=\s*\$4\s+and\s+deleted_at is null/i);
      expect(upd.params).toEqual(['smtp.exemple.fr', 587, TENANT, 'acc-1']);
    });

    it('patch vide ({}) ne lance AUCUN UPDATE et renvoie le résultat de getById()', async () => {
      const { pool, queries } = fakePool();
      const store = new PgEmailAccountStore(pool);

      const result = await store.update(TENANT, 'acc-1', {});

      expect(queries.some((q) => /^update email_accounts set/i.test(q.sql))).toBe(false); // aucun UPDATE, d'aucune forme
      expect(queries).toHaveLength(1); // uniquement le SELECT de getById()
      expect(queries[0]!.sql).toMatch(/^select/i);
      expect(result?.id).toBe('acc-1'); // la ligne renvoyée par getById()
    });
  });

  it('markVerified() : UPDATE verified_at=now() scopé tenant_id=$1 and id=$2, deleted_at is null', async () => {
    const { pool, queries } = fakePool();
    const store = new PgEmailAccountStore(pool);
    await store.markVerified(TENANT, 'acc-1');

    const upd = queries.find((q) => /^update email_accounts set verified_at=now\(\)/i.test(q.sql));
    expect(upd).toBeTruthy();
    expect(upd!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    expect(upd!.sql).toMatch(/id\s*=\s*\$2/i);
    expect(upd!.sql).toMatch(/deleted_at is null/i);
    expect(upd!.params).toEqual([TENANT, 'acc-1']);
  });

  it('softDelete() : UPDATE deleted_at=now() scopé tenant_id + id, jamais un delete réel', async () => {
    const { pool, queries } = fakePool({ rowCount: 1 });
    const store = new PgEmailAccountStore(pool);
    const ok = await store.softDelete(TENANT, 'acc-1');

    const upd = queries.find((q) => /update email_accounts/i.test(q.sql));
    expect(upd).toBeTruthy();
    expect(upd!.sql).toMatch(/deleted_at\s*=\s*now\(\)/i);
    expect(upd!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    expect(upd!.sql).toMatch(/deleted_at is null/i); // ne redélie pas une ligne déjà supprimée
    expect(upd!.sql).not.toMatch(/^delete/i); // suppression douce uniquement
    expect(upd!.params).toEqual([TENANT, 'acc-1']);
    expect(ok).toBe(true);
  });

  it('softDelete() : aucune ligne touchée (autre tenant ou id inconnu) -> false', async () => {
    const { pool } = fakePool({ rowCount: 0 });
    const store = new PgEmailAccountStore(pool);
    expect(await store.softDelete(OTHER_TENANT, 'inexistant')).toBe(false);
  });

  /**
   * Isolation tenant, version RIGOUREUSE. Une version antérieure de ce test s'appuyait sur un fakePool
   * configuré pour toujours renvoyer `null` (`row: null`) : il passait même si le store ne filtrait RIEN par
   * tenant_id, donc aucun pouvoir de détection. Ici on capture la SQL et les params RÉELLEMENT construits par
   * le store pour CHAQUE méthode, et on vérifie (a) que le tenant appelant est bien le paramètre lié à
   * `tenant_id`, (b) que la clause `tenant_id` est bien dans la SQL et, pour les méthodes qui touchent des
   * lignes déjà existantes, que `deleted_at is null` y est aussi (jamais de fuite ni d'écrasement d'une ligne
   * déjà supprimée).
   *
   * update() est un cas à part : le tenant_id/id sont poussés en DERNIER dans vals (patch d'abord), donc ce
   * n'est jamais params[0] comme pour les autres méthodes ; on vérifie sa position réelle (les 2 derniers slots).
   *
   * Preuve du pouvoir de détection (faite manuellement pendant la revue, pas reconduite ici en dur pour ne pas
   * casser le store à chaque run) : `and deleted_at is null` retiré temporairement de la requête getById()
   * dans account-store.pg.ts -> `npx vitest run tests/email-account-store.test.ts` fait tomber le test
   * "getById()" ci-dessous, ainsi que "update() : patch vide" qui appelle getById() en interne ; code remis à
   * l'identique ensuite et suite revérifiée verte.
   */
  describe('Isolation tenant : SQL + params scopés tenant_id (et deleted_at is null) sur CHAQUE méthode', () => {
    it('list()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailAccountStore(pool).list(TENANT);
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });

    it('getById()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailAccountStore(pool).getById(TENANT, 'acc-1');
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.params[1]).toBe('acc-1');
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });

    it('getDecrypted()', async () => {
      // password_enc doit être un secret VALIDE (getDecrypted() le déchiffre pour de vrai) : le placeholder
      // 'v1.iv.tag.data' de fakeRow() par défaut n'a pas un tag GCM de la bonne longueur et ferait planter
      // le déchiffrement avant même d'atteindre les assertions d'isolation visées par ce test.
      const { pool, queries } = fakePool({ row: fakeRow({ password_enc: encryptSecret('s3cr3t', TEST_KEY) }) });
      await new PgEmailAccountStore(pool).getDecrypted(TENANT, 'acc-1');
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.params[1]).toBe('acc-1');
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });

    it('create()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailAccountStore(pool).create(TENANT, baseInput('iso'));
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT); // tenant_id = 1re colonne de l'INSERT
      expect(q.sql).toMatch(/tenant_id/i);
    });

    it('update()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailAccountStore(pool).update(TENANT, 'acc-1', { label: 'iso' });
      const upd = queries[0]!;
      // tenant_id/id sont les 2 DERNIERS params ici (patch avant), pas params[0] (cf. commentaire du describe).
      expect(upd.params.at(-2)).toBe(TENANT);
      expect(upd.params.at(-1)).toBe('acc-1');
      expect(upd.sql).toMatch(/tenant_id\s*=\s*\$\d+/i);
      expect(upd.sql).toMatch(/deleted_at is null/i);
    });

    it('softDelete()', async () => {
      const { pool, queries } = fakePool({ rowCount: 1 });
      await new PgEmailAccountStore(pool).softDelete(TENANT, 'acc-1');
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.params[1]).toBe('acc-1');
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });

    it('markVerified()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailAccountStore(pool).markVerified(TENANT, 'acc-1');
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.params[1]).toBe('acc-1');
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });
  });
});
