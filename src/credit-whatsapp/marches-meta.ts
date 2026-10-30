/**
 * LES MARCHÉS DE LA GRILLE DE META (page Pricing de Meta, relevée le 2026-10-30) : 39 pays nommés et 8 régions. Un pays
 * absent de la liste est facturé au marché « Other ». Meta facture selon l'indicatif du destinataire : les territoires
 * qui partagent l'indicatif d'un pays listé (Guernesey et le Royaume-Uni au +44, Åland et la Finlande au +358...) suivent
 * ce pays. Une grille dont un marché n'est pas ici est refusée au chargement : Meta a changé sa liste, ce fichier suit.
 */
export interface MarcheMeta {
  /** La clé interne : le code ISO d'un pays nommé, ou un nom de région. */
  cle: string;
  /** Le nom du marché dans le fichier de Meta (anglais). */
  nom: string;
  /** Les pays (ISO 3166) que Meta range dans ce marché. */
  pays: readonly string[];
  /** Les territoires qui partagent l'indicatif d'un de ces pays, sans être listés par Meta. */
  memeIndicatif?: readonly string[];
}

const NOMMES: ReadonlyArray<[string, string]> = [
  ['AR', 'Argentina'], ['BD', 'Bangladesh'], ['BR', 'Brazil'], ['CL', 'Chile'], ['CO', 'Colombia'], ['EG', 'Egypt'],
  ['FR', 'France'], ['DE', 'Germany'], ['HK', 'Hong Kong'], ['HU', 'Hungary'], ['IN', 'India'], ['ID', 'Indonesia'],
  ['IL', 'Israel'], ['IQ', 'Iraq'], ['IT', 'Italy'], ['KZ', 'Kazakhstan'], ['KW', 'Kuwait'], ['MY', 'Malaysia'],
  ['MX', 'Mexico'], ['MA', 'Morocco'], ['NP', 'Nepal'], ['NL', 'Netherlands'], ['NG', 'Nigeria'], ['OM', 'Oman'],
  ['PK', 'Pakistan'], ['PE', 'Peru'], ['PL', 'Poland'], ['QA', 'Qatar'], ['RO', 'Romania'], ['RU', 'Russia'],
  ['SA', 'Saudi Arabia'], ['SG', 'Singapore'], ['LK', 'Sri Lanka'], ['ZA', 'South Africa'], ['ES', 'Spain'],
  ['TR', 'Turkey'], ['UA', 'Ukraine'], ['AE', 'United Arab Emirates'], ['GB', 'United Kingdom'],
];

/** Les territoires au même indicatif qu'un pays nommé. */
const MEME_INDICATIF_NOMMES: Readonly<Record<string, readonly string[]>> = {
  GB: ['GG', 'JE', 'IM'],
  IT: ['VA'],
  MA: ['EH'],
};

export const MARCHES_META: readonly MarcheMeta[] = [
  ...NOMMES.map(([cle, nom]) => ({ cle, nom, pays: [cle], ...(MEME_INDICATIF_NOMMES[cle] ? { memeIndicatif: MEME_INDICATIF_NOMMES[cle] } : {}) })),
  { cle: 'north_america', nom: 'North America', pays: ['CA', 'US'] },
  {
    cle: 'rest_of_africa',
    nom: 'Rest of Africa',
    pays: ['DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CM', 'TD', 'CG', 'ER', 'ET', 'GA', 'GM', 'GH', 'GW', 'CI', 'KE', 'LS', 'LR',
      'LY', 'MG', 'MW', 'ML', 'MR', 'MZ', 'NA', 'NE', 'RW', 'SN', 'SL', 'SO', 'SS', 'SD', 'SZ', 'TZ', 'TG', 'TN', 'UG', 'ZM', 'ZW'],
  },
  {
    cle: 'rest_of_asia_pacific',
    nom: 'Rest of Asia Pacific',
    pays: ['AF', 'AU', 'KH', 'CN', 'JP', 'LA', 'MN', 'NZ', 'PG', 'PH', 'TW', 'TJ', 'TH', 'TM', 'UZ', 'VN'],
    memeIndicatif: ['CX', 'CC'],
  },
  {
    cle: 'rest_of_central_eastern_europe',
    nom: 'Rest of Central & Eastern Europe',
    pays: ['AL', 'AM', 'AZ', 'BY', 'BG', 'HR', 'CZ', 'GE', 'GR', 'LV', 'LT', 'MD', 'MK', 'RS', 'SK', 'SI'],
  },
  {
    cle: 'rest_of_western_europe',
    nom: 'Rest of Western Europe',
    pays: ['AT', 'BE', 'DK', 'FI', 'IE', 'NO', 'PT', 'SE', 'CH'],
    memeIndicatif: ['AX', 'SJ'],
  },
  {
    cle: 'rest_of_latin_america',
    nom: 'Rest of Latin America',
    pays: ['BO', 'CR', 'DO', 'EC', 'SV', 'GT', 'HT', 'HN', 'JM', 'NI', 'PA', 'PY', 'PR', 'UY', 'VE'],
  },
  { cle: 'rest_of_middle_east', nom: 'Rest of Middle East', pays: ['BH', 'JO', 'LB', 'YE'] },
  { cle: 'other', nom: 'Other', pays: [] },
];

/** Le marché de tout pays que la liste ne nomme pas. */
export const MARCHE_AUTRES = 'other';

const PAR_PAYS: ReadonlyMap<string, string> = new Map(
  MARCHES_META.flatMap((m) => [...m.pays, ...(m.memeIndicatif ?? [])].map((p) => [p, m.cle] as const)),
);

/** Le nom d'un marché, ramené à une forme comparable : « Rest of Central & Eastern Europe », « rest of central and eastern europe ». */
function cleDeNom(nom: string): string {
  return nom
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const PAR_NOM: ReadonlyMap<string, string> = new Map(MARCHES_META.map((m) => [cleDeNom(m.nom), m.cle] as const));

/** Le marché de Meta d'un pays (ISO 3166, celui que rend `paysDuNumero`) ; un pays inconnu ou absent va à « Other ». */
export function marcheDuPays(pays: string | null): string {
  if (pays === null) return MARCHE_AUTRES;
  return PAR_PAYS.get(pays.toUpperCase()) ?? MARCHE_AUTRES;
}

/** Le marché que nomme le fichier de Meta, ou `null` s'il n'est pas dans la liste (le chargement le refuse alors). */
export function marcheDuNom(nom: string): string | null {
  return PAR_NOM.get(cleDeNom(nom)) ?? null;
}
