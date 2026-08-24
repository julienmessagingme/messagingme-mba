import { describe, it, expect } from 'vitest';
import { versMessageRcs, versBrouillonRcs, maxTexteRcs, MAX_TEXTE_RCS, MAX_TEXTE_RCS_AVEC_IMAGE } from '../web/lib/rcs';
import { rcsOutboundSchema } from '../src/rcs/schema';

/**
 * La bascule TEXTE / CARTE de l'ecran, verifiee contre le schema SERVEUR.
 *
 * C'est le point de ce fichier : ce que l'ecran fabrique doit passer la validation de la route, sinon
 * l'operateur decouvre son erreur au moment d'enregistrer. Les deux vivent dans des tsconfig differents et
 * ne partagent aucun paquet ; seul un test peut tenir l'invariant.
 */
describe('Brouillon de message RCS (ecran) vers message envoyable', () => {
  it('sans visuel : un message TEXTE', () => {
    const msg = versMessageRcs({ text: '  Bonjour  ', imageUrl: '', suggestions: [] });
    expect(msg).toEqual({ kind: 'text', text: 'Bonjour' });
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
  });

  it('avec un visuel : une CARTE, texte en description, boutons SOUS le message', () => {
    const msg = versMessageRcs({
      text: 'Notre offre',
      imageUrl: ' https://x/visuel.jpg ',
      suggestions: [{ kind: 'reply', text: 'Oui', postbackData: '' }],
    });
    expect(msg).toEqual({
      kind: 'card',
      card: { description: 'Notre offre', mediaUrl: 'https://x/visuel.jpg', mediaHeight: 'TALL' },
      suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'btn_1' }],
    });
    // 🔴 Les boutons sont au niveau du MESSAGE, pas dans la carte : la carte n'en accepte que 4, le message 11.
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
  });

  it('ecarte les boutons sans libelle', () => {
    const msg = versMessageRcs({
      text: 'Bonjour',
      imageUrl: '',
      suggestions: [{ kind: 'reply', text: '  ', postbackData: '' }, { kind: 'reply', text: 'Oui', postbackData: '' }],
    });
    expect(msg).toEqual({ kind: 'text', text: 'Bonjour', suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'btn_1' }] });
  });

  it('fait l aller-retour message -> brouillon -> message', () => {
    for (const brouillon of [
      { text: 'Bonjour', imageUrl: '', suggestions: [] },
      { text: 'Notre offre', imageUrl: 'https://x/v.png', suggestions: [{ kind: 'reply' as const, text: 'Oui', postbackData: 'btn_1' }] },
    ]) {
      const msg = versMessageRcs(brouillon);
      expect(versBrouillonRcs(msg)).toEqual(brouillon);
    }
  });

  it('SIGNALE les formats sans composeur au lieu de les ouvrir a moitie', () => {
    expect(versBrouillonRcs(null)).toBeNull();
    expect(versBrouillonRcs({ kind: 'carousel', cards: [{ title: 'A' }, { title: 'B' }] })).toBeNull();
    // Carte a TITRE : l'ecran n'expose pas de champ titre, l'ouvrir reenregistrerait un message ampute.
    expect(versBrouillonRcs({ kind: 'card', card: { title: 'T', description: 'D' } })).toBeNull();
  });

  it('plafonne le texte selon la borne de smsmode, qui change avec le visuel', () => {
    expect(maxTexteRcs('')).toBe(MAX_TEXTE_RCS);
    expect(maxTexteRcs('https://x/v.png')).toBe(MAX_TEXTE_RCS_AVEC_IMAGE);
    expect(MAX_TEXTE_RCS_AVEC_IMAGE).toBeLessThan(MAX_TEXTE_RCS);
    // Un texte plus long que la borne d'une CARTE doit etre refuse par le schema serveur : c'est ce qui
    // rend le compteur de l'ecran autre chose qu'une decoration.
    const trop = versMessageRcs({ text: 'x'.repeat(MAX_TEXTE_RCS_AVEC_IMAGE + 1), imageUrl: 'https://x/v.png', suggestions: [] });
    expect(rcsOutboundSchema.safeParse(trop).success).toBe(false);
  });
});
