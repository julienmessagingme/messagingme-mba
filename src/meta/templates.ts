import { MetaApiError } from './errors';
import type { MetaErrorBody } from './errors';
import { FLOW_ENTRY_SCREEN } from './flow-json';

/**
 * Client des templates WhatsApp (niveau WABA, pas phone_number_id). Création + liste via
 * l'API Graph. `fetchImpl` injectable pour les tests (aucun réseau).
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'FLOW';
  text: string;
  /** requis si type = URL */
  url?: string;
  /** requis si type = FLOW : id Meta d'un flow PUBLISHED. */
  flowId?: string;
}

export interface CreateTemplateInput {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  language: string;
  /** corps du message, variables {{1}}, {{2}}... */
  body: string;
  /** exemples de valeurs pour chaque variable (requis par Meta si le corps a des variables) */
  example?: string[];
  buttons?: TemplateButton[];
}

export interface TemplateSummary {
  name: string;
  status: string;
  category: string;
  language: string;
  /** Corps du template (composant BODY) : sert à déduire les variables + l'aperçu côté campagne. */
  body: string;
  /** Format du header : TEXT | IMAGE | VIDEO | DOCUMENT, ou null si pas de header. */
  headerFormat: string | null;
}

/** Texte du composant BODY parmi les components d'un template. */
function bodyOf(components: unknown): string {
  if (!Array.isArray(components)) return '';
  for (const c of components) {
    const comp = c as { type?: string; text?: string };
    if (comp?.type === 'BODY' && typeof comp.text === 'string') return comp.text;
  }
  return '';
}

/** Format du composant HEADER (IMAGE/VIDEO/DOCUMENT/TEXT), null si aucun. */
function headerFormatOf(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  for (const c of components) {
    const comp = c as { type?: string; format?: string };
    if (comp?.type === 'HEADER') return typeof comp.format === 'string' ? comp.format : null;
  }
  return null;
}

function buildComponents(input: CreateTemplateInput): unknown[] {
  const components: unknown[] = [];
  const body: Record<string, unknown> = { type: 'BODY', text: input.body };
  if (input.example && input.example.length > 0) {
    body.example = { body_text: [input.example] };
  }
  components.push(body);
  if (input.buttons && input.buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: input.buttons.map((b) => {
        // Bouton FLOW : ouvre le flow publié à son écran d'entrée (navigate_screen = id d'écran, vérifié live).
        if (b.type === 'FLOW') return { type: 'FLOW', text: b.text, flow_id: b.flowId, navigate_screen: FLOW_ENTRY_SCREEN, flow_action: 'navigate' };
        if (b.type !== 'URL') return { type: 'QUICK_REPLY', text: b.text };
        const btn: Record<string, unknown> = { type: 'URL', text: b.text, url: b.url };
        // URL dynamique ({{1}}) : Meta EXIGE un exemple d'URL complète au niveau du bouton.
        if (b.url && /\{\{\s*\d+\s*\}\}/.test(b.url)) {
          btn.example = [b.url.replace(/\{\{\s*\d+\s*\}\}/g, 'exemple')];
        }
        return btn;
      }),
    });
  }
  return components;
}

export class MetaTemplateClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v23.0',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  private url(wabaId: string, suffix = ''): string {
    return `${this.baseUrl}/${this.version}/${wabaId}/message_templates${suffix}`;
  }

  private async call(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const errBody = (json as { error?: MetaErrorBody } | null)?.error ?? null;
      throw new MetaApiError(res.status, errBody);
    }
    return json;
  }

  /** Crée (soumet à validation) un template. Retourne l'id + le statut initial. */
  async create(wabaId: string, input: CreateTemplateInput): Promise<{ id: string; status: string }> {
    const json = (await this.call(this.url(wabaId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        category: input.category,
        language: input.language,
        components: buildComponents(input),
      }),
    })) as { id?: string; status?: string };
    return { id: json.id ?? '', status: json.status ?? 'PENDING' };
  }

  /**
   * Liste TOUS les templates du WABA avec leur statut (APPROVED/PENDING/REJECTED).
   * Suit le curseur `paging.next` pour ne rien tronquer (cap de sécurité à 20 pages).
   */
  async list(wabaId: string): Promise<TemplateSummary[]> {
    const out: TemplateSummary[] = [];
    let next: string | null = this.url(wabaId, '?fields=name,status,category,language,components&limit=100');
    for (let page = 0; page < 20 && next; page++) {
      const json = (await this.call(next, { method: 'GET' })) as {
        data?: Array<{ name?: string; status?: string; category?: string; language?: string; components?: unknown }>;
        paging?: { next?: string };
      };
      for (const t of json.data ?? []) {
        out.push({
          name: t.name ?? '',
          status: t.status ?? '',
          category: t.category ?? '',
          language: t.language ?? '',
          body: bodyOf(t.components),
          headerFormat: headerFormatOf(t.components),
        });
      }
      next = json.paging?.next ?? null;
    }
    return out;
  }
}
