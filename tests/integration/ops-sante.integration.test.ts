import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgPoolAttentesStore } from '../../src/ops/pool-attentes.pg';
import { PgSanteStore } from '../../src/ops/sante.pg';
import { PgMesuresFilesStore } from '../../src/ops/mesures-files.pg';
import { PgBossQueue } from '../../src/queue/pgboss';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES LECTURES DE LA REFONTE DE /OPS (lot 1) : du SQL dont l'erreur ne se voit pas d'un test unitaire (une copie
 * de réception comptée comme une copie d'API, un percentile en secondes rangé en millisecondes, un accusé pris pour
 * un message).
 */
describe.skipIf(!url)('onglets Santé et Capacité de /ops (Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
  });

  afterAll(async () => {
    await pool.query(`delete from pool_attentes where process like 'api-itest%' or process like 'worker-itest%'`).catch(() => {});
    await pool.query(`delete from webhook_events where meta_message_id like '%itest-ops%'`).catch(() => {});
    await pool.query(`delete from mesures_files_heures where file = 'webhook'`).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 les copies d’API par heure : chaque copie compte une fois, sa jumelle de réception jamais', async () => {
    const store = new PgPoolAttentesStore(pool);
    // Une minute à part, il y a trois jours, que rien d'autre n'écrit.
    const minute = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    minute.setUTCMinutes(17, 0, 0);
    const seau = (attentes: number) => ({ echantillons: 10, attentes, maxMs: 50, maxAttenteMs: attentes > 0 ? 400 : 0, sommeMs: 100 });
    await store.enregistrer('api-itest-a', minute, seau(2));
    await store.enregistrer('api-itest-a-reception', minute, seau(0));
    await store.enregistrer('api-itest-b', minute, seau(1));
    await store.enregistrer('worker-itest', minute, seau(5));
    const heure = new Date(minute);
    heure.setUTCMinutes(0, 0, 0);
    const point = (await store.lireParHeure(30)).find((p) => p.heure === heure.toISOString());
    expect(point).toMatchObject({ copiesMax: 2, minutesDeuxCopiesOuPlus: 1, attentesApi: 3, attentesWorkers: 5, maxAttenteMs: 400 });
  });

  it('les derniers signaux de Meta : un message et un accusé, chacun par sa clé', async () => {
    // Dans le futur : rien d'autre dans la base ne peut être plus récent.
    await pool.query(
      `insert into webhook_events (source, meta_message_id, payload, received_at) values
         ('meta', 'msg:wamid.itest-ops', '{}'::jsonb, now() + interval '1 hour'),
         ('meta', 'status:wamid.itest-ops:delivered', '{}'::jsonb, now() + interval '2 hours')`,
    );
    const meta = await new PgSanteStore(pool).signauxMeta();
    expect(Date.parse(meta.dernierAccuse!) - Date.parse(meta.dernierMessage!)).toBe(3600 * 1000);
  });

  it('les connexions de la base, hors réserve du superutilisateur', async () => {
    const c = await new PgSanteStore(pool).connexionsBase();
    expect(c.utilisees).toBeGreaterThan(0);
    expect(c.max).toBeGreaterThan(c.utilisees);
  });

  it('🔴 la latence des files heure par heure, relevée depuis pg-boss, en millisecondes, et relevable deux fois', async () => {
    const schema = 'pgboss_itest_mf';
    const queue = new PgBossQueue(url, schema, { max: 2, supervise: false });
    await queue.start();
    try {
      let fait!: () => void;
      const termine = new Promise<void>((r) => { fait = r; });
      await queue.work('webhook', async () => { fait(); });
      await queue.enqueue('webhook', { itest: true });
      await termine;
      const store = new PgMesuresFilesStore(pool, schema);
      // pg-boss marque la tâche terminée juste après le gestionnaire : on relève jusqu'à la voir.
      for (let i = 0; i < 20 && (await store.relever(new Date(Date.now() - 3600 * 1000))) === 0; i++) await new Promise((r) => setTimeout(r, 250));
      await store.relever(new Date(Date.now() - 3600 * 1000));
      const lignes = (await store.lire(1)).filter((l) => l.file === 'webhook');
      expect(lignes).toHaveLength(1);
      expect(lignes[0]!.echantillons).toBe(1);
      expect(lignes[0]!.boutEnBoutP95Secondes).toBeGreaterThanOrEqual(0);
      expect(lignes[0]!.boutEnBoutP95Secondes).toBeLessThan(60);
    } finally {
      await queue.stop();
      await pool.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    }
  });
});
