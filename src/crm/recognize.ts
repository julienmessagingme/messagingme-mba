import { slugify } from './fields';

export interface ColumnSuggestion {
  header: string;
  target: 'phone' | 'name' | 'custom';
  /** Key du champ perso proposé quand target === 'custom'. */
  suggestedKey?: string;
}

function norm(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Attributs standard (colonnes du contact).
const STANDARD: Record<'phone' | 'name', string[]> = {
  phone: ['phone', 'telephone', 'tel', 'mobile', 'portable', 'whatsapp', 'gsm', 'msisdn', 'phone number', 'mobile number', 'numero de telephone', 'numero mobile'],
  // `name` = nom d'affichage (profile_name). Le prénom est traité à part pour ne PAS écraser le
  // nom quand le CSV a les deux colonnes.
  name: ['name', 'nom', 'fullname', 'contact', 'full name', 'nom complet', 'lastname', 'last name', 'nom de famille'],
};
// Prénom -> champ perso `prenom`. Vérifié AVANT `name` (« first name » contient le token « name »).
const PRENOM = ['prenom', 'firstname', 'first name', 'given name'];
// Alias ambigus : ne matchent phone QUE si le header normalisé est EXACTEMENT ça
// (`numéro` seul -> phone, mais `numéro de commande` -> custom).
const PHONE_EXACT = ['numero', 'number', 'num'];
// Champs perso à key normalisée (reconnus mais stockés en custom).
const CUSTOM_KEYS: Record<string, string[]> = {
  email: ['email', 'mail', 'courriel', 'e mail', 'adresse mail'],
};

function matches(normalized: string, alias: string): boolean {
  // alias multi-mots : sous-chaîne ; alias mono-mot : match d'un token entier.
  if (alias.includes(' ')) return normalized.includes(alias);
  return normalized.split(' ').includes(alias);
}

/** Suggère une cible pour chaque en-tête CSV (alias FR + EN). */
export function recognizeColumns(headers: string[]): ColumnSuggestion[] {
  return headers.map((header) => {
    const n = norm(header);
    if (STANDARD.phone.some((a) => matches(n, a)) || PHONE_EXACT.includes(n)) {
      return { header, target: 'phone' };
    }
    if (PRENOM.some((a) => matches(n, a))) {
      return { header, target: 'custom', suggestedKey: 'prenom' };
    }
    if (STANDARD.name.some((a) => matches(n, a))) {
      return { header, target: 'name' };
    }
    for (const [key, aliases] of Object.entries(CUSTOM_KEYS)) {
      if (aliases.some((a) => matches(n, a))) return { header, target: 'custom', suggestedKey: key };
    }
    return { header, target: 'custom', suggestedKey: slugify(header) };
  });
}
