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

  /**
   * TÉLÉCHARGE un média entrant, en DEUX appels (2026-09-09).
   *
   * 🔴 POURQUOI DEUX, ET POURQUOI ON NE PEUT PAS MÉMORISER LE RÉSULTAT DU PREMIER. Meta ne donne pas d'URL
   * stable : `GET /{media-id}` rend une URL de téléchargement à DURÉE DE VIE COURTE (quelques minutes), qu'il
   * faut ensuite chercher AVEC le jeton, ce qu'aucun navigateur ne fera pour nous. Mettre cette URL en cache
   * ou la donner au front produirait des 401 quelques minutes plus tard, de façon intermittente, donc
   * difficile à relier à sa cause. L'identifiant, lui, reste valable tant que Meta garde le fichier : SEPT jours
   * pour un média reçu, et non trente comme ce commentaire l'a dit (`DUREE_MEDIA_RECU_JOURS`, mesuré le 2026-09-19).
   *
   * ⚠️ LE SECOND APPEL PORTE LE JETON LUI AUSSI. L'URL rendue est sur `lookaside.fb.com` et ne s'ouvre pas
   * sans en-tête d'autorisation : la tester dans un navigateur donne un 403 et fait croire à une URL morte.
   *
   * ⚠️ PLAFOND DE TAILLE OBLIGATOIRE. Un vocal WhatsApp monte à 16 Mo, et ce corps entre en MÉMOIRE avant
   * d'être transcrit (l'API de transcription veut du base64, qui pèse un tiers de plus). Sans borne, un
   * fichier inattendu ferait grossir le processus au lieu d'échouer proprement : on refuse au-delà, en le
   * disant.
   */
  async telechargerEntrant(mediaId: string, tailleMaxOctets: number): Promise<{ bytes: Buffer; mime: string | null }> {
    const meta = await this.fetchImpl(`${this.baseUrl}/${this.version}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    const mj = (await meta.json().catch(() => null)) as { url?: string; mime_type?: string; file_size?: number; error?: MetaErrorBody } | null;
    if (!meta.ok) throw new MetaApiError(meta.status, mj?.error ?? null);
    if (!mj?.url) throw new MediaUploadError('media sans url de telechargement');
    // La taille annoncée AVANT de télécharger : refuser ici évite de tirer 16 Mo pour les jeter ensuite.
    if (typeof mj.file_size === 'number' && mj.file_size > tailleMaxOctets) {
      throw new MediaTropGros(mj.file_size, tailleMaxOctets);
    }
    const bin = await this.fetchImpl(mj.url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!bin.ok) throw new MetaApiError(bin.status, null);
    const buf = Buffer.from(await bin.arrayBuffer());
    // Second contrôle sur ce qui est RÉELLEMENT arrivé : `file_size` peut manquer, et un en-tête ne fait pas
    // un fichier. Sans ce test, l'absence du champ suffirait à contourner le plafond.
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
