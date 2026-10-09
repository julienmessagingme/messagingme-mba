import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { estClientEnregistre, type ClientResolu } from './clients';

/**
 * Les clients OAuth ENREGISTRÉS par `POST /oauth/register` (RFC 7591 ; migration 0227, lot 15). Anonymes : aucune clé
 * vers un espace, l'enregistrement précède toute connexion. 🔴 Ni secret ni jeton ici : un client enregistré est
 * public, il prouve chaque échange par PKCE.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `mcl_` et 32 caractères tirés sans biais (rejet des octets au-delà du dernier multiple de 62). */
export function nouvelIdentifiantClient(): string {
  let out = '';
  while (out.length < 32) {
    for (const o of randomBytes(48)) {
      if (o < 248 && out.length < 32) out += ALPHABET[o % 62];
    }
  }
  return `mcl_${out}`;
}

export interface NouveauClient {
  nom: string | null;
  adressesDeRetour: string[];
  typeApplication: 'web' | 'native' | null;
}

/** Combien de jours un client enregistré survit sans autorisation vivante. */
export const RETENTION_CLIENTS_JOURS = 30;
const PAQUET_PURGE_CLIENTS = 1000;

export class PgOauthClientsStore {
  constructor(private readonly pool: Pool) {}

  async enregistrer(c: NouveauClient): Promise<{ clientId: string; creeLe: Date }> {
    const res = await this.pool.query<{ client_id: string; cree_le: Date }>(
      `insert into oauth_clients (client_id, nom, adresses_de_retour, type_application)
       values ($1, $2, $3::text[], $4) returning client_id, cree_le`,
      [nouvelIdentifiantClient(), c.nom, c.adressesDeRetour, c.typeApplication],
    );
    const r = res.rows[0]!;
    return { clientId: r.client_id, creeLe: r.cree_le };
  }

  /** Le client de cet identifiant, ou `null` (forme fausse, inconnu, purgé). La forme est vue AVANT la base. */
  async lire(id: string): Promise<ClientResolu | null> {
    if (!estClientEnregistre(id)) return null;
    const res = await this.pool.query<{ client_id: string; nom: string | null; adresses_de_retour: string[] }>(
      'select client_id, nom, adresses_de_retour from oauth_clients where client_id = $1',
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    const hote = new URL(r.adresses_de_retour[0]!).hostname;
    return { id: r.client_id, nom: r.nom ?? hote, adressesDeRetour: r.adresses_de_retour, marque: 'declaree' };
  }

  /**
   * La purge (worker) : les clients enregistrés depuis plus de `RETENTION_CLIENTS_JOURS` qu'aucune autorisation
   * VIVANTE n'utilise (non révoquée, renouvellement encore valide, ou code pas encore échangé). Un client purgé dont
   * une autorisation morte subsiste n'est plus reconnu : son renouvellement échoue et l'application redemande une
   * connexion.
   */
  async purger(): Promise<number> {
    // Par paquets bornés, comme `PgOauthStore.purger` : une rafale d'enregistrements ne tient jamais un verrou long.
    let total = 0;
    for (;;) {
      const res = await this.pool.query(
        `delete from oauth_clients where client_id in (
           select c.client_id from oauth_clients c
            where c.cree_le < now() - make_interval(days => $1::int)
              and not exists (
                select 1 from oauth_autorisations a
                 where a.client_id = c.client_id and a.revoque_le is null
                   and (a.refresh_hash is null or least(a.refresh_expire_le, a.refresh_max_le) > now()))
            limit $2)`,
        [RETENTION_CLIENTS_JOURS, PAQUET_PURGE_CLIENTS],
      );
      const n = res.rowCount ?? 0;
      total += n;
      if (n < PAQUET_PURGE_CLIENTS) return total;
    }
  }
}
