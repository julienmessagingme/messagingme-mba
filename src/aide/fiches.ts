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

import { ENCADRE, structureFiche, texteBloc } from './structure';

/** Une fiche remontée par le rappel, avec ce qui a permis de la remonter. */
export interface FicheAide {
  id: string;
  /** Le nom de son fichier dans `docs/aide/fiches/`, sans extension, suivi de `#<n>` pour un morceau (`decouperFiche`). */
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
  /**
   * Le nom du fichier sans extension, ou `<nom>#<n>` pour un morceau d'une fiche longue. C'est la clé d'unicité, donc
   * ce qui rend le chargement idempotent.
   */
  cle: string;
  titre: string;
  corps: string;
  ecran: string | null;
  sourceSection: string | null;
  sourceEmpreinte: string | null;
}

/**
 * Ce que le bot reçoit d'une fiche, au plus. Une fiche plus longue est chargée en morceaux (`decouperFiche`) : avant
 * le 2026-10-20, il en recevait les 2 000 premiers caractères, soit les étapes 1 et 2 de « Lancer une campagne ».
 */
export const MORCEAU_MAX = 2_000;

/** Une phrase se termine par sa ponctuation forte ; on coupe après, jamais au milieu. */
const FIN_DE_PHRASE = /(?<=[.!?…])\s+/;

/**
 * Un texte trop long pour un morceau, rendu en parts qui tiennent : une liste se coupe entre ses points, un paragraphe
 * entre ses phrases, et une phrase seule plus longue que la borne (aucune aujourd'hui) entre ses mots.
 */
function eclater(texte: string, budget: number): string[] {
  const liste = texte.split('\n').every((l) => l.startsWith('- '));
  const unites = (liste ? texte.split('\n') : texte.split(FIN_DE_PHRASE)).flatMap((u) => {
    if (u.length <= budget) return [u];
    const mots: string[] = [];
    for (const mot of u.split(' ')) {
      if (mots.length > 0 && `${mots.at(-1)} ${mot}`.length <= budget) mots[mots.length - 1] += ` ${mot}`;
      else mots.push(mot.slice(0, budget));
    }
    return mots;
  });
  return emballer(unites, budget, liste ? '\n' : ' ');
}

/** Range des unités, dans l'ordre, en parts d'au plus `budget` caractères. */
function emballer(unites: string[], budget: number, joint: string): string[] {
  const parts: string[] = [];
  let courante = '';
  for (const u of unites) {
    if (courante !== '' && courante.length + joint.length + u.length > budget) {
      parts.push(courante);
      courante = '';
    }
    courante = courante === '' ? u : `${courante}${joint}${u}`;
  }
  if (courante !== '') parts.push(courante);
  return parts;
}

/**
 * Les morceaux d'un sujet : chacun commence par `prefixe` (le marqueur d'une étape ou d'un encadré, suivi d'une espace ;
 * l'intertitre d'une section, suivi d'une ligne vide), pour qu'un morceau retrouvé seul dise encore de quoi il parle.
 */
function morceaux(prefixe: string, blocs: string[], joint = ' '): string[] {
  const budget = MORCEAU_MAX - (prefixe === '' ? 0 : prefixe.length + joint.length);
  const unites = blocs.filter((b) => b !== '').flatMap((b) => (b.length <= budget ? [b] : eclater(b, budget)));
  return emballer(unites, budget, '\n\n').map((m) => (prefixe === '' ? m : `${prefixe}${joint}${m}`));
}

/**
 * Ce que le chargeur écrit en base pour une fiche. Une fiche qui tient dans `MORCEAU_MAX` reste ENTIÈRE, sous sa clé :
 * son texte ne change pas, donc son vecteur est gardé. Une fiche plus longue devient des morceaux `<clé>#<n>` : le
 * chapeau et la prose d'avant la première étape, puis une étape par morceau, un encadré par morceau, la prose
 * regroupée. Chaque morceau d'étape commence par son marqueur (`**3. Le contenu.**`) : un morceau retrouvé seul dit
 * encore de quel geste il parle, et le titre de la fiche part à côté (`TITRE :` du bloc donné au modèle).
 */
export function decouperFiche(f: FicheFichier): FicheFichier[] {
  if (f.corps.length <= MORCEAU_MAX) return [f];
  const s = structureFiche(f.corps);
  const textes: string[] = [];
  let prose: string[] = s.chapeau === '' ? [] : [s.chapeau];
  const vider = () => {
    textes.push(...morceaux('', prose));
    prose = [];
  };
  for (const section of s.sections) {
    if (section.type === 'prose' && section.titre === null) {
      prose.push(...section.blocs.map(texteBloc));
      continue;
    }
    vider();
    if (section.type === 'prose') {
      // Une section sous intertitre se range à part, et chaque morceau en porte l'intertitre : sinon il restait seul en
      // fin d'un morceau, et sa suite ouvrait le suivant sans lui.
      textes.push(...morceaux(`## ${section.titre}`, section.blocs.map(texteBloc), '\n\n'));
    } else if (section.type === 'etape') {
      textes.push(...morceaux(`**${section.numero}. ${section.titre}.**`, [section.tete, ...section.detail.map(texteBloc)]));
    } else {
      textes.push(...morceaux(ENCADRE.fr, [section.texte]));
    }
  }
  vider();
  return textes.map((corps, i) => ({ ...f, cle: `${f.cle}#${i + 1}`, corps }));
}

/** Les rubriques du centre d'aide public, dans l'ordre du menu. */
export const RUBRIQUES = ['demarrer', 'parler-aux-clients'] as const;
export type Rubrique = (typeof RUBRIQUES)[number];

/**
 * Ce qu'une fiche PUBLIQUE dit d'elle-même dans son en-tête, pour le centre d'aide de la vitrine (plan du centre
 * d'aide, tâche 3). Le bot n'en lit rien : ces champs ne servent qu'aux pages et au lien « Comment faire ».
 */
export interface PublicationFiche {
  rubrique: Rubrique;
  /** Sa place dans la rubrique, à partir de 1. */
  rang: number;
  /** La page « Comment faire » de son écran (`ecran`), dans la console. */
  commentFaire: boolean;
  /** Ses étapes ont une capture de la console ; `captures: non` pour des étapes qui se passent ailleurs. */
  captures: boolean;
  /** Son film est livré (`site/films/aide-<cle>*`) ; posé à la livraison, jamais avant. */
  video: boolean;
  /** La fiche à lire avant, le second bouton de la page. */
  prerequis: string | null;
  /**
   * L'offre la moins chère qui ouvre ce que la page fait faire, et que la page dit (spec Business) : `pro` par défaut,
   * `business` ou `entreprise` ; `null` (`offre: non`) pour une page qui n'en demande pas.
   */
  offre: OffreFiche | null;
  /**
   * Le geste se fait aussi depuis Claude Code, avec l'offre Free (`claude_code: oui`) : la page mène d'abord au plugin,
   * et dit que la console demande le Pro.
   */
  claudeCode: boolean;
}

/** Les offres qu'une fiche peut demander (le champ `offre:`), de la moins chère à la plus chère. */
export const OFFRES_FICHE = ['pro', 'business', 'entreprise'] as const;
export type OffreFiche = (typeof OFFRES_FICHE)[number];

/** Un champ de l'en-tête `---` d'une fiche ; un champ vide vaut absent. */
export function champDeFiche(texte: string, nom: string): string | null {
  const lignes = texte.split(/\r?\n/);
  const fin = lignes[0] === '---' ? lignes.indexOf('---', 1) : -1;
  if (fin <= 0) return null;
  const trouve = new RegExp(`^${nom}:(.*)$`, 'm').exec(lignes.slice(1, fin).join('\n'));
  const valeur = trouve?.[1]?.trim() ?? '';
  return valeur === '' ? null : valeur;
}

/**
 * La publication d'une fiche, ou `null` si elle n'est pas publique (`publique: oui`). LÈVE sur un champ mal écrit, en
 * le nommant : seuls les tests et le générateur de la vitrine l'appellent, jamais le chargeur du bot.
 */
export function publicationDe(texte: string): PublicationFiche | null {
  if (champDeFiche(texte, 'publique') !== 'oui') return null;
  const oui = (nom: string, defaut: boolean): boolean => {
    const v = champDeFiche(texte, nom);
    if (v === null) return defaut;
    if (v !== 'oui' && v !== 'non') throw new Error(`${nom}: « ${v} », attendu oui ou non`);
    return v === 'oui';
  };
  const rubrique = champDeFiche(texte, 'rubrique');
  if (!RUBRIQUES.includes(rubrique as Rubrique)) throw new Error(`rubrique: « ${rubrique} », attendu ${RUBRIQUES.join(' ou ')}`);
  const offre = champDeFiche(texte, 'offre');
  if (offre !== null && offre !== 'non' && !(OFFRES_FICHE as readonly string[]).includes(offre)) {
    throw new Error(`offre: « ${offre} », attendu ${OFFRES_FICHE.join(', ')} ou non`);
  }
  const rang = Number(champDeFiche(texte, 'rang'));
  if (!Number.isInteger(rang) || rang < 1) throw new Error(`rang: « ${champDeFiche(texte, 'rang')} », attendu un entier dès 1`);
  return {
    rubrique: rubrique as Rubrique,
    rang,
    commentFaire: oui('comment_faire', false),
    captures: oui('captures', true),
    video: oui('video', false),
    prerequis: champDeFiche(texte, 'prerequis'),
    offre: offre === null ? 'pro' : offre === 'non' ? null : (offre as OffreFiche),
    claudeCode: oui('claude_code', false),
  };
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
