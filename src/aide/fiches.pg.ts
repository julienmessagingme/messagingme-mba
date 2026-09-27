import type { Pool } from 'pg';
import { CONFIG_RECHERCHE, PROXIMITE_TITRE_MIN, termesDeRecherche } from '../agent/knowledge';
import { texteAVectoriser, type DepotAVectoriser } from '../agent/recherche';
import type { DepotAide, FicheAide } from './fiches';

interface Ligne {
  id: string;
  cle: string;
  titre: string;
  corps: string;
  ecran: string | null;
  termes_trouves: number;
  termes_utiles: number;
  proximite_titre: number;
}

/**
 * Recherche dans `aide_fiches`, décalquée de `PgKnowledgeStore` (`src/agent/knowledge.pg.ts`) sans `tenant_id`
 * ni `agent_id`. Les primitives partagées sont importées (`termesDeRecherche`, `PROXIMITE_TITRE_MIN`,
 * `texteAVectoriser`) : deux découpages de requête finiraient par ne plus traiter les accents pareil.
 *
 * Ce que la requête mesure n'est pas un rang : `ts_rank_cd` rendait le seuil inerte, et un seul mot commun
 * suffisait à livrer une fiche. On mesure combien de termes signifiants de la question se retrouvent dans la
 * fiche, et sur combien.
 */
export class PgDepotAide implements DepotAide, DepotAVectoriser {
  constructor(private readonly pool: Pool) {}

  async chercher(requete: string, limite: number): Promise<FicheAide[]> {
    const termes = termesDeRecherche(requete);
    // Aucun terme exploitable : aucune requête. `to_tsquery` sur une chaîne vide lèverait.
    if (termes.length === 0) return [];
    const res = await this.pool.query<Ligne>(
      `with utiles as (
         select distinct plainto_tsquery('${CONFIG_RECHERCHE}'::regconfig, t) as tq
           from unnest($1::text[]) as t
          where numnode(plainto_tsquery('${CONFIG_RECHERCHE}'::regconfig, t)) > 0
       )
       select f.id, f.cle, f.titre, f.corps, f.ecran,
              (select count(*) from utiles u where f.corps_tsv @@ u.tq)::int as termes_trouves,
              (select count(*) from utiles)::int as termes_utiles,
              similarity(f.titre, $2) as proximite_titre
         from aide_fiches f
        where f.corps_tsv @@ to_tsquery('${CONFIG_RECHERCHE}'::regconfig, $3)
              -- L operateur % d abord, parce que LUI seul utilise l index trigramme sur le titre
              -- (aide_fiches_titre_trgm_idx) ; la comparaison explicite ensuite, pour que le seuil effectif
              -- vienne de NOTRE code et non du GUC pg_trgm.similarity_threshold, qui est un reglage serveur
              -- que le depot ne controle pas.
              or (f.titre % $2 and similarity(f.titre, $2) >= $4)
        order by termes_trouves desc, proximite_titre desc
        limit $5::int`,
      [termes, requete, termes.join(' | '), PROXIMITE_TITRE_MIN, Math.max(1, Math.floor(limite))],
    );
    return res.rows.map((r) => ({
      id: r.id,
      cle: r.cle,
      titre: r.titre,
      corps: r.corps,
      ecran: r.ecran,
      termesTrouves: r.termes_trouves,
      // Sans terme signifiant, la couverture n'a pas de sens : zéro, le repli qui ne laisse pas passer une fiche.
      couverture: r.termes_utiles > 0 ? r.termes_trouves / r.termes_utiles : 0,
      proximiteTitre: Number(r.proximite_titre ?? 0),
    }));
  }

  /**
   * Le rappel vectoriel. Il ne juge rien : il y a toujours une fiche « la moins loin », même pour une question
   * sans réponse ; le verdict vient du reclassement. Une fiche pas encore vectorisée reste trouvable par le
   * plein texte.
   */
  async chercherParVecteur(vecteur: number[], limite: number): Promise<FicheAide[]> {
    if (vecteur.length === 0) return [];
    const res = await this.pool.query<{ id: string; cle: string; titre: string; corps: string; ecran: string | null; similarite: string }>(
      `select id, cle, titre, corps, ecran, (1 - (embedding <=> $1::vector))::text as similarite
         from aide_fiches
        where embedding is not null
        order by embedding <=> $1::vector
        limit $2::int`,
      [`[${vecteur.join(',')}]`, Math.max(1, Math.floor(limite))],
    );
    return res.rows.map((r) => ({
      id: r.id,
      cle: r.cle,
      titre: r.titre,
      corps: r.corps,
      ecran: r.ecran,
      // Aucune mesure lexicale : la fiche n'a pas été trouvée par les mots, lui prêter une couverture ferait passer
      // la règle lexicale pour un verdict qu'elle n'a pas rendu.
      termesTrouves: 0,
      couverture: 0,
      proximiteTitre: 0,
      similarite: Number(r.similarite),
    }));
  }

  /**
   * Les fiches sans vecteur, ou dont le vecteur vient d'un autre modèle : un changement de modèle se fait au fil
   * de l'eau, les anciens vecteurs servant jusqu'à leur remplacement.
   */
  async fichesAVectoriser(modele: string, limite: number): Promise<Array<{ id: string; titre: string; corps: string }>> {
    const res = await this.pool.query<{ id: string; titre: string; corps: string }>(
      `select id, titre, corps
         from aide_fiches
        where embedding is null or embedding_modele is distinct from $1
        order by updated_at asc
        limit $2::int`,
      [modele, Math.max(1, Math.floor(limite))],
    );
    return res.rows;
  }

  /**
   * Écrit les vecteurs d'un lot. `texteAVectoriser` est importé : ce qu'on vectorise doit être identique des deux
   * côtés, sinon une même question ne tomberait pas au même endroit selon la base interrogée.
   */
  async ecrireVecteurs(modele: string, vecteurs: Array<{ id: string; vecteur: number[] }>): Promise<number> {
    if (vecteurs.length === 0) return 0;
    const res = await this.pool.query(
      `update aide_fiches f
          set embedding = v.vecteur::vector, embedding_modele = $1
         from (select unnest($2::uuid[]) as id, unnest($3::text[]) as vecteur) v
        where f.id = v.id`,
      [modele, vecteurs.map((v) => v.id), vecteurs.map((v) => `[${v.vecteur.join(',')}]`)],
    );
    return res.rowCount ?? 0;
  }
}

/** Réexporté pour que le chargeur et le balayage lisent la même définition de ce qui est vectorisé. */
export { texteAVectoriser };
