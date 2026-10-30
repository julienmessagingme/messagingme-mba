import { cheminValide, estScalaire, litChemin, valeurTexte } from './chemin';

/**
 * Ce qu'une règle de mapping peut viser, et comment on l'applique à un payload reçu. Module pur.
 * 🔴 On itère sur notre mapping, jamais sur les clés reçues (même doctrine que `web/lib/flow-mapping.ts`) : sinon
 * un tiers écrirait où il veut en nommant ses clés comme nos champs.
 */

/** Le téléphone, qui désigne le contact. Sans lui, un appel ne fait que s'enregistrer dans `last_payload`. */
export const CIBLE_TELEPHONE = 'sys:phone';
/** Le nom affiché : un attribut (`contacts.profile_name`), pas une clé de `contacts.fields`, sinon un doublon que
 *  personne ne lit. */
export const CIBLE_NOM = 'sys:name';
/** Tout le reste : `field:<clé technique>` ou `field:<code fld_...>`, résolu par `resolveFieldKey`. */
export const PREFIXE_CHAMP = 'field:';

/** Au-delà, ce n'est plus un mapping, c'est une erreur de manipulation. */
export const MAX_REGLES = 50;

export interface RegleMapping {
  /** Chemin dans le JSON reçu (`client.tel`, `lignes[0].prix`). */
  chemin: string;
  /** `sys:phone`, `sys:name`, ou `field:<ref>`. */
  cible: string;
}

/** Référence de champ portée par une cible `field:...`, ou null si ce n'en est pas une. */
export function refDeChamp(cible: string): string | null {
  if (!cible.startsWith(PREFIXE_CHAMP)) return null;
  const ref = cible.slice(PREFIXE_CHAMP.length).trim();
  return ref === '' ? null : ref;
}

export function cibleValide(cible: unknown): boolean {
  if (typeof cible !== 'string') return false;
  if (cible === CIBLE_TELEPHONE || cible === CIBLE_NOM) return true;
  const ref = refDeChamp(cible);
  return ref !== null && ref.length <= 100;
}

export type ValidationMapping = { ok: true; mapping: RegleMapping[] } | { ok: false; error: string };

/**
 * Valide un mapping au moment de sa configuration. Le dernier payload n'est qu'un échantillon : un chemin absent
 * reste accepté, mais un chemin qui désigne un objet ou un tableau est refusé, car les champs ne stockent que des
 * valeurs scalaires. La route d'administration ne redérive pas ces règles du module qui applique le mapping.
 */
export function validerMapping(brut: unknown, payload: unknown): ValidationMapping {
  if (brut === undefined) return { ok: true, mapping: [] };
  if (!Array.isArray(brut)) return { ok: false, error: 'mapping invalide (tableau)' };
  if (brut.length > MAX_REGLES) return { ok: false, error: `mapping trop long (${MAX_REGLES} règles au maximum)` };

  const mapping: RegleMapping[] = [];
  for (const item of brut) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'chaque règle est un objet { chemin, cible }' };
    }
    const r = item as { chemin?: unknown; cible?: unknown };
    if (typeof r.chemin !== 'string' || !cheminValide(r.chemin)) {
      return { ok: false, error: `chemin invalide : ${typeof r.chemin === 'string' ? r.chemin.slice(0, 80) : 'absent'}` };
    }
    if (!cibleValide(r.cible)) return { ok: false, error: `destination invalide pour « ${r.chemin.slice(0, 80)} »` };
    const chemin = r.chemin.trim();
    if (payload !== null && payload !== undefined) {
      const valeur = litChemin(payload, chemin);
      if (valeur !== undefined && !estScalaire(valeur)) {
        return {
          ok: false,
          error: `« ${chemin.slice(0, 80)} » désigne un ensemble, pas une valeur : pointez un élément précis (par exemple ${chemin.slice(0, 60)}[0])`,
        };
      }
    }
    mapping.push({ chemin, cible: (r.cible as string).trim() });
  }
  return { ok: true, mapping };
}

/**
 * Coerce le `mapping` jsonb (écrit par une route, peut-être d'une version antérieure) en règles exploitables. Une
 * règle illisible est retirée, sans lever. Les doublons de cible sont conservés : `extraireDuPayload` garde la
 * première valeur, ce qui permet un chemin de repli.
 */
export function coerceMapping(raw: unknown): RegleMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: RegleMapping[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as { chemin?: unknown; cible?: unknown };
    if (typeof r.chemin !== 'string' || typeof r.cible !== 'string') continue;
    if (!cheminValide(r.chemin) || !cibleValide(r.cible)) continue;
    out.push({ chemin: r.chemin.trim(), cible: r.cible.trim() });
    if (out.length >= MAX_REGLES) break;
  }
  return out;
}

export interface Extraction {
  /** Téléphone tel qu'il est arrivé : la normalisation E.164 reste au chemin d'écriture partagé. */
  telephone: string | null;
  nom: string | null;
  /** Référence de champ -> valeur texte. La résolution et la validation par type restent à `upsertContactsFromApi`,
   *  partagé avec l'API publique. */
  champs: Record<string, string>;
  /** Chemins qui n'ont rien rendu, renvoyés pour que la réponse au tiers le dise : un mapping muet est indébogable. */
  ignores: string[];
}

/**
 * Applique le mapping à un payload. Ne lève jamais, n'écrit rien : elle dit ce qu'il y a à écrire. Une règle qui ne
 * résout pas n'empêche pas les autres.
 */
export function extraireDuPayload(payload: unknown, regles: readonly RegleMapping[]): Extraction {
  const ex: Extraction = { telephone: null, nom: null, champs: {}, ignores: [] };
  for (const r of regles) {
    const valeur = valeurTexte(litChemin(payload, r.chemin));
    if (valeur === null) { ex.ignores.push(r.chemin); continue; }
    // Première règle qui rend une valeur : gagne. Les suivantes sont des replis, pas des écrasements.
    if (r.cible === CIBLE_TELEPHONE) {
      if (ex.telephone === null) ex.telephone = valeur;
      continue;
    }
    if (r.cible === CIBLE_NOM) {
      if (ex.nom === null) ex.nom = valeur;
      continue;
    }
    const ref = refDeChamp(r.cible);
    if (ref === null) continue;
    if (!Object.prototype.hasOwnProperty.call(ex.champs, ref)) ex.champs[ref] = valeur;
  }
  return ex;
}
