import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWidgetStore, type WidgetInput } from '../../src/widgets/store.pg';
import { PgWidgetTirsStore } from '../../src/widgets/tirs.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour
// ça (job `integration`). `describe.skipIf(!url)` le rend inerte sans DATABASE_URL, mais ne protège pas contre
// un DATABASE_URL défini qui pointerait sur la production.
const url = process.env.DATABASE_URL ?? '';

/**
 * Les tirs des widgets (migration 0201), contre un vrai Postgres : l'anti-rebond et le plafond horaire du scénario
 * d'un widget (lot 3 du plan) reposent sur ces quatre requêtes, que le runner des automations appelle.
 *
 * 🔴 L'ISOLATION EST LE PREMIER SUJET : chaque requête porte `tenant_id = $1`, la RLS étant contournée par le
 * pooler. Un tir posé au nom d'un espace sur le widget d'un autre doit ne RIEN écrire, et la lecture d'un espace ne
 * doit jamais voir les tirs d'un autre, sinon l'anti-rebond d'un client ferait taire le scénario d'un autre.
 */
describe.skipIf(!url)('PgWidgetTirsStore (Postgres réel)', () => {
  let pool: Pool;
  let tirs: PgWidgetTirsStore;
  let widgets: PgWidgetStore;
  let tenantId = '';
  let autreTenantId = '';

  const widget = (): WidgetInput => ({
    nom: 'itest-tirs', phrase: `itest tirs ${randomUUID()}`, devenir: null, agentId: null, workflowId: null,
    couleur: '#25d366', position: 'bas_droite', libelle: null, avatarUrl: null, badge: true, actif: true,
    maxParHeure: null,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tirs = new PgWidgetTirsStore(pool);
    widgets = new PgWidgetStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-widget-tirs') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-widget-tirs-voisin') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    // Les tirs partent par cascade avec leur widget, et le widget avec son espace.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('un tir se lit, se compte, s’écrase par contact et s’efface', async () => {
    const w = await widgets.creer(tenantId, widget());
    const t = tirs.pour(tenantId);
    const avant = new Date(Date.now() - 60_000);
    expect(await t.lastFiredAt(w.id, '33600000001')).toBeNull();
    expect(await t.markFired(w.id, '33600000001')).toBe(true);
    expect(await t.lastFiredAt(w.id, '33600000001')).toBeInstanceOf(Date);
    // Une ligne par contact : le second tir du même contact écrase, il ne compte pas double au plafond.
    expect(await t.markFired(w.id, '33600000001')).toBe(true);
    expect(await t.markFired(w.id, '33600000002')).toBe(true);
    expect(await t.firedSince(w.id, avant)).toBe(2);
    expect(await t.firedSince(w.id, new Date(Date.now() + 60_000))).toBe(0);
    await t.clearFired(w.id, '33600000001');
    expect(await t.lastFiredAt(w.id, '33600000001')).toBeNull();
    expect(await t.firedSince(w.id, avant)).toBe(1);
  });

  it('🔴 isolation : un espace n’écrit, ne lit, ne compte ni n’efface les tirs du widget d’un autre', async () => {
    const w = await widgets.creer(tenantId, widget());
    await tirs.pour(tenantId).markFired(w.id, '33600000003');
    const voisin = tirs.pour(autreTenantId);
    // Écrire au nom du voisin sur ce widget n'écrit rien : l'insertion passe par le widget filtré sur l'espace.
    expect(await voisin.markFired(w.id, '33600000004')).toBe(false);
    expect(await voisin.lastFiredAt(w.id, '33600000003')).toBeNull();
    expect(await voisin.firedSince(w.id, new Date(Date.now() - 3600_000))).toBe(0);
    await voisin.clearFired(w.id, '33600000003');
    // Le témoin : le tir de l'espace propriétaire est toujours là, et le voisin n'a rien ajouté.
    expect(await tirs.pour(tenantId).lastFiredAt(w.id, '33600000003')).toBeInstanceOf(Date);
    expect(await tirs.pour(tenantId).firedSince(w.id, new Date(Date.now() - 3600_000))).toBe(1);
  });

  it('un widget supprimé emporte ses tirs (cascade), et un tir sur lui n’écrit plus rien', async () => {
    const w = await widgets.creer(tenantId, widget());
    await tirs.pour(tenantId).markFired(w.id, '33600000005');
    expect(await widgets.supprimer(tenantId, w.id)).toBe(true);
    const reste = await pool.query('select 1 from widget_tirs where widget_id = $1', [w.id]);
    expect(reste.rowCount).toBe(0);
    expect(await tirs.pour(tenantId).markFired(w.id, '33600000005')).toBe(false);
  });
});
