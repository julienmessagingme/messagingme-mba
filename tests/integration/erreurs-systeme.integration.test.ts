import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgJournalAppels } from '../../src/agent/catalog.pg';
import { PgErreursLivraisonStore } from '../../src/ops/erreurs-livraison.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA MOITIÉ SYSTÈME DU JOURNAL DES ERREURS (migration 0142), contre un VRAI Postgres.
 *
 * 🔴 CE QUI NE SE PROUVE QU'ICI. La migration relâche `session_id` pour que deux appelants qui n'ouvrent
 * AUCUNE session d'agent puissent écrire : un faux dépôt dirait oui à une insertion que la vraie clé
 * étrangère aurait refusée. C'est exactement ce verrou-là qui empêchait ces deux chemins de journaliser, et
 * il faut un vrai schéma pour vérifier qu'il est levé.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('journal système des appels de connecteur (Postgres)', () => {
  let pool: Pool;
  let journal: PgJournalAppels;
  let lecture: PgErreursLivraisonStore;
  let tenantId: string;
  let autreTenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    journal = new PgJournalAppels(pool);
    lecture = new PgErreursLivraisonStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-erreurs-sys') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-erreurs-sys-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  /**
   * 🔴 LE CAS QUI DÉBLOQUE TOUT LE LOT. Sans `session_id` nullable, cette insertion violait la clé étrangère
   * vers `agent_sessions`, et c'est LA raison pour laquelle le bloc « Appel HTTP » d'un scénario et la
   * poussée d'un opt-out ne journalisaient rien.
   */
  it('🔴 un appel SANS session d’agent s’écrit, et se relit', async () => {
    const id = await journal.ouvrir({
      tenantId, sessionId: null, toolId: null, toolName: 'Desabonner dans le CRM',
      origin: 'http', argsRediges: {}, source: 'optout',
    });
    await journal.clore({ tenantId, id, status: 'erreur_outil', httpStatus: 500, dureeMs: 120, erreur: 'http_500' });

    const lignes = await lecture.listerEchecsSysteme(tenantId);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({
      nom: 'Desabonner dans le CRM', source: 'optout', statut: 'erreur_outil', httpStatus: 500, erreur: 'http_500',
    });
  });

  /**
   * ⚠️ LE TÉMOIN DANS L'AUTRE SENS : un appel RÉUSSI ne doit PAS apparaître. Sans lui, une lecture qui
   * oublierait son `status <> 'ok'` passerait le cas précédent tout en noyant les échecs sous des milliers
   * de succès, et en sortant du contrat de son index partiel.
   */
  it('⚠️ un appel RÉUSSI n’apparaît pas dans le journal des erreurs', async () => {
    const id = await journal.ouvrir({
      tenantId, sessionId: null, toolId: null, toolName: 'Appel qui marche',
      origin: 'http', argsRediges: {}, source: 'scenario',
    });
    await journal.clore({ tenantId, id, status: 'ok', httpStatus: 200, dureeMs: 30 });

    const noms = (await lecture.listerEchecsSysteme(tenantId)).map((l) => l.nom);
    expect(noms).not.toContain('Appel qui marche');
  });

  it('🔴 le journal d’un AUTRE espace n’est jamais rendu', async () => {
    const id = await journal.ouvrir({
      tenantId: autreTenantId, sessionId: null, toolId: null, toolName: 'Chez le voisin',
      origin: 'http', argsRediges: {}, source: 'agent',
    });
    await journal.clore({ tenantId: autreTenantId, id, status: 'timeout', dureeMs: 20_000 });

    expect((await lecture.listerEchecsSysteme(tenantId)).map((l) => l.nom)).not.toContain('Chez le voisin');
    expect((await lecture.listerEchecsSysteme(autreTenantId)).map((l) => l.nom)).toContain('Chez le voisin');
  });

  /**
   * 🔴 LA BASE REFUSE UNE SOURCE INCONNUE. C'est ce qui garantit qu'aucun autre chemin d'écriture ne posera
   * une valeur que la lecture ne sait pas rendre en français, et que le jour où la facturation lira cette
   * table, elle ne trouvera pas une catégorie qu'elle ne connaît pas.
   */
  it('🔴 le CHECK refuse une `source` inconnue', async () => {
    await expect(
      pool.query(
        `insert into agent_tool_calls (tenant_id, session_id, tool_name, origin, status, source)
         values ($1, null, 'x', 'http', 'ok', 'parfois')`,
        [tenantId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  /**
   * 🔴 L'INDEX PARTIEL EXISTE ET SON PRÉDICAT EST CELUI DE LA REQUÊTE. En sortir ne produirait aucune
   * erreur, juste un balayage complet du journal d'appels à chaque ouverture de l'écran (leçon des 0120 et
   * 0122, payée deux fois).
   */
  it('🔴 l’index partiel des échecs est là, avec son prédicat', async () => {
    const idx = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'agent_tool_calls' and indexname = 'agent_tool_calls_echecs_idx'`,
    );
    expect(idx.rowCount, 'index absent : la migration 0142 n’a pas tout appliqué').toBe(1);
    expect(idx.rows[0]!.indexdef).toMatch(/WHERE \(status <> 'ok'/i);
  });
});
