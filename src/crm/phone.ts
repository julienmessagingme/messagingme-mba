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
