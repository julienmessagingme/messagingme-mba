import { MAX_TEXTE_POST } from './api-chaine';

/**
 * La mise en forme du texte d'un post de chaîne : ce que l'éditeur ÉCRIT, et ce que l'aperçu MONTRE.
 *
 * 🔴 POURQUOI UN MODULE PUR PLUTÔT QUE DU CODE DANS LE `.tsx`. Même raison que `chaine-apercu.ts` : le
 * vitest du front n'inclut que les tests de `lib/`, un composant ne s'y teste pas. Or ce module transforme
 * le texte qui partira dans un post PUBLIÉ, donc irrattrapable. Ce qui le transforme se teste avant.
 *
 * ⚠️ LA SYNTAXE EST CELLE DE WHATSAPP, ET ELLE EST MESURÉE, PAS SUPPOSÉE. La spec OpenAPI du fournisseur
 * (https://channels-me.com/api-docs/v1/swagger.yaml, champ `text` du schéma `Message`, relue le 2026-09-07)
 * dit mot pour mot : « Text of the message, formated as WhatsApp flavored mardown ». Les marqueurs partent
 * donc TELS QUELS et c'est le client WhatsApp qui les rend. L'aperçu ne promet qu'une chose, et il la
 * tient : ce qu'il montre correspond à ce que le texte contient. Le rendu final se confirme sur un vrai
 * post, sur un vrai téléphone.
 */

/** Les trois marqueurs de WhatsApp, et le style qu'ils portent. */
export const MARQUEURS = { '*': 'gras', _: 'italique', '~': 'barre' } as const;
export type Marqueur = keyof typeof MARQUEURS;
export type StyleTexte = (typeof MARQUEURS)[Marqueur];

/**
 * Un morceau de texte et les styles qui le portent, du plus EXTÉRIEUR au plus intérieur.
 *
 * 🔴 UN TABLEAU, PAS UN STYLE UNIQUE, et c'est le chemin nominal de la barre d'outils qui l'impose :
 * `entoure` existe pour enchaîner gras PUIS italique, et deux clics produisent `*_mot_*`. Avec un style
 * unique, l'aperçu montrait « `_mot_` en gras », soulignés apparents, quand WhatsApp compose les deux et
 * n'affiche aucun souligné. Le client corrigeait alors un aperçu qui avait tort, et perdait son italique.
 * Sur l'écran dont le contrat écrit est « ce qui est dessiné ici correspond à ce qui part », c'était le
 * défaut le plus cher possible.
 *
 * Un tableau VIDE est du texte brut.
 */
export interface SegmentTexte {
  styles: StyleTexte[];
  contenu: string;
}

/**
 * Un marqueur ne compte que s'il est en BORDURE DE MOT, et c'est ce qui protège les adresses.
 *
 * 🔴 Sans cette règle, `https://exemple.fr/mon_super_lien` deviendrait « mon » en italique au milieu d'une
 * URL, et le client ne verrait le dégât qu'une fois le post diffusé. Un souligné entouré de lettres n'est
 * pas une intention de style, c'est un caractère d'adresse ou de nom de fichier.
 *
 * La bordure, c'est le début du texte, la fin, une espace ou une ponctuation.
 *
 * ⚠️ L'APOSTROPHE TYPOGRAPHIQUE EN FAIT PARTIE, au même titre que l'apostrophe droite. Toute l'interface
 * écrit la typographique (« l’adresse », « l’en-tête ») : sans elle, `l’*offre*` ne stylait rien, et le
 * client n'avait aucun moyen de deviner que son apostrophe était en cause.
 *
 * ⚠️ Un EMOJI collé au marqueur reste une non-bordure : `🎉*promo*` ne style rien. Ce n'est pas réparable
 * par une classe de caractères (un emoji est une suite de points de code, pas un caractère), et le contour
 * exact que WhatsApp applique n'est pas mesurable d'ici. Une espace entre les deux suffit.
 */
const EST_BORDURE = (c: string | undefined): boolean => c === undefined || /[\s.,!?;:()[\]"'’«»]/.test(c);

/**
 * Au-delà de cette longueur, on ne met plus rien en forme : le texte est rendu brut.
 *
 * ⚠️ CE N'EST PAS UNE LIMITE DE PRODUIT, c'est une garde de coût. L'analyse est quadratique dans son pire
 * cas (une ouverture qui ne ferme jamais rebalaie la fin du texte), l'aperçu recalcule à CHAQUE frappe, et
 * le `textarea` n'a pas de `maxLength` : un collage de 200 Ko figerait l'onglet. Au-delà de
 * `MAX_TEXTE_POST`, le texte n'est de toute façon pas publiable, donc son aperçu n'a plus rien à promettre.
 */
const PLAFOND_MISE_EN_FORME = MAX_TEXTE_POST;

/**
 * Découpe un texte en segments stylés, pour l'aperçu.
 *
 * ⚠️ Un marqueur qui ne se ferme pas reste un caractère ORDINAIRE. Le client qui tape « 5 * 3 » ou « le
 * fichier _brouillon » doit voir ce qu'il a tapé : une mise en forme qui avale un caractère isolé fait
 * douter de tout le reste.
 */
export function segmentsMisEnForme(texte: string): SegmentTexte[] {
  if (texte === '') return [];
  if (texte.length > PLAFOND_MISE_EN_FORME) return [{ styles: [], contenu: texte }];
  return decoupe(texte);
}

function decoupe(texte: string): SegmentTexte[] {
  const segments: SegmentTexte[] = [];
  let brut = '';
  let i = 0;
  const pousserBrut = (): void => {
    if (brut !== '') segments.push({ styles: [], contenu: brut });
    brut = '';
  };

  while (i < texte.length) {
    const c = texte[i]!;
    const style = (MARQUEURS as Record<string, StyleTexte | undefined>)[c];
    // Ouverture possible : marqueur connu, en bordure de mot, et NON suivi d'une espace (`* 3` n'ouvre rien).
    if (style !== undefined && EST_BORDURE(texte[i - 1]) && texte[i + 1] !== undefined && !/\s/.test(texte[i + 1]!)) {
      const fin = fermeture(texte, i, c);
      if (fin > i + 1) {
        pousserBrut();
        // Le contenu est REDÉCOUPÉ : `*_mot_*` porte les deux styles, comme chez WhatsApp. Chaque niveau
        // retire au moins les deux marqueurs, donc la récursion est bornée par la longueur du texte.
        for (const interne of decoupe(texte.slice(i + 1, fin))) {
          segments.push({ styles: [style, ...interne.styles], contenu: interne.contenu });
        }
        i = fin + 1;
        continue;
      }
    }
    brut += c;
    i += 1;
  }
  pousserBrut();
  return segments;
}

/**
 * Où se ferme le marqueur ouvert en `debut`, ou `-1`.
 *
 * La fermeture doit elle aussi être en bordure de mot du côté droit, et ne pas être précédée d'une espace :
 * `_mot _` n'est pas un italique, c'est un souligné traînant.
 */
function fermeture(texte: string, debut: number, marqueur: string): number {
  for (let j = debut + 1; j < texte.length; j += 1) {
    if (texte[j] === '\n') return -1; // un style ne traverse pas une ligne
    if (texte[j] !== marqueur) continue;
    if (/\s/.test(texte[j - 1]!)) continue;
    if (!EST_BORDURE(texte[j + 1])) continue;
    return j;
  }
  return -1;
}

/** Le texte, et où laisser la sélection ensuite. */
export interface Edition {
  texte: string;
  debut: number;
  fin: number;
}

/**
 * Entoure la sélection d'un marqueur, et rend la sélection à poser ensuite.
 *
 * 🔴 LA SÉLECTION EST RENDUE, elle n'est pas perdue. Un éditeur qui remet le curseur à la fin après chaque
 * clic oblige à re-sélectionner pour enchaîner gras puis italique, et c'est exactement ce qu'on fait en
 * mettant en forme.
 *
 * 🔴 LES ESPACES DE BORDURE SONT RENDUES AU TEXTE avant d'entourer, et sans ça le bouton semble MORT. Un
 * triple-clic sélectionne la ligne AVEC son passage à la ligne final, et un double-clic sous Windows
 * emporte l'espace qui suit le mot : on écrivait alors `*ligne\n*` ou `*promo *`, un balisage qu'aucune des
 * deux règles de fermeture n'accepte, ni la nôtre ni celle de WhatsApp. Rien ne se mettait en forme nulle
 * part, et il restait une étoile à nettoyer à la main en tête de la ligne suivante.
 *
 * Sélection VIDE (ou réduite à des espaces) : les deux marqueurs sont posés et le curseur va ENTRE eux,
 * prêt à taper. C'est le geste qu'on attend d'un bouton de mise en forme quand rien n'est sélectionné.
 */
export function entoure(texte: string, debut: number, fin: number, marqueur: string): Edition {
  let d = debut;
  let f = fin;
  while (d < f && /\s/.test(texte[d]!)) d += 1;
  while (f > d && /\s/.test(texte[f - 1]!)) f -= 1;
  return {
    texte: `${texte.slice(0, d)}${marqueur}${texte.slice(d, f)}${marqueur}${texte.slice(f)}`,
    debut: d + marqueur.length,
    fin: f + marqueur.length,
  };
}

/**
 * Insère au CURSEUR, jamais à la fin.
 *
 * Un smiley ajouté en bout de texte oblige à le déplacer à la main : c'est le genre de détail qui fait
 * abandonner une fonctionnalité. Une sélection non vide est remplacée, comme le ferait une frappe.
 */
export function insere(texte: string, debut: number, fin: number, ajout: string): Edition {
  const position = debut + ajout.length;
  return {
    texte: `${texte.slice(0, debut)}${ajout}${texte.slice(fin)}`,
    debut: position,
    fin: position,
  };
}
