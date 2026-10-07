import { optInAllows } from '../campaign/guardrails';
import { buildRecipients, type BuiltRecipient, type ContactEnvoi, type SkippedRecipient } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
import type { TemplateParam } from '../crm/template';
import type { OuvertureApi } from '../workflow/ouverture-api';
import type { CodeApi } from './erreurs';

/**
 * Les motifs d'écart d'un envoi par l'API : les mêmes codes que les erreurs des autres routes. `satisfies`
 * fait refuser un motif qui ne serait pas un code de l'API.
 */
export const CODES_ECART = [
  'invalid_recipient', 'invalid_phone', 'unknown_contact', 'duplicate', 'identity_conflict', 'blocked_contact',
  'opted_out', 'no_consent', 'window_closed', 'missing_variable', 'no_phone', 'plan_limit_reached',
] as const satisfies readonly CodeApi[];
export type CodeEcart = (typeof CODES_ECART)[number];

/** Un destinataire écarté : son index dans `recipients`, qui le retrouve quelle que soit la clé utilisée. */
export interface Ecart { index: number; reason: CodeEcart }

/** Un destinataire après résolution de sa fiche, ou le motif qui l'a écarté avant même de la lire. */
export type DestinataireResolu =
  | {
    index: number; contactId: string; consent?: 'opted_in' | 'opted_out'; consentSource?: string;
    /** Les variables propres à ce destinataire, portées jusqu'à la construction, jamais sur la fiche. */
    variables?: Readonly<Record<string, string>>;
  }
  | { index: number; ecart: CodeEcart };

/**
 * La seconde désignation d'une même fiche est un doublon : écarté `duplicate`, jamais fusionné en silence.
 * Idempotente : la route l'appelle avant d'écrire les consentements, le tri la rappelle par sûreté.
 */
export function marquerDoublons(resolus: readonly DestinataireResolu[]): DestinataireResolu[] {
  const vus = new Set<string>();
  return resolus.map((r) => {
    if (!('contactId' in r)) return r;
    if (vus.has(r.contactId)) return { index: r.index, ecart: 'duplicate' };
    vus.add(r.contactId);
    return r;
  });
}

export interface EntreeTri {
  category: CampaignCategory;
  ouverture: OuvertureApi;
  resolus: readonly DestinataireResolu[];
  /** Les fiches, relues après l'écriture des consentements : le tri voit l'état que l'appelant a demandé. */
  contacts: readonly ContactEnvoi[];
  /** Fenêtre de 24 h par contact, lue pour une ouverture `whatsapp_session` seulement. Absente = fermée. */
  fenetreOuverteParContact?: ReadonlyMap<string, boolean>;
}

export interface ResultatTri {
  /**
   * `variables` : celles du destinataire, gardées à côté de la fiche chargée et jamais dessus ; seule la copie
   * passée à la construction les porte.
   */
  eligibles: Array<{ index: number; contact: ContactEnvoi; variables?: Readonly<Record<string, string>> }>;
  ecarts: Ecart[];
}

/**
 * Le motif qui écarte ce contact, ou null. L'ordre est celui de la gravité : un contact bloqué l'est avant
 * d'être désabonné, un désabonné l'est avant de manquer de consentement.
 */
function motifDEcart(c: ContactEnvoi, e: EntreeTri): CodeEcart | null {
  if (c.bloque) return 'blocked_contact';
  if (c.optInStatus === 'opted_out') return 'opted_out';
  if (e.ouverture === 'rcs' && c.rcsDesabonne) return 'opted_out';
  if (e.ouverture === 'rcs' && !c.phone_e164) return 'no_phone';
  // Aucune adresse du tout : la base l'interdit, mais `buildRecipients` l'écarterait sans motif.
  if (!c.phone_e164 && !c.bsuid) return 'no_phone';
  // 🔴 La règle du consentement est celle de la console (`optInAllows`), jamais une seconde écriture :
  // `tests/optout-chemins.test.ts` exige que la voie API l'appelle. Le désabonné est écarté plus haut.
  if (!optInAllows(e.category, c)) return 'no_consent';
  // Fermée ou inconnue : une fenêtre qu'on n'a pas lue n'est pas ouverte.
  if (e.ouverture === 'whatsapp_session' && e.fenetreOuverteParContact?.get(c.id) !== true) return 'window_closed';
  return null;
}

/**
 * Le tri des destinataires d'un envoi par l'API : chacun finit éligible ou écarté avec son motif et son
 * index, aucune perte silencieuse. Une fiche désignée mais absente de la lecture (supprimée entre-temps) est
 * `unknown_contact`.
 */
export function trierDestinataires(e: EntreeTri): ResultatTri {
  const parId = new Map(e.contacts.map((c) => [c.id, c]));
  const eligibles: ResultatTri['eligibles'] = [];
  const ecarts: Ecart[] = [];
  for (const r of marquerDoublons(e.resolus)) {
    if ('ecart' in r) { ecarts.push({ index: r.index, reason: r.ecart }); continue; }
    const c = parId.get(r.contactId);
    if (!c) { ecarts.push({ index: r.index, reason: 'unknown_contact' }); continue; }
    const motif = motifDEcart(c, e);
    if (motif) { ecarts.push({ index: r.index, reason: motif }); continue; }
    eligibles.push({ index: r.index, contact: c, ...(r.variables ? { variables: r.variables } : {}) });
  }
  return { eligibles, ecarts };
}

/** Les motifs de `buildRecipients`, dans le vocabulaire de l'API. Exhaustif : un motif neuf ne compile pas. */
const MOTIF_DE_CONSTRUCTION: Record<SkippedRecipient['reason'], CodeEcart> = {
  missing_variable: 'missing_variable',
  not_opted_in: 'no_consent',
  no_phone_number: 'no_phone',
};

/**
 * Les destinataires construits (variables de template résolues) et tous les écarts, triés par index.
 * `buildRecipients`, partagée avec la console, reste telle quelle : on traduit ses motifs. Elle dédoublonne
 * par adresse en silence : un éligible qui ne ressort ni construit ni écarté est rendu `duplicate`.
 */
export function construireDestinataires(
  category: CampaignCategory,
  params: TemplateParam[],
  tri: ResultatTri,
  now: Date,
  /** Le canal de la campagne : `rcs` pour une cible `rcsMessage`. Absent = WhatsApp. */
  canal: 'whatsapp' | 'rcs' = 'whatsapp',
): { recipients: BuiltRecipient[]; ecarts: Ecart[] } {
  // Une adresse vide vaut absence, comme dans le tri : `buildRecipients` prend `phone_e164 ?? bsuid`, et un
  // numéro `''` masquerait le BSUID. Les variables du destinataire sont posées sur cette copie, jamais sur la
  // fiche chargée.
  const contacts = tri.eligibles.map((x) => ({
    ...x.contact, phone_e164: x.contact.phone_e164 || null, bsuid: x.contact.bsuid || null,
    ...(x.variables ? { variables: x.variables } : {}),
  }));
  const built = buildRecipients(category, params, contacts, { now }, canal);
  const indexDe = new Map(tri.eligibles.map((x) => [x.contact.id, x.index]));
  const ecarts = [...tri.ecarts];
  for (const s of built.skipped) {
    const index = indexDe.get(s.contactId);
    if (index !== undefined) ecarts.push({ index, reason: MOTIF_DE_CONSTRUCTION[s.reason] });
    indexDe.delete(s.contactId);
  }
  for (const r of built.recipients) indexDe.delete(r.contactId);
  for (const index of indexDe.values()) ecarts.push({ index, reason: 'duplicate' });
  ecarts.sort((a, b) => a.index - b.index);
  return { recipients: built.recipients, ecarts };
}
