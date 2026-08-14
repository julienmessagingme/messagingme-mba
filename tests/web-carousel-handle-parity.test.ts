import { describe, it, expect } from 'vitest';
import { carouselButtonHandle as web } from '../web/lib/carousel-handle';
import { carouselButtonHandle as api } from '../src/meta/template-components';

// Le builder nomme la sortie d'un bloc, l'envoi pose le payload chez Meta, et le moteur relie les deux en
// comparant les deux chaînes. Elles sont écrites de chaque côté d'une frontière de build : si elles divergent,
// l'opérateur relie des fils que le tap ne suivra jamais. Ce test casse avant lui.
describe('parité carouselButtonHandle builder / envoi', () => {
  it('même chaîne des deux côtés, sur toute la plage utile (10 cartes x 2 boutons)', () => {
    for (let carte = 0; carte < 10; carte += 1) {
      for (let bouton = 0; bouton < 2; bouton += 1) {
        expect(web(carte, bouton)).toBe(api(carte, bouton));
      }
    }
  });

  it('format attendu, et deux boutons distincts ne se confondent jamais', () => {
    expect(web(0, 0)).toBe('card:0:btn:0');
    expect(web(2, 1)).toBe('card:2:btn:1');
    const tous = new Set<string>();
    for (let c = 0; c < 10; c += 1) for (let b = 0; b < 2; b += 1) tous.add(web(c, b));
    expect(tous.size).toBe(20); // les 20 destinations sont bien distinctes
  });
});
