import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { evaluerFiltreFiche, type CleFiltrable } from '../../src/crm/filtre-fiche';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES FILTRES DE LA DERNIÈRE ANALYSE, contre un VRAI Postgres (lot 2b « Tout sur la fiche »).
 *
 * Ce qu'un test pur ne peut pas dire : que la clause SQL retient EXACTEMENT les fiches que le bloc Condition
 * retient pour le même filtre (une campagne ne doit pas viser quelqu'un que son scénario écarte), que `null` et 0
 * se lisent pareil des deux côtés, et que `getContactStateByWaId` porte la copie au bloc Condition sans la mêler
 * aux champs perso.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION) : joué par le job `integration`.
 */
describe.skipIf(!url)('filtres de la dernière analyse (Postgres)', () => {
  let pool: Pool;
  let store: PgContactStore;
  let tenantId: string;
  let autreTenantId: string;

  /** Une copie entière (la contrainte de cohérence de 0196 l'exige), notes et date réglables. */
  const fiche = async (
    t: string, phone: string,
    a: { sentiment: string; satisfaction: number | null; urgence: number | null; resolue: boolean; joursDepuis: number } | null,
    fields: Record<string, string> = {},
  ): Promise<string> => {
    if (a === null) {
      return (await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164, fields) values ($1, $2, $3) returning id`, [t, phone, fields],
      )).rows[0]!.id;
    }
    return (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, fields, analyse_intention, analyse_sentiment, analyse_satisfaction,
         analyse_urgence, analyse_resolue, analyse_sujet, analyse_traitee_par, analyse_action, analyse_le, analyse_fenetre_fin)
       values ($1, $2, $3, 'reclamation', $4, $5, $6, $7, 'colis', 'humain', 'rappeler',
               now() - ($8::int * interval '1 day'), now() - ($8::int * interval '1 day'))
       returning id`,
      [t, phone, fields, a.sentiment, a.satisfaction, a.urgence, a.resolue, a.joursDepuis],
    )).rows[0]!.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgContactStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-filtre-fiche') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-filtre-fiche-autre') returning id`)).rows[0]!.id;
    await fiche(tenantId, '+33600200001', { sentiment: 'negatif', satisfaction: 0, urgence: 9, resolue: false, joursDepuis: 1 });
    await fiche(tenantId, '+33600200002', { sentiment: 'neutre', satisfaction: null, urgence: null, resolue: true, joursDepuis: 20 });
    await fiche(tenantId, '+33600200003', { sentiment: 'positif', satisfaction: 10, urgence: 0, resolue: true, joursDepuis: 200 });
    // Jamais analysée, mais porte un champ perso homonyme (d'avant les clés réservées) : il ne doit compter nulle part.
    await fiche(tenantId, '+33600200004', null, { analyse_sentiment: 'negatif', analyse_urgence: '10' });
    // Le même profil dans un autre espace : jamais compté ici.
    await fiche(autreTenantId, '+33600200001', { sentiment: 'negatif', satisfaction: 0, urgence: 9, resolue: false, joursDepuis: 1 });
  });
  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const FILTRES: Array<[CleFiltrable, string, string]> = [
    ['analyse_sentiment', 'in', 'negatif'],
    ['analyse_sentiment', 'in', 'neutre,positif'],
    ['analyse_satisfaction', 'lte', '0'],
    ['analyse_satisfaction', 'gte', '0'],
    ['analyse_satisfaction', 'empty', ''],
    ['analyse_urgence', 'gte', '7'],
    ['analyse_urgence', 'lte', '0'],
    ['analyse_resolue', 'is_false', ''],
    ['analyse_resolue', 'is_true', ''],
    ['analyse_resolue', 'empty', ''],
    ['analyse_le', 'newer_than_days', '30'],
    ['analyse_le', 'not_empty', ''],
    ['analyse_intention', 'in', 'reclamation'],
    ['analyse_action', 'in', 'aucune'],
  ];

  it('🔴 pour chaque filtre, le SQL retient EXACTEMENT les fiches que le bloc Condition retient', async () => {
    // Les fiches telles que le bloc Condition les voit : par `getContactStateByWaId`, le vrai chemin.
    const numeros = ['33600200001', '33600200002', '33600200003', '33600200004'];
    const etats = await Promise.all(numeros.map(async (n) => ({ n, etat: (await store.getContactStateByWaId(tenantId, n))! })));
    const maintenant = new Date();
    for (const [cle, op, value] of FILTRES) {
      const ids = await store.idsForFilters(tenantId, { fieldFilters: [{ key: cle, op: op as never, value }] });
      const parSql = (await pool.query<{ phone_e164: string }>(
        'select phone_e164 from contacts where id = any($1::uuid[])', [ids],
      )).rows.map((r) => r.phone_e164.slice(1)).sort();
      const parCondition = etats.filter(({ etat }) => evaluerFiltreFiche(cle, op, value, etat.analyse, maintenant)).map(({ n }) => n).sort();
      expect(parSql, `${cle} ${op} ${value}`).toEqual(parCondition);
    }
  });

  it('les comptes attendus : 0 est une mesure, `null` n’en est pas une, l’homonyme ne compte pas', async () => {
    const compte = (key: string, op: string, value: string) => store.count(tenantId, { fieldFilters: [{ key, op: op as never, value }] });
    expect(await compte('analyse_satisfaction', 'lte', '0')).toBe(1);
    expect(await compte('analyse_satisfaction', 'empty', '')).toBe(2); // sans mesure, et jamais analysée
    expect(await compte('analyse_sentiment', 'in', 'negatif')).toBe(1); // ni l'homonyme, ni l'autre espace
    expect(await compte('analyse_urgence', 'gte', '7')).toBe(1);
    expect(await compte('analyse_resolue', 'is_false', '')).toBe(1);
    expect(await compte('analyse_le', 'newer_than_days', '30')).toBe(2);
  });

  it('🔴 le bloc Condition reçoit la copie À CÔTÉ des champs perso, jamais dedans', async () => {
    const analysee = (await store.getContactStateByWaId(tenantId, '33600200001'))!;
    expect(analysee.analyse).toMatchObject({ sentiment: 'negatif', satisfaction: 0, urgence: 9, resolue: false });
    expect(Object.keys(analysee.fields).some((k) => k.startsWith('analyse_'))).toBe(false);
    const jamais = (await store.getContactStateByWaId(tenantId, '33600200004'))!;
    expect(jamais.analyse).toBeNull();
    expect(jamais.fields).toEqual({ analyse_sentiment: 'negatif', analyse_urgence: '10' });
  });
});
