import type { Pool } from 'pg';
import type { CreditStore, MouvementLu, RaisonMouvement } from './credits';

/**
 * Le solde prépayé en base (migration 0087).
 *
 * 🔴 CHAQUE MOUVEMENT EST UNE SEULE INSTRUCTION, et c'est le point. Le worker joue plusieurs tours en
 * parallèle, y compris pour le même workspace : un `lire puis écrire` perdrait une consommation sur deux au
 * premier croisement, et le client paierait moins que ce qu'il a consommé. Les CTE modifiantes de Postgres
 * font l'écriture du solde et celle du journal dans la même instruction, donc sans état intermédiaire où
 * l'un existerait sans l'autre.
 *
 * ⚠️ `tenant_id` est la CLÉ, pas un filtre parmi d'autres : il n'y a qu'une ligne de solde par workspace, et
 * l'`insert ... on conflict` la crée à la première consommation comme au premier rechargement.
 */
export class PgCreditStore implements CreditStore {
  constructor(private readonly pool: Pool) {}

  async solde(tenantId: string): Promise<number> {
    const res = await this.pool.query<{ solde_micro_eur: string }>(
      'select solde_micro_eur from agent_credits where tenant_id = $1',
      [tenantId],
    );
    // `bigint` rendu en `string` par node-pg, converti ici comme partout ailleurs dans le repo. Aucune ligne
    // = rien à dépenser, et c'est le bon défaut : un crédit implicite ferait payer une consommation que
    // personne n'a autorisée.
    return Number(res.rows[0]?.solde_micro_eur ?? 0);
  }

  async debiter(tenantId: string, montantMicroEur: number, contexte?: { sessionId?: string; note?: string }): Promise<number> {
    // Un débit nul ou négatif ne veut rien dire : on ne l'écrit pas, et surtout on ne le laisse pas devenir
    // un rechargement déguisé.
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return this.solde(tenantId);
    return this.bouger(tenantId, -montant, 'conso', contexte ?? {});
  }

  async crediter(tenantId: string, montantMicroEur: number, note: string): Promise<number> {
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return this.solde(tenantId);
    return this.bouger(tenantId, montant, 'recharge', { note });
  }

  /** Le solde et le journal, en une instruction. Rend le solde APRÈS opération. */
  private async bouger(
    tenantId: string, delta: number, raison: RaisonMouvement,
    extra: { sessionId?: string; note?: string },
  ): Promise<number> {
    const res = await this.pool.query<{ solde_micro_eur: string }>(
      `with solde as (
         insert into agent_credits (tenant_id, solde_micro_eur, updated_at)
         values ($1, $2, now())
         on conflict (tenant_id) do update
           set solde_micro_eur = agent_credits.solde_micro_eur + excluded.solde_micro_eur,
               updated_at = now()
         returning solde_micro_eur
       ),
       trace as (
         insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, session_id, note)
         values ($1, $2, $3, $4::uuid, $5)
         returning 1
       )
       select solde_micro_eur from solde`,
      [tenantId, delta, raison, extra.sessionId ?? null, extra.note ?? null],
    );
    return Number(res.rows[0]?.solde_micro_eur ?? 0);
  }

  async mouvements(tenantId: string, limite: number): Promise<MouvementLu[]> {
    const res = await this.pool.query<{
      id: string; delta_micro_eur: string; raison: string; session_id: string | null;
      note: string | null; at: Date;
    }>(
      `select id, delta_micro_eur, raison, session_id, note, at
         from agent_credit_mouvements
        where tenant_id = $1
        order by at desc
        limit $2::int`,
      [tenantId, Math.max(1, Math.floor(limite))],
    );
    return res.rows.map((r) => ({
      id: r.id,
      deltaMicroEur: Number(r.delta_micro_eur),
      // Lu défensivement : la colonne est du texte libre en base (pour qu'une raison de plus ne demande pas
      // de migration), donc une ligne écrite par une version future ne doit pas casser la lecture.
      raison: (r.raison === 'recharge' ? 'recharge' : 'conso') as RaisonMouvement,
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      ...(r.note ? { note: r.note } : {}),
      at: r.at.toISOString(),
    }));
  }
}
