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

/** Une carte de carousel : image (handle du resumable upload) + texte + boutons (identiques sur toutes). */
export interface CarouselCard {
  headerHandle: string;
  body?: string;
  buttons?: TemplateButton[];
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
  /** Template CAROUSEL : corps commun (`body`) + 2-10 cartes. Exclut `buttons` (boutons par carte). */
  carousel?: { cards: CarouselCard[] };
}

export interface TemplateSummary {
  /** Id Meta du template (requis pour l'édition POST /{id}). Vide pour les anciens appels sans le field. */
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  /** Corps du template (composant BODY) : sert à déduire les variables + l'aperçu côté campagne. */
  body: string;
  /** Format du header : TEXT | IMAGE | VIDEO | DOCUMENT, ou null si pas de header. */
  headerFormat: string | null;
  /** Boutons top-level (pour pré-remplir l'édition). undefined si aucun. */
  buttons?: TemplateButton[];
  /** Exemples de variables du BODY (pour pré-remplir l'édition). undefined si aucun. */
  example?: string[];
  /** true si le template est un CAROUSEL (édition non supportée : header_handle non récupérable). */
  isCarousel: boolean;
  /** true si le template se limite à BODY (+BUTTONS) : seul cas éditable en place sans PERTE. Un HEADER,
   *  un FOOTER ou un CAROUSEL serait supprimé par l'édition (buildComponents ne les régénère pas + Meta
   *  REMPLACE tous les components). L'UI et la route PATCH bloquent l'édition si `editable` est false. */
  editable: boolean;
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

/** Boutons top-level (composant BUTTONS) remappés en TemplateButton, pour pré-remplir l'édition. */
function buttonsOf(components: unknown): TemplateButton[] | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const c of components) {
    const comp = c as { type?: string; buttons?: unknown };
    if (comp?.type === 'BUTTONS' && Array.isArray(comp.buttons)) {
      return comp.buttons.map((raw): TemplateButton => {
        const b = raw as { type?: string; text?: string; url?: string; flow_id?: string };
        if (b.type === 'URL') return { type: 'URL', text: b.text ?? '', url: b.url ?? '' };
        if (b.type === 'FLOW') return { type: 'FLOW', text: b.text ?? '', flowId: b.flow_id ?? '' };
        return { type: 'QUICK_REPLY', text: b.text ?? '' };
      });
    }
  }
  return undefined;
}

/** Exemples de variables du BODY (example.body_text[0]) pour pré-remplir l'édition. */
function exampleOf(components: unknown): string[] | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const c of components) {
    const comp = c as { type?: string; example?: { body_text?: unknown } };
    if (comp?.type === 'BODY' && comp.example && Array.isArray(comp.example.body_text)) {
      const row = comp.example.body_text[0];
      if (Array.isArray(row)) return row.map(String);
    }
  }
  return undefined;
}

/** true si le template porte un composant CAROUSEL (édition non supportée en V1). */
function isCarouselOf(components: unknown): boolean {
  return Array.isArray(components) && components.some((c) => (c as { type?: string })?.type === 'CAROUSEL');
}

/**
 * Un template n'est éditable en place QUE s'il se limite à BODY (+ éventuel BUTTONS). Tout HEADER / FOOTER /
 * CAROUSEL serait DÉTRUIT par l'édition : buildComponents ne régénère que BODY/BUTTONS/CAROUSEL et Meta
 * remplace intégralement les components. On bloque donc l'édition de ces templates (garde-fou anti perte).
 */
function isSimpleEditable(components: unknown): boolean {
  if (!Array.isArray(components)) return false;
  const types = components.map((c) => (c as { type?: string })?.type);
  return types.includes('BODY') && types.every((t) => t === 'BODY' || t === 'BUTTONS');
}

/** Mappe un bouton applicatif -> composant Meta (QUICK_REPLY / URL / FLOW). Réutilisé top-level + cartes. */
function mapButton(b: TemplateButton): Record<string, unknown> {
  // Bouton FLOW : ouvre le flow publié à son écran d'entrée (navigate_screen = id d'écran, vérifié live).
  if (b.type === 'FLOW') return { type: 'FLOW', text: b.text, flow_id: b.flowId, navigate_screen: FLOW_ENTRY_SCREEN, flow_action: 'navigate' };
  if (b.type !== 'URL') return { type: 'QUICK_REPLY', text: b.text };
  const btn: Record<string, unknown> = { type: 'URL', text: b.text, url: b.url };
  // URL dynamique ({{1}}) : Meta EXIGE un exemple d'URL complète au niveau du bouton.
  if (b.url && /\{\{\s*\d+\s*\}\}/.test(b.url)) {
    btn.example = [b.url.replace(/\{\{\s*\d+\s*\}\}/g, 'exemple')];
  }
  return btn;
}

/** Les seuls champs qui déterminent les `components` Meta (partagé create + update ; name/language exclus). */
type ComponentInput = Pick<CreateTemplateInput, 'body' | 'example' | 'buttons' | 'carousel'>;

function buildComponents(input: ComponentInput): unknown[] {
  const components: unknown[] = [];
  const body: Record<string, unknown> = { type: 'BODY', text: input.body };
  if (input.example && input.example.length > 0) {
    body.example = { body_text: [input.example] };
  }
  components.push(body);

  // Template CAROUSEL : un composant CAROUSEL de cartes (chaque carte = header image + body + boutons).
  if (input.carousel) {
    components.push({
      type: 'CAROUSEL',
      cards: input.carousel.cards.map((card) => ({
        components: [
          { type: 'HEADER', format: 'IMAGE', example: { header_handle: [card.headerHandle] } },
          ...(card.body ? [{ type: 'BODY', text: card.body }] : []),
          ...(card.buttons && card.buttons.length > 0 ? [{ type: 'BUTTONS', buttons: card.buttons.map(mapButton) }] : []),
        ],
      })),
    });
    return components;
  }

  if (input.buttons && input.buttons.length > 0) {
    components.push({ type: 'BUTTONS', buttons: input.buttons.map(mapButton) });
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
    let next: string | null = this.url(wabaId, '?fields=id,name,status,category,language,components&limit=100');
    for (let page = 0; page < 20 && next; page++) {
      const json = (await this.call(next, { method: 'GET' })) as {
        data?: Array<{ id?: string; name?: string; status?: string; category?: string; language?: string; components?: unknown }>;
        paging?: { next?: string };
      };
      for (const t of json.data ?? []) {
        out.push({
          id: t.id ?? '',
          name: t.name ?? '',
          status: t.status ?? '',
          category: t.category ?? '',
          language: t.language ?? '',
          body: bodyOf(t.components),
          headerFormat: headerFormatOf(t.components),
          ...(buttonsOf(t.components) ? { buttons: buttonsOf(t.components) } : {}),
          ...(exampleOf(t.components) ? { example: exampleOf(t.components) } : {}),
          isCarousel: isCarouselOf(t.components),
          editable: isSimpleEditable(t.components),
        });
      }
      next = json.paging?.next ?? null;
    }
    return out;
  }

  /**
   * Édite un template existant : POST /{templateId} (node template, PAS /message_templates). Meta REMPLACE
   * intégralement les components (pas de patch) et n'accepte QUE category et/ou components (name/language
   * immuables). Un APPROVED édité repasse en revue (PENDING) puis est auto-réapprouvé si la review passe.
   */
  async update(
    templateId: string,
    input: { category?: 'MARKETING' | 'UTILITY' } & ComponentInput,
  ): Promise<{ success: boolean }> {
    const json = (await this.call(`${this.baseUrl}/${this.version}/${templateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(input.category ? { category: input.category } : {}), components: buildComponents(input) }),
    })) as { success?: boolean };
    return { success: json.success ?? false };
  }

  /** Supprime un template par NOM (toutes langues) : DELETE /{waba}/message_templates?name=. */
  async remove(wabaId: string, name: string): Promise<{ success: boolean }> {
    const json = (await this.call(this.url(wabaId, `?name=${encodeURIComponent(name)}`), { method: 'DELETE' })) as { success?: boolean };
    return { success: json.success ?? false };
  }
}
