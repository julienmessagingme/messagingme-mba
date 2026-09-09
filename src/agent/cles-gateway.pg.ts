import type { Pool } from 'pg';

/**
 * La cle AI Gateway d'un espace : lecture, ecriture, et deplacement de son plafond (migration 0124).
 *
 * 🔴 LE SECRET ENTRE ET SORT CHIFFRE DE CE MODULE. Le chiffrement est INJECTE (`chiffrer` / `dechiffrer`),
 * il n'est pas relu depuis la configuration ici : c'est le contrat que `PgChannelsMeConnectionStore` tient
 * deja pour ses deux secrets. Un store qui irait chercher `config.ENCRYPTION_KEY` tout seul serait un
 * second endroit ou la cle de chiffrement est lue, donc un second endroit ou l'oublier.
 *
 * ⚠️ AUCUNE de ces methodes ne journalise le secret, et aucune ne le rend au client : la seule sortie est
 * `cleDe`, consommee par le client de modele, jamais par une route.
 */
export interface CleGatewayEspace {
  cleId: string;
  /** Le secret EN CLAIR. Ne jamais le mettre dans un journal ni dans une reponse HTTP. */
  cle: string;
  plafondMicroEur: number;
}

export class PgCleGatewayStore {
  constructor(
    private readonly pool: Pool,
    private readonly chiffrer: (clair: string) => string,
    private readonly dechiffrer: (chiffre: string) => string,
    /**
     * Prévenir quand une clé existe mais ne se déchiffre pas.
     *
     * 🔴 SANS ÇA, LE REPLI EST TOTALEMENT MUET. L'espace retombe sur la clé maison, ses agents continuent de
     * répondre, tout a l'air normal, et sa dépense cesse d'être attribuée sans que rien ne le dise. C'est
     * exactement la panne qu'on ne veut pas : celle qui ne se voit pas. Optionnel pour les tests.
     */
    private readonly signaler?: (tenantId: string, err: unknown) => void,
  ) {}

  /**
   * La cle de cet espace, dechiffree, ou `null` s'il n'en a pas.
   *
   * ⚠️ `null` n'est PAS une erreur : un espace sans agent n'a pas de cle, et un espace d'avant ce lot non
   * plus. L'appelant retombe alors sur la cle maison, exactement comme un espace RCS sans cle propre.
   */
  async lire(tenantId: string): Promise<CleGatewayEspace | null> {
    const res = await this.pool.query<{ cle_id: string; cle_chiffree: string; plafond_micro_eur: string }>(
      'select cle_id, cle_chiffree, plafond_micro_eur from agent_gateway_keys where tenant_id = $1',
      [tenantId],
    );
    const row = res.rows[0];
    if (!row) return null;
    try {
      return {
        cleId: row.cle_id,
        cle: this.dechiffrer(row.cle_chiffree),
        plafondMicroEur: Number(row.plafond_micro_eur),
      };
    } catch (err) {
      // 🔴 Dechiffrement impossible (cle de chiffrement changee, ligne corrompue) : on rend `null`, donc on
      // retombe sur la cle maison, plutot que de faire echouer TOUS les tours d'agent de cet espace. La
      // depense cesse d'etre attribuee, ce qui est mauvais ; l'agent muet chez un client en production le
      // serait davantage.
      // ⚠️ MAIS ON LE DIT. Sans ce signalement, le repli etait indiscernable du cas normal « cet espace n'a
      // pas encore de cle », et un client aurait pu consommer des mois sur le pot commun sans que personne
      // ne s'en apercoive. La route de creation, elle, refuse plutot que de retomber : les deux chemins ne
      // peuvent pas avoir la meme reponse, l'un est une panne, l'autre un etat normal.
      this.signaler?.(tenantId, err);
      return null;
    }
  }

  /**
   * Enregistre la cle d'un espace. Le conflit est un SUCCES : il veut dire qu'une autre creation d'agent a
   * gagne la course, et la cle qu'elle a posee fait autorite.
   *
   * 🔴 REND CE QUI EST EN BASE APRES COUP, pas ce qu'on voulait ecrire. C'est ce qui rend le provisionnement
   * sur : le perdant de la course repart avec la cle du gagnant, au lieu de deux appels convaincus d'avoir
   * chacun la leur. ⚠️ C'est aussi ce qui permet a l'appelant de SAVOIR qu'il a perdu (identifiant rendu
   * different de celui qu'il a passe) et de supprimer chez Vercel la cle devenue inutile : sans cette
   * comparaison, elle facturerait sans que personne puisse s'en servir.
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
   * Oublie la cle d'un espace.
   *
   * ⚠️ N'appelle PAS Vercel : la revocation la-bas est le geste de l'appelant, et elle doit passer AVANT
   * celui-ci. Inverser l'ordre laisserait une cle qui facture et dont plus personne ne connait
   * l'identifiant, puisque c'est cette ligne qui le porte.
   */
  async oublier(tenantId: string): Promise<boolean> {
    const res = await this.pool.query('delete from agent_gateway_keys where tenant_id = $1', [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Note le plafond REELLEMENT pose chez Vercel, pour ne rappeler Vercel que quand il change. */
  async noterPlafond(tenantId: string, plafondMicroEur: number): Promise<void> {
    await this.pool.query(
      'update agent_gateway_keys set plafond_micro_eur = $2, updated_at = now() where tenant_id = $1',
      [tenantId, Math.max(0, Math.round(plafondMicroEur))],
    );
  }
}
