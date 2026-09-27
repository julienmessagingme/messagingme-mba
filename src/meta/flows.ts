import type { FetchLike } from './templates';
import { appelGraph } from './graph';
import { buildFlowScreens } from './flow-json';
import type { FlowScreenDef } from './flow-json';

export interface CreateFlowInput {
  name: string;
  /** Écrans aux éléments DÉJÀ dérivés (clés + visibleIf résolus). La validation vit dans la route, pas ici. */
  screens: FlowScreenDef[];
  /** Discriminant du flow, figé dans le payload complete (identifie le flow au retour nfm_reply). */
  ref: string;
  /** Libellé du bouton final (Footer du dernier écran). Défaut « Envoyer ». */
  cta?: string;
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
 * Client des WhatsApp Flows (niveau WABA) : créer, publier, lister via l'API Graph. Ne lève que MetaApiError
 * (réseau, HTTP) ou FlowJsonInvalidError (validation) ; la génération du flow_json est interne (buildFlowScreens).
 */
export class MetaFlowClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v23.0',
    private readonly flowJsonVersion = '7.2',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  private call(url: string, init: RequestInit): Promise<unknown> {
    return appelGraph(this.fetchImpl, this.token, url, init);
  }

  /** POST /{waba}/flows : name + categories:['LEAD_GENERATION'] + flow_json (en chaîne). Statut initial DRAFT. */
  async create(wabaId: string, input: CreateFlowInput): Promise<{ id: string; status: string }> {
    const flowJson = buildFlowScreens(input.name, input.screens, this.flowJsonVersion, input.ref, input.cta);
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
   * Édite le flow_json d'un flow DRAFT : `POST /{flowId}/assets` en multipart (asset_type=FLOW_JSON,
   * name=flow.json), là où la création passe le JSON inline. Ne pas forcer le content-type (le runtime pose le
   * boundary). Un flow PUBLISHED est immuable chez Meta : la route amont garantit status=DRAFT.
   */
  async updateDraft(flowId: string, input: CreateFlowInput): Promise<void> {
    const flowJson = buildFlowScreens(input.name, input.screens, this.flowJsonVersion, input.ref, input.cta);
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

  /** POST /{flow}/publish : DRAFT -> PUBLISHED, irréversible côté Meta. */
  async publish(flowId: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${flowId}/publish`, { method: 'POST' });
  }

  /** DELETE /{flow} : Meta n'autorise la suppression que sur un DRAFT. */
  async delete(flowId: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${flowId}`, { method: 'DELETE' });
  }

  /** POST /{flow}/deprecate : retire de l'usage un flow PUBLISHED, qui ne se supprime pas. */
  async deprecate(flowId: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${flowId}/deprecate`, { method: 'POST' });
  }

  /** GET /{waba}/flows, en suivant paging.next. Non branché sur la route GET, qui sert le store local. */
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
