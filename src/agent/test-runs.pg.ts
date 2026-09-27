import type { Pool } from 'pg';
import type { EssaiAEcrire, EssaiAgent, TestRunStore } from './test-runs';

/**
 * L'historique des essais, en base. Le pilote pg rend un `bigint` en `string`, d'où les `Number()` : sinon
 * deux coûts s'additionneraient en concaténation.
 */
const COLONNES = 'id, messages, reponse, sortie, appels, tokens_in, tokens_out, cout_micro_eur, created_at';

interface Ligne {
  id: string;
  messages: unknown;
  reponse: string | null;
  sortie: string | null;
  appels: unknown;
  tokens_in: string;
  tokens_out: string;
  cout_micro_eur: string;
  created_at: Date;
}

/** Le jsonb revient en `unknown` : on ne fait confiance à sa forme qu'après vérification. */
function tableau<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export class PgTestRunStore implements TestRunStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Lève en cas d'échec : c'est la route qui protège l'essai, et avaler ici priverait son journal de la cause.
   */
  async ecrire(tenantId: string, agentId: string, essai: EssaiAEcrire): Promise<void> {
    await this.pool.query(
      `insert into agent_test_runs
              (tenant_id, agent_id, messages, reponse, sortie, appels, tokens_in, tokens_out, cout_micro_eur)
       values ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        tenantId, agentId,
        JSON.stringify(essai.messages), essai.reponse, essai.sortie,
        JSON.stringify(essai.appels), essai.tokensEntree, essai.tokensSortie, essai.coutMicroEur,
      ],
    );
  }

  async lister(tenantId: string, agentId: string, limite: number): Promise<EssaiAgent[]> {
    const { rows } = await this.pool.query<Ligne>(
      `select ${COLONNES} from agent_test_runs
        where tenant_id = $1 and agent_id = $2
        order by created_at desc
        limit $3`,
      [tenantId, agentId, Math.max(1, Math.min(100, Math.floor(limite)))],
    );
    return rows.map((r) => ({
      id: r.id,
      messages: tableau<{ role: string; content: string }>(r.messages),
      reponse: r.reponse,
      sortie: r.sortie,
      appels: tableau<{ nom: string; status: string }>(r.appels),
      tokensEntree: Number(r.tokens_in),
      tokensSortie: Number(r.tokens_out),
      coutMicroEur: Number(r.cout_micro_eur),
      createdAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Pas de plafond par passage, contrairement aux purges de conversations : une ligne par clic sur « Tester »
   * n'en produit jamais assez pour rendre ce `delete` coûteux.
   */
  async purger(jours: number): Promise<number> {
    const res = await this.pool.query(
      "delete from agent_test_runs where created_at < now() - make_interval(days => $1)",
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
