import type { HttpTransport, RetryOpts } from './http';
import { withRetry, RateLimiter, parseRetryAfter } from './http';
import { MetaApiError } from './errors';
import type { MetaErrorBody } from './errors';
import { messagingTarget } from './types';
import type { SendResult, TemplateSpec, MarketingParams } from './types';
import { FLOW_ENTRY_SCREEN } from './flow-json';

export interface MetaClientOpts {
  transport: HttpTransport;
  token: string;
  phoneNumberId: string;
  version?: string;
  baseUrl?: string;
  rateLimiter?: RateLimiter;
  retry?: RetryOpts;
  /**
   * Router les envois marketing par l'endpoint MM Lite `/marketing_messages` (true) ou par
   * l'endpoint standard `/messages` (false, défaut). MM Lite exige un onboarding au niveau
   * Business Manager (ToS dédiée) ; sans lui, `/marketing_messages` échoue en 131042
   * (« business eligibility payment issue »). Un template marketing s'envoie très bien par
   * `/messages`, facturé au tarif marketing. Activer une fois le BM onboardé MM Lite.
   */
  marketingViaLite?: boolean;
}

function templatePayload(tpl: TemplateSpec): Record<string, unknown> {
  return {
    name: tpl.name,
    language: { code: tpl.language },
    ...(tpl.components ? { components: tpl.components } : {}),
  };
}

/**
 * Client typé des API de messagerie Meta pour UN numéro (phone_number_id).
 * Throttle + retries appliqués à chaque appel. Transport injecté (testable sans réseau).
 */
export class MetaClient {
  private readonly transport: HttpTransport;
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly base: string;
  private readonly version: string;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly retry: RetryOpts | undefined;
  private readonly marketingViaLite: boolean;

  constructor(opts: MetaClientOpts) {
    this.transport = opts.transport;
    this.token = opts.token;
    this.phoneNumberId = opts.phoneNumberId;
    this.base = opts.baseUrl ?? 'https://graph.facebook.com';
    this.version = opts.version ?? 'v25.0';
    this.rateLimiter = opts.rateLimiter;
    this.retry = opts.retry;
    this.marketingViaLite = opts.marketingViaLite ?? false;
  }

  private url(path: string): string {
    return `${this.base}/${this.version}/${this.phoneNumberId}/${path}`;
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    return withRetry(async () => {
      if (this.rateLimiter) await this.rateLimiter.acquire();
      const res = await this.transport.post(this.url(path), body, {
        Authorization: `Bearer ${this.token}`,
      });
      if (res.status < 200 || res.status >= 300) {
        const errBody = (res.json as { error?: MetaErrorBody } | null)?.error ?? null;
        throw new MetaApiError(res.status, errBody, parseRetryAfter(res.headers));
      }
      return res.json;
    }, this.retry);
  }

  private messageId(json: unknown): string {
    const messages = (json as { messages?: Array<{ id?: string }> } | null)?.messages;
    const id = messages?.[0]?.id;
    if (!id) throw new Error('réponse Meta sans message id');
    return id;
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    const json = await this.call('messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body },
    });
    return { messageId: this.messageId(json) };
  }

  /**
   * Message interactif à boutons de réponse (hors template). `to` = E.164 OU BSUID (routé par messagingTarget).
   * Les titres vides sont filtrés en PRÉSERVANT l'index d'origine dans `reply.id` (`btn:<i>`), pour que la branche
   * par bouton (sourceHandle) reste stable même si une réponse du milieu est vide. Cap Meta : 3 boutons, titre 20 car.
   */
  async sendInteractive(to: string, body: string, buttons: { text: string }[]): Promise<SendResult> {
    const replyButtons = buttons
      .map((b, i) => ({ type: 'reply' as const, reply: { id: `btn:${i}`, title: b.text.trim().slice(0, 20) } }))
      .filter((b) => b.reply.title !== '')
      .slice(0, 3);
    const json = await this.call('messages', {
      messaging_product: 'whatsapp',
      ...messagingTarget(to),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: replyButtons },
      },
    });
    return { messageId: this.messageId(json) };
  }

  /**
   * Message interactif de type FLOW (formulaire) hors template — fenêtre de service 24 h requise.
   * Params requis Meta : flow_message_version '3', flow_cta, flow_id. `flow_token` jamais vide (#131009)
   * mais la corrélation au retour passe par le `_ref` baké dans le flow_json, PAS par le token (jetable).
   * `screen` = id de l'écran d'ENTRÉE (défaut FORM, celui des flows du générateur). `mode: 'draft'` permet
   * de tester un brouillon non publié (sondé 2026-07-17) ; nominal = published (défaut Meta, omis).
   */
  async sendFlowMessage(to: string, opts: { body: string; flowId: string; cta: string; flowToken?: string; screen?: string; mode?: 'draft' | 'published' }): Promise<SendResult> {
    const json = await this.call('messages', {
      messaging_product: 'whatsapp',
      ...messagingTarget(to),
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: opts.body },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: (opts.flowToken ?? '').trim() || 'mba-flow',
            flow_id: opts.flowId,
            flow_cta: opts.cta,
            flow_action: 'navigate',
            flow_action_payload: { screen: opts.screen ?? FLOW_ENTRY_SCREEN },
            ...(opts.mode === 'draft' ? { mode: 'draft' } : {}),
          },
        },
      },
    });
    return { messageId: this.messageId(json) };
  }

  async sendTemplate(to: string, tpl: TemplateSpec): Promise<SendResult> {
    // `to` peut être un numéro E.164 OU un BSUID : Meta route via `to` (numéro) vs `recipient` (BSUID).
    const json = await this.call('messages', {
      messaging_product: 'whatsapp',
      ...messagingTarget(to),
      type: 'template',
      template: templatePayload(tpl),
    });
    return { messageId: this.messageId(json) };
  }

  async sendMarketing(params: MarketingParams): Promise<SendResult> {
    if (!params.to && !params.recipient) {
      throw new Error('sendMarketing: `to` (E.164) ou `recipient` (BSUID) requis');
    }
    // `to` prime si les deux sont fournis (spec Meta).
    const target = params.to ? { to: params.to } : { recipient: params.recipient };
    // MM Lite (`/marketing_messages`) seulement si le BM est onboardé, sinon endpoint standard
    // `/messages` (un template marketing s'envoie très bien par là, facturé au tarif marketing).
    const endpoint = this.marketingViaLite ? 'marketing_messages' : 'messages';
    const json = await this.call(endpoint, {
      messaging_product: 'whatsapp',
      ...target,
      type: 'template',
      template: templatePayload(params.template),
    });
    return { messageId: this.messageId(json) };
  }
}
