import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';

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

  /**
   * Ajuste le plafond de la clé d'un espace, SOUS LE VERROU DE SA LIGNE, et note ce qui a été posé chez Vercel.
   * `poser` reçoit la clé (son identifiant, le dernier plafond noté) et la CIBLE, et rend le plafond qu'il a posé
   * chez Vercel, ou `null` s'il n'a rien posé. Rend `true` si un plafond a été posé, `false` si l'espace n'a pas de
   * clé ou si rien n'a bougé. Une exception de `poser` annule tout et remonte : rien n'est noté.
   *
   * 🔴 LA CIBLE SE RECALCULE DEPUIS LE SOLDE, ELLE NE S'INCRÉMENTE PAS (relecture du 2026-09-29). Ajouter le montant
   * d'un achat au dernier plafond noté perdait des achats de deux façons : un achat arrivé pendant l'ouverture de la
   * clé (pas encore de ligne, donc rien à remonter, et la clé naissait au solde lu AVANT lui), et deux remontées
   * simultanées qui lisaient le même plafond (la seconde écrasait la première). La cible est le cumul de ce qui a été
   * crédité depuis l'ouverture de la clé, plafond initial compris : le solde d'aujourd'hui, plus tout ce qui en a été
   * débité depuis `created_at`. Une remontée tardive ou rejouée converge donc vers la même valeur.
   *
   * 🔴 SÉRIALISÉE PAR ESPACE, ENTRE TOUTES LES COPIES : `for update` sur la ligne de la clé, tenu jusqu'à la fin de la
   * transaction, donc pendant l'appel à Vercel. La cible se calcule dans une SECONDE instruction, après le verrou :
   * en lecture validée, elle voit alors tout ce que la remontée précédente a vu, et le plafond qu'elle a noté. Le
   * verrou ne gêne pas le chemin chaud : les tours d'agent LISENT la clé (`lireEtat`), sans verrou. Il retient une
   * connexion du pool le temps de l'appel à Vercel (30 s au pire), sur un geste rare : un achat, une offre, une
   * recharge, l'ouverture d'une clé.
   */
  async ajusterPlafond(
    tenantId: string,
    poser: (cle: { cleId: string; plafondMicroEur: number }, cibleMicroEur: number) => Promise<number | null>,
  ): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      const lu = await client.query<{ cle_id: string; plafond_micro_eur: string }>(
        'select cle_id, plafond_micro_eur from agent_gateway_keys where tenant_id = $1 for update',
        [tenantId],
      );
      const row = lu.rows[0];
      if (!row) return false;
      const calcul = await client.query<{ cible: string | null }>(
        `select coalesce((select solde_micro_eur from agent_credits where tenant_id = $1), 0)
              - coalesce((select sum(m.delta_micro_eur)
                            from agent_credit_mouvements m
                            join agent_gateway_keys k on k.tenant_id = m.tenant_id
                           where m.tenant_id = $1 and m.delta_micro_eur < 0 and m.at >= k.created_at), 0) as cible`,
        [tenantId],
      );
      const cible = Number(calcul.rows[0]?.cible ?? 0);
      const pose = await poser({ cleId: row.cle_id, plafondMicroEur: Number(row.plafond_micro_eur) }, cible);
      if (pose === null) return false;
      await client.query(
        'update agent_gateway_keys set plafond_micro_eur = $2, updated_at = now() where tenant_id = $1',
        [tenantId, Math.max(0, Math.round(pose))],
      );
      return true;
    });
  }
}
