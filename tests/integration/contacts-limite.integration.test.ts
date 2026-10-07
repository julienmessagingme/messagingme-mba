import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { LimiteOffreError } from '../../src/offres/refus';

/**
 * LA LIMITE DE CONTACTS DE L'OFFRE (lot 6, tâche 5), sur une vraie base. Une fiche créée par import, API, console ou
 * scénario compte ; une fiche née d'un message entrant ne compte jamais, et elle n'est jamais refusée. Mettre à jour une
 * fiche existante n'est jamais refusé ; une fiche supprimée libère sa place.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const LIMITE = 3;
const tel = (n: number) => `+3369990${String(n).padStart(4, '0')}`;

describe.skipIf(!url)('la limite de contacts de l’offre', () => {
  let pool: Pool;
  let store: PgContactStore;
  let t = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgContactStore(pool, undefined, async () => LIMITE);
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-limite-contacts') returning id`)).rows[0]!.id;
  });
  beforeEach(async () => { await pool.query('delete from contacts where tenant_id = $1', [t]); });
  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const creer = (n: number) => store.upsertByPhoneReturningId({ tenantId: t, phoneE164: tel(n), profileName: null, fields: {}, optInStatus: 'unknown' });

  it('🔴 la fiche au-delà de la limite est refusée par chacun des trois chemins de création', async () => {
    for (let n = 1; n <= LIMITE; n++) await creer(n);
    await expect(creer(99)).rejects.toBeInstanceOf(LimiteOffreError);
    await expect(store.creerFicheApi(t, { phoneE164: tel(98) })).rejects.toBeInstanceOf(LimiteOffreError);
    await expect(store.upsertManyByPhone({ tenantId: t, optInStatus: 'unknown', autorite: 'import', contacts: [{ phoneE164: tel(97), profileName: null, fields: {} }] }))
      .rejects.toBeInstanceOf(LimiteOffreError);
    const r = await pool.query<{ n: number }>('select count(*)::int as n from contacts where tenant_id = $1', [t]);
    expect(r.rows[0]!.n).toBe(LIMITE);
  });

  it('🔴 mettre à jour une fiche existante, limite atteinte, n’est jamais refusé', async () => {
    for (let n = 1; n <= LIMITE; n++) await creer(n);
    const r = await store.upsertByPhoneReturningId({ tenantId: t, phoneE164: tel(1), profileName: 'Camille', fields: { ville: 'Lyon' }, optInStatus: 'unknown' });
    expect(r.created).toBe(false);
    expect(await store.upsertManyByPhone({ tenantId: t, optInStatus: 'unknown', autorite: 'import', contacts: [{ phoneE164: tel(2), profileName: 'Lou', fields: {} }] }))
      .toEqual(['updated']);
  });

  it('🔴 vigilance 1 : une fiche née d’un entrant n’est jamais refusée ni comptée, même complétée ensuite', async () => {
    for (let n = 1; n <= LIMITE; n++) await creer(n);
    expect(await store.upsertFromInbound(t, tel(50).slice(1), 'Inconnu')).toBe('created');
    // Complétée par la console : elle reste « née d'un entrant », donc hors du compte.
    await store.upsertByPhoneReturningId({ tenantId: t, phoneE164: tel(50), profileName: 'Connu', fields: {}, optInStatus: 'unknown' });
    const r = await pool.query<{ ne_entrant: boolean }>('select ne_entrant from contacts where tenant_id = $1 and phone_e164 = $2', [t, tel(50)]);
    expect(r.rows[0]!.ne_entrant).toBe(true);
    await expect(creer(51)).rejects.toBeInstanceOf(LimiteOffreError);
  });

  it('🔴 vigilance 6 : une fiche supprimée libère sa place', async () => {
    for (let n = 1; n <= LIMITE; n++) await creer(n);
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and phone_e164 = $2', [t, tel(1)]);
    await expect(creer(60)).resolves.toMatchObject({ created: true });
  });

  it('un lot dont les fiches NEUVES dépassent le reste est refusé en entier : rien n’est écrit', async () => {
    await creer(1);
    await expect(store.verifierPlaceContacts(t, [tel(1), tel(2), tel(3), tel(4)])).rejects.toBeInstanceOf(LimiteOffreError);
    await expect(store.verifierPlaceContacts(t, [tel(1), tel(2), tel(3)])).resolves.toBeUndefined();
  });

  it('sans limite (Pro, Entreprise), rien n’est compté ni refusé', async () => {
    const libre = new PgContactStore(pool);
    for (let n = 1; n <= LIMITE + 2; n++) await libre.upsertByPhoneReturningId({ tenantId: t, phoneE164: tel(n), profileName: null, fields: {}, optInStatus: 'unknown' });
    const r = await pool.query<{ n: number }>('select count(*)::int as n from contacts where tenant_id = $1', [t]);
    expect(r.rows[0]!.n).toBe(LIMITE + 2);
  });
});
