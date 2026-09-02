'use client';

/**
 * Le mini-CRM : fiches, historique, filtres, actions en masse, journal d'audit, import CSV.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';
import { teteCsv } from '../csv';

export interface Contact {
  id: string;
  phoneE164: string | null;
  /** Identité BSUID (compte WhatsApp) quand le contact n'a pas de numéro. */
  bsuid: string | null;
  profileName: string | null;
  optInStatus: string;
  fields: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  /**
   * Date de blocage, `null` ou absent = non bloqué. Bloqué : plus aucun envoi vers ce contact, et sa
   * conversation n'apparaît plus dans l'inbox. Ses messages restent enregistrés.
   */
  blockedAt?: string | null;
}
/** Identité messageable d'un contact : le numéro s'il existe, sinon le BSUID. null si aucun. */
export function contactIdentity(c: Pick<Contact, 'phoneE164' | 'bsuid'>): string | null {
  return c.phoneE164 ?? c.bsuid ?? null;
}
export function listContacts(tenantId: string, opts?: { limit?: number; offset?: number; tag?: string }): Promise<{ contacts: Contact[] }> {
  const qs = new URLSearchParams();
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.offset != null) qs.set('offset', String(opts.offset));
  if (opts?.tag) qs.set('tag', opts.tag);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ contacts: Contact[] }>(`/tenants/${tenantId}/contacts${suffix}`);
}

/** Édite un contact (fiche) : ajoute/met à jour/supprime des valeurs de user fields, édite le Nom (profileName,
 *  '' -> vide), affecte/retire des tags. MERGE côté serveur (n'écrase pas les autres champs). Le téléphone et le
 *  BSUID (identité/routage) restent en lecture seule. Renvoie le contact à jour. */
export function updateContact(
  tenantId: string,
  contactId: string,
  patch: {
    fields?: Record<string, string>; removeFields?: string[]; addTags?: string[]; removeTags?: string[];
    profileName?: string | null;
    /** Consentement posé à la main depuis la fiche. Deux valeurs : « inconnu » ne se réécrit pas (il signifie
     *  « rien n'a jamais été enregistré », le repeindre falsifierait le registre au lieu de le corriger). */
    optInStatus?: 'opted_in' | 'opted_out';
  },
): Promise<{ contact: Contact }> {
  return request<{ contact: Contact }>(`/tenants/${tenantId}/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

// --- Historique d'un contact (onglet de la fiche) ---

export interface ContactSend {
  campaignId: string;
  campaignName: string;
  category: string;
  /** null quand la campagne envoie un scénario au lieu d'un template. */
  templateName: string | null;
  templateLanguage: string | null;
  workflowName: string | null;
  status: string;
  sentAt: string | null;
  error: string | null;
  /** Dernier état connu. null = statut jamais remonté par Meta, ce qui ne veut PAS dire « non délivré ». */
  deliveryStatus: string | null;
  deliveryUpdatedAt: string | null;
  /**
   * La personne a-t-elle RÉAGI à cet envoi : répondu, ou appuyé sur un bouton du template.
   *
   * 🔴 Ce n'est PAS « lu ». « Lu » dit que Meta a affiché le message ; « engagé » dit qu'un humain a fait
   * quelque chose. Optionnel : une instance antérieure au 2026-09-02 ne le rend pas, et le badge ne
   * s'affiche alors nulle part, ce qui vaut mieux que de l'afficher faux.
   */
  engage?: boolean;
}
export interface ContactConversation {
  conversationId: string;
  waId: string;
  lastMessageAt: string;
  lastPreview: string | null;
  messagesCount: number;
  analysisStatus: string;
  analysis: {
    sentiment: string; intent: string; topic: string; resolved: boolean;
    handledBy: string; exchangesCount: number; actionSuggestion: string; analyzedAt: string;
  } | null;
  /** L'analyse existe mais un message est arrivé depuis : elle est périmée. */
  analysisStale: boolean;
  inboxHref: string;
}
export interface ContactHistory {
  sends: ContactSend[];
  conversations: ContactConversation[];
}
/** Campagnes reçues + conversations tenues par ce contact. 404 si le contact n'est pas dans l'espace. */
export function getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory> {
  return request<ContactHistory>(`/tenants/${tenantId}/contacts/${contactId}/history`);
}
/** Envois du contact pour l'export CSV (F5), NON capé (contrairement à getContactHistory borné à l'écran). */
export function getContactSendsForExport(tenantId: string, contactId: string): Promise<{ sends: ContactSend[] }> {
  return request<{ sends: ContactSend[] }>(`/tenants/${tenantId}/contacts/${contactId}/history/export`);
}

// Types + sérialisation des filtres : module PUR `./contact-filters` (testable sans navigateur, miroir du parse
// serveur). Ré-exportés ici pour ne pas casser les imports existants (`import { ContactFilters } from '../lib/api'`).
export type { ContactFieldOp, ContactFieldFilter, ContactFilters, BulkTarget } from '../contact-filters';
import { filtersToQuery, type ContactFilters, type BulkTarget } from '../contact-filters';

/** Contacts correspondant aux filtres (paginé) + total (compteur réel). Source « Liste de contacts ». */
export function queryContacts(tenantId: string, filters: ContactFilters, opts?: { limit?: number; offset?: number }): Promise<{ contacts: Contact[]; total?: number }> {
  const qs = filtersToQuery(filters);
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.offset != null) qs.set('offset', String(opts.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ contacts: Contact[]; total?: number }>(`/tenants/${tenantId}/contacts${suffix}`);
}

/** Nombre de contacts correspondant aux filtres (badge « N contacts correspondent »). */
export function countContacts(tenantId: string, filters: ContactFilters): Promise<{ total: number }> {
  const suffix = filtersToQuery(filters).toString();
  return request<{ total: number }>(`/tenants/${tenantId}/contacts/count${suffix ? `?${suffix}` : ''}`);
}

/** Action en masse du mini-CRM (admin) : ajouter/retirer un tag OU poser un champ, sur une cible (ids ou filtres).
 *  Renvoie le nombre de contacts touchés. */
export type BulkAction =
  | { type: 'add_tag'; tags: string[] }
  | { type: 'remove_tag'; tags: string[] }
  | { type: 'set_field'; key: string; value: string }
  | { type: 'set_optin'; value: 'opted_in' | 'opted_out' };
export function bulkContactAction(tenantId: string, target: BulkTarget, action: BulkAction): Promise<{ affected: number }> {
  return request<{ affected: number }>(`/tenants/${tenantId}/contacts/bulk`, { method: 'POST', body: JSON.stringify({ target, action }) });
}

/**
 * SUPPRESSION de contacts (admin). LA seule, et elle est IRRÉVERSIBLE : le fil de conversation, ses messages
 * et l'analyse qualitative sont effacés, puis ce qui porte les compteurs est anonymisé pour que les totaux de
 * campagne restent justes. Le `confirm` n'est pas décoratif : le serveur refuse sans lui.
 */
export function deleteContacts(tenantId: string, target: BulkTarget): Promise<{ purges: number; conversations: number; messages: number; analyses: number }> {
  return request(`/tenants/${tenantId}/contacts/purge`, { method: 'POST', body: JSON.stringify({ target, confirm: 'SUPPRIMER' }) });
}

/** Une action sensible enregistrée sur les contacts. Ne porte JAMAIS de numéro : seulement l'identifiant. */
export interface AuditEntry {
  id: string;
  at: string;
  actorEmail: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  detail: Record<string, unknown>;
}

/** Historique des actions sensibles de l'espace, du plus récent au plus ancien (admin). */
/**
 * Le journal des actions, avec sa recherche.
 *
 * ⚠️ `telephone` n'est PAS cherché dans le journal, qui ne porte aucun numéro : le serveur le RÉSOUT vers les
 * contacts correspondants et cherche leur identifiant. Deux conséquences que l'écran doit dire plutôt que de
 * rendre une liste vide : un numéro inconnu ne trouve rien, et un contact ANONYMISÉ ne se retrouve plus par
 * son numéro, puisque celui-ci a été détruit.
 */
export function listAudit(
  tenantId: string,
  limit = 100,
  filtre: { q?: string; acteur?: string; telephone?: string } = {},
): Promise<{ entries: AuditEntry[] }> {
  const p = new URLSearchParams({ limit: String(limit) });
  // Un filtre vide n'est PAS envoyé : « contient la chaîne vide » est vrai partout, donc ne filtre rien, mais
  // il ferait croire à l'écran qu'une recherche est en cours.
  for (const [k, v] of Object.entries(filtre)) if (v && v.trim() !== '') p.set(k, v.trim());
  return request<{ entries: AuditEntry[] }>(`/tenants/${tenantId}/audit?${p.toString()}`);
}

/** Une erreur de livraison, telle que le journal des erreurs la rend. */
export interface ErreurLivraison {
  recipientId: string;
  campaignId: string;
  campaignName: string;
  /** Le numéro appelé. Ce journal-ci les porte : « quel message n'est pas arrivé » sans dire « à qui » ne
   *  répond à rien. C'est ce qui le distingue du journal des actions, qui n'en porte jamais. */
  telephone: string;
  contactId: string | null;
  contactNom: string | null;
  code: number | null;
  message: string | null;
  /** `envoi` = Meta a refusé l'appel, le message n'est jamais parti. `livraison` = il est parti puis a échoué. */
  origine: 'envoi' | 'livraison';
  at: string | null;
}

export function listErreursLivraison(
  tenantId: string,
  limit = 100,
  filtre: { q?: string; telephone?: string; code?: string } = {},
): Promise<{ erreurs: ErreurLivraison[] }> {
  const p = new URLSearchParams({ limit: String(limit) });
  for (const [k, v] of Object.entries(filtre)) if (v && v.trim() !== '') p.set(k, v.trim());
  return request<{ erreurs: ErreurLivraison[] }>(`/tenants/${tenantId}/erreurs-livraison?${p.toString()}`);
}

// `listAllContacts` a vécu ici sans appelant : elle paginait correctement, avec un commentaire promettant de
// « ne jamais tronquer silencieusement », pendant que la page Contacts et l'écran Campagne appelaient
// `listContacts` avec la limite serveur en dur. Supprimée le 2026-07-18 plutôt que gardée « au cas où » :
// la pagination réelle de ces deux écrans est un item du backlog (bloc 5 du PLAN.md), pas un helper dormant.

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ line: number; reason: string }>;
}

export type ColumnTarget = 'phone' | 'name' | 'custom' | 'ignore';
export interface ColumnMapping {
  columns: Record<string, { target: ColumnTarget; key?: string }>;
}
export interface ImportPreview {
  headers: string[];
  sampleRows: Array<Record<string, string>>;
  rowCount: number;
  mapping: ColumnMapping;
  /** `rowCount` est-il une ESTIMATION ? (fichier trop gros pour être analysé en entier, cf. `teteCsv`). */
  estime: boolean;
}

/** Aperçu : renvoie les colonnes détectées + un mapping suggéré (même parsing que l'import), sur la seule
 *  TÊTE du fichier. Le nombre de lignes est alors extrapolé au prorata des caractères, et signalé comme tel. */
export async function previewImport(tenantId: string, csv: string): Promise<ImportPreview> {
  const tete = teteCsv(csv);
  const p = await request<Omit<ImportPreview, 'estime'>>(`/tenants/${tenantId}/contacts/import/preview`, {
    method: 'POST',
    body: JSON.stringify({ csv: tete }),
  });
  if (tete.length === csv.length) return { ...p, estime: false };
  return { ...p, estime: true, rowCount: Math.round(p.rowCount * (csv.length / tete.length)) };
}

export function importCsv(
  tenantId: string,
  csv: string,
  optIn: boolean,
  tags?: string[],
  mapping?: ColumnMapping,
): Promise<ImportReport> {
  return request<ImportReport>(`/tenants/${tenantId}/contacts/import`, {
    method: 'POST',
    body: JSON.stringify({
      csv,
      optIn,
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(mapping ? { mapping } : {}),
    }),
  });
}
