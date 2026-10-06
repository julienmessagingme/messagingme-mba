import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { DidDejaDeclare, PgNumerosFournisStore } from '../../src/otp/store.pg';

/**
 * LA RÉSERVE DE NUMÉROS FOURNIS ET LES CODES CAPTÉS (migration 0210, lot 3a), sur une vraie base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : les CHECK et les unicités, exécutés par Postgres. Le CHECK à sens unique de
 * l'espace (un espace supprimé laisse un numéro `attribue` sans espace, et ça doit passer), la paire code et cause, et
 * l'unicité de `appel_id`, qui rend sans effet un envoi rejoué par le script de l'Asterisk.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
/** Des numéros que personne n'aura : préfixe britannique non attribué. */
const N1 = '449990000001';
const N2 = '449990000002';

describe.skipIf(!url)('la réserve de numéros fournis (0210)', () => {
  let pool: Pool;
  let store: PgNumerosFournisStore;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgNumerosFournisStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-numeros-fournis') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`delete from numeros_fournis where numero like '44999%'`);
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`delete from numeros_fournis where numero like '44999%'`);
  });

  it('déclarer : inscrit `libre` ; redéclarer rend l’existant sans le réécrire ; le même numéro DIDWW ailleurs : refusé', async () => {
    const a = await store.declarer(N1, 'did-itest-1');
    expect(a).toMatchObject({ cree: true, numero: { numero: N1, didwwDidId: 'did-itest-1', statut: 'libre', tenantId: null } });
    await pool.query(`update numeros_fournis set statut = 'attribue', tenant_id = $2 where numero = $1`, [N1, tenantId]);
    const b = await store.declarer(N1, 'did-itest-1');
    // 🔴 Une seconde déclaration ne remet jamais à `libre` un numéro attribué.
    expect(b).toMatchObject({ cree: false, numero: { statut: 'attribue', tenantId } });
    await expect(store.declarer(N2, 'did-itest-1')).rejects.toBeInstanceOf(DidDejaDeclare);
  });

  it('🔴 les CHECK : le format du numéro, la liste des statuts, et l’espace à sens unique', async () => {
    await expect(pool.query(`insert into numeros_fournis (numero, didww_did_id) values ('+449990000003', 'd3')`)).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`insert into numeros_fournis (numero, didww_did_id, statut) values ($1, 'd3', 'perdu')`, [N2])).rejects.toMatchObject({ code: '23514' });
    // Un espace sur un numéro libre : refusé.
    await expect(pool.query(`insert into numeros_fournis (numero, didww_did_id, tenant_id) values ($1, 'd3', $2)`, [N2, tenantId])).rejects.toMatchObject({ code: '23514' });
    // L'inverse est atteignable : un numéro attribué dont l'espace a disparu.
    await expect(pool.query(`insert into numeros_fournis (numero, didww_did_id, statut) values ($1, 'd3', 'attribue')`, [N2])).resolves.toBeDefined();
  });

  it('🔴 un espace supprimé laisse son numéro en place, sans espace (set null, pas de cascade)', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-numeros-fournis-autre') returning id`)).rows[0]!.id;
    await store.declarer(N1, 'did-itest-1');
    await pool.query(`update numeros_fournis set statut = 'attribue', tenant_id = $2, attribue_le = now() where numero = $1`, [N1, autre]);
    await pool.query('delete from tenants where id = $1', [autre]);
    expect(await store.parNumero(N1)).toMatchObject({ statut: 'attribue', tenantId: null });
  });

  it('🔴 un appel s’écrit une fois : rejoué, rien n’est réécrit ; la paire code et cause est tenue par la base', async () => {
    const { numero } = await store.declarer(N1, 'did-itest-1');
    expect(await store.ecrireCode(numero.id, { appelId: 'itest.1', code: '863801', transcription: 'your code is 8 6 3 8 0 1' })).toBe(true);
    expect(await store.ecrireCode(numero.id, { appelId: 'itest.1', code: '111111', transcription: 'autre' })).toBe(false);
    expect(await store.ecrireCode(numero.id, { appelId: 'itest.2', code: null, transcription: '', cause: 'transcription_indisponible' })).toBe(true);
    // Un code sans cause, ou une cause hors liste : refusés.
    await expect(pool.query(`insert into codes_verification (numero_id, appel_id, code, cause) values ($1, 'itest.3', '123456', 'code_introuvable')`, [numero.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`insert into codes_verification (numero_id, appel_id, code, cause) values ($1, 'itest.4', null, 'autre')`, [numero.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`insert into codes_verification (numero_id, appel_id, code) values ($1, 'itest.5', '12345')`, [numero.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('🔴 une transcription en PANNE se remplace au rejeu ; un appel lu, jamais ; `appelDejaLu` et `appelsRecents`', async () => {
    const { numero } = await store.declarer(N1, 'did-itest-1');
    expect(await store.ecrireCode(numero.id, { appelId: 'itest.20', code: null, transcription: '', cause: 'transcription_indisponible' })).toBe(true);
    expect(await store.appelDejaLu('itest.20')).toBe(false);
    expect(await store.ecrireCode(numero.id, { appelId: 'itest.20', code: '863801', transcription: 'your code is 863801' })).toBe(true);
    expect(await store.appelDejaLu('itest.20')).toBe(true);
    expect(await store.ecrireCode(numero.id, { appelId: 'itest.20', code: null, transcription: '', cause: 'transcription_indisponible' })).toBe(false);
    const ligne = await pool.query(`select code, cause from codes_verification where appel_id = 'itest.20'`);
    expect(ligne.rows).toEqual([{ code: '863801', cause: null }]);
    expect(await store.appelsRecents(numero.id, 60)).toBe(1);
  });

  it('lister : chaque numéro et son DERNIER appel, `null` sans appel ; purger : les appels anciens seulement', async () => {
    const { numero } = await store.declarer(N1, 'did-itest-1');
    await store.declarer(N2, 'did-itest-2');
    await store.ecrireCode(numero.id, { appelId: 'itest.10', code: null, transcription: 'rien', cause: 'code_introuvable' });
    await store.ecrireCode(numero.id, { appelId: 'itest.11', code: '863801', transcription: 'your code is 863801' });
    await pool.query(`update codes_verification set recu_le = now() - interval '10 days' where appel_id = 'itest.10'`);
    const liste = (await store.lister()).filter((n) => n.numero.startsWith('44999'));
    expect(liste.find((n) => n.numero === N1)?.dernierCode).toMatchObject({ appelId: 'itest.11', code: '863801', cause: null });
    expect(liste.find((n) => n.numero === N2)?.dernierCode).toBeNull();
    expect(await store.purgerAvant(7)).toBeGreaterThanOrEqual(1);
    const restants = await pool.query(`select appel_id from codes_verification where numero_id = $1`, [numero.id]);
    expect(restants.rows.map((r) => r.appel_id)).toEqual(['itest.11']);
  });

  /**
   * 🔴 LE NUMÉRO FOURNI CÔTÉ CLIENT (lot 3b, migration 0212). L'attribution est la seule écriture qui donne un numéro de
   * la réserve à un espace : elle doit tenir deux espaces qui se disputent le dernier numéro libre, et deux demandes
   * du MÊME espace (double clic). Le code d'un espace ne se lit que sur SON numéro, après l'attribution.
   */
  describe('l’attribution à un espace (0212)', () => {
    let autre = '';
    beforeAll(async () => {
      autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-numeros-fournis-b') returning id`)).rows[0]!.id;
    });
    afterAll(async () => {
      await pool.query(`delete from numeros_fournis where numero like '44999%'`);
      if (autre) await pool.query('delete from tenants where id = $1', [autre]);
    });
    // ⚠️ Les comptes de numéros libres supposent une réserve qui ne contient que les numéros de ce fichier : c'est le cas
    // en CI (base jetable, seul fichier qui écrit numeros_fournis, fichiers joués l'un après l'autre).

    it('🔴 deux espaces, un seul numéro libre : un seul gagne, l’autre reçoit null', async () => {
      await store.declarer(N1, 'did-itest-1');
      const [a, b] = await Promise.all([store.attribuer(tenantId), store.attribuer(autre)]);
      expect([a, b].filter((x) => x !== null)).toHaveLength(1);
      expect(await store.compterLibres()).toBe(0);
    });

    it('🔴 rejouée par le même espace, elle rend le même numéro ; deux demandes simultanées aussi', async () => {
      await store.declarer(N1, 'did-itest-1');
      await store.declarer(N2, 'did-itest-2');
      const [x, y] = await Promise.all([store.attribuer(tenantId), store.attribuer(tenantId)]);
      expect(x?.numero).toBeDefined();
      expect(y?.numero).toBe(x?.numero);
      expect((await store.attribuer(tenantId))?.numero).toBe(x?.numero);
      expect(await store.compterLibres()).toBe(1);
      expect(await store.numeroDeLEspace(tenantId)).toMatchObject({ numero: x?.numero, statut: 'attribue', tenantId });
    });

    it('🔴 le code d’un espace : sur SON numéro seulement, après l’attribution, jamais un appel sans code', async () => {
      const { numero: n1 } = await store.declarer(N1, 'did-itest-1');
      const { numero: n2 } = await store.declarer(N2, 'did-itest-2');
      // Un appel reçu AVANT l'attribution ne compte pas.
      await store.ecrireCode(n1.id, { appelId: 'itest.30', code: '111111', transcription: 'avant' });
      await pool.query(`update codes_verification set recu_le = now() - interval '1 minute' where appel_id = 'itest.30'`);
      const pris = await store.attribuer(tenantId);
      expect(pris?.numero).toBe(N1);
      expect(await store.codeDeLEspace(tenantId)).toBeNull();
      await store.ecrireCode(n1.id, { appelId: 'itest.31', code: null, transcription: 'rien', cause: 'code_introuvable' });
      expect(await store.codeDeLEspace(tenantId)).toBeNull();
      await store.ecrireCode(n1.id, { appelId: 'itest.32', code: '863801', transcription: 'your code is 863801' });
      expect(await store.codeDeLEspace(tenantId)).toMatchObject({ code: '863801' });
      // Le numéro d'un autre espace : son code n'est jamais vu ici.
      await store.attribuer(autre);
      await store.ecrireCode(n2.id, { appelId: 'itest.33', code: '222222', transcription: 'autre' });
      expect(await store.codeDeLEspace(tenantId)).toMatchObject({ code: '863801' });
      expect(await store.codeDeLEspace(autre)).toMatchObject({ code: '222222' });
      // La borne des 15 minutes, éprouvée SEULE : l'attribution reculée d'une heure, le code reste après elle.
      await pool.query(`update numeros_fournis set attribue_le = now() - interval '1 hour' where numero = $1`, [N1]);
      await pool.query(`update codes_verification set recu_le = now() - interval '14 minutes' where appel_id = 'itest.32'`);
      expect(await store.codeDeLEspace(tenantId)).toMatchObject({ code: '863801' });
      await pool.query(`update codes_verification set recu_le = now() - interval '16 minutes' where appel_id = 'itest.32'`);
      expect(await store.codeDeLEspace(tenantId)).toBeNull();
    });

    it('remplacer : l’actuel passe en bloque, sans espace, et un autre est attribué ; rendre le remet en réserve', async () => {
      await store.declarer(N1, 'did-itest-1');
      await store.declarer(N2, 'did-itest-2');
      const premier = await store.attribuer(tenantId);
      const r = await store.remplacerNumero(tenantId);
      expect(r.bloque).toBe(premier?.numero);
      expect(r.nouveau?.numero).not.toBe(premier?.numero);
      expect(await store.parNumero(premier!.numero)).toMatchObject({ statut: 'bloque', tenantId: null });
      // Plus rien de libre : remplacer encore bloque l'actuel et rend null.
      expect(await store.remplacerNumero(tenantId)).toEqual({ bloque: r.nouveau?.numero, nouveau: null });
      await store.declarer('449990000003', 'did-itest-3');
      const t = await store.attribuer(tenantId);
      expect(await store.rendre(tenantId)).toBe(t?.numero);
      expect(await store.parNumero(t!.numero)).toMatchObject({ statut: 'libre', tenantId: null, attribueLe: null });
      expect(await store.numeroDeLEspace(tenantId)).toBeNull();
    });

    it('🔴 l’index tient : un second numéro attribué au même espace est refusé par la base', async () => {
      await store.declarer(N1, 'did-itest-1');
      await store.declarer(N2, 'did-itest-2');
      await store.attribuer(tenantId);
      await expect(pool.query(`update numeros_fournis set statut = 'attribue', tenant_id = $1, attribue_le = now() where numero = $2`, [tenantId, N2]))
        .rejects.toMatchObject({ code: '23505' });
    });
  });
});
