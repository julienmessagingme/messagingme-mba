import type { Pool } from 'pg';
import { verdictWhatsApp } from '../contacts/joignabilite';
import { waIdOf } from '../crm/identity';
import { joignabiliteRcsConnue } from '../rcs/reachability';
import type { FaitsRisque, MessageDelivre, NiveauRisque, RaisonRisque, Risque } from './risque';

/**
 * La lecture et l'écriture du risque de désengagement.
 *
 * 🔴 `tenant_id = $1` sur chaque table qui en porte un : le pooler est en rôle superuser, la RLS est contournée,
 * ce filtre est le seul contrôle (`tests/risque-isolation.test.ts`). Les tables sans `tenant_id` sont bornées par
 * une jointure qui filtre : `campaign_recipients` par sa campagne, `conversation_messages` par les fils de
 * l'espace, `rcs_capabilities_cache` par l'agent RCS de l'espace.
 *
 * Groupée, jamais une requête par contact : une lecture des fiches à évaluer, puis par lot une lecture des faits
 * et une écriture, chacune servie par des index et bornée par la fenêtre de 90 jours.
 */

/** La ligne d'une fiche à évaluer : ses faits, et le niveau stocké (celui dont on part). */
export interface ContactAEvaluer {
  contactId: string;
  niveauStocke: NiveauRisque | null;
  faits: FaitsRisque;
}

/** Un changement de niveau, rendu par l'écriture. Rester au même niveau n'en est pas un. */
export interface TransitionRisque {
  contactId: string;
  /** L'adresse du contact pour les automations (numéro en chiffres, sinon BSUID). `null` = aucune. */
  waId: string | null;
  ancien: NiveauRisque | null;
  nouveau: NiveauRisque;
  score: number | null;
  raisons: RaisonRisque[];
}

interface LigneFaits {
  id: string;
  opt_in_status: string;
  rcs_optout_at: Date | null;
  blocked_at: Date | null;
  whatsapp_joignable: boolean | null;
  whatsapp_joignable_le: Date | null;
  risque_niveau: NiveauRisque | null;
  envoyes_le: Array<Date | string> | null;
  lus: boolean[] | null;
  lus_le: Array<Date | string | null> | null;
  derniere_reponse: Date | null;
  dernier_clic: Date | null;
  intent: string | null;
  sentiment: string | null;
  resolved: boolean | null;
  satisfaction: number | null;
  analyse_le: Date | null;
  rcs_joignable: boolean | null;
  rcs_verifie_le: Date | null;
}

const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const plusTard = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a > b ? a : b);

/** Une ligne lue en faits, avec les règles de joignabilité du dépôt : jamais une seconde définition. */
export function faitsDeLaLigne(r: LigneFaits, maintenant: Date): FaitsRisque {
  const envoyes = r.envoyes_le ?? [];
  const delivres: MessageDelivre[] = envoyes.map((e, i) => {
    const luLe = r.lus_le?.[i] ?? null;
    return { envoyeLe: date(e), lu: r.lus?.[i] === true, luLe: luLe === null ? null : date(luLe) };
  });
  const whatsapp = verdictWhatsApp(r.whatsapp_joignable, r.whatsapp_joignable_le, maintenant);
  return {
    desabonne: r.opt_in_status === 'opted_out' || r.rcs_optout_at !== null,
    bloque: r.blocked_at !== null,
    delivres,
    derniereReactionLe: plusTard(r.derniere_reponse, r.dernier_clic),
    derniereAnalyse: r.intent !== null && r.sentiment !== null && r.resolved !== null && r.analyse_le !== null
      ? { intent: r.intent, sentiment: r.sentiment, resolved: r.resolved, satisfaction: r.satisfaction, le: r.analyse_le }
      : null,
    joignableWhatsapp: whatsapp === 'inconnu' ? null : whatsapp === 'oui',
    joignableRcs: r.rcs_joignable === null || r.rcs_verifie_le === null
      ? null
      : joignabiliteRcsConnue({ reachable: r.rcs_joignable, checkedAt: r.rcs_verifie_le.getTime() }, maintenant.getTime()),
  };
}

export class PgRisqueStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Les espaces à balayer, seule lecture transverse de ce fichier. Un espace verrouillé (`/ops/verrou`) est
   * sauté : le balayage peut déclencher des scénarios, et un espace arrêté ne doit rien démarrer.
   */
  async espaces(): Promise<string[]> {
    const res = await this.pool.query<{ id: string }>(`select id from tenants where status <> 'locked' order by created_at asc`);
    return res.rows.map((r) => r.id);
  }

  async espaceExiste(tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from tenants where id = $1`, [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Les fiches à évaluer : celles qui ont reçu un envoi de campagne sur la fenêtre, celles dont le niveau stocké
   * n'est pas null (pour retomber en `inconnu` plutôt que garder un vieux niveau), les désabonnées et les bloquées.
   * Des identifiants seulement, les faits se lisent ensuite par lots.
   * `contacts_tenant_risque_idx` ne sert pas cette requête (un OU avec un `exists`, contrairement à ce que dit la
   * migration 0178) : elle parcourt les fiches de l'espace et sonde `campaign_recipients_contact_idx`.
   */
  async contactsAEvaluer(tenantId: string, depuis: Date): Promise<string[]> {
    const res = await this.pool.query<{ id: string }>(
      `select c.id from contacts c
        where c.tenant_id = $1 and c.deleted_at is null
          and (c.risque_niveau is not null or c.opt_in_status = 'opted_out' or c.rcs_optout_at is not null
               or c.blocked_at is not null
               or exists (select 1 from campaign_recipients r join campaigns k on k.id = r.campaign_id
                           where r.contact_id = c.id and k.tenant_id = $1 and r.sent_at >= $2))
        order by c.id`,
      [tenantId, depuis],
    );
    return res.rows.map((r) => r.id);
  }

  /**
   * Les faits d'un lot de fiches, en une requête. Une fiche supprimée entre-temps n'est pas rendue.
   * Les fils d'un contact se trouvent par deux chemins, comme sur la fiche (`CONVERSATION_DU_CONTACT_SQL`) :
   * `contact_id` seul perd les conversations ouvertes avant la fiche, on rattrape par `wa_id`. En union de deux
   * jointures indexées, le `or` du fragment ne servant qu'un contact à la fois.
   * Une réponse est tout message entrant (un appui de bouton compte comme « oui » écrit à la main).
   * 🔴 LA DERNIÈRE ANALYSE SE LIT SUR LA FICHE (colonnes `analyse_*`, 0196), qui survit à l'effacement de la
   * conversation : une réclamation continue de peser jusqu'à 90 jours. Repli par la conversation pour une fiche qui
   * n'a pas encore de copie, et pour elle seule : il n'y a pas de reprise du passé, et sans ce repli toutes les
   * réclamations des 90 derniers jours sortiraient du calcul le jour du déploiement. Jamais un mélange des deux
   * sources : c'est l'une ou l'autre, entière.
   */
  async faits(tenantId: string, ids: readonly string[], depuis: Date, maintenant: Date): Promise<ContactAEvaluer[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<LigneFaits>(
      `with cible as (
         select c.id, c.opt_in_status, c.rcs_optout_at, c.blocked_at, c.whatsapp_joignable, c.whatsapp_joignable_le,
                c.risque_niveau,
                c.analyse_intention, c.analyse_sentiment, c.analyse_resolue, c.analyse_satisfaction,
                c.analyse_le as fiche_analyse_le,
                nullif(regexp_replace(coalesce(c.phone_e164, ''), '[^0-9]', '', 'g'), '') as digits,
                nullif(c.bsuid, '') as bsuid
           from contacts c
          where c.tenant_id = $1 and c.id = any($2::uuid[]) and c.deleted_at is null
       ),
       fils as (
         select v.id as conversation_id, ct.id as contact_id
           from cible ct join conversations v on v.tenant_id = $1 and v.contact_id = ct.id
         union
         select w.id, ct.id
           from cible ct join conversations w on w.tenant_id = $1 and w.wa_id = any(array_remove(array[ct.digits, ct.bsuid], null))
       ),
       envois as (
         select r.contact_id,
                array_agg(r.sent_at order by r.sent_at desc) as envoyes_le,
                array_agg(r.delivery_status = 'read' order by r.sent_at desc) as lus,
                array_agg(r.delivery_updated_at order by r.sent_at desc) as lus_le
           from campaign_recipients r join campaigns k on k.id = r.campaign_id
          where k.tenant_id = $1 and r.contact_id = any($2::uuid[]) and r.sent_at >= $3
            and r.delivery_status in ('delivered', 'read')
          group by r.contact_id
       ),
       reponses as (
         select f.contact_id, max(m.created_at) as le
           from fils f join conversation_messages m on m.conversation_id = f.conversation_id
          where m.direction = 'in' and m.created_at >= $3
          group by f.contact_id
       ),
       clics as (
         select tc.contact_id, max(tc.at) as le
           from tracked_link_clicks tc
          where tc.tenant_id = $1 and tc.contact_id is not null and tc.contact_id = any($2::uuid[]) and tc.at >= $3
          group by tc.contact_id
       ),
       analyses as (
         select distinct on (f.contact_id) f.contact_id, ca.intent, ca.sentiment, ca.resolved, ca.satisfaction, ca.created_at
           from fils f join cible ct on ct.id = f.contact_id
           join conversation_analysis ca on ca.conversation_id = f.conversation_id
          where ca.tenant_id = $1 and ca.created_at >= $3 and ct.fiche_analyse_le is null
          order by f.contact_id, ca.created_at desc
       ),
       agent as (
         select ag.agent_id from rcs_agents ag where ag.tenant_id = $1 order by ag.created_at asc limit 1
       )
       select ct.id, ct.opt_in_status, ct.rcs_optout_at, ct.blocked_at, ct.whatsapp_joignable, ct.whatsapp_joignable_le,
              ct.risque_niveau, e.envoyes_le, e.lus, e.lus_le, rp.le as derniere_reponse, cl.le as dernier_clic,
              case when ct.fiche_analyse_le is null then an.intent when ct.fiche_analyse_le >= $3 then ct.analyse_intention end as intent,
              case when ct.fiche_analyse_le is null then an.sentiment when ct.fiche_analyse_le >= $3 then ct.analyse_sentiment end as sentiment,
              case when ct.fiche_analyse_le is null then an.resolved when ct.fiche_analyse_le >= $3 then ct.analyse_resolue end as resolved,
              case when ct.fiche_analyse_le is null then an.satisfaction when ct.fiche_analyse_le >= $3 then ct.analyse_satisfaction end as satisfaction,
              case when ct.fiche_analyse_le is null then an.created_at when ct.fiche_analyse_le >= $3 then ct.fiche_analyse_le end as analyse_le,
              rcs.reachable as rcs_joignable, rcs.checked_at as rcs_verifie_le
         from cible ct
         left join envois e on e.contact_id = ct.id
         left join reponses rp on rp.contact_id = ct.id
         left join clics cl on cl.contact_id = ct.id
         left join analyses an on an.contact_id = ct.id
         -- Le cache porte un même numéro sous DEUX formes (« +33… » des campagnes, chiffres seuls des scénarios et
         -- de l'Inbox) : la plus récente gagne, comme dans « joignabiliteRcsToutesFormes ».
         left join lateral (
           select cc.reachable, cc.checked_at
             from rcs_capabilities_cache cc
            where cc.agent_id = (select agent_id from agent) and cc.phone_e164 in ('+' || ct.digits, ct.digits)
            order by cc.checked_at desc limit 1
         ) rcs on true`,
      [tenantId, [...ids], depuis],
    );
    return res.rows.map((r) => ({ contactId: r.id, niveauStocke: r.risque_niveau, faits: faitsDeLaLigne(r, maintenant) }));
  }

  /**
   * Écrit le calcul d'un lot et rend les changements de niveau.
   *
   * 🔴 L'ancien niveau est lu sous verrou, dans la même instruction (`for update`) : le balayage de nuit et `/ops`
   * peuvent passer en même temps sur un espace, et sans verrou les deux verraient le passage en élevé et
   * déclencheraient chacun l'automation.
   * Seules les fiches qui changent sont réécrites (`is distinct from` sur niveau, score et raisons) : `contacts`
   * est la table du chemin chaud, une réécriture nocturne de toutes les fiches y ferait une version morte par
   * fiche. Un changement de niveau change forcément la valeur, aucune transition n'est perdue.
   * `updated_at` ne bouge pas (un calcul n'est pas une modification), et `risque_calcule_le` ne bouge qu'avec le
   * niveau : c'est « à ce niveau depuis le », la date que lit aussi le plafond du jour (`declenchablesDepuis`).
   */
  async ecrire(tenantId: string, lignes: ReadonlyArray<{ contactId: string; risque: Risque }>, calculeLe: Date): Promise<TransitionRisque[]> {
    if (lignes.length === 0) return [];
    const parId = new Map(lignes.map((l) => [l.contactId, l.risque]));
    const valeurs = lignes.map((l) => ({ id: l.contactId, niveau: l.risque.niveau, score: l.risque.score, raisons: l.risque.raisons }));
    const res = await this.pool.query<{ id: string; ancien: NiveauRisque | null; phone_e164: string | null; bsuid: string | null }>(
      `with v as (
         select * from jsonb_to_recordset($2::jsonb) as v(id uuid, niveau text, score smallint, raisons text[])
       ),
       avant as (
         select c.id, c.risque_niveau
           from contacts c join v on v.id = c.id
          where c.tenant_id = $1 and c.deleted_at is null
            and (c.risque_niveau, c.risque_score, c.risque_raisons) is distinct from (v.niveau, v.score, v.raisons)
          for update of c
       )
       update contacts c
          set risque_niveau = v.niveau, risque_score = v.score, risque_raisons = v.raisons,
              risque_calcule_le = case when a.risque_niveau is distinct from v.niveau then $3 else c.risque_calcule_le end
         from v join avant a on a.id = v.id
        where c.tenant_id = $1 and c.id = v.id
       returning c.id, a.risque_niveau as ancien, c.phone_e164, c.bsuid`,
      [tenantId, JSON.stringify(valeurs), calculeLe],
    );
    const transitions: TransitionRisque[] = [];
    for (const r of res.rows) {
      const risque = parId.get(r.id);
      if (!risque || r.ancien === risque.niveau) continue;
      transitions.push({
        contactId: r.id, waId: waIdOf(r.phone_e164, r.bsuid), ancien: r.ancien, nouveau: risque.niveau,
        score: risque.score, raisons: risque.raisons,
      });
    }
    return transitions;
  }

  /**
   * Les passages en élevé déclenchables écrits pour cet espace depuis minuit (Paris), pour le plafond du jour.
   * La trace est la fiche : `risque_calcule_le` ne bouge qu'au changement de niveau. Mêmes exclusions que le point
   * d'émission : STOP, blocage, fiche sans adresse.
   * L'égalité nue `risque_niveau = 'eleve'` derrière `tenant_id = $1 and deleted_at is null` est le contrat de
   * l'index partiel `contacts_tenant_risque_idx`.
   */
  async declenchablesDepuis(tenantId: string, depuis: Date): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `select count(*)::int as n from contacts c
        where c.tenant_id = $1 and c.deleted_at is null and c.risque_niveau = 'eleve'
          and c.risque_calcule_le >= $2
          and not (c.risque_raisons && array['stop', 'bloque']::text[])
          and (coalesce(c.phone_e164, '') <> '' or c.bsuid is not null)`,
      [tenantId, depuis],
    );
    return res.rows[0]?.n ?? 0;
  }
}
