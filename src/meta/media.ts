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
