import type { Pool } from 'pg';

/**
 * Les TABLEAUX enregistrés d'Analytics > Mes tableaux.
 *
 * Un tableau est une SÉLECTION, jamais des chiffres : un scénario, un nom, et les mesures retenues. Les
 * compteurs se recalculent à la lecture, donc un tableau ouvert six mois plus tard sur une autre période
 * répond juste. Stocker des totaux les aurait figés au jour de l'enregistrement.
 */
export interface MesureRetenue {
  cle: string;
  label: string;
  kind: string;
  handle: string | null;
}

export interface WorkflowReport {
  id: string;
  workflowId: string;
  name: string;
  mesures: MesureRetenue[];
  updatedAt: string;
}

/** Nom déjà pris dans cet espace : l'appelant le traduit en 409, pas en 500. */
export class NomDeTableauDejaPris extends Error {
  constructor() {
    super('un tableau porte déjà ce nom');
    this.name = 'NomDeTableauDejaPris';
  }
}

export class PgWorkflowReportStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<WorkflowReport[]> {
    const res = await this.pool.query<Ligne>(
      `select id, workflow_id, name, mesures, updated_at
         from workflow_reports where tenant_id = $1 order by updated_at desc limit 200`,
      [tenantId],
    );
    return res.rows.map(versReport);
  }

  /**
   * Crée un tableau, ou MET À JOUR celui dont l'identifiant est fourni. Un seul chemin d'écriture : deux
   * méthodes séparées auraient fini par diverger sur la validation ou le scope tenant.
   *
   * `id` inconnu ou appartenant à un autre espace -> null, jamais une création silencieuse sous un id imposé
   * par l'appelant.
   */
  async save(
    tenantId: string,
    input: { id?: string; workflowId: string; name: string; mesures: MesureRetenue[] },
  ): Promise<WorkflowReport | null> {
    const params = [tenantId, input.workflowId, input.name, JSON.stringify(input.mesures)];
    try {
      const res = input.id
        ? await this.pool.query<Ligne>(
            `update workflow_reports set workflow_id = $2, name = $3, mesures = $4::jsonb, updated_at = now()
              where tenant_id = $1 and id = $5
              returning id, workflow_id, name, mesures, updated_at`,
            [...params, input.id],
          )
        : await this.pool.query<Ligne>(
            `insert into workflow_reports (tenant_id, workflow_id, name, mesures)
             values ($1, $2, $3, $4::jsonb)
             returning id, workflow_id, name, mesures, updated_at`,
            params,
          );
      const r = res.rows[0];
      return r ? versReport(r) : null;
    } catch (err) {
      // 23505 = violation d'unicité (tenant_id, name). C'est une erreur de SAISIE, pas une panne : la laisser
      // sortir en 500 ferait remplacer le message par la page d'erreur de Cloudflare, et l'opérateur ne
      // saurait même pas qu'il s'agit d'un nom déjà pris.
      if ((err as { code?: string }).code === '23505') throw new NomDeTableauDejaPris();
      throw err;
    }
  }

  /** Renvoie true si un tableau a bien été supprimé (false = inconnu ou hors de cet espace). */
  async remove(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query('delete from workflow_reports where tenant_id = $1 and id = $2', [tenantId, id]);
    return (res.rowCount ?? 0) > 0;
  }
}

interface Ligne {
  id: string;
  workflow_id: string;
  name: string;
  mesures: MesureRetenue[] | null;
  updated_at: Date;
}

const versReport = (r: Ligne): WorkflowReport => ({
  id: r.id,
  workflowId: r.workflow_id,
  name: r.name,
  mesures: Array.isArray(r.mesures) ? r.mesures : [],
  updatedAt: r.updated_at.toISOString(),
});
