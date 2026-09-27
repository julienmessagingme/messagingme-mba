import type { OutboundCarouselCard } from './template-components';
import { texteDe } from '../lib/erreur';

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
  /** Téléchargement du visuel chez Meta. Injecté par les tests ; défaut : `fetch` global. */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Horloge (tests du cache). Défaut : Date.now. */
  now?: () => number;
}

/** Un media id vit 30 jours côté Meta : on le garde 7, large marge, et jamais au-delà d'un redémarrage. */
const MEDIA_CACHE_MS = 7 * 86_400_000;

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
    const cle = `${pn}|${mediaUrl.split('?')[0]!}`;
    const hit = this.cache.get(cle);
    if (hit && this.now() - hit.at < MEDIA_CACHE_MS) return hit.id;
    const get = this.deps.fetchImpl ?? ((url: string) => fetch(url));
    try {
      const media = await this.deps.mediaClientFor(tenantId);
      const res = await get(mediaUrl);
      if (!res.ok) throw new Error(`téléchargement du visuel: HTTP ${res.status}`);
      const mime = res.headers.get('content-type') ?? 'image/jpeg';
      const bytes = Buffer.from(await res.arrayBuffer());
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
