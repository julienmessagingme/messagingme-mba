import { normalizePhone } from '../crm/phone';
import { validateFieldValue, canonicalizeFieldValue, ensureFieldByKey } from '../crm/fields';
import { normaliserDate, raisonDateLisible } from '../crm/date-iso';
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
  /**
   * D'où vient le consentement, quand `optIn` est vrai. Tracé dans `contacts.opt_in_source`, comme
   * `csv_import` pour l'import et `hubspot_list` pour une liste : c'est ce qui permet de savoir PAR OÙ un
   * consentement est entré, et donc de le justifier. Absent -> `api`, le comportement d'origine.
   */
  optInSource?: string;
  /** Identifiant WhatsApp d'un client sans numéro partagé. Optionnel ; unique par espace côté base. */
  bsuid?: string;
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
/**
 * Combien d'upserts en vol à la fois.
 *
 * 4 et pas 8 : le pool applicatif de ce process en compte 8 au total (`DB_POOL_MAX`, valeur mesurée comme la
 * capacité réelle du pooler), et cette API ne doit pas prendre à elle seule toutes les connexions pendant
 * qu'un opérateur charge son inbox. Chaque upsert est UNE instruction `on conflict`, donc deux vagues ne
 * peuvent pas s'interbloquer : au pire elles attendent le même verrou de ligne, ce qui est le cas voulu quand
 * un lot répète le même numéro.
 */
const ECRITURES_EN_VOL = 4;

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

  // DEUX TEMPS (lot 6 du programme II), et l'ordre n'est pas indifférent.
  //
  // 1) La validation reste SÉQUENTIELLE : elle partage un cache de définitions de champs et peut en créer un
  //    au passage. La paralléliser ferait courir deux items sur la même création, pour un gain nul (le cache
  //    évite déjà presque tous les allers-retours).
  // 2) Les ÉCRITURES partent par vagues. C'est là qu'était le coût : 500 upserts à la file, un aller-retour
  //    chacun, soit environ cinq secondes et demie de latence pure pour un lot plein.
  const out: ApiUpsertOutcome[] = [];
  const aEcrire: Array<{ index: number; upsert: Parameters<PgContactStore['upsertByPhoneReturningId']>[0] }> = [];
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
      if (!validateFieldValue(resolved.type, val)) {
        // Une date refusée dit POURQUOI : ambiguë, sans heure, ou illisible. « valeur invalide (datetime) »
        // n'apprend rien à l'intégrateur d'un webhook, qui ne voit pas notre écran et ne peut que deviner.
        const detail = resolved.type === 'date' || resolved.type === 'datetime'
          ? raisonDateLisible((normaliserDate(val, resolved.type) as { raison: 'ambigu' | 'sans_heure' | 'illisible' }).raison)
          : `valeur invalide (${resolved.type})`;
        fieldError = `« ${resolved.key} » : ${detail}`;
        break;
      }
      fieldValues[resolved.key] = canonicalizeFieldValue(resolved.type, val);
    }
    if (fieldError) {
      out.push({ index: i, status: 'error', reason: fieldError });
      continue;
    }

    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim().slice(0, 200) : null;
    const bsuid = typeof item.bsuid === 'string' && item.bsuid.trim() !== '' ? item.bsuid.trim().slice(0, 200) : null;
    aEcrire.push({
      index: i,
      upsert: {
        tenantId,
        phoneE164: p.e164,
        profileName: name,
        fields: fieldValues,
        optInStatus: item.optIn === true ? 'opted_in' : 'unknown',
        ...(item.optIn === true ? { optInSource: item.optInSource ?? 'api' } : {}),
        ...(normalizeTags(item.tags).length > 0 ? { tags: normalizeTags(item.tags) } : {}),
        ...(bsuid !== null ? { bsuid } : {}),
      },
    });
  }

  for (let d = 0; d < aEcrire.length; d += ECRITURES_EN_VOL) {
    const vague = aEcrire.slice(d, d + ECRITURES_EN_VOL);
    const resultats = await Promise.all(vague.map(async ({ index, upsert }): Promise<ApiUpsertOutcome> => {
      try {
        const res = await deps.contacts.upsertByPhoneReturningId(upsert);
        return { index, status: res.created ? 'created' : 'updated', contactId: res.id };
      } catch (err) {
        // `contacts_tenant_bsuid_uidx` rend le BSUID unique par espace. Le violer est une erreur de SAISIE, pas
        // une panne : sans ce filet elle sortirait en 500, et Cloudflare remplace le corps des 5xx par sa propre
        // page, donc l'opérateur ne verrait même pas ce qu'on lui reproche.
        if ((err as { code?: string }).code === '23505') {
          return { index, status: 'error', reason: 'ce BSUID est déjà utilisé par un autre contact de cet espace' };
        }
        throw err;
      }
    }));
    out.push(...resultats);
  }
  // Les erreurs de validation sont poussées au fil du premier temps, les écritures au second : on RETRIE sur
  // l'index pour rendre les résultats dans l'ordre reçu, qui est le contrat de cette API.
  return out.sort((a, b) => a.index - b.index);
}
