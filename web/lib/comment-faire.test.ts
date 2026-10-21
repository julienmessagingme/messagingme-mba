import { describe, it, expect } from 'vitest';
import { pageCommentFaire } from './comment-faire';

/**
 * Le lien « Comment faire » de la barre du haut (plan du centre d'aide, tâche 10) : la page du centre d'aide de l'écran
 * courant, dans la langue de la console, ou rien quand l'écran n'a pas de page.
 */
describe('pageCommentFaire', () => {
  it('Campagnes mène à « Lancer une campagne », dans la langue de la console', () => {
    expect(pageCommentFaire('campagnes', 'fr')).toBe('https://app.messagingme.fr/aide/lancer-une-campagne/');
    expect(pageCommentFaire('campagnes', 'en')).toBe('https://app.messagingme.fr/en/help/launch-a-campaign/');
  });

  it('un écran sans page n’a pas de lien, même un nom hérité d’Object', () => {
    expect(pageCommentFaire('webhooks', 'fr')).toBeNull();
    expect(pageCommentFaire('', 'en')).toBeNull();
    expect(pageCommentFaire('constructor', 'fr')).toBeNull();
    expect(pageCommentFaire('__proto__', 'en')).toBeNull();
  });
});
