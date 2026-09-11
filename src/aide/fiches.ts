/**
 * LES FICHES DU MODE D'EMPLOI : le contrat de recherche, et le format d'un fichier de fiche.
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

/** Une fiche telle qu'elle vit dans le dépôt, avant d'être chargée en base. */
export interface FicheFichier {
  /** Le nom du fichier sans extension. C'est la clé d'unicité, donc ce qui rend le chargement idempotent. */
  cle: string;
  titre: string;
  corps: string;
  ecran: string | null;
  sourceSection: string | null;
  sourceEmpreinte: string | null;
}

/**
 * Lit un fichier de fiche : un en-tête `---` de métadonnées, puis un titre `# ...`, puis le corps.
 *
 * ⚠️ `lireFicheDuDepot` ET NON `lireFiche` : ce dernier nom est DÉJÀ pris dans ce dépôt, par la dépendance
 * qui lit la fiche d'un AGENT en base (`RunTurnDeps.lireFiche`). Aucun conflit de compilation, les deux
 * vivent dans des modules différents, mais un `grep lireFiche` rendrait deux choses sans rapport. Le nom
 * choisi est symétrique de `fichesDuDepot` : l'une lit toutes les fiches, l'autre en analyse une.
 *
 * ⚠️ VOLONTAIREMENT PRIMITIF, et sans aucune dépendance de lecture d'en-tête. Le format est le nôtre, il est
 * lu à un seul endroit, et il est tenu par `tests/aide-fiches-format.test.ts`. Ajouter une bibliothèque pour
 * six lignes de découpage serait le genre de dépendance qu'on regrette au premier audit.
 *
 * ⚠️ NE JETTE JAMAIS. Une fiche mal formée qui ferait échouer la lecture priverait le bot de TOUTES les
 * autres au chargement. Le défaut sûr est de charger ce qu'on comprend ; c'est le test de format qui refuse
 * un fichier douteux, en amont, là où quelqu'un peut le corriger.
 *
 * ⚠️ LE TITRE EST RETIRÉ DU CORPS. Il est déjà donné au modèle à part, et le laisser le ferait compter deux
 * fois dans la vectorisation comme dans le rappel lexical, ce qui avantagerait les fiches au titre long sans
 * aucune raison.
 */
export function lireFicheDuDepot(nomFichier: string, texte: string): FicheFichier {
  const cle = nomFichier.replace(/\.md$/, '');
  // 🔴 L'EN-TÊTE EST LU LIGNE PAR LIGNE, et non par une expression régulière. La version régulière ne
  // reconnaissait pas un en-tête VIDE (une ligne `---` suivie d'une autre), et laissait alors les deux
  // tirets DANS le corps, c'est-à-dire sous les yeux du client. Trouvé en relisant les fiches le
  // 2026-09-11, sur une fiche qui n'avait rien à déclarer et portait donc un en-tête vide.
  const lignes = texte.split(/\r?\n/);
  const finEntete = lignes[0] === '---' ? lignes.indexOf('---', 1) : -1;
  const entete = finEntete > 0 ? lignes.slice(1, finEntete).join('\n') : null;
  const corpsBrut = (finEntete > 0 ? lignes.slice(finEntete + 1).join('\n') : texte).trim();
  const champ = (nom: string): string | null => {
    if (entete === null) return null;
    const trouve = new RegExp(`^${nom}:(.*)$`, 'm').exec(entete);
    const valeur = trouve?.[1]?.trim() ?? '';
    // Un champ VIDE vaut ABSENT : `ecran: ` produirait sinon une clé d'écran vide, que la carte ne
    // résoudrait jamais et que personne ne verrait, au lieu d'une fiche honnêtement sans écran.
    return valeur === '' ? null : valeur;
  };
  const titre = /^#[ \t]+(.+)$/m.exec(corpsBrut);
  return {
    cle,
    titre: titre?.[1]?.trim() ?? '',
    corps: corpsBrut.replace(/^#[ \t]+.+$/m, '').trim(),
    ecran: champ('ecran'),
    sourceSection: champ('source_section'),
    sourceEmpreinte: champ('source_empreinte'),
  };
}
