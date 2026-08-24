import { describe, it, expect } from 'vitest';
import {
  versMessageRcs, versBrouillonRcs, maxTexteRcs, MAX_TEXTE_RCS, MAX_TEXTE_RCS_AVEC_IMAGE, MAX_BOUTONS_CARTE,
} from '../web/lib/rcs';
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

  /**
   * 🔴 OU les boutons sont accroches decide de leur APPARENCE sur le telephone, et ce n'est pas nous qui la
   * dessinons. Documentation RBM de Google, lue le 2026-08-24 : dans la CARTE ils s'affichent en boutons
   * pleine largeur empiles et y RESTENT (4 maximum) ; sous le MESSAGE ils s'affichent en petites pastilles
   * en ligne et disparaissent des que la conversation avance (11 maximum).
   *
   * C'est la premiere forme que tout le monde reconnait des campagnes RCS, et la seconde que cet ecran
   * produisait. Des qu'il y a un visuel, les boutons vont donc DANS la carte.
   */
  it('avec un visuel : une CARTE, et les boutons DANS la carte', () => {
    const msg = versMessageRcs({
      text: 'Notre offre',
      imageUrl: ' https://x/visuel.jpg ',
      suggestions: [{ kind: 'reply', text: 'Oui', postbackData: '' }],
    });
    expect(msg).toEqual({
      kind: 'card',
      card: {
        description: 'Notre offre',
        mediaUrl: 'https://x/visuel.jpg',
        mediaHeight: 'TALL',
        suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'btn_1' }],
      },
    });
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
  });

  it('au-dela de quatre, le surplus retombe en pastilles au lieu d etre perdu', () => {
    const cinq = Array.from({ length: 5 }, (_, i) => ({ kind: 'reply' as const, text: `B${i}`, postbackData: '' }));
    const msg = versMessageRcs({ text: 'Offre', imageUrl: 'https://x/v.png', suggestions: cinq });
    expect(msg.kind).toBe('card');
    if (msg.kind !== 'card') throw new Error('carte attendue');
    expect(msg.card.suggestions).toHaveLength(MAX_BOUTONS_CARTE);
    expect(msg.suggestions).toEqual([{ kind: 'reply', text: 'B4', postbackData: 'btn_5' }]);
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
  });

  // Les boutons de la carte d'abord, les pastilles ensuite : c'est cet ordre qui aligne la numerotation
  // `btn:<i>` des sorties d'un bloc sur ce que le contact voit.
  it('relit une carte en remettant ses boutons dans l ordre carte puis pastilles', () => {
    const brouillon = {
      text: 'Offre',
      imageUrl: 'https://x/v.png',
      suggestions: Array.from({ length: 5 }, (_, i) => ({ kind: 'reply' as const, text: `B${i}`, postbackData: `btn_${i + 1}` })),
    };
    expect(versBrouillonRcs(versMessageRcs(brouillon))).toEqual(brouillon);
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
