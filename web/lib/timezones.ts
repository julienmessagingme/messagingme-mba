// Liste curée de fuseaux horaires pour le sélecteur des Paramètres. Module PUR (importable depuis la suite racine).
// On STOCKE le fuseau IANA (ex. 'Europe/Paris') -> l'heure d'été est gérée à l'évaluation ; on AFFICHE « (GMT+1)
// Paris » (offset de l'heure normale, comme les sélecteurs d'OS ; l'offset réel varie avec l'heure d'été, c'est
// voulu et correct). Un représentant par grand offset ; le serveur, lui, accepte tout IANA valide (via Intl).

export interface TimezoneOption {
  /** Identifiant IANA stocké et utilisé pour tous les calculs (DST-correct). */
  iana: string;
  /** Ville affichée. */
  city: string;
  /** Offset de l'heure NORMALE, pour l'affichage seulement (ex. 'GMT+1'). */
  gmt: string;
}

export const DEFAULT_TIMEZONE = 'Europe/Paris';

export const TIMEZONES: TimezoneOption[] = [
  { iana: 'Pacific/Midway', city: 'Midway', gmt: 'GMT-11' },
  { iana: 'Pacific/Honolulu', city: 'Honolulu', gmt: 'GMT-10' },
  { iana: 'America/Anchorage', city: 'Anchorage', gmt: 'GMT-9' },
  { iana: 'America/Los_Angeles', city: 'Los Angeles', gmt: 'GMT-8' },
  { iana: 'America/Denver', city: 'Denver', gmt: 'GMT-7' },
  { iana: 'America/Chicago', city: 'Chicago', gmt: 'GMT-6' },
  { iana: 'America/New_York', city: 'New York', gmt: 'GMT-5' },
  { iana: 'America/Halifax', city: 'Halifax', gmt: 'GMT-4' },
  { iana: 'America/Sao_Paulo', city: 'São Paulo', gmt: 'GMT-3' },
  { iana: 'Atlantic/South_Georgia', city: 'Géorgie du Sud', gmt: 'GMT-2' },
  { iana: 'Atlantic/Azores', city: 'Açores', gmt: 'GMT-1' },
  { iana: 'Europe/London', city: 'Londres', gmt: 'GMT+0' },
  { iana: 'Europe/Paris', city: 'Paris', gmt: 'GMT+1' },
  { iana: 'Europe/Athens', city: 'Athènes', gmt: 'GMT+2' },
  { iana: 'Europe/Moscow', city: 'Moscou', gmt: 'GMT+3' },
  { iana: 'Asia/Dubai', city: 'Dubaï', gmt: 'GMT+4' },
  { iana: 'Asia/Karachi', city: 'Karachi', gmt: 'GMT+5' },
  { iana: 'Asia/Dhaka', city: 'Dacca', gmt: 'GMT+6' },
  { iana: 'Asia/Bangkok', city: 'Bangkok', gmt: 'GMT+7' },
  { iana: 'Asia/Shanghai', city: 'Shanghai', gmt: 'GMT+8' },
  { iana: 'Asia/Tokyo', city: 'Tokyo', gmt: 'GMT+9' },
  { iana: 'Australia/Sydney', city: 'Sydney', gmt: 'GMT+10' },
  { iana: 'Pacific/Noumea', city: 'Nouméa', gmt: 'GMT+11' },
  { iana: 'Pacific/Auckland', city: 'Auckland', gmt: 'GMT+12' },
];

/** Libellé complet d'une option (« (GMT+1) Paris »). */
export function timezoneLabel(o: TimezoneOption): string {
  return `(${o.gmt}) ${o.city}`;
}

/** Le fuseau fait-il partie de la liste proposée ? (le sélecteur ne propose que ceux-là). */
export function isKnownTimezone(iana: string): boolean {
  return TIMEZONES.some((o) => o.iana === iana);
}
