import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgLiberationStore } from '../src/numero/liberation.pg';

/**
 * 🔴 LE PRO RETIENT LA LIBÉRATION DANS SA TRANSACTION (lot 6, livraison B1, vigilance 4). Le balayage ne libère que sur
 * l'état couvert par le Pro (`etatDeLEspace`), mais il le lit AVANT la transaction : un Pro payé entre les deux ne doit
 * pas laisser partir le numéro, comme un réabonnement du numéro entre-temps. La libération résilie chez DIDWW : c'est le
 * geste irréversible du lot. La vraie base est vue par `tests/integration/liberation.integration.test.ts` (CI).
 */
const T = 't-pro';
const MAINTENANT = new Date('2026-10-20T10:00:00Z');

/** Un faux client : l'abonnement du numéro est dû, aucun autre n'est vivant ; le Pro répond selon `pro`. */
function base(pro: boolean) {
  const requetes: string[] = [];
  const client = {
    query: async (sql: string) => {
      requetes.push(sql);
      if (/^(begin|commit|rollback)$/.test(sql)) return { rowCount: 0, rows: [] };
      if (/from abonnements_numero\s+where stripe_subscription_id/.test(sql)) return { rowCount: 1, rows: [{}] };
      if (/statut <> 'resilie'/.test(sql)) return { rowCount: 0, rows: [] };
      if (/from abonnements_offre/.test(sql)) return pro ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
      throw new Error(`requête inattendue : ${sql.slice(0, 80)}`);
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, requetes };
}

describe('la libération et le Pro', () => {
  it('🔴 un Pro vivant, ou fini depuis moins de 7 jours : rien ne bouge, DIDWW jamais appelé', async () => {
    const { pool, requetes } = base(true);
    let resilie = 0;
    const r = await new PgLiberationStore(pool).liberer(T, 'sub_num', async () => { resilie += 1; }, MAINTENANT);
    expect(r).toEqual({ fait: 'rien' });
    expect(resilie).toBe(0);
    // La relecture porte la même grâce que la couverture : un Pro fini depuis moins de 7 jours retient encore.
    const relecture = requetes.find((q) => /from abonnements_offre/.test(q)) ?? '';
    expect(relecture).toMatch(/fini_le is null or fini_le > \$2::timestamptz - interval '7 days'/);
  });

  it('sans Pro : la transaction va au-delà de la relecture (le reste est vu par l’intégration)', async () => {
    const { pool } = base(false);
    await expect(new PgLiberationStore(pool).liberer(T, 'sub_num', async () => {}, MAINTENANT)).rejects.toThrow(/requête inattendue/);
  });
});
