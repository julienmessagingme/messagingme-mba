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
 * Recherche dans `aide_fiches` (migration 0131).
 *
 * 🔴 DÉCALQUE DÉLIBÉRÉ de `PgKnowledgeStore` (`src/agent/knowledge.pg.ts`), à `tenant_id` et `agent_id`
 * près. Les primitives partagées sont IMPORTÉES et non recopiées (`termesDeRecherche`,
 * `PROXIMITE_TITRE_MIN`, `texteAVectoriser`) : ce sont les points de passage obligés du dépôt, et les
 * recopier ferait deux découpages de requête qui finiraient par ne plus traiter les accents pareil.
 *
 * ⚠️ CE QUE CETTE REQUÊTE MESURE N'EST PAS UN RANG, et c'est la leçon payée sur la connaissance des agents :
 * classer par `ts_rank_cd` rendait le seuil INERTE (la fonction a un plancher arithmétique, l'opérateur `%`
 * un autre), si bien que le filtre réel était le `where`, un OU sur les termes, et qu'UN SEUL mot commun
 * suffisait à livrer une fiche au modèle. On mesure donc combien de termes signifiants de la question se
 * retrouvent dans la fiche, et sur combien : « ai-je une source pour CETTE question » plutôt que « à quel
 * point ça ressort ».
 */
export class PgDepotAide implements DepotAide, DepotAVectoriser {
  constructor(private readonly pool: Pool) {}

  async chercher(requete: string, limite: number): Promise<FicheAide[]> {
    const termes = termesDeRecherche(requete);
    // Aucun terme exploitable (question vide, ponctuation seule) : on ne lance AUCUNE requête. `to_tsquery`
    // sur une chaîne vide lèverait, et il n'y a de toute façon rien à chercher.
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
      // Aucun terme signifiant (la question n'était faite que de mots vides) : la couverture n'a pas de
      // sens, et zéro est le repli sûr, celui qui ne laisse pas passer une fiche.
      couverture: r.termes_utiles > 0 ? r.termes_trouves / r.termes_utiles : 0,
      proximiteTitre: Number(r.proximite_titre ?? 0),
    }));
  }

  /**
   * LE RAPPEL VECTORIEL. Les fiches les plus proches du vecteur de la question.
   *
   * 🔴 Elle ne juge RIEN : il y a TOUJOURS une fiche « la moins loin », y compris pour une question sans
   * réponse dans la base. Le verdict est rendu après, par le reclassement.
   *
   * `embedding is not null` n'est pas une précaution : une fiche chargée il y a dix secondes, en attente du
   * balayage, reste trouvable par le plein texte. Elle n'a simplement pas encore sa seconde porte d'entrée.
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
      // Aucune mesure LEXICALE ici, et zéro est la valeur juste : cette fiche n'a pas été trouvée par les
      // mots. Lui prêter une couverture inventée ferait passer la règle lexicale pour un verdict qu'elle
      // n'a pas rendu.
      termesTrouves: 0,
      couverture: 0,
      proximiteTitre: 0,
      similarite: Number(r.similarite),
    }));
  }

  /**
   * Les fiches sans vecteur, ou dont le vecteur vient d'un AUTRE modèle.
   *
   * ⚠️ Le second cas rend un changement de modèle progressif au lieu d'aveuglant : on ne vide pas la colonne
   * d'un coup, le balayage remplace les vecteurs périmés au fil de l'eau pendant que les anciens servent.
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
   * Écrit les vecteurs d'un lot.
   *
   * ⚠️ `texteAVectoriser` est importé et non recopié : ce qu'on vectorise (titre ET corps, borné) doit être
   * IDENTIQUE des deux côtés, sinon une même question ne tomberait pas au même endroit selon la base
   * interrogée, et personne ne saurait pourquoi.
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
