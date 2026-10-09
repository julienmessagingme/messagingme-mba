import type { HttpTransport, RetryOpts } from './http';
import { withRetry, type PorteDeDebit, parseRetryAfter } from './http';
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
  rateLimiter?: PorteDeDebit;
  retry?: RetryOpts;
  /**
   * Envois marketing par l'endpoint MM Lite `/marketing_messages` (true) ou par `/messages` (false, défaut).
   * MM Lite exige un onboarding du Business Manager, sans lequel il échoue en 131042 ; un template marketing
   * s'envoie très bien par `/messages`, au tarif marketing.
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
 * Client typé des API de messagerie Meta pour un numéro (phone_number_id). Débit et rejeux appliqués à chaque
 * appel ; transport injecté.
 */
export class MetaClient {
  private readonly transport: HttpTransport;
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly base: string;
  private readonly version: string;
  private readonly rateLimiter: PorteDeDebit | undefined;
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

  /**
   * Un envoi `messages` à `to`, E.164 ou BSUID (routé par `messagingTarget`), qui rend l'identifiant du message.
   * `sendText` n'y passe pas (`recipient_type` et `to` nu), ni `sendMarketing` (qui choisit son point d'entrée).
   */
  private async envoyer(to: string, corps: Record<string, unknown>): Promise<SendResult> {
    // Un `to` ou un `recipient` glissé dans le corps ne peut pas remplacer le destinataire : il est retiré.
    const { to: _to, recipient: _recipient, ...propre } = corps;
    const json = await this.call('messages', { messaging_product: 'whatsapp', ...messagingTarget(to), ...propre });
    return { messageId: this.messageId(json) };
  }

  private messageId(json: unknown): string {
    const messages = (json as { messages?: Array<{ id?: string }> } | null)?.messages;
    const id = messages?.[0]?.id;
    if (!id) throw new Error('réponse Meta sans message id');
    return id;
  }

  /**
   * Un message au format de Meta, déjà VALIDÉ (`schemaContenuMeta`, `src/api/message-meta.ts`) : le type et son contenu,
   * le destinataire posé ici comme pour les autres envois (`messagingTarget`). Lot 13, domaine 2.
   */
  async sendMessage(to: string, corps: Record<string, unknown>): Promise<SendResult> {
    return this.envoyer(to, corps);
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
   * Message interactif à boutons de réponse (hors template), `to` en E.164 ou BSUID. Les titres vides sont filtrés
   * en préservant l'index d'origine dans `reply.id` (`btn:<i>`), pour que la branche par bouton reste stable.
   * Limites Meta : 3 boutons, titre de 20 caractères.
   * `mediaId` = visuel d'en-tête, un identifiant Meta et non un lien : la livraison ne dépend alors pas de
   * l'accessibilité de notre hébergement au moment où Meta va le chercher.
   */
  async sendInteractive(to: string, body: string, buttons: { text: string }[], mediaId?: string): Promise<SendResult> {
    const replyButtons = buttons
      .map((b, i) => ({ type: 'reply' as const, reply: { id: `btn:${i}`, title: b.text.trim().slice(0, 20) } }))
      .filter((b) => b.reply.title !== '')
      .slice(0, 3);
    return this.envoyer(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(mediaId ? { header: { type: 'image', image: { id: mediaId } } } : {}),
        body: { text: body },
        action: { buttons: replyButtons },
      },
    });
  }

  /**
   * Message à bouton de lien (`cta_url`) : un corps de texte et un bouton qui ouvre le navigateur du contact.
   * Chez Meta, c'est un type distinct des réponses rapides (qui reviennent dans le scénario) : un bouton de réponse
   * rapide ne peut pas porter d'adresse. Meta n'envoie aucun webhook au clic : le bloc n'a pas de sortie et le
   * parcours continue tout de suite. Libellé borné à 20 caractères, sinon Meta refuse le message entier.
   */
  async sendCtaUrl(to: string, body: string, lien: { texte: string; url: string }, mediaId?: string): Promise<SendResult> {
    return this.envoyer(to, {
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        ...(mediaId ? { header: { type: 'image', image: { id: mediaId } } } : {}),
        body: { text: body },
        action: {
          name: 'cta_url',
          parameters: { display_text: lien.texte.trim().slice(0, 20), url: lien.url.trim() },
        },
      },
    });
  }

  /**
   * Liste interactive (menu déroulant) : un corps, un bouton qui ouvre le menu et jusqu'à 10 lignes. Même règle
   * d'index que `sendInteractive` : les lignes vides sont filtrées après numérotation, pour que `row:<i>` reste
   * stable (renuméroter enverrait le contact dans la mauvaise branche). Limites Meta appliquées ici : 10 lignes,
   * bouton 20 caractères, titre de ligne 24, description 72, corps 4096. Une seule section.
   */
  async sendList(
    to: string,
    body: string,
    buttonLabel: string,
    rows: { title: string; description?: string }[],
  ): Promise<SendResult> {
    const lignes = rows
      .map((r, i) => ({
        id: `row:${i}`,
        title: String(r.title ?? '').trim().slice(0, 24),
        ...(r.description && r.description.trim() !== '' ? { description: r.description.trim().slice(0, 72) } : {}),
      }))
      .filter((r) => r.title !== '')
      .slice(0, 10);
    return this.envoyer(to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body.slice(0, 4096) },
        action: {
          button: buttonLabel.trim().slice(0, 20) || 'Choisir',
          sections: [{ rows: lignes }],
        },
      },
    });
  }

  /**
   * Image seule, légende facultative : un message interactif exige au moins un bouton, donc un bloc qui porte un
   * visuel sans réponse rapide n'a pas d'autre chemin (sinon le visuel disparaîtrait en silence).
   */
  async sendImage(to: string, mediaId: string, caption?: string): Promise<SendResult> {
    return this.envoyer(to, {
      type: 'image',
      image: { id: mediaId, ...(caption && caption.trim() !== '' ? { caption } : {}) },
    });
  }

  /**
   * Message interactif FLOW (formulaire) hors template, dans la fenêtre de service de 24 h. Requis par Meta :
   * flow_message_version '3', flow_cta, flow_id, et un `flow_token` non vide (#131009) ; la corrélation au retour
   * passe par le `_ref` du flow_json, pas par ce jeton. `screen` = écran d'entrée (défaut FORM). `mode: 'draft'`
   * permet de tester un brouillon non publié.
   */
  async sendFlowMessage(to: string, opts: { body: string; flowId: string; cta: string; flowToken?: string; screen?: string; mode?: 'draft' | 'published' }): Promise<SendResult> {
    return this.envoyer(to, {
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
  }

  async sendTemplate(to: string, tpl: TemplateSpec): Promise<SendResult> {
    // `to` peut être un numéro E.164 OU un BSUID : Meta route via `to` (numéro) vs `recipient` (BSUID).
    return this.envoyer(to, {
      type: 'template',
      template: templatePayload(tpl),
    });
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
