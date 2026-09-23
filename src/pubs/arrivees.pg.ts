import type { Pool } from 'pg';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { ArriveePub, IssueArrivee } from '../webhooks/arrivees-pub';
import type { IssueRoutage } from './routage';

/**
 * LA FENÊTRE D'ATTRIBUTION D'UN LEAD QUALIFIÉ, en jours (spec § 3.4, décision de Julien du 2026-09-22).
 *
 * 🔴 ELLE EST ICI ET NULLE PART AILLEURS. C'est le chiffre qui décide si un tag posé aujourd'hui compte pour
 * une publicité cliquée il y a un mois : le recopier dans l'écran de l'entonnoir ferait deux vérités, et
 * c'est le motif qui a déjà coûté à ce dépôt (un compteur affiché à côté d'un compteur calculé autrement).
 */
export const ATTRIBUTION_JOURS = 28;

/**
 * L'écriture des arrivées publicitaires (`arrivees_pub`, migration 0163).
 *
 * 🔴 LA FICHE SE RETROUVE PAR LA RÈGLE PARTAGÉE `MATCH_BY_WAID_SQL`, JAMAIS PAR UNE COPIE. C'est la règle de
 * routage des messages entrants ; une égalité recopiée (`phone_e164 = wa_id`) ne peut jamais être vraie, le
 * fil portant `33612345678` et la fiche `+33612345678`, et c'est exactement le bug de purge du 2026-08-18.
 *
 * Une seule requête rend les deux constats dont l'appelant a besoin : y avait-il une fiche, et la ligne
 * a-t-elle été écrite. Un `on conflict do nothing` seul ne distingue pas « déjà vue » de « aucune fiche ».
 */
export class PgArriveesPubStore {
  constructor(private readonly pool: Pool) {}

  async enregistrer(tenantId: string, waId: string, a: ArriveePub): Promise<IssueArrivee> {
    const res = await this.pool.query<{ fiches: number; ecrites: number }>(
      `with fiche as (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       ), ecrite as (
         insert into arrivees_pub (tenant_id, contact_id, meta_message_id, ad_id, source_type, titre, url, ctwa_clid, en_standby)
         select $1, fiche.id, $3, $4, $5, $6, $7, $8, $9 from fiche
         on conflict (tenant_id, meta_message_id) do nothing
         returning 1
       )
       select (select count(*) from fiche)::int as fiches, (select count(*) from ecrite)::int as ecrites`,
      [tenantId, waId, a.messageId, a.adId, a.sourceType, a.titre, a.url, a.ctwaClid, a.enStandby],
    );
    const r = res.rows[0];
    if (!r || r.fiches === 0) return 'sans_contact';
    return r.ecrites > 0 ? 'ecrite' : 'deja_vue';
  }

  /**
   * Inscrit sur l'arrivée ce que le routage a décidé (lot 3).
   *
   * 🔴 `issue is null` DANS LE `where` : LE PREMIER ROUTAGE GAGNE. Meta redélivre ses webhooks quand notre
   * accusé se perd, et pg-boss rejoue un job interrompu. Sans cette condition, un rejeu réécrirait l'histoire
   * d'un lead déjà routé et surtout DÉPLACERAIT l'heure de reprise, qui est la seule mesure du délai entre
   * l'arrivée et la prise du fil, celle que l'essai réel du pilote doit lire.
   *
   * ⚠️ Aucune ligne touchée est un cas NORMAL, pas une erreur : l'arrivée n'a pas pu être écrite (aucune
   * fiche pour ce `wa_id`), ou elle l'a déjà été et routée. L'appelant n'en tire rien, il route quand même.
   */
  async noterIssue(
    tenantId: string,
    messageId: string,
    v: { campagneId: string | null; issue: IssueRoutage; repriseLe: Date | null },
  ): Promise<void> {
    await this.pool.query(
      `update arrivees_pub set campagne_id = $3, issue = $4, reprise_le = $5
         where tenant_id = $1 and meta_message_id = $2 and issue is null`,
      [tenantId, messageId, v.campagneId, v.issue, v.repriseLe],
    );
  }

  /**
   * CE CONTACT VIENT DE RECEVOIR CE TAG : son arrivée publicitaire la plus récente devient QUALIFIÉE.
   *
   * 🔴 UNE SEULE REQUÊTE, DONC IDEMPOTENTE PAR CONSTRUCTION. Lire puis écrire laisserait deux événements
   * `tag_added` simultanés qualifier la même arrivée deux fois, ou pire, deux arrivées différentes pour un
   * seul tag. Le `qualifie_le is null` du sous-select et l'unicité du `limit 1` font le travail en un tour.
   *
   * 🔴 LA PLUS RÉCENTE, ET UNE SEULE (spec § 3.4). Un contact peut être arrivé par trois publicités : c'est
   * la dernière qui a produit la conversation dans laquelle le tag a été posé. Les compter toutes gonflerait
   * l'entonnoir de chaque campagne avec le travail d'une autre.
   *
   * ⚠️ LA COMPARAISON DU TAG EST EXACTE, pas normalisée, et c'est cohérent avec le reste du dépôt : un tag
   * est choisi dans la liste de l'espace (`tags`, migration 0018) et stocké tel quel dans `contacts.tags`.
   * Normaliser ici ferait qualifier sur « Rappel » un contact tagué « rappelé ».
   *
   * ⚠️ `tag_added` N'EST ÉMIS QUE PAR LES CHEMINS UNITAIRES (bloc d'un scénario, fiche, Inbox, agent IA).
   * L'action en masse, l'import CSV, l'API publique et l'outil MCP n'émettent pas, donc ils ne qualifient
   * personne. C'est un invariant du dépôt (un chemin de masse n'émet jamais), et l'écran de la pub le dit.
   *
   * Rend la campagne qualifiée, ou `null` si aucune arrivée ne correspondait.
   */
  async qualifier(tenantId: string, waId: string, tag: string, fenetreJours = ATTRIBUTION_JOURS): Promise<string | null> {
    const { rows } = await this.pool.query<{ campagne_id: string | null }>(
      // ⚠️ `tenant_id = $1` EST POSÉ DEUX FOIS, dehors et dans le sous-select, et la redite est voulue : la
      // règle du dépôt est « sur CHAQUE requête », pas « quelque part dans la requête ». Un jour où le
      // sous-select changerait de forme, l'isolation ne doit pas partir avec lui.
      `update arrivees_pub set qualifie_le = now()
         where tenant_id = $1 and id = (
           select a.id from arrivees_pub a
             join publicites p on p.tenant_id = a.tenant_id and p.campagne_id = a.campagne_id
            where a.tenant_id = $1
              and a.qualifie_le is null
              and a.arrivee_le > now() - ($4::int * interval '1 day')
              and p.tag_qualification = $3
              and a.contact_id = (
                select id from contacts where tenant_id = $1
                ${MATCH_BY_WAID_SQL}
              )
            order by a.arrivee_le desc
            limit 1
         )
         returning campagne_id`,
      [tenantId, waId, tag, fenetreJours],
    );
    return rows[0]?.campagne_id ?? null;
  }
}
