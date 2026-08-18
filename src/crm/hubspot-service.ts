/**
 * Client du canal service vers le connecteur mm-hubspot : appel signé (`callService`), import de listes,
 * déconnexion d'un portail, signalement d'un contact injoignable, lecture des étapes de deal.
 *
 * Nommé `hubspot-import` jusqu'au 2026-08-18, alors qu'il ne portait plus qu'en partie l'import, et que les
 * ROUTES de l'import s'appellent déjà `src/http/hubspot-import.ts` : deux fichiers de même nom pour deux rôles.
 */
import { randomBytes } from 'node:crypto';
import { signRequest } from '../lib/signature';
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
  const fullUrl = `${deps.baseUrl}${path}`;
  // Chemin signé = pathname de l'URL complète (robuste à un éventuel préfixe de proxy), tel que mm-hubspot voit req.url.
  const signedPath = new URL(fullUrl).pathname;
  return withRetry(async () => {
    const raw = JSON.stringify(body);
    // ts + nonce FRAIS par tentative (voir postAnalysis) : le vérificateur mm-hubspot rejette un ts hors fenêtre.
    const sig = signRequest(deps.secret, { ts: Date.now(), nonce: randomBytes(8).toString('hex'), method: 'POST', path: signedPath, body: raw });
    const res = await deps.transport.post(fullUrl, body, { 'x-mm-service-signature': sig });
    if (res.status >= 200 && res.status < 300) return res.json as T;
    const j = res.json as { error?: string; reconsentUrl?: string } | undefined;
    if (res.status === 409 && j?.error === 'reconsent_required') throw new ReconsentRequiredError(j.reconsentUrl);
    throw new HubspotServiceError(res.status, j?.error, res.status === 429 || res.status >= 500);
  });
}

/**
 * Déconnexion complète (candidat 2) : délie le tenant de son portail HubSpot côté connecteur (mm-hubspot révoque le
 * refresh token si c'était le dernier tenant). Idempotent : `{disconnected:false}` = déjà délié = SUCCÈS (2xx). Un
 * échec terminal (4xx/5xx après retries) lève HubspotServiceError -> l'appelant NE coupe PAS l'état local (pas de
 * drift : on ne veut jamais que mba affiche « coupé » alors que le connecteur pousse encore vers HubSpot).
 */
export async function disconnectHubspot(deps: ConnectorDeps, tenantId: string): Promise<{ disconnected: boolean; revoked: boolean }> {
  const res = await callService<{ disconnected?: boolean; revoked?: boolean }>(deps, '/service/unlink', { tenantId });
  return { disconnected: res.disconnected ?? false, revoked: res.revoked ?? false };
}

/**
 * Marque un contact « injoignable en WhatsApp » dans HubSpot (F6, appelé au 2e échec de livraison 131026). Résout le
 * contact par téléphone côté connecteur et pose la propriété. `tenant_not_connected` (404) = pas de portail lié -> on
 * ignore proprement (rien à marquer), pas une erreur. Un échec réseau/5xx est rejoué (withRetry) ; un autre 4xx lève.
 */
export async function flagContactUnreachable(deps: ConnectorDeps, tenantId: string, e164: string): Promise<{ flagged: boolean }> {
  try {
    const res = await callService<{ flagged?: boolean }>(deps, '/service/contact-flag', { tenantId, e164, flag: 'unreachable' });
    return { flagged: res.flagged ?? false };
  } catch (err) {
    if (err instanceof HubspotServiceError && err.status === 404) return { flagged: false }; // portail non lié : rien à marquer
    throw err;
  }
}

export interface HubspotDealStage { id: string; label: string; closed: boolean }
export interface HubspotDealPipeline { id: string; label: string; stages: HubspotDealStage[] }

/**
 * Pipelines de deals du portail, avec les libellés de leurs étapes : de quoi peupler le menu « étape de deal »
 * de l'écran Automation, au lieu de faire recopier un identifiant opaque depuis HubSpot.
 *
 * Ne lève PAS ReconsentRequiredError : les deals sont dans les scopes obligatoires de l'app, contrairement aux
 * listes. Un tenant sans portail lié remonte en HubspotServiceError 404 (`tenant_not_connected`), que la route
 * HTTP traduit en « pas connecté » plutôt qu'en erreur.
 */
export async function fetchHubspotDealStages(deps: ConnectorDeps, tenantId: string): Promise<HubspotDealPipeline[]> {
  const res = await callService<{ pipelines?: HubspotDealPipeline[] }>(deps, '/service/deal-stages', { tenantId });
  return res.pipelines ?? [];
}

/** Liste les listes HubSpot du portail du tenant. Lève ReconsentRequiredError si crm.lists.read pas accordé. */
export async function fetchHubspotLists(deps: ConnectorDeps, tenantId: string, query?: string): Promise<HubspotList[]> {
  const res = await callService<{ lists: HubspotList[] }>(deps, '/service/lists', { tenantId, ...(query ? { query } : {}) });
  return res.lists ?? [];
}

/**
 * Importe les contacts d'une liste HubSpot comme contacts du tenant, taggés « HubSpot: <nom> ».
 *
 * OPT-IN : les contacts arrivent `opted_in`, source `hubspot_list`. Le consentement est géré DANS HubSpot,
 * c'est lui qui en porte la preuve, et une liste qu'un opérateur choisit pour une campagne est par
 * construction une liste de gens à qui il a le droit d'écrire.
 *
 * Ce n'est pas un assouplissement, c'est la correction d'un contresens : la fonction posait `unknown`, or
 * `optInAllows` exige un opt-in EXPLICITE pour le marketing. Une campagne marketing montée sur une liste
 * HubSpot rendait donc ZÉRO destinataire, sans que rien ne le dise (l'écart n'était même pas compté).
 * mba re-décidait du consentement à partir d'une donnée qu'il n'a pas.
 *
 * La fonction n'expose toujours pas de paramètre : la source du consentement est la liste, point.
 * Renvoie le rapport d'import (forme CSV) + `truncated`/`skippedNoPhone` (liste géante / contacts sans numéro).
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
  const report = await importContacts({ rows, mapping, tenantId, optIn: true, optInSource: 'hubspot_list', tags }, importDeps);
  return { report, truncated: data.truncated, skippedNoPhone: data.skippedNoPhone, tags };
}
