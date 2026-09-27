import type { Pool } from 'pg';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { ArriveePub, IssueArrivee } from '../webhooks/arrivees-pub';
import type { IssueRoutage } from './routage';

/**
 * La fenêtre d'attribution d'un lead qualifié, en jours : elle décide si un tag posé aujourd'hui compte pour
 * une publicité cliquée il y a un mois. Écrite ici et nulle part ailleurs, pour que l'écran de l'entonnoir ne
 * compte pas autrement.
 */
export const ATTRIBUTION_JOURS = 28;

/**
 * L'écriture des arrivées publicitaires (`arrivees_pub`). La fiche se retrouve par la règle partagée
 * `MATCH_BY_WAID_SQL`, jamais par une copie : une égalité `phone_e164 = wa_id` n'est jamais vraie (le fil
 * porte `33612345678`, la fiche `+33612345678`). Une seule requête dit s'il y avait une fiche et si la ligne
 * a été écrite, ce qu'un `on conflict do nothing` seul ne distingue pas.
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
   * Inscrit sur l'arrivée ce que le routage a décidé. `issue is null` dans le `where` : le premier routage
   * gagne. Meta redélivre ses webhooks et pg-boss rejoue un job interrompu ; sans cette condition, un rejeu
   * réécrirait l'histoire d'un lead et déplacerait l'heure de reprise, seule mesure du délai entre l'arrivée et
   * la prise du fil. Aucune ligne touchée est un cas normal (pas de fiche, ou déjà routée).
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
   * Ce contact vient de recevoir ce tag : son arrivée publicitaire la plus récente devient qualifiée. Rend la
   * campagne qualifiée, ou `null`.
   *
   * Une seule requête, donc idempotente : lire puis écrire laisserait deux `tag_added` simultanés qualifier
   * deux fois. La plus récente et une seule : c'est la dernière pub qui a produit la conversation où le tag est
   * posé. Comparaison du tag exacte, comme partout (un tag est choisi dans la liste de l'espace). `tag_added`
   * n'est émis que par les chemins unitaires : un chemin de masse ne qualifie personne.
   */
  async qualifier(tenantId: string, waId: string, tag: string, fenetreJours = ATTRIBUTION_JOURS): Promise<string | null> {
    const { rows } = await this.pool.query<{ campagne_id: string | null }>(
      // 🔴 `tenant_id = $1` posé deux fois, dehors et dans le sous-select : la règle est « sur chaque requête »,
      // et l'isolation ne doit pas partir le jour où le sous-select change de forme.
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
