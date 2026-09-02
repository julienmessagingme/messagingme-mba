import { config } from '../config';
import { GatewayRechercheClient } from './llm/recherche-client';
import type { RechercheSemantique } from './resolvers/connaissance';

/**
 * LA FABRIQUE UNIQUE de la recherche sémantique (chantier vectorisation, 2026-09-02).
 *
 * 🔴 Pourquoi une fabrique et pas deux constructions. Trois endroits en ont besoin : le worker (l'agent en
 * production), l'API (le bac à sable) et le balayage qui vectorise. Trois constructions, ce sont trois
 * occasions de câbler un modèle différent, un seuil différent, ou d'en oublier une. Et un bac à sable qui ne
 * jugerait pas comme la production ne prouverait rien, ce qui est précisément le défaut que le partage de
 * `chercherConnaissance` avait déjà corrigé une fois.
 *
 * `null` quand la clé du Gateway ou le modèle manquent : tous les appelants savent s'en passer, et la
 * recherche retombe alors sur le plein texte et la règle lexicale, c'est-à-dire le comportement d'avant.
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

/** Ce qu'on donne à vectoriser : le titre ET le corps. Un titre seul ne dit pas ce que la fiche contient. */
export const texteAVectoriser = (f: { titre: string; corps: string }): string => `${f.titre}\n${f.corps}`.slice(0, 8_000);

/**
 * LE BALAYAGE QUI VECTORISE, et c'est le SEUL endroit du dépôt qui calcule un vecteur de fiche.
 *
 * 🔴 Pourquoi le faire ici plutôt qu'à l'écriture d'une fiche, alors que ce serait plus immédiat. Trois
 * raisons, et la première est celle qui a décidé :
 *
 *  1. **Il y a TROIS chemins d'écriture** (création à la main, import d'un document, remplacement d'une
 *     source), donc trois occasions d'oublier. Le dépôt a payé ce prix le 2026-09-02 avec le 131008 : une
 *     dépendance câblée d'un côté, oubliée de l'autre, et une fonctionnalité qui disparaît en silence. Ici,
 *     un quatrième chemin d'écriture est vectorisé sans que personne y pense.
 *  2. **Une panne du Gateway ne doit pas empêcher d'enregistrer une fiche.** Un enrichissement ne casse pas
 *     ce qu'il enrichit. La fiche existe et reste trouvable par le plein texte à la seconde ; son vecteur
 *     arrive au passage suivant.
 *  3. **Le rattrapage est gratuit** : les fiches déjà en base, et celles dont le modèle a changé, sont
 *     exactement le même cas que « pas encore vectorisée ». Aucun code de migration à écrire.
 *
 * Le prix, et il est assumé : une fiche créée il y a dix secondes n'est pas encore trouvable par le sens.
 * Elle l'est par les mots, ce qui est le comportement d'aujourd'hui.
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
  // ⚠️ Une réponse incomplète n'écrit RIEN. Écrire ce qu'on a en appariant par position ferait porter à une
  // fiche le vecteur d'une autre, et ce serait indétectable : la recherche deviendrait absurde sans erreur.
  if (vecteurs.length !== fiches.length) {
    throw new Error(`vectorisation: ${vecteurs.length} vecteurs pour ${fiches.length} fiches, rien écrit`);
  }
  return depot.ecrireVecteurs(modele, fiches.map((f, i) => ({ id: f.id, vecteur: vecteurs[i]! })));
}
