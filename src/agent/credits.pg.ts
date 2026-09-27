import type { Pool } from 'pg';
import type { MouvementLu, RaisonMouvement } from './credits';

/**
 * Le solde prépayé en base.
 *
 * 🔴 Chaque mouvement est une seule instruction : le worker joue plusieurs tours en parallèle pour le même
 * workspace, et un « lire puis écrire » perdrait des consommations. Les CTE modifiantes écrivent le solde et
 * le journal ensemble, sans état intermédiaire. Une ligne de solde par workspace, clé `tenant_id`.
 */
export class PgCreditStore {
  constructor(private readonly pool: Pool) {}

  async solde(tenantId: string): Promise<number> {
    const res = await this.pool.query<{ solde_micro_eur: string }>(
      'select solde_micro_eur from agent_credits where tenant_id = $1',
      [tenantId],
    );
    // Aucune ligne = rien à dépenser : un crédit implicite ferait payer une consommation que personne n'a
    // autorisée.
    return Number(res.rows[0]?.solde_micro_eur ?? 0);
  }

  async debiter(tenantId: string, montantMicroEur: number, contexte?: { sessionId?: string; note?: string }): Promise<number> {
    // Un débit nul ou négatif n'est pas écrit : il ne doit pas devenir un rechargement déguisé.
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return this.solde(tenantId);
    return this.bouger(tenantId, -montant, 'conso', contexte ?? {});
  }

  /**
   * `note` est obligatoire : c'est la seule trace de qui recharge et pourquoi, le jeton d'exploitation étant
   * partagé.
   */
  async crediter(tenantId: string, montantMicroEur: number, note: string): Promise<number> {
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return this.solde(tenantId);
    return this.bouger(tenantId, montant, 'recharge', { note });
  }

  /** Le solde et le journal, en une instruction. Rend le solde après opération. */
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
      // Lu défensivement : la colonne est du texte libre, une ligne écrite par une version future ne doit pas
      // casser la lecture.
      raison: (r.raison === 'recharge' ? 'recharge' : 'conso') as RaisonMouvement,
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      ...(r.note ? { note: r.note } : {}),
      at: r.at.toISOString(),
    }));
  }
}
