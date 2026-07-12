/**
 * Client minimal Resend pour le formulaire de support. Un seul endpoint : POST /emails.
 * `fetchImpl` injectable (tests sans réseau). Ne lève que ResendError (HTTP non-2xx) -> mappé en 502 amont.
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
  /** Adresse de réponse (l'expéditeur réel du message de support). */
  replyTo?: string;
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
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    const json = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
    if (!res.ok) {
      throw new ResendError(res.status, json?.message ?? `Resend HTTP ${res.status}`);
    }
    return { id: json?.id ?? '' };
  }
}
