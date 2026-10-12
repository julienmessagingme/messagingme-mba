import { z } from 'zod';
import type { FetchLike } from './templates';
import { appelGraph } from './graph';
import { MetaApiError } from './errors';
import { messageDe } from '../lib/erreur';
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

/** Les fichiers d'un flow (`GET /{flow}/assets`), lus champ par champ : seul le flow_json nous sert. */
const assetsSchema = z.object({
  data: z.array(z.object({ asset_type: z.string().optional(), download_url: z.string().optional() })),
});

/** Le flow_json d'un flow, réduit à ce qu'on en lit : l'id de chaque écran, dans l'ordre. */
const flowJsonSchema = z.object({ screens: z.array(z.object({ id: z.string().min(1) })) });

/** Plafond de chacune des deux lectures de `ecranDEntree`. Dépassé, l'envoi retombe sur `FORM` (`envois-bloc.ts`). */
const DELAI_LECTURE_FLOW_MS = 10_000;

/**
 * Client des WhatsApp Flows (niveau WABA) : créer, publier, lister via l'API Graph, lire l'écran d'ouverture. Ne lève
 * que MetaApiError (réseau, HTTP), FlowJsonInvalidError (validation), ou une `Error` simple pour tout échec de
 * `ecranDEntree`, refus de Graph compris ; la génération du flow_json est interne (buildFlowScreens).
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

  /**
   * L'écran d'ouverture d'un flow : le premier de son flow_json, lu par `GET /{flow}/assets` puis le fichier désigné.
   * Le message interactif doit le nommer (`flow_action_payload.screen`), et un écran que le flow n'a pas fait refuser
   * le message entier par Meta en 131009. Nos flows ouvrent sur `FORM` ; un flow construit dans WhatsApp Manager porte
   * ses propres noms (`CIVILITE` pour SMATIS, le 2026-10-12). Lève une `Error` simple si la lecture est refusée, ou
   * si le fichier est introuvable ou illisible.
   *
   * ⚠️ `screens[0]` : l'écran de tête, celui de nos flows et des flows de WhatsApp Manager mesurés. Un flow à endpoint
   * dont l'entrée ne serait pas en tête n'est pas couvert, et `sendFlowMessage` ne sait de toute façon pas l'ouvrir
   * (`navigate` sans `data`).
   */
  async ecranDEntree(flowId: string): Promise<string> {
    // Plafond par lecture : elle précède l'envoi d'un formulaire, qu'une lecture pendue retiendrait sans fin.
    const lus = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(flowId)}/assets`, { method: 'GET', signal: AbortSignal.timeout(DELAI_LECTURE_FLOW_MS) })
      .catch((err: unknown) => {
        // 🔴 Jamais une `MetaApiError` hors d'ici : l'intercepteur de la fabrique (`guard`) prend tout refus de type
        // `OAuthException` pour un jeton mort et invalide celui de l'espace, or Meta pose ce type sur un simple
        // paramètre refusé (code 100). Une lecture accessoire ne doit pas couper tous les envois d'un espace ; un jeton
        // réellement mort sera vu par l'envoi qui suit.
        throw new Error(`flow ${flowId} : lecture de ses fichiers refusée (${err instanceof MetaApiError ? `HTTP ${err.httpStatus}, code ${err.code ?? '?'}` : messageDe(err)})`);
      });
    const assets = assetsSchema.safeParse(lus);
    const url = assets.success ? assets.data.data.find((a) => a.asset_type === 'FLOW_JSON')?.download_url : undefined;
    if (!url) throw new Error(`flow ${flowId} : aucun flow_json dans ses fichiers chez Meta`);
    // Une adresse signée du CDN de Meta, servie sans jeton.
    const res = await this.fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(DELAI_LECTURE_FLOW_MS) });
    const lu = flowJsonSchema.safeParse(res.ok ? await res.json().catch(() => null) : null);
    const ecran = lu.success ? lu.data.screens[0]?.id : undefined;
    if (!ecran) throw new Error(`flow ${flowId} : flow_json illisible (HTTP ${res.status})`);
    return ecran;
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
