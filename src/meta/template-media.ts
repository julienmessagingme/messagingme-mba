import type { OutboundCarouselCard } from './template-components';

/**
 * Prépare les visuels d'un template POUR L'ENVOI : chaque image lue chez Meta est re-téléversée sur le numéro
 * d'envoi, et c'est son `media id` qui part. Sert aux cartes d'un carousel ET à l'en-tête média d'un template
 * simple, qui ont exactement le même besoin.
 *
 * Pourquoi ce détour, mesuré en live le 2026-08-15 : envoyer l'URL du CDN de Meta (`link`) est ACCEPTÉ par
 * l'API (200 + id de message) puis échoue 2 s plus tard en `131053`, parce que le téléchargeur de Meta se
 * prend un 403 sur son propre CDN. L'URL est pourtant publiquement lisible depuis n'importe où ailleurs :
 * c'est ce qui rendait le bug invisible à une sonde qui se contente de lire l'URL.
 *
 * Extrait du worker parce que l'INBOX en a besoin aussi (envoi à la main dans une conversation). Un second
 * exemplaire de cette logique est exactement ce qui avait laissé le carousel non branché côté campagne : il
 * n'y en a qu'un, et les deux processus l'instancient.
 */
export interface TemplateMediaDeps {
  /** Numéro d'envoi du tenant : un `media id` est scopé au numéro qui l'a téléversé. */
  getPhoneNumberId(tenantId: string): Promise<string | null>;
  /** Client d'upload résolu PAR TENANT (token du tenant). */
  mediaClientFor(tenantId: string): Promise<{ uploadForSend(phoneNumberId: string, bytes: Buffer, mime: string): Promise<string> }>;
  /** Téléchargement du visuel chez Meta. Injecté par les tests ; défaut : `fetch` global. */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Horloge (tests du cache). Défaut : Date.now. */
  now?: () => number;
}

/** Un media id vit 30 jours côté Meta : on le garde 7, large marge, et jamais au-delà d'un redémarrage. */
const MEDIA_CACHE_MS = 7 * 86_400_000;

export class TemplateMediaPreparer {
  /** Cache par CHEMIN d'image (l'URL porte une signature qui change à chaque lecture du template). Sans lui,
   *  une campagne de 5 000 destinataires re-téléverserait 5 000 fois le même visuel. */
  private readonly cache = new Map<string, { at: number; id: string }>();

  constructor(private readonly deps: TemplateMediaDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Téléverse (ou relit du cache) UN visuel pour un numéro d'envoi DÉJÀ résolu.
   *
   * ⚠️ La clé de cache porte le NUMÉRO, pas seulement l'URL : un `media id` est scopé au numéro qui l'a
   * téléversé. Sans lui, un numéro reconnecté ou remplacé dans les 7 jours réutiliserait un identifiant
   * téléversé sur l'ancien, et l'envoi échouerait sans qu'on comprenne pourquoi.
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
      console.error("média de template : visuel non préparé pour l'envoi:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * UNE URL de visuel -> son `media id`, ou null si la préparation a échoué (numéro d'envoi absent,
   * téléchargement refusé, téléversement en erreur). Jamais de throw : l'appelant refuse l'envoi en nommant ce
   * qui manque, plutôt que de laisser partir un message que Meta accepterait puis ne livrerait pas.
   *
   * Point d'entrée COMMUN aux cartes de carousel et à l'en-tête média : un même visuel servant aux deux, sur le
   * même numéro, ne se téléverse qu'une fois.
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
   * Rend les cartes prêtes à l'envoi. Une carte dont le visuel n'a pas pu être préparé revient SANS `mediaId` :
   * c'est `carouselSendBlocker` qui refuse alors l'envoi en la nommant, plutôt que de laisser partir un
   * message que Meta accepterait puis ne livrerait pas.
   *
   * Le numéro d'envoi est résolu UNE fois pour toutes les cartes, pas une fois par carte.
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
