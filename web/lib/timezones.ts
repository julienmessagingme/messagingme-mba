// Liste curée de fuseaux horaires pour le sélecteur des Paramètres. Module PUR (importable depuis la suite racine).
// On STOCKE le fuseau IANA (ex. 'Europe/Paris') -> l'heure d'été est gérée à l'évaluation ; on AFFICHE « (GMT+1)
// Paris » (offset de l'heure normale, comme les sélecteurs d'OS ; l'offset réel varie avec l'heure d'été, c'est
// voulu et correct). Un représentant par grand offset ; le serveur, lui, accepte tout IANA valide (via Intl).

import type { Locale } from './locale';

export interface TimezoneOption {
  /** Identifiant IANA stocké et utilisé pour tous les calculs (DST-correct). */
  iana: string;
  /**
   * Ville affichée, en paire `[fr, en]` — TOUJOURS, même quand les deux sont identiques (`['Paris', 'Paris']`).
   * Un type mixte obligerait à brancher à chaque lecture, et c'est la convention du dépôt (`NODE_META`).
   * Les exonymes, eux, diffèrent vraiment : « Londres » n'a rien à faire dans une console en anglais.
   */
  city: [string, string];
  /** Offset de l'heure NORMALE, pour l'affichage seulement (ex. 'GMT+1'). */
  gmt: string;
}

export const DEFAULT_TIMEZONE = 'Europe/Paris';

export const TIMEZONES: TimezoneOption[] = [
  { iana: 'Pacific/Midway', city: ['Midway', 'Midway'], gmt: 'GMT-11' },
  { iana: 'Pacific/Honolulu', city: ['Honolulu', 'Honolulu'], gmt: 'GMT-10' },
  { iana: 'America/Anchorage', city: ['Anchorage', 'Anchorage'], gmt: 'GMT-9' },
  { iana: 'America/Los_Angeles', city: ['Los Angeles', 'Los Angeles'], gmt: 'GMT-8' },
  { iana: 'America/Denver', city: ['Denver', 'Denver'], gmt: 'GMT-7' },
  { iana: 'America/Chicago', city: ['Chicago', 'Chicago'], gmt: 'GMT-6' },
  { iana: 'America/New_York', city: ['New York', 'New York'], gmt: 'GMT-5' },
  { iana: 'America/Halifax', city: ['Halifax', 'Halifax'], gmt: 'GMT-4' },
  { iana: 'America/Sao_Paulo', city: ['São Paulo', 'Sao Paulo'], gmt: 'GMT-3' },
  { iana: 'Atlantic/South_Georgia', city: ['Géorgie du Sud', 'South Georgia'], gmt: 'GMT-2' },
  { iana: 'Atlantic/Azores', city: ['Açores', 'Azores'], gmt: 'GMT-1' },
  { iana: 'Europe/London', city: ['Londres', 'London'], gmt: 'GMT+0' },
  { iana: 'Europe/Paris', city: ['Paris', 'Paris'], gmt: 'GMT+1' },
  { iana: 'Europe/Athens', city: ['Athènes', 'Athens'], gmt: 'GMT+2' },
  { iana: 'Europe/Moscow', city: ['Moscou', 'Moscow'], gmt: 'GMT+3' },
  { iana: 'Asia/Dubai', city: ['Dubaï', 'Dubai'], gmt: 'GMT+4' },
  { iana: 'Asia/Karachi', city: ['Karachi', 'Karachi'], gmt: 'GMT+5' },
  { iana: 'Asia/Dhaka', city: ['Dacca', 'Dhaka'], gmt: 'GMT+6' },
  { iana: 'Asia/Bangkok', city: ['Bangkok', 'Bangkok'], gmt: 'GMT+7' },
  { iana: 'Asia/Shanghai', city: ['Shanghai', 'Shanghai'], gmt: 'GMT+8' },
  { iana: 'Asia/Tokyo', city: ['Tokyo', 'Tokyo'], gmt: 'GMT+9' },
  { iana: 'Australia/Sydney', city: ['Sydney', 'Sydney'], gmt: 'GMT+10' },
  { iana: 'Pacific/Noumea', city: ['Nouméa', 'Noumea'], gmt: 'GMT+11' },
  { iana: 'Pacific/Auckland', city: ['Auckland', 'Auckland'], gmt: 'GMT+12' },
];

/** Libellé complet d'une option (« (GMT+1) Paris »), dans la langue de la console. */
export function timezoneLabel(o: TimezoneOption, locale: Locale): string {
  const ville = locale === 'en' ? o.city[1] : o.city[0];
  return `(${o.gmt}) ${ville}`;
}

