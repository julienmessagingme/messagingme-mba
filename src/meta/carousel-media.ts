import type { OutboundCarouselCard } from './template-components';

/**
 * Prépare les visuels des cartes d'un carousel POUR L'ENVOI : chaque image est re-téléversée sur le numéro
 * d'envoi et la carte repart avec son `media id`.
 *
 * Pourquoi ce détour, mesuré en live le 2026-08-15 : envoyer l'URL du CDN de Meta (`link`) est ACCEPTÉ par
 * l'API (200 + id de message) puis échoue 2 s plus tard en `131053`, parce que le téléchargeur de Meta se
 * prend un 403 sur son propre CDN. L'URL est pourtant publiquement lisible depuis n'importe où ailleurs :
 * c'est ce qui rendait le bug invisible à une sonde qui se contente de lire l'URL.
 *
 * Extrait du worker parce que l'INBOX en a besoin aussi (envoi d'un carousel à la main dans une conversation).
 * Un second exemplaire de cette logique est exactement ce qui avait laissé le carousel non branché côté
 * campagne : il n'y en a qu'un, et les deux processus l'instancient.
 */
export interface CarouselMediaDeps {
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

export class CarouselMediaPreparer {
  /** Cache par CHEMIN d'image (l'URL porte une signature qui change à chaque lecture du template). Sans lui,
   *  une campagne de 5 000 destinataires re-téléverserait 5 000 fois les mêmes visuels. */
  private readonly cache = new Map<string, { at: number; id: string }>();

  constructor(private readonly deps: CarouselMediaDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Rend les cartes prêtes à l'envoi. Une carte dont le visuel n'a pas pu être préparé revient SANS `mediaId` :
   * c'est `carouselSendBlocker` qui refuse alors l'envoi en la nommant, plutôt que de laisser partir un
   * message que Meta accepterait puis ne livrerait pas.
   */
  async prepare(tenantId: string, cards: OutboundCarouselCard[]): Promise<OutboundCarouselCard[]> {
    const pn = await this.deps.getPhoneNumberId(tenantId);
    if (!pn) {
      // eslint-disable-next-line no-console
      console.error('carousel: aucun numéro d’envoi pour le tenant, visuels non préparés');
      return cards;
    }
    const media = await this.deps.mediaClientFor(tenantId);
    const get = this.deps.fetchImpl ?? ((url: string) => fetch(url));
    return Promise.all(cards.map(async (card) => {
      if (!card.mediaUrl) {
        // eslint-disable-next-line no-console
        console.error('carousel: carte sans URL de visuel lisible chez Meta (handle non exploitable)');
        return card;
      }
      const cle = card.mediaUrl.split('?')[0]!;
      const hit = this.cache.get(cle);
      if (hit && this.now() - hit.at < MEDIA_CACHE_MS) return { ...card, mediaId: hit.id };
      try {
        const res = await get(card.mediaUrl);
        if (!res.ok) throw new Error(`téléchargement du visuel: HTTP ${res.status}`);
        const mime = res.headers.get('content-type') ?? 'image/jpeg';
        const bytes = Buffer.from(await res.arrayBuffer());
        const id = await media.uploadForSend(pn, bytes, mime);
        this.cache.set(cle, { at: this.now(), id });
        return { ...card, mediaId: id };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("carousel: visuel non préparé pour l'envoi:", err instanceof Error ? err.message : String(err));
        return card; // sans mediaId -> carouselSendBlocker refusera en nommant la carte
      }
    }));
  }
}
