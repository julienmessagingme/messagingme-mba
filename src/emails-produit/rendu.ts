import { escapeHtml } from '../crm/render';
import { DEFAULT_TIMEZONE } from '../settings/store.pg';
import { renderBrandedEmail } from '../support/email-templates';
import { variablesDe, type Langue, type ModeleEmail, type TexteEmail } from './catalogue';

/**
 * LE RENDU D'UN E-MAIL DU PRODUIT : un texte (celui de `/ops` ou celui d'origine) et des valeurs donnent un sujet, une
 * version texte et une version HTML dans la mise en page Messaging Me.
 *
 * 🔴 Toute valeur est échappée, et le texte lui-même aussi : Julien écrit du texte, jamais du HTML (décision du
 * 2026-10-14). Les paragraphes sont séparés par une ligne vide, un retour simple devient un saut de ligne.
 * Une variable sans valeur s'écrit vide plutôt que `{{nom}}` : un e-mail ne montre jamais une accolade au client.
 */

/** Les valeurs d'un envoi. `fuseau` (facultatif) : celui de l'espace, pour écrire les dates. */
export type Valeurs = Readonly<Record<string, string>>;

/** Le fuseau des dates, lu dans les valeurs sous ce nom réservé. */
export const CLE_FUSEAU = '_fuseau';

export interface Rendu {
  sujet: string;
  text: string;
  html: string;
}

export interface OptionsRendu {
  /** Le lien de désinscription de la personne, pour les catégories qui en portent un. */
  desinscription?: string;
}

const PHRASES: Record<Langue, { secours: string; pied: string; desinscription: string; desinscriptionTexte: string }> = {
  fr: {
    secours: 'Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :',
    pied: 'Messaging Me, la plateforme conversationnelle WhatsApp. Vous recevez cet e-mail en tant qu’administrateur de votre espace.',
    desinscription: 'Ne plus recevoir ces e-mails',
    desinscriptionTexte: 'Ne plus recevoir ces e-mails :',
  },
  en: {
    secours: 'If the button does not work, copy this link into your browser:',
    pied: 'Messaging Me, the WhatsApp conversational platform. You receive this e-mail as an administrator of your workspace.',
    desinscription: 'Stop receiving these e-mails',
    desinscriptionTexte: 'Stop receiving these e-mails:',
  },
};

/** Une date ISO écrite dans la langue et le fuseau ; une valeur illisible reste telle quelle. */
export function dateLisible(iso: string, langue: Langue, fuseau: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  const locale = langue === 'en' ? 'en-GB' : 'fr-FR';
  try {
    return d.toLocaleDateString(locale, { ...o, timeZone: fuseau });
  } catch {
    return d.toLocaleDateString(locale, { ...o, timeZone: DEFAULT_TIMEZONE });
  }
}

/** Les valeurs prêtes à écrire : les dates mises en forme, rien d'autre. Toujours en clair, jamais échappées. */
function valeursEcrites(m: ModeleEmail, valeurs: Valeurs, langue: Langue): Map<string, string> {
  const fuseau = valeurs[CLE_FUSEAU] || DEFAULT_TIMEZONE;
  const permises = variablesDe(m);
  const ecrites = new Map<string, string>();
  for (const [nom, v] of Object.entries(permises)) {
    const brute = valeurs[nom] ?? '';
    ecrites.set(nom, v.forme === 'date' && brute !== '' ? dateLisible(brute, langue, fuseau) : brute);
  }
  return ecrites;
}

/** Remplace les `{{nom}}` d'un texte en clair. Une variable inconnue ou sans valeur s'écrit vide. */
function remplir(texte: string, valeurs: ReadonlyMap<string, string>): string {
  return texte.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_m, nom: string) => valeurs.get(nom) ?? '');
}

/** Les paragraphes d'un corps rempli : séparés par une ligne vide, sans paragraphe vide. */
function paragraphes(corps: string): string[] {
  return corps.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '');
}

/** Un texte du sujet sur une ligne : un sujet ne porte jamais de retour (en-tête de l'e-mail). */
function uneLigne(t: string): string {
  return t.replace(/[\r\n]+/g, ' ').trim();
}

export function rendre(m: ModeleEmail, texte: TexteEmail, valeurs: Valeurs, langue: Langue, options: OptionsRendu = {}): Rendu {
  const ecrites = valeursEcrites(m, valeurs, langue);
  const phrases = PHRASES[langue];
  const sujet = uneLigne(remplir(texte.sujet, ecrites));
  const paras = paragraphes(remplir(texte.corps, ecrites));
  const bouton = texte.bouton
    ? { libelle: uneLigne(remplir(texte.bouton.libelle, ecrites)), lien: remplir(texte.bouton.lien, ecrites).trim() }
    : null;
  const boutonUtile = bouton && bouton.libelle !== '' && /^https?:\/\//i.test(bouton.lien) ? bouton : null;

  const text = [
    ...paras,
    ...(boutonUtile ? [`${boutonUtile.libelle} : ${boutonUtile.lien}`] : []),
    ...(options.desinscription ? [`${phrases.desinscriptionTexte} ${options.desinscription}`] : []),
  ].join('\n\n');

  const bodyHtml = paras
    .map((p) => `<p style="margin:0 0 14px 0;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
  const html = renderBrandedEmail({
    title: sujet,
    bodyHtml,
    ...(boutonUtile ? { ctaLabel: boutonUtile.libelle, ctaUrl: boutonUtile.lien } : {}),
    preheader: paras[1] ?? paras[0] ?? sujet,
    phrases: { lang: langue, secours: phrases.secours, pied: phrases.pied },
    ...(options.desinscription ? { desinscription: { texte: phrases.desinscription, url: options.desinscription } } : {}),
  });
  return { sujet, text, html };
}

/** Les valeurs d'exemple d'un modèle, pour l'aperçu et l'essai de `/ops`. */
export function valeursExemple(m: ModeleEmail): Record<string, string> {
  const valeurs: Record<string, string> = { [CLE_FUSEAU]: DEFAULT_TIMEZONE };
  for (const [nom, v] of Object.entries(variablesDe(m))) valeurs[nom] = v.exemple;
  return valeurs;
}
