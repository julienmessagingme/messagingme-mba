import { setTimeout as dormir } from 'node:timers/promises';
import { MetaApiError } from './errors';
import type { MetaErrorBody } from './errors';
import type { FetchLike } from './templates';
import { HOTE_360DIALOG } from './client';
import { HTTP_TIMEOUT_DEFAUT_MS } from './http';
import { MediaTropGros, MediaUploadError } from './media';

/** L'hôte que rend `GET /{media_id}` chez 360dialog, et qui refuse la clé (401, mesuré le 2026-10-15). */
const HOTE_LOOKASIDE = 'https://lookaside.fbsbx.com';

/**
 * Les médias d'un numéro porté par 360dialog : les deux gestes de `MetaMediaClient` dont l'envoi et la lecture des
 * fichiers reçus ont besoin, avec la clé d'API du numéro. Mesuré le 2026-10-15 : `POST /media` rend un `id` ;
 * `GET /{id}` rend une URL `lookaside.fbsbx.com` qui ne s'ouvre qu'en la réécrivant sur `HOTE_360DIALOG`, avec la clé
 * (binaire identique à l'octet ; en direct, 401).
 */
export class Media360dialogClient {
  constructor(
    private readonly cle: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly delaiMs: number = HTTP_TIMEOUT_DEFAUT_MS,
  ) {}

  private appel(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      headers: { 'D360-API-KEY': this.cle, ...(init.headers as Record<string, string> | undefined ?? {}) },
      signal: AbortSignal.timeout(this.delaiMs),
      // `fetch` ne retire en changeant d'origine que `Authorization` : une redirection emporterait `D360-API-KEY`.
      redirect: 'error',
    });
  }

  /** Comme `MetaMediaClient.uploadForSend` : le numéro est désigné par la clé, `_phoneNumberId` n'est pas lu. */
  async uploadForSend(_phoneNumberId: string, bytes: Buffer, mime: string, retries = 3): Promise<string> {
    let dernier: unknown = null;
    for (let essai = 0; essai <= retries; essai += 1) {
      if (essai > 0) await dormir(800 * essai);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'media');
      const res = await this.appel(`${HOTE_360DIALOG}/media`, { method: 'POST', body: form });
      const j = (await res.json().catch(() => null)) as { id?: string; error?: MetaErrorBody } | null;
      if (res.ok && j?.id) return j.id;
      // Une clé refusée ne se rejoue pas : l'erreur remonte telle quelle, l'intercepteur de la fabrique la lit.
      if (res.status === 401) throw new MetaApiError(401, j?.error ?? null);
      dernier = j?.error ?? { message: `HTTP ${res.status}` };
    }
    throw new MediaUploadError(`upload d'envoi refusé par 360dialog après ${retries + 1} tentatives : ${JSON.stringify(dernier)}`);
  }

  /** Comme `MetaMediaClient.telechargerEntrant`, mêmes deux contrôles de taille. */
  async telechargerEntrant(mediaId: string, tailleMaxOctets: number): Promise<{ bytes: Buffer; mime: string | null }> {
    const info = await this.appel(`${HOTE_360DIALOG}/${encodeURIComponent(mediaId)}`);
    const mj = (await info.json().catch(() => null)) as { url?: string; mime_type?: string; file_size?: number; error?: MetaErrorBody } | null;
    if (!info.ok) throw new MetaApiError(info.status, mj?.error ?? null);
    if (!mj?.url) throw new MediaUploadError('media sans url de telechargement');
    if (typeof mj.file_size === 'number' && mj.file_size > tailleMaxOctets) throw new MediaTropGros(mj.file_size, tailleMaxOctets);
    // 🔴 Seul l'hôte de Meta est réécrit : une URL d'un autre hôte n'est jamais appelée avec la clé.
    if (!mj.url.startsWith(`${HOTE_LOOKASIDE}/`)) throw new MediaUploadError('url de media inattendue');
    const bin = await this.appel(HOTE_360DIALOG + mj.url.slice(HOTE_LOOKASIDE.length));
    if (!bin.ok) throw new MetaApiError(bin.status, null);
    const buf = Buffer.from(await bin.arrayBuffer());
    if (buf.byteLength > tailleMaxOctets) throw new MediaTropGros(buf.byteLength, tailleMaxOctets);
    return { bytes: buf, mime: mj.mime_type ?? null };
  }
}
