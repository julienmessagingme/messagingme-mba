import { describe, it, expect } from 'vitest';
import { carouselOutputs, type CarouselTemplateLike } from '../web/lib/carousel-outputs';

const tpl = (over: CarouselTemplateLike): CarouselTemplateLike => over;

describe('carouselOutputs (sorties d un bloc template carousel)', () => {
  it('une sortie par bouton de chaque carte, avec son étiquette de carte', () => {
    const out = carouselOutputs(tpl({
      carousel: { cards: [
        { buttons: [{ type: 'QUICK_REPLY', text: 'Je viens' }, { type: 'URL', text: 'Voir', url: 'https://a.fr' }] },
        { buttons: [{ type: 'QUICK_REPLY', text: 'Ça m intéresse' }, { type: 'URL', text: 'Détails', url: 'https://b.fr' }] },
      ] },
    }));
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ type: 'QUICK_REPLY', text: 'Je viens', handle: 'card:0:btn:0', cardIndex: 0 });
    expect(out[2]).toEqual({ type: 'QUICK_REPLY', text: 'Ça m intéresse', handle: 'card:1:btn:0', cardIndex: 1 });
  });

  it('l index d un bouton compte les boutons lien : une réponse rapide APRÈS un lien porte l index 1', () => {
    // Le payload posé à l'envoi utilise la position dans TOUS les boutons de la carte. Décaler ici ferait
    // relier un fil que le tap ne suivrait jamais.
    const out = carouselOutputs(tpl({
      carousel: { cards: [{ buttons: [{ type: 'URL', text: 'Voir', url: 'https://a.fr' }, { type: 'QUICK_REPLY', text: 'Rappelez-moi' }] }] },
    }));
    expect(out[1]).toMatchObject({ text: 'Rappelez-moi', handle: 'card:0:btn:1' });
  });

  it('10 cartes x 2 boutons -> 20 sorties toutes distinctes', () => {
    const cards = Array.from({ length: 10 }, () => ({ buttons: [{ type: 'QUICK_REPLY' as const, text: 'A' }, { type: 'QUICK_REPLY' as const, text: 'B' }] }));
    const out = carouselOutputs(tpl({ carousel: { cards } }));
    expect(out).toHaveLength(20);
    expect(new Set(out.map((o) => o.handle)).size).toBe(20);
  });

  it('template sans carousel, carousel vide, ou template absent -> aucune sortie (repli sur le premier niveau)', () => {
    expect(carouselOutputs(tpl({}))).toEqual([]);
    expect(carouselOutputs(tpl({ carousel: { cards: [] } }))).toEqual([]);
    expect(carouselOutputs(undefined)).toEqual([]);
  });

  it('carte sans bouton -> aucune sortie pour elle, sans casser les autres', () => {
    const out = carouselOutputs(tpl({
      carousel: { cards: [{ body: 'sans bouton' }, { buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }] }] },
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ handle: 'card:1:btn:0' });
  });
});
