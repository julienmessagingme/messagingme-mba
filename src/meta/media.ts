import { MetaApiError } from './errors';
import type { MetaErrorBody } from './errors';
import type { FetchLike } from './templates';

/** Média refusé par l'upload (réponse sans handle). */
export class MediaUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUploadError';
  }
}

/**
 * Upload d'image via la Resumable Upload API (2 appels), pour obtenir un `header_handle` de carte
 * carousel. Vérifié live : start `POST /{appId}/uploads?file_length&file_type` -> {id} ; puis
 * `POST /{session}` (Authorization: OAuth, file_offset:0, body=bytes) -> {h}. `fetchImpl` injectable.
 */
export class MetaMediaClient {
  constructor(
    private readonly token: string,
    private readonly appId: string,
    private readonly version = 'v23.0',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  /**
   * Téléverse des octets sur le NUMÉRO d'envoi et rend un `media id` utilisable comme paramètre d'envoi
   * (`image: { id }`). Endpoint DIFFÉRENT de `uploadImage` : celui-ci sert à la CRÉATION de template (handle
   * de resumable upload), celui-là à l'ENVOI.
   *
   * Pourquoi c'est nécessaire, mesuré en live le 2026-08-15 : les URL d'image que Meta renvoie pour les cartes
   * d'un carousel (`example.header_handle[0]`) sont publiquement téléchargeables depuis n'importe où SAUF
   * depuis le téléchargeur de Meta lui-même, qui reçoit un 403 de son propre CDN. L'envoi est alors ACCEPTÉ
   * (200 + id de message) puis échoue en asynchrone, 2 s plus tard, en `131053 Media upload error`. Re-téléverser
   * l'image et envoyer son `id` est la seule voie qui se LIVRE réellement (vérifié : statut `delivered`).
   *
   * `retries` : un upload sur dix échoue en `131000 Something went wrong` (transitoire, vu en sonde).
   */
  async uploadForSend(phoneNumberId: string, bytes: Buffer, mime: string, retries = 3): Promise<string> {
    let dernier: unknown = null;
    for (let essai = 0; essai <= retries; essai += 1) {
      if (essai > 0) await new Promise((r) => setTimeout(r, 800 * essai));
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'media');
      const res = await this.fetchImpl(`${this.baseUrl}/${this.version}/${phoneNumberId}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
        body: form,
      } as RequestInit);
      const j = (await res.json().catch(() => null)) as { id?: string; error?: MetaErrorBody } | null;
      if (res.ok && j?.id) return j.id;
      dernier = j?.error ?? { message: `HTTP ${res.status}` };
    }
    throw new MediaUploadError(`upload d'envoi refusé après ${retries + 1} tentatives : ${JSON.stringify(dernier)}`);
  }

  async uploadImage(bytes: Buffer, mime: string): Promise<string> {
    // 1) Ouvrir la session d'upload (le token en query est exigé par cet endpoint).
    const startUrl = `${this.baseUrl}/${this.version}/${this.appId}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}&access_token=${this.token}`;
    const start = await this.fetchImpl(startUrl, { method: 'POST' });
    const sj = (await start.json().catch(() => null)) as { id?: string; error?: MetaErrorBody } | null;
    if (!start.ok) throw new MetaApiError(start.status, sj?.error ?? null);
    const sessionId = sj?.id;
    if (!sessionId) throw new MediaUploadError('pas de session d\'upload renvoyée');

    // 2) Envoyer les octets ; renvoie le handle `h`.
    const up = await this.fetchImpl(`${this.baseUrl}/${this.version}/${sessionId}`, {
      method: 'POST',
      headers: { authorization: `OAuth ${this.token}`, file_offset: '0' },
      body: new Uint8Array(bytes),
    });
    const uj = (await up.json().catch(() => null)) as { h?: string; error?: MetaErrorBody } | null;
    if (!up.ok) throw new MetaApiError(up.status, uj?.error ?? null);
    if (!uj?.h) throw new MediaUploadError('upload sans handle');
    return uj.h;
  }
}
