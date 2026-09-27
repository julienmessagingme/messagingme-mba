import { config } from '../config';
import { GatewayRechercheClient } from './llm/recherche-client';
import type { RechercheSemantique } from './resolvers/connaissance';

/**
 * La fabrique unique de la recherche sémantique, pour le worker (l'agent), l'API (le bac à sable) et le
 * balayage qui vectorise : un bac à sable qui ne jugerait pas comme la production ne prouverait rien.
 *
 * `null` quand la clé du Gateway ou le modèle manquent : la recherche retombe alors sur le plein texte et la
 * règle lexicale.
 */
export function creerRechercheSemantique(): RechercheSemantique | null {
  if (config.AI_GATEWAY_API_KEY === '' || config.AGENT_EMBED_MODEL === '') return null;
  const client = new GatewayRechercheClient(
    config.AI_GATEWAY_API_KEY,
    config.AGENT_EMBED_MODEL,
    config.AGENT_RERANK_MODEL,
  );
  return {
    vectoriser: (textes) => client.vectoriser(textes),
    reclasser: (question, fiches) => client.reclasser(question, fiches),
    candidats: config.AGENT_RAPPEL_CANDIDATS,
    seuil: config.AGENT_RERANK_SEUIL,
  };
}

/** Ce que le balayage a besoin de savoir du dépôt de fiches. Volontairement étroit. */
export interface DepotAVectoriser {
  fichesAVectoriser(modele: string, limite: number): Promise<Array<{ id: string; titre: string; corps: string }>>;
  ecrireVecteurs(modele: string, vecteurs: Array<{ id: string; vecteur: number[] }>): Promise<number>;
}

/**
 * Taille d'un lot. Un seul appel au Gateway par passage : vectoriser cinquante fiches une par une ferait
 * cinquante allers-retours pour le même résultat. Assez petit pour qu'un échec ne coûte qu'un lot.
 */
export const LOT_VECTORISATION = 50;

/** Ce qu'on donne à vectoriser : le titre et le corps. Un titre seul ne dit pas ce que la fiche contient. */
export const texteAVectoriser = (f: { titre: string; corps: string }): string => `${f.titre}\n${f.corps}`.slice(0, 8_000);

/**
 * Le balayage qui vectorise, seul endroit du dépôt qui calcule un vecteur de fiche.
 *
 * Plutôt qu'à l'écriture : les chemins d'écriture sont plusieurs (et un nouveau est couvert sans y penser),
 * une panne du Gateway n'empêche pas d'enregistrer une fiche, et un changement de modèle se rattrape comme
 * une fiche « pas encore vectorisée ». Le prix : une fiche toute neuve n'est trouvable que par les mots
 * jusqu'au passage suivant.
 */
export async function balayerVectorisation(
  depot: DepotAVectoriser,
  recherche: Pick<RechercheSemantique, 'vectoriser'>,
  modele: string,
  limite = LOT_VECTORISATION,
): Promise<number> {
  const fiches = await depot.fichesAVectoriser(modele, limite);
  if (fiches.length === 0) return 0;
  const vecteurs = await recherche.vectoriser(fiches.map(texteAVectoriser));
  // Une réponse incomplète n'écrit rien : apparier par position ferait porter à une fiche le vecteur d'une
  // autre, sans aucune erreur.
  if (vecteurs.length !== fiches.length) {
    throw new Error(`vectorisation: ${vecteurs.length} vecteurs pour ${fiches.length} fiches, rien écrit`);
  }
  return depot.ecrireVecteurs(modele, fiches.map((f, i) => ({ id: f.id, vecteur: vecteurs[i]! })));
}
