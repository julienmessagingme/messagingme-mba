import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { parsePhoneNumberFromString as lireAvecTypes } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js';

/**
 * Les types de numéro que WhatsApp ne porte pas, partout : une ligne fixe, un numéro de service (gratuit, à coût
 * partagé, surtaxé). Mesurés avec les métadonnées complètes le 2026-10-27.
 */
const TYPES_SANS_WHATSAPP = new Set(['FIXED_LINE', 'TOLL_FREE', 'SHARED_COST', 'PREMIUM_RATE']);

/**
 * Un numéro FIXE au sens large, que WhatsApp ne porte pas (les workflows HubSpot, cadrage du 2026-10-27, décision 2) :
 * refusé avant d'écrire, plutôt qu'un échec de Meta invisible après. Seul un type certain compte : une plage « fixe ou
 * mobile » (États-Unis) ou un type inconnu passe. En France, le 09 (VOIP, une box) est une ligne fixe dans les faits ;
 * ailleurs une VOIP peut porter WhatsApp, elle passe. Le type demande les métadonnées complètes (`/max`), absentes de
 * l'import par défaut.
 */
export function estUnFixe(e164: string): boolean {
  const n = lireAvecTypes(e164);
  const type = n?.getType();
  if (type === undefined) return false;
  return TYPES_SANS_WHATSAPP.has(type) || (type === 'VOIP' && n?.country === 'FR');
}

export interface PhoneResult {
  e164?: string;
  error?: string;
}

/** Normalise un numéro en E.164 (défaut FR : 06/07/+33/0033, espaces/points tolérés). */
export function normalizePhone(raw: string, defaultCountry: CountryCode = 'FR'): PhoneResult {
  // Robuste aux valeurs non-string (l'API publique ne doit pas jeter).
  const trimmed = (typeof raw === 'string' ? raw : String(raw ?? '')).trim();
  if (!trimmed) return { error: 'numéro vide' };
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return { error: `numéro invalide: ${raw}` };
  return { e164: parsed.number };
}

/**
 * Le PAYS d'un numéro (code ISO 3166 à deux lettres, `FR`), déduit de son indicatif et de ses premiers chiffres,
 * ou `null`. Sert le champ système « pays de l'indicatif » du bloc Condition (RC5).
 *
 * ⚠️ Un indicatif partagé se départage par les chiffres qui suivent : `+44 7911` est un mobile de Guernesey (`GG`),
 * `+44 7400` du Royaume-Uni (`GB`), `+1 613` le Canada. Un numéro que la bibliothèque ne sait rattacher à aucun pays
 * (plage inconnue) rend `null`, jamais un pays deviné sur l'indicatif seul.
 */
export function paysDuNumero(numero: string | null | undefined): string | null {
  const brut = typeof numero === 'string' ? numero.trim() : '';
  if (brut === '') return null;
  // Le E.164 de la fiche porte son « + » ; un identifiant WhatsApp (l'indicatif sans « + ») le reçoit ici.
  return parsePhoneNumberFromString(brut.startsWith('+') ? brut : `+${brut}`)?.country ?? null;
}

/**
 * Un numéro tel qu'un APPELANT le donne, vers le E.164 de la fiche, ou `null`. Trois formes arrivent : un identifiant
 * WhatsApp (l'indicatif, sans « + » : `33612345678`, c'est ce que le relais de l'agent de Meta pose depuis la
 * conversation), un E.164, ou un numéro national (`06 12 34 56 78`, pays par défaut).
 * 🔴 L'identifiant WhatsApp se tente AVANT le national : lu comme un numéro français, `33612345678` serait invalide,
 * et un `get_contact` cherchait le texte tel quel dans `phone_e164`, donc ne trouvait jamais la fiche (2026-10-02).
 * Un national sans son 0 (`612345678`) retombe sur le pays par défaut quand le « + » ne donne rien de valide.
 */
export function e164DepuisSaisie(raw: string, defaultCountry: CountryCode = 'FR'): string | null {
  const compact = (typeof raw === 'string' ? raw : '').trim().replace(/[\s.()-]/g, '');
  if (/^\d{8,15}$/.test(compact) && !compact.startsWith('0')) {
    const international = normalizePhone(`+${compact}`, defaultCountry).e164;
    if (international) return international;
  }
  return normalizePhone(raw, defaultCountry).e164 ?? null;
}
