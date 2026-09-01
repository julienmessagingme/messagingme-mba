import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * La reprise d'une campagne en pause de DÉBIT, contre une vraie base (migration 0103).
 *
 * 🔴 EN INTÉGRATION parce que ce qui est vérifié est du SQL, et qu'un faux ne peut rien en dire : la
 * réclamation atomique (`update ... returning` sur les lignes dues), le fait qu'une pause de QUALITÉ ne soit
 * jamais sélectionnée, et qu'une échéance encore future ne le soit pas non plus. Un test unitaire aurait
 * prouvé ma lecture de la requête, pas la requête.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('reprise après un plafond de débit (Postgres)', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    repo = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-reprise') returning id`)).rows[0]!.id;
    await pool.query(`insert into waba (id, tenant_id, name) values ('itest-reprise-waba', $1, 'itest')`, [tenantId]);
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status)
       values ('itest-reprise-pn', $1, 'itest-reprise-waba', '+33500000099', 'CONNECTED')`,
      [tenantId],
    );
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  /** Une campagne en pause, avec la raison et l'échéance voulues. Rend son identifiant. */
  async function campagneEnPause(reason: string | null, until: string | null): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language,
                              status, param_mapping, pause_reason, paused_until)
       values ($1, 'itest-reprise-pn', 'itest', 'marketing', 'tpl', 'fr', 'paused', '[]'::jsonb, $2, $3::timestamptz)
       returning id`,
      [tenantId, reason, until],
    );
    return r.rows[0]!.id;
  }

  const statutDe = async (id: string) =>
    (await pool.query<{ status: string; pause_reason: string | null; paused_until: Date | null }>(
      `select status, pause_reason, paused_until from campaigns where id = $1`, [id],
    )).rows[0]!;

  it('🔴 reprend une pause de DÉBIT échue, et efface les deux colonnes', async () => {
    const due = await campagneEnPause('debit', new Date(Date.now() - 60_000).toISOString());
    const reprises = await repo.reprendreCampagnesEnPauseDeDebit();
    expect(reprises.map((c) => c.id)).toContain(due);
    expect(reprises.find((c) => c.id === due)?.tenantId).toBe(tenantId);

    const apres = await statutDe(due);
    expect(apres.status).toBe('running');
    // 🔴 Les colonnes sont EFFACÉES. Les laisser ferait « reprendre » la campagne une seconde fois au
    // balayage suivant, alors qu'elle tourne déjà, donc un run de plus pour rien.
    expect(apres.pause_reason).toBeNull();
    expect(apres.paused_until).toBeNull();
  });

  it('🔴 une pause de QUALITÉ n’est JAMAIS reprise, même avec une échéance échue', async () => {
    // La garde la plus importante du lot. Meta juge alors le numéro : relancer sans rien changer aggrave le
    // problème et peut coûter le numéro. L'échéance est posée ici EXPRÈS, pour prouver que c'est bien la
    // RAISON qui protège, et pas seulement l'absence de date.
    const qualite = await campagneEnPause('qualite', new Date(Date.now() - 60_000).toISOString());
    const reprises = await repo.reprendreCampagnesEnPauseDeDebit();
    expect(reprises.map((c) => c.id)).not.toContain(qualite);
    expect((await statutDe(qualite)).status).toBe('paused');
  });

  it('une échéance encore FUTURE n’est pas reprise', async () => {
    const future = await campagneEnPause('debit', new Date(Date.now() + 3_600_000).toISOString());
    const reprises = await repo.reprendreCampagnesEnPauseDeDebit();
    expect(reprises.map((c) => c.id)).not.toContain(future);
    expect((await statutDe(future)).status).toBe('paused');
  });

  it('une pause SANS raison (mise en pause à la main) n’est pas reprise non plus', async () => {
    // `pauseCampaign` (le bouton de l'opérateur) n'écrit ni raison ni échéance : une pause décidée par un
    // humain ne doit pas se lever toute seule.
    const manuelle = await campagneEnPause(null, null);
    const reprises = await repo.reprendreCampagnesEnPauseDeDebit();
    expect(reprises.map((c) => c.id)).not.toContain(manuelle);
    expect((await statutDe(manuelle)).status).toBe('paused');
  });

  it('🔴 la réclamation est ATOMIQUE : deux balayages ne reprennent pas la même campagne', async () => {
    // Deux workers un jour, ou un balayage qui déborde sur le suivant. Sans l'atomicité, deux runs seraient
    // enfilés pour la même campagne.
    const due = await campagneEnPause('debit', new Date(Date.now() - 60_000).toISOString());
    const [a, b] = await Promise.all([
      repo.reprendreCampagnesEnPauseDeDebit(),
      repo.reprendreCampagnesEnPauseDeDebit(),
    ]);
    const vues = [...a, ...b].filter((c) => c.id === due);
    expect(vues).toHaveLength(1);
  });
});
