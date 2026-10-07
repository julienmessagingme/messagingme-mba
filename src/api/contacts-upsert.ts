import { z } from 'zod';
import { config } from '../config';
import { normalizePhone } from '../crm/phone';
import { validateFieldValue, canonicalizeFieldValue, ensureFieldByKey, type UserFieldStore } from '../crm/fields';
import { normaliserDate, raisonDateLisible } from '../crm/date-iso';
import { resolveFieldKey } from '../ids/resolve';
import type { FieldLister } from '../ids/resolve';
import type { PgContactStore } from '../crm/contact-store.pg';
import type { PgUserFieldStore } from '../crm/field-store.pg';
import type { UserFieldDef } from '../crm/types';
import type { CountryCode } from 'libphonenumber-js';
import { MAX_EXTERNAL_ID } from './fiche';
import { estCleReservee } from '../crm/champs-fiche';
import { nettoyerEtiquettes } from '../crm/poser-etiquette';
import { LimiteOffreError } from '../offres/refus';

/**
 * Les bornes de forme d'un contact poussé par l'API : champs et étiquettes par fiche, 20 à l'unité, 10 dans
 * un lot. Une fiche coûte une écriture quel que soit son nombre de champs : ces bornes tiennent la taille
 * d'un corps, pas la charge de la base (c'est la taille du lot, `MAX_BATCH`). Rien à voir avec le plafond de
 * définitions de champs par espace.
 */
export const MAX_CLE_CHAMP = config.API_MAX_CLE_CHAMP;
export const MAX_PAR_FICHE = 20;
export const MAX_PAR_FICHE_EN_LOT = 10;
/**
 * Pas configurable : `optInSource` justifie un consentement (`crm`, `csv_import`, `webhook:<nom>`), aucun
 * réglage d'exploitation n'a de raison de la desserrer.
 */
export const MAX_OPT_IN_SOURCE = 100;

/**
 * Un nombre et un booléen restent acceptés, convertis en texte (`{age: 42}` doit passer). On refuse ce dont
 * il n'existe pas de texte sensé : un objet (« [object Object] »), un tableau, `null`.
 */
export const valeurDeChamp = z.union([z.string(), z.number(), z.boolean()]).transform(String);

/** Le refus d'un `fields` trop long, rendu tel quel par `raisonDeValidation`. */
export const champsAuPlus = (max: number): string => `« fields » : ${max} champs au plus par fiche`;

/** Les champs d'un contact : clé bornée, valeur texte, et pas plus de `max` par contact. */
export const schemaChamps = (max: number) => z.record(z.string().max(MAX_CLE_CHAMP), valeurDeChamp)
  .refine((r) => Object.keys(r).length <= max, { message: champsAuPlus(max) });

/** Des étiquettes : au-delà de `max`, le tableau est refusé, pas tronqué (cf. la note de `schemaContactApi`). */
export const schemaTags = (max: number) => z.array(z.union([z.string(), z.number()]).transform(String)).max(max);

/**
 * La forme d'un contact qu'écrit `upsertContactsFromApi`, dont dérive `ApiContactInput`. Aucune route ne
 * valide plus son corps avec ce schéma : l'API publique a ses propres schémas, et les appelants restants
 * (webhook entrant, création à la main dans la console) construisent l'objet eux-mêmes. S'il revalidait un
 * corps : clés inconnues écartées, tableau démesuré refusé, pas tronqué.
 */
export const schemaContactApi = z.object({
  phone: z.string().trim().min(1),
  name: z.string().optional(),
  fields: schemaChamps(MAX_PAR_FICHE).optional(),
  /**
   * Bornée ici aussi : le service coupe à 50 tags après avoir reçu la liste, un tableau de 100 000 entrées
   * traverserait la validation. On refuse au lieu de tronquer.
   */
  tags: schemaTags(MAX_PAR_FICHE).optional(),
  optIn: z.boolean().optional(),
  optInSource: z.string().max(MAX_OPT_IN_SOURCE).optional(),
  bsuid: z.string().optional(),
});

/**
 * Un contact écrit par `upsertContactsFromApi` : téléphone et attributs optionnels, `fields` adressés par clé
 * technique ou code. Dérivé du schéma : le type est ce que la validation rend, jamais une seconde vérité.
 */
export type ApiContactInput = z.infer<typeof schemaContactApi>;

/** Les clés qu'un schéma refuse (`z.never`), et ce qu'on dit à qui les envoie. */
const CLES_REFUSEES: Record<string, string> = {
  optIn: '« optIn » n’existe plus : utilisez « consent » (« opted_in » ou « opted_out »)',
  optInSource: '« optInSource » n’existe plus : utilisez « consentSource »',
  phone: '« phone » ne se modifie pas : le numéro porte les conversations de la fiche',
  bsuid: '« bsuid » ne se modifie pas : il porte les conversations de la fiche',
};

/**
 * Ce qu'on dit à l'intégrateur quand son élément est refusé : le chemin avant le message (« fields.adresse »
 * désigne la ligne à reprendre). Les messages de zod sont en anglais et peu parlants : on traduit les cas
 * qu'on provoque, et on garde le message d'origine pour les autres plutôt que d'inventer.
 */
export function raisonDeValidation(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'contact invalide';
  /**
   * Le chemin contient la clé envoyée par l'appelant : borné avant d'être recopié, sinon une clé de 5 000
   * caractères reviendrait dans la réponse, multipliée par le nombre de lignes fautives.
   */
  const chemin = i.path.join('.').slice(0, 80);
  // Un `refine` posé à la racine porte un message écrit par nous, en français : on le rend tel quel.
  if (chemin === '' && i.code === 'custom') return i.message;
  if (chemin === '') return 'chaque contact doit être un objet';
  if (i.code === 'invalid_type' && i.expected === 'never') return CLES_REFUSEES[chemin] ?? `« ${chemin} » : clé non acceptée ici`;
  if (chemin === 'contactId') return '« contactId » : un identifiant de fiche (UUID) est attendu';
  if (chemin === 'externalId') return `« externalId » : texte de ${MAX_EXTERNAL_ID} caractères au plus`;
  if (chemin === 'consent') return '« consent » : « opted_in » ou « opted_out » est attendu';
  if (chemin === 'consentSource') return `« consentSource » : ${MAX_OPT_IN_SOURCE} caractères au plus`;
  // Les trois listes d'étiquettes, et un défaut sur l'un de leurs éléments (`addTags.3`) : sans ce second cas,
  // un élément fautif retombait sur le message anglais de zod.
  const liste = chemin.split('.')[0];
  if (liste === 'tags' || liste === 'addTags' || liste === 'removeTags') {
    if (chemin !== liste) return `« ${chemin} » : une étiquette est un texte ou un nombre`;
    // La borne vient de l'issue : trois schémas la posent (10 en lot, 20 ailleurs), aucune constante ne la connaît.
    return i.code === 'too_big'
      ? `« ${chemin} » : ${String(i.maximum)} étiquettes au plus par fiche`
      : `« ${chemin} » : une liste d’étiquettes en texte est attendue`;
  }
  if (i.code === 'invalid_key') return `« ${chemin} » : clé de champ invalide (texte, ${MAX_CLE_CHAMP} caractères au plus)`;
  if (chemin === 'fields') {
    // Le message du `refine` porte la borne de son schéma (`champsAuPlus`).
    return i.code === 'custom' ? i.message : '« fields » : un objet { clé: valeur } est attendu';
  }
  if (chemin.startsWith('fields.')) return `« ${chemin} » : texte, nombre ou booléen attendu`;
  if (chemin === 'phone') return '« phone » : un numéro de téléphone (texte non vide) est attendu';
  if (chemin === 'optInSource') return `« optInSource » : ${MAX_OPT_IN_SOURCE} caractères au plus`;
  return `« ${chemin} » : ${i.message}`;
}

export interface ApiUpsertOutcome {
  index: number;
  status: 'created' | 'updated' | 'error';
  contactId?: string;
  reason?: string;
  /** La limite de contacts de l'offre atteinte (lot 6) : sa valeur, pour un refus 402 qui la dit. */
  limite?: number;
}

/** Les étiquettes d'une fiche reçue par l'API, nettoyées comme toute pose (`nettoyerEtiquettes`) et bornées à 50. */
export const normalizeTags = (v: unknown): string[] =>
  Array.isArray(v) ? nettoyerEtiquettes(v.map(String), 50) : [];

/**
 * Combien d'upserts en vol à la fois : 4, MOINS que le pool de la copie (`DB_POOL_MAX` de `mba-api`, dans
 * `docker-compose.yml` ; l'écart est tenu par `tests/budget-pooler.test.ts`), parce que cette API ne doit pas prendre tout
 * le pool pendant qu'un opérateur charge son inbox.
 * Chaque upsert est une instruction `on conflict` : deux vagues ne peuvent pas s'interbloquer.
 */
export const ECRITURES_EN_VOL = 4;

/** Ce que rend la préparation des champs d'un contact : les valeurs canoniques, ou la raison du refus. */
export type ChampsPrepares = { ok: true; valeurs: Record<string, string> } | { ok: false; raison: string };

/**
 * Préparer les champs d'un contact : résoudre chaque référence (clé technique ou code), auto-créer en texte
 * un champ inconnu dans la limite du plafond, valider et canonicaliser chaque valeur. Définitions chargées
 * une fois ; le cache grossit au fil des appels.
 *
 * Le plafond se compte sur `defs`, qui grossit au fil du lot : compté sur la photo d'avant, un lot portant
 * une clé distincte par contact passerait entier. Il ne refuse que la création : un contact qui n'utilise que
 * des champs déclarés passe, même au plafond.
 *
 * `champInconnu` est requis : l'API publique refuse (un champ se crée dans la console), le webhook entrant
 * (mapping configuré par un admin) et la console créent. Un appelant de plus doit choisir.
 */
export async function preparateurDeChamps(
  tenantId: string,
  deps: { fields: UserFieldStore; maxChampsParEspace?: number; champInconnu: 'creer' | 'refuser' },
): Promise<(champs: Record<string, string> | undefined) => Promise<ChampsPrepares>> {
  const defs = await deps.fields.list(tenantId);
  const cache: FieldLister = { list: async () => defs };
  const ensured = new Set<string>();
  const plafondEspace = deps.maxChampsParEspace ?? config.API_MAX_CHAMPS_PAR_ESPACE;
  const plafondAtteint = (): boolean => plafondEspace > 0 && defs.length >= plafondEspace;
  return async (champs) => {
    const valeurs: Record<string, string> = {};
    for (const [ref, rawVal] of Object.entries(champs ?? {})) {
      const resolved = await resolveFieldKey(tenantId, ref, cache);
      if (!resolved.ok) return { ok: false, raison: `champ inconnu : ${ref}` };
      // La clé d'un champ FIXE de la fiche ne s'écrit jamais par ce chemin : la dernière analyse n'est écrite que par
      // l'analyse, et un champ perso homonyme se confondrait avec elle.
      if (!resolved.known && estCleReservee(resolved.key)) {
        return { ok: false, raison: `« ${ref} » : champ réservé de la fiche, il ne s'écrit pas par l'API.` };
      }
      if (!resolved.known && !ensured.has(resolved.key)) {
        if (deps.champInconnu === 'refuser') {
          return { ok: false, raison: `« ${ref} » : champ inconnu de cet espace. Créez-le dans la console (Bibliothèque > Champs), puis relancez.` };
        }
        if (plafondAtteint()) {
          // La raison nomme le geste qui débloque : un refus sans issue devient un ticket de support.
          return { ok: false, raison: `« ${resolved.key} » : cet espace a atteint son plafond de ${plafondEspace} champs personnalisés. Créez-le depuis la console, puis relancez.` };
        }
        await ensureFieldByKey(deps.fields, tenantId, resolved.key, resolved.key, 'text');
        ensured.add(resolved.key);
        defs.push({ key: resolved.key, label: resolved.key, type: 'text' } as UserFieldDef);
      }
      const val = String(rawVal);
      if (!validateFieldValue(resolved.type, val)) {
        // Une date refusée dit pourquoi (ambiguë, sans heure, illisible) : l'intégrateur d'un webhook ne voit pas
        // notre écran.
        const detail = resolved.type === 'date' || resolved.type === 'datetime'
          ? raisonDateLisible((normaliserDate(val, resolved.type) as { raison: 'ambigu' | 'sans_heure' | 'illisible' }).raison)
          : `valeur invalide (${resolved.type})`;
        return { ok: false, raison: `« ${resolved.key} » : ${detail}` };
      }
      valeurs[resolved.key] = canonicalizeFieldValue(resolved.type, val);
    }
    return { ok: true, valeurs };
  };
}

export async function upsertContactsFromApi(
  tenantId: string,
  items: ApiContactInput[],
  deps: {
    contacts: PgContactStore;
    fields: PgUserFieldStore;
    defaultCountry?: CountryCode;
    /**
     * Combien de définitions de champs un espace peut porter ; défaut `API_MAX_CHAMPS_PAR_ESPACE`, 0 désactive.
     * Injectable pour que les tests fassent varier la borne.
     */
    maxChampsParEspace?: number;
  },
): Promise<ApiUpsertOutcome[]> {
  // Upsert d'un lot de contacts désignés par leur numéro (webhook entrant, création à la main dans la
  // console) ; un item invalide rend `error` sans faire échouer les autres, un outcome par item. La préparation
  // des champs est partagée avec l'API publique (`preparateurDeChamps`) : ici on crée un champ inconnu, l'API
  // refuse.
  const preparer = await preparateurDeChamps(tenantId, { ...deps, champInconnu: 'creer' });

  // Deux temps : la validation reste séquentielle (cache de définitions partagé, création possible au
  // passage), les écritures partent par vagues, là où était le coût (un aller-retour par upsert).
  const out: ApiUpsertOutcome[] = [];
  const aEcrire: Array<{ index: number; upsert: Parameters<PgContactStore['upsertByPhoneReturningId']>[0] }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const p = normalizePhone(String(item.phone ?? ''), deps.defaultCountry ?? 'FR');
    if (!p.e164) {
      out.push({ index: i, status: 'error', reason: p.error ?? 'téléphone invalide' });
      continue;
    }

    const prep = await preparer(item.fields);
    if (!prep.ok) {
      out.push({ index: i, status: 'error', reason: prep.raison });
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
        fields: prep.valeurs,
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
        // La limite de contacts de l'offre (lot 6) : refusée à SA ligne, avec la phrase et la limite ; les autres passent.
        if (err instanceof LimiteOffreError) return { index, status: 'error', reason: err.message, limite: err.max };
        // `contacts_tenant_bsuid_uidx` rend le BSUID unique par espace : le violer est une erreur de saisie, pas une
        // panne. En 500, Cloudflare remplacerait le corps par sa page, et l'opérateur ne verrait pas la raison.
        if ((err as { code?: string }).code === '23505') {
          return { index, status: 'error', reason: 'ce BSUID est déjà utilisé par un autre contact de cet espace' };
        }
        throw err;
      }
    }));
    out.push(...resultats);
  }
  // Validation et écritures poussent leurs résultats à des moments différents : on retrie sur l'index pour
  // rendre l'ordre reçu, qui est le contrat.
  return out.sort((a, b) => a.index - b.index);
}
