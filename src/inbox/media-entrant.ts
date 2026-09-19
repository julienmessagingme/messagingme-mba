import { MetaApiError } from '../meta/errors';

/**
 * LES PIÈCES JOINTES REÇUES (photo, document, vidéo, sticker, vocal) : combien de temps on peut les lire, et
 * comment on les sert au navigateur (2026-09-19, demande de Julien : « dans les conversations on doit pouvoir
 * recevoir des photos... voire des fichiers »).
 *
 * Aucune IO propre : les règles sont pures, et la lecture d'un fichier (`lireMediaRecu`) reçoit ses
 * dépendances, comme `transcrireMessage`. Tout se teste sans réseau ni base.
 */

/**
 * 🔴 SEPT JOURS, ET PAS TRENTE. Meta ne garde l'identifiant d'un média REÇU par webhook que sept jours
 * (« Media IDs in webhooks expire after 7 days », doc de référence de l'API Cloud) ; les trente jours
 * qu'affirmait ce dépôt valent pour les médias que NOUS téléversons. MESURÉ le 2026-09-19 depuis le conteneur
 * de production : les deux seuls vocaux enregistrés, reçus 7,9 et 8,9 jours plus tôt, rendaient
 * `100 / 33` (« object does not exist »).
 *
 * ⚠️ AUCUNE COPIE CHEZ NOUS, arbitrage de Julien du même jour : passé ce délai, l'écran dit « expiré » au
 * lieu de proposer un fichier qui n'existe plus. C'est cette constante qui le décide, en SQL comme en code.
 */
export const DUREE_MEDIA_RECU_JOURS = 7;

/**
 * Le message a-t-il dépassé le délai de Meta ? Fragment SQL, `m` = alias de `conversation_messages`.
 *
 * ⚠️ DÉRIVÉ DE LA CONSTANTE, jamais réécrit : l'écran (`getMessages`) et la route qui sert le fichier la
 * lisent tous les deux, et deux délais écrits à deux endroits finiraient par annoncer « expiré » d'un côté
 * pendant que l'autre va encore chercher le fichier chez Meta.
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
 * Cette erreur de Meta dit-elle que le média a expiré ?
 *
 * `100 / 33` est la réponse MESURÉE sur nos deux vocaux périmés. Elle signifie aussi, en général, « pas le
 * droit de lire cet objet », mais un média qu'on a REÇU sur notre propre numéro n'a pas d'autre raison d'être
 * introuvable que son âge. Prendre ce refus pour une panne ferait dire « réessayez » sur un fichier qui ne
 * reviendra jamais.
 */
export function estMediaExpireChezMeta(err: unknown): boolean {
  return err instanceof MetaApiError && err.code === 100 && err.subcode === 33;
}

/**
 * Les SEULS types qu'on laisse le navigateur AFFICHER. Tout le reste se TÉLÉCHARGE.
 *
 * 🔴 C'EST UNE FRONTIÈRE DE SÉCURITÉ, PAS UN CHOIX DE PRÉSENTATION. Un document reçu porte le type que son
 * EXPÉDITEUR a annoncé. Un `text/html` ou un `image/svg+xml` rendu tel quel dans l'origine de la console y
 * exécuterait son script, donc lirait la session de l'opérateur. Les images matricielles, elles, ne
 * s'exécutent jamais. Le SVG n'est PAS dans la liste, précisément parce qu'il est une image qui peut porter
 * du script.
 */
export const MIMES_AFFICHABLES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Le type sans ses paramètres (`audio/ogg; codecs=opus` -> `audio/ogg`), en minuscules. */
export function typeNu(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const t = mime.split(';')[0]!.trim().toLowerCase();
  return t === '' ? null : t;
}

/**
 * Le nom sous lequel le navigateur enregistre le fichier, sans rien qui puisse casser l'en-tête.
 *
 * ⚠️ Le nom vient de l'expéditeur : on retire les guillemets, les barres, les retours à la ligne et tout
 * caractère de contrôle, qui permettraient d'injecter un second en-tête ou un chemin. Vide après nettoyage ->
 * un nom neutre, jamais un en-tête sans nom.
 */
export function nomDeFichierSur(nom: string | null | undefined, repli: string): string {
  // eslint-disable-next-line no-control-regex
  const propre = (nom ?? '').replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 150);
  return propre === '' ? repli : propre;
}

/**
 * Les en-têtes d'un fichier reçu servi au navigateur.
 *
 * `inline` pour une image affichable, `attachment` pour TOUT le reste. `nosniff` dans les deux cas : sans lui,
 * un navigateur peut « deviner » qu'un fichier annoncé comme image est du HTML et le rendre comme tel, ce qui
 * rouvrirait par la bande la porte que la liste ci-dessus ferme.
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

/** Ce que la lecture d'un média reçu a besoin de savoir du message, relu DANS son espace. */
export interface MessageAvecMedia {
  mediaId: string | null;
  mediaMime: string | null;
  mediaNom: string | null;
  mediaExpire: boolean;
}

export interface DepsLireMediaRecu {
  /** Le message, relu dans l'espace appelant : c'est là que se joue l'isolation entre clients. */
  lireMessage(tenantId: string, messageId: string, conversationId?: string): Promise<MessageAvecMedia | null>;
  telecharger(mediaId: string, tailleMaxOctets: number): Promise<{ bytes: Buffer; mime: string | null }>;
  tailleMaxOctets: number;
}

/**
 * LIT le fichier d'un média reçu, pour le servir à la console.
 *
 * 🔴 SORTIE DU CÂBLAGE LE 2026-09-19, SUR REVUE. Elle vivait en ligne dans `src/index.ts`, et deux défauts
 * s'y cachaient : aucun test ne la voyait (on pouvait retirer la conversion de l'erreur de Meta sans que rien
 * ne tombe), et elle n'était câblée que si la TRANSCRIPTION l'était. Une instance sans modèle de transcription
 * aurait répondu 503 sur chaque photo, alors que lire un fichier n'a besoin que du jeton Meta.
 *
 * `null` = ce message ne porte aucun média. `MediaExpire` = trop tard, lu d'avance sur l'âge du message
 * (on n'appelle pas Meta pour un échec certain) ou appris de Meta (`100/33`, effacé plus tôt que prévu).
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
  // Le mime du MESSAGE d'abord : c'est celui que WhatsApp a annoncé, et Meta ne le rend pas toujours.
  return { bytes: f.bytes, mime: msg.mediaMime ?? f.mime, nom: msg.mediaNom };
}
