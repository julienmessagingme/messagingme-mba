import { cheminValide, litChemin, valeurTexte } from './chemin';

/**
 * Ce qu'une règle de mapping peut VISER, et comment on l'applique à un payload reçu.
 *
 * Module PUR. La règle structurante tient en une phrase : **on itère sur NOTRE mapping, jamais sur les clés
 * reçues**. C'est la même doctrine que `web/lib/flow-mapping.ts` côté formulaires. Parcourir le payload pour
 * y chercher des noms connus laisserait un tiers écrire où il veut, simplement en nommant ses clés comme nos
 * champs.
 */

/** Le téléphone : c'est lui qui désigne le contact. Sans lui, un appel ne peut rien faire d'autre que
 *  s'enregistrer dans `last_payload`. */
export const CIBLE_TELEPHONE = 'sys:phone';
/** Le nom affiché. ⚠️ C'est un ATTRIBUT (`contacts.profile_name`), pas une clé de `contacts.fields` :
 *  l'écrire dans le jsonb créerait un doublon silencieux, invisible partout où le nom est lu. */
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

/**
 * Coerce le `mapping` jsonb (opaque : écrit par une route, potentiellement par une version antérieure) en
 * règles exploitables. Jamais de throw sur une valeur malformée : une règle illisible est simplement retirée,
 * comme `toRow` retire une automation au `trigger_kind` inconnu. Les doublons de cible sont CONSERVÉS : c'est
 * `extraireDuPayload` qui tranche (la première règle qui rend une valeur gagne), ce qui permet un chemin de
 * repli quand un tiers n'envoie pas toujours la même forme.
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
  /** Téléphone tel qu'il est arrivé (format libre) : la normalisation E.164 reste au chemin d'écriture partagé. */
  telephone: string | null;
  nom: string | null;
  /** Référence de champ -> valeur texte. La résolution et la validation par TYPE restent à l'appelant, qui
   *  a la base : c'est `upsertContactsFromApi` qui les fait, comme pour l'API publique et l'import. */
  champs: Record<string, string>;
  /** Chemins qui n'ont rien rendu (absents du payload, ou valeur non stockable). Renvoyés pour que la réponse
   *  au tiers puisse le dire : un mapping muet sans trace est indébogable. */
  ignores: string[];
}

/**
 * Applique le mapping à un payload. Ne lève jamais, n'écrit rien : elle DIT ce qu'il y a à écrire.
 *
 * Une règle qui ne résout pas est ignorée sans empêcher les autres : un tiers qui cesse d'envoyer un champ
 * facultatif ne doit pas faire tomber tout le reste de l'appel.
 */
export function extraireDuPayload(payload: unknown, regles: readonly RegleMapping[]): Extraction {
  const ex: Extraction = { telephone: null, nom: null, champs: {}, ignores: [] };
  for (const r of regles) {
    const valeur = valeurTexte(litChemin(payload, r.chemin));
    if (valeur === null) { ex.ignores.push(r.chemin); continue; }
    // Première règle qui rend une valeur : gagne. Les suivantes visant la même cible sont des REPLIS, pas des
    // écrasements ; sinon un chemin de repli vide effacerait la valeur trouvée par le chemin principal.
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
