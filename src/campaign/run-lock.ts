import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Verrou d'exécution par campagne : empêche que deux runs de la même campagne tournent en même temps.
 *
 * La file ne peut pas le faire : le `singletonKey` de pg-boss ne déduplique que sous une policy autre que
 * `standard`, et la policy d'une file est immuable après création. Le claim atomique par destinataire évite
 * déjà le double envoi ; ce verrou protège le débit, car chaque run a son limiteur en mémoire.
 *
 * Posé au seul endroit qui exécute (`campaignRunJob`) : on empêche les exécutions en double, pas les
 * enfilements en double.
 */
/**
 * Durée du bail, en secondes : courte et renouvelée à chaque relecture de statut du moteur (toutes les 5 s),
 * pour qu'un process tué libère la campagne en deux minutes au pire au lieu de geler la reprise des heures.
 * L'expiration du job pg-boss reste la borne extérieure.
 */
export const BAIL_SECONDES = 120;

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
  /**
  /**
   * Repousse l'échéance du bail. `false` = on ne le tient plus (écoulé, repris par un autre) : l'appelant doit
   * s'arrêter, sinon deux runs de la même campagne tourneraient en parallèle.
   */
  renouveler(campaignId: string, tenantId: string, holder: string): Promise<boolean>;
}

export class PgCampaignRunLock implements CampaignRunLock {
  constructor(private readonly pool: Pool) {}

  async acquire(campaignId: string, tenantId: string, leaseSeconds: number): Promise<string | null> {
    const holder = randomUUID();
    // Une requête, donc atomique sans transaction : l'insert échoue sur la PK si le verrou existe, et la branche
    // `do update` ne s'applique que si son bail est écoulé. Pas de ligne retournée = un run vivant le tient.
    // `rerun` repart à false quand on reprend un verrou : le drapeau appartient au porteur courant.
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
    // Verrou tenu par un run vivant : on marque une relance. Le job écarté peut porter un destinataire remis en
    // attente après l'instantané du run en cours ; sans cette marque, il resterait `pending` à vie.
    await this.pool.query(
      `update campaign_run_locks set rerun = true where campaign_id = $1 and tenant_id = $2`,
      [campaignId, tenantId],
    );
    return null;
  }

  async renouveler(campaignId: string, tenantId: string, holder: string): Promise<boolean> {
    // Le jeton dans la clause : si notre bail a expiré et qu'un autre run a repris le verrou, on ne repousse
    // pas le sien, et on apprend qu'on ne tient plus rien.
    const res = await this.pool.query(
      `update campaign_run_locks set expires_at = now() + make_interval(secs => $4)
       where campaign_id = $1 and tenant_id = $2 and holder = $3`,
      [campaignId, tenantId, holder, BAIL_SECONDES],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async release(campaignId: string, tenantId: string, holder: string): Promise<{ rerunDemande: boolean }> {
    // `holder = $3` est le jeton de garde : si un autre run a repris le verrou, ce delete ne touche rien, on ne
    // lui vole ni son verrou ni sa relance.
    const res = await this.pool.query<{ rerun: boolean }>(
      `delete from campaign_run_locks where campaign_id = $1 and tenant_id = $2 and holder = $3 returning rerun`,
      [campaignId, tenantId, holder],
    );
    return { rerunDemande: res.rows[0]?.rerun === true };
  }
}
