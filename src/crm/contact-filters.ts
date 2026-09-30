import { NIVEAUX_RISQUE, type NiveauRisque } from '../engagement/risque';
import { isContactFieldOp, type ContactFieldFilter, type ContactFilters } from './contact-store.pg';
import { champFiche } from './champs-fiche';
import { estCleFiltrable, estOperateurFicheSeul, lireFiltreFiche } from './filtre-fiche';

/**
 * Construction d'un `ContactFilters` à partir de données non fiables. Deux entrées : les query params d'une URL
 * (`parseFilters`) et le corps JSON d'une action en masse (`normalizeContactFilters`). Le décodage diffère, les
 * règles (bornes, opérateurs, plafonds) sont ici, communes : sinon un même filtre affiché viserait deux
 * populations différentes.
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
 * Filtres de champ normalisés. Chaque élément doit être un objet portant une `key` texte. Les éléments non-objets
 * (`[null]` d'un corps JSON hostile) sont écartés avant lecture, sinon la route tombe en 500 sur `f.key`.
 *
 * Deux régimes. Un champ PERSO : un opérateur inconnu retombe sur `eq`, et `empty`/`not_empty` n'ont pas de valeur.
 * Un champ de la DERNIÈRE ANALYSE : 🔴 rien n'est deviné, un opérateur ou une valeur invalide lève
 * `FiltreContactInvalide` (400), comme le niveau de risque. Ramené à `eq`, « urgence au moins 7 » deviendrait
 * « urgence égale à 7 », et une valeur jetée rendrait tout l'espace. Le sujet (texte libre) n'est pas filtrable, et
 * un opérateur de colonne n'a pas de sens sur un champ perso : refusés aussi.
 */
export function normalizeFieldFilters(raw: unknown[]): ContactFieldFilter[] {
  return raw
    .filter((f): f is { key?: unknown; op?: unknown; value?: unknown } => f !== null && typeof f === 'object' && !Array.isArray(f))
    .filter((f) => typeof f.key === 'string')
    .slice(0, MAX_FIELD_FILTERS)
    .map((f): ContactFieldFilter => {
      const key = String(f.key).slice(0, MAX_FIELD_KEY);
      if (estCleFiltrable(key)) {
        const lu = lireFiltreFiche(key, f.op, typeof f.value === 'string' ? f.value.slice(0, MAX_FIELD_VALUE) : f.value);
        if (!lu.ok) throw new FiltreContactInvalide(lu.raison);
        return { key, op: lu.filtre.op, value: lu.filtre.valeur };
      }
      if (champFiche(key)?.provenance === 'analyse') {
        throw new FiltreContactInvalide(`« ${champFiche(key)!.libelle[0]} » n’est pas filtrable`);
      }
      if (estOperateurFicheSeul(f.op)) {
        throw new FiltreContactInvalide(`opérateur « ${f.op} » réservé aux champs de la dernière analyse`);
      }
      return {
        key,
        op: isContactFieldOp(f.op) ? f.op : 'eq',
        value: typeof f.value === 'string' ? String(f.value).slice(0, MAX_FIELD_VALUE) : '',
      };
    });
}

/** Entrées déjà décodées par l'appelant (chacun sait lire sa forme), avant les règles communes. */
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
 * Un filtre de contacts refusé plutôt qu'ignoré. `statusCode` le fait rendre en 400 par le gestionnaire
 * d'erreurs de `src/server.ts`, avec ce message, par toutes les routes qui lisent des filtres : aucune ne peut
 * l'oublier et rendre une liste.
 */
export class FiltreContactInvalide extends Error {
  readonly statusCode = 400;
}

/**
 * Le niveau de risque demandé : absent, ou l'un des quatre niveaux. 🔴 Toute autre valeur est refusée, à
 * l'inverse du reste du module : un niveau mal orthographié jeté en silence rendrait tout l'espace à qui
 * demandait « risque élevé », et une campagne construite dessus partirait à tout le monde. Chaîne vide = « tous ».
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
    // Une seule valeur reconnue, le reste est jeté : une donnée à moitié comprise viserait la mauvaise population.
    // Seul le niveau de risque refuse au lieu de jeter (cf. `risqueFiltre`).
    ...(e.joignabilite === 'connu_injoignable' ? { joignabiliteWhatsApp: 'connu_injoignable' as const } : {}),
    ...(risque !== undefined ? { risque } : {}),
    ...(e.fieldFilters.length > 0 ? { fieldFilters: e.fieldFilters } : {}),
  };
}
