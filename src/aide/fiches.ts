/**
 * Les fiches du mode d'emploi : le contrat de recherche, et le format d'un fichier de fiche.
 *
 * Ce module ne rend que des mesures, jamais un verdict (même séparation que `src/agent/knowledge.ts`) : le
 * rappel remonte des candidats même pour une question sans réponse, et c'est le reclassement qui tranche.
 *
 * 🔴 Aucun `tenantId` : le mode d'emploi est le même pour tous les espaces. C'est la raison de la table
 * séparée : le loger dans `agent_knowledge` aurait exigé d'y rendre `tenant_id` nullable, donc d'affaiblir
 * l'isolation entre clients.
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
  /** Combien de termes signifiants de la question se retrouvent dans la fiche. Un compte, pas un rang. */
  termesTrouves: number;
  /** `termesTrouves` rapporté au nombre de termes signifiants de la question. Dans [0, 1]. */
  couverture: number;
  /** Proximité trigramme du titre avec la question brute, dans [0, 1]. Rattrape la faute de frappe. */
  proximiteTitre: number;
  /**
   * Similarité cosinus au vecteur de la question, dans [0, 1] ; `undefined` hors du rappel vectoriel. Ce n'est
   * pas une mesure de pertinence : une question hors sujet peut remonter plus haut qu'une vraie, aucun seuil n'y
   * tient. Elle sert au rappel, le verdict appartient au reclassement.
   */
  similarite?: number;
}

export interface DepotAide {
  /** Les fiches qui ont quelque chose à voir avec cette question, mesures comprises. */
  chercher(requete: string, limite: number): Promise<FicheAide[]>;
  /**
   * Les fiches les plus proches d'un vecteur de question. Optionnelle : sans elle (ou sans vecteurs), la
   * recherche retombe sur le plein texte seul.
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
 * Lit un fichier de fiche : un en-tête `---` de métadonnées, puis un titre `# ...`, puis le corps. Pas
 * `lireFiche`, nom déjà pris par la lecture de la fiche d'un agent.
 *
 * Ne lève jamais : une fiche mal formée priverait le bot de toutes les autres au chargement ; c'est
 * `tests/aide-fiches-format.test.ts` qui refuse un fichier douteux en amont. Le titre est retiré du corps :
 * il est donné au modèle à part, et compterait deux fois dans la vectorisation comme dans le rappel lexical.
 */
export function lireFicheDuDepot(nomFichier: string, texte: string): FicheFichier {
  const cle = nomFichier.replace(/\.md$/, '');
  // En-tête lu ligne par ligne : une expression régulière ne reconnaissait pas un en-tête vide et laissait les
  // deux tirets dans le corps, sous les yeux du client.
  const lignes = texte.split(/\r?\n/);
  const finEntete = lignes[0] === '---' ? lignes.indexOf('---', 1) : -1;
  const entete = finEntete > 0 ? lignes.slice(1, finEntete).join('\n') : null;
  const corpsBrut = (finEntete > 0 ? lignes.slice(finEntete + 1).join('\n') : texte).trim();
  const champ = (nom: string): string | null => {
    if (entete === null) return null;
    const trouve = new RegExp(`^${nom}:(.*)$`, 'm').exec(entete);
    const valeur = trouve?.[1]?.trim() ?? '';
    // Un champ vide vaut absent : `ecran: ` donnerait sinon une clé d'écran que la carte ne résoudrait jamais.
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
