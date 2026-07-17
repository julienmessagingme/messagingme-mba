import { normalizePhone } from '../crm/phone';
import { validateFieldValue, canonicalizeFieldValue, ensureFieldByKey } from '../crm/fields';
import { resolveFieldKey } from '../ids/resolve';
import type { FieldLister } from '../ids/resolve';
import type { PgContactStore } from '../crm/contact-store.pg';
import type { PgUserFieldStore } from '../crm/field-store.pg';
import type { UserFieldDef } from '../crm/types';
import type { CountryCode } from 'libphonenumber-js';

/** Un contact poussé par l'API : téléphone + attributs optionnels. `fields` adressés par clé technique OU code. */
export interface ApiContactInput {
  phone: string;
  name?: string;
  fields?: Record<string, string>;
  tags?: string[];
  optIn?: boolean;
}

export interface ApiUpsertOutcome {
  index: number;
  status: 'created' | 'updated' | 'error';
  contactId?: string;
  reason?: string;
}

const normalizeTags = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((t) => String(t).trim().slice(0, 64)).filter((t) => t !== ''))].slice(0, 50) : [];

/**
 * Upsert d'un lot de contacts poussés par l'API (upsert-then, D-3). Par item : normalise le téléphone,
 * résout chaque champ (clé technique OU code, D-2 ; champ inconnu -> auto-créé en texte, comme l'import CSV),
 * valide + canonicalise chaque valeur, pose tags + opt-in, upsert par téléphone. Séquentiel (chaque upsert
 * est déjà atomique via ON CONFLICT ; pas de transaction géante, comme importContacts). Un item invalide ->
 * outcome `error` avec la raison, sans faire échouer les autres. Renvoie un outcome par item (index préservé).
 */
export async function upsertContactsFromApi(
  tenantId: string,
  items: ApiContactInput[],
  deps: { contacts: PgContactStore; fields: PgUserFieldStore; defaultCountry?: CountryCode },
): Promise<ApiUpsertOutcome[]> {
  // Défs chargées UNE fois (cache mutable) : évite un list() par champ/par item. Un champ auto-créé y est
  // ajouté pour que les items suivants le voient sans re-lister.
  const defs = await deps.fields.list(tenantId);
  const cache: FieldLister = { list: async () => defs };
  const ensured = new Set<string>();

  const out: ApiUpsertOutcome[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const p = normalizePhone(String(item.phone ?? ''), deps.defaultCountry ?? 'FR');
    if (!p.e164) {
      out.push({ index: i, status: 'error', reason: p.error ?? 'téléphone invalide' });
      continue;
    }

    const fieldValues: Record<string, string> = {};
    let fieldError: string | null = null;
    for (const [ref, rawVal] of Object.entries(item.fields ?? {})) {
      const resolved = await resolveFieldKey(tenantId, ref, cache);
      if (!resolved.ok) { fieldError = `champ inconnu : ${ref}`; break; }
      if (!resolved.known && !ensured.has(resolved.key)) {
        await ensureFieldByKey(deps.fields, tenantId, resolved.key, resolved.key, 'text');
        ensured.add(resolved.key);
        defs.push({ key: resolved.key, label: resolved.key, type: 'text' } as UserFieldDef);
      }
      const val = String(rawVal);
      if (!validateFieldValue(resolved.type, val)) { fieldError = `valeur invalide pour « ${resolved.key} » (${resolved.type})`; break; }
      fieldValues[resolved.key] = canonicalizeFieldValue(resolved.type, val);
    }
    if (fieldError) {
      out.push({ index: i, status: 'error', reason: fieldError });
      continue;
    }

    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim().slice(0, 200) : null;
    const res = await deps.contacts.upsertByPhoneReturningId({
      tenantId,
      phoneE164: p.e164,
      profileName: name,
      fields: fieldValues,
      optInStatus: item.optIn === true ? 'opted_in' : 'unknown',
      ...(item.optIn === true ? { optInSource: 'api' } : {}),
      ...(normalizeTags(item.tags).length > 0 ? { tags: normalizeTags(item.tags) } : {}),
    });
    out.push({ index: i, status: res.created ? 'created' : 'updated', contactId: res.id });
  }
  return out;
}
