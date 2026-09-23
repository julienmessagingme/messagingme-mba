import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgPubConnexionStore } from '../../src/pubs/connexion.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du dépôt). La CI monte un Postgres jetable pour ça (job `integration`).
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('lot 2 des pubs : la connexion d un espace (Postgres réel)', () => {
  let pool: Pool;
  let store: PgPubConnexionStore;
  let tenantId = '';
  let voisinId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgPubConnexionStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pub-cnx') returning id`)).rows[0]!.id;
    voisinId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pub-cnx-v') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId !== '') await pool.query('delete from tenants where id = any($1::uuid[])', [[tenantId, voisinId]]);
    await pool?.end();
  });

  it('pose un jeton, puis le relit sans jamais rendre le jeton dans l état', async () => {
    await store.poserJeton(tenantId, 'CHIFFRE_1', null);
    const etat = await store.lire(tenantId);
    expect(etat).not.toBeNull();
    expect(etat?.comptePubId).toBeNull();
    expect(etat?.pageLiee).toBeNull();
    expect(Object.keys(etat ?? {})).not.toContain('jetonChiffre');
    await expect(store.lireJetonChiffre(tenantId)).resolves.toBe('CHIFFRE_1');
  });

  it('🔴 un second jeton n ECRASE JAMAIS le premier : la base refuse, et le dit', async () => {
    await store.choisirActifs(tenantId, { comptePubId: '111', compteNom: 'GMC', pageId: 'p1', pageNom: 'Gerermonchantier', devise: 'EUR', fuseau: 'Europe/Paris', pageLiee: 'oui' });
    const etat = await store.lire(tenantId);
    expect(etat?.comptePubId).toBe('111');
    // Les NOMS sont gardes (0169) : l ecran montre « GMC », pas quinze chiffres.
    expect(etat?.compteNom).toBe('GMC');
    expect(etat?.pageNom).toBe('Gerermonchantier');

    // Le jeton en place n expire jamais : l ecraser laisserait un acces vivant dont nous perdrions le seul
    // exemplaire (le piege de la cle Vercel, 0124). Pour reconnecter, il faut passer par la deconnexion.
    await expect(store.poserJeton(tenantId, 'CHIFFRE_2', null)).resolves.toBe(false);
    const { rows } = await pool.query<{ n: string }>('select count(*) as n from pub_connexion where tenant_id = $1', [tenantId]);
    expect(rows[0]!.n).toBe('1');
    await expect(store.lireJetonChiffre(tenantId)).resolves.toBe('CHIFFRE_1');
    expect((await store.lire(tenantId))?.comptePubId).toBe('111');
  });

  it('apres une deconnexion, un jeton neuf se pose : le chemin normal reste ouvert', async () => {
    await store.supprimer(tenantId);
    await expect(store.poserJeton(tenantId, 'CHIFFRE_3', null)).resolves.toBe(true);
    await expect(store.lireJetonChiffre(tenantId)).resolves.toBe('CHIFFRE_3');
    expect((await store.lire(tenantId))?.comptePubId).toBeNull();
  });

  it('🔴 un espace ne voit JAMAIS la connexion d un autre', async () => {
    await store.poserJeton(voisinId, 'CHIFFRE_VOISIN', null);
    await store.choisirActifs(voisinId, { comptePubId: '999', compteNom: 'Voisin', pageId: 'p9', pageNom: 'Page voisine', devise: 'USD', fuseau: 'America/New_York', pageLiee: 'non' });
    expect((await store.lire(tenantId))?.comptePubId).toBeNull();
    // CHIFFRE_3 : c'est le jeton pose par le cas precedent, apres deconnexion. Ces cas partagent leur
    // espace et s'enchainent, donc le jeton attendu ici SUIT ce que le cas d'avant a laisse.
    await expect(store.lireJetonChiffre(tenantId)).resolves.toBe('CHIFFRE_3');
    expect((await store.lire(voisinId))?.devise).toBe('USD');
  });

  it('le rejet du jeton se pose une fois, et la ligne RESTE (sinon l écran dirait « jamais connecté »)', async () => {
    await store.marquerJetonRejete(tenantId);
    const premier = (await store.lire(tenantId))?.jetonRejeteLe;
    expect(premier).toBeInstanceOf(Date);
    await store.marquerJetonRejete(tenantId);
    expect((await store.lire(tenantId))?.jetonRejeteLe?.getTime()).toBe(premier?.getTime());
    expect(await store.lireJetonChiffre(tenantId)).not.toBeNull();
  });

  it('⚠️ les trois valeurs de liaison passent la contrainte, une quatrième est REFUSÉE par la base', async () => {
    for (const v of ['oui', 'non', 'inconnu'] as const) {
      await store.choisirActifs(tenantId, { comptePubId: '111', compteNom: 'GMC', pageId: 'p1', pageNom: 'Gerermonchantier', devise: 'EUR', fuseau: 'Europe/Paris', pageLiee: v });
      expect((await store.lire(tenantId))?.pageLiee).toBe(v);
    }
    await expect(
      pool.query('update pub_connexion set page_liee = $2 where tenant_id = $1', [tenantId, 'peut-etre']),
    ).rejects.toThrow();
  });

  it('la déconnexion efface la ligne, jeton compris', async () => {
    await store.supprimer(tenantId);
    await expect(store.lire(tenantId)).resolves.toBeNull();
    await expect(store.lireJetonChiffre(tenantId)).resolves.toBeNull();
  });

  it('🔴 la suppression d un espace emporte sa connexion (cascade), donc aucun jeton orphelin', async () => {
    const jetable = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pub-cnx-jetable') returning id`)).rows[0]!.id;
    await store.poserJeton(jetable, 'CHIFFRE_JETABLE', null);
    await pool.query('delete from tenants where id = $1', [jetable]);
    await expect(store.lireJetonChiffre(jetable)).resolves.toBeNull();
  });
});
