import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgEmailTemplateStore } from '../src/email/template-store.pg';
import type { EmailTemplateInput } from '../src/email/types';

/**
 * Test UNITAIRE avec fake pool (aucune base réelle), même patron que tests/email-account-store.test.ts /
 * tests/ids-store.test.ts : un fake pool capture les requêtes SQL et leurs params, on inspecte les deux
 * plutôt que de taper une vraie Postgres (le DATABASE_URL local pointe sur la production).
 */

const TENANT = 't1';
const OTHER_TENANT = 't2';

function baseInput(name: string): EmailTemplateInput {
  return {
    name,
    format: 'basic',
    subject: `Bonjour {{prenom}} (${name})`,
    body: 'Merci de votre confiance.',
  };
}

/** Ligne `email_templates` par défaut renvoyée par le fake pool (RETURNING / SELECT). `created_at`/`updated_at`
 *  en `Date` (jamais en string) : c'est ce que le driver `pg` rend réellement pour un `timestamptz`, et
 *  template-store.pg.ts appelle `.toISOString()` dessus directement (cf EmailTemplateRow, sans repasser par
 *  `new Date(...)`) : une string ici ferait planter toTemplate() au lieu de prouver quoi que ce soit sur le store. */
function fakeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'tpl-1', tenant_id: TENANT, name: 'Confirmation', format: 'basic',
    subject: 'Bonjour {{prenom}}', body: 'Merci.', created_at: new Date(0), updated_at: new Date(0),
    ...overrides,
  };
}

interface FakePoolOpts {
  /** Ligne rendue par INSERT...RETURNING, UPDATE...RETURNING et par les SELECT scopés à un id. `null` = aucune
   *  ligne (introuvable). */
  row?: Record<string, unknown> | null;
  /** Lignes rendues par le SELECT de list(). Par défaut : [row]. */
  rows?: Array<Record<string, unknown>>;
  /** rowCount de l'UPDATE sans RETURNING (softDelete). */
  rowCount?: number;
}

/** Fake pool : capture les requêtes SQL + params, répond selon la forme du SQL (patron tests/ids-store.test.ts). */
function fakePool(opts: FakePoolOpts = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });

      if (/^insert into email_templates/i.test(sql)) {
        return { rows: [opts.row === undefined ? fakeRow() : opts.row].filter((r) => r !== null), rowCount: 1 };
      }
      // softDelete() : deleted_at=now() seul dans le SET, pas de RETURNING.
      if (/^update email_templates set deleted_at=now\(\)/i.test(sql)) {
        return { rows: [], rowCount: opts.rowCount ?? 1 };
      }
      // update() : liste de colonnes VARIABLE (dépend du patch fourni), reconnue par le RETURNING final (seule
      // des 2 formes d'UPDATE du store à en avoir un) plutôt que par un SET figé.
      if (/^update email_templates set/i.test(sql) && /returning/i.test(sql)) {
        return { rows: [opts.row === undefined ? fakeRow() : opts.row].filter((r) => r !== null), rowCount: 1 };
      }
      // list() : where tenant_id=$1 and deleted_at is null, suivi de « order by » (pas de id=$2).
      // Flag « s » (dotAll) INDISPENSABLE : COLS est un template littéral multi-lignes potentiel, `.` ne
      // traverse pas un \n sans lui.
      if (/^select .* from email_templates where tenant_id=\$1 and deleted_at is null order by/is.test(sql)) {
        const rows = opts.rows ?? (opts.row === null ? [] : [opts.row ?? fakeRow()]);
        return { rows, rowCount: rows.length };
      }
      // getById() : where tenant_id=$1 and id=$2 and deleted_at is null.
      if (/^select .* from email_templates where tenant_id=\$1 and id=\$2 and deleted_at is null/is.test(sql)) {
        const row = opts.row === null ? null : (opts.row ?? fakeRow());
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

describe('PgEmailTemplateStore (fake pool, sans base réelle)', () => {
  it('create() insère name/format/subject/body scopés tenant_id, renvoie le modèle créé', async () => {
    const { pool, queries } = fakePool();
    const store = new PgEmailTemplateStore(pool);
    const tpl = await store.create(TENANT, baseInput('Confirmation'));

    const ins = queries.find((q) => /insert into email_templates/i.test(q.sql));
    expect(ins).toBeTruthy();
    // Ordre des params de l'INSERT (cf plan) : (tenant_id, name, format, subject, body).
    expect(ins!.params).toEqual([
      TENANT, 'Confirmation', 'basic', 'Bonjour {{prenom}} (Confirmation)', 'Merci de votre confiance.',
    ]);
    expect(tpl.id).toBe('tpl-1');
    expect(tpl.format).toBe('basic');
  });

  it('list() : SQL scopée tenant_id + deleted_at is null, params = [tenantId]', async () => {
    const { pool, queries } = fakePool({ rows: [fakeRow(), fakeRow({ id: 'tpl-2', name: 'Autre' })] });
    const store = new PgEmailTemplateStore(pool);
    const list = await store.list(TENANT);

    expect(list).toHaveLength(2);
    expect(list.map((t) => t.id)).toEqual(['tpl-1', 'tpl-2']);
    const q = queries[0]!;
    expect(q.params).toEqual([TENANT]);
    expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    expect(q.sql).toMatch(/deleted_at is null/i);
  });

  it('getById() : SQL scopée tenant_id + id + deleted_at is null, renvoie le modèle', async () => {
    const { pool, queries } = fakePool();
    const store = new PgEmailTemplateStore(pool);
    const tpl = await store.getById(TENANT, 'tpl-1');

    expect(tpl?.id).toBe('tpl-1');
    const q = queries[0]!;
    expect(q.params).toEqual([TENANT, 'tpl-1']);
    expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    expect(q.sql).toMatch(/id\s*=\s*\$2/i);
    expect(q.sql).toMatch(/deleted_at is null/i);
  });

  it('getById() : introuvable (autre tenant ou id inconnu) -> null', async () => {
    const { pool } = fakePool({ row: null });
    const store = new PgEmailTemplateStore(pool);
    expect(await store.getById(OTHER_TENANT, 'tpl-1')).toBeNull();
  });

  describe('update()', () => {
    it('construit un SET correct sur patch partiel : ordre des $n stable, tenant_id/id en fin, updated_at=now()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailTemplateStore(pool).update(TENANT, 'tpl-1', { subject: 'Nouveau sujet', body: 'Nouveau corps' });

      const upd = queries[0]!;
      // 2 champs du patch (déclarés subject puis body dans le store) -> $1, $2 ; updated_at=now() SANS
      // placeholder ; puis WHERE tenant_id=$3 and id=$4 (poussés en dernier dans vals).
      expect(upd.sql).toMatch(/set\s+subject\s*=\s*\$1\s*,\s*body\s*=\s*\$2\s*,\s*updated_at\s*=\s*now\(\)/i);
      expect(upd.sql).toMatch(/where\s+tenant_id\s*=\s*\$3\s+and\s+id\s*=\s*\$4\s+and\s+deleted_at is null/i);
      expect(upd.params).toEqual(['Nouveau sujet', 'Nouveau corps', TENANT, 'tpl-1']);
    });

    it('un seul champ dans le patch (format) -> une seule colonne dans le SET', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailTemplateStore(pool).update(TENANT, 'tpl-1', { format: 'html' });

      const upd = queries[0]!;
      expect(upd.sql).toMatch(/set\s+format\s*=\s*\$1\s*,\s*updated_at\s*=\s*now\(\)/i);
      expect(upd.sql).not.toMatch(/\bname\s*=/i);
      expect(upd.sql).not.toMatch(/\bsubject\s*=/i);
      expect(upd.sql).not.toMatch(/\bbody\s*=/i);
      expect(upd.params).toEqual(['html', TENANT, 'tpl-1']);
    });

    it('patch vide ({}) ne lance AUCUN UPDATE et renvoie le résultat de getById()', async () => {
      const { pool, queries } = fakePool();
      const store = new PgEmailTemplateStore(pool);

      const result = await store.update(TENANT, 'tpl-1', {});

      expect(queries.some((q) => /^update email_templates set/i.test(q.sql))).toBe(false); // aucun UPDATE, d'aucune forme
      expect(queries).toHaveLength(1); // uniquement le SELECT de getById()
      expect(queries[0]!.sql).toMatch(/^select/i);
      expect(result?.id).toBe('tpl-1'); // la ligne renvoyée par getById()
    });

    it('id inconnu (ou autre tenant) sur un patch non vide -> null, pas de ligne RETURNING', async () => {
      const { pool } = fakePool({ row: null });
      const store = new PgEmailTemplateStore(pool);
      expect(await store.update(OTHER_TENANT, 'inexistant', { name: 'x' })).toBeNull();
    });
  });

  it('softDelete() : UPDATE deleted_at=now() scopé tenant_id + id, jamais un delete réel', async () => {
    const { pool, queries } = fakePool({ rowCount: 1 });
    const store = new PgEmailTemplateStore(pool);
    const ok = await store.softDelete(TENANT, 'tpl-1');

    const upd = queries.find((q) => /update email_templates/i.test(q.sql));
    expect(upd).toBeTruthy();
    expect(upd!.sql).toMatch(/deleted_at\s*=\s*now\(\)/i);
    expect(upd!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    expect(upd!.sql).toMatch(/deleted_at is null/i); // ne redélie pas une ligne déjà supprimée
    expect(upd!.sql).not.toMatch(/^delete/i); // suppression douce uniquement
    expect(upd!.params).toEqual([TENANT, 'tpl-1']);
    expect(ok).toBe(true);
  });

  it('softDelete() : aucune ligne touchée (autre tenant ou id inconnu) -> false', async () => {
    const { pool } = fakePool({ rowCount: 0 });
    const store = new PgEmailTemplateStore(pool);
    expect(await store.softDelete(OTHER_TENANT, 'inexistant')).toBe(false);
  });

  describe('Isolation tenant : SQL + params scopés tenant_id (et deleted_at is null) sur CHAQUE méthode', () => {
    it('list()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailTemplateStore(pool).list(TENANT);
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });

    it('getById()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailTemplateStore(pool).getById(TENANT, 'tpl-1');
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.params[1]).toBe('tpl-1');
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });

    it('create()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailTemplateStore(pool).create(TENANT, baseInput('iso'));
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT); // tenant_id = 1re colonne de l'INSERT
      expect(q.sql).toMatch(/tenant_id/i);
    });

    it('update()', async () => {
      const { pool, queries } = fakePool();
      await new PgEmailTemplateStore(pool).update(TENANT, 'tpl-1', { name: 'iso' });
      const upd = queries[0]!;
      // tenant_id/id sont les 2 DERNIERS params ici (patch avant), pas params[0].
      expect(upd.params.at(-2)).toBe(TENANT);
      expect(upd.params.at(-1)).toBe('tpl-1');
      expect(upd.sql).toMatch(/tenant_id\s*=\s*\$\d+/i);
      expect(upd.sql).toMatch(/deleted_at is null/i);
    });

    it('softDelete()', async () => {
      const { pool, queries } = fakePool({ rowCount: 1 });
      await new PgEmailTemplateStore(pool).softDelete(TENANT, 'tpl-1');
      const q = queries[0]!;
      expect(q.params[0]).toBe(TENANT);
      expect(q.params[1]).toBe('tpl-1');
      expect(q.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(q.sql).toMatch(/deleted_at is null/i);
    });
  });
});
