import { normalizePhone } from './phone';
import { slugify, validateFieldValue, canonicalizeFieldValue } from './fields';
import type { UserFieldStore } from './fields';
import type { ColumnMapping, ImportReport, UserFieldDef } from './types';
import type { CountryCode } from 'libphonenumber-js';

export interface ContactUpsert {
  tenantId: string;
  phoneE164: string;
  profileName: string | null;
  fields: Record<string, string>;
  optInStatus: 'opted_in' | 'unknown';
  optInSource?: string;
  /** Tags à ajouter (union avec les tags existants côté store, jamais d'écrasement). */
  tags?: string[];
  /**
   * Identifiant WhatsApp d'un client qui n'a pas partagé son numéro. OPTIONNEL et jamais requis : le numéro
   * reste l'identité de ce chemin d'upsert. Absent -> le BSUID déjà en base est PRÉSERVÉ (jamais écrasé par
   * du vide), sinon un import CSV effacerait l'identifiant d'un contact arrivé par l'inbound.
   */
  bsuid?: string | null;
}

/**
 * Ce qui VARIE d'une ligne à l'autre dans un import. L'espace, le consentement et les tags valent pour tout
 * le lot : les répéter par ligne enverrait cinq mille fois la même valeur sur le fil.
 */
export interface ContactDeLot {
  phoneE164: string;
  profileName: string | null;
  fields: Record<string, string>;
}

/** Un lot d'import : un espace, un consentement, un jeu de tags, et les gens. */
export interface LotContacts {
  tenantId: string;
  /** Ces contacts sont-ils opt-in ? Vaut pour tout le lot (la case cochée à l'écran d'import). */
  optInStatus: 'opted_in' | 'unknown';
  optInSource?: string;
  /** Tags appliqués à TOUS les contacts du lot (union avec l'existant, jamais d'écrasement). */
  tags?: string[];
  /**
   * 🔴 Ce lot peut-il réabonner quelqu'un qui a dit STOP ? Seul l'import CSV case cochée le peut (décision de
   * Julien du 2026-09-26) : c'est l'opérateur qui le demande. Absent = non, et c'est le défaut SÛR : un appelant
   * qui l'oublie garde le STOP, il ne le lève pas. L'import HubSpot ne le pose jamais.
   */
  peutLeverStop?: boolean;
  contacts: ContactDeLot[];
}

export interface ContactStore {
  /**
   * Upsert d'un LOT de contacts par (tenant, téléphone), en UNE requête (AUDIT-SCALE-2026-08-25.md, R9).
   *
   * ⚠️ `fields` est un PATCH À FUSIONNER (merge, pas replace) : côté SQL, faire
   * `fields = contacts.fields || excluded.fields` (jsonb) pour ne PAS écraser les champs perso déjà présents
   * et absents du CSV courant. Le CSV ne porte que les clés non vides.
   *
   * Rend un résultat PAR CONTACT DONNÉ, dans l'ordre reçu : c'est ce qui permet au rapport d'import de
   * compter juste, y compris quand le même numéro apparaît plusieurs fois dans le fichier (une seule
   * création possible, les suivantes sont des mises à jour).
   */
  upsertManyByPhone(lot: LotContacts): Promise<Array<'created' | 'updated'>>;
}

/**
 * Taille d'un lot d'upsert. 500 lignes en une requête plutôt qu'une requête par ligne : à 11 ms
 * d'aller-retour mesurés vers le pooler, un fichier de 50 000 contacts passe de neuf minutes (donc un
 * timeout Cloudflare à 100 s, et un opérateur qui voit une erreur pendant que le serveur travaille encore)
 * à une centaine de requêtes. Pas 5000 : au-delà, un lot fait une requête énorme dont l'échec coûte cher à
 * rejouer, sans gagner grand-chose sur le nombre d'allers-retours.
 */
const TAILLE_LOT = 500;

export interface ImportInput {
  rows: Array<Record<string, string>>;
  mapping: ColumnMapping;
  tenantId: string;
  /** Ces contacts sont-ils opt-in (la preuve est gérée en amont) ? */
  optIn: boolean;
  /** D'où vient la preuve du consentement. Défaut `csv_import`. Une liste HubSpot pose `hubspot_list` :
   *  le consentement y est géré par HubSpot, c'est lui la source, et il faut pouvoir le retracer. */
  optInSource?: string;
  /** Tags appliqués à TOUS les contacts de cet import (union avec l'existant). */
  tags?: string[];
  /** Cet import peut-il réabonner quelqu'un qui a dit STOP ? Seule la route CSV, case cochée. Cf. `LotContacts`. */
  peutLeverStop?: boolean;
}

export interface ImportDeps {
  contacts: ContactStore;
  userFields: UserFieldStore;
  defaultCountry?: CountryCode;
}

/**
 * Applique un mapping à des lignes CSV : normalise le téléphone (clé de dédup),
 * écrit les attributs standard + les champs perso, enregistre les nouveaux user fields,
 * pose l'opt-in, et renvoie un rapport.
 */
export async function importContacts(input: ImportInput, deps: ImportDeps): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
  const cols = Object.entries(input.mapping.columns);
  /**
   * Une erreur par ligne rejetée, PLAFONNÉE. Depuis que la route accepte 8 Mo, un fichier dont aucune ligne
   * n'a de téléphone produirait 150 000 entrées, donc une réponse de plusieurs mégaoctets pour un écran qui
   * n'en affiche que cinq. Le COMPTE (`skipped`), lui, reste exact : c'est lui qui dit l'ampleur.
   */
  const signaler = (line: number, reason: string): void => {
    if (report.errors.length < 100) report.errors.push({ line, reason });
  };

  // 1) Enregistrer une fois les champs perso mappés qui n'existent pas encore, et repérer
  //    les collisions (plusieurs en-têtes -> même clé) pour les signaler (perte silencieuse).
  const keyToHeaders = new Map<string, string[]>();
  for (const [header, m] of cols) {
    if (m.target === 'custom') {
      const key = m.key ?? slugify(header);
      keyToHeaders.set(key, [...(keyToHeaders.get(key) ?? []), header]);
    }
  }
  for (const [key, headers] of keyToHeaders) {
    if (headers.length > 1) {
      signaler(1, `colonnes fusionnées sur la clé "${key}": ${headers.join(', ')}`);
    }
  }
  // On garde la DÉFINITION (type inclus), pas juste la clé : elle sert à canonicaliser chaque valeur selon
  // le type déclaré du champ (ex. un booléen « Oui » -> 'true'), sur les MÊMES règles que la fiche contact.
  const defsByKey = new Map((await deps.userFields.list(input.tenantId)).map((f) => [f.key, f] as const));
  for (const key of keyToHeaders.keys()) {
    if (!defsByKey.has(key)) {
      const def: UserFieldDef = { key, label: key, type: 'text' };
      await deps.userFields.upsert(input.tenantId, def);
      defsByKey.set(key, def);
    }
  }

  // 2) Traiter chaque ligne : validation ligne à ligne (elle produit le rapport d'erreurs), puis
  //    accumulation. L'écriture, elle, se fait par LOTS plus bas.
  const aEcrire: ContactDeLot[] = [];
  for (let i = 0; i < input.rows.length; i += 1) {
    const row = input.rows[i] ?? {};
    let phoneRaw = '';
    let profileName: string | null = null;
    const fields: Record<string, string> = {};

    for (const [header, m] of cols) {
      const val = (row[header] ?? '').trim();
      // Garder la PREMIÈRE valeur non vide : une 2e colonne mappée (ex. Mobile vide après
      // Telephone) ne doit pas écraser un numéro/nom déjà trouvé.
      if (m.target === 'phone') {
        if (val && !phoneRaw) phoneRaw = val;
      } else if (m.target === 'name') {
        if (val && profileName === null) profileName = val;
      } else if (m.target === 'custom') {
        const key = m.key ?? slugify(header);
        if (val && fields[key] === undefined) {
          // Canonicalise selon le type déclaré (booléen 'Oui' -> 'true'). Valeur non valide pour le type ->
          // conservée BRUTE (comme avant : l'import ne rejette pas une ligne sur une valeur de champ perso).
          const type = defsByKey.get(key)?.type ?? 'text';
          fields[key] = validateFieldValue(type, val) ? canonicalizeFieldValue(type, val) : val;
        }
      }
      // 'ignore' -> rien
    }

    const line = i + 2; // en-tête = ligne 1, 1re donnée = ligne 2
    if (!phoneRaw) {
      report.skipped += 1;
      signaler(line, 'pas de téléphone');
      continue;
    }
    const p = normalizePhone(phoneRaw, deps.defaultCountry ?? 'FR');
    if (!p.e164) {
      report.skipped += 1;
      signaler(line, p.error ?? 'téléphone invalide');
      continue;
    }

    aEcrire.push({ phoneE164: p.e164, profileName, fields });
  }

  // 3) Écrire par lots. Chaque lot est une requête indépendante : un échec en cours de route laisse en base
  //    ce que les lots précédents ont écrit, exactement comme le faisait l'écriture ligne à ligne.
  const commun = {
    tenantId: input.tenantId,
    optInStatus: (input.optIn ? 'opted_in' : 'unknown') as 'opted_in' | 'unknown',
    ...(input.optIn ? { optInSource: input.optInSource ?? 'csv_import' } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.peutLeverStop ? { peutLeverStop: true } : {}),
  };
  for (let d = 0; d < aEcrire.length; d += TAILLE_LOT) {
    const res = await deps.contacts.upsertManyByPhone({ ...commun, contacts: aEcrire.slice(d, d + TAILLE_LOT) });
    for (const r of res) {
      if (r === 'created') report.created += 1;
      else report.updated += 1;
    }
  }

  return report;
}
