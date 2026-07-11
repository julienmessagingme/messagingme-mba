import { MetaApiError } from './errors';
import type { MetaErrorBody } from './errors';
import type { FetchLike } from './templates';
import { buildFlowElements } from './flow-json';
import type { FlowElement } from './flow-json';

export interface CreateFlowInput {
  name: string;
  /** Éléments DÉJÀ dérivés (texte/image/champ avec clés). La validation vit dans la route, pas ici. */
  elements: FlowElement[];
  /** Discriminant du flow, figé dans le payload complete (identifie le flow au retour nfm_reply). */
  ref: string;
}

export interface FlowSummary {
  id: string;
  name: string;
  status: string; // DRAFT | PUBLISHED | DEPRECATED
  categories: string[];
}

/** Flow JSON refusé par Meta à la création (validation_errors non vide). Ne devrait pas arriver avec
 *  notre générateur (validé), mais on le remonte plutôt que de laisser un DRAFT invalide silencieux. */
export class FlowJsonInvalidError extends Error {
  constructor(public readonly errors: string[]) {
    super(`flow_json refusé par Meta: ${errors.join(' | ')}`);
    this.name = 'FlowJsonInvalidError';
  }
}

/**
 * Client des WhatsApp Flows (niveau WABA). Créer / publier / lister via l'API Graph. `fetchImpl`
 * injectable pour les tests. Ne lève que MetaApiError (réseau/HTTP) ou FlowJsonInvalidError (validation).
 * Calque de MetaTemplateClient : la génération du flow_json est interne (buildFlowElements).
 */
export class MetaFlowClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v23.0',
    private readonly flowJsonVersion = '7.2',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  private async call(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(url, { ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) } });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const errBody = (json as { error?: MetaErrorBody } | null)?.error ?? null;
      throw new MetaApiError(res.status, errBody);
    }
    return json;
  }

  /** POST /{waba}/flows — name + categories:['LEAD_GENERATION'] + flow_json (STRING). Statut initial DRAFT. */
  async create(wabaId: string, input: CreateFlowInput): Promise<{ id: string; status: string }> {
    const flowJson = buildFlowElements(input.name, input.elements, this.flowJsonVersion, input.ref);
    const json = (await this.call(`${this.baseUrl}/${this.version}/${wabaId}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, categories: ['LEAD_GENERATION'], flow_json: JSON.stringify(flowJson) }),
    })) as { id?: string; validation_errors?: Array<{ message?: string; error?: string }> };
    const errs = json.validation_errors ?? [];
    if (errs.length > 0) throw new FlowJsonInvalidError(errs.map((e) => e.message ?? e.error ?? 'erreur'));
    return { id: json.id ?? '', status: 'DRAFT' };
  }

  /**
   * Édite le flow_json d'un flow DRAFT : POST /{flowId}/assets en MULTIPART (asset_type=FLOW_JSON,
   * name=flow.json, file=<json>). ⚠️ Diffère du create (JSON inline) : /assets EXIGE du multipart/form-data
   * (vérifié live). Ne PAS forcer content-type (le runtime pose le boundary). Un flow PUBLISHED est immuable
   * chez Meta (refusé) : la route amont doit garantir status=DRAFT (409 sinon). Relit validation_errors.
   */
  async updateDraft(flowId: string, input: CreateFlowInput): Promise<void> {
    const flowJson = buildFlowElements(input.name, input.elements, this.flowJsonVersion, input.ref);
    const fd = new FormData();
    fd.append('asset_type', 'FLOW_JSON');
    fd.append('name', 'flow.json');
    fd.append('file', new Blob([JSON.stringify(flowJson)], { type: 'application/json' }), 'flow.json');
    const json = (await this.call(`${this.baseUrl}/${this.version}/${flowId}/assets`, {
      method: 'POST',
      body: fd,
    })) as { validation_errors?: Array<{ message?: string; error?: string }> };
    const errs = json.validation_errors ?? [];
    if (errs.length > 0) throw new FlowJsonInvalidError(errs.map((e) => e.message ?? e.error ?? 'erreur'));
  }

  /** POST /{flow}/publish — DRAFT -> PUBLISHED. Irréversible côté Meta. */
  async publish(flowId: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${flowId}/publish`, { method: 'POST' });
  }

  /** GET /{waba}/flows — suit paging.next (calque templates.list). Non branché sur la route GET (qui
   *  sert le store local) ; utile pour un futur script de réconciliation/ops. */
  async list(wabaId: string): Promise<FlowSummary[]> {
    const out: FlowSummary[] = [];
    let next: string | null = `${this.baseUrl}/${this.version}/${wabaId}/flows?fields=id,name,status,categories&limit=100`;
    for (let page = 0; page < 20 && next; page++) {
      const json = (await this.call(next, { method: 'GET' })) as {
        data?: Array<{ id?: string; name?: string; status?: string; categories?: string[] }>;
        paging?: { next?: string };
      };
      for (const f of json.data ?? []) {
        out.push({ id: f.id ?? '', name: f.name ?? '', status: f.status ?? '', categories: f.categories ?? [] });
      }
      next = json.paging?.next ?? null;
    }
    return out;
  }
}
