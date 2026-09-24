import { optInAllows } from '../campaign/guardrails';
import { buildRecipients, type BuiltRecipient, type ContactEnvoi, type SkippedRecipient } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
import type { TemplateParam } from '../crm/template';
import type { OuvertureApi } from '../workflow/ouverture-api';
import type { CodeApi } from './erreurs';

/**
 * LES MOTIFS D'ÉCART D'UN ENVOI PAR L'API (spec 2026-09-24, § 9). Les MÊMES codes que les erreurs des autres
 * routes : un même refus porte le même code partout. `satisfies` fait refuser au compilateur un motif qui ne
 * serait pas un code de l'API.
 */
export const CODES_ECART = [
  'invalid_recipient', 'invalid_phone', 'unknown_contact', 'duplicate', 'identity_conflict', 'blocked_contact',
  'opted_out', 'no_consent', 'window_closed', 'missing_variable', 'no_phone',
] as const satisfies readonly CodeApi[];
export type CodeEcart = (typeof CODES_ECART)[number];

/** Un destinataire écarté : son INDEX dans `recipients`, qui le retrouve quelle que soit la clé utilisée. */
export interface Ecart { index: number; reason: CodeEcart }

/** Un destinataire après résolution de sa fiche, ou le motif qui l'a écarté avant même de la lire. */
export type DestinataireResolu =
  | { index: number; contactId: string; consent?: 'opted_in' | 'opted_out'; consentSource?: string }
  | { index: number; ecart: CodeEcart };

/**
 * La seconde désignation d'une MÊME fiche est un doublon : écarté `duplicate`, jamais fusionné en silence.
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
  /** Les fiches, relues APRÈS l'écriture des consentements : le tri voit l'état que l'appelant a demandé. */
  contacts: readonly ContactEnvoi[];
  /** Fenêtre de 24 h par contact, lue pour une ouverture `whatsapp_session` seulement. Absente = fermée. */
  fenetreOuverteParContact?: ReadonlyMap<string, boolean>;
}

export interface ResultatTri {
  eligibles: Array<{ index: number; contact: ContactEnvoi }>;
  ecarts: Ecart[];
}

/**
 * Le motif qui écarte ce contact, ou null. L'ORDRE est celui de la gravité : un contact bloqué l'est avant
 * d'être désabonné, un désabonné l'est avant de manquer de consentement.
 */
function motifDEcart(c: ContactEnvoi, e: EntreeTri): CodeEcart | null {
  if (c.bloque) return 'blocked_contact';
  if (c.optInStatus === 'opted_out') return 'opted_out';
  if (e.ouverture === 'rcs' && c.rcsDesabonne) return 'opted_out';
  if (e.ouverture === 'rcs' && !c.phone_e164) return 'no_phone';
  // Aucune adresse du tout : la base l'interdit, mais `buildRecipients` l'écarterait SANS motif.
  if (!c.phone_e164 && !c.bsuid) return 'no_phone';
  // 🔴 LA RÈGLE DU CONSENTEMENT EST CELLE DE LA CONSOLE (`optInAllows`), jamais une seconde écriture :
  // `tests/optout-chemins.test.ts` exige que la voie API l'appelle. Le désabonné est écarté plus haut avec
  // son propre motif, donc ce qu'elle refuse encore ici est un consentement manquant.
  if (!optInAllows(e.category, c)) return 'no_consent';
  // Fermée ou INCONNUE : une fenêtre qu'on n'a pas lue n'est pas ouverte.
  if (e.ouverture === 'whatsapp_session' && e.fenetreOuverteParContact?.get(c.id) !== true) return 'window_closed';
  return null;
}

/**
 * LE TRI DES DESTINATAIRES D'UN ENVOI PAR L'API : chacun finit éligible ou écarté avec son motif et son index.
 *
 * 🔴 AUCUNE PERTE SILENCIEUSE (spec 2026-09-24, § 3). Une fiche désignée mais absente de la lecture (supprimée
 * entre la résolution et la lecture) est `unknown_contact`, jamais oubliée.
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
    eligibles.push({ index: r.index, contact: c });
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
 * Les destinataires construits (variables de template résolues) et TOUS les écarts, triés par index.
 * `buildRecipients` reste la construction partagée avec la console : on ne la modifie pas, on traduit ses motifs.
 *
 * ⚠️ `buildRecipients` dédoublonne par ADRESSE, en silence. Deux fiches distinctes à la même adresse sont
 * interdites par la base (index uniques sur le numéro et sur le BSUID), mais un éligible qui ne ressort ni
 * construit ni écarté est rendu `duplicate` : aucune perte silencieuse ne dépend de cet index.
 */
export function construireDestinataires(
  category: CampaignCategory,
  params: TemplateParam[],
  tri: ResultatTri,
  now: Date,
): { recipients: BuiltRecipient[]; ecarts: Ecart[] } {
  // Une adresse VIDE vaut absence, comme dans le tri (`!c.phone_e164`). `buildRecipients` prend
  // `phone_e164 ?? bsuid` : sans ceci, un numéro `''` masquait le BSUID et la fiche sortait sans motif.
  const contacts = tri.eligibles.map((x) => ({ ...x.contact, phone_e164: x.contact.phone_e164 || null, bsuid: x.contact.bsuid || null }));
  const built = buildRecipients(category, params, contacts, { now });
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
