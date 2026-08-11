import { describe, it, expect } from 'vitest';
import { buildTemplateComponents, carouselSendBlocker } from '../src/meta/template-components';
import type { OutboundCarouselCard } from '../src/meta/template-components';

describe('buildTemplateComponents', () => {
  it('header IMAGE -> paramètre type=image', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/a.jpg', headerFormat: 'IMAGE' });
    expect(c).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.fr/a.jpg' } }] }]);
  });

  it('header VIDEO -> paramètre type=video (pas image !)', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/v.mp4', headerFormat: 'VIDEO' });
    expect(c).toEqual([{ type: 'header', parameters: [{ type: 'video', video: { link: 'https://x.fr/v.mp4' } }] }]);
  });

  it('header DOCUMENT -> paramètre type=document', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/d.pdf', headerFormat: 'DOCUMENT' });
    expect(c).toEqual([{ type: 'header', parameters: [{ type: 'document', document: { link: 'https://x.fr/d.pdf' } }] }]);
  });

  it('format absent mais URL fournie -> image par défaut', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/a.jpg' });
    expect((c[0] as { parameters: Array<{ type: string }> }).parameters[0]?.type).toBe('image');
  });

  it('variables du corps -> body avec paramètres texte, dans l ordre', () => {
    const c = buildTemplateComponents({ bodyParams: ['Julie', 'Lyon'] });
    expect(c).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Julie' }, { type: 'text', text: 'Lyon' }] }]);
  });

  it('header média + corps -> les deux components, header en premier', () => {
    const c = buildTemplateComponents({ bodyParams: ['Julie'], headerMediaUrl: 'https://x.fr/a.jpg', headerFormat: 'IMAGE' });
    expect(c).toHaveLength(2);
    expect((c[0] as { type: string }).type).toBe('header');
    expect((c[1] as { type: string }).type).toBe('body');
  });

  it('rien -> aucun component', () => {
    expect(buildTemplateComponents({ bodyParams: [] })).toEqual([]);
  });
});

const card = (over: Partial<OutboundCarouselCard> = {}): OutboundCarouselCard => ({ mediaUrl: 'https://cdn.fr/1.jpg', ...over });

describe('buildTemplateComponents — carousel', () => {
  it('2 cartes -> un composant carousel, card_index 0 puis 1, une image par carte', () => {
    const c = buildTemplateComponents({
      bodyParams: [],
      carousel: { cards: [card({ mediaUrl: 'https://cdn.fr/a.jpg' }), card({ mediaUrl: 'https://cdn.fr/b.jpg' })] },
    });
    expect(c).toEqual([
      {
        type: 'carousel',
        cards: [
          { card_index: 0, components: [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.fr/a.jpg' } }] }] },
          { card_index: 1, components: [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.fr/b.jpg' } }] }] },
        ],
      },
    ]);
  });

  it('carte VIDEO -> paramètre type=video (pas image)', () => {
    const c = buildTemplateComponents({ bodyParams: [], carousel: { cards: [card({ mediaUrl: 'https://cdn.fr/v.mp4', mediaFormat: 'VIDEO' })] } });
    const cards = (c[0] as { cards: Array<{ components: Array<{ parameters: Array<{ type: string }> }> }> }).cards;
    expect(cards[0]!.components[0]!.parameters[0]!.type).toBe('video');
  });

  it("corps d'intro AVANT le carousel dans le tableau top-level", () => {
    const c = buildTemplateComponents({ bodyParams: ['Julie'], carousel: { cards: [card()] } });
    expect(c).toHaveLength(2);
    expect((c[0] as { type: string }).type).toBe('body');
    expect((c[1] as { type: string }).type).toBe('carousel');
  });

  it('carte sans variable -> AUCUN composant body de carte (un parameters vide déclenche 132012)', () => {
    const c = buildTemplateComponents({ bodyParams: [], carousel: { cards: [card({ body: 'Texte fixe de la carte' })] } });
    const comps = (c[0] as { cards: Array<{ components: Array<{ type: string }> }> }).cards[0]!.components;
    expect(comps.map((x) => x.type)).toEqual(['header']);
  });

  it('bouton quick-reply -> composant button avec payload portant la carte ; URL statique -> rien', () => {
    const c = buildTemplateComponents({
      bodyParams: [],
      carousel: { cards: [card(), card({ buttons: [{ type: 'QUICK_REPLY' }, { type: 'URL' }] })] },
    });
    const cards = (c[0] as { cards: Array<{ components: unknown[] }> }).cards;
    expect(cards[0]!.components).toHaveLength(1); // carte sans bouton : image seule
    expect(cards[1]!.components).toHaveLength(2); // image + LE seul quick-reply (l'URL statique n'en produit pas)
    expect(cards[1]!.components[1]).toEqual({
      type: 'button', sub_type: 'quick_reply', index: '0',
      parameters: [{ type: 'payload', payload: 'card:1:btn:0' }],
    });
  });

  it('carousel + header top-level -> le carousel gagne, le header est ignoré (ses médias sont par carte)', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://cdn.fr/top.jpg', headerFormat: 'IMAGE', carousel: { cards: [card()] } });
    expect(c).toHaveLength(1);
    expect((c[0] as { type: string }).type).toBe('carousel');
  });

  it('template SANS carousel -> sortie strictement identique (non-régression)', () => {
    expect(buildTemplateComponents({ bodyParams: ['Julie'] })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Julie' }] },
    ]);
    expect(buildTemplateComponents({ bodyParams: [] })).toEqual([]);
  });
});

describe('carouselSendBlocker', () => {
  it('cartes complètes -> null (envoyable)', () => {
    expect(carouselSendBlocker([card(), card({ body: 'Texte fixe' })])).toBeNull();
  });

  it('aucune carte -> refus', () => {
    expect(carouselSendBlocker([])).toBe('ce carousel ne contient aucune carte');
  });

  it("carte sans image -> refus nommant la carte (numérotée à partir de 1)", () => {
    expect(carouselSendBlocker([card(), { body: 'x' }])).toContain('carte 2');
  });

  it('carte avec une variable -> refus explicite (aucun mapping carte -> champ CRM en base)', () => {
    const blocked = carouselSendBlocker([card({ body: 'Bonjour {{1}}' })]);
    expect(blocked).toContain('carte 1');
    expect(blocked).toContain('variable');
  });

  it('le refus prime sur la construction : une carte sans image ne part jamais en silence', () => {
    const cards: OutboundCarouselCard[] = [{ body: 'sans image' }];
    expect(carouselSendBlocker(cards)).not.toBeNull();
  });
});
