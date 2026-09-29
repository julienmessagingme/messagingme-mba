import type { Pool, PoolClient } from 'pg';
import type { LigneHistorique, MouvementLu, RaisonMouvement } from './credits';

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

  /**
   * L'historique montré au client : les mouvements tels qu'écrits, SAUF les tours d'agent, agrégés par jour de Paris
   * sur les `JOURS_HISTORIQUE_AGENTS` derniers jours. Un agent actif écrit une ligne par tour : sans agrégat, les
   * cinquante lignes de l'écran ne montreraient plus que des centimes, et jamais l'achat qu'on vient de payer.
   * Les traductions ont déjà une ligne par jour en base (migration 0190). Aucune note ne sort (`LigneHistorique`).
   * La fenêtre ne borne que l'agrégat : elle garde la lecture sur l'index `(tenant_id, at desc)`, quel que soit le
   * nombre de tours.
   */
  async historique(tenantId: string, limite: number): Promise<LigneHistorique[]> {
    const res = await this.pool.query<{ id: string; delta_micro_eur: string; raison: string; jour: string | null; at: Date }>(
      `with agents as (
         select (at at time zone 'Europe/Paris')::date as jour, sum(delta_micro_eur) as delta_micro_eur, max(at) as at
           from agent_credit_mouvements
          where tenant_id = $1 and raison = 'conso' and at >= now() - make_interval(days => $3::int)
          group by 1
       )
       select id::text as id, delta_micro_eur, raison, to_char(jour, 'YYYY-MM-DD') as jour, at
         from agent_credit_mouvements
        where tenant_id = $1 and raison <> 'conso'
       union all
       select 'agents-' || to_char(jour, 'YYYY-MM-DD'), delta_micro_eur, 'conso', to_char(jour, 'YYYY-MM-DD'), at
         from agents
        order by at desc
        limit $2::int`,
      [tenantId, Math.max(1, Math.floor(limite)), JOURS_HISTORIQUE_AGENTS],
    );
    return res.rows.map((r) => ({
      id: r.id,
      deltaMicroEur: Number(r.delta_micro_eur),
      raison: r.raison,
      jour: r.jour,
      at: r.at.toISOString(),
    }));
  }
}

/** Combien de jours de tours d'agent l'historique du client agrège. Au-delà, le solde les compte, l'écran non. */
export const JOURS_HISTORIQUE_AGENTS = 30;

/** La note du crédit offert, pour le journal d'exploitation (le client lit la raison, pas la note). */
export const NOTE_CREDIT_OFFERT = 'crédit offert à la connexion du premier numéro WhatsApp';

/**
 * Le crédit offert à la connexion du premier numéro WhatsApp d'un espace, écrit DANS la transaction qui relie le
 * numéro (`PgEmbeddedSignupStore.linkTenant`). Rend le montant offert, 0 si rien ne l'a été.
 *
 * 🔴 L'OFFRE D'ABORD, LE CRÉDIT ENSUITE, ET SEULEMENT SI L'OFFRE A PRIS. `credits_offerts` (migration 0191) tient les
 * deux bornes par ses contraintes : une offre par espace (clé primaire), jamais deux pour le même numéro (unique),
 * même s'il change d'espace. `on conflict do nothing` sans cible couvre les deux ; une insertion qui n'a pas eu lieu
 * n'écrit ni solde ni mouvement. Deux liaisons simultanées se sérialisent sur ces contraintes.
 *
 * Aucune clé Vercel ici : elle s'ouvre au premier usage qui en a besoin. Un espace qui en a déjà une voit son plafond
 * remonté par le câblage, après la transaction (`remonterPlafondApresRecharge`).
 */
export async function offrirALaConnexion(
  client: PoolClient, tenantId: string, phoneNumberId: string, montantMicroEur: number,
): Promise<number> {
  const montant = Math.max(0, Math.round(montantMicroEur));
  // Éteint (0) : rien n'est marqué, l'offre reste due le jour où on la rallume.
  if (montant === 0) return 0;
  const pris = await client.query(
    `insert into credits_offerts (tenant_id, phone_number_id, montant_micro_eur)
     values ($1, $2, $3)
     on conflict do nothing`,
    [tenantId, phoneNumberId, montant],
  );
  if ((pris.rowCount ?? 0) === 0) return 0;
  await bouger(client, tenantId, montant, 'offert', { note: NOTE_CREDIT_OFFERT });
  return montant;
}

/**
 * Le crédit d'un achat Stripe, écrit DANS la transaction du webhook, juste après la ligne de paiement qui le rend
 * idempotent (`PgStripeStore.crediterPaiement`). Rend le solde après opération.
 */
export async function crediterAchat(client: PoolClient, tenantId: string, montantMicroEur: number, note: string): Promise<number> {
  const montant = Math.max(0, Math.round(montantMicroEur));
  return bouger(client, tenantId, montant, 'achat', { note });
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
