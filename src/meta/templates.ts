import { appelGraph } from './graph';
import { FLOW_ENTRY_SCREEN } from './flow-json';
import type { OutboundCarouselCard } from './template-components';

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

/** En-tête d'un template : texte (avec variable optionnelle) OU média (handle du resumable upload). */
export type TemplateHeader =
  | { format: 'TEXT'; text: string; example?: string }
  | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; handle: string };

export interface CreateTemplateInput {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  language: string;
  /** En-tête optionnel (texte / image / vidéo / document). Un seul par template. */
  header?: TemplateHeader;
  /** corps du message, variables {{1}}, {{2}}... */
  body: string;
  /** exemples de valeurs pour chaque variable (requis par Meta si le corps a des variables) */
  example?: string[];
  /** Pied de page optionnel (texte court, <= 60 car., sans variable). */
  footer?: string;
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
  /** Texte du header TEXT (pour pré-remplir l'édition). undefined si header média/absent. */
  headerText?: string;
  /** URL du média d'en-tête lue chez Meta quand `headerFormat` vaut IMAGE/VIDEO/DOCUMENT. Sert à obtenir le
   *  `media id` de l'envoi, jamais envoyée telle quelle (cf. `headerMediaUrlOf`). undefined si pas de média. */
  headerMediaUrl?: string;
  /** Pied de page (composant FOOTER), pour pré-remplir l'édition. undefined si absent. */
  footer?: string;
  /** Boutons top-level (pour pré-remplir l'édition). undefined si aucun. */
  buttons?: TemplateButton[];
  /** Exemples de variables du BODY (pour pré-remplir l'édition). undefined si aucun. */
  example?: string[];
  /** true si le template est un CAROUSEL (édition non supportée : header_handle non récupérable). */
  isCarousel: boolean;
  /** Cartes du CAROUSEL relues pour l'ENVOI (média, corps, boutons). undefined si le template n'en a pas. */
  carousel?: { cards: OutboundCarouselCard[] };
  /** true si le template se limite à BODY (+BUTTONS) : seul cas éditable en place sans PERTE. Un HEADER,
   *  un FOOTER ou un CAROUSEL serait supprimé par l'édition (buildComponents ne les régénère pas + Meta
   *  REMPLACE tous les components). L'UI et la route PATCH bloquent l'édition si `editable` est false. */
  editable: boolean;
}

/** Un composant de template tel que Meta le rend : tout est optionnel, rien n'est garanti. */
type Composant = {
  type?: string; format?: string; text?: string; buttons?: unknown; cards?: unknown;
  example?: { body_text?: unknown; header_handle?: unknown };
} | null | undefined;

/**
 * La PREMIÈRE valeur que `lire` rend (autre que `undefined`) en parcourant les components d'un template, dans
 * l'ordre. `lire` décide seul s'il s'arrête sur un composant (rendre une valeur, `null` compris) ou s'il passe
 * au suivant (rendre `undefined`). `undefined` = rien trouvé, ou `components` n'est pas un tableau.
 */
function premier<T>(components: unknown, lire: (c: Composant) => T | undefined): T | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const c of components) {
    const v = lire(c as Composant);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Texte du composant BODY parmi les components d'un template. */
function bodyOf(components: unknown): string {
  return premier(components, (c) => (c?.type === 'BODY' && typeof c.text === 'string' ? c.text : undefined)) ?? '';
}

/** Format du composant HEADER (IMAGE/VIDEO/DOCUMENT/TEXT), null si aucun. S'arrête au PREMIER HEADER. */
function headerFormatOf(components: unknown): string | null {
  return premier(components, (c) => (c?.type === 'HEADER' ? (typeof c.format === 'string' ? c.format : null) : undefined)) ?? null;
}

/** Texte d'un header TEXT (pré-remplissage édition). undefined si header média/absent. */
function headerTextOf(components: unknown): string | undefined {
  return premier(components, (c) => (c?.type === 'HEADER' && c.format === 'TEXT' && typeof c.text === 'string' ? c.text : undefined));
}

/** Texte du composant FOOTER (pré-remplissage édition). undefined si absent. */
function footerOf(components: unknown): string | undefined {
  return premier(components, (c) => (c?.type === 'FOOTER' && typeof c.text === 'string' ? c.text : undefined));
}

/** Boutons top-level (composant BUTTONS) remappés en TemplateButton, pour pré-remplir l'édition. */
function buttonsOf(components: unknown): TemplateButton[] | undefined {
  return premier(components, (c) => (c?.type === 'BUTTONS' && Array.isArray(c.buttons)
    ? c.buttons.map((raw): TemplateButton => {
      const b = raw as { type?: string; text?: string; url?: string; flow_id?: string };
      if (b.type === 'URL') return { type: 'URL', text: b.text ?? '', url: b.url ?? '' };
      if (b.type === 'FLOW') return { type: 'FLOW', text: b.text ?? '', flowId: b.flow_id ?? '' };
      return { type: 'QUICK_REPLY', text: b.text ?? '' };
    })
    : undefined));
}

/** Exemples de variables du BODY (example.body_text[0]) pour pré-remplir l'édition. */
function exampleOf(components: unknown): string[] | undefined {
  return premier(components, (c) => {
    if (c?.type !== 'BODY' || !c.example || !Array.isArray(c.example.body_text)) return undefined;
    const row = c.example.body_text[0];
    return Array.isArray(row) ? row.map(String) : undefined;
  });
}

/**
 * URL de média d'un composant HEADER, lue dans `example.header_handle[0]`. Un handle de resumable upload
 * (`4::aW1hZ2U...`, ce qu'on POSTe à la CRÉATION) n'en est PAS une : on ne garde que ce qui est une URL,
 * sinon on enverrait une valeur que Meta refuse. undefined = pas de média exploitable.
 *
 * ⚠️ Cette URL sert à OBTENIR un `media id` (re-téléversement), JAMAIS à l'envoi direct en `link`. Le
 * commentaire précédent affirmait le contraire (« exploitable telle quelle, vérifié live ») sans trace de
 * mesure, et la mesure du 2026-08-15 le contredit : Meta accepte le `link` (200) puis échoue 2 s plus tard en
 * 131053, son téléchargeur se prenant un 403 sur son propre CDN. Cf. `meta/template-media.ts`.
 */
function headerMediaUrlOf(components: unknown): string | undefined {
  return premier(components, (c) => {
    if (c?.type !== 'HEADER') return undefined;
    const handles = c.example?.header_handle;
    const h = Array.isArray(handles) ? handles[0] : undefined;
    return typeof h === 'string' && /^https?:\/\//i.test(h) ? h : undefined;
  });
}

/**
 * Cartes du composant CAROUSEL, relues pour l'ENVOI. Les `cards[].components[]` ont exactement la forme des
 * components top-level (HEADER/BODY/BUTTONS) : on réutilise les mêmes extracteurs. undefined = pas de carousel.
 */
function carouselOf(components: unknown): { cards: OutboundCarouselCard[] } | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const c of components) {
    const comp = c as { type?: string; cards?: unknown };
    if (comp?.type !== 'CAROUSEL') continue;
    const cards = Array.isArray(comp.cards) ? comp.cards : [];
    return {
      cards: cards.map((raw): OutboundCarouselCard => {
        const inner = (raw as { components?: unknown })?.components;
        const url = headerMediaUrlOf(inner);
        const body = bodyOf(inner);
        const buttons = buttonsOf(inner);
        return {
          ...(url !== undefined ? { mediaUrl: url } : {}),
          ...(headerFormatOf(inner) === 'VIDEO' ? { mediaFormat: 'VIDEO' as const } : {}),
          ...(body !== '' ? { body } : {}),
          ...(buttons ? { buttons } : {}),
        };
      }),
    };
  }
  return undefined;
}

/**
 * Éditable en place = on sait REGÉNÉRER tous ses composants à l'identique. OK : BODY, BUTTONS, FOOTER, et un
 * HEADER **TEXTE** (texte récupérable depuis list). PAS éditable : un HEADER **média** (le header_handle
 * n'est pas récupérable -> l'édition le détruirait) ni un CAROUSEL. Meta remplace TOUS les components à l'edit.
 */
function isSimpleEditable(components: unknown): boolean {
  if (!Array.isArray(components)) return false;
  let hasBody = false;
  for (const c of components) {
    const comp = c as { type?: string; format?: string };
    if (comp?.type === 'BODY') hasBody = true;
    else if (comp?.type === 'BUTTONS' || comp?.type === 'FOOTER') continue;
    else if (comp?.type === 'HEADER' && comp.format === 'TEXT') continue;
    else return false; // HEADER média, CAROUSEL, ou composant inconnu -> non éditable
  }
  return hasBody;
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
type ComponentInput = Pick<CreateTemplateInput, 'header' | 'body' | 'example' | 'footer' | 'buttons' | 'carousel'>;

const hasVar = (s: string): boolean => /\{\{\s*\d+\s*\}\}/.test(s);

function buildComponents(input: ComponentInput): unknown[] {
  const components: unknown[] = [];

  // HEADER (ordre Meta : HEADER, BODY, FOOTER, BUTTONS). Hors carousel (le carousel a ses headers par carte).
  if (input.header && !input.carousel) {
    if (input.header.format === 'TEXT') {
      const h: Record<string, unknown> = { type: 'HEADER', format: 'TEXT', text: input.header.text };
      if (hasVar(input.header.text)) h.example = { header_text: [input.header.example || 'exemple'] };
      components.push(h);
    } else {
      // Image / vidéo / document : le handle vient du resumable upload (pas une URL).
      components.push({ type: 'HEADER', format: input.header.format, example: { header_handle: [input.header.handle] } });
    }
  }

  const body: Record<string, unknown> = { type: 'BODY', text: input.body };
  if (input.example && input.example.length > 0) {
    body.example = { body_text: [input.example] };
  }
  components.push(body);

  if (input.footer && !input.carousel) components.push({ type: 'FOOTER', text: input.footer });

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

  private call(url: string, init: RequestInit): Promise<unknown> {
    return appelGraph(this.fetchImpl, this.token, url, init);
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
        const carousel = carouselOf(t.components);
        out.push({
          id: t.id ?? '',
          name: t.name ?? '',
          status: t.status ?? '',
          category: t.category ?? '',
          language: t.language ?? '',
          body: bodyOf(t.components),
          headerFormat: headerFormatOf(t.components),
          ...(headerTextOf(t.components) !== undefined ? { headerText: headerTextOf(t.components) } : {}),
          // Uniquement pour un en-tête MÉDIA : sur un carousel, les visuels sont par carte (cf. `carouselOf`),
          // et un en-tête top-level n'existe pas, donc en exposer un ici induirait l'envoi en erreur.
          ...(!carousel && headerMediaUrlOf(t.components) !== undefined ? { headerMediaUrl: headerMediaUrlOf(t.components) } : {}),
          ...(footerOf(t.components) !== undefined ? { footer: footerOf(t.components) } : {}),
          ...(buttonsOf(t.components) ? { buttons: buttonsOf(t.components) } : {}),
          ...(exampleOf(t.components) ? { example: exampleOf(t.components) } : {}),
          isCarousel: carousel !== undefined,
          ...(carousel ? { carousel } : {}),
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
