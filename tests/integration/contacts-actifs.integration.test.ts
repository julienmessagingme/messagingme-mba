import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca.
const url = process.env.DATABASE_URL ?? '';

/**
 * LES CONTACTS ACTIFS, JOUR PAR JOUR (bascule cumules/actifs, demandee par Julien le 2026-09-23).
 *
 * 🔴 POURQUOI EN INTEGRATION : la serie est calculee PAR DIFFERENCE en SQL (cumules moins supprimes, chacun
 * avec sa ligne de base et sa somme courante). Un faux pool prouverait la forme de la requete ; seul un vrai
 * Postgres dit si la courbe descend au bon jour, et surtout si elle ne REECRIT PAS LE PASSE.
 *
 * 🔴 LE CAS QUI COMPTE VRAIMENT EST LE DERNIER : un contact supprime AUJOURD'HUI ne doit pas faire baisser
 * la courbe d'il y a trois semaines. C'est l'erreur naturelle quand on compte « les contacts non supprimes »
 * sans borner la suppression a la journee affichee, et elle est parfaitement invisible : la courbe reste
 * plausible, elle est juste fausse partout avant la suppression.
 */
const AUJ = '2026-09-20';
const RANGE = { from: '2026-09-14', to: AUJ };

describe.skipIf(!url)('Contacts actifs : la courbe ne reecrit pas le passe (Postgres reel)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    store = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-contacts-actifs') returning id`)).rows[0]!.id;

    const contact = async (num: string, creeLe: string, supprimeLe: string | null) => pool.query(
      `insert into contacts (tenant_id, phone_e164, created_at, deleted_at)
       values ($1, $2, $3::timestamptz, $4::timestamptz)`,
      [tenantId, num, `${creeLe}T10:00:00+02`, supprimeLe === null ? null : `${supprimeLe}T10:00:00+02`],
    );
    // Deux contacts d'AVANT la plage : ils forment la ligne de base des deux courbes.
    await contact('+33600000701', '2026-09-01', null);
    await contact('+33600000702', '2026-09-02', null);
    // Un contact cree DANS la plage, puis supprime DANS la plage : la courbe des actifs redescend le 18.
    await contact('+33600000703', '2026-09-16', '2026-09-18');
    // Un contact d'avant la plage, supprime le DERNIER jour : tout le debut de plage doit rester intact.
    await contact('+33600000704', '2026-09-03', AUJ);
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query(`delete from contacts where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from tenants where id = $1`, [tenantId]);
    }
    await pool.end();
  });

  it('🔴 les CUMULES ne baissent jamais : une suppression n efface pas ce qu on a collecte', async () => {
    const d = await store.getDashboard(tenantId, RANGE);
    const par = new Map(d.contacts.map((p) => [p.date, p.count]));
    expect(par.get('2026-09-14'), 'trois contacts d avant la plage').toBe(3);
    expect(par.get('2026-09-16'), 'un quatrieme est arrive').toBe(4);
    expect(par.get('2026-09-18'), 'la suppression ne retire rien des cumules').toBe(4);
    expect(par.get(AUJ)).toBe(4);
  });

  it('🔴 les ACTIFS baissent le jour de la suppression, et pas avant', async () => {
    const d = await store.getDashboard(tenantId, RANGE);
    const par = new Map(d.contactsActifs.map((p) => [p.date, p.count]));
    expect(par.get('2026-09-14'), 'les trois d avant la plage sont encore la').toBe(3);
    expect(par.get('2026-09-16'), 'le quatrieme arrive').toBe(4);
    expect(par.get('2026-09-17'), 'rien n a encore ete supprime').toBe(4);
    expect(par.get('2026-09-18'), 'le contact supprime ce jour-la sort').toBe(3);
    expect(par.get('2026-09-19')).toBe(3);
  });

  it('🔴 une suppression du DERNIER jour ne touche QUE le dernier jour', async () => {
    // C'est le sens de la borne haute : sans elle, la courbe d'il y a une semaine baisserait aussi, et
    // personne ne le verrait (elle resterait parfaitement plausible).
    const d = await store.getDashboard(tenantId, RANGE);
    const par = new Map(d.contactsActifs.map((p) => [p.date, p.count]));
    expect(par.get('2026-09-19'), 'la veille est intacte').toBe(3);
    expect(par.get(AUJ), 'le quatrieme part le jour meme').toBe(2);
  });
});
