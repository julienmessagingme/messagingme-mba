import { MetaApiError } from './errors';
import type { MetaErrorBody } from './errors';

/**
 * Client des templates WhatsApp (niveau WABA, pas phone_number_id). Création + liste via
 * l'API Graph. `fetchImpl` injectable pour les tests (aucun réseau).
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TemplateButton {
  type: 'QUICK_REPLY' | 'URL';
  text: string;
  /** requis si type = URL */
  url?: string;
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
      buttons: input.buttons.map((b) =>
        b.type === 'URL'
          ? { type: 'URL', text: b.text, url: b.url }
          : { type: 'QUICK_REPLY', text: b.text },
      ),
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

  /** Liste les templates du WABA avec leur statut (APPROVED/PENDING/REJECTED). */
  async list(wabaId: string): Promise<TemplateSummary[]> {
    const json = (await this.call(this.url(wabaId, '?fields=name,status,category,language&limit=200'), {
      method: 'GET',
    })) as { data?: Array<{ name?: string; status?: string; category?: string; language?: string }> };
    return (json.data ?? []).map((t) => ({
      name: t.name ?? '',
      status: t.status ?? '',
      category: t.category ?? '',
      language: t.language ?? '',
    }));
  }
}
