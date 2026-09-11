/**
 * LES FICHES DU MODE D'EMPLOI : le contrat de recherche.
 *
 * 🔴 CE MODULE NE REND QUE DES MESURES, JAMAIS UN VERDICT. C'est la même séparation que la connaissance des
 * agents (`src/agent/knowledge.ts`), et elle est ce qui empêche l'hallucination : le rappel remonte des
 * candidats, y compris pour une question qui n'a aucune réponse dans la base, et c'est le reclassement qui
 * tranche ensuite sur un score qui, lui, sépare. Servir ces lignes directement au modèle reviendrait à lui
 * demander d'inventer à partir de ce qui ressemble le moins mal.
 *
 * ⚠️ AUCUN `tenantId` dans ce contrat, contrairement à `KnowledgeStore`. Le mode d'emploi d'Engage Me est le
 * même pour tous les espaces, et c'est ce qui permet de mutualiser le coût d'une question fréquente. Cette
 * absence est la RAISON de la table séparée : la garder dans `agent_knowledge` aurait exigé d'y rendre
 * `tenant_id` nullable, c'est-à-dire d'affaiblir le seul contrôle d'isolation entre clients qui reste.
 */

/** Une fiche remontée par le rappel, avec ce qui a permis de la remonter. */
export interface FicheAide {
  id: string;
  /** Le nom de son fichier dans `docs/aide/fiches/`, sans extension. */
  cle: string;
  titre: string;
  corps: string;
  /** La clé de nav de l'écran concerné, ou `null` quand la fiche ne parle d'aucun écran précis. */
  ecran: string | null;
  /** Combien de termes SIGNIFIANTS de la question se retrouvent dans la fiche. Un compte, pas un rang. */
  termesTrouves: number;
  /** `termesTrouves` rapporté au nombre de termes signifiants de la question. Dans [0, 1]. */
  couverture: number;
  /** Proximité trigramme du TITRE avec la question brute, dans [0, 1]. Rattrape la faute de frappe. */
  proximiteTitre: number;
  /**
   * Similarité cosinus au vecteur de la question, dans [0, 1]. `undefined` quand la fiche ne vient pas du
   * rappel vectoriel.
   *
   * 🔴 CE N'EST PAS UNE MESURE DE PERTINENCE, et lui en faire porter le rôle serait reproduire le défaut
   * mesuré le 2026-09-02 sur la connaissance des agents : une question HORS SUJET y remonte à 0,361 quand
   * une vraie question descend à 0,299. Les deux populations se chevauchent, aucun seuil n'est posable
   * dessus. Elle sert au RAPPEL, le verdict appartient au reclassement.
   */
  similarite?: number;
}

export interface DepotAide {
  /** Les fiches qui ont quelque chose à voir avec cette question, mesures comprises. */
  chercher(requete: string, limite: number): Promise<FicheAide[]>;
  /**
   * Les fiches les plus proches d'un VECTEUR de question.
   *
   * OPTIONNELLE : absente, ou colonne vide, ou vectorisation non branchée, la recherche retombe sur le plein
   * texte seul. Une base sans vecteurs reste donc pleinement utilisable, ce qui est ce qui rend la migration
   * 0131 non bloquante.
   */
  chercherParVecteur?(vecteur: number[], limite: number): Promise<FicheAide[]>;
}
