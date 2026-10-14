/**
 * Client minimal Resend pour le formulaire de support (POST /emails), `fetchImpl` injectable. Ne lève que
 * ResendError (HTTP non-2xx), traduit en 422 par la route.
 */
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

/**
 * L'expéditeur des e-mails du produit (lot 7) : UN client, construit à un seul endroit (le socle), avec l'adresse
 * « Messaging Me <SUPPORT_FROM> » et un appel borné à `DELAI_RESEND_MS`. Il rend l'identifiant de Resend, que le journal
 * garde pour son webhook.
 */
export function creerEnvoyeurProduit(apiKey: string, from: string, fetchImpl: FetchLike = fetch): (m: Omit<SendEmailInput, 'from'>) => Promise<{ id: string }> {
  const client = new ResendClient(apiKey, (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(DELAI_RESEND_MS) }));
  return (m) => client.send({ from, ...m });
}
