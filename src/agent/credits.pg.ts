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
   * L'historique montré au client : les mouvements des `JOURS_HISTORIQUE` derniers jours, tels qu'écrits, SAUF les
   * tours d'agent, agrégés par jour de Paris. Un agent actif écrit une ligne par tour : sans agrégat, les cinquante
   * lignes de l'écran ne montreraient plus que des centimes, et jamais l'achat qu'on vient de payer. Les traductions
   * ont déjà une ligne par jour en base (migration 0190). Aucune note ne sort (`LigneHistorique`).
   *
   * 🔴 LA FENÊTRE BORNE LES DEUX BRANCHES, et c'est ce qui borne la lecture (relecture du 2026-09-29). Ce commentaire
   * affirmait qu'une fenêtre posée sur la seule branche des agents gardait la lecture sur l'index, « quel que soit le
   * nombre de tours » : c'était faux. L'index `(tenant_id, at desc)` ne connaît pas la raison, donc la branche
   * `raison <> 'conso'`, sans fenêtre, parcourait TOUS les mouvements de l'espace depuis son ouverture, une ligne par
   * tour d'agent comprise, pour en garder quelques-unes. Les deux branches lisent désormais le même intervalle de
   * l'index. Au-delà, le solde compte tout, l'écran non ; un achat ancien reste sur sa facture Stripe.
   */
  async historique(tenantId: string, limite: number): Promise<LigneHistorique[]> {
    const res = await this.pool.query<{
      id: string; delta_micro_eur: string; raison: string; jour: string | null; at: Date;
      paiement_id: string | null; facture: boolean;
    }>(
      // Le paiement d'un achat, et s'il a une facture : par la session Stripe du mouvement (migration 0193), relue
      // dans les paiements DE CET ESPACE. Aucune autre ligne n'en a.
      `with fenetre as (
         select id, delta_micro_eur, raison, jour, at, stripe_session_id
           from agent_credit_mouvements
          where tenant_id = $1 and at >= now() - make_interval(days => $3::int)
       ),
       agents as (
         select (at at time zone 'Europe/Paris')::date as jour, sum(delta_micro_eur) as delta_micro_eur, max(at) as at
           from fenetre
          where raison = 'conso'
          group by 1
       )
       select f.id::text as id, f.delta_micro_eur, f.raison, to_char(f.jour, 'YYYY-MM-DD') as jour, f.at,
              p.session_id as paiement_id, (p.facture_id is not null) as facture
         from fenetre f
         left join stripe_paiements p on p.session_id = f.stripe_session_id and p.tenant_id = $1
        where f.raison <> 'conso'
       union all
       select 'agents-' || to_char(jour, 'YYYY-MM-DD'), delta_micro_eur, 'conso', to_char(jour, 'YYYY-MM-DD'), at,
              null, false
         from agents
        order by at desc
        limit $2::int`,
      [tenantId, Math.max(1, Math.floor(limite)), JOURS_HISTORIQUE],
    );
    return res.rows.map((r) => ({
      id: r.id,
      deltaMicroEur: Number(r.delta_micro_eur),
      raison: r.raison,
      jour: r.jour,
      at: r.at.toISOString(),
      paiementId: r.paiement_id,
      facture: r.facture === true,
    }));
  }
}

/**
 * Combien de jours de mouvements l'historique du client montre, tours d'agent (agrégés) comme le reste. Au-delà, le
 * solde les compte, l'écran non. La même fenêtre pour les deux branches : c'est elle qui borne la lecture.
 */
export const JOURS_HISTORIQUE = 90;

/** La note du crédit offert, pour le journal d'exploitation (le client lit la raison, pas la note). */
export const NOTE_CREDIT_OFFERT = 'crédit offert au premier numéro WhatsApp vérifié par Meta';

/**
 * Le numéro affiché d'un numéro WhatsApp, normalisé en E.164 : « + » suivi des seuls chiffres de
 * `display_phone_number`, que Meta écrit toujours avec son indicatif (espaces et tirets compris). En SQL et pas en
 * TypeScript : la reprise de la migration 0193 calcule la même valeur sur les lignes existantes, et
 * `tests/migration-0193.test.ts` compare les deux textes. `pn` est l'alias de `phone_numbers`.
 */
export const NUMERO_AFFICHE_SQL = `'+' || regexp_replace(pn.display_phone_number, '[^0-9]', '', 'g')`;
/** Un numéro affiché qu'on sait normaliser : présent, et au moins huit chiffres (indicatif compris). */
export const NUMERO_AFFICHE_VALIDE_SQL = `pn.display_phone_number is not null and length(regexp_replace(pn.display_phone_number, '[^0-9]', '', 'g')) >= 8`;

/**
 * Le crédit offert au premier numéro WhatsApp d'un espace, pour un numéro que Meta dit VÉRIFIÉ (décision de Julien du
 * 2026-09-29). L'appelant sait que Meta l'a dit, le dépôt non : `PgEmbeddedSignupStore.offrirCredit`, appelé par la
 * route de l'inscription et par celle de l'activation, jamais par la liaison elle-même. Rend le montant offert, 0 si
 * rien ne l'a été.
 *
 * 🔴 L'OFFRE D'ABORD, LE CRÉDIT ENSUITE, ET SEULEMENT SI L'OFFRE A PRIS. `credits_offerts` tient TROIS bornes par ses
 * contraintes : une offre par espace (clé primaire), jamais deux pour le même identifiant Meta (unique, 0191), jamais
 * deux pour le même numéro AFFICHÉ (index unique, 0193), même s'il change d'espace ou d'identifiant. `on conflict do
 * nothing` sans cible couvre les trois ; une insertion qui n'a pas eu lieu n'écrit ni solde ni mouvement. Deux offres
 * simultanées se sérialisent sur ces contraintes.
 *
 * Le numéro est relu dans `phone_numbers` DE CET ESPACE : un identifiant qui n'y est pas relié n'offre rien, et un
 * numéro sans numéro affiché normalisable non plus (la troisième borne ne tiendrait pas). L'offre reste alors due.
 *
 * Aucune clé Vercel ici : elle s'ouvre au premier usage qui en a besoin. Un espace qui en a déjà une voit son plafond
 * remonté par le câblage, après la transaction (`remonterPlafondApresRecharge`).
 */
export async function offrirAuNumeroVerifie(
  client: PoolClient, tenantId: string, phoneNumberId: string, montantMicroEur: number,
): Promise<number> {
  const montant = Math.max(0, Math.round(montantMicroEur));
  // Éteint (0) : rien n'est marqué, l'offre reste due le jour où on la rallume.
  if (montant === 0) return 0;
  const pris = await client.query(
    `insert into credits_offerts (tenant_id, phone_number_id, numero_affiche, montant_micro_eur)
     select $1, pn.id, ${NUMERO_AFFICHE_SQL}, $3
       from phone_numbers pn
      where pn.id = $2 and pn.tenant_id = $1 and ${NUMERO_AFFICHE_VALIDE_SQL}
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
 * `stripeSessionId` rattache le mouvement à son paiement (migration 0193) : c'est ce lien, et jamais la note, que lit
 * l'historique pour offrir la facture.
 */
export async function crediterAchat(
  client: PoolClient, tenantId: string, montantMicroEur: number, note: string, stripeSessionId: string,
): Promise<number> {
  const montant = Math.max(0, Math.round(montantMicroEur));
  return bouger(client, tenantId, montant, 'achat', { note, stripeSessionId });
}

/** Le solde et le journal, en une instruction. Rend le solde après opération. */
async function bouger(
  q: Pool | PoolClient, tenantId: string, delta: number, raison: RaisonMouvement,
  extra: { sessionId?: string; note?: string; stripeSessionId?: string },
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
       insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, session_id, note, stripe_session_id)
       values ($1, $2, $3, $4::uuid, $5, $6)
       returning 1
     )
     select solde_micro_eur from solde`,
    [tenantId, delta, raison, extra.sessionId ?? null, extra.note ?? null, extra.stripeSessionId ?? null],
  );
  return Number(res.rows[0]?.solde_micro_eur ?? 0);
}
