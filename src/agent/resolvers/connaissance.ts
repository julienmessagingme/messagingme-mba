import { ficheEstPertinente, type KnowledgeStore } from '../knowledge';
import { SORTIE_SANS_SOURCE } from '../sorties';

/**
 * LA recherche de connaissance d'un agent, en un seul endroit (lot 1 du programme, 2026-08-31).
 *
 * 🔴 Pourquoi ça ne se recopie pas. C'est le garde-fou ANTI-HALLUCINATION : aucune fiche pertinente rend
 * `aucune_source` et une SORTIE imposée, ce qui empêche le modèle de répondre de mémoire. Cette règle vivait
 * en double, à l'identique, dans le résolveur de production et dans celui du bac à sable, alors que le bac à
 * sable n'a de valeur que s'il rend EXACTEMENT ce que la production rendrait. Leurs deux copies avaient déjà
 * commencé à diverger sur la forme de l'erreur.
 *
 * Ce qui reste chez l'appelant, et c'est voulu : le message d'erreur d'une requête vide. Les deux surfaces ne
 * l'expriment pas dans la même forme (l'une a un `echec()`, l'autre un objet `{ ok: false }`), et ce n'est pas
 * une règle métier. Seul ce qui doit être IDENTIQUE est partagé.
 */

/** Nombre de fiches rendues au modèle. Au-delà, on paie du contexte à chaque tour pour des sources que le
 *  modèle n'utilisera pas. */
export const FICHES_RENDUES = 3;

/**
 * Bornes de ce qui repart au modèle. Le tronc commun borne DÉJÀ la réponse entière à `max_bytes`, mais sa
 * troncature remplace toute la structure par un aperçu : trois fiches entières la déclencheraient, et le
 * modèle recevrait une source mutilée au lieu de sources listées. Le pire des deux mondes pour un mécanisme
 * anti-hallucination, donc on borne fiche par fiche, en le disant.
 */
export const CORPS_MAX = 2_000;

/** La requête vient du modèle, qui peut recopier un message que le contact contrôle. `similarity()` génère
 *  les trigrammes de cette chaîne pour chaque ligne candidate : une requête de plusieurs kilo-octets se
 *  paierait en base. */
export const REQUETE_MAX = 512;

/** Ce que la recherche rend au tronc commun : soit l'aveu d'absence AVEC sa sortie, soit les sources. */
export type ResultatConnaissance =
  | { contenu: { aucune_source: true }; sortie: string }
  | { contenu: { sources: Array<{ titre: string; contenu: string; url: string | null }> } };

/**
 * Cherche, filtre sur la pertinence, borne, et rend le verdict.
 *
 * Les MESURES viennent de la base, la RÈGLE est appliquée ici (`ficheEstPertinente`), et le modèle ne voit ni
 * l'une ni les autres : lui montrer un score reviendrait à lui rendre la décision qu'on lui retire.
 */
export async function chercherConnaissance(
  connaissance: KnowledgeStore,
  ctx: { tenantId: string; agentId: string },
  requeteBrute: string,
): Promise<ResultatConnaissance> {
  const requete = requeteBrute.slice(0, REQUETE_MAX);
  const fiches = await connaissance.chercher(ctx.tenantId, ctx.agentId, requete, FICHES_RENDUES);
  const retenues = fiches.filter(ficheEstPertinente);
  if (retenues.length === 0) return { contenu: { aucune_source: true }, sortie: SORTIE_SANS_SOURCE };
  return {
    contenu: {
      sources: retenues.map((f) => ({
        titre: f.titre,
        contenu: f.corps.length > CORPS_MAX ? `${f.corps.slice(0, CORPS_MAX)}...` : f.corps,
        url: f.sourceUrl,
      })),
    },
  };
}
