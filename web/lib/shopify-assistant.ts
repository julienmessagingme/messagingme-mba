import type { Locale } from './locale';
import type { EtatShopifyVue } from './api-shopify';
import {
  DONNEES_PAR_EVENEMENT, DONNEES_SHOPIFY, EXEMPLES_DONNEES, LIBELLES_DONNEES, TEXTES_PROPOSES,
  type DonneeShopify, type EvenementShopify,
} from './partage/shopify-messages';

/**
 * L'ASSISTANT SHOPIFY DE LA CONSOLE, SA PARTIE SANS ÉCRAN (conception 2026-10-22) : le marchand écrit « {prénom} »,
 * le serveur attend « {{first_name}} ». La conversion vit ici, testée, et la carte n'en garde que l'affichage.
 *
 * Un repère s'écrit avec le libellé de la donnée, dans l'une ou l'autre langue de la console (« {prénom} » comme
 * « {first name} ») : un texte collé depuis une console en anglais reste lisible dans une console en français.
 */

const indice = (locale: Locale): 0 | 1 => (locale === 'en' ? 1 : 0);

/** Le repère d'une donnée tel que le marchand le lit et l'écrit : `{prénom}`. */
export function repere(donnee: DonneeShopify, locale: Locale): string {
  return `{${LIBELLES_DONNEES[donnee][indice(locale)]}}`;
}

// NFC : un « é » collé en deux points de code (e + accent) est le même repère que celui qu'on tape (relecture du lot 3).
const normaliser = (s: string): string => s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

/** Un libellé, dans l'une des deux langues, ou le nom technique, vers sa donnée. */
function donneeDuRepere(contenu: string): DonneeShopify | null {
  const c = normaliser(contenu);
  for (const d of DONNEES_SHOPIFY) {
    if (c === d || c === normaliser(LIBELLES_DONNEES[d][0]) || c === normaliser(LIBELLES_DONNEES[d][1])) return d;
  }
  return null;
}

export type Conversion = { ok: true; texte: string } | { ok: false; inconnus: string[]; horsEvenement: string[] };

/**
 * Le texte du marchand vers celui du serveur : chaque `{libellé}` devient `{{donnée}}`. Un repère que personne ne
 * connaît, ou une donnée que cet événement ne sait pas remplir (le lien du panier dans une commande payée), est
 * signalé AVANT l'envoi : parti tel quel, il arriverait au client en toutes lettres.
 */
export function versTexteServeur(texte: string, evenement: EvenementShopify): Conversion {
  const inconnus: string[] = [];
  const horsEvenement: string[] = [];
  const permises: readonly string[] = DONNEES_PAR_EVENEMENT[evenement];
  const converti = texte.replace(/\{\{?\s*([^{}]+?)\s*\}?\}/g, (tout, contenu: string) => {
    const d = donneeDuRepere(contenu);
    if (d === null) { inconnus.push(tout); return tout; }
    if (!permises.includes(d)) { horsEvenement.push(tout); return tout; }
    return `{{${d}}}`;
  });
  return inconnus.length > 0 || horsEvenement.length > 0 ? { ok: false, inconnus, horsEvenement } : { ok: true, texte: converti };
}

/** Le texte du serveur (`{{first_name}}`) vers celui du marchand (`{prénom}`). */
export function versTexteAffiche(texteServeur: string, locale: Locale): string {
  return texteServeur.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (tout, cle: string) =>
    ((DONNEES_SHOPIFY as readonly string[]).includes(cle) ? repere(cle as DonneeShopify, locale) : tout));
}

/** Le corps d'un modèle chez Meta (`{{1}}`, `{{2}}`) et ses données, vers le texte du marchand. */
export function texteDuModele(corps: string, variables: readonly string[], locale: Locale): string {
  return corps.replace(/\{\{\s*(\d+)\s*\}\}/g, (tout, n: string) => {
    const d = variables[Number(n) - 1];
    return d !== undefined && (DONNEES_SHOPIFY as readonly string[]).includes(d) ? repere(d as DonneeShopify, locale) : tout;
  });
}

/** Le texte proposé d'un message, dans la langue du modèle, avec les repères de la console. */
export function textePropose(evenement: EvenementShopify, langue: 'fr' | 'en', locale: Locale): string {
  return versTexteAffiche(TEXTES_PROPOSES[evenement][langue], locale);
}

export type EtatMessage =
  | 'a_regler'
  | 'en_validation'
  | 'actif'
  | 'actif_nouvelle_version'
  | 'arrete'
  | 'arrete_nouvelle_version'
  | 'en_pause';

/**
 * L'état d'un message sur la carte. Une attente PASSE DEVANT un message arrêté (elle le remplacera) mais pas devant
 * un message actif : l'ancien continue de partir pendant la validation du nouveau (conception, « Modifier un message
 * actif ne l'arrête pas »). Une relance active dont l'affirmation du consentement a été retirée est EN PAUSE : rien ne
 * part tant qu'elle n'est pas affirmée de nouveau (les gardes du serveur), et la carte doit le dire.
 */
export function etatDuMessage(vue: Pick<EtatShopifyVue, 'messages' | 'attentes' | 'boutique'>, evenement: EvenementShopify): EtatMessage {
  const m = vue.messages.find((x) => x.evenement === evenement);
  const enAttente = vue.attentes.some((x) => x.evenement === evenement);
  if (!m) return enAttente ? 'en_validation' : 'a_regler';
  if (m.actif && evenement === 'checkout_abandoned' && !vue.boutique?.consentementLe) return 'en_pause';
  if (m.actif) return enAttente ? 'actif_nouvelle_version' : 'actif';
  return enAttente ? 'arrete_nouvelle_version' : 'arrete';
}

/** Le délai en clair : « 15 min », « 1 h », « 1 h 30 », « 24 h ». */
export function delaiEnClair(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

/** L'aperçu WhatsApp du texte du marchand : chaque repère connu remplacé par sa valeur d'exemple, le reste tel quel. */
export function apercuAffiche(texte: string): string {
  return texte.replace(/\{\{?\s*([^{}]+?)\s*\}?\}/g, (tout, contenu: string) => {
    const d = donneeDuRepere(contenu);
    return d === null ? tout : EXEMPLES_DONNEES[d];
  });
}
