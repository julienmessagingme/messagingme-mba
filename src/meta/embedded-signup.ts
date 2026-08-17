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
   * Comptes WhatsApp auxquels ce business token donne accès, lus DANS LE TOKEN (`GET /debug_token` ->
   * `granular_scopes[...].target_ids`).
   *
   * 🔴 POURQUOI ce détour existe. La popup n'émet ses informations de compte (`WA_EMBEDDED_SIGNUP`) que
   * lorsqu'elle exécute VRAIMENT les étapes de configuration. Un client qui rouvre le parcours après un premier
   * passage déjà abouti obtient un code d'autorisation... et RIEN d'autre : Meta n'a plus rien à configurer,
   * donc plus rien à annoncer. Mesuré le 2026-08-17 avec toute trace de filtrage retirée : le seul message reçu
   * de facebook.com était le canal interne du SDK portant le code. Tant qu'on dépendait de ce message, un client
   * ayant cliqué deux fois restait bloqué DÉFINITIVEMENT, sans aucun recours.
   *
   * Rend [] si le token n'expose aucune cible, et ce n'est pas une erreur : un token NON scopé (System User de
   * notre propre business, mesuré le 2026-08-17) rend `target_ids: null`. L'appelant décide quoi en dire.
   */
  async wabasForToken(businessToken: string): Promise<string[]> {
    const qs = new URLSearchParams({ input_token: businessToken });
    const body = await this.call(`${this.baseUrl}/${this.version}/debug_token?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${businessToken}` },
    });
    const data = (body['data'] ?? {}) as { granular_scopes?: unknown };
    const scopes = Array.isArray(data.granular_scopes) ? data.granular_scopes : [];
    const out: string[] = [];
    for (const s of scopes as Array<{ scope?: unknown; target_ids?: unknown }>) {
      // Les DEUX scopes WhatsApp sont acceptés : selon la configuration, la cible n'est portée que par l'un.
      if (s?.scope !== 'whatsapp_business_management' && s?.scope !== 'whatsapp_business_messaging') continue;
      for (const id of Array.isArray(s.target_ids) ? s.target_ids : []) {
        if (typeof id === 'string' && id !== '' && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /** Numéros d'un WABA, lus avec le business token. Sert à retrouver le numéro quand la popup ne l'a pas dit. */
  async listPhones(wabaId: string, businessToken: string): Promise<EsPhoneInfo[]> {
    const qs = new URLSearchParams({ fields: 'id,display_phone_number,verified_name,status', limit: '50' });
    const body = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}/phone_numbers?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${businessToken}` },
    });
    const rows = Array.isArray(body['data']) ? (body['data'] as Array<Record<string, unknown>>) : [];
    return rows
      .map((r) => ({
        id: typeof r['id'] === 'string' ? r['id'] : '',
        displayPhoneNumber: typeof r['display_phone_number'] === 'string' ? r['display_phone_number'] : null,
        verifiedName: typeof r['verified_name'] === 'string' ? r['verified_name'] : null,
        status: typeof r['status'] === 'string' ? r['status'] : null,
      }))
      .filter((p) => p.id !== '');
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
