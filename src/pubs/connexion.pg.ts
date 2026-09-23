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
  pageId: string | null;
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
      compte_pub_id: string | null; page_id: string | null; devise: string | null; fuseau: string | null;
      page_liee: string | null; connecte_par: string | null; connecte_le: Date; jeton_rejete_le: Date | null;
    }>(
      `select compte_pub_id, page_id, devise, fuseau, page_liee, connecte_par, connecte_le, jeton_rejete_le
       from pub_connexion where tenant_id = $1`,
      [tenantId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      comptePubId: r.compte_pub_id,
      pageId: r.page_id,
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
   * Pose le jeton fraîchement échangé, AVANT tout choix d'actifs.
   *
   * 🔴 IDEMPOTENT PAR LA CLÉ PRIMAIRE, et c'est ce qui rend deux connexions simultanées inoffensives. Une
   * reconnexion REMET À ZÉRO le choix et le rejet : le jeton neuf n'accorde pas forcément les mêmes actifs
   * que l'ancien, donc garder l'ancien compte reviendrait à afficher un compte auquel on n'a plus accès.
   */
  async poserJeton(tenantId: string, jetonChiffre: string, parUserId: string | null): Promise<void> {
    await this.pool.query(
      `insert into pub_connexion (tenant_id, jeton_chiffre, connecte_par, connecte_le)
       values ($1, $2, $3, now())
       on conflict (tenant_id) do update set
         jeton_chiffre = excluded.jeton_chiffre,
         connecte_par = excluded.connecte_par,
         connecte_le = now(),
         compte_pub_id = null, page_id = null, devise = null, fuseau = null, page_liee = null,
         jeton_rejete_le = null`,
      [tenantId, jetonChiffre, parUserId],
    );
  }

  /** Enregistre le compte et la Page choisis, avec ce que Meta a dit d'eux. */
  async choisirActifs(
    tenantId: string,
    choix: { comptePubId: string; pageId: string; devise: string | null; fuseau: string | null; pageLiee: LiaisonPage },
  ): Promise<void> {
    await this.pool.query(
      `update pub_connexion set compte_pub_id = $2, page_id = $3, devise = $4, fuseau = $5, page_liee = $6
       where tenant_id = $1`,
      [tenantId, choix.comptePubId, choix.pageId, choix.devise, choix.fuseau, choix.pageLiee],
    );
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
