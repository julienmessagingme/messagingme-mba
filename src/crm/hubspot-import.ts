import { signHmac } from '../lib/signature';
import { withRetry } from '../meta/http';
import type { HttpTransport } from '../meta/http';
import { importContacts } from './import';
import type { ImportDeps } from './import';
import type { ColumnMapping, ImportReport } from './types';

/** Le portail n'a pas (encore) accordé crm.lists.read : l'admin doit re-consentir. Porte l'URL construite par mm-hubspot. */
export class ReconsentRequiredError extends Error {
  constructor(readonly reconsentUrl: string | undefined) {
    super('reconsent_required');
    this.name = 'ReconsentRequiredError';
  }
}
/** Autre échec du canal service (tenant non connecté, portail désinstallé, 5xx...). `retryable` piloté par withRetry. */
export class HubspotServiceError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly retryable: boolean) {
    super(`hubspot service HTTP ${status}${code ? ` (${code})` : ''}`);
    this.name = 'HubspotServiceError';
  }
}

export interface ConnectorDeps {
  /** Base interne du connecteur (ex. http://mm-hubspot-api:8096). */
  baseUrl: string;
  /** Secret HMAC du canal service (== SERVICE_SECRET de mm-hubspot). */
  secret: string;
  transport: HttpTransport;
}

export interface HubspotList { listId: string; name: string; size: number | null; processingType: string }

/** POST signé (x-mm-service-signature) vers le connecteur, retry borné sur 429/5xx/réseau ; 409 reconsent -> terminal. */
async function callService<T>(deps: ConnectorDeps, path: string, body: unknown): Promise<T> {
  return withRetry(async () => {
    const raw = JSON.stringify(body);
    const res = await deps.transport.post(`${deps.baseUrl}${path}`, body, { 'x-mm-service-signature': signHmac(deps.secret, raw) });
    if (res.status >= 200 && res.status < 300) return res.json as T;
    const j = res.json as { error?: string; reconsentUrl?: string } | undefined;
    if (res.status === 409 && j?.error === 'reconsent_required') throw new ReconsentRequiredError(j.reconsentUrl);
    throw new HubspotServiceError(res.status, j?.error, res.status === 429 || res.status >= 500);
  });
}

/** Liste les listes HubSpot du portail du tenant. Lève ReconsentRequiredError si crm.lists.read pas accordé. */
export async function fetchHubspotLists(deps: ConnectorDeps, tenantId: string, query?: string): Promise<HubspotList[]> {
  const res = await callService<{ lists: HubspotList[] }>(deps, '/service/lists', { tenantId, ...(query ? { query } : {}) });
  return res.lists ?? [];
}

/**
 * Importe les contacts d'une liste HubSpot comme contacts du tenant, taggés « HubSpot: <nom> ».
 * CONFORMITÉ NON NÉGOCIABLE : l'opt-in marketing n'est JAMAIS posé à 'opted_in' (importContacts optIn=false).
 * La fonction n'EXPOSE PAS de paramètre optIn : impossible de le passer à true par erreur (garantie de type).
 * Renvoie le rapport d'import (forme CSV) + `truncated`/`skippedNoPhone` (info liste géante / contacts sans numéro).
 */
export async function importHubspotList(
  connector: ConnectorDeps,
  importDeps: ImportDeps,
  tenantId: string,
  listId: string,
  listName: string,
): Promise<{ report: ImportReport; truncated: boolean; skippedNoPhone: number; tags: string[] }> {
  const data = await callService<{ contacts: Array<{ phone: string; name: string | null }>; truncated: boolean; skippedNoPhone: number }>(
    connector,
    '/service/lists/contacts',
    { tenantId, listId },
  );
  const rows = data.contacts.map((c) => ({ phone: c.phone, name: c.name ?? '' }));
  const mapping: ColumnMapping = { columns: { phone: { target: 'phone' }, name: { target: 'name' } } };
  // `tags` = source de vérité UNIQUE du tag réellement posé (le front s'en sert pour filtrer -> doit matcher
  // EXACTEMENT ce qui est stocké, y compris toute normalisation). On le renvoie plutôt que de laisser le front
  // reconstruire « HubSpot: <nom> » de son côté (risque de divergence sur un nom long/espacé).
  const tags = [`HubSpot: ${listName}`];
  const report = await importContacts({ rows, mapping, tenantId, optIn: false, tags }, importDeps);
  return { report, truncated: data.truncated, skippedNoPhone: data.skippedNoPhone, tags };
}
