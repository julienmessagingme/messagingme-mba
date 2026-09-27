import { MetaApiError } from './errors';
import type { FetchLike } from './templates';
import { appelGraph } from './graph';

/**
 * Ajout et vérification d'un numéro sur un WABA, entièrement par API, sans la popup d'Embedded Signup (un iframe
 * d'un autre domaine, impossible à remplir) : c'est ce qui permet d'automatiser l'OTP.
 *
 * Ordre strict : `addPhoneNumber`, `requestCode` (Meta appelle le numéro et dicte le code), `verifyCode`.
 * L'activation (`/register` + PIN) reste dans `MetaEmbeddedSignupClient.register`, seule source de cet appel.
 *
 * Plafond Meta : 10 requêtes par numéro sur 72 heures, toutes étapes confondues. Aucune méthode n'est donc
 * rejouée automatiquement : un retry grillerait le quota, et un numéro bloqué attend 72 h.
 */
export class MetaPhoneRegisterClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v25.0',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  private async post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const json = (await appelGraph(this.fetchImpl, this.token, `${this.baseUrl}/${this.version}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })) as Record<string, unknown> | null;
    return json ?? {};
  }

  /**
   * `POST /{waba_id}/phone_numbers`. `cc` est l'indicatif pays, séparé du numéro national (Meta les veut
   * distincts) ; `verifiedName` le nom d'affichage soumis à revue. Rend le `phone_number_id`.
   */
  async addPhoneNumber(wabaId: string, cc: string, phoneNumber: string, verifiedName: string): Promise<string> {
    const json = await this.post(`${encodeURIComponent(wabaId)}/phone_numbers`, { cc, phone_number: phoneNumber, verified_name: verifiedName });
    const id = json.id;
    if (typeof id !== 'string' || id === '') throw new MetaApiError(200, null);
    return id;
  }

  /**
   * `POST /{phone_number_id}/request_code`. VOICE par défaut : Meta déconseille le SMS sur un numéro VoIP, et les
   * numéros du pool sont en voix seule ; le SMS reste offert au client, seul à savoir si son numéro est VoIP.
   * `language` est forcé (« fr ») sans quoi Meta dicte le code dans une autre langue, mal transcrite.
   */
  async requestCode(phoneNumberId: string, opts: { methode?: 'VOICE' | 'SMS'; language?: string } = {}): Promise<void> {
    await this.post(`${encodeURIComponent(phoneNumberId)}/request_code`, {
      code_method: opts.methode ?? 'VOICE',
      language: opts.language ?? 'fr',
    });
  }

  /**
   * `POST /{phone_number_id}/verify_code`, avec le code capté par la transcription. Après lui, le numéro est
   * vérifié mais pas activé : il ne peut rien envoyer tant que `MetaEmbeddedSignupClient.register` n'a pas posé le PIN.
   */
  async verifyCode(phoneNumberId: string, code: string): Promise<void> {
    await this.post(`${encodeURIComponent(phoneNumberId)}/verify_code`, { code });
  }
}
