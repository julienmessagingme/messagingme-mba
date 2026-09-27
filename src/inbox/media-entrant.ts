import { MetaApiError } from '../meta/errors';

/**
 * Les pièces jointes reçues (photo, document, vidéo, sticker, vocal) : combien de temps on peut les lire, et
 * comment on les sert au navigateur. Règles pures ; la lecture d'un fichier reçoit ses dépendances.
 */

/**
 * Sept jours : Meta ne garde l'identifiant d'un média reçu par webhook que sept jours (« Media IDs in webhooks
 * expire after 7 days » ; trente jours ne vaut que pour les médias que nous téléversons). Aucune copie chez
 * nous : passé ce délai, l'écran dit « expiré ». Cette constante le décide, en SQL comme en code.
 */
export const DUREE_MEDIA_RECU_JOURS = 7;

/**
 * Le message a-t-il dépassé le délai de Meta ? Fragment SQL, `m` = alias de `conversation_messages`. Dérivé
 * de la constante, pour que l'écran et la route qui sert le fichier ne divergent pas.
 */
export const MEDIA_EXPIRE_SQL = `(m.created_at < now() - make_interval(days => ${DUREE_MEDIA_RECU_JOURS}))`;

/** Le fichier n'existe plus chez Meta. Distinct d'une panne : rien n'est cassé, il est trop tard. */
export class MediaExpire extends Error {
  constructor() {
    super(`ce fichier n'est plus disponible chez WhatsApp (conservation de ${DUREE_MEDIA_RECU_JOURS} jours)`);
    this.name = 'MediaExpire';
  }
}

/**
 * Cette erreur de Meta dit-elle que le média a expiré ? `100 / 33` (« object does not exist ») : un média reçu
 * sur notre propre numéro n'a pas d'autre raison d'être introuvable que son âge. Le prendre pour une panne
 * ferait dire « réessayez » sur un fichier qui ne reviendra jamais.
 */
export function estMediaExpireChezMeta(err: unknown): boolean {
  return err instanceof MetaApiError && err.code === 100 && err.subcode === 33;
}

/**
 * 🔴 Les seuls types que le navigateur peut afficher, tout le reste se télécharge. Frontière de sécurité : un
 * document reçu porte le type annoncé par son expéditeur, et un `text/html` ou un `image/svg+xml` rendu dans
 * l'origine de la console y exécuterait son script (donc lirait la session). Le SVG n'y est pas pour ça.
 */
export const MIMES_AFFICHABLES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Le type sans ses paramètres (`audio/ogg; codecs=opus` -> `audio/ogg`), en minuscules. */
export function typeNu(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const t = mime.split(';')[0]!.trim().toLowerCase();
  return t === '' ? null : t;
}

/**
 * Le nom sous lequel le navigateur enregistre le fichier. Il vient de l'expéditeur : guillemets, barres,
 * retours à la ligne et caractères de contrôle sont retirés (injection d'en-tête ou de chemin). Vide -> un nom
 * neutre.
 */
export function nomDeFichierSur(nom: string | null | undefined, repli: string): string {
  // eslint-disable-next-line no-control-regex
  const propre = (nom ?? '').replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 150);
  return propre === '' ? repli : propre;
}

/**
 * Les en-têtes d'un fichier reçu servi au navigateur : `inline` pour une image affichable, `attachment` pour
 * tout le reste. `nosniff` toujours, sinon le navigateur pourrait deviner du HTML dans une « image ».
 */
export function enTetesMedia(mime: string | null, nom: string | null, repli: string): Record<string, string> {
  const t = typeNu(mime);
  const affichable = t !== null && MIMES_AFFICHABLES.has(t);
  const fichier = nomDeFichierSur(nom, repli);
  // `filename` en ASCII pour les vieux clients, `filename*` en UTF-8 pour les accents (RFC 6266 / 5987).
  const ascii = fichier.replace(/[^\x20-\x7e]/g, '_');
  return {
    'content-type': affichable ? t! : (t ?? 'application/octet-stream'),
    'content-disposition': `${affichable ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fichier)}`,
    'x-content-type-options': 'nosniff',
    // Ces octets sont ceux d'un client : rien à faire dans un cache partagé.
    'cache-control': 'private, no-store',
  };
}

/** Ce que la lecture d'un média reçu a besoin de savoir du message, relu dans son espace. */
export interface MessageAvecMedia {
  mediaId: string | null;
  mediaMime: string | null;
  mediaNom: string | null;
  mediaExpire: boolean;
}

export interface DepsLireMediaRecu {
  /** 🔴 Le message, relu dans l'espace appelant : c'est là que se joue l'isolation entre clients. */
  lireMessage(tenantId: string, messageId: string, conversationId?: string): Promise<MessageAvecMedia | null>;
  telecharger(mediaId: string, tailleMaxOctets: number): Promise<{ bytes: Buffer; mime: string | null }>;
  tailleMaxOctets: number;
}

/**
 * Lit le fichier d'un média reçu, pour le servir à la console. Ne dépend que du jeton Meta, pas de la
 * transcription. `null` = aucun média. `MediaExpire` = trop tard, lu d'avance sur l'âge du message (on
 * n'appelle pas Meta pour un échec certain) ou appris de Meta (`100/33`).
 */
export async function lireMediaRecu(
  deps: DepsLireMediaRecu,
  tenantId: string,
  messageId: string,
  conversationId?: string,
): Promise<{ bytes: Buffer; mime: string | null; nom: string | null } | null> {
  const msg = await deps.lireMessage(tenantId, messageId, conversationId);
  if (!msg?.mediaId) return null;
  if (msg.mediaExpire) throw new MediaExpire();
  const f = await deps.telecharger(msg.mediaId, deps.tailleMaxOctets).catch((err: unknown) => {
    throw estMediaExpireChezMeta(err) ? new MediaExpire() : err;
  });
  // Le mime du message d'abord : c'est celui que WhatsApp a annoncé, et Meta ne le rend pas toujours.
  return { bytes: f.bytes, mime: msg.mediaMime ?? f.mime, nom: msg.mediaNom };
}
