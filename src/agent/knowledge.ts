/**
 * La base de connaissance d'un agent : le contrat de recherche, et le découpage des termes.
 *
 * 🔴 C'EST LE MÉCANISME ANTI-HALLUCINATION, et c'est le seul endroit du produit où l'on prétend qu'il est
 * DÉTERMINISTE. La règle vit dans `resolvers/mba.ts` (`ficheEstPertinente`) ; ici on ne rend que des MESURES,
 * jamais un verdict. Les autres fichiers renvoient à ces deux endroits plutôt que de réexpliquer.
 */

export interface FicheTrouvee {
  id: string;
  titre: string;
  corps: string;
  sourceUrl: string | null;
  /** Combien de termes SIGNIFIANTS de la requête se retrouvent dans la fiche. Un compte, pas un rang. */
  termesTrouves: number;
  /** `termesTrouves` rapporté au nombre de termes signifiants de la requête. Dans [0, 1]. */
  couverture: number;
  /** Proximité trigramme du TITRE avec la requête brute, dans [0, 1]. Rattrape la faute de frappe. */
  proximiteTitre: number;
}

export interface KnowledgeStore {
  /**
   * Les fiches du tenant ET de l'agent qui ont quelque chose à voir avec cette requête, mesures comprises.
   *
   * ⚠️ `tenantId` ET `agentId` : le pooler est superuser, la RLS est bypassée, ce filtrage est le SEUL
   * contrôle. Et la requête vient du MODÈLE, donc d'un texte qu'un contact peut influencer.
   */
  chercher(tenantId: string, agentId: string, requete: string, limite: number): Promise<FicheTrouvee[]>;
}

/**
 * 🔴 LA RÈGLE DE PERTINENCE, ET ELLE EST EN CODE. C'est tout le mécanisme : on ne demande jamais au modèle de
 * juger s'il sait, on le rend incapable de répondre hors de ses sources. Une fiche jugée non pertinente n'est
 * pas montrée, et si aucune ne l'est, le parcours sort par `sortie:sans_source`.
 *
 * Trois raisons d'accepter, chacune tenant en une phrase, et c'est volontaire : un client doit pouvoir se
 * faire expliquer pourquoi son agent a transféré.
 *
 * 1. **Deux mots de la question au moins se retrouvent dans la fiche.** Un COMPTE, pas une proportion : une
 *    question polie et bavarde ne doit pas être punie pour sa longueur. C'est cette règle qui écarte la fiche
 *    qui ne partage qu'un mot incident (« résident » dans une question sur les annulations).
 * 2. **Ou la question est si courte que la fiche en couvre la moitié.** Sans elle, « la piscine ? » serait
 *    rejetée alors que la fiche répond exactement.
 * 3. **Ou le titre est très proche de la question**, au trigramme : c'est le rattrapage de la faute de frappe
 *    (« parkin »), là où le plein texte ne trouve rien du tout.
 *
 * ⚠️ Ces valeurs sont un point de départ RAISONNÉ, pas une mesure. Ce qui est robuste et ne dépend d'aucune
 * d'entre elles : une question sans le moindre mot commun ne fait remonter AUCUNE fiche (le `where` de la
 * requête est un filtre, pas un tri), donc la sortie tombe de toute façon.
 */
export const MIN_TERMES_COMMUNS = 2;
export const COUVERTURE_MIN = 0.5;
export const PROXIMITE_TITRE_MIN = 0.3;

export function ficheEstPertinente(f: FicheTrouvee): boolean {
  return f.termesTrouves >= MIN_TERMES_COMMUNS
    || f.couverture >= COUVERTURE_MIN
    || f.proximiteTitre >= PROXIMITE_TITRE_MIN;
}

/** Au-delà, ce n'est plus une requête mais un message entier recopié : on borne le coût du plein texte. Les
 *  doublons sont retirés AVANT de trancher, sinon une question bavarde perdait son mot-clé au profit de trois
 *  « le ». */
const MAX_TERMES = 20;

/**
 * Découpe une requête libre en termes SÛRS pour `to_tsquery`.
 *
 * 🔴 POURQUOI EN CODE ET PAS EN SQL. `to_tsquery` LÈVE sur une entrée libre : `&`, `|`, `!`, `(`, `)`, `:` et
 * `*` sont ses métacaractères. Un seul qui survivrait ferait échouer TOUTE recherche, donc sortirait l'agent
 * en `sans_source` en permanence. On découpe donc sur tout ce qui n'est PAS une lettre ou un chiffre unicode,
 * ce qui ne peut en laisser passer aucun.
 *
 * ⚠️ LES ACCENTS SONT CONSERVÉS. `to_tsvector('french', ...)` les garde (la colonne générée de la migration
 * 0086 aussi) : les retirer côté requête casserait le rapprochement au lieu de l'élargir.
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
