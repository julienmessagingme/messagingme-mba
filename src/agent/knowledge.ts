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
export interface FicheConnaissance {
  id: string;
  titre: string;
  corps: string;
  sourceUrl: string | null;
  /** Quand la source a été lue pour la dernière fois. `null` pour une fiche écrite à la main. Visible dans
   *  l'écran : le cadrage en fait la parade au défaut le plus courant du marché, le contenu périmé. */
  derniereLectureAt: string | null;
  updatedAt: string;
}

/** Ce qu'un import de page produit avant écriture. */
export interface FicheAEcrire {
  titre: string;
  corps: string;
  sourceUrl?: string | null;
}

/**
 * L'écriture de la base de connaissance, réservée à l'écran de réglage.
 *
 * SÉPARÉE de `KnowledgeStore` à dessein : le tour d'agent ne lit que `chercher`, et lui faire porter cinq
 * méthodes d'écriture obligerait chaque double de test du runtime à les implémenter pour rien. Une seule
 * classe les sert toutes les deux.
 */
export interface KnowledgeAdminStore {
  lister(tenantId: string, agentId: string): Promise<FicheConnaissance[]>;

  /**
   * Écrit une fiche. Rend `null` si l'agent n'existe pas OU appartient à un autre tenant.
   *
   * 🔴 L'appartenance de l'agent se vérifie DANS l'écriture, pas avant. Le couple (tenant, agent) est ce qui
   * rend une fiche visible : une ligne portant le tenant de l'un et l'agent de l'autre ne serait jamais lue
   * par personne, tout en consommant la place et en polluant les comptes.
   */
  creer(tenantId: string, agentId: string, fiche: FicheAEcrire): Promise<FicheConnaissance | null>;

  /**
   * Corrige une fiche. Rend `null` si elle n'existe pas, ou si elle n'est pas celle de CE couple
   * (tenant, agent).
   *
   * L'agent fait partie du périmètre, comme à l'écriture : sans lui, l'adresse promet un agent que la requête
   * ne contrôle pas, et un identifiant de fiche mal aiguillé par l'écran corrigerait en silence la fiche d'un
   * AUTRE agent du même client.
   */
  modifier(tenantId: string, agentId: string, ficheId: string, patch: { titre?: string; corps?: string }): Promise<FicheConnaissance | null>;

  /** Rend `false` si la fiche n'existe pas ou n'est pas celle de ce couple (tenant, agent). */
  supprimer(tenantId: string, agentId: string, ficheId: string): Promise<boolean>;

  /**
   * Relit une source : retire les fiches de CETTE adresse pour CET agent, puis écrit les nouvelles, en une
   * seule transaction.
   *
   * 🔴 REMPLACER ET NON AJOUTER. Une relecture qui ajouterait doublerait la base à chaque passage, et la
   * recherche compte les mots partagés : deux copies d'une même fiche ne rendent pas la réponse plus sûre,
   * elles la rendent deux fois plus probable qu'une autre. Le prix est dit au client dans l'écran : ses
   * corrections sur les fiches de cette adresse partent avec.
   */
  remplacerSource(tenantId: string, agentId: string, sourceUrl: string, fiches: FicheAEcrire[]): Promise<{ retirees: number; ecrites: number } | null>;
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
