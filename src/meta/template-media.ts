import type { OutboundCarouselCard } from './template-components';
import { texteDe } from '../lib/erreur';
import { genreParAdresse, typeFichier, verifierVideo } from '../medias/fichier';

/**
 * Prépare les visuels d'un template pour l'envoi : chaque image lue chez Meta est re-téléversée sur le numéro
 * d'envoi, et c'est son `media id` qui part (cartes de carousel et en-tête média d'un template simple).
 *
 * Envoyer l'URL du CDN de Meta (`link`) est accepté par l'API puis échoue en `131053` quelques secondes plus
 * tard : le téléchargeur de Meta prend un 403 sur son propre CDN, alors que l'URL est lisible partout ailleurs.
 * Un seul exemplaire de cette logique, instancié par le worker et par l'API (Inbox).
 */
export interface TemplateMediaDeps {
  /** Numéro d'envoi du tenant : un `media id` est scopé au numéro qui l'a téléversé. */
  getPhoneNumberId(tenantId: string): Promise<string | null>;
  /** Client d'upload résolu par tenant (token du tenant). */
  mediaClientFor(tenantId: string): Promise<{ uploadForSend(phoneNumberId: string, bytes: Buffer, mime: string): Promise<string> }>;
  /**
   * Le fichier de la médiathèque de CET espace derrière un code (`/m/<code>.<ext>`), ou null : un code d'un autre espace
   * n'est jamais lu ici (spec médias, § 3.2). Les vidéos et les PDF ne sont pas servis publiquement : c'est le seul
   * chemin par lequel ils partent.
   */
  lireFichier(tenantId: string, code: string): Promise<{ bytes: Buffer; mime: string; nom: string | null } | null>;
  /**
   * Le téléchargement GARDÉ d'une adresse saisie par un client (`telechargerEnteteProduction`, `src/api/entete-par-url.ts` :
   * `fetchPublic`, `resolutionPublique`, sans redirection, lecture bornée au plafond du format). Un refus est une réponse.
   */
  telecharger(format: 'IMAGE' | 'VIDEO' | 'DOCUMENT', url: string): Promise<{ octets: Buffer; mime: string } | { refus: string }>;
  /** Téléchargement du visuel chez Meta. Injecté par les tests ; défaut : `fetch` global. */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Horloge (tests du cache). Défaut : Date.now. */
  now?: () => number;
}

/** Un media id vit 30 jours côté Meta : on le garde 7, large marge, et jamais au-delà d'un redémarrage. */
const MEDIA_CACHE_MS = 7 * 86_400_000;

/** Le fichier d'un bloc prêt pour l'envoi : son identifiant chez Meta, la forme de l'en-tête, et le nom d'un document. */
export interface FichierPrepare {
  mediaId: string;
  type: 'image' | 'video' | 'document';
  nom: string | null;
}

/** Le chemin d'une adresse de la médiathèque, quel que soit son nom d'hôte (`api.`, `mba.`, anciens noms) : le code. */
const CHEMIN_MEDIATHEQUE = /^\/m\/([0-9a-hjkmnp-tv-z]{26})\.[a-z0-9]+$/i;
function codeDeMediatheque(url: string): string | null {
  try {
    const m = CHEMIN_MEDIATHEQUE.exec(new URL(url).pathname);
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Une adresse du CDN de Meta, la seule que le visuel d'un modèle lu CHEZ META peut porter : elle garde le `fetch`
 * direct d'avant. 🔴 Chez 360dialog, le visuel d'un modèle est une URL publique quelconque, posée par qui a créé le
 * modèle (un autre logiciel sur le numéro, mesuré le 2026-10-15) : elle passe par le téléchargement GARDÉ.
 */
export function estCdnDeMeta(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'lookaside.fbsbx.com' || h.endsWith('.whatsapp.net') || h.endsWith('.fbcdn.net');
  } catch {
    return false;
  }
}

/** La forme d'en-tête que WhatsApp accepte pour un type de fichier, ou null (refus). */
function typeEnTete(mime: string): FichierPrepare['type'] | null {
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif') return 'image';
  if (mime === 'video/mp4') return 'video';
  if (mime === 'application/pdf') return 'document';
  return null;
}

export class TemplateMediaPreparer {
  /**
   * Cache par chemin d'image (l'URL porte une signature qui change à chaque lecture du template) : sans lui, une
   * campagne re-téléverserait le même visuel pour chaque destinataire.
   */
  private readonly cache = new Map<string, { at: number; id: string }>();

  constructor(private readonly deps: TemplateMediaDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Téléverse (ou relit du cache) un visuel pour un numéro d'envoi déjà résolu. La clé de cache porte le numéro :
   * un `media id` est scopé au numéro qui l'a téléversé, et un numéro remplacé réutiliserait sinon un identifiant
   * inutilisable.
   */
  private async televerse(tenantId: string, pn: string, mediaUrl: string): Promise<string | null> {
    // Le chemin seul pour le CDN de Meta, dont la query n'est qu'une signature ; l'URL ENTIÈRE ailleurs (modèle
    // 360dialog), où la query peut être ce qui distingue deux images.
    const cle = `${pn}|${estCdnDeMeta(mediaUrl) ? mediaUrl.split('?')[0]! : mediaUrl}`;
    const hit = this.cache.get(cle);
    if (hit && this.now() - hit.at < MEDIA_CACHE_MS) return hit.id;
    const get = this.deps.fetchImpl ?? ((url: string) => fetch(url));
    try {
      const media = await this.deps.mediaClientFor(tenantId);
      const { bytes, mime } = await this.lireVisuel(tenantId, mediaUrl, get);
      const id = await media.uploadForSend(pn, bytes, mime);
      this.cache.set(cle, { at: this.now(), id });
      return id;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("média de template : visuel non préparé pour l'envoi:", texteDe(err));
      return null;
    }
  }

  /**
   * Les octets d'un visuel de modèle : le CDN de Meta comme avant ; une adresse de NOTRE médiathèque, lue par (espace,
   * code) ; toute autre adresse par le téléchargement gardé, le type tranché sur les octets. Lève en cas d'échec.
   */
  private async lireVisuel(tenantId: string, url: string, get: (url: string) => Promise<Response>): Promise<{ bytes: Buffer; mime: string }> {
    if (estCdnDeMeta(url)) {
      const res = await get(url);
      if (!res.ok) throw new Error(`téléchargement du visuel: HTTP ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'image/jpeg' };
    }
    const code = codeDeMediatheque(url);
    const local = code ? await this.deps.lireFichier(tenantId, code) : null;
    if (local) return { bytes: local.bytes, mime: local.mime };
    const genre = genreParAdresse(url);
    const telecharge = await this.deps.telecharger(genre === 'video' ? 'VIDEO' : genre === 'document' ? 'DOCUMENT' : 'IMAGE', url);
    if ('refus' in telecharge) throw new Error(`téléchargement du visuel : ${telecharge.refus}`);
    const mime = typeFichier(telecharge.octets);
    if (!mime || typeEnTete(mime) === null) throw new Error(`type de visuel non accepté par WhatsApp : ${mime ?? 'inconnu'}`);
    return { bytes: telecharge.octets, mime };
  }

  /**
   * Une URL de visuel -> son `media id`, ou null si la préparation a échoué. Ne lève jamais : l'appelant refuse
   * l'envoi en nommant ce qui manque, plutôt que de laisser partir un message que Meta accepterait sans le livrer.
   * Point d'entrée commun aux cartes et à l'en-tête : un même visuel sur un même numéro ne se téléverse qu'une fois.
   */
  async prepareOne(tenantId: string, mediaUrl: string): Promise<string | null> {
    if (mediaUrl === '') return null;
    const pn = await this.deps.getPhoneNumberId(tenantId);
    if (!pn) {
      // eslint-disable-next-line no-console
      console.error('média de template : aucun numéro d’envoi pour le tenant, visuel non préparé');
      return null;
    }
    return this.televerse(tenantId, pn, mediaUrl);
  }

  /** Cache du fichier d'un bloc : même clé que les visuels (numéro et chemin), le type et le nom en plus. */
  private readonly fichiers = new Map<string, { at: number } & FichierPrepare>();

  /**
   * Le fichier d'un bloc « message rapide » prêt pour l'envoi, ou null (le bloc refuse alors en le nommant). Une adresse
   * de la médiathèque se lit DIRECTEMENT par (espace, code), sans passer par HTTP : vidéos et PDF n'ont pas d'adresse
   * publique, et une image y gagne un aller-retour par Cloudflare. Faute de fiche dans cet espace, ou pour une adresse
   * étrangère, 🔴 l'adresse est saisie par le client : elle passe par le téléchargement GARDÉ (`telecharger`, https, adresse
   * publique vérifiée à la connexion, sans redirection, lecture bornée), jamais par un `fetch` nu, et le type se tranche
   * sur les octets, une vidéo lue comme au dépôt. Une image publique d'un autre espace marche comme avant. Ne lève jamais.
   * La clé du cache porte l'ESPACE : un numéro rattaché à un autre espace ne réutilise pas un identifiant qui n'est pas
   * le sien.
   */
  async prepareFichier(tenantId: string, url: string): Promise<FichierPrepare | null> {
    if (url === '') return null;
    const pn = await this.deps.getPhoneNumberId(tenantId);
    if (!pn) {
      // eslint-disable-next-line no-console
      console.error('fichier du bloc : aucun numéro d’envoi pour le tenant, fichier non préparé');
      return null;
    }
    const cle = `${tenantId}|${pn}|${url.split('?')[0]!}`;
    const hit = this.fichiers.get(cle);
    if (hit && this.now() - hit.at < MEDIA_CACHE_MS) return { mediaId: hit.mediaId, type: hit.type, nom: hit.nom };
    try {
      const code = codeDeMediatheque(url);
      const local = code ? await this.deps.lireFichier(tenantId, code) : null;
      let lu: { bytes: Buffer; mime: string; nom: string | null };
      if (local) {
        // Le type d'une fiche est celui lu à son dépôt, sur ses octets, et une vidéo y a déjà été lue.
        lu = local;
      } else {
        const genre = genreParAdresse(url);
        const telecharge = await this.deps.telecharger(genre === 'video' ? 'VIDEO' : genre === 'document' ? 'DOCUMENT' : 'IMAGE', url);
        if ('refus' in telecharge) throw new Error(`téléchargement du fichier : ${telecharge.refus}`);
        const mime = typeFichier(telecharge.octets);
        if (mime === 'video/mp4') {
          const raison = verifierVideo(telecharge.octets);
          if (raison) throw new Error(raison);
        }
        lu = { bytes: telecharge.octets, mime: mime ?? '', nom: null };
      }
      const type = typeEnTete(lu.mime);
      if (!type) throw new Error(`type de fichier non accepté par WhatsApp : ${lu.mime || 'inconnu'}`);
      const media = await this.deps.mediaClientFor(tenantId);
      const mediaId = await media.uploadForSend(pn, lu.bytes, lu.mime);
      const pret: FichierPrepare = { mediaId, type, nom: lu.nom };
      this.fichiers.set(cle, { at: this.now(), ...pret });
      return pret;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("fichier du bloc : non préparé pour l'envoi:", texteDe(err));
      return null;
    }
  }

  /**
   * Rend les cartes prêtes à l'envoi. Une carte dont le visuel n'a pas pu être préparé revient sans `mediaId` :
   * `carouselSendBlocker` refuse alors l'envoi en la nommant. Le numéro d'envoi est résolu une fois pour toutes.
   */
  async prepare(tenantId: string, cards: OutboundCarouselCard[]): Promise<OutboundCarouselCard[]> {
    const pn = await this.deps.getPhoneNumberId(tenantId);
    if (!pn) {
      // eslint-disable-next-line no-console
      console.error('carousel: aucun numéro d’envoi pour le tenant, visuels non préparés');
      return cards;
    }
    return Promise.all(cards.map(async (card) => {
      if (!card.mediaUrl) {
        // eslint-disable-next-line no-console
        console.error('carousel: carte sans URL de visuel lisible chez Meta (handle non exploitable)');
        return card;
      }
      const id = await this.televerse(tenantId, pn, card.mediaUrl);
      return id ? { ...card, mediaId: id } : card;
    }));
  }
}
