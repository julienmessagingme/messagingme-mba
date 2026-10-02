import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

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
