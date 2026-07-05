import { normalizePhone } from './phone';
import { slugify } from './fields';
import type { UserFieldStore } from './fields';
import type { ColumnMapping, ImportReport } from './types';
import type { CountryCode } from 'libphonenumber-js';

export interface ContactUpsert {
  tenantId: string;
  phoneE164: string;
  profileName: string | null;
  fields: Record<string, string>;
  optInStatus: 'opted_in' | 'unknown';
  optInSource?: string;
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

  // 1) Enregistrer une fois les champs perso mappés qui n'existent pas encore.
  const wantedKeys = new Set<string>();
  for (const [header, m] of cols) {
    if (m.target === 'custom') wantedKeys.add(m.key ?? slugify(header));
  }
  const existing = new Set((await deps.userFields.list(input.tenantId)).map((f) => f.key));
  for (const key of wantedKeys) {
    if (!existing.has(key)) await deps.userFields.upsert(input.tenantId, { key, label: key, type: 'text' });
  }

  // 2) Traiter chaque ligne.
  for (let i = 0; i < input.rows.length; i += 1) {
    const row = input.rows[i] ?? {};
    let phoneRaw = '';
    let profileName: string | null = null;
    const fields: Record<string, string> = {};

    for (const [header, m] of cols) {
      const val = (row[header] ?? '').trim();
      if (m.target === 'phone') phoneRaw = val;
      else if (m.target === 'name') profileName = val || null;
      else if (m.target === 'custom') {
        const key = m.key ?? slugify(header);
        if (val) fields[key] = val;
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
    });
    if (res === 'created') report.created += 1;
    else report.updated += 1;
  }

  return report;
}
