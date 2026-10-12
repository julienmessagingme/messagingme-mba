import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgEntretienStore } from '../../src/agent/setup/entretien-store.pg';
import type { EntretienComplet } from '../../src/agent/setup/entretien-store';

const url = process.env.DATABASE_URL ?? '';

/**
 * L'entretien de construction en base, et l'adresse du site qu'il retient (0228). Le défaut d'avant ne se voyait
 * qu'à la relecture : la route posait `connaissanceUrl`, le store ne l'écrivait nulle part, et l'adresse donnée
 * au point `connaissance` disparaissait dès le tour suivant (agent SMATIS, 2026-10-12). Seul un vrai Postgres le
 * prouve : jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('entretien de construction en base (Postgres)', () => {
  let pool: Pool;
  let store: PgEntretienStore;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;

  const etat = (over: Partial<EntretienComplet> = {}): EntretienComplet => ({
    messages: [{ role: 'user', content: 'Mon agent répond sur nos contrats.' }],
    auteurs: [null],
    reponses: [{ point: 'mission', valeur: 'informer sur les offres' }],
    poses: ['mission'],
    bascules: [],
    ...over,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgEntretienStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-entretien') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-entretien-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele, max_tours, max_appels_outils, budget_micro_eur, inactivite_minutes)
       values ($1, 'itest', 'Je suis une IA.', 'anthropic/claude-haiku-4.5', 5, 7, 12345, 42) returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 l’adresse du site donnée pendant l’entretien survit à l’enregistrement', async () => {
    await store.ecrire(tenantId, agentId, etat({ connaissanceUrl: 'https://www.smatis.fr/' }));
    const relu = await store.lire(tenantId, agentId);
    expect(relu?.connaissanceUrl).toBe('https://www.smatis.fr/');
    // Et le reste de l'entretien est intact : une colonne neuve ne doit rien coûter à la relecture.
    expect(relu?.messages).toHaveLength(1);
    expect(relu?.reponses[0]?.point).toBe('mission');
  });

  it('🔴 un entretien SANS adresse se relit entier, sans adresse inventée ni retour au vierge', async () => {
    // La colonne vaut `null` : un `null` passé au schéma de relecture le ferait échouer, et l'entretien entier
    // retomberait sur le vierge, conversation perdue.
    await store.ecrire(tenantId, agentId, etat());
    const relu = await store.lire(tenantId, agentId);
    expect(relu?.connaissanceUrl).toBeUndefined();
    expect(relu?.messages).toHaveLength(1);
    expect(relu?.poses).toEqual(['mission']);
  });

  it('l’adresse se remplace au tour suivant, et un autre espace ne lit rien', async () => {
    await store.ecrire(tenantId, agentId, etat({ connaissanceUrl: 'https://ancien.fr/' }));
    await store.ecrire(tenantId, agentId, etat({ connaissanceUrl: 'https://nouveau.fr/' }));
    expect((await store.lire(tenantId, agentId))?.connaissanceUrl).toBe('https://nouveau.fr/');
    expect(await store.lire(autreTenantId, agentId)).toBeNull();
  });
});
