/**
 * Client Graph API de l'Embedded Signup (Tech Provider). Séquence officielle, vérifiée sur la doc
 * primaire Meta (2026-07-15, ES v4) :
 *  1. échange du code renvoyé par la popup (TTL 30 s) -> business token (BISU, scopé au client onboardé) ;
 *  2. GET du numéro AVEC ce business token -> display/verified/status ;
 *  3. POST /{waba_id}/subscribed_apps -> webhooks du WABA branchés sur notre app (idempotent) ;
 *  4. POST /{phone_number_id}/register (pin) : numéro NEUF uniquement — un numéro déjà CONNECTED se
 *     re-sélectionne dans la popup sans OTP ni register.
 */

export interface EsPhoneInfo {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** Statut du numéro (ex. CONNECTED) : décide si le register est nécessaire. */
  status: string | null;
}

export class MetaEmbeddedSignupClient {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly version: string,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  private async call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (body as { error?: { message?: string; code?: number } }).error;
      throw new Error(`Graph ${res.status}${err?.code !== undefined ? ` (#${err.code})` : ''} : ${err?.message ?? 'erreur inconnue'}`);
    }
    return body;
  }

  /** Échange le code ES (TTL 30 s) contre le business token du client. */
  async exchangeCode(code: string): Promise<string> {
    const qs = new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, code });
    const body = await this.call(`${this.baseUrl}/${this.version}/oauth/access_token?${qs.toString()}`);
    const token = body['access_token'];
    if (typeof token !== 'string' || token === '') throw new Error("échange du code : pas d'access_token dans la réponse");
    return token;
  }

  /**
   * PREUVE D'APPARTENANCE du WABA : GET /{waba_id} avec le business token. Le token est scopé au client qui a
   * complété l'Embedded Signup -> l'appel ne réussit QUE si ce WABA lui appartient. Throw sinon. C'est le garde-fou
   * anti-hijack cross-tenant : sans ça, un tenant pourrait rattacher le WABA d'un autre en forgeant l'id.
   */
  async verifyWaba(wabaId: string, businessToken: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}?fields=id`, {
      headers: { Authorization: `Bearer ${businessToken}` },
    });
  }

  /** Infos du numéro onboardé, lues avec le business token (le token global ne voit pas les WABA clients).
   *  Sert AUSSI de preuve d'appartenance du numéro (l'appel échoue si le token ne le possède pas). */
  async getPhone(phoneNumberId: string, businessToken: string): Promise<EsPhoneInfo> {
    const qs = new URLSearchParams({ fields: 'id,display_phone_number,verified_name,status' });
    const b = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(phoneNumberId)}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${businessToken}` },
    });
    return {
      id: typeof b['id'] === 'string' ? b['id'] : phoneNumberId,
      displayPhoneNumber: typeof b['display_phone_number'] === 'string' ? b['display_phone_number'] : null,
      verifiedName: typeof b['verified_name'] === 'string' ? b['verified_name'] : null,
      status: typeof b['status'] === 'string' ? b['status'] : null,
    };
  }

  /** Abonne NOTRE app aux webhooks du WABA du client (messages, statuts...). Idempotent côté Meta. */
  async subscribeApp(wabaId: string, businessToken: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${businessToken}` },
    });
  }

  /** Enregistre le numéro sur la Cloud API (numéro neuf). Le pin devient le PIN 2FA du numéro. */
  async register(phoneNumberId: string, businessToken: string, pin: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(phoneNumberId)}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
  }
}
