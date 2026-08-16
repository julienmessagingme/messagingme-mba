import { MetaApiError, type MetaErrorBody } from './errors';
import type { FetchLike } from './templates';

/**
 * Ajout et vérification d'un numéro sur un WABA, DE BOUT EN BOUT PAR API, sans la popup.
 *
 * C'est ce qui rend l'automatisation de l'OTP possible : le code ne transite jamais par l'écran de Meta, il
 * est posté par `verifyCode`. La popup d'Embedded Signup est un iframe d'un autre domaine, donc impossible à
 * remplir automatiquement ; ce chemin-ci la contourne au lieu d'essayer de la piloter.
 *
 * Séquence, dans cet ordre strict :
 *   1. `addPhoneNumber`  -> crée le numéro sur le WABA, rend son `phone_number_id`
 *   2. `requestCode`     -> Meta APPELLE le numéro et dicte le code (VOICE ; le SMS est déconseillé sur VoIP,
 *                           et nos numéros français ne reçoivent de toute façon pas de SMS)
 *   3. `verifyCode`      -> poste le code capté
 *   4. l'activation sur la Cloud API (`/register` + PIN) N'EST PAS ici : elle existe déjà dans
 *      `MetaEmbeddedSignupClient.register`, sur le chemin d'embarquement en production. La dupliquer
 *      donnerait deux sources de vérité pour le même appel Graph, qui divergeraient au premier changement.
 *
 * 🔴 PLAFOND : 10 requêtes par numéro sur 72 heures, toutes étapes confondues. Aucune méthode de ce client
 * n'est donc rejouée automatiquement : un `withRetry` sur `requestCode` griderait le quota d'un numéro en
 * quelques secondes, et un numéro bloqué se récupère en attendant 72 h, pas en corrigeant du code.
 */
export class MetaPhoneRegisterClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v25.0',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  private async post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/${this.version}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as ({ error?: MetaErrorBody } & Record<string, unknown>) | null;
    if (!res.ok) throw new MetaApiError(res.status, json?.error ?? null);
    return json ?? {};
  }

  /**
   * `POST /{waba_id}/phone_numbers`. `cc` est l'indicatif pays SÉPARÉ du numéro national (Meta les veut
   * distincts), `verifiedName` le nom d'affichage soumis à revue. Rend le `phone_number_id`.
   */
  async addPhoneNumber(wabaId: string, cc: string, phoneNumber: string, verifiedName: string): Promise<string> {
    const json = await this.post(`${encodeURIComponent(wabaId)}/phone_numbers`, { cc, phone_number: phoneNumber, verified_name: verifiedName });
    const id = json.id;
    if (typeof id !== 'string' || id === '') throw new MetaApiError(200, null);
    return id;
  }

  /**
   * `POST /{phone_number_id}/request_code`. VOICE imposé : Meta classe le SMS « non recommandé » sur un numéro
   * VoIP, et nos numéros français sont en voix seule. `language` est forcé (« fr » par défaut) sans quoi Meta
   * dicte le code dans une autre langue, que la reconnaissance vocale française transcrirait mal.
   */
  async requestCode(phoneNumberId: string, language = 'fr'): Promise<void> {
    await this.post(`${encodeURIComponent(phoneNumberId)}/request_code`, { code_method: 'VOICE', language });
  }

  /**
   * `POST /{phone_number_id}/verify_code`. Le code capté par la transcription, jamais saisi à l'écran.
   *
   * ⚠️ Après celui-ci, le numéro est VÉRIFIÉ mais pas encore ACTIVÉ : il reste incapable d'envoyer tant que
   * `MetaEmbeddedSignupClient.register` n'a pas posé le PIN. C'est l'étape la plus oubliée de la séquence.
   */
  async verifyCode(phoneNumberId: string, code: string): Promise<void> {
    await this.post(`${encodeURIComponent(phoneNumberId)}/verify_code`, { code });
  }
}
