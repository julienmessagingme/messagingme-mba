import type { Pool } from 'pg';

/**
 * La clé AI Gateway d'un espace : lecture, écriture, et déplacement de son plafond.
 *
 * Le secret entre et sort chiffré de ce module : le chiffrement est injecté (`chiffrer` / `dechiffrer`),
 * jamais relu depuis la configuration, pour qu'un seul endroit lise la clé de chiffrement. Aucune méthode ne
 * journalise le secret ; la seule sortie est `cleDe`, consommée par le client de modèle, jamais par une route.
 */
export interface CleGatewayEspace {
  cleId: string;
  /** Le secret en clair. Ne jamais le mettre dans un journal ni dans une réponse HTTP. */
  cle: string;
  plafondMicroEur: number;
}

/**
 * Ce que la base dit de la clé d'un espace : aucune ligne (`absente`), une ligne lue (`lue`), ou une ligne qui ne se
 * déchiffre pas (`illisible`). Seule `absente` autorise à en ouvrir une.
 */
export type LectureCleGateway =
  | { etat: 'absente' }
  | { etat: 'illisible' }
  | { etat: 'lue'; cle: CleGatewayEspace };

export class PgCleGatewayStore {
  constructor(
    private readonly pool: Pool,
    private readonly chiffrer: (clair: string) => string,
    private readonly dechiffrer: (chiffre: string) => string,
    /**
     * Prévient quand une clé existe mais ne se déchiffre pas : sans ça, le repli sur la clé maison est muet et
     * la dépense de l'espace cesse d'être attribuée sans que rien ne le dise. Optionnel pour les tests.
     */
    private readonly signaler?: (tenantId: string, err: unknown) => void,
  ) {}

  /**
   * La clé de cet espace, déchiffrée, ou `null` s'il n'en a pas (pas une erreur : l'appelant retombe sur la
   * clé maison). Une clé illisible rend aussi `null` ici : qui doit les distinguer lit `lireEtat`.
   */
  async lire(tenantId: string): Promise<CleGatewayEspace | null> {
    const lu = await this.lireEtat(tenantId);
    return lu.etat === 'lue' ? lu.cle : null;
  }

  /**
   * La clé de cet espace, en distinguant « pas de clé » de « clé illisible ».
   *
   * 🔴 LES CONFONDRE FAISAIT BOUCLER L'OUVERTURE (relecture du lot 1, 2026-09-28). Une ligne présente mais
   * indéchiffrable se lisait comme une absence : le provisionnement créait alors une clé chez Vercel, se heurtait à
   * la ligne existante, la supprimait, et recommençait au répit suivant, une fois par minute et par espace. Une clé
   * illisible ne s'ouvre pas à nouveau : c'est une panne (clé de chiffrement changée ou ligne abîmée), qui se
   * signale et attend un humain.
   */
  async lireEtat(tenantId: string): Promise<LectureCleGateway> {
    const res = await this.pool.query<{ cle_id: string; cle_chiffree: string; plafond_micro_eur: string }>(
      'select cle_id, cle_chiffree, plafond_micro_eur from agent_gateway_keys where tenant_id = $1',
      [tenantId],
    );
    const row = res.rows[0];
    if (!row) return { etat: 'absente' };
    try {
      return {
        etat: 'lue',
        cle: { cleId: row.cle_id, cle: this.dechiffrer(row.cle_chiffree), plafondMicroEur: Number(row.plafond_micro_eur) },
      };
    } catch (err) {
      // 🔴 Déchiffrement impossible : `lire` retombe sur la clé maison plutôt que de faire échouer tous les tours
      // d'agent de l'espace, mais on le signale, sinon le repli serait indiscernable d'un espace sans clé. La
      // route de création, elle, refuse : là c'est une panne, pas un état normal.
      this.signaler?.(tenantId, err);
      return { etat: 'illisible' };
    }
  }

  /**
   * Enregistre la clé d'un espace. Le conflit est un succès : une autre création d'agent a gagné la course,
   * et sa clé fait autorité.
   *
   * 🔴 Rend ce qui est en base après coup, pas ce qu'on voulait écrire : le perdant repart avec la clé du
   * gagnant, et voit à l'identifiant différent qu'il doit supprimer chez Vercel la clé devenue inutile (elle
   * facturerait sans servir).
   */
  async enregistrer(tenantId: string, o: { cleId: string; cle: string; plafondMicroEur: number }): Promise<CleGatewayEspace> {
    const res = await this.pool.query<{ cle_id: string; cle_chiffree: string; plafond_micro_eur: string }>(
      `insert into agent_gateway_keys (tenant_id, cle_id, cle_chiffree, plafond_micro_eur)
       values ($1, $2, $3, $4)
       on conflict (tenant_id) do update set updated_at = now()
       returning cle_id, cle_chiffree, plafond_micro_eur`,
      [tenantId, o.cleId, this.chiffrer(o.cle), Math.max(0, Math.round(o.plafondMicroEur))],
    );
    const row = res.rows[0]!;
    return { cleId: row.cle_id, cle: this.dechiffrer(row.cle_chiffree), plafondMicroEur: Number(row.plafond_micro_eur) };
  }

  /**
   * Oublie la clé d'un espace. 🔴 N'appelle pas Vercel : la révocation là-bas est le geste de l'appelant, et
   * doit passer avant, sinon la clé facturerait avec un identifiant que plus personne ne connaît.
   */
  async oublier(tenantId: string): Promise<boolean> {
    const res = await this.pool.query('delete from agent_gateway_keys where tenant_id = $1', [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Note le plafond réellement posé chez Vercel, pour ne rappeler Vercel que quand il change. */
  async noterPlafond(tenantId: string, plafondMicroEur: number): Promise<void> {
    await this.pool.query(
      'update agent_gateway_keys set plafond_micro_eur = $2, updated_at = now() where tenant_id = $1',
      [tenantId, Math.max(0, Math.round(plafondMicroEur))],
    );
  }
}
