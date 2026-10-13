/**
 * Ce que la console et le serveur disent pareil de l'agent de Meta : les fichiers de connaissance qu'il accepte, le
 * titre et les bornes d'une consigne (« skill »), le prix public d'une réponse. La console refuse tout de suite ce que
 * Meta refusera ; le serveur le refuse en dernier ressort.
 */

/**
 * Type MIME accepté vers l'extension que le nom du fichier doit porter. La liste vient du SCHÉMA de Meta, pas de sa
 * prose : `.txt` et `.md` en sont absents, même si la description de l'API parle de « text documents ».
 */
export const EXTENSIONS_FICHIER: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** `.jpeg` est la même chose que `.jpg` côté Meta : les deux sont acceptés à l'écriture du nom. */
const EXTENSIONS_EQUIVALENTES: Readonly<Record<string, readonly string[]>> = { jpg: ['jpg', 'jpeg'] };

/** Meta accepte 100 Mo, mais le corps transite en base64 (+33 %) : le serveur plafonne plus bas, à 20 Mo. */
export const MAX_FICHIER = 20 * 1024 * 1024;

/** Le nom du fichier porte-t-il l'extension qui correspond à son type déclaré ? */
export function extensionCoherente(fileName: string, mime: string): boolean {
  const attendue = EXTENSIONS_FICHIER[mime.toLowerCase()];
  if (attendue === undefined) return false;
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  return (EXTENSIONS_EQUIVALENTES[attendue] ?? [attendue]).includes(ext);
}

export function tailleFichierOk(octets: number): boolean {
  return octets > 0 && octets <= MAX_FICHIER;
}

/** Titre d'une consigne : minuscules, chiffres et tirets, sans tiret aux extrémités. Règle de Meta, refusée en 400. */
export const TITRE_SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TITRE_SKILL_MAX = 64;
export const DESCRIPTION_SKILL_MAX = 1024;
export const CORPS_SKILL_MAX = 20000;

export function titreSkillValide(titre: string): boolean {
  return titre.length > 0 && titre.length <= TITRE_SKILL_MAX && TITRE_SKILL_RE.test(titre);
}

/**
 * Les prix publics de Meta, en dollars, pour une ESTIMATION : 2 $ le million de jetons, et 20 000 à 25 000 jetons
 * annoncés par message (doc « non-template messages », relue le 2026-10-01). Aucune API ne rend le coût réel (mesuré
 * le 2026-10-01) : la facture du Billing Hub fait foi, et l'écran le dit.
 */
export const PRIX_JETONS_USD_PAR_MILLION = 2;
export const PRIX_MESSAGE_AGENT_USD = { min: 0.04, max: 0.05 } as const;
