import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import type { Connexion, ConnexionPublique } from './types';

/**
 * Colonnes de la projection PUBLIQUE de `channelsme_connections`.
 *
 * 🔴 `api_key_enc` et `secret_enc` n y figurent pas, et ne sont meme pas TRANSPORTEES : sur ce chemin, le
 * chiffre ne quitte jamais la base. C est la difference entre « le secret n est pas rendu au client » et
 * « le secret n est pas lu du tout », et c est la seconde qu on veut, parce qu elle se verifie en lisant
 * une seule requete.
 *
 * ⚠️ Liste tenue A LA MAIN : ajouter une colonne oblige a toucher aussi `ConnexionRow` et `versPublique`.
 */
const COLS = 'org_id, channel_id, verified_at';

/** Forme brute d une ligne `channelsme_connections` pour COLS, telle que Postgres la rend. Jamais un chiffre. */
interface ConnexionRow {
  org_id: string;
  channel_id: string;
  verified_at: Date | null;
}

/** Idem plus les deux colonnes chiffrees : uniquement pour getSecrets(), jamais selectionnees ailleurs. */
interface ConnexionRowAvecSecrets extends ConnexionRow {
  api_key_enc: string;
  secret_enc: string;
}

/** Ligne brute vers projection publique. Partagee par les methodes qui SELECTent COLS. */
function versPublique(r: ConnexionRow): ConnexionPublique {
  return {
    orgId: r.org_id,
    channelId: r.channel_id,
    // Les deux colonnes chiffrees sont `not null` (migration 0114) et `upsert` est leur SEUL redacteur : une
    // ligne existe si et seulement si les deux creds sont enregistres. On l affirme ici plutot que de faire
    // voyager le chiffre jusqu au mapping pour tester s il est vide.
    // ⚠️ Rendre une de ces deux colonnes nullable un jour obligerait a calculer ces booleens en SQL.
    hasApiKey: true,
    hasSecret: true,
    verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
  };
}

/**
 * La connexion Channels Me d un tenant : une ligne par tenant (cle primaire `tenant_id`), les deux secrets
 * chiffres au repos.
 *
 * Deux choses ne se negocient pas ici. Le chiffrement se fait DANS ce store, directement dans le tableau de
 * parametres de la requete : c est ce qui rend impossible de faire transiter un clair par une couche
 * superieure. Et la cle arrive par le CONSTRUCTEUR au lieu d etre lue dans la config, ce qui rend le store
 * testable sans variable d environnement, en local comme en CI.
 */
export class PgChannelsMeConnectionStore {
  constructor(private readonly pool: Pool, private readonly encryptionKey: string) {}

  /** Ce que l API a le droit de rendre : jamais un secret, seulement leur PRESENCE. */
  async get(tenantId: string): Promise<ConnexionPublique | null> {
    const { rows } = await this.pool.query<ConnexionRow>(
      `select ${COLS} from channelsme_connections where tenant_id=$1`,
      [tenantId],
    );
    return rows[0] ? versPublique(rows[0]) : null;
  }

  /**
   * Les creds DECHIFFRES, pour appeler Channels Me depuis le serveur.
   * En memoire uniquement, jamais serialise vers le client.
   */
  async getSecrets(tenantId: string): Promise<Connexion | null> {
    const { rows } = await this.pool.query<ConnexionRowAvecSecrets>(
      `select ${COLS}, api_key_enc, secret_enc from channelsme_connections where tenant_id=$1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      orgId: row.org_id,
      channelId: row.channel_id,
      apiKey: decryptSecret(row.api_key_enc, this.encryptionKey),
      secret: decryptSecret(row.secret_enc, this.encryptionKey),
    };
  }

  /**
   * Provisionne ou REMPLACE les creds du tenant (une ligne par tenant, d ou l upsert sur la cle primaire).
   *
   * 🔴 `verified_at` retombe a null a chaque ecriture. Une preuve de validite porte sur les creds qui ont ete
   * essayes, pas sur la ligne qui les contient : garder l ancienne date ferait dire a l ecran « connexion
   * verifiee » a propos d une cle que personne n a jamais essayee.
   */
  async upsert(tenantId: string, c: Connexion): Promise<void> {
    await this.pool.query(
      `insert into channelsme_connections (tenant_id, org_id, channel_id, api_key_enc, secret_enc, updated_at)
       values ($1,$2,$3,$4,$5, now())
       on conflict (tenant_id) do update set
         org_id = excluded.org_id,
         channel_id = excluded.channel_id,
         api_key_enc = excluded.api_key_enc,
         secret_enc = excluded.secret_enc,
         verified_at = null,
         updated_at = now()`,
      [
        tenantId, c.orgId, c.channelId,
        encryptSecret(c.apiKey, this.encryptionKey),
        encryptSecret(c.secret, this.encryptionKey),
      ],
    );
  }

  /** Les creds viennent d etre essayes contre Channels Me et ils marchent. */
  async markVerified(tenantId: string): Promise<void> {
    await this.pool.query(
      `update channelsme_connections set verified_at = now(), updated_at = now() where tenant_id=$1`,
      [tenantId],
    );
  }
}
