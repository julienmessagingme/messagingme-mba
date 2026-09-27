import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import type { Connexion, ConnexionPublique } from './types';

/**
 * Colonnes de la projection publique de `channelsme_connections`. 🔴 `api_key_enc` et `secret_enc` n'y
 * figurent pas : sur ce chemin, le chiffré ne quitte jamais la base, ce qui se vérifie en lisant une requête.
 * Liste tenue à la main : une colonne ajoutée ici doit l'être aussi dans `ConnexionRow` et `versPublique`.
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
    // Les deux colonnes chiffrées sont `not null` et `upsert` est leur seul rédacteur : une ligne existe si et
    // seulement si les deux secrets sont enregistrés. Si l'une devenait nullable, ces booléens se calculeraient
    // en SQL.
    hasApiKey: true,
    hasSecret: true,
    verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
  };
}

/**
 * La connexion Channels Me d'un tenant : une ligne par tenant, les deux secrets chiffrés au repos. Le
 * chiffrement se fait dans ce store, dans les paramètres de la requête, pour qu'aucun clair ne transite par
 * une couche supérieure ; la clé arrive par le constructeur, testable sans variable d'environnement.
 */
export class PgChannelsMeConnectionStore {
  constructor(private readonly pool: Pool, private readonly encryptionKey: string) {}

  /** Ce que l'API a le droit de rendre : jamais un secret, seulement leur présence. */
  async get(tenantId: string): Promise<ConnexionPublique | null> {
    const { rows } = await this.pool.query<ConnexionRow>(
      `select ${COLS} from channelsme_connections where tenant_id=$1`,
      [tenantId],
    );
    return rows[0] ? versPublique(rows[0]) : null;
  }

  /** Les secrets déchiffrés, pour appeler Channels Me depuis le serveur. En mémoire uniquement, jamais
   *  sérialisés vers le client. */
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
   * Provisionne ou remplace les secrets du tenant (upsert sur la clé primaire). `verified_at` retombe à null à
   * chaque écriture : une preuve de validité porte sur les secrets essayés, pas sur la ligne, et l'écran
   * dirait sinon « connexion vérifiée » d'une clé jamais essayée.
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

  /**
   * Débranche la chaîne : oublie les identifiants ; `true` = une connexion existait. Seule cette table est
   * touchée : liens et publications n'ont aucune clé étrangère vers elle, et un post publié circule pour
   * toujours, son bouton doit continuer de démarrer son scénario. Rebrancher, c'est ressaisir les identifiants.
   */
  async supprimer(tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from channelsme_connections where tenant_id=$1`, [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Les creds viennent d etre essayes contre Channels Me et ils marchent. */
  async markVerified(tenantId: string): Promise<void> {
    await this.pool.query(
      `update channelsme_connections set verified_at = now(), updated_at = now() where tenant_id=$1`,
      [tenantId],
    );
  }
}
