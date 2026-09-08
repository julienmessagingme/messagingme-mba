/**
 * Ce qui s'affiche dans l'aperçu d'un post de chaîne, et ce qui autorise à publier.
 *
 * 🔴 POURQUOI CE MODULE EXISTE PLUTÔT QUE DE VIVRE DANS LE `.tsx`. Le vitest du front n'inclut que
 * `lib/**\/*.test.ts` (`web/vitest.config.ts`) : un composant ne s'y teste pas, il se teste en Playwright
 * depuis une page montée. Sortir les décisions ici (y a-t-il un bouton ? cette image est-elle affichable ?
 * ce brouillon est-il publiable ?) les rend vérifiables tout de suite, et laisse aux `.tsx` ce qu'ils font
 * bien seuls : du balisage.
 *
 * 🔴 CE MODULE NE FABRIQUE AUCUNE ADRESSE. Le lien `wa.me` et le texte pré-remplis sont composés par le
 * SERVEUR et arrivent tout faits dans `LienChaine.waMeUrl` et `LienChaine.texteRempli`. Une adresse `wa.me`
 * part dans des messages publics irrattrapables : deux compositions de la même adresse divergeraient au
 * premier ajustement, et la seconde partirait quand même.
 */

import { MAX_PHRASE, MAX_TEXTE_POST } from './api-chaine';

/**
 * Le libellé du bouton, tel que WhatsApp le DESSINE, et que personne ne choisit.
 *
 * 🔴 Mesuré, pas supposé : aucun champ d'API ne contrôle ce bouton. WhatsApp le rend à partir d'une adresse
 * `wa.me` présente dans le texte du post, et son libellé n'est pas modifiable. Le paramètre `text=` de
 * l'adresse n'est PAS ce libellé : c'est le message que l'abonné ENVOIE en appuyant. La constante est donc
 * un rappel d'aperçu, jamais une valeur qu'on transmettrait à quiconque.
 */
export const LIBELLE_BOUTON_DISCUTER = 'Discuter';

export type MorceauApercu =
  | { kind: 'texte'; contenu: string }
  | { kind: 'lien'; contenu: string }
  | { kind: 'bouton'; contenu: string };

export interface BrouillonChaine {
  texte: string;
  imageUrl: string;
  /** L'identifiant du LIEN rattaché, pas du scénario. Chaîne vide = publication sans bouton. */
  linkId: string;
}

/** Ce que le serveur intercale entre le corps et l'adresse, cf. `src/http/channels-me.ts`. */
const SEPARATEUR_LIEN = '\n\n';

/**
 * Une adresse `wa.me` EN FIN de texte, precedee du separateur du serveur. Ancree a la fin (`$`) : un client
 * qui cite sa propre adresse au milieu de son texte ne doit rien perdre.
 */
const FIN_LIEN_WA_ME = new RegExp(SEPARATEUR_LIEN + 'https://wa\\.me/\\S*$');


/**
 * Ce que l'abonné verra, dans l'ordre.
 *
 * 🔴 LA COMPOSITION EST CELLE DU SERVEUR, recopiée d'un seul endroit : `src/http/channels-me.ts` fait
 * `texteDuPost = `${text}\n\n${url}``. Un aperçu qui montrerait autre chose (le lien avant le texte, une
 * seule ligne de séparation) mentirait sur ce qui part, et le client ne s'en apercevrait qu'une fois le post
 * diffusé, donc trop tard.
 */
export function morceauxApercu(texte: string, waMeUrl: string | null): MorceauApercu[] {
  const corps = texte.trim();
  const morceaux: MorceauApercu[] = [];
  if (corps !== '') morceaux.push({ kind: 'texte', contenu: corps });
  // Pas d'adresse, pas de bouton. C'est le cas d'un tenant sans numéro WhatsApp connecté, et celui d'une
  // publication volontairement sans scénario : les deux doivent montrer un post NU, pas un bouton mort.
  if (waMeUrl !== null && waMeUrl !== '') {
    morceaux.push({ kind: 'lien', contenu: waMeUrl });
    morceaux.push({ kind: 'bouton', contenu: LIBELLE_BOUTON_DISCUTER });
  }
  return morceaux;
}

/**
 * L'image est-elle montrable dans l'aperçu, et acceptable par le serveur ?
 *
 * Rend l'adresse quand elle passe, `null` sinon. La garde reproduit celle du serveur (`urlRecuperable` plus
 * protocole `https:`), en plus lâche : elle ne résout aucun nom. Ce n'est pas un contrôle de sécurité, c'est
 * un message d'erreur donné avant l'envoi plutôt qu'après un 400. La vraie garde reste côté serveur.
 */
export function imageAffichable(url: string): string | null {
  const brut = url.trim();
  if (brut === '') return null;
  if (brut.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(brut);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  // Les hôtes que le serveur refuse de toute façon. On les nomme pour que le refus soit compréhensible tout
  // de suite, au lieu d'un 400 générique une fois le formulaire soumis.
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  return brut;
}

/** Le texte seul suffit-il à publier ? Un post sans bouton reste une publication parfaitement valable. */
export function pretAPublier(b: BrouillonChaine): boolean {
  const texte = b.texte.trim();
  if (texte === '' || texte.length > MAX_TEXTE_POST) return false;
  // Une image SAISIE mais invalide bloque : la publier telle quelle partirait en 400, et laisser le champ
  // rempli en ignorant sa valeur ferait croire que l'image est partie.
  if (b.imageUrl.trim() !== '' && imageAffichable(b.imageUrl) === null) return false;
  return true;
}

/** Une phrase d'accroche est-elle acceptable pour créer un lien ? Le scénario est choisi ailleurs. */
export function phraseAcceptable(phrase: string): boolean {
  const p = phrase.trim();
  return p !== '' && p.length <= MAX_PHRASE;
}

/**
 * Combien de caractères reste-t-il, et faut-il le dire ?
 *
 * On n'affiche le compteur qu'en approche de la borne : un compteur permanent sur un champ de 4096
 * caractères est du bruit, et il détourne l'attention de ce qui compte (le texte lui-même).
 */
export function resteAAfficher(longueur: number, max: number): number | null {
  const reste = max - longueur;
  return reste <= Math.max(20, Math.floor(max * 0.1)) ? reste : null;
}

/**
 * Le CORPS d'un post deja publie, sans l'adresse wa.me que le serveur lui a collee.
 *
 * 🔴 POURQUOI CETTE FONCTION EXISTE. Le texte STOCKE d'un post vaut `corps + deux sauts de ligne + adresse`
 * (composition du serveur, `src/http/channels-me.ts`). L'apercu, lui, ne met en forme que le CORPS : il
 * recoit le brouillon et l'adresse separement. Donner le texte entier au formateur n'est donc pas « le meme
 * rendu que l'apercu », c'est un autre traitement sur une autre entree, avec deux consequences reelles :
 * l'adresse traverse les regles de mise en forme, et sa longueur compte dans le plafond d'analyse, qu'un
 * post au corps maximal depasse alors qu'il est parfaitement legitime.
 *
 * On retire l'adresse EXACTE et seulement si elle est bien en fin de texte : un corps qui contiendrait la
 * meme chaine ailleurs n'est pas touche. Adresse inconnue (lien supprime, post sans bouton) : on rend le
 * texte tel quel, ce qui est le comportement honnete.
 */
export function corpsDuPost(texte: string, waMeUrl: string | null): string {
  const t = texte ?? '';
  // Le cas courant : l'adresse actuelle du lien, retiree a l'identique.
  if (waMeUrl !== null && waMeUrl !== '') {
    const suffixe = SEPARATEUR_LIEN + waMeUrl;
    if (t.endsWith(suffixe)) return t.slice(0, t.length - suffixe.length).trim();
  }
  // 🔴 ET LES POSTS D'AVANT LE 2026-09-07, dont l'adresse n'est PLUS celle que le serveur recompose. Leur
  // texte pre-rempli portait le jeton (`phrase (cm-xxxx)`), donc leur adresse encodee differe de celle
  // d'aujourd'hui, qui ne porte que la phrase. Une comparaison exacte ne les reconnaissait pas : ces posts
  // affichaient leur adresse entiere dans la liste, elle passait dans le formateur, et sa longueur entrait
  // dans le plafond d'analyse. Ils circulent pour toujours et ne peuvent plus etre modifies, donc c'est
  // l'affichage qui doit savoir les lire.
  return t.replace(FIN_LIEN_WA_ME, '').trim();
}
