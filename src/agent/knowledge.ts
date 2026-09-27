/**
 * La base de connaissance d'un agent : le contrat de recherche, et le découpage des termes.
 *
 * Le mécanisme anti-hallucination : le store ne rend que des mesures, jamais un verdict ; la règle est
 * `ficheEstPertinente`, plus bas.
 */

export interface FicheTrouvee {
  id: string;
  titre: string;
  corps: string;
  sourceUrl: string | null;
  /** Combien de termes signifiants de la requête se retrouvent dans la fiche. Un compte, pas un rang. */
  termesTrouves: number;
  /** `termesTrouves` rapporté au nombre de termes signifiants de la requête. Dans [0, 1]. */
  couverture: number;
  /** Proximité trigramme du titre avec la requête brute, dans [0, 1]. Rattrape la faute de frappe. */
  proximiteTitre: number;
  /**
   * Similarité cosinus au vecteur de la question, dans [0, 1]. `undefined` = fiche non venue du rappel
   * vectoriel. Ce n'est pas une mesure de pertinence (hors sujet et vraies questions se chevauchent) : elle
   * sert au rappel, le verdict appartient au reranker.
   */
  similarite?: number;
}

export interface KnowledgeStore {
  /**
   * Les fiches du tenant et de l'agent qui ont quelque chose à voir avec cette requête, mesures comprises.
   *
   * 🔴 `tenantId` et `agentId` : la RLS est contournée par le pooler, ce filtrage est le seul contrôle. Et la
   * requête vient du modèle, donc d'un texte qu'un contact peut influencer.
   */
  chercher(tenantId: string, agentId: string, requete: string, limite: number): Promise<FicheTrouvee[]>;
  /**
   * Les fiches les plus proches d'un vecteur de question. Même portée, mêmes raisons. Optionnelle : absente,
   * ou sans vecteurs, la recherche retombe sur le plein texte seul.
   */
  chercherParVecteur?(tenantId: string, agentId: string, vecteur: number[], limite: number): Promise<FicheTrouvee[]>;
}

/**
 * D'où vient une fiche : nommé, jamais deviné de la présence d'une URL (un document joint et une fiche
 * tapée à la main ont tous deux `sourceUrl` à null).
 */
export type SourceFiche =
  | { type: 'page'; url: string }
  | { type: 'document'; nom: string }
  | { type: 'manuel' };

export interface FicheConnaissance {
  id: string;
  titre: string;
  corps: string;
  /** D'où vient cette fiche, pour que l'écran puisse le dire. */
  source: SourceFiche;
  sourceUrl: string | null;
  /** Quand la source a été lue pour la dernière fois. `null` pour une fiche écrite à la main. Visible à
   *  l'écran, contre le contenu périmé. */
  derniereLectureAt: string | null;
  updatedAt: string;
}

/** Ce qu'un import produit avant écriture, qu'il vienne d'une page web ou d'un document. */
export interface FicheAEcrire {
  titre: string;
  corps: string;
  sourceUrl?: string | null;
}

/**
 * La règle de pertinence, en code : on ne demande jamais au modèle de juger s'il sait. Une fiche non
 * pertinente n'est pas montrée, et si aucune ne l'est, le parcours sort par `sortie:sans_source`.
 *
 * Trois raisons d'accepter, chacune explicable au client :
 * 1. deux mots de la question au moins se retrouvent dans la fiche (un compte, pas une proportion : une
 *    question bavarde n'est pas punie pour sa longueur) ;
 * 2. ou la question est si courte que la fiche en couvre la moitié (« la piscine ? ») ;
 * 3. ou le titre est très proche au trigramme (la faute de frappe, « parkin »).
 *
 * Des valeurs raisonnées, pas mesurées. Ce qui n'en dépend pas : une question sans aucun mot commun ne fait
 * remonter aucune fiche (le `where` filtre).
 */
export const MIN_TERMES_COMMUNS = 2;
export const COUVERTURE_MIN = 0.5;
export const PROXIMITE_TITRE_MIN = 0.3;

/**
 * La règle lexicale de pertinence. Elle prend les trois mesures qu'elle lit, pas une `FicheTrouvee`
 * entière, pour servir aussi au bot d'aide (`src/aide/`), dont les fiches n'ont pas de `sourceUrl` : une
 * seule règle pour les deux corpus.
 */
export function ficheEstPertinente(f: Pick<FicheTrouvee, 'termesTrouves' | 'couverture' | 'proximiteTitre'>): boolean {
  return f.termesTrouves >= MIN_TERMES_COMMUNS
    || f.couverture >= COUVERTURE_MIN
    || f.proximiteTitre >= PROXIMITE_TITRE_MIN;
}

/**
 * La configuration de recherche plein texte des deux corpus (`agent_knowledge`, `aide_fiches`).
 *
 * Une seule définition, parce que la colonne générée en base et la requête écrite ici doivent s'accorder, et
 * que rien ne signale leur désaccord (la recherche rend juste moins). `tests/recherche-configuration.test.ts`
 * les tient alignées en lisant les migrations. Interpolée dans le SQL (`regconfig` n'accepte pas de
 * paramètre) : une constante, aucune entrée utilisateur ne l'atteint.
 */
export const CONFIG_RECHERCHE = 'french_sans_accent';

/** Au-delà, ce n'est plus une requête mais un message recopié : on borne le coût du plein texte. Les
 *  doublons sont retirés avant de trancher, pour qu'une question bavarde ne perde pas son mot-clé. */
const MAX_TERMES = 20;

/**
 * Découpe une requête libre en termes sûrs pour `to_tsquery`.
 *
 * En code : `to_tsquery` lève sur ses métacaractères (`&`, `|`, `!`, `(`, `)`, `:`, `*`), et une seule
 * survivante ferait échouer toute recherche, donc sortir l'agent en `sans_source`. On découpe sur tout ce
 * qui n'est pas lettre ou chiffre unicode. Les accents sont conservés : `CONFIG_RECHERCHE` les retire des
 * deux côtés, requête et colonne.
 */
export function termesDeRecherche(texte: string): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const brut of texte.normalize('NFC').split(/[^\p{L}\p{N}]+/u)) {
    // Un terme d'une seule lettre ne porte pas de sens et élargit la requête pour rien.
    if (brut.length < 2) continue;
    const cle = brut.toLocaleLowerCase('fr');
    if (vus.has(cle)) continue;
    vus.add(cle);
    out.push(brut);
    if (out.length === MAX_TERMES) break;
  }
  return out;
}
