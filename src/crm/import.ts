import { normalizePhone } from './phone';
import { slugify, validateFieldValue, canonicalizeFieldValue } from './fields';
import { estCleReservee } from './champs-fiche';
import type { UserFieldStore } from './fields';
import type { ColumnMapping, ImportReport, UserFieldDef } from './types';
import type { CountryCode } from 'libphonenumber-js';
import type { AutoriteImport } from './transition-consentement';

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
   * Identifiant WhatsApp d'un client qui n'a pas partagé son numéro, optionnel : le numéro reste l'identité de cet
   * upsert. Absent -> le BSUID en base est préservé, sinon un import CSV effacerait celui d'un contact entrant.
   */
  bsuid?: string | null;
}

/**
 * Ce qui varie d'une ligne à l'autre dans un import. L'espace, le consentement et les tags valent pour tout le
 * lot : les répéter par ligne enverrait cinq mille fois la même valeur sur le fil.
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
  /** Tags appliqués à tous les contacts du lot (union avec l'existant, jamais d'écrasement). */
  tags?: string[];
  /**
   * 🔴 Qui importe, donc ce lot peut-il réabonner quelqu'un qui a dit STOP ? Seul l'import CSV case cochée
   * (`import_csv_coche`) le peut, à la demande de l'opérateur ; l'import sans case et l'import HubSpot (`import`)
   * gardent le STOP. Requise : un appelant qui l'oublierait ne compile pas (`src/crm/transition-consentement.ts`).
   */
  autorite: AutoriteImport;
  contacts: ContactDeLot[];
}

export interface ContactStore {
  /**
   * Upsert d'un lot de contacts par (tenant, téléphone), en une requête. `fields` est un patch à fusionner
   * (`fields = contacts.fields || excluded.fields`), pour ne pas écraser les champs absents du CSV. Rend un résultat
   * par contact donné, dans l'ordre reçu, pour un rapport juste même si un numéro apparaît plusieurs fois.
   */
  upsertManyByPhone(lot: LotContacts): Promise<Array<'created' | 'updated'>>;
  /**
   * La limite de contacts de l'offre (lot 6) : refuse (`LimiteOffreError`) si ces numéros feraient dépasser la limite.
   * L'import la vérifie sur TOUT le fichier avant son premier lot : un fichier qui ne tient pas n'est pas écrit à moitié.
   */
  verifierPlaceContacts(tenantId: string, numeros: readonly string[]): Promise<void>;
}

/**
 * Taille d'un lot d'upsert. 500 lignes par requête : une requête par ligne ferait durer un gros fichier plus
 * que le timeout Cloudflare (100 s). Pas 5000 : un lot énorme coûte cher à rejouer, sans gagner grand-chose.
 */
const TAILLE_LOT = 500;

export interface ImportInput {
  rows: Array<Record<string, string>>;
  mapping: ColumnMapping;
  tenantId: string;
  /** Ces contacts sont-ils opt-in (la preuve est gérée en amont) ? */
  optIn: boolean;
  /** D'où vient la preuve du consentement. Défaut `csv_import` ; une liste HubSpot pose `hubspot_list`, qui en
   *  est la source et doit rester traçable. */
  optInSource?: string;
  /** Tags appliqués à tous les contacts de cet import (union avec l'existant). */
  tags?: string[];
  /** Qui importe : `import_csv_coche` (la route CSV, case cochée) lève un STOP, `import` jamais. Cf. `LotContacts`. */
  autorite: AutoriteImport;
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
  /**
   * Une erreur par ligne rejetée, plafonnée : un gros fichier sans téléphone produirait sinon une réponse de
   * plusieurs mégaoctets pour un écran qui en affiche cinq. Le compte (`skipped`), lui, reste exact.
   */
  const signaler = (line: number, reason: string): void => {
    if (report.errors.length < 100) report.errors.push({ line, reason });
  };
  // Une colonne qui prendrait la clé d'un champ FIXE de la fiche (`analyse_sentiment`, `external_id`...) est
  // écartée et le rapport le dit : sinon elle créerait un champ perso qui se confondrait avec le champ fixe.
  const cols = Object.entries(input.mapping.columns).filter(([header, m]) => {
    if (m.target !== 'custom') return true;
    const key = m.key ?? slugify(header);
    if (!estCleReservee(key)) return true;
    signaler(1, `colonne « ${header} » ignorée : « ${key} » est un champ réservé de la fiche`);
    return false;
  });

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
  // On garde la définition (type inclus) : elle sert à canonicaliser chaque valeur selon le type déclaré,
  // sur les mêmes règles que la fiche contact.
  const defsByKey = new Map((await deps.userFields.list(input.tenantId)).map((f) => [f.key, f] as const));
  for (const key of keyToHeaders.keys()) {
    if (!defsByKey.has(key)) {
      const def: UserFieldDef = { key, label: key, type: 'text' };
      await deps.userFields.upsert(input.tenantId, def);
      defsByKey.set(key, def);
    }
  }

  // 2) Traiter chaque ligne : validation ligne à ligne (elle produit le rapport d'erreurs), puis accumulation.
  //    L'écriture se fait par lots plus bas.
  const aEcrire: ContactDeLot[] = [];
  for (let i = 0; i < input.rows.length; i += 1) {
    const row = input.rows[i] ?? {};
    let phoneRaw = '';
    let profileName: string | null = null;
    const fields: Record<string, string> = {};

    for (const [header, m] of cols) {
      const val = (row[header] ?? '').trim();
      // Garder la première valeur non vide : une 2e colonne mappée (ex. Mobile vide après Telephone) n'écrase
      // pas un numéro ou un nom déjà trouvé.
      if (m.target === 'phone') {
        if (val && !phoneRaw) phoneRaw = val;
      } else if (m.target === 'name') {
        if (val && profileName === null) profileName = val;
      } else if (m.target === 'custom') {
        const key = m.key ?? slugify(header);
        if (val && fields[key] === undefined) {
          // Canonicalise selon le type déclaré ; une valeur non valide pour le type est conservée brute (l'import
          // ne rejette pas une ligne sur un champ perso).
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
  //    ce que les lots précédents ont écrit.
  const commun = {
    tenantId: input.tenantId,
    optInStatus: (input.optIn ? 'opted_in' : 'unknown') as 'opted_in' | 'unknown',
    ...(input.optIn ? { optInSource: input.optInSource ?? 'csv_import' } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    autorite: input.autorite,
  };
  // La limite de contacts de l'offre (lot 6), sur tout le fichier et avant le premier lot : refusé en entier.
  await deps.contacts.verifierPlaceContacts(input.tenantId, aEcrire.map((c) => c.phoneE164));
  for (let d = 0; d < aEcrire.length; d += TAILLE_LOT) {
    const res = await deps.contacts.upsertManyByPhone({ ...commun, contacts: aEcrire.slice(d, d + TAILLE_LOT) });
    for (const r of res) {
      if (r === 'created') report.created += 1;
      else report.updated += 1;
    }
  }

  return report;
}
