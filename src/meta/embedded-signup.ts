/**
 * Client Graph API de l'Embedded Signup (Tech Provider). Séquence officielle, vérifiée sur la doc
 * primaire Meta (2026-07-15, ES v4) :
 *  1. échange du code renvoyé par la popup (TTL 30 s) -> business token (BISU, scopé au client onboardé) ;
 *  2. GET du numéro AVEC ce business token -> display/verified/status ;
 *  3. POST /{waba_id}/subscribed_apps -> webhooks du WABA branchés sur notre app (idempotent) ;
 *  4. POST /{phone_number_id}/register (pin) : numéro NEUF uniquement — un numéro déjà CONNECTED se
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
   * Vérification du numéro par code (`VERIFIED`, `NOT_VERIFIED`, `EXPIRED`). Rendu par `getPhone` seulement,
   * d'où l'optionnalité : `listPhones` ne sert qu'à retrouver un identifiant et ne le demande pas.
   *
   * 🔴 DEPUIS LA v4 DE L'INSCRIPTION, un client peut terminer le parcours avec un numéro NON vérifié (la v2
   * finissait toujours vérifié). `register` refuse alors le numéro (133006) et chaque tentative consomme une
   * des 10 requêtes permises par numéro sur 72 h. Mesuré le 2026-09-22 : numéro resté `PENDING`, cause perdue.
   */
  codeVerificationStatus?: string | null;
}

/**
 * L'appel Graph, l'échange de code et la lecture des cibles d'un jeton viennent de `ClientGraph`
 * (`./graph.ts`), extrait le 2026-09-23 pour que les publicités ne les recopient pas. Ce qui suit est ce
 * qui appartient EN PROPRE à l'inscription WhatsApp.
 */
export class MetaEmbeddedSignupClient extends ClientGraph {

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
    // Les DEUX scopes WhatsApp sont acceptés : selon la configuration, la cible n'est portée que par l'un.
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
