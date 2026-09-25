// src/api/contacts-v1.ts
import { z } from 'zod';
import type { AuditSink } from '../audit/journal';
import type { ClesNormalisees, FicheApiLigne, PgContactStore } from '../crm/contact-store.pg';
import type { UserFieldStore } from '../crm/fields';
import { verdictWhatsApp } from '../contacts/joignabilite';
import type { NiveauRisque, RaisonRisque } from '../engagement/risque';
import { estUuid } from '../http/scope';
import { resolveFieldKey } from '../ids/resolve';
import {
  ECRITURES_EN_VOL, MAX_CHAMPS_PAR_CONTACT, MAX_CLE_CHAMP, MAX_OPT_IN_SOURCE,
  normalizeTags, preparateurDeChamps, schemaChamps, schemaTags, valeurDeChamp,
} from './contacts-upsert';
import { appliquerConsentement, depsConsentementDe } from './consentement';
import type { CodeApi } from './erreurs';
import { MAX_EXTERNAL_ID, MESSAGE_RESOLUTION, normaliserCles, resoudreFiche, schemaClesFiche, videEnAbsent } from './fiche';

/**
 * LES FICHES DE L'API PUBLIQUE (`/v1/contacts`, spec du 2026-09-24, § 2).
 *
 * 🔴 UNE PERSONNE EST UNE FICHE : elle se désigne par ce que l'intégrateur a, et `resoudreFiche` la trouve.
 * Ce service n'écrit qu'APRÈS : champs validés, fiche résolue (ou créée), puis édition, puis consentement.
 * Un champ refusé ne crée donc jamais de fiche, et un conflit d'identité n'écrit rien.
 *
 * ⚠️ `upsertContactsFromApi` N'EST PLUS SUR CE CHEMIN : il désigne un contact par son numéro seul, et ne sait
 * que promouvoir un consentement. Il reste celui du webhook entrant et de la création à la main.
 */

// Une chaîne vide ou blanche vaut ABSENCE, comme pour les quatre clés (`videEnAbsent`) : un outil qui remplit
// son corps avec les variables d'un profil envoie `""` pour une variable absente, et refuser l'élément entier
// pour un consentement vide serait refuser précisément ce cas. Une valeur FAUSSE (« oui ») reste refusée.
const consent = z.preprocess(videEnAbsent, z.enum(['opted_in', 'opted_out']).optional());
const consentSource = z.preprocess(videEnAbsent, z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional());

export const schemaContactV1 = schemaClesFiche.extend({
  name: z.preprocess(videEnAbsent, z.string().optional()),
  fields: schemaChamps.optional(),
  tags: schemaTags.optional(),
  consent,
  consentSource,
  // REFUSÉES, pas ignorées : elles décrivaient le consentement avant `consent`, et un intégrateur qui les
  // enverrait encore croirait avoir consigné un opt-in qui n'existerait nulle part.
  optIn: z.never().optional(),
  optInSource: z.never().optional(),
});
export type ContactV1 = z.infer<typeof schemaContactV1>;

export const schemaPatchContactV1 = z.object({
  // Seul `null` VIDE le nom : une chaîne blanche est une variable absente, pas une demande d'effacement.
  name: z.preprocess(videEnAbsent, z.union([z.string(), z.null()]).optional()),
  fields: z.record(z.string().max(MAX_CLE_CHAMP), z.union([valeurDeChamp, z.null()]))
    .refine((r) => Object.keys(r).length <= MAX_CHAMPS_PAR_CONTACT)
    .optional(),
  addTags: schemaTags.optional(),
  removeTags: schemaTags.optional(),
  consent,
  consentSource,
  externalId: z.preprocess(videEnAbsent, z.string().trim().max(MAX_EXTERNAL_ID).optional()),
  // Ils portent les conversations : les changer couperait la fiche de son historique.
  phone: z.never().optional(),
  bsuid: z.never().optional(),
});
export type PatchContactV1 = z.infer<typeof schemaPatchContactV1>;

/** Une RECHERCHE, pas un rattachement : exactement une clé, et jamais le numéro dans l'adresse. */
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

/** Le contrat de `GET /v1/contacts/{contactId}` (§ 2). `null` = inconnu, jamais « faux » par défaut. */
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
   * Le risque de désengagement (lot 7, spec § 19), calculé chaque nuit. `null` = jamais calculé (la fiche n'a
   * jamais été sollicitée, ou le balayage n'est pas encore passé). `level: 'inconnu'` va toujours avec
   * `score: null` : aucun message ne lui a été délivré sur 90 jours. `reasons` : les trois raisons les plus
   * lourdes, en codes. `computedAt` : quand la fiche est passée à CE niveau. Le calcul repasse chaque nuit, mais
   * cette date ne bouge qu'au changement de niveau ; le score et les raisons, eux, sont toujours à jour (relecture
   * du lot 7 : réécrire chaque fiche chaque nuit pour dater une vérification coûtait une version morte par fiche).
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
 * Le risque tel que l'API le rend. ⚠️ Un niveau sans date de calcul ne peut pas exister (CHECK de 0178) : s'il se
 * présentait quand même, on rend `null` plutôt qu'un `computedAt` inventé.
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
  // par élément qui verrouille sans ce filtre (cf. son docblock dans `src/crm/contact-store.pg.ts`).
  contacts: Pick<PgContactStore, 'chercherParCles' | 'creerFicheApi' | 'rattacherCles' | 'editerFicheApi' | 'poserExternalId' | 'lireFicheApi' | 'ecrireConsentementParId'>;
  fields: UserFieldStore;
  /** REQUIS : le consentement posé par l'API se journalise (`appliquerConsentement`). */
  audit: AuditSink;
  /** La joignabilité RCS CONNUE d'un numéro pour l'agent de l'espace. `null` = inconnue, ou pas de canal RCS. */
  joignabiliteRcs(tenantId: string, phoneE164: string): Promise<boolean | null>;
  maxChampsParEspace?: number;
  maintenant?: () => Date;
}

const INCONNUE_POUR_ECRIRE = 'aucune fiche ne correspond, et il faut un « phone » ou un « bsuid » pour en créer une (un « contactId » ne crée jamais de fiche)';

/**
 * 🔴 UN STOP NE SE LÈVE PAS PAR MACHINE (décision de Julien du 2026-09-24). L'API fait passer une fiche de
 * « inconnu » à « opt-in », jamais d'« opt-out » à « opt-in » : une synchronisation qui porte un consentement
 * périmé réabonnerait quelqu'un qui nous a dit stop. La garde du dépôt (`ecrireConsentementParId`) tient la
 * course ; la vérification ci-dessous la fait tomber AVANT toute écriture, pour qu'un refus ne laisse ni
 * champ, ni étiquette, ni nom modifié.
 */
const STOP_NON_LEVABLE = 'cette personne a demandé l’arrêt des messages (STOP) : l’API ne peut pas la réabonner, seul un opérateur (depuis sa fiche) ou la personne elle-même le peut. Ni ses champs, ni ses étiquettes, ni son consentement n’ont été modifiés.';
/**
 * Le STOP est arrivé PENDANT l'appel, entre la vérification et l'écriture du consentement : la garde du dépôt a
 * refusé le réabonnement, mais les champs, étiquettes ou nom demandés ont déjà pu être écrits. Le dire, plutôt
 * que de réutiliser un message qui affirmerait le contraire (revue finale du lot 1).
 */
const STOP_PENDANT_L_APPEL = 'cette personne a demandé l’arrêt des messages (STOP) pendant cet appel : son consentement n’a pas été modifié, mais les autres champs demandés ont pu l’être.';

export function creerServiceContactsV1(deps: DepsServiceContactsV1): ServiceContactsV1 {
  const maintenant = deps.maintenant ?? ((): Date => new Date());
  // UNE construction, partagée avec `/v1/sends` (`src/index.ts`) : `depsConsentementDe`.
  const consentement = depsConsentementDe(deps.contacts, deps.audit);
  const optsChamps = {
    fields: deps.fields,
    ...(deps.maxChampsParEspace === undefined ? {} : { maxChampsParEspace: deps.maxChampsParEspace }),
  };

  /** Vrai si le corps demande `opted_in` pour une fiche désabonnée. Une lecture, et seulement dans ce cas. */
  async function leveraitUnStop(tenantId: string, contactId: string, voulu: 'opted_in' | 'opted_out' | undefined): Promise<boolean> {
    if (voulu !== 'opted_in') return false;
    return (await deps.contacts.lireFicheApi(tenantId, contactId))?.optInStatus === 'opted_out';
  }

  /**
   * 🔴 LA MÊME QUESTION, POSÉE AVANT LA RÉSOLUTION, et c'est ce qui la rend juste (revue finale du lot 1) :
   * `resoudreFiche` ÉCRIT (elle rattache une clé neuve, elle peut ressusciter une fiche), donc un refus posé après
   * elle laissait un `externalId` rattaché à une fiche désabonnée. Ici, rien que des lectures : les fiches que
   * désignent les clés, puis leur consentement. Seulement quand le corps demande `opted_in`.
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
    // AVANT la résolution, qui écrit : un refus ne doit rien laisser, pas même une clé rattachée.
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
      // Même règle que pour l'édition : une fiche purgée depuis la résolution n'a RIEN reçu, et répondre
      // « updated » ferait croire à l'intégrateur un désabonnement enregistré.
      const issue = await appliquerConsentement(consentement, tenantId, r.contactId, item.consent, item.consentSource ?? 'api');
      if (issue === 'absente') return { index, status: 'error', code: 'unknown_contact', reason: MESSAGE_RESOLUTION.unknown_contact };
      // Un STOP arrivé entre la vérification et cette écriture : le dépôt a refusé, on ne répond pas « updated ».
      if (issue === 'refuse') return { index, status: 'error', code: 'opted_out', reason: STOP_PENDANT_L_APPEL };
    }
    return { index, status: r.cree ? 'created' : 'updated', contactId: r.contactId };
  }

  /**
   * 🔴 LES ÉLÉMENTS D'UNE MÊME PERSONNE S'ÉCRIVENT DANS L'ORDRE, jamais en parallèle. Deux éléments qui
   * partagent une clé (numéro, BSUID, identifiant externe ou `contactId`, normalisés) forment une CHAÎNE, et une
   * chaîne s'écrit élément après élément. Sans ça, `[{ phone, externalId: 'X' }, { externalId: 'X', name }]`
   * dans la même vague faisait dépendre le second du hasard : résolu avant que le premier ait créé la fiche,
   * il rendait `unknown_contact`, alors que le même corps en deux appels successifs réussit toujours. Le lien
   * est TRANSITIF (A et B partagent un numéro, B et C un identifiant : une seule chaîne).
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
      // DEUX TEMPS, comme l'upsert d'import : la préparation des champs est SÉQUENTIELLE (elle partage un
      // cache et peut créer une définition), les écritures partent par vagues bornées (le pool n'est pas à nous).
      //
      // 🔴 LES CLÉS D'ABORD, LES CHAMPS ENSUITE, comme l'upsert d'avant (le numéro, puis les champs) : un élément
      // sans clé ou au numéro illisible sort à son index sans avoir fait naître la moindre définition de champ.
      // Une définition est durable et compte dans le plafond de l'espace.
      // ⚠️ CE QUI RESTE, ET QUI EST ASSUMÉ : un élément aux clés LISIBLES qui finit en `unknown_contact` ou en
      // `identity_conflict` a pu créer une définition, parce que la préparation passe avant la résolution
      // (c'est ce qui garantit qu'un champ refusé ne crée jamais de fiche). Une définition est un nom de champ,
      // sans valeur ni personne.
      const preparer = await preparateurDeChamps(tenantId, optsChamps);
      const out: ResultatFiche[] = [];
      const aEcrire: Array<{ index: number; item: ContactV1; valeurs: Record<string, string>; cles: ClesNormalisees }> = [];
      for (const [index, item] of items.entries()) {
        const cles = normaliserCles(item);
        if (!cles.ok) { out.push({ index, status: 'error', code: cles.code, reason: MESSAGE_RESOLUTION[cles.code] }); continue; }
        const prep = await preparer(item.fields);
        if (!prep.ok) { out.push({ index, status: 'error', code: 'invalid_body', reason: prep.raison }); continue; }
        aEcrire.push({ index, item, valeurs: prep.valeurs, cles: cles.cles });
      }
      // Au plus `ECRITURES_EN_VOL` chaînes à la fois, chacune SÉQUENTIELLE : jamais plus d'écritures en vol
      // qu'avant, et jamais deux en même temps pour des éléments qui partagent une clé. ⚠️ Un `contactId` et le
      // numéro de la même fiche, portés par deux éléments DIFFÉRENTS, ne se relient pas avant la résolution :
      // ils désignent une fiche qui existe déjà, donc aucun des deux ne dépend de l'autre pour la trouver.
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

      // Les champs d'abord : un refus ici ne doit rien laisser d'écrit, pas même l'identifiant externe.
      // ⚠️ La contrepartie, assumée : une définition de champ née ici survit si `poserExternalId` finit en
      // conflit juste après. C'est un nom de champ, sans valeur ni personne.
      const aVider: string[] = [];
      const aPoser: Record<string, string> = {};
      // Les définitions sont lues UNE fois pour tous les champs à vider, pas une requête par champ `null`.
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

      if (patch.externalId !== undefined) {
        const e = await deps.contacts.poserExternalId(tenantId, r.contactId, patch.externalId);
        if (e === 'conflit') return { ok: false, code: 'identity_conflict', reason: 'cet identifiant externe est déjà porté par une autre fiche de cet espace' };
        if (e === 'absente') return { ok: false, code: 'unknown_contact', reason: 'fiche inconnue' };
      }

      // Seul `null` VIDE le nom ; une chaîne blanche vaut absence (le schéma l'a déjà écartée, on ne la
      // retransforme pas en effacement ici).
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
