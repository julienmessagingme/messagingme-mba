import type { Pool } from 'pg';
import type { LiaisonPage } from '../meta/pubs';

/**
 * LA CONNEXION PUBLICITAIRE D'UN ESPACE (`pub_connexion`, migration 0167).
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE, sans exception. La connexion au pooler est un rôle superuser,
 * donc la RLS est contournée : ce filtrage EST le contrôle d'isolation, pas une ceinture en plus.
 *
 * 🔴 LE JETON N'EST JAMAIS LU PAR CE DÉPÔT EN CLAIR. Il entre chiffré (`chiffre`) et sort chiffré
 * (`lireJetonChiffre`), le déchiffrement appartenant au câblage. Un dépôt qui déchiffrerait mettrait la
 * clé à portée de chaque appelant, et un jeton en clair finirait un jour dans un journal.
 */
export interface ConnexionPub {
  comptePubId: string | null;
  /** Le nom vu chez Meta AU MOMENT DU CHOIX (0169). Libellé d'affichage, jamais une clé. */
  compteNom: string | null;
  pageId: string | null;
  pageNom: string | null;
  devise: string | null;
  fuseau: string | null;
  pageLiee: LiaisonPage | null;
  connectePar: string | null;
  connecteLe: Date;
  jetonRejeteLe: Date | null;
}

export class PgPubConnexionStore {
  constructor(private readonly pool: Pool) {}

  /** L'état de la connexion, sans le jeton. C'est ce que l'écran affiche. */
  async lire(tenantId: string): Promise<ConnexionPub | null> {
    const { rows } = await this.pool.query<{
      compte_pub_id: string | null; compte_nom: string | null; page_id: string | null; page_nom: string | null;
      devise: string | null; fuseau: string | null;
      page_liee: string | null; connecte_par: string | null; connecte_le: Date; jeton_rejete_le: Date | null;
    }>(
      `select compte_pub_id, compte_nom, page_id, page_nom, devise, fuseau, page_liee, connecte_par,
              connecte_le, jeton_rejete_le
         from pub_connexion where tenant_id = $1`,
      [tenantId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      comptePubId: r.compte_pub_id,
      compteNom: r.compte_nom,
      pageId: r.page_id,
      pageNom: r.page_nom,
      devise: r.devise,
      fuseau: r.fuseau,
      pageLiee: estLiaison(r.page_liee) ? r.page_liee : null,
      connectePar: r.connecte_par,
      connecteLe: r.connecte_le,
      jetonRejeteLe: r.jeton_rejete_le,
    };
  }

  /** Le jeton chiffré, pour le câblage seul. Rend null quand l'espace n'est pas connecté. */
  async lireJetonChiffre(tenantId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ jeton_chiffre: string }>(
      'select jeton_chiffre from pub_connexion where tenant_id = $1',
      [tenantId],
    );
    return rows[0]?.jeton_chiffre ?? null;
  }

  /**
   * Pose le jeton fraîchement échangé. Rend `false` quand une connexion EXISTE DÉJÀ, sans rien écraser.
   *
   * 🔴 L'INVARIANT EST TENU PAR LA BASE, PAS PAR L'ÉCRAN NI PAR UN CONTRÔLE PRÉALABLE. Cette méthode
   * faisait un `do update set jeton_chiffre`, et un second jeton écrasait le premier : l'ancien, SANS
   * EXPIRATION, restait vivant chez Meta alors que nous venions d'en perdre le seul exemplaire. C'est le
   * piège de la clé Vercel (0124), et il s'était déplacé deux fois avant d'arriver ici : d'abord non vu, puis
   * confié à un enchaînement de l'écran qui ne s'arrêtait pas en cas d'échec (relecture du 2026-09-23).
   *
   * ⚠️ `on conflict do nothing` et pas un `select` préalable : entre la lecture et l'écriture, deux
   * connexions simultanées passeraient toutes les deux. Ici la seconde repart avec `false`, toujours.
   *
   * Pour reconnecter, il faut donc PASSER PAR LA DÉCONNEXION, qui révoque avant d'effacer.
   */
  async poserJeton(tenantId: string, jetonChiffre: string, parUserId: string | null): Promise<boolean> {
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      `insert into pub_connexion (tenant_id, jeton_chiffre, connecte_par, connecte_le)
       values ($1, $2, $3, now())
       on conflict (tenant_id) do nothing
       returning tenant_id`,
      [tenantId, jetonChiffre, parUserId],
    );
    return rows.length === 1;
  }

  /** Enregistre le compte et la Page choisis, avec ce que Meta a dit d'eux. */
  async choisirActifs(
    tenantId: string,
    choix: {
      comptePubId: string; compteNom: string | null; pageId: string; pageNom: string | null;
      devise: string | null; fuseau: string | null; pageLiee: LiaisonPage;
    },
  ): Promise<void> {
    await this.pool.query(
      `update pub_connexion set compte_pub_id = $2, compte_nom = $3, page_id = $4, page_nom = $5,
              devise = $6, fuseau = $7, page_liee = $8
         where tenant_id = $1`,
      [tenantId, choix.comptePubId, choix.compteNom, choix.pageId, choix.pageNom, choix.devise, choix.fuseau, choix.pageLiee],
    );
  }

  /**
   * REMPLACE la connexion d'un espace EN UNE SEULE TRANSACTION : efface, repose, rechoisit.
   *
   * 🔴 POURQUOI UNE TRANSACTION, ET PAS TROIS APPELS À LA SUITE. C'est le geste de `/ops`, le seul
   * chemin qui remplace au lieu de refuser. En trois appels, un échec APRÈS le `delete` laisse l'espace
   * SANS connexion, avec l'ancien jeton déjà perdu et le neuf jamais rangé : l'appelant reçoit une
   * erreur qui ressemble à « rien ne s'est passé » alors que tout a été détruit. Ici, un échec ne
   * laisse rien derrière lui.
   *
   * ⚠️ L'INSERT N'A PAS DE `on conflict` : la ligne vient d'être effacée dans la MÊME transaction, donc
   * un conflit signifierait qu'une autre connexion s'est faufilée entre les deux, ce que la clé
   * primaire empêche. Le `do nothing` de `poserJeton` protège un cas différent (deux connexions par
   * l'écran), et le recopier ici masquerait l'anomalie au lieu de la rendre.
   */
  async remplacer(
    tenantId: string,
    jetonChiffre: string,
    choix: {
      comptePubId: string; compteNom: string | null; pageId: string; pageNom: string | null;
      devise: string | null; fuseau: string | null; pageLiee: LiaisonPage;
    },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from pub_connexion where tenant_id = $1', [tenantId]);
      await client.query(
        `insert into pub_connexion (tenant_id, jeton_chiffre, compte_pub_id, compte_nom, page_id, page_nom,
                                    devise, fuseau, page_liee, connecte_par, connecte_le)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, now())`,
        [tenantId, jetonChiffre, choix.comptePubId, choix.compteNom, choix.pageId, choix.pageNom,
         choix.devise, choix.fuseau, choix.pageLiee],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Meta a refusé ce jeton. On garde la ligne, avec sa date : l'écran doit pouvoir dire « reconnectez-vous »
   * plutôt que d'afficher un espace non connecté, qui laisserait croire que personne n'a jamais rien fait.
   */
  async marquerJetonRejete(tenantId: string): Promise<void> {
    await this.pool.query(
      'update pub_connexion set jeton_rejete_le = now() where tenant_id = $1 and jeton_rejete_le is null',
      [tenantId],
    );
  }

  async supprimer(tenantId: string): Promise<void> {
    await this.pool.query('delete from pub_connexion where tenant_id = $1', [tenantId]);
  }
}

function estLiaison(v: string | null): v is LiaisonPage {
  return v === 'oui' || v === 'non' || v === 'inconnu';
}
