import type { Pool, PoolClient } from 'pg';
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
    return bouger(this.pool, tenantId, -montant, 'conso', contexte ?? {});
  }

  /**
   * Débite une traduction : le solde descend du montant, et la ligne `traduction` du JOUR (Paris) de l'espace
   * grossit d'autant, créée au premier débit du jour. Rend le solde après opération.
   *
   * 🔴 Une seule instruction, donc une seule transaction : le solde et la ligne du jour bougent ensemble ou pas du
   * tout. Deux débits simultanés du même jour se sérialisent sur l'index unique partiel (migration 0190) : aucun
   * n'est perdu, aucun ne crée une seconde ligne. ⚠️ La clause `on conflict` doit reprendre MOT POUR MOT le
   * prédicat de cet index, sinon Postgres n'en trouve aucun à inférer et chaque débit échoue (comparés par
   * `tests/migration-0190.test.ts`).
   */
  async debiterTraduction(tenantId: string, montantMicroEur: number): Promise<number> {
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return this.solde(tenantId);
    const res = await this.pool.query<{ solde_micro_eur: string }>(
      `with aujourdhui as (
         -- Le jour de Paris, calculé une fois : la note et la clé de la ligne le lisent tous deux.
         select (now() at time zone 'Europe/Paris')::date as j
       ),
       solde as (
         insert into agent_credits (tenant_id, solde_micro_eur, updated_at)
         values ($1, $2, now())
         on conflict (tenant_id) do update
           set solde_micro_eur = agent_credits.solde_micro_eur + excluded.solde_micro_eur,
               updated_at = now()
         returning solde_micro_eur
       ),
       trace as (
         insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, note, jour)
         values ($1, $2, 'traduction',
                 'traductions du ' || to_char((select j from aujourdhui), 'DD/MM'),
                 (select j from aujourdhui))
         on conflict (tenant_id, jour) where raison = 'traduction' do update
           set delta_micro_eur = agent_credit_mouvements.delta_micro_eur + excluded.delta_micro_eur,
               at = now()
         returning 1
       )
       select solde_micro_eur from solde`,
      [tenantId, -montant],
    );
    return Number(res.rows[0]?.solde_micro_eur ?? 0);
  }

  /**
   * `note` est obligatoire : elle dit qui recharge et pourquoi (la route d'exploitation la signe de l'adresse
   * de son auteur, `noteSignee`).
   */
  async crediter(tenantId: string, montantMicroEur: number, note: string): Promise<number> {
    const montant = Math.max(0, Math.round(montantMicroEur));
    if (montant === 0) return this.solde(tenantId);
    return bouger(this.pool, tenantId, montant, 'recharge', { note });
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
      // Telle qu'écrite : ramener tout ce qui n'est pas `recharge` à `conso` faisait lire un crédit offert comme
      // une consommation, donc un solde qui monte comme s'il avait baissé.
      raison: r.raison,
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      ...(r.note ? { note: r.note } : {}),
      at: r.at.toISOString(),
    }));
  }
}

/** La note du crédit offert, telle que le journal la montre. */
export const NOTE_CREDIT_OFFERT = 'crédit offert à l’ouverture';

/**
 * Le crédit offert à un espace qui naît, écrit DANS la transaction qui le crée (`PgUserStore.createTenantWithAdmin`) :
 * un espace sans son crédit, ou un crédit sans son espace, ne peut pas exister. Aucune clé Vercel ici, elle s'ouvre
 * au premier usage qui en a besoin : une inscription ne fabrique pas de clé facturable.
 */
export async function offrirALOuverture(client: PoolClient, tenantId: string, montantMicroEur: number): Promise<void> {
  const montant = Math.max(0, Math.round(montantMicroEur));
  if (montant === 0) return;
  await bouger(client, tenantId, montant, 'offert', { note: NOTE_CREDIT_OFFERT });
}

/** Le solde et le journal, en une instruction. Rend le solde après opération. */
async function bouger(
  q: Pool | PoolClient, tenantId: string, delta: number, raison: RaisonMouvement,
  extra: { sessionId?: string; note?: string },
): Promise<number> {
  const res = await q.query<{ solde_micro_eur: string }>(
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
