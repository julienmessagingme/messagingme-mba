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
  /**
   * Similarité cosinus au vecteur de la question, dans [0, 1]. `undefined` = cette fiche n'est pas venue du
   * rappel vectoriel (ou la vectorisation n'est pas branchée).
   *
   * 🔴 CE N'EST PAS UNE MESURE DE PERTINENCE, et il ne faut jamais lui en faire porter le rôle. Mesuré le
   * 2026-09-02 : une question HORS SUJET remonte une fiche à 0,361 quand une vraie question descend à 0,299.
   * Les deux populations se chevauchent, donc aucun seuil n'est posable dessus. Elle sert au RAPPEL, c'est
   * tout ; le verdict appartient au reranker. Cf. `docs/MESURE-RECHERCHE-CONNAISSANCE-2026-09-02.md`.
   */
  similarite?: number;
}

export interface KnowledgeStore {
  /**
   * Les fiches du tenant ET de l'agent qui ont quelque chose à voir avec cette requête, mesures comprises.
   *
   * ⚠️ `tenantId` ET `agentId` : le pooler est superuser, la RLS est bypassée, ce filtrage est le SEUL
   * contrôle. Et la requête vient du MODÈLE, donc d'un texte qu'un contact peut influencer.
   */
  chercher(tenantId: string, agentId: string, requete: string, limite: number): Promise<FicheTrouvee[]>;
  /**
   * Les fiches les plus proches d'un VECTEUR de question (migration 0110). Même scope, mêmes raisons.
   *
   * OPTIONNELLE : absente, ou colonne vide, ou vectorisation non branchée -> la recherche retombe sur le
   * plein texte seul, qui est le comportement d'avant. Une base sans vecteurs reste donc pleinement
   * utilisable, ce qui est ce qui rend la migration non bloquante.
   */
  chercherParVecteur?(tenantId: string, agentId: string, vecteur: number[], limite: number): Promise<FicheTrouvee[]>;
}

/** Une fiche telle que l'écran de réglage la montre et l'édite. */
/**
 * D'ou vient une fiche.
 *
 * 🔴 NOMMEE, JAMAIS DEVINEE DE LA PRESENCE D'UNE URL. Avant le 2026-09-08, une fiche issue d'un PDF joint a
 * la conversation etait ecrite par le meme chemin qu'une fiche tapee a la main : les deux avaient
 * `sourceUrl` a null, et rien ne les distinguait. L'ecran ne peut pas montrer ce qu'il ne sait pas.
 */
export type SourceFiche =
  | { type: 'page'; url: string }
  | { type: 'document'; nom: string }
  | { type: 'manuel' };

export interface FicheConnaissance {
  id: string;
  titre: string;
  corps: string;
  /** D'ou vient cette fiche, pour que l'ecran puisse le DIRE. */
  source: SourceFiche;
  sourceUrl: string | null;
  /** Quand la source a été lue pour la dernière fois. `null` pour une fiche écrite à la main. Visible dans
   *  l'écran : le cadrage en fait la parade au défaut le plus courant du marché, le contenu périmé. */
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

/**
 * La règle LEXICALE de pertinence : la fiche a-t-elle assez de rapport avec la question ?
 *
 * ⚠️ ELLE PREND LES TROIS MESURES QU'ELLE LIT, pas une `FicheTrouvee` entière, depuis le 2026-09-11. Le bot
 * d'aide (`src/aide/`) cherche dans une AUTRE table, dont les fiches n'ont pas de `sourceUrl` : deux règles
 * de pertinence auraient fini par ne plus vouloir dire la même chose, et personne n'aurait su laquelle
 * s'appliquait où. Le `Pick` est CONSOMMÉ sur place, ce qui est le cas où le CLAUDE.md l'autorise.
 */
export function ficheEstPertinente(f: Pick<FicheTrouvee, 'termesTrouves' | 'couverture' | 'proximiteTitre'>): boolean {
  return f.termesTrouves >= MIN_TERMES_COMMUNS
    || f.couverture >= COUVERTURE_MIN
    || f.proximiteTitre >= PROXIMITE_TITRE_MIN;
}

/**
 * LA CONFIGURATION DE RECHERCHE PLEIN TEXTE, pour les deux corpus (`agent_knowledge`, `aide_fiches`).
 *
 * 🔴 UNE SEULE DÉFINITION, PARCE QUE LA COLONNE ET LA REQUÊTE DOIVENT S'ACCORDER. Elles vivent dans deux
 * mondes qui ne se parlent pas : la colonne est GÉNÉRÉE en base (migrations 0086, 0131, 0132), la requête
 * est écrite ici. Rien ne signale leur désaccord, ni le compilateur, ni une erreur SQL : la recherche rend
 * simplement moins de résultats. `tests/recherche-configuration.test.ts` tient les deux alignées en LISANT
 * les fichiers de migration, seul endroit d'où l'invariant est visible.
 *
 * ⚠️ ELLE EST INTERPOLÉE DANS DU SQL, jamais paramétrée : `regconfig` n'accepte pas un paramètre de requête.
 * C'est une constante de ce fichier, aucune entrée utilisateur ne l'atteint.
 */
export const CONFIG_RECHERCHE = 'french_sans_accent';

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
 * ⚠️ LES ACCENTS SONT CONSERVÉS ICI, ET C'EST LA CONFIGURATION QUI LES RETIRE, DES DEUX CÔTÉS.
 * Ce commentaire disait « les retirer côté requête casserait le rapprochement au lieu de l'élargir » :
 * l'observation était juste, la conclusion fausse. Les retirer d'UN SEUL côté casse ; les retirer des DEUX
 * répare, et c'est ce que fait `CONFIG_RECHERCHE` depuis la migration 0132. Mesuré avant : « prevoyance »
 * trouvait ZÉRO fiche là où « prévoyance » en trouvait trois.
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
