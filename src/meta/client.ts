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
   * Un envoi `messages` à `to`, E.164 OU BSUID (routé par `messagingTarget`) : rend l'identifiant du message.
   * ⚠️ `sendText` n'y passe pas : il porte `recipient_type` et un `to` nu. `sendMarketing` non plus : il choisit
   * son point d'entrée (MM Lite) et sa cible.
   */
  private async envoyer(to: string, corps: Record<string, unknown>): Promise<SendResult> {
    const json = await this.call('messages', { messaging_product: 'whatsapp', ...messagingTarget(to), ...corps });
    return { messageId: this.messageId(json) };
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
   *
   * `mediaId` = visuel d'EN-TÊTE (identifiant Meta, pas une URL). Un message interactif accepte un en-tête
   * image/vidéo/document ; on n'expose que l'image, seul format que l'éditeur sait téléverser.
   *
   * ⚠️ Un identifiant, et pas un lien, alors que Meta accepte les deux : c'est le chemin déjà éprouvé en
   * production par l'en-tête des templates (`TemplateMedia.prepareOne`, qui téléverse et met en cache).
   * Passer un lien ferait dépendre la livraison de l'accessibilité de notre hébergement au moment où Meta
   * va le chercher.
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
   * Message à BOUTON DE LIEN (`cta_url`) : un corps de texte et UN bouton qui ouvre le navigateur du contact.
   *
   * 🔴 EXCLUSIF DES RÉPONSES RAPIDES, et ce n'est pas notre choix : chez Meta, `button` (jusqu'à trois
   * réponses rapides, qui REVIENNENT dans le scénario) et `cta_url` (un bouton, qui OUVRE une page) sont deux
   * types de messages interactifs DIFFÉRENTS. Un bouton de réponse rapide ne peut donc pas porter d'adresse,
   * quelle que soit la façon dont on l'écrit dans la console. L'écran le dit au moment où la case se coche,
   * plutôt que de laisser le client le découvrir à l'envoi.
   *
   * ⚠️ RIEN NE REVIENT quand le contact clique : Meta n'envoie aucun webhook pour ce bouton. Le bloc ne
   * porte donc aucune sortie à relier, et le parcours continue tout de suite après, comme après un simple
   * texte.
   *
   * ⚠️ Le libellé est borné à 20 caractères, la même limite que les réponses rapides. La dépasser fait
   * refuser le message ENTIER par Meta.
   *
   * ⚠️ L'en-tête image vient de la référence Cloud API, PAS d'une mesure : on ne mesure jamais contre le
   * Meta de production (le numéro est live). Un refus de Meta serait visible et remonté tel quel ; laisser
   * tomber le visuel en silence, non.
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
   * LISTE interactive (menu déroulant) : un corps de texte, un bouton qui ouvre le menu, et jusqu'à 10 lignes
   * sélectionnables. C'est ce qu'envoie un bloc Question quand il porte un menu.
   *
   * MÊME règle d'index que `sendInteractive`, et pour la même raison : les lignes au libellé vide sont
   * filtrées APRÈS numérotation, donc `row:<i>` reste stable même si une ligne du milieu est vide. Filtrer
   * avant renumérote les lignes et envoie le contact dans la mauvaise branche du scénario.
   *
   * Limites relevées sur la référence Cloud API le 2026-08-26, et appliquées ICI plutôt que laissées à Meta :
   * 10 lignes toutes sections confondues, bouton 20 caractères, titre de ligne 24, description 72, corps 4096.
   * UNE seule section : Meta en accepte 10, mais le titre de section est un habillage que l'éditeur n'expose
   * pas, et une section unique rend exactement le menu attendu.
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
   * Image seule, légende facultative. Nécessaire parce qu'un message INTERACTIF exige au moins un bouton :
   * un bloc « message rapide » qui porte un visuel mais aucune réponse rapide n'a donc pas d'autre chemin.
   * Sans ça, ce montage partirait en texte nu et le visuel disparaîtrait sans que personne ne le sache.
   */
  async sendImage(to: string, mediaId: string, caption?: string): Promise<SendResult> {
    return this.envoyer(to, {
      type: 'image',
      image: { id: mediaId, ...(caption && caption.trim() !== '' ? { caption } : {}) },
    });
  }

  /**
   * Message interactif de type FLOW (formulaire) hors template — fenêtre de service 24 h requise.
   * Params requis Meta : flow_message_version '3', flow_cta, flow_id. `flow_token` jamais vide (#131009)
   * mais la corrélation au retour passe par le `_ref` baké dans le flow_json, PAS par le token (jetable).
   * `screen` = id de l'écran d'ENTRÉE (défaut FORM, celui des flows du générateur). `mode: 'draft'` permet
   * de tester un brouillon non publié (sondé 2026-07-17) ; nominal = published (défaut Meta, omis).
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
