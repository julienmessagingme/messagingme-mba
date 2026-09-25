import type { Pool } from 'pg';
import { verdictWhatsApp } from '../contacts/joignabilite';
import { waIdOf } from '../crm/identity';
import { joignabiliteRcsConnue } from '../rcs/reachability';
import type { FaitsRisque, MessageDelivre, NiveauRisque, RaisonRisque, Risque } from './risque';

/**
 * LA LECTURE ET L'ÉCRITURE DU RISQUE DE DÉSENGAGEMENT (spec § 19, tâche 3 du plan du lot 7).
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE TABLE QUI EN PORTE UN : la connexion passe par le pooler en rôle superuser, la
 * RLS est contournée, ce filtre est le seul contrôle (`tests/risque-isolation.test.ts`, qui se mute en local).
 * Les trois tables qui n'en portent pas sont bornées par une jointure qui, elle, filtre : `campaign_recipients` par
 * sa campagne, `conversation_messages` par les fils de l'espace, `rcs_capabilities_cache` par l'agent RCS de
 * l'espace.
 *
 * 🔴 GROUPÉE, JAMAIS UNE REQUÊTE PAR CONTACT. Un balayage d'espace fait UNE lecture des fiches à évaluer, puis,
 * par lot de fiches (`TAILLE_LOT_RISQUE`, dans `balayage.ts`), UNE lecture des faits et UNE écriture. Sur un espace
 * de 100 000 contacts : la liste parcourt les fiches de l'espace et sonde, pour chacune qui n'est pas déjà
 * retenue, `campaign_recipients_contact_idx (contact_id, sent_at desc)` ; chaque lot de faits ne touche que des
 * index (clé primaire des contacts, `conversations_contact_idx` et l'unique `(tenant_id, wa_id)` des fils,
 * `campaign_recipients_contact_idx`, `conversation_messages_unread_idx` partiel sur les entrants,
 * `tracked_link_clicks_contact_idx`, la clé primaire de `conversation_analysis`, celle du cache RCS), bornés par
 * la fenêtre de 90 jours ; l'écriture se fait par clé primaire.
 */

/** La ligne d'une fiche à évaluer : ses faits, et le niveau stocké (celui dont on part). */
export interface ContactAEvaluer {
  contactId: string;
  niveauStocke: NiveauRisque | null;
  faits: FaitsRisque;
}

/** Un changement de NIVEAU, rendu par l'écriture. Rester au même niveau n'en est pas un. */
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
   * Les espaces à balayer. LA SEULE LECTURE TRANSVERSE de ce fichier, délibérée : le balayage de nuit fait le
   * tour des espaces. Un espace VERROUILLÉ (arrêt d'urgence, `/ops/verrou`) est sauté : le balayage peut
   * déclencher des scénarios, et un espace arrêté ne doit rien démarrer de neuf.
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
   * Les fiches à évaluer (plan, tâche 3) : celles qui ont reçu un envoi de campagne sur la fenêtre, celles dont
   * le niveau stocké n'est pas null (pour qu'un contact qu'on n'écrit plus retombe en `inconnu` au lieu de
   * garder un niveau d'il y a trois mois), les désabonnées et les bloquées. Des identifiants seulement : les
   * faits se lisent ensuite par lots.
   *
   * ⚠️ L'INDEX DU RISQUE NE SERT PAS CETTE REQUÊTE, et le commentaire de la migration 0178 le dit à tort (« il sert
   * aussi la lecture des fiches à réévaluer »). `risque_niveau is not null` n'y est qu'une branche d'un OU dont une
   * autre est un `exists` : aucun index ne peut servir la condition entière, donc la requête parcourt les fiches
   * de l'espace et sonde `campaign_recipients_contact_idx` pour chacune (cf. l'en-tête du fichier).
   * `contacts_tenant_risque_idx (tenant_id, risque_niveau)` sert le filtre de la liste, qui pose une égalité nue,
   * et le compte du plafond du jour (`declenchablesDepuis`). Une migration appliquée ne se réécrit pas : la
   * correction vit ici et dans `documentation.md`.
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
   * Les faits d'un LOT de fiches, en une requête. Une fiche supprimée entre-temps n'est pas rendue.
   *
   * ⚠️ LES FILS D'UN CONTACT SE TROUVENT PAR DEUX CHEMINS, comme sur la fiche du mini-CRM
   * (`CONVERSATION_DU_CONTACT_SQL`) : `contact_id` seul perd les conversations ouvertes avant que la fiche
   * existe, il faut rattraper par `wa_id`. Écrits ici en UNION de deux jointures, chacune sur son index, plutôt
   * qu'avec le `or` du fragment, qui ne sait servir qu'UN contact à la fois.
   *
   * ⚠️ UNE RÉPONSE EST TOUT MESSAGE ENTRANT, comme l'« engagé » de l'historique d'une fiche : un appui de bouton
   * arrive en entrant, et « oui » écrit à la main est la même réaction.
   */
  async faits(tenantId: string, ids: readonly string[], depuis: Date, maintenant: Date): Promise<ContactAEvaluer[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<LigneFaits>(
      `with cible as (
         select c.id, c.opt_in_status, c.rcs_optout_at, c.blocked_at, c.whatsapp_joignable, c.whatsapp_joignable_le,
                c.risque_niveau,
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
           from fils f join conversation_analysis ca on ca.conversation_id = f.conversation_id
          where ca.tenant_id = $1 and ca.created_at >= $3
          order by f.contact_id, ca.created_at desc
       ),
       agent as (
         select ag.agent_id from rcs_agents ag where ag.tenant_id = $1 order by ag.created_at asc limit 1
       )
       select ct.id, ct.opt_in_status, ct.rcs_optout_at, ct.blocked_at, ct.whatsapp_joignable, ct.whatsapp_joignable_le,
              ct.risque_niveau, e.envoyes_le, e.lus, e.lus_le, rp.le as derniere_reponse, cl.le as dernier_clic,
              an.intent, an.sentiment, an.resolved, an.satisfaction, an.created_at as analyse_le,
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
   * Écrit le calcul d'un lot et rend les CHANGEMENTS DE NIVEAU.
   *
   * 🔴 L'ANCIEN NIVEAU EST LU SOUS VERROU, DANS LA MÊME INSTRUCTION (`for update`). Le balayage de nuit (worker) et
   * le lancement à la demande (`/ops`, l'API) peuvent passer en même temps sur un même espace : sans ce verrou,
   * les deux liraient « moyen », écriraient « élevé », et déclencheraient chacun l'automation. Le second attend
   * le premier, relit « élevé », et ne voit aucun passage.
   *
   * ⚠️ `updated_at` NE BOUGE PAS : un calcul n'est pas une modification de la fiche par quelqu'un.
   *
   * 🔴 SEULES LES FICHES QUI CHANGENT SONT RÉÉCRITES (relecture du lot 7, 2026-09-25). `contacts` est la table du
   * chemin chaud (chaque message entrant la lit et l'écrit) : réécrire chaque nuit toutes les fiches évaluées,
   * même inchangées, y produisait une version morte par fiche et par nuit. La garde `is distinct from` porte sur
   * les TROIS colonnes de la valeur (niveau, score, raisons), dans `avant`, donc une fiche inchangée n'est ni
   * verrouillée ni réécrite. Un changement de niveau change forcément la valeur : aucune transition ne peut être
   * perdue par la garde. Si un passage concurrent a écrit entre-temps, le verrou relit la nouvelle version et la
   * garde la réévalue sur elle.
   *
   * 🔴 ET `risque_calcule_le` NE BOUGE QU'AVEC LE NIVEAU : c'est désormais « à ce niveau DEPUIS le », et la console
   * comme l'API le disent ainsi (`computedAt`). Un score ou des raisons qui changent sans changer le niveau sont
   * réécrits, pas la date. La faire bouger chaque nuit pour dire « vérifié le » aurait exigé de réécrire chaque
   * fiche chaque nuit, c'est-à-dire exactement ce que la garde retire. C'est aussi la date que lit le plafond du
   * jour (`declenchablesDepuis`) : un passage en élevé est un changement de niveau, donc il porte sa date.
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
   * Les passages en élevé DÉCLENCHABLES écrits pour cet espace depuis `depuis` (minuit, Paris) : le plafond du
   * jour (`PLAFOND_DECLENCHEMENTS_PAR_JOUR`, `balayage.ts`) s'en sert pour qu'un lancement `/ops` ne s'ajoute pas
   * à la nuit.
   *
   * La trace est la fiche elle-même : `risque_calcule_le` ne bouge qu'au changement de niveau (`ecrire`), donc un
   * `eleve` daté d'aujourd'hui est un passage d'aujourd'hui. Mêmes exclusions que le point d'émission : STOP et
   * blocage (ils ne déclenchent rien, et la première nuit en ferait passer beaucoup), fiche sans adresse (`waIdOf`
   * ne rend rien : un téléphone vide et aucun BSUID).
   *
   * ⚠️ L'égalité NUE `risque_niveau = 'eleve'` derrière `tenant_id = $1 and deleted_at is null` est le contrat de
   * l'index partiel `contacts_tenant_risque_idx` : la requête ne lit que les fiches en élevé de l'espace.
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
