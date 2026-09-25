import { NIVEAUX_RISQUE, type NiveauRisque } from '../engagement/risque';
import { isContactFieldOp, type ContactFieldFilter, type ContactFilters } from './contact-store.pg';

/**
 * Construction d'un `ContactFilters` à partir de données NON FIABLES.
 *
 * Deux points d'entrée l'alimentent : les query params d'une URL (`parseFilters`, où tout arrive en chaînes
 * CSV ou JSON) et le corps JSON d'une action en masse (`normalizeContactFilters`, où tout arrive en tableaux).
 * Le DÉCODAGE diffère donc légitimement, mais les RÈGLES qui suivent (bornes, whitelist d'opérateurs, plafonds,
 * champs retenus) étaient recopiées ligne à ligne des deux côtés : deux écrans de ciblage qui divergent au
 * premier ajustement, donc deux populations de destinataires différentes pour un même filtre affiché.
 */

/** Plafonds : ils bornent une donnée cliente, pas un choix d'ergonomie. */
const MAX_TAGS = 50;
const MAX_FIELD_FILTERS = 20;
const MAX_FIELD_KEY = 120;
const MAX_FIELD_VALUE = 500;

/** Chaîne utile (non vide après trim), sinon undefined. */
export function texteFiltre(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Liste de tags dédupliquée, sans vides, plafonnée. */
export function tagsFiltre(v: string[]): string[] {
  return [...new Set(v.map(String).map((s) => s.trim()).filter((s) => s !== ''))].slice(0, MAX_TAGS);
}

/**
 * Filtres de champ perso normalisés. Chaque élément doit être un objet portant une `key` texte ; un opérateur
 * inconnu retombe sur `eq` et `empty`/`not_empty` n'ont pas de valeur. Les éléments non-objets (`[null]` d'un
 * corps JSON hostile) sont écartés avant lecture, sinon la route tombe en 500 sur `f.key`.
 */
export function normalizeFieldFilters(raw: unknown[]): ContactFieldFilter[] {
  return raw
    .filter((f): f is { key?: unknown; op?: unknown; value?: unknown } => f !== null && typeof f === 'object' && !Array.isArray(f))
    .filter((f) => typeof f.key === 'string')
    .map((f): ContactFieldFilter => ({
      key: String(f.key).slice(0, MAX_FIELD_KEY),
      op: isContactFieldOp(f.op) ? f.op : 'eq',
      value: typeof f.value === 'string' ? String(f.value).slice(0, MAX_FIELD_VALUE) : '',
    }))
    .slice(0, MAX_FIELD_FILTERS);
}

/** Entrées déjà décodées par l'appelant (chacun sait lire SA forme), avant application des règles communes. */
export interface EntreesFiltres {
  tags: string[];
  tagMode: unknown;
  tagsExclude: string[];
  optIn: unknown;
  phonePrefix: unknown;
  phoneContains: unknown;
  nameSearch: unknown;
  joignabilite: unknown;
  risque: unknown;
  fieldFilters: ContactFieldFilter[];
}

/**
 * Un filtre de contacts qu'on REFUSE au lieu de l'ignorer. `statusCode` le fait rendre en 400 par le gestionnaire
 * d'erreurs de `src/server.ts`, avec ce message, par TOUTES les routes qui lisent des filtres (liste, compte,
 * identifiants, action en masse, suppression, cible d'une campagne) : aucune ne peut oublier de le traiter, et
 * celle qui l'oublierait rendrait quand même un refus, jamais une liste.
 */
export class FiltreContactInvalide extends Error {
  readonly statusCode = 400;
}

/**
 * Le niveau de risque demandé : absent, ou l'un des quatre niveaux.
 *
 * 🔴 TOUTE AUTRE VALEUR EST REFUSÉE, et c'est l'inverse du reste de ce module, délibérément. Ailleurs, une
 * valeur incomprise est jetée : le filtre ne se pose pas, et l'écran qui l'a demandé le voit. Ici, un niveau
 * mal orthographié (`élevé`, `high`, `eleve,moyen`) jeté en silence rendrait TOUT l'espace à qui demandait
 * « risque élevé », et une campagne construite dessus partirait à tout le monde. Une chaîne vide, elle, n'est pas
 * un filtre (le choix « tous » de l'écran).
 */
function risqueFiltre(v: unknown): NiveauRisque | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const estNiveau = (x: unknown): x is NiveauRisque => typeof x === 'string' && (NIVEAUX_RISQUE as readonly string[]).includes(x);
  if (estNiveau(v)) return v;
  throw new FiltreContactInvalide(`filtre de risque invalide : ${NIVEAUX_RISQUE.join(', ')}, ou rien`);
}

/** Assemble le `ContactFilters` final : seules les clés réellement renseignées y figurent. */
export function buildContactFilters(e: EntreesFiltres): ContactFilters {
  const optIn = texteFiltre(e.optIn);
  const tags = tagsFiltre(e.tags);
  const tagsExclude = tagsFiltre(e.tagsExclude);
  const risque = risqueFiltre(e.risque);
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(e.tagMode === 'or' ? { tagMode: 'or' as const } : {}),
    ...(tagsExclude.length > 0 ? { tagsExclude } : {}),
    ...(optIn === 'opted_in' || optIn === 'opted_out' || optIn === 'unknown' ? { optIn } : {}),
    ...(texteFiltre(e.phonePrefix) ? { phonePrefix: texteFiltre(e.phonePrefix) } : {}),
    ...(texteFiltre(e.phoneContains) ? { phoneContains: texteFiltre(e.phoneContains) } : {}),
    ...(texteFiltre(e.nameSearch) ? { nameSearch: texteFiltre(e.nameSearch) } : {}),
    // ⚠️ UNE SEULE VALEUR RECONNUE, le reste est JETÉ. C'est la règle de tout ce module : une donnée
    // cliente à moitié comprise viserait la mauvaise population, ce qui est pire que pas de filtre du tout.
    ...(e.joignabilite === 'connu_injoignable' ? { joignabiliteWhatsApp: 'connu_injoignable' as const } : {}),
    ...(risque !== undefined ? { risque } : {}),
    ...(e.fieldFilters.length > 0 ? { fieldFilters: e.fieldFilters } : {}),
  };
}
