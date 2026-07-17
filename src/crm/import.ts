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
}

export interface ContactStore {
  /**
   * Upsert par (tenant, téléphone). Retourne s'il a été créé ou mis à jour.
   * ⚠️ `fields` est un PATCH À FUSIONNER (merge, pas replace) : côté SQL, faire
   * `fields = contacts.fields || $new` (jsonb) pour ne PAS écraser les champs perso
   * déjà présents et absents du CSV courant. Le CSV ne porte que les clés non vides.
   */
  upsertByPhone(c: ContactUpsert): Promise<'created' | 'updated'>;
}

export interface ImportInput {
  rows: Array<Record<string, string>>;
  mapping: ColumnMapping;
  tenantId: string;
  /** Ces contacts sont-ils opt-in (la preuve est gérée en amont) ? */
  optIn: boolean;
  /** Tags appliqués à TOUS les contacts de cet import (union avec l'existant). */
  tags?: string[];
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
      report.errors.push({ line: 1, reason: `colonnes fusionnées sur la clé "${key}": ${headers.join(', ')}` });
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

  // 2) Traiter chaque ligne.
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
      report.errors.push({ line, reason: 'pas de téléphone' });
      continue;
    }
    const p = normalizePhone(phoneRaw, deps.defaultCountry ?? 'FR');
    if (!p.e164) {
      report.skipped += 1;
      report.errors.push({ line, reason: p.error ?? 'téléphone invalide' });
      continue;
    }

    const res = await deps.contacts.upsertByPhone({
      tenantId: input.tenantId,
      phoneE164: p.e164,
      profileName,
      fields,
      optInStatus: input.optIn ? 'opted_in' : 'unknown',
      ...(input.optIn ? { optInSource: 'csv_import' } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    });
    if (res === 'created') report.created += 1;
    else report.updated += 1;
  }

  return report;
}
