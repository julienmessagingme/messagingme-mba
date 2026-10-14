/**
 * Client du canal service vers le connecteur mm-hubspot : appel signé (`callService`), import de listes,
 * déconnexion d'un portail, signalement d'un contact injoignable, lecture des étapes de deal et du portail relié.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { signRequest } from '../lib/signature';
import type { HubspotPortalLink } from '../account/types';
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

/**
 * POST signé (x-mm-service-signature) vers le connecteur, retry borné sur 429/5xx/réseau ; 409 reconsent -> terminal.
 * Avec `delaiMs` : un seul essai, sous cette échéance (une lecture qui sert un affichage n'attend pas les reprises).
 */
async function callService<T>(deps: ConnectorDeps, path: string, body: unknown, delaiMs?: number): Promise<T> {
  const fullUrl = `${deps.baseUrl}${path}`;
  // Chemin signé = pathname de l'URL complète (robuste à un éventuel préfixe de proxy), tel que mm-hubspot voit req.url.
  const signedPath = new URL(fullUrl).pathname;
  const appel = async (): Promise<T> => {
    const raw = JSON.stringify(body);
    // ts + nonce frais à chaque tentative : le vérificateur mm-hubspot rejette un ts hors fenêtre.
    const sig = signRequest(deps.secret, { ts: Date.now(), nonce: randomBytes(8).toString('hex'), method: 'POST', path: signedPath, body: raw });
    const entetes = { 'x-mm-service-signature': sig };
    const res = delaiMs === undefined
      ? await deps.transport.post(fullUrl, body, entetes)
      : await deps.transport.post(fullUrl, body, entetes, { signal: AbortSignal.timeout(delaiMs) });
    if (res.status >= 200 && res.status < 300) return res.json as T;
    const j = res.json as { error?: string; reconsentUrl?: string } | undefined;
    if (res.status === 409 && j?.error === 'reconsent_required') throw new ReconsentRequiredError(j.reconsentUrl);
    throw new HubspotServiceError(res.status, j?.error, res.status === 429 || res.status >= 500);
  };
  return delaiMs === undefined ? withRetry(appel) : appel();
}

/**
 * Délie le tenant de son portail HubSpot côté connecteur (qui révoque le refresh token si c'était le dernier
 * tenant). Idempotent : `{disconnected:false}` = déjà délié = succès. Un échec terminal lève HubspotServiceError, et
 * l'appelant ne coupe pas l'état local : mba ne doit jamais afficher « coupé » pendant que le connecteur pousse encore.
 */
export async function disconnectHubspot(deps: ConnectorDeps, tenantId: string): Promise<{ disconnected: boolean; revoked: boolean }> {
  const res = await callService<{ disconnected?: boolean; revoked?: boolean }>(deps, '/service/unlink', { tenantId });
  return { disconnected: res.disconnected ?? false, revoked: res.revoked ?? false };
}

/**
 * Marque un contact « injoignable en WhatsApp » dans HubSpot (au 2e échec de livraison 131026), résolu par
 * téléphone côté connecteur. `tenant_not_connected` (404) = pas de portail lié, rien à marquer ; un échec
 * réseau ou 5xx est rejoué, un autre 4xx lève.
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

/** L'échéance d'une lecture du portail : deux requêtes indexées chez le connecteur, quelques millisecondes d'habitude. */
export const DELAI_PORTAIL_MS = 3_000;

/** La réponse de `POST /service/portal`, validée : rien d'autre ne passe. */
const reponsePortail = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({ connected: z.literal(true), hubId: z.string().min(1), hubDomain: z.string().nullable(), listsScopeGranted: z.boolean() }),
]);

/**
 * Le portail HubSpot relié à un espace, lu PAR LE CONNECTEUR (`POST /service/portal`, lot 1 de la bascule Scaleway).
 * On le lisait en cross-schéma dans `mmhs`, dans la même base ; une fois ce schéma sur sa propre base, la lecture
 * rendrait `42P01`, que les consommateurs traduisaient en « aucun portail relié ». Le contrat :
 * - aucun connecteur configuré (`deps` null, `HUBSPOT_SERVICE_URL` vide) : `{ connected: false }`, sans appel. C'est
 *   le remplaçant légitime de `42P01` : sans connecteur, aucun portail ne peut être relié ;
 * - le connecteur répond : sa réponse, validée par Zod ;
 * - injoignable, délai, signature refusée, 404 (connecteur pas encore à jour), 5xx, réponse invalide : une ERREUR,
 *   jamais `connected: false`. Chaque consommateur décide : l'interrupteur refuse (503), la suppression d'un espace
 *   rend « on ne sait pas », l'écran du compte affiche « non connecté ».
 * Un seul essai, sous `DELAI_PORTAIL_MS` : l'Accueil et les réglages l'attendent, et un connecteur figé les aurait tenus
 * jusqu'à deux minutes et demie (30 s par essai, cinq essais). L'interrupteur répond alors 503, et l'on réessaie.
 */
export async function lireHubspotPortal(deps: ConnectorDeps | null, tenantId: string): Promise<HubspotPortalLink> {
  if (deps === null) return { connected: false };
  const reponse = reponsePortail.safeParse(await callService<unknown>(deps, '/service/portal', { tenantId }, DELAI_PORTAIL_MS));
  if (!reponse.success) throw new HubspotServiceError(502, 'reponse_invalide', false);
  return reponse.data;
}

export interface HubspotDealStage { id: string; label: string; closed: boolean }
export interface HubspotDealPipeline { id: string; label: string; stages: HubspotDealStage[] }

/**
 * Pipelines de deals du portail, avec les libellés de leurs étapes, pour le menu « étape de deal » de l'écran
 * Automation. Ne lève pas ReconsentRequiredError (les deals sont dans les scopes obligatoires) ; un tenant sans
 * portail remonte en HubspotServiceError 404, que la route traduit en « pas connecté ».
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
 * Importe les contacts d'une liste HubSpot, taggés « HubSpot: <nom> ». Ils arrivent `opted_in`, source
 * `hubspot_list` : le consentement est géré et prouvé dans HubSpot, et `optInAllows` exige un opt-in explicite
 * pour le marketing. 🔴 Sauf qui a dit STOP : il reste désabonné, la base refusant de lever le STOP
 * (autorité `import`, `src/crm/transition-consentement.ts`). Rend le rapport d'import, plus `truncated` et `skippedNoPhone`.
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
  // `tags` = source de vérité unique du tag posé : le front s'en sert pour filtrer, il doit correspondre exactement
  // à ce qui est stocké plutôt que d'être reconstruit côté front.
  const tags = [`HubSpot: ${listName}`];
  const report = await importContacts({ rows, mapping, tenantId, optIn: true, optInSource: 'hubspot_list', tags, autorite: 'import' }, importDeps);
  return { report, truncated: data.truncated, skippedNoPhone: data.skippedNoPhone, tags };
}
