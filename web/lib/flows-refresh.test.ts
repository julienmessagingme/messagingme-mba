import { describe, it, expect } from 'vitest';
import { messageRafraichissement } from './flows-refresh';

/**
 * Compte-rendu du bouton « Rafraîchir » de l'écran Formulaires. Testé ici plutôt qu'en E2E parce que c'est de
 * la logique de phrase (pluriels, branches, mise en garde conditionnelle), et parce que ce message porte la
 * SEULE information qui distingue un formulaire importé d'un formulaire construit dans la console.
 *
 * ⚠️ Vit dans `web/` : il importe `./api` (via le type du rapport), qui tire `http.ts` et donc `window`.
 */
const t = (fr: string) => fr;
const rapport = (over: Partial<{ importes: number; majs: number; ignores: number; absents: number }> = {}) => ({
  importes: 0, majs: 0, ignores: 0, absents: 0, ...over,
});

describe('messageRafraichissement', () => {
  it('rien à faire -> le dit franchement plutôt que de rendre une phrase vide', () => {
    expect(messageRafraichissement(rapport(), t)).toBe('Aucun changement : la liste est déjà à jour.');
  });

  it('un import AVERTIT que les réponses n\'alimenteront pas les fiches contact', () => {
    const msg = messageRafraichissement(rapport({ importes: 1 }), t);
    expect(msg).toContain('1 formulaire importé');
    expect(msg).toContain('n’alimentent pas les fiches contact');
  });

  it('sans import, pas de mise en garde (elle ne concernerait aucun formulaire de la liste)', () => {
    const msg = messageRafraichissement(rapport({ majs: 2 }), t);
    expect(msg).toBe('2 mis à jour.');
    expect(msg).not.toContain('fiches contact');
  });

  it('accorde les pluriels et énumère les quatre issues', () => {
    const msg = messageRafraichissement(rapport({ importes: 2, majs: 1, ignores: 3, absents: 1 }), t);
    expect(msg).toContain('2 formulaires importés');
    expect(msg).toContain('1 mis à jour');
    expect(msg).toContain('3 ignorés (déprécié ou bloqué chez Meta)');
    expect(msg).toContain('1 présent ici mais plus chez Meta');
  });
});
