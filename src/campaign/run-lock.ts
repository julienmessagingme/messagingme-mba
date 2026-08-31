import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Verrou d'exécution PAR CAMPAGNE (R1-bis, migration 0089).
 *
 * Il remplace une déduplication qu'on croyait avoir et qui n'a jamais existé : le `singletonKey` de pg-boss ne
 * déduplique que sous une policy de file autre que le défaut `standard`, et les nôtres sont créées sans policy
 * (cf. `Queue.enqueue`). Ce n'est pas une garantie de plus, c'est LA garantie, et elle vit ici parce que la file
 * ne peut pas la porter (la policy d'une file est immuable après création).
 *
 * Ce qu'il empêche, précisément : que DEUX runs de la même campagne tournent en même temps. Aucun contact ne
 * recevait deux fois même avant (le claim atomique par destinataire tient), mais chaque run instancie SON
 * limiteur de débit en mémoire, donc N runs envoient à N fois la cadence choisie. C'est le débit qui est
 * protégé ici, pas l'unicité de l'envoi.
 *
 * Posé au SEUL endroit qui exécute (`campaignRunJob`), jamais aux cinq endroits qui enfilent : on n'essaie pas
 * d'empêcher les enfilements en double, on empêche les exécutions en double. C'est la même différence qu'entre
 * verrouiller toutes les portes et verrouiller le coffre.
 */
export interface CampaignRunLock {
  /**
   * Tente de prendre le verrou. Retourne le jeton de garde si on l'a, `null` si un run vivant le tient (et
   * marque alors une relance à faire, cf. `release`). Un verrou dont le bail a expiré est repris.
   */
  acquire(campaignId: string, tenantId: string, leaseSeconds: number): Promise<string | null>;
  /**
   * Rend le verrou et dit si une relance a été demandée pendant qu'on le tenait. `false` aussi quand le verrou
   * ne nous appartient plus (bail expiré, repris par un autre) : dans ce cas l'autre porte la responsabilité de
   * la relance, et nous n'avons rien supprimé.
   */
  release(campaignId: string, tenantId: string, holder: string): Promise<{ rerunDemande: boolean }>;
}

export class PgCampaignRunLock implements CampaignRunLock {
  constructor(private readonly pool: Pool) {}

  async acquire(campaignId: string, tenantId: string, leaseSeconds: number): Promise<string | null> {
    const holder = randomUUID();
    // UNE requête, donc atomique sans transaction : l'insert échoue sur la PK si le verrou existe, et la branche
    // `do update` ne s'applique QUE si son bail est écoulé. Pas de ligne retournée = un run vivant le tient.
    // `rerun` repart à false quand on reprend un verrou : le drapeau appartient au tenant courant, pas au passé.
    const res = await this.pool.query<{ holder: string }>(
      `insert into campaign_run_locks (campaign_id, tenant_id, holder, expires_at)
       values ($1, $2, $3, now() + make_interval(secs => $4))
       on conflict (campaign_id) do update
         set holder = excluded.holder, tenant_id = excluded.tenant_id,
             acquired_at = now(), expires_at = excluded.expires_at, rerun = false
         where campaign_run_locks.expires_at < now()
       returning holder`,
      [campaignId, tenantId, holder, Math.max(1, Math.ceil(leaseSeconds))],
    );
    if ((res.rowCount ?? 0) > 0) return holder;
    // Verrou tenu par un run vivant : on note qu'il restera peut-être du travail après lui. Le job écarté peut
    // porter un destinataire remis en attente APRÈS que le run en cours ait pris son instantané ; sans cette
    // marque il resterait `pending` à vie sur une campagne passée `completed`.
    await this.pool.query(
      `update campaign_run_locks set rerun = true where campaign_id = $1 and tenant_id = $2`,
      [campaignId, tenantId],
    );
    return null;
  }

  async release(campaignId: string, tenantId: string, holder: string): Promise<{ rerunDemande: boolean }> {
    // `holder = $3` est le JETON DE GARDE. Si notre bail a expiré et qu'un autre run a repris le verrou, ce
    // delete ne touche RIEN : on ne lui vole pas son verrou, et on ne s'attribue pas sa relance.
    const res = await this.pool.query<{ rerun: boolean }>(
      `delete from campaign_run_locks where campaign_id = $1 and tenant_id = $2 and holder = $3 returning rerun`,
      [campaignId, tenantId, holder],
    );
    return { rerunDemande: res.rows[0]?.rerun === true };
  }
}
