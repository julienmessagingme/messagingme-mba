import { z } from 'zod';
import type { AuditSink } from '../audit/journal';
import type { ClesNormalisees, FicheApiLigne, PgContactStore } from '../crm/contact-store.pg';
import type { UserFieldStore } from '../crm/fields';
import { verdictWhatsApp } from '../contacts/joignabilite';
import type { NiveauRisque, RaisonRisque } from '../engagement/risque';
import { estUuid } from '../http/scope';
import { resolveFieldKey } from '../ids/resolve';
import {
  champsAuPlus, ECRITURES_EN_VOL, MAX_CLE_CHAMP, MAX_OPT_IN_SOURCE, MAX_PAR_FICHE, MAX_PAR_FICHE_EN_LOT,
  normalizeTags, preparateurDeChamps, schemaChamps, schemaTags, valeurDeChamp,
} from './contacts-upsert';
import { appliquerConsentement, depsConsentementDe } from './consentement';
import type { CodeApi } from './erreurs';
import { MAX_EXTERNAL_ID, MESSAGE_RESOLUTION, normaliserCles, resoudreFiche, schemaClesFiche, videEnAbsent } from './fiche';

/**
 * Les fiches de l'API publique (`/v1/contacts`). Une personne est une fiche, désignée par ce que
 * l'intégrateur a et trouvée par `resoudreFiche`. On n'écrit qu'après : champs validés, fiche résolue (ou
 * créée), puis édition, puis consentement ; un champ refusé ne crée jamais de fiche, un conflit d'identité
 * n'écrit rien. `upsertContactsFromApi` (numéro seul, promotion seule) n'est pas sur ce chemin.
 */

// Une chaîne vide vaut absence, comme pour les clés (`videEnAbsent`) : un outil envoie `""` pour une
// variable de profil absente. Une valeur fausse (« oui ») reste refusée.
const consent = z.preprocess(videEnAbsent, z.enum(['opted_in', 'opted_out']).optional());
const consentSource = z.preprocess(videEnAbsent, z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional());

/** Une fiche, avec au plus `max` champs et `max` étiquettes : 20 à l'unité, 10 dans un lot (`MAX_PAR_FICHE*`). */
const schemaFicheV1 = (max: number) => schemaClesFiche.extend({
  name: z.preprocess(videEnAbsent, z.string().optional()),
  fields: schemaChamps(max).optional(),
  tags: schemaTags(max).optional(),
  consent,
  consentSource,
  // Refusées, pas ignorées : un intégrateur qui les enverrait encore croirait avoir consigné un opt-in.
  optIn: z.never().optional(),
  optInSource: z.never().optional(),
});
export const schemaContactV1 = schemaFicheV1(MAX_PAR_FICHE);
export const schemaContactLotV1 = schemaFicheV1(MAX_PAR_FICHE_EN_LOT);
export type ContactV1 = z.infer<typeof schemaContactV1>;

export const schemaPatchContactV1 = z.object({
  // Seul `null` vide le nom : une chaîne blanche est une variable absente, pas une demande d'effacement.
  name: z.preprocess(videEnAbsent, z.union([z.string(), z.null()]).optional()),
  fields: z.record(z.string().max(MAX_CLE_CHAMP), z.union([valeurDeChamp, z.null()]))
    .refine((r) => Object.keys(r).length <= MAX_PAR_FICHE, { message: champsAuPlus(MAX_PAR_FICHE) })
    .optional(),
  addTags: schemaTags(MAX_PAR_FICHE).optional(),
  removeTags: schemaTags(MAX_PAR_FICHE).optional(),
  consent,
  consentSource,
  externalId: z.preprocess(videEnAbsent, z.string().trim().max(MAX_EXTERNAL_ID).optional()),
  // Ils portent les conversations : les changer couperait la fiche de son historique.
  phone: z.never().optional(),
  bsuid: z.never().optional(),
});
export type PatchContactV1 = z.infer<typeof schemaPatchContactV1>;

/** Une recherche, pas un rattachement : exactement une clé, et jamais le numéro dans l'adresse. */
export const schemaRechercheContactV1 = schemaClesFiche.omit({ contactId: true }).refine(
  (c) => [c.phone, c.bsuid, c.externalId].filter((v) => v !== undefined).length === 1,
  { message: 'donnez exactement une clé : « phone », « bsuid » ou « externalId »' },
);
export type RechercheContactV1 = z.infer<typeof schemaRechercheContactV1>;

export type ResultatFiche =
  | { index: number; status: 'created' | 'updated'; contactId: string }
  | { index: number; status: 'error'; code: CodeApi; reason: string };

export type ResultatRecherche = { ok: true; fiche: FicheApi | null } | { ok: false; code: 'invalid_phone'; reason: string };
export type ResultatModification = { ok: true; contactId: string } | { ok: false; code: CodeApi; reason: string };

/** Le contrat de `GET /v1/contacts/{contactId}`. `null` = inconnu, jamais « faux » par défaut. */
export interface FicheApi {
  contactId: string;
  externalId: string | null;
  phone: string | null;
  bsuid: string | null;
  name: string | null;
  fields: Record<string, unknown>;
  tags: string[];
  consent: { status: 'opted_in' | 'opted_out' | 'unknown'; source: string | null; optedOutAt: string | null };
  rcsOptedOutAt: string | null;
  blocked: boolean;
  reachability: { whatsapp: boolean | null; rcs: boolean | null };
  /**
   * Le risque de désengagement, calculé chaque nuit ; `null` = jamais calculé. `level: 'inconnu'` va toujours
   * avec `score: null` (aucun message délivré sur 90 jours). `reasons` : les trois raisons les plus lourdes.
   * `computedAt` date le passage à ce niveau : il ne bouge qu'au changement de niveau, score et raisons sont
   * toujours à jour.
   */
  engagementRisk: EngagementRisk | null;
  createdAt: string;
}

export interface EngagementRisk {
  level: NiveauRisque;
  score: number | null;
  reasons: RaisonRisque[];
  computedAt: string;
}

/**
 * Le risque tel que l'API le rend. Un niveau sans date de calcul ne peut exister (CHECK de la base) : s'il se
 * présentait, `null` plutôt qu'un `computedAt` inventé.
 */
function risqueDeLaFiche(l: FicheApiLigne): EngagementRisk | null {
  if (l.risqueNiveau === null || l.risqueCalculeLe === null) return null;
  return { level: l.risqueNiveau, score: l.risqueScore, reasons: [...l.risqueRaisons], computedAt: l.risqueCalculeLe };
}

export function formaterFicheApi(l: FicheApiLigne, rcs: boolean | null, maintenant: Date): FicheApi {
  // La règle de péremption est celle du mini-CRM (`verdictWhatsApp`), jamais une seconde définition.
  const whatsapp = verdictWhatsApp(l.whatsappJoignable, l.whatsappJoignableLe ? new Date(l.whatsappJoignableLe) : null, maintenant);
  const status = l.optInStatus === 'opted_in' || l.optInStatus === 'opted_out' ? l.optInStatus : 'unknown';
  return {
    contactId: l.id,
    externalId: l.externalId,
    phone: l.phoneE164,
    bsuid: l.bsuid,
    name: l.profileName,
    fields: l.fields,
    tags: l.tags,
    consent: { status, source: l.optInSource, optedOutAt: l.optOutAt },
    rcsOptedOutAt: l.rcsOptoutAt,
    blocked: l.blockedAt !== null,
    reachability: { whatsapp: whatsapp === 'inconnu' ? null : whatsapp === 'oui', rcs },
    engagementRisk: risqueDeLaFiche(l),
    createdAt: l.createdAt,
  };
}

export interface ServiceContactsV1 {
  ecrireFiches(tenantId: string, items: ContactV1[]): Promise<ResultatFiche[]>;
  lireFiche(tenantId: string, contactId: string): Promise<FicheApi | null>;
  chercherFiche(tenantId: string, recherche: RechercheContactV1): Promise<ResultatRecherche>;
  modifierFiche(tenantId: string, contactId: string, patch: PatchContactV1): Promise<ResultatModification>;
}

export interface DepsServiceContactsV1 {
  // `editerFicheApi` et pas `applyEdits` : une requête filtrée par `deleted_at is null`, pas une transaction
  // par élément qui verrouille sans ce filtre.
  contacts: Pick<PgContactStore, 'chercherParCles' | 'creerFicheApi' | 'rattacherCles' | 'editerFicheApi' | 'poserExternalId' | 'lireFicheApi' | 'ecrireConsentementParId' | 'etiquettesInconnues'>;
  fields: UserFieldStore;
  /** Requis : le consentement posé par l'API se journalise (`appliquerConsentement`). */
  audit: AuditSink;
  /** La joignabilité RCS connue d'un numéro pour l'agent de l'espace. `null` = inconnue, ou pas de canal RCS. */
  joignabiliteRcs(tenantId: string, phoneE164: string): Promise<boolean | null>;
  maintenant?: () => Date;
}

/**
 * L'API ne fait naître aucune étiquette, comme aucun champ : une étiquette inconnue de l'espace refuse la
 * fiche, avant toute écriture. Retirer une étiquette inconnue reste permis.
 */
function raisonEtiquettes(noms: string[]): string {
  const [s, la] = noms.length > 1 ? ['s', 'les'] : ['', 'la'];
  return `étiquette${s} inconnue${s} de cet espace : ${noms.map((n) => `« ${n} »`).join(', ')}. Déclarez-${la} dans la console (Bibliothèque > Étiquettes), puis relancez.`;
}

const INCONNUE_POUR_ECRIRE ='aucune fiche ne correspond, et il faut un « phone » ou un « bsuid » pour en créer une (un « contactId » ne crée jamais de fiche)';

/**
 * 🔴 Un STOP ne se lève pas par machine : l'API fait passer une fiche d'« inconnu » à « opt-in », jamais
 * d'« opt-out » à « opt-in » (une synchronisation au consentement périmé réabonnerait quelqu'un qui a dit
 * stop). La garde du dépôt (`ecrireConsentementParId`) tient la course ; la vérification la fait tomber
 * avant toute écriture, pour qu'un refus ne laisse rien de modifié.
 */
const STOP_NON_LEVABLE = 'cette personne a demandé l’arrêt des messages (STOP) : l’API ne peut pas la réabonner, seul un opérateur (depuis sa fiche) ou la personne elle-même le peut. Ni ses champs, ni ses étiquettes, ni son consentement n’ont été modifiés.';
/**
 * Le STOP est arrivé pendant l'appel, entre la vérification et l'écriture du consentement : le dépôt a
 * refusé le réabonnement, mais les autres champs ont pu être écrits. Le message le dit.
 */
const STOP_PENDANT_L_APPEL = 'cette personne a demandé l’arrêt des messages (STOP) pendant cet appel : son consentement n’a pas été modifié, mais les autres champs demandés ont pu l’être.';

export function creerServiceContactsV1(deps: DepsServiceContactsV1): ServiceContactsV1 {
  const maintenant = deps.maintenant ?? ((): Date => new Date());
  // Une construction, partagée avec `/v1/sends` : `depsConsentementDe`.
  const consentement = depsConsentementDe(deps.contacts, deps.audit);
  const optsChamps = { fields: deps.fields, champInconnu: 'refuser' } as const;

  /** Vrai si le corps demande `opted_in` pour une fiche désabonnée. Une lecture, et seulement dans ce cas. */
  async function leveraitUnStop(tenantId: string, contactId: string, voulu: 'opted_in' | 'opted_out' | undefined): Promise<boolean> {
    if (voulu !== 'opted_in') return false;
    return (await deps.contacts.lireFicheApi(tenantId, contactId))?.optInStatus === 'opted_out';
  }

  /**
   * La même question, posée avant la résolution : `resoudreFiche` écrit (rattache une clé, peut ressusciter
   * une fiche), un refus posé après laisserait un `externalId` rattaché à une fiche désabonnée. Ici, que des
   * lectures, et seulement quand le corps demande `opted_in`.
   */
  async function clesDesignentUnStop(tenantId: string, item: ContactV1): Promise<boolean> {
    if (item.consent !== 'opted_in') return false;
    const n = normaliserCles(item);
    if (!n.ok) return false; // la résolution rendra la bonne erreur de clé
    for (const f of await deps.contacts.chercherParCles(tenantId, n.cles)) {
      if (await leveraitUnStop(tenantId, f.id, 'opted_in')) return true;
    }
    return false;
  }

  async function lireFiche(tenantId: string, contactId: string): Promise<FicheApi | null> {
    if (!estUuid(contactId)) return null;
    const ligne = await deps.contacts.lireFicheApi(tenantId, contactId);
    if (!ligne) return null;
    const rcs = ligne.phoneE164 ? await deps.joignabiliteRcs(tenantId, ligne.phoneE164) : null;
    return formaterFicheApi(ligne, rcs, maintenant());
  }

  async function ecrireUne(tenantId: string, index: number, item: ContactV1, valeurs: Record<string, string>): Promise<ResultatFiche> {
    // Avant la résolution, qui écrit : un refus ne doit rien laisser, pas même une clé rattachée.
    if (await clesDesignentUnStop(tenantId, item)) {
      return { index, status: 'error', code: 'opted_out', reason: STOP_NON_LEVABLE };
    }
    const r = await resoudreFiche(deps.contacts, tenantId, item, { creer: 'phone_ou_bsuid' });
    if (!r.ok) {
      return { index, status: 'error', code: r.code, reason: r.code === 'unknown_contact' ? INCONNUE_POUR_ECRIRE : MESSAGE_RESOLUTION[r.code] };
    }
    const nom = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim().slice(0, 200) : undefined;
    const tags = normalizeTags(item.tags);
    if (Object.keys(valeurs).length > 0 || tags.length > 0 || nom !== undefined) {
      // `false` : la fiche a été supprimée ou purgée depuis la résolution, rien n'a été écrit.
      const ecrit = await deps.contacts.editerFicheApi(tenantId, r.contactId, {
        fields: valeurs, removeFields: [], addTags: tags, removeTags: [], ...(nom !== undefined ? { profileName: nom } : {}),
      });
      if (!ecrit) return { index, status: 'error', code: 'unknown_contact', reason: MESSAGE_RESOLUTION.unknown_contact };
    }
    if (item.consent) {
      // Une fiche purgée depuis la résolution n'a rien reçu : répondre « updated » ferait croire à un
      // désabonnement enregistré.
      const issue = await appliquerConsentement(consentement, tenantId, r.contactId, item.consent, item.consentSource ?? 'api');
      if (issue === 'absente') return { index, status: 'error', code: 'unknown_contact', reason: MESSAGE_RESOLUTION.unknown_contact };
      // Un STOP arrivé entre la vérification et cette écriture : le dépôt a refusé, on ne répond pas « updated ».
      if (issue === 'refuse') return { index, status: 'error', code: 'opted_out', reason: STOP_PENDANT_L_APPEL };
    }
    return { index, status: r.cree ? 'created' : 'updated', contactId: r.contactId };
  }

  /**
   * Les éléments d'une même personne s'écrivent dans l'ordre, jamais en parallèle. Deux éléments qui
   * partagent une clé normalisée forment une chaîne (lien transitif) : en parallèle, le second pourrait être
   * résolu avant que le premier ait créé la fiche, et rendre `unknown_contact` au hasard.
   */
  function enChaines<E extends { cles: ClesNormalisees }>(elements: E[]): E[][] {
    const parent = elements.map((_, i) => i);
    const racine = (i: number): number => {
      while (parent[i] !== i) i = parent[i]!;
      return i;
    };
    const premierPorteur = new Map<string, number>();
    elements.forEach((e, i) => {
      for (const [nom, valeur] of Object.entries(e.cles)) {
        if (!valeur) continue;
        const cle = `${nom}:${valeur}`;
        const j = premierPorteur.get(cle);
        if (j === undefined) premierPorteur.set(cle, i);
        else parent[racine(i)] = racine(j);
      }
    });
    const chaines = new Map<number, E[]>();
    elements.forEach((e, i) => {
      const r = racine(i);
      const chaine = chaines.get(r);
      if (chaine) chaine.push(e); else chaines.set(r, [e]);
    });
    return [...chaines.values()];
  }

  return {
    async ecrireFiches(tenantId, items) {
      // Deux temps : la préparation des champs est séquentielle (cache partagé), les écritures partent par vagues
      // bornées. Clés, champs et étiquettes sont vérifiés avant la résolution, qui écrit : un élément refusé ne
      // laisse rien, ni fiche ni clé rattachée.
      const preparer = await preparateurDeChamps(tenantId, optsChamps);
      const out: ResultatFiche[] = [];
      const prepares: Array<{ index: number; item: ContactV1; valeurs: Record<string, string>; cles: ClesNormalisees }> = [];
      for (const [index, item] of items.entries()) {
        const cles = normaliserCles(item);
        if (!cles.ok) { out.push({ index, status: 'error', code: cles.code, reason: MESSAGE_RESOLUTION[cles.code] }); continue; }
        const prep = await preparer(item.fields);
        if (!prep.ok) { out.push({ index, status: 'error', code: 'invalid_body', reason: prep.raison }); continue; }
        prepares.push({ index, item, valeurs: prep.valeurs, cles: cles.cles });
      }
      // Une lecture pour les étiquettes de tout le lot, pas une par fiche.
      const inconnues = new Set(await deps.contacts.etiquettesInconnues(tenantId, [...new Set(prepares.flatMap((e) => normalizeTags(e.item.tags)))]));
      const aEcrire = prepares.filter((e) => {
        const manquantes = normalizeTags(e.item.tags).filter((t) => inconnues.has(t));
        if (manquantes.length > 0) out.push({ index: e.index, status: 'error', code: 'invalid_body', reason: raisonEtiquettes(manquantes) });
        return manquantes.length === 0;
      });
      // Au plus `ECRITURES_EN_VOL` chaînes à la fois, chacune séquentielle. Un `contactId` et le numéro de la même
      // fiche portés par deux éléments différents ne se relient pas : la fiche existe déjà, aucun ne dépend de
      // l'autre pour la trouver.
      const chaines = enChaines(aEcrire);
      for (let d = 0; d < chaines.length; d += ECRITURES_EN_VOL) {
        const vague = chaines.slice(d, d + ECRITURES_EN_VOL);
        await Promise.all(vague.map(async (chaine) => {
          for (const e of chaine) out.push(await ecrireUne(tenantId, e.index, e.item, e.valeurs));
        }));
      }
      // Le contrat du lot : un résultat par index, dans l'ordre reçu.
      return out.sort((a, b) => a.index - b.index);
    },

    lireFiche,

    async chercherFiche(tenantId, recherche) {
      const n = normaliserCles(recherche);
      if (!n.ok) {
        return n.code === 'invalid_phone'
          ? { ok: false, code: 'invalid_phone', reason: MESSAGE_RESOLUTION.invalid_phone }
          : { ok: true, fiche: null };
      }
      const [trouvee] = await deps.contacts.chercherParCles(tenantId, n.cles);
      return { ok: true, fiche: trouvee ? await lireFiche(tenantId, trouvee.id) : null };
    },

    async modifierFiche(tenantId, contactId, patch) {
      const champs = Object.entries(patch.fields ?? {});
      const addTags = normalizeTags(patch.addTags);
      const removeTags = normalizeTags(patch.removeTags);
      if (patch.name === undefined && champs.length === 0 && addTags.length === 0 && removeTags.length === 0
        && patch.consent === undefined && patch.externalId === undefined) {
        return { ok: false, code: 'invalid_body', reason: 'rien à modifier : name, fields, addTags, removeTags, consent ou externalId' };
      }
      const r = await resoudreFiche(deps.contacts, tenantId, { contactId }, { creer: 'jamais' });
      if (!r.ok) return { ok: false, code: r.code, reason: r.code === 'unknown_contact' ? 'fiche inconnue' : MESSAGE_RESOLUTION[r.code] };
      if (await leveraitUnStop(tenantId, r.contactId, patch.consent)) return { ok: false, code: 'opted_out', reason: STOP_NON_LEVABLE };

      // Les champs et les étiquettes d'abord : un refus ici ne doit rien laisser d'écrit, pas même l'identifiant
      // externe. Aucune définition de champ ne naît ici (`champInconnu: 'refuser'`).
      const aVider: string[] = [];
      const aPoser: Record<string, string> = {};
      // Les définitions sont lues une fois pour tous les champs à vider, pas une requête par champ `null`.
      const defsAVider = champs.some(([, v]) => v === null) ? await deps.fields.list(tenantId) : [];
      const listeAVider = { list: async () => defsAVider };
      for (const [ref, valeur] of champs) {
        if (valeur !== null) { aPoser[ref] = valeur; continue; }
        const cle = await resolveFieldKey(tenantId, ref, listeAVider);
        if (!cle.ok) return { ok: false, code: 'invalid_body', reason: `champ inconnu : ${ref}` };
        aVider.push(cle.key);
      }
      let valeurs: Record<string, string> = {};
      if (Object.keys(aPoser).length > 0) {
        const prep = await (await preparateurDeChamps(tenantId, optsChamps))(aPoser);
        if (!prep.ok) return { ok: false, code: 'invalid_body', reason: prep.raison };
        valeurs = prep.valeurs;
      }
      const inconnues = addTags.length === 0 ? [] : await deps.contacts.etiquettesInconnues(tenantId, addTags);
      if (inconnues.length > 0) return { ok: false, code: 'invalid_body', reason: raisonEtiquettes(inconnues) };

      if (patch.externalId !== undefined) {
        const e = await deps.contacts.poserExternalId(tenantId, r.contactId, patch.externalId);
        if (e === 'conflit') return { ok: false, code: 'identity_conflict', reason: 'cet identifiant externe est déjà porté par une autre fiche de cet espace' };
        if (e === 'absente') return { ok: false, code: 'unknown_contact', reason: 'fiche inconnue' };
      }

      // Seul `null` vide le nom ; une chaîne blanche vaut absence (déjà écartée par le schéma).
      const nom = patch.name === null
        ? null
        : typeof patch.name === 'string' && patch.name.trim() !== '' ? patch.name.trim().slice(0, 200) : undefined;
      if (Object.keys(valeurs).length > 0 || aVider.length > 0 || addTags.length > 0 || removeTags.length > 0 || nom !== undefined) {
        const ecrit = await deps.contacts.editerFicheApi(tenantId, r.contactId, {
          fields: valeurs, removeFields: aVider, addTags, removeTags, ...(nom !== undefined ? { profileName: nom } : {}),
        });
        if (!ecrit) return { ok: false, code: 'unknown_contact', reason: 'fiche inconnue' };
      }
      if (patch.consent) {
        const issue = await appliquerConsentement(consentement, tenantId, r.contactId, patch.consent, patch.consentSource ?? 'api');
        if (issue === 'absente') return { ok: false, code: 'unknown_contact', reason: 'fiche inconnue' };
        if (issue === 'refuse') return { ok: false, code: 'opted_out', reason: STOP_PENDANT_L_APPEL };
      }
      return { ok: true, contactId: r.contactId };
    },
  };
}
