import { ficheEstPertinente, type FicheTrouvee, type KnowledgeStore } from '../knowledge';
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
  recherche?: RechercheSemantique,
): Promise<ResultatConnaissance> {
  const requete = requeteBrute.slice(0, REQUETE_MAX);
  /**
   * RAPPEL puis VERDICT. Sans `recherche` câblée, les deux se confondent dans le comportement d'avant : le
   * plein texte remonte trois fiches et la règle lexicale tranche. C'est ce qui rend la migration 0110 non
   * bloquante, et c'est aussi le repli quand un appel au Gateway échoue.
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
 * LA RECHERCHE SÉMANTIQUE, telle que le résolveur en a besoin (chantier vectorisation, 2026-09-02).
 *
 * Deux modèles, et il en faut DEUX : cf. `src/agent/llm/recherche-client.ts` pour la raison, mesurée.
 */
export interface RechercheSemantique {
  vectoriser(textes: string[]): Promise<number[][]>;
  reclasser(question: string, fiches: Array<{ texte: string }>): Promise<number[]>;
  /** Combien de candidats le rappel remonte AVANT le verdict. Plus large que les 3 rendues au modèle. */
  candidats: number;
  /** Le seuil du reranker. Mesuré, pas deviné, et re-mesurable : cf. `AGENT_RERANK_SEUIL`. */
  seuil: number;
}

/**
 * Le RAPPEL vectoriel. Rend `null` dès que quoi que ce soit manque ou échoue, ce qui fait retomber tout le
 * chemin sur le comportement d'avant.
 *
 * 🔴 Un échec ici ne doit JAMAIS priver le client de sa base de connaissance : sans le Gateway, le plein
 * texte cherche toujours. C'est la même doctrine que partout ce soir, un enrichissement ne casse pas ce qu'il
 * enrichit. Et c'est le repli SÛR : il rend l'agent moins bon, jamais menteur, puisque la règle lexicale
 * reprend alors son rôle de juge.
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
    console.error('connaissance: rappel vectoriel indisponible, repli sur le plein texte:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Fusionne les deux rappels PAR IDENTIFIANT, en gardant la meilleure mesure de chaque famille.
 *
 * Une fiche trouvée par les deux chemins ne doit apparaître qu'une fois : la présenter deux fois au reranker
 * la ferait payer double et pourrait occuper deux des trois places rendues au modèle.
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
 * 🔴 LE VERDICT, ET C'EST LUI QUI PORTE LA GARDE ANTI-HALLUCINATION une fois le vectoriel branché.
 *
 * Pourquoi ce n'est pas la similarité qui décide : mesuré le 2026-09-02, une question HORS SUJET remonte une
 * fiche à 0,361 quand une vraie question descend à 0,299. Les deux populations se chevauchent, donc aucun
 * seuil n'est posable sur un cosinus. Le reranker, lui, place les vraies questions au-dessus de 0,0817 et le
 * hors-sujet en dessous de 0,0409.
 *
 * ⚠️ En cas d'échec du reranker, on RETOMBE SUR LA RÈGLE LEXICALE, jamais sur « on laisse passer ». Une fiche
 * venue du seul rappel vectoriel a une couverture de zéro : elle est donc écartée par ce repli, ce qui est
 * exactement le bon sens de la dégradation. On perd le gain, on ne perd pas la garde.
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
    console.error('connaissance: reranker indisponible, repli sur la regle lexicale:', err instanceof Error ? err.message : err);
    return candidates.filter(ficheEstPertinente).slice(0, FICHES_RENDUES);
  }
  return candidates
    .map((f, i) => ({ f, score: scores[i] ?? 0 }))
    .filter((x) => x.score >= recherche.seuil)
    .sort((a, b) => b.score - a.score)
    .slice(0, FICHES_RENDUES)
    .map((x) => x.f);
}
