import { setTimeout as dormir } from 'node:timers/promises';
import { MetaApiError } from './errors';
import type { MetaErrorBody } from './errors';
import type { FetchLike } from './templates';
import { appelGraph } from './graph';

/** Média refusé par l'upload (réponse sans handle). */
export class MediaUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUploadError';
  }
}

/**
 * Upload d'image via la Resumable Upload API, pour obtenir le `header_handle` d'une carte de carousel :
 * `POST /{appId}/uploads?file_length&file_type` -> {id}, puis `POST /{session}` (Authorization: OAuth,
 * file_offset: 0, corps = octets) -> {h}.
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
   * Téléverse des octets sur le numéro d'envoi et rend un `media id` pour l'envoi (`image: { id }`), là où
   * `uploadImage` sert à la création de template. Les URL d'image que Meta rend pour les cartes sont refusées
   * (403) par son propre téléchargeur : l'envoi est accepté puis échoue en `131053`. Seul l'envoi par `id` se livre.
   * `retries` : environ un upload sur dix échoue en `131000`, transitoire.
   */
  async uploadForSend(phoneNumberId: string, bytes: Buffer, mime: string, retries = 3): Promise<string> {
    let dernier: unknown = null;
    for (let essai = 0; essai <= retries; essai += 1) {
      if (essai > 0) await dormir(800 * essai);
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

  /**
   * Télécharge un média entrant, en deux appels. `GET /{media-id}` rend une URL à durée de vie courte, à chercher
   * avec le jeton : elle ne se met pas en cache et ne se donne pas au front (401 intermittents). L'identifiant, lui,
   * reste valable tant que Meta garde le fichier (`DUREE_MEDIA_RECU_JOURS`).
   *
   * Le second appel porte aussi le jeton : sans en-tête, l'URL (`lookaside.fb.com`) rend 403.
   * Plafond de taille obligatoire : le corps entre en mémoire avant transcription, donc on refuse au-delà.
   */
  async telechargerEntrant(mediaId: string, tailleMaxOctets: number): Promise<{ bytes: Buffer; mime: string | null }> {
    const mj = (await appelGraph(this.fetchImpl, this.token, `${this.baseUrl}/${this.version}/${encodeURIComponent(mediaId)}`)) as
      { url?: string; mime_type?: string; file_size?: number } | null;
    if (!mj?.url) throw new MediaUploadError('media sans url de telechargement');
    // La taille annoncée, avant de télécharger : refuser ici évite de tirer 16 Mo pour les jeter ensuite.
    if (typeof mj.file_size === 'number' && mj.file_size > tailleMaxOctets) {
      throw new MediaTropGros(mj.file_size, tailleMaxOctets);
    }
    const bin = await this.fetchImpl(mj.url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!bin.ok) throw new MetaApiError(bin.status, null);
    const buf = Buffer.from(await bin.arrayBuffer());
    // Second contrôle sur ce qui est réellement arrivé : sans lui, un `file_size` absent contournerait le plafond.
    if (buf.byteLength > tailleMaxOctets) throw new MediaTropGros(buf.byteLength, tailleMaxOctets);
    return { bytes: buf, mime: mj.mime_type ?? null };
  }
}

/** Le média dépasse ce qu'on accepte de charger en mémoire. Distinct d'une panne : rien n'est cassé. */
export class MediaTropGros extends Error {
  constructor(readonly octets: number, readonly plafond: number) {
    super(`media trop gros (${octets} octets, plafond ${plafond})`);
    this.name = 'MediaTropGros';
  }
}
