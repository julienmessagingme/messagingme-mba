import type { Pool } from 'pg';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { ArriveePub, IssueArrivee } from '../webhooks/arrivees-pub';

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
}
