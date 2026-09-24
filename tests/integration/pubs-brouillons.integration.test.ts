import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgBrouillonsPubStore, type ChampsBrouillon } from '../../src/pubs/brouillons.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du dépôt). La CI monte un Postgres jetable pour ça (job `integration`).
const url = process.env.DATABASE_URL ?? '';

/**
 * LES BROUILLONS DE PUBLICITÉ CONTRE UN VRAI POSTGRES (migration 0171).
 *
 * 🔴 CE FICHIER EXISTE PARCE QUE RIEN D'AUTRE NE PEUT VOIR CE QU'IL VOIT. Le SQL d'un store n'est vérifié ni
 * par le compilateur (c'est une chaîne), ni par les tests de route (qui montent un faux store), ni par un
 * contrôle de noms de colonnes (qui ne dit rien des CHECK, des types, ni de ce que `bytea` rend à la
 * relecture). Sans ce fichier, la première exécution de ces requêtes serait en production.
 *
 * ⚠️ ET LE CAS QUI COMPTE LE PLUS EST L'ALLER-RETOUR DU VISUEL. Des octets écrits en `bytea` et relus en
 * base64 passent par deux conversions : c'est le seul endroit où l'on peut constater que l'image revient
 * IDENTIQUE, ce qui est la promesse même de la décision de la stocker.
 */
describe.skipIf(!url)('brouillons de publicité (Postgres réel)', () => {
  let pool: Pool;
  let store: PgBrouillonsPubStore;
  let tenantId = '';
  let voisinId = '';

  /** Une image minuscule mais RÉELLE : un PNG 1x1 valide, pour que l'aller-retour soit comparable octet à octet. */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const champs = (over: Partial<ChampsBrouillon> = {}): ChampsBrouillon => ({
    nom: 'Rentrée', titre: 'Un devis', texte: 'Écrivez-nous', accueil: 'Bonjour',
    messagePreRempli: 'Je veux un devis', budgetTotal: '', debut: '', fin: '',
    pays: 'FR', ageMin: '18', ageMax: '65', tagQualification: '',
    destination: 'scenario', workflowId: null,
    ...over,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgBrouillonsPubStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pub-br') returning id`)).rows[0]!.id;
    voisinId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pub-br-v') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId !== '') await pool.query('delete from tenants where id = any($1::uuid[])', [[tenantId, voisinId]]);
    await pool?.end();
  });

  it('enregistre un formulaire INCOMPLET, le relit, et le liste', async () => {
    const id = await store.creer(tenantId, champs({ budgetTotal: '', debut: '' }));
    const lu = await store.lire(tenantId, id);
    expect(lu).not.toBeNull();
    expect(lu?.nom).toBe('Rentrée');
    // Les champs vides restent vides : les colonnes sont `not null default ''`, jamais `null`.
    expect(lu?.budgetTotal).toBe('');
    expect(lu?.visuel).toBeNull();
    expect(lu?.aUnVisuel).toBe(false);
    const liste = await store.lister(tenantId);
    expect(liste.map((b) => b.id)).toContain(id);
  });

  it('🔴 le visuel fait l’aller-retour SANS se déformer', async () => {
    const id = await store.creer(tenantId, champs({ visuel: { type: 'image/png', base64: PNG } }));
    const lu = await store.lire(tenantId, id);
    expect(lu?.visuel?.type).toBe('image/png');
    // Octet pour octet : c'est ce qui prouve que `bytea` et le base64 ne se marchent pas dessus.
    expect(lu?.visuel?.base64).toBe(PNG);
  });

  it('🔴 la LISTE ne transporte pas les octets, elle ne dit que leur présence', async () => {
    // C'est un CONTRAT de performance, pas un détail : un brouillon peut peser 5 Mo, et la liste en
    // charge autant qu'il y en a. Un `select *` ferait de l'ouverture de l'écran un téléchargement.
    const id = await store.creer(tenantId, champs({ nom: 'Avec visuel', visuel: { type: 'image/jpeg', base64: PNG } }));
    const ligne = (await store.lister(tenantId)).find((b) => b.id === id);
    expect(ligne?.aUnVisuel).toBe(true);
    expect(ligne).not.toHaveProperty('visuel');
  });

  it('🔴 une mise à jour SANS visuel CONSERVE celui qui est en base', async () => {
    // Le cas qui protège l'image : corriger une faute de frappe ne doit pas effacer ce qu'on a mis le
    // plus de temps à choisir. C'est le `case when` de `mettreAJour` qui le tient, et lui seul.
    const id = await store.creer(tenantId, champs({ visuel: { type: 'image/png', base64: PNG } }));
    const ok = await store.mettreAJour(tenantId, id, champs({ nom: 'Corrigé' }));
    expect(ok).toBe(true);
    const lu = await store.lire(tenantId, id);
    expect(lu?.nom).toBe('Corrigé');
    expect(lu?.visuel?.base64).toBe(PNG);
  });

  it('une mise à jour avec `visuel: null` EFFACE, et les deux colonnes partent ensemble', async () => {
    const id = await store.creer(tenantId, champs({ visuel: { type: 'image/png', base64: PNG } }));
    await store.mettreAJour(tenantId, id, champs({ visuel: null }));
    const lu = await store.lire(tenantId, id);
    expect(lu?.visuel).toBeNull();
    expect(lu?.aUnVisuel).toBe(false);
    // Le CHECK de la migration refuse un type sans octets : s'il restait, cette écriture aurait échoué.
  });

  it('🔴 un brouillon d’un AUTRE espace est invisible, illisible et insupprimable', async () => {
    // L'isolation ne tient pas au code de la route, elle tient au `tenant_id = $1` de chaque requête :
    // la RLS est contournée par le pooler superuser, donc c'est le SEUL contrôle.
    const id = await store.creer(voisinId, champs({ nom: 'Chez le voisin' }));
    expect((await store.lister(tenantId)).map((b) => b.id)).not.toContain(id);
    await expect(store.lire(tenantId, id)).resolves.toBeNull();
    await expect(store.mettreAJour(tenantId, id, champs())).resolves.toBe(false);
    await expect(store.supprimer(tenantId, id)).resolves.toBe(false);
    // Et il est toujours là, chez son propriétaire : aucune des quatre tentatives ne l'a entamé.
    await expect(store.lire(voisinId, id)).resolves.not.toBeNull();
  });

  it('supprimer rend `true` une fois, puis `false` : la route en fait un 404', async () => {
    const id = await store.creer(tenantId, champs());
    await expect(store.supprimer(tenantId, id)).resolves.toBe(true);
    await expect(store.supprimer(tenantId, id)).resolves.toBe(false);
  });

  it('⚠️ la suppression d’un ESPACE emporte ses brouillons (cascade), image comprise', async () => {
    const jetable = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pub-br-j') returning id`)).rows[0]!.id;
    await store.creer(jetable, champs({ visuel: { type: 'image/png', base64: PNG } }));
    await pool.query('delete from tenants where id = $1', [jetable]);
    const reste = await pool.query('select 1 from pubs_brouillons where tenant_id = $1', [jetable]);
    expect(reste.rowCount).toBe(0);
  });
});
