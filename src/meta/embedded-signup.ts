/**
 * Client Graph API de l'Embedded Signup (Tech Provider), séquence officielle Meta (ES v4) :
 *  1. échange du code de la popup (TTL 30 s) -> business token, scopé au client embarqué ;
 *  2. GET du numéro avec ce token -> display, verified, status ;
 *  3. POST /{waba_id}/subscribed_apps -> webhooks du WABA branchés sur notre app (idempotent) ;
 *  4. POST /{phone_number_id}/register (pin) : numéro neuf uniquement, un numéro déjà CONNECTED se
 *     re-sélectionne dans la popup sans OTP ni register.
 */

import { ClientGraph } from './graph';

export interface EsPhoneInfo {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** Statut du numéro (ex. CONNECTED) : décide si le register est nécessaire. */
  status: string | null;
  /**
   * Vérification du numéro par code (`VERIFIED`, `NOT_VERIFIED`, `EXPIRED`), rendue par `getPhone` seulement.
   * Depuis la v4, un client peut finir le parcours avec un numéro non vérifié : `register` le refuse (133006), et
   * chaque tentative consomme une des 10 requêtes permises par numéro sur 72 h.
   */
  codeVerificationStatus?: string | null;
}

/** Ce qui est propre à l'inscription WhatsApp ; l'appel Graph et l'échange de code viennent de `ClientGraph`. */
export class MetaEmbeddedSignupClient extends ClientGraph {

  /**
   * Comptes WhatsApp auxquels ce business token donne accès, lus dans le token (`GET /debug_token` ->
   * `granular_scopes[...].target_ids`). La popup n'annonce ses comptes (`WA_EMBEDDED_SIGNUP`) que lorsqu'elle
   * configure vraiment : un client qui refait le parcours ne reçoit que le code, et resterait bloqué sans ce détour.
   * Rend [] si le token n'expose aucune cible (un token non scopé rend `target_ids: null`) : l'appelant décide.
   */
  async wabasForToken(businessToken: string): Promise<string[]> {
    // Les deux scopes WhatsApp sont acceptés : selon la configuration, la cible n'est portée que par l'un.
    return this.ciblesDuJeton(businessToken, ['whatsapp_business_management', 'whatsapp_business_messaging']);
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
   * 🔴 Preuve d'appartenance du WABA : `GET /{waba_id}` avec le business token, scopé au client qui a fait
   * l'Embedded Signup, ne réussit que si ce WABA lui appartient (lève sinon). Sans elle, un tenant pourrait
   * rattacher le WABA d'un autre en forgeant l'identifiant.
   */
  async verifyWaba(wabaId: string, businessToken: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}?fields=id`, {
      headers: { Authorization: `Bearer ${businessToken}` },
    });
  }

  /**
   * Infos du numéro embarqué, lues avec le business token (le token global ne voit pas les WABA clients).
   * Sert aussi de preuve d'appartenance du numéro : l'appel échoue si le token ne le possède pas.
   */
  async getPhone(phoneNumberId: string, businessToken: string): Promise<EsPhoneInfo> {
    const qs = new URLSearchParams({ fields: 'id,display_phone_number,verified_name,status,code_verification_status' });
    const b = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(phoneNumberId)}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${businessToken}` },
    });
    return {
      id: typeof b['id'] === 'string' ? b['id'] : phoneNumberId,
      displayPhoneNumber: typeof b['display_phone_number'] === 'string' ? b['display_phone_number'] : null,
      verifiedName: typeof b['verified_name'] === 'string' ? b['verified_name'] : null,
      status: typeof b['status'] === 'string' ? b['status'] : null,
      codeVerificationStatus: typeof b['code_verification_status'] === 'string' ? b['code_verification_status'] : null,
    };
  }

  /** Abonne notre app aux webhooks du WABA du client (messages, statuts...). Idempotent côté Meta. */
  async subscribeApp(wabaId: string, businessToken: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${businessToken}` },
    });
  }

  /**
   * Désabonne notre app des webhooks du WABA du client : l'inverse de `subscribeApp`, à la suppression d'un espace
   * (RC8). 🔴 Jamais avec le jeton global : sur notre propre WABA, il couperait les webhooks d'autres espaces
   * (`src/ops/suppression-espace.ts` ne l'appelle qu'avec le jeton propre de l'espace).
   */
  async unsubscribeApp(wabaId: string, businessToken: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'DELETE',
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
