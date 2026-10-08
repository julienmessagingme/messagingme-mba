import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgKnowledgeStore } from '../../src/agent/knowledge.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * 🔴 LES FICHES À VECTORISER SONT CELLES D'UN ESPACE QUI A DU CRÉDIT (lot 6, livraison C, tâche 18). La vectorisation
 * se paie sur le crédit du client : sans crédit, une fiche attend. Le filtre est dans la requête, pas après elle : un lot
 * rempli des fiches d'espaces sans crédit bloquerait sinon le balayage pour tous les autres.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('les fiches à vectoriser, selon le crédit de leur espace (Postgres)', () => {
  let pool: Pool;
  const espaces: string[] = [];
  const fiches: Record<string, string> = {};

  async function espaceAvecFiche(nom: string, solde: number | null): Promise<string> {
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    espaces.push(t);
    if (solde !== null) await pool.query(`insert into agent_credits (tenant_id, solde_micro_eur) values ($1, $2)`, [t, solde]);
    const a = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-vect', 'Je suis une IA.', 'm') returning id`, [t],
    )).rows[0]!.id;
    fiches[nom] = (await pool.query<{ id: string }>(
      `insert into agent_knowledge (tenant_id, agent_id, titre, corps) values ($1, $2, 'titre', 'corps') returning id`, [t, a],
    )).rows[0]!.id;
    return t;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    await pool.end();
  });

  it('seule la fiche de l’espace qui a du crédit est rendue, avec son espace ; à zéro ou sans ligne, elle attend', async () => {
    const riche = await espaceAvecFiche('itest-vect-credit', 1_000_000);
    await espaceAvecFiche('itest-vect-zero', 0);
    await espaceAvecFiche('itest-vect-sans', null);
    const lot = await new PgKnowledgeStore(pool).fichesAVectoriser('itest-modele-payant', 100_000);
    const ids = lot.map((f) => f.id);
    expect(ids).toContain(fiches['itest-vect-credit']);
    expect(ids).not.toContain(fiches['itest-vect-zero']);
    expect(ids).not.toContain(fiches['itest-vect-sans']);
    expect(lot.find((f) => f.id === fiches['itest-vect-credit'])?.tenantId).toBe(riche);
  });
});
