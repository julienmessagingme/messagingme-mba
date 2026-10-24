/** Le transport HTTP minimal de Resend (POST /emails), partagé par tous les e-mails de l'application. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ResendError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Corps HTML (facultatif) : les clients qui le rendent l'affichent, `text` reste le repli. */
  html?: string;
  /** Adresse de réponse (l'expéditeur réel du message de support). */
  replyTo?: string;
  /** En-têtes de l'e-mail (lot 7 : `List-Unsubscribe` des e-mails qu'une personne peut couper). */
  headers?: Record<string, string>;
  /** Étiquettes Resend (lot 7 : le modèle), relues dans son tableau de bord et ses webhooks. */
  tags?: Array<{ name: string; value: string }>;
  /** En-tête `Idempotency-Key` (lot 7) : la même clé pendant 24 h rend la même réponse, sans second envoi. */
  cleIdempotence?: string;
}

export type MessageResend = Omit<SendEmailInput, 'from'>;

/**
 * La seule porte de sortie vers Resend. Les appelants composent le message ; ce module possède la clé, le délai et
 * les identités d'expéditeur. Les propriétés sont des fermetures : elles peuvent être passées à un worker sans perdre
 * un `this`, contrairement aux méthodes d'une instance.
 */
export interface EnvoisResend {
  /** E-mails d'authentification et du produit, signés « Messaging Me ». */
  produit: (message: MessageResend) => Promise<{ id: string }>;
  /** Messages adressés à l'équipe depuis le support de la console ou la vitrine. */
  support: (message: MessageResend) => Promise<{ id: string }>;
}

export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.resend.com',
  ) {}

  async send(input: SendEmailInput): Promise<{ id: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json',
        ...(input.cleIdempotence ? { 'idempotency-key': input.cleIdempotence } : {}),
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
        ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      }),
    });
    const json = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
    if (!res.ok) {
      throw new ResendError(res.status, json?.message ?? `Resend HTTP ${res.status}`);
    }
    return { id: json?.id ?? '' };
  }
}

/** Ce qu'on attend au plus de Resend pour un e-mail : au-delà, l'envoi est un échec passager, réessayé. */
export const DELAI_RESEND_MS = 30_000;

/** Un client, deux politiques d'expéditeur, le même délai et le même contrat d'erreur pour tous les appelants. */
export function creerEnvoisResend(apiKey: string, supportFrom: string, fetchImpl: FetchLike = fetch): EnvoisResend {
  const client = new ResendClient(apiKey, (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(DELAI_RESEND_MS) }));
  return {
    produit: (message) => client.send({ ...message, from: `Messaging Me <${supportFrom}>` }),
    support: (message) => client.send({ ...message, from: supportFrom }),
  };
}
