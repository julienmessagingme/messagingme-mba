import '../../src/charger-env';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgComptesApplication } from '../../src/application/comptes.pg';
import { effacerEtatAuth, etatAuthPostgres } from '../../src/application/transport/etat-auth';

/**
 * L'ÉTAT D'AUTHENTIFICATION D'UNE SESSION DE L'APPLICATION (migration 0247), recopié de wagroups avec ses tests
 * (commit 526d3cc, `src/transport/baileys/authState.test.ts`), sur une vraie base.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const CLE = Buffer.alloc(32, 7);

describe.skipIf(!url)('l’état d’authentification d’une session (0247)', () => {
  let pool: Pool;
  let comptes: PgComptesApplication;
  const espaces: string[] = [];
  let compteId = '';

  const nouveauCompte = async (numero: string): Promise<string> => {
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-etat-auth') returning id`)).rows[0]!.id;
    espaces.push(t);
    const p = await comptes.preparer(t, { numero, fourniId: null });
    if (!p.ok) throw new Error(`préparation refusée : ${p.raison}`);
    return p.compte.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    comptes = new PgComptesApplication(pool);
  });

  beforeEach(async () => {
    compteId = await nouveauCompte(`4499900008${String(espaces.length).padStart(2, '0')}`);
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    await pool.end();
  });

  const lire = (categorie: string, cle: string, compte = compteId) => pool.query<{ valeur: string; maj_le: string }>(
    'select valeur, maj_le::text as maj_le from comptes_application_auth where compte_id = $1 and categorie = $2 and cle = $3',
    [compte, categorie, cle],
  );

  it('crée des identifiants neufs quand la base est vide, puis relit les mêmes après un saveCreds', async () => {
    const premier = await etatAuthPostgres(pool, compteId, CLE);
    expect(premier.state.creds.registered).toBe(false);
    premier.state.creds.registered = true;
    await premier.saveCreds();
    const second = await etatAuthPostgres(pool, compteId, CLE);
    expect(second.state.creds.registered).toBe(true);
    expect(second.state.creds.noiseKey.private).toEqual(premier.state.creds.noiseKey.private);
  });

  it('écrit et relit une clé de Signal en Buffer, pas en objet dégradé', async () => {
    const { state } = await etatAuthPostgres(pool, compteId, CLE);
    await state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1, 2, 3]) } as never } });
    const valeur = (await state.keys.get('pre-key', ['1']))['1'] as { public: Buffer } | undefined;
    expect(Buffer.isBuffer(valeur!.public)).toBe(true);
    expect(valeur!.public).toEqual(Buffer.from([1, 2, 3]));
  });

  it('écrit UNE ligne par clé : un set n’écrase pas les clés sœurs', async () => {
    const { state } = await etatAuthPostgres(pool, compteId, CLE);
    await state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]) } as never } });
    const avant = (await lire('pre-key', '1')).rows[0]!.maj_le;
    await state.keys.set({ 'pre-key': { '2': { public: Buffer.from([2]) } as never } });
    expect((await lire('pre-key', '1')).rows[0]!.maj_le).toBe(avant);
    const lu = await state.keys.get('pre-key', ['1', '2']);
    expect(lu['1']).toBeDefined();
    expect(lu['2']).toBeDefined();
  });

  it('supprime une clé dont la valeur est nulle', async () => {
    const { state } = await etatAuthPostgres(pool, compteId, CLE);
    await state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]) } as never } });
    await state.keys.set({ 'pre-key': { '1': null } });
    expect((await lire('pre-key', '1')).rowCount).toBe(0);
  });

  it('ne laisse aucune valeur en clair en base, même décodée de son base64', async () => {
    const { state, saveCreds } = await etatAuthPostgres(pool, compteId, CLE);
    state.creds.me = { id: 'marqueur-tres-reconnaissable@s.whatsapp.net', name: 'x' };
    await saveCreds();
    const lignes = await pool.query<{ valeur: string }>('select valeur from comptes_application_auth where compte_id = $1', [compteId]);
    expect(lignes.rowCount).toBeGreaterThan(0);
    for (const l of lignes.rows) {
      expect(l.valeur).not.toContain('marqueur-tres-reconnaissable');
      expect(Buffer.from(l.valeur, 'base64').toString('utf8')).not.toContain('marqueur-tres-reconnaissable');
    }
  });

  it('refuse de relire avec une autre clé de chiffrement', async () => {
    const premier = await etatAuthPostgres(pool, compteId, CLE);
    await premier.saveCreds();
    await expect(etatAuthPostgres(pool, compteId, Buffer.alloc(32, 42))).rejects.toThrow();
  });

  it('lie le chiffré à sa ligne : déplacé vers une autre clé, une autre catégorie ou un autre compte, il ne se lit plus', async () => {
    const { state } = await etatAuthPostgres(pool, compteId, CLE);
    await state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]) } as never, '2': { public: Buffer.from([2]) } as never } });
    await state.keys.set({ 'app-state-sync-key': { '1': { public: Buffer.from([9]) } as never } });
    const ligne1 = (await lire('pre-key', '1')).rows[0]!.valeur;
    await pool.query(`update comptes_application_auth set valeur = $1 where compte_id = $2 and categorie = 'pre-key' and cle = '2'`, [ligne1, compteId]);
    await expect(state.keys.get('pre-key', ['2'])).rejects.toThrow();
    await pool.query(`update comptes_application_auth set valeur = $1 where compte_id = $2 and categorie = 'app-state-sync-key' and cle = '1'`, [ligne1, compteId]);
    await expect(state.keys.get('app-state-sync-key', ['1'])).rejects.toThrow();

    const autre = await nouveauCompte('449990000899');
    const autreEtat = await etatAuthPostgres(pool, autre, CLE);
    await autreEtat.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([2]) } as never } });
    await pool.query(`update comptes_application_auth set valeur = $1 where compte_id = $2 and categorie = 'pre-key' and cle = '1'`, [ligne1, autre]);
    await expect(autreEtat.state.keys.get('pre-key', ['1'])).rejects.toThrow();
  });

  it('effacer ne laisse aucune clé du compte', async () => {
    const { state, saveCreds } = await etatAuthPostgres(pool, compteId, CLE);
    await saveCreds();
    await state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]) } as never } });
    await effacerEtatAuth(pool, compteId);
    const reste = await pool.query('select 1 from comptes_application_auth where compte_id = $1', [compteId]);
    expect(reste.rowCount).toBe(0);
  });
});
