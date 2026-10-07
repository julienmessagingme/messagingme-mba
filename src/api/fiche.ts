import { z } from 'zod';
import type { CountryCode } from 'libphonenumber-js';
import { normalizePhone } from '../crm/phone';
import { estUuid } from '../http/scope';
import type { ClesNormalisees, FicheIdentite, PgContactStore } from '../crm/contact-store.pg';
import { LimiteOffreError, adresseOffre } from '../offres/refus';

/**
 * Trouver la fiche d'une personne à partir de ce que l'intégrateur a. Une seule fonction pour toute l'API
 * publique : une seconde résolution divergerait sur la règle multi-clés, et une personne aurait deux fiches.
 *
 *  - au moins une clé parmi `contactId`, `externalId`, `phone`, `bsuid`, sinon `invalid_recipient` ;
 *  - toutes les clés données désignent la même fiche, sinon `identity_conflict`, et rien n'est écrit ;
 *  - une clé que la fiche ne porte pas encore lui est rattachée ; une clé qu'elle porte autrement est un
 *    conflit (on ne remplace jamais une identité ici) ;
 *  - `contactId` ne se rattache jamais : il existe, ou il est inconnu ;
 *  - aucune fiche : création seulement si le mode le permet et qu'un `phone` (ou un `bsuid`, selon le mode)
 *    est donné. Sinon `unknown_contact`.
 *
 * Elle rend une fiche, jamais une adresse : l'adresse d'envoi se calcule sur la fiche (`waIdOf`), ce qui
 * garde un seul fil par personne.
 */

/** La borne de l'identifiant externe (celle des outils qui en ont une, la plus stricte connue). */
export const MAX_EXTERNAL_ID = 512;

/**
 * Une chaîne vide ou blanche vaut absence : un outil qui remplit son corps avec les variables d'un profil
 * envoie `""` pour une variable que le profil n'a pas, et ce n'est pas une clé.
 */
export const videEnAbsent = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const schemaClesFiche = z.object({
  contactId: z.preprocess(videEnAbsent, z.guid().optional()),
  externalId: z.preprocess(videEnAbsent, z.string().trim().max(MAX_EXTERNAL_ID).optional()),
  phone: z.preprocess(videEnAbsent, z.string().trim().max(64).optional()),
  // Refusé au-delà de 200 plutôt que tronqué : un BSUID coupé serait l'identité d'un autre compte.
  bsuid: z.preprocess(videEnAbsent, z.string().trim().max(200).optional()),
});

export interface ClesFiche {
  contactId?: string;
  externalId?: string;
  phone?: string;
  bsuid?: string;
}

export type ModeCreation = 'jamais' | 'phone' | 'phone_ou_bsuid';
export type CodeResolution = 'invalid_recipient' | 'invalid_phone' | 'unknown_contact' | 'identity_conflict' | 'plan_limit_reached';
export type ResolutionFiche = { ok: true; contactId: string; cree: boolean } | { ok: false; code: CodeResolution };
export type DepsFiche = Pick<PgContactStore, 'chercherParCles' | 'creerFicheApi' | 'rattacherCles'>;

export const MESSAGE_RESOLUTION: Record<CodeResolution, string> = {
  invalid_recipient: 'désignez la personne par au moins une clé : « contactId », « externalId », « phone » ou « bsuid »',
  invalid_phone: '« phone » : numéro de téléphone illisible',
  unknown_contact: 'aucune fiche ne correspond à ces clés',
  identity_conflict: 'ces clés désignent des fiches différentes, ou une clé que la fiche porte déjà avec une autre valeur : rien n’a été écrit',
  // Lot 6 : la fiche serait une création au-delà de la limite de contacts de l'offre.
  plan_limit_reached: `limite de contacts de votre offre atteinte, aucune fiche n’a été créée : passez en Pro (${adresseOffre()})`,
};

/** Rogne les clés, écarte les vides, normalise le numéro. */
export function normaliserCles(
  cles: ClesFiche,
  pays: CountryCode = 'FR',
): { ok: true; cles: ClesNormalisees } | { ok: false; code: 'invalid_recipient' | 'invalid_phone' } {
  const propre = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== '' ? v.trim() : undefined);
  // En minuscules, la forme que la base rend : `juger` compare en texte, et un identifiant en majuscules
  // serait trouvé puis déclaré inconnu.
  const contactId = propre(cles.contactId)?.toLowerCase();
  const externalId = propre(cles.externalId);
  const phone = propre(cles.phone);
  const bsuid = propre(cles.bsuid);
  if (!contactId && !externalId && !phone && !bsuid) return { ok: false, code: 'invalid_recipient' };
  let phoneE164: string | undefined;
  if (phone) {
    const p = normalizePhone(phone, pays);
    if (!p.e164) return { ok: false, code: 'invalid_phone' };
    phoneE164 = p.e164;
  }
  return {
    ok: true,
    cles: {
      ...(contactId ? { contactId } : {}),
      ...(externalId ? { externalId } : {}),
      ...(phoneE164 ? { phoneE164 } : {}),
      ...(bsuid ? { bsuid } : {}),
    },
  };
}

type AttacherCles = { externalId?: string; phoneE164?: string; bsuid?: string };
type Verdict =
  | { type: 'refus'; code: CodeResolution }
  | { type: 'trouvee'; id: string; aRattacher: AttacherCles }
  | { type: 'aucune' };

function juger(c: ClesNormalisees, trouvees: FicheIdentite[]): Verdict {
  const par = {
    contactId: c.contactId !== undefined ? trouvees.find((f) => f.id === c.contactId) : undefined,
    externalId: c.externalId !== undefined ? trouvees.find((f) => f.externalId === c.externalId) : undefined,
    phone: c.phoneE164 !== undefined ? trouvees.find((f) => f.phoneE164 === c.phoneE164) : undefined,
    bsuid: c.bsuid !== undefined ? trouvees.find((f) => f.bsuid === c.bsuid) : undefined,
  };
  if (c.contactId !== undefined && !par.contactId) return { type: 'refus', code: 'unknown_contact' };
  const ids = new Set([par.contactId, par.externalId, par.phone, par.bsuid].filter((f): f is FicheIdentite => f !== undefined).map((f) => f.id));
  if (ids.size > 1) return { type: 'refus', code: 'identity_conflict' };
  const fiche = trouvees.find((f) => ids.has(f.id));
  if (!fiche) return { type: 'aucune' };
  const aRattacher: AttacherCles = {};
  if (c.externalId !== undefined && !par.externalId) {
    if (fiche.externalId !== null) return { type: 'refus', code: 'identity_conflict' };
    aRattacher.externalId = c.externalId;
  }
  if (c.phoneE164 !== undefined && !par.phone) {
    if (fiche.phoneE164 !== null) return { type: 'refus', code: 'identity_conflict' };
    aRattacher.phoneE164 = c.phoneE164;
  }
  if (c.bsuid !== undefined && !par.bsuid) {
    if (fiche.bsuid !== null) return { type: 'refus', code: 'identity_conflict' };
    aRattacher.bsuid = c.bsuid;
  }
  return { type: 'trouvee', id: fiche.id, aRattacher };
}

function peutCreer(c: ClesNormalisees, mode: ModeCreation): boolean {
  if (mode === 'jamais') return false;
  if (mode === 'phone') return c.phoneE164 !== undefined;
  return c.phoneE164 !== undefined || c.bsuid !== undefined;
}

/**
 * Deux passes au plus : une écriture concurrente peut prendre une clé entre la lecture et l'écriture ; on
 * relit une fois, et au-delà c'est un conflit, jamais une boucle.
 */
const PASSES = 2;

export async function resoudreFiche(
  deps: DepsFiche,
  tenantId: string,
  cles: ClesFiche,
  opts: { creer: ModeCreation },
): Promise<ResolutionFiche> {
  const n = normaliserCles(cles);
  if (!n.ok) return n;
  const c = n.cles;
  // Un identifiant mal formé ne désigne rien : on ne le laisse pas atteindre la base, où le cast lèverait.
  if (c.contactId !== undefined && !estUuid(c.contactId)) return { ok: false, code: 'unknown_contact' };

  for (let passe = 0; passe < PASSES; passe += 1) {
    const verdict = juger(c, await deps.chercherParCles(tenantId, c));
    if (verdict.type === 'refus') return { ok: false, code: verdict.code };
    if (verdict.type === 'trouvee') {
      if (Object.keys(verdict.aRattacher).length === 0) return { ok: true, contactId: verdict.id, cree: false };
      const r = await deps.rattacherCles(tenantId, verdict.id, verdict.aRattacher);
      if (r === 'ok') return { ok: true, contactId: verdict.id, cree: false };
      if (r === 'absente') continue;
      return { ok: false, code: 'identity_conflict' };
    }
    if (!peutCreer(c, opts.creer)) return { ok: false, code: 'unknown_contact' };
    let creation: Awaited<ReturnType<DepsFiche['creerFicheApi']>>;
    try {
      creation = await deps.creerFicheApi(tenantId, {
        ...(c.phoneE164 ? { phoneE164: c.phoneE164 } : {}),
        ...(c.bsuid ? { bsuid: c.bsuid } : {}),
        ...(c.externalId ? { externalId: c.externalId } : {}),
      });
    } catch (err) {
      // La limite de contacts de l'offre (lot 6) : un refus de la ligne, jamais une panne de la requête.
      if (err instanceof LimiteOffreError) return { ok: false, code: 'plan_limit_reached' };
      throw err;
    }
    if (creation === 'conflit') continue;
    const tient = (voulu: string | undefined, porte: string | null): boolean => voulu === undefined || voulu === porte;
    if (!tient(c.externalId, creation.externalId) || !tient(c.bsuid, creation.bsuid) || !tient(c.phoneE164, creation.phoneE164)) {
      return { ok: false, code: 'identity_conflict' };
    }
    return { ok: true, contactId: creation.id, cree: creation.created };
  }
  return { ok: false, code: 'identity_conflict' };
}
