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

/**
 * LES BORNES DE FORME D'UN CONTACT POUSSÉ PAR L'API.
 *
 * 🔴 ELLES SONT LARGES, ET LEUR VALEUR VIENT D'UNE MESURE, pas d'une intuition (base de production,
 * le 2026-09-14) : 10 définitions de champs en tout sur l'ensemble des espaces, l'espace le plus fourni
 * en porte 9, la clé la plus longue fait 11 caractères, aucun contact ne porte plus de 6 champs, et
 * `opt_in_source` ne dépasse pas 12 caractères. Chacune de ces bornes est donc entre 5 et 8 fois
 * au-dessus de l'usage réel : un intégrateur normal ne peut pas les rencontrer, une boucle d'appels s'y
 * heurte tout de suite.
 *
 * ⚠️ CE N'EST PAS LE PLAFOND PAR ESPACE, qui est un autre sujet (le nombre total de définitions qu'une
 * série d'appels peut faire naître). Ici on borne UN contact, dans le corps d'UNE requête.
 */
export const MAX_CLE_CHAMP = config.API_MAX_CLE_CHAMP;
export const MAX_CHAMPS_PAR_CONTACT = config.API_MAX_CHAMPS_PAR_CONTACT;
/**
 * ⚠️ CELLE-CI N'EST PAS CONFIGURABLE, et c'est un choix : `optInSource` JUSTIFIE un consentement
 * (`crm`, `csv_import`, `webhook:<nom>`, 12 caractères au plus en production). Aucun réglage d'exploitation
 * n'a de raison de la desserrer, là où les deux autres peuvent gêner un intégrateur légitime.
 */
export const MAX_OPT_IN_SOURCE = 100;
/**
 * ⚠️ LE SERVICE EN GARDE 50 APRÈS DÉDUPLICATION : cette borne-ci est celle du CORPS REÇU, volontairement
 * plus haute (une liste de 60 tags dont 15 doublons reste légitime). Ce qu'elle refuse, c'est le tableau
 * démesuré, pas l'appel un peu bavard.
 */
export const MAX_TAGS_PAR_CONTACT = 200;

/**
 * ⚠️ UN NOMBRE ET UN BOOLÉEN RESTENT ACCEPTÉS, convertis en texte. Le service faisait déjà `String(...)`
 * sur la valeur : les refuser casserait toute intégration qui envoie `{age: 42}` pour aucun gain. Ce
 * qu'on refuse, c'est ce dont il n'existe pas de texte SENSÉ : un objet (stocké « [object Object] »,
 * donnée irrécupérable), un tableau, `null`.
 */
export const valeurDeChamp = z.union([z.string(), z.number(), z.boolean()]).transform(String);

/** Les champs d'un contact : clé bornée, valeur texte, et pas plus de `MAX_CHAMPS_PAR_CONTACT` par contact. */
export const schemaChamps = z.record(z.string().max(MAX_CLE_CHAMP), valeurDeChamp)
  .refine((r) => Object.keys(r).length <= MAX_CHAMPS_PAR_CONTACT);

/** Des étiquettes : le tableau démesuré est refusé, pas tronqué (cf. la note de `schemaContactApi`). */
export const schemaTags = z.array(z.union([z.string(), z.number()]).transform(String)).max(MAX_TAGS_PAR_CONTACT);

/**
 * CE QU'UN CONTACT POUSSÉ PAR L'API A LE DROIT D'ÊTRE.
 *
 * 🔴 IL EXISTE PARCE QUE LA ROUTE CASTAIT (`as ApiContactInput[]`) APRÈS AVOIR COMPTÉ LES ÉLÉMENTS.
 * Le `as` est un mensonge au compilateur : tout le contenu arrivait non vérifié dans un service écrit
 * pour des objets bien formés. Quatre gestes ordinaires d'un intégrateur suffisaient à faire des dégâts,
 * dont deux définitifs (un champ personnalisé par caractère dans l'espace du client, une valeur stockée
 * « [object Object] ») et un opaque (un `null` au milieu d'un lot emportait le LOT ENTIER en 500, dont
 * Cloudflare remplace le corps par sa page).
 *
 * ⚠️ LES CLÉS INCONNUES SONT ÉCARTÉES, PAS REFUSÉES (comportement par défaut de Zod, vérifié) : un
 * intégrateur qui laisse traîner un champ de son propre modèle ne doit pas être bloqué pour ça.
 */
export const schemaContactApi = z.object({
  phone: z.string().trim().min(1),
  name: z.string().optional(),
  fields: schemaChamps.optional(),
  /**
   * ⚠️ BORNÉE ICI AUSSI (relevé en revue) : le service coupe déjà à 50 tags, mais il coupe APRÈS avoir
   * reçu la liste. Un tableau de 100 000 entrées traversait donc la validation entière pour finir
   * tronqué. On refuse au lieu de tronquer, comme partout ailleurs dans ce schéma.
   */
  tags: schemaTags.optional(),
  optIn: z.boolean().optional(),
  optInSource: z.string().max(MAX_OPT_IN_SOURCE).optional(),
  bsuid: z.string().optional(),
});

/**
 * UN CONTACT POUSSÉ PAR L'API : téléphone + attributs optionnels. `fields` adressés par clé technique OU code.
 *
 * 🔴 IL EST DÉRIVÉ DU SCHÉMA, ET C'EST TOUT L'INTÉRÊT. Écrit à la main à côté, il redeviendrait une
 * seconde vérité : le jour où l'un des deux gagne un champ, l'autre le refuse ou le laisse passer sans
 * que rien ne le signale. Le type est ce que la validation REND, jamais ce qu'on espère recevoir.
 */
export type ApiContactInput = z.infer<typeof schemaContactApi>;

/** Les clés qu'un schéma REFUSE (`z.never`), et ce qu'on dit à qui les envoie. */
const CLES_REFUSEES: Record<string, string> = {
  optIn: '« optIn » n’existe plus : utilisez « consent » (« opted_in » ou « opted_out »)',
  optInSource: '« optInSource » n’existe plus : utilisez « consentSource »',
  phone: '« phone » ne se modifie pas : le numéro porte les conversations de la fiche',
  bsuid: '« bsuid » ne se modifie pas : il porte les conversations de la fiche',
};

/**
 * CE QU'ON DIT À L'INTÉGRATEUR QUAND SON ÉLÉMENT EST REFUSÉ.
 *
 * 🔴 LE CHEMIN AVANT LE MESSAGE, parce que c'est le chemin qui le fait corriger : « fields.adresse »
 * lui désigne la ligne à reprendre, là où « Invalid input » l'envoie relire son lot entier.
 *
 * ⚠️ LES MESSAGES DE ZOD SONT EN ANGLAIS ET PEU PARLANTS (mesuré : une clé de champ trop longue rend
 * « Invalid key in record », une valeur imbriquée rend « Invalid input »). Le reste de cette API répond
 * en français à des intégrateurs français : on traduit donc les cas qu'on provoque nous-mêmes, et on
 * garde le message d'origine pour les autres plutôt que d'inventer une phrase qui pourrait être fausse.
 */
export function raisonDeValidation(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'contact invalide';
  /**
   * ⚠️ LE CHEMIN EST BORNÉ AVANT D'ÊTRE RECOPIÉ (relevé en revue). Il contient la CLÉ envoyée par
   * l'appelant : sans cette coupe, une clé de 5 000 caractères reviendrait telle quelle dans la réponse,
   * multipliée par le nombre de lignes fautives. Ce n'est pas une fuite, c'est une amplification, et
   * c'est précisément ce que ce lot existe pour fermer.
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
  // Les trois listes d'étiquettes, et un défaut sur l'un de leurs ÉLÉMENTS (`addTags.3`) : sans ce second cas,
  // un élément fautif retombait sur le message anglais de zod.
  const liste = chemin.split('.')[0];
  if (liste === 'tags' || liste === 'addTags' || liste === 'removeTags') {
    return chemin === liste
      ? `« ${chemin} » : une liste de ${MAX_TAGS_PAR_CONTACT} étiquettes au plus, en texte`
      : `« ${chemin} » : une étiquette est un texte ou un nombre`;
  }
  if (i.code === 'invalid_key') return `« ${chemin} » : clé de champ invalide (texte, ${MAX_CLE_CHAMP} caractères au plus)`;
  if (chemin === 'fields') {
    return i.code === 'custom'
      ? `« fields » : un contact ne peut pas porter plus de ${MAX_CHAMPS_PAR_CONTACT} champs`
      : '« fields » : un objet { clé: valeur } est attendu';
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
}

export const normalizeTags = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((t) => String(t).trim().slice(0, 64)).filter((t) => t !== ''))].slice(0, 50) : [];

/**
 * Upsert d'un lot de contacts désignés par leur NUMÉRO (webhook entrant, création à la main de la console).
 * L'API publique ne passe plus par ici : elle désigne une fiche par plusieurs clés (`src/api/contacts-v1.ts`).
 * Par item : normalise le téléphone,
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
export const ECRITURES_EN_VOL = 4;

/** Ce que rend la préparation des champs d'UN contact : les valeurs canoniques, ou la raison du refus. */
export type ChampsPrepares = { ok: true; valeurs: Record<string, string> } | { ok: false; raison: string };

/**
 * PRÉPARER LES CHAMPS D'UN CONTACT : résoudre chaque référence (clé technique OU code, D-2), auto-créer en
 * texte un champ inconnu dans la limite du plafond, valider et canonicaliser chaque valeur.
 *
 * Les définitions sont chargées UNE fois, et le cache GROSSIT au fil des appels : un champ auto-créé par un
 * contact est connu du suivant sans relire la base.
 *
 * 🔴 LE PLAFOND SE COMPTE SUR `defs`, QUI GROSSIT AU FIL DU LOT, et c'est ce qui en fait une borne.
 * Compté sur la seule photo d'avant, un unique appel de 500 contacts portant 500 clés distinctes
 * passerait entièrement : le plafond ne serait qu'un compteur d'historique.
 *
 * ⚠️ IL VAUT POUR TOUS LES CHEMINS QUI PRÉPARENT DES CHAMPS PAR ICI : l'API publique, le webhook entrant
 * (`src/webhook-entrant/chemin.ts`) et la création à la main de la console. C'est voulu, l'amplification
 * est la même ; et le webhook y est le moins exposé, puisque ses clés de champs viennent d'un mapping qu'un
 * ADMIN de l'espace a configuré, pas du payload d'un tiers.
 *
 * ⚠️ ET IL NE REFUSE QUE LA CRÉATION. Un contact qui n'utilise que des champs DÉJÀ déclarés passe, même
 * au plafond, y compris dans le lot où un autre contact vient d'être refusé. Un plafond qui bloquerait
 * l'espace entier une fois atteint changerait une protection en panne.
 */
export async function preparateurDeChamps(
  tenantId: string,
  deps: { fields: UserFieldStore; maxChampsParEspace?: number },
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
      if (!resolved.known && !ensured.has(resolved.key)) {
        if (plafondAtteint()) {
          // La raison NOMME le geste qui débloque : l'intégrateur ne peut pas deviner qu'un champ se crée
          // aussi depuis la console, et un refus sans issue se transforme en ticket de support.
          return { ok: false, raison: `« ${resolved.key} » : cet espace a atteint son plafond de ${plafondEspace} champs personnalisés. Créez-le depuis la console, puis relancez.` };
        }
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
     * COMBIEN DE DÉFINITIONS DE CHAMPS UN ESPACE PEUT PORTER. Défaut : `API_MAX_CHAMPS_PAR_ESPACE`, 0 désactive.
     *
     * ⚠️ INJECTABLE PLUTÔT QUE LUE ICI, pour que les tests l'exercent sans remonter le module : une borne
     * qu'on ne peut pas faire varier ne se teste que sur sa valeur du jour, donc pas du tout.
     */
    maxChampsParEspace?: number;
  },
): Promise<ApiUpsertOutcome[]> {
  // La préparation des champs est PARTAGÉE avec l'API publique (`preparateurDeChamps`) : mêmes règles de
  // résolution, d'auto-création et de plafond, un seul cache par appel.
  const preparer = await preparateurDeChamps(tenantId, deps);

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
