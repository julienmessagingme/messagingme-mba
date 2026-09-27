import { ficheEstPertinente, type FicheTrouvee, type KnowledgeStore } from '../knowledge';
import { SORTIE_SANS_SOURCE } from '../sorties';
import { messageDe } from '../../lib/erreur';

/**
 * La recherche de connaissance d'un agent, en un seul endroit, pour la production et le bac à sable : aucune
 * fiche pertinente rend `aucune_source` et une sortie imposée, et le bac à sable n'a de valeur que s'il rend
 * exactement ce que la production rendrait. Le message d'une requête vide reste chez chaque appelant.
 */

/** Nombre de fiches rendues au modèle. Au-delà, on paie du contexte à chaque tour pour des sources que le
 *  modèle n'utilisera pas. */
export const FICHES_RENDUES = 3;

/**
 * Bornes de ce qui repart au modèle, fiche par fiche. Le tronc commun borne déjà la réponse entière, mais
 * remplace alors toute la structure par un aperçu : trois fiches entières rendraient une source mutilée.
 */
export const CORPS_MAX = 2_000;

/** La requête vient du modèle, qui peut recopier un message que le contact contrôle. `similarity()` génère
 *  les trigrammes de cette chaîne pour chaque ligne candidate : une requête de plusieurs kilo-octets se
 *  paierait en base. */
export const REQUETE_MAX = 512;

/** Ce que la recherche rend au tronc commun : soit l'aveu d'absence avec sa sortie, soit les sources. */
export type ResultatConnaissance =
  | { contenu: { aucune_source: true }; sortie: string }
  | { contenu: { sources: Array<{ titre: string; contenu: string; url: string | null }> } };

/**
 * Cherche, filtre sur la pertinence, borne, et rend le verdict. Le modèle ne voit aucune mesure : un score
 * montré lui rendrait la décision qu'on lui retire.
 */
export async function chercherConnaissance(
  connaissance: KnowledgeStore,
  ctx: { tenantId: string; agentId: string },
  requeteBrute: string,
  recherche?: RechercheSemantique,
): Promise<ResultatConnaissance> {
  const requete = requeteBrute.slice(0, REQUETE_MAX);
  /**
   * Rappel puis verdict. Sans `recherche`, ou si le Gateway échoue, le plein texte remonte trois fiches et la
   * règle lexicale tranche.
   */
  const semantique = recherche ? await rappelSemantique(connaissance, ctx, requete, recherche) : null;
  const large = semantique !== null;
  const lexicales = await connaissance.chercher(ctx.tenantId, ctx.agentId, requete, large ? recherche!.candidats : FICHES_RENDUES);
  const candidates = semantique === null ? lexicales : fusionner(lexicales, semantique);

  const retenues = semantique === null
    ? candidates.filter(ficheEstPertinente)
    : await verdictReranker(candidates, requete, recherche!);
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

/**
 * La recherche sémantique telle que le résolveur en a besoin. Deux modèles, pourquoi :
 * `src/agent/llm/recherche-client.ts`.
 */
export interface RechercheSemantique {
  vectoriser(textes: string[]): Promise<number[][]>;
  reclasser(question: string, fiches: Array<{ texte: string }>): Promise<number[]>;
  /** Combien de candidats le rappel remonte avant le verdict. Plus large que les 3 rendues au modèle. */
  candidats: number;
  /** Le seuil du reranker, mesuré et re-mesurable : cf. `AGENT_RERANK_SEUIL`. */
  seuil: number;
}

/**
 * Le rappel vectoriel. Rend `null` dès que quoi que ce soit manque ou échoue : le plein texte cherche
 * toujours, et la règle lexicale reprend son rôle de juge. L'agent est moins bon, jamais menteur.
 */
async function rappelSemantique(
  connaissance: KnowledgeStore,
  ctx: { tenantId: string; agentId: string },
  requete: string,
  recherche: RechercheSemantique,
): Promise<FicheTrouvee[] | null> {
  if (!connaissance.chercherParVecteur) return null;
  try {
    const [vecteur] = await recherche.vectoriser([requete]);
    if (!vecteur || vecteur.length === 0) return null;
    return await connaissance.chercherParVecteur(ctx.tenantId, ctx.agentId, vecteur, recherche.candidats);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('connaissance: rappel vectoriel indisponible, repli sur le plein texte:', messageDe(err));
    return null;
  }
}

/**
 * Fusionne les deux rappels par identifiant, en gardant la meilleure mesure de chaque famille : une fiche
 * présentée deux fois au reranker coûterait double et pourrait occuper deux des trois places.
 */
function fusionner(lexicales: FicheTrouvee[], semantiques: FicheTrouvee[]): FicheTrouvee[] {
  const par = new Map<string, FicheTrouvee>();
  for (const f of [...lexicales, ...semantiques]) {
    const deja = par.get(f.id);
    if (!deja) { par.set(f.id, f); continue; }
    par.set(f.id, {
      ...deja,
      termesTrouves: Math.max(deja.termesTrouves, f.termesTrouves),
      couverture: Math.max(deja.couverture, f.couverture),
      proximiteTitre: Math.max(deja.proximiteTitre, f.proximiteTitre),
      ...(f.similarite !== undefined || deja.similarite !== undefined
        ? { similarite: Math.max(deja.similarite ?? 0, f.similarite ?? 0) }
        : {}),
    });
  }
  return [...par.values()];
}

/**
 * Le verdict, qui porte la garde anti-hallucination une fois le vectoriel branché : la similarité ne peut pas
 * décider (hors sujet et vraies questions se chevauchent), le reranker, calibré, le peut.
 *
 * En cas d'échec du reranker, retour à la règle lexicale, jamais « on laisse passer » : une fiche venue du
 * seul rappel vectoriel a une couverture nulle et est écartée. On perd le gain, pas la garde.
 */
async function verdictReranker(
  candidates: FicheTrouvee[],
  requete: string,
  recherche: RechercheSemantique,
): Promise<FicheTrouvee[]> {
  if (candidates.length === 0) return [];
  let scores: number[];
  try {
    scores = await recherche.reclasser(requete, candidates.map((f) => ({ texte: `${f.titre}\n${f.corps}` })));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('connaissance: reranker indisponible, repli sur la regle lexicale:', messageDe(err));
    return candidates.filter(ficheEstPertinente).slice(0, FICHES_RENDUES);
  }
  return candidates
    .map((f, i) => ({ f, score: scores[i] ?? 0 }))
    .filter((x) => x.score >= recherche.seuil)
    .sort((a, b) => b.score - a.score)
    .slice(0, FICHES_RENDUES)
    .map((x) => x.f);
}
