import { describe, it, expect } from 'vitest';
import { boutonsTracables, appliquerLiens, cleBouton, lienDe, rehabillerBoutons } from '../src/links/rewrite';
import type { CreateTemplateInput } from '../src/meta/templates';

const base = (over: Partial<CreateTemplateInput> = {}): CreateTemplateInput => ({
  name: 'promo',
  category: 'MARKETING',
  language: 'fr',
  body: 'Bonjour',
  ...over,
});

describe('boutonsTracables', () => {
  it('repère les boutons URL du template, à leur index META', () => {
    // L'index compte TOUS les boutons, pas seulement les URL : c'est la numérotation de Meta, et c'est elle
    // qu'il faudra retrouver pour rattacher un clic au bon bouton.
    const t = base({
      buttons: [
        { type: 'QUICK_REPLY', text: 'Oui' },
        { type: 'URL', text: 'Voir le site', url: 'https://client.fr/promo' },
      ],
    });
    expect(boutonsTracables(t)).toEqual([{ cardIndex: null, buttonIndex: 1, url: 'https://client.fr/promo' }]);
  });

  it('🔴 laisse intacte une URL qui contient DÉJÀ une variable', () => {
    // Personne ne sait fournir sa valeur à l'envoi : aucun chemin ne produit de composant `sub_type: url`.
    // La tracer fabriquerait un lien cassé chez le destinataire.
    const t = base({ buttons: [{ type: 'URL', text: 'Suivi', url: 'https://client.fr/suivi/{{1}}' }] });
    expect(boutonsTracables(t)).toEqual([]);
  });

  it('🔴 ne trace pas une URL que Meta refuserait de toute façon', () => {
    // Sinon on garde en base une ligne qui décrit un template qui n'existera jamais.
    const t = base({
      buttons: [
        { type: 'URL', text: 'Sans schéma', url: 'client.fr/promo' },
        { type: 'URL', text: 'Sans domaine', url: 'https://client/promo' },
        { type: 'URL', text: 'Vide', url: '' },
      ],
    });
    expect(boutonsTracables(t)).toEqual([]);
  });

  it('descend dans les cartes d’un carousel, chacune avec son index de carte', () => {
    const t = base({
      carousel: {
        cards: [
          { headerHandle: 'h1', buttons: [{ type: 'URL', text: 'A', url: 'https://client.fr/a' }] },
          { headerHandle: 'h2', buttons: [{ type: 'QUICK_REPLY', text: 'Non' }, { type: 'URL', text: 'B', url: 'https://client.fr/b' }] },
        ],
      },
    });
    expect(boutonsTracables(t)).toEqual([
      { cardIndex: 0, buttonIndex: 0, url: 'https://client.fr/a' },
      { cardIndex: 1, buttonIndex: 1, url: 'https://client.fr/b' },
    ]);
  });

  it('un template sans bouton ne trace rien', () => {
    expect(boutonsTracables(base())).toEqual([]);
  });
});

describe('appliquerLiens', () => {
  it('remplace l’URL du bouton visé et NE TOUCHE À RIEN d’autre', () => {
    const t = base({
      buttons: [
        { type: 'QUICK_REPLY', text: 'Oui' },
        { type: 'URL', text: 'Voir le site', url: 'https://client.fr/promo' },
      ],
      footer: 'STOP au 36111',
    });
    const sortie = appliquerLiens(t, new Map([[cleBouton(null, 1), 'https://mba.messagingme.app/r/ab12cd34ef56']]));
    expect(sortie.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Oui' },
      { type: 'URL', text: 'Voir le site', url: 'https://mba.messagingme.app/r/ab12cd34ef56' },
    ]);
    expect(sortie.footer).toBe('STOP au 36111');
    expect(sortie.body).toBe('Bonjour');
  });

  it('🔴 ne MUTE pas l’entrée : l’original reste soumettable tel quel', () => {
    // C'est ce qui permet de retomber sur le template NON tracé si l'allocation échoue en cours de route.
    const t = base({ buttons: [{ type: 'URL', text: 'Site', url: 'https://client.fr/promo' }] });
    appliquerLiens(t, new Map([[cleBouton(null, 0), 'https://mba.messagingme.app/r/aaaaaaaaaaaa']]));
    expect(t.buttons?.[0]?.url).toBe('https://client.fr/promo');
  });

  it('remplace dans la bonne carte d’un carousel', () => {
    const t = base({
      carousel: {
        cards: [
          { headerHandle: 'h1', buttons: [{ type: 'URL', text: 'A', url: 'https://client.fr/a' }] },
          { headerHandle: 'h2', buttons: [{ type: 'URL', text: 'B', url: 'https://client.fr/b' }] },
        ],
      },
    });
    const sortie = appliquerLiens(t, new Map([[cleBouton(1, 0), 'https://mba.messagingme.app/r/bbbbbbbbbbbb']]));
    expect(sortie.carousel?.cards[0]?.buttons?.[0]?.url).toBe('https://client.fr/a');
    expect(sortie.carousel?.cards[1]?.buttons?.[0]?.url).toBe('https://mba.messagingme.app/r/bbbbbbbbbbbb');
  });

  it('table vide -> template inchangé', () => {
    const t = base({ buttons: [{ type: 'URL', text: 'Site', url: 'https://client.fr/promo' }] });
    expect(appliquerLiens(t, new Map())).toBe(t);
  });
});

describe('lienDe', () => {
  it('assemble sans doubler le slash', () => {
    expect(lienDe('https://mba.messagingme.app', 'ab12cd34ef56')).toBe('https://mba.messagingme.app/r/ab12cd34ef56');
    expect(lienDe('https://mba.messagingme.app/', 'ab12cd34ef56')).toBe('https://mba.messagingme.app/r/ab12cd34ef56');
  });
});

describe('rehabillerBoutons', () => {
  it('🔴 remontre le lien SAISI là où Meta rend le nôtre', () => {
    // Sans ça, la console afficherait `…/r/xxxx` partout et la promesse « tu saisis ton lien » serait fausse
    // dès le premier rechargement de page.
    const boutons = [
      { type: 'QUICK_REPLY', text: 'Oui' },
      { type: 'URL', text: 'Voir le site', url: 'https://mba.messagingme.app/r/ab12cd34ef56' },
    ];
    const sortie = rehabillerBoutons(boutons, new Map([['https://mba.messagingme.app/r/ab12cd34ef56', 'https://client.fr/promo']]));
    expect(sortie?.[1]?.url).toBe('https://client.fr/promo');
    expect(sortie?.[0]).toEqual({ type: 'QUICK_REPLY', text: 'Oui' });
  });

  it('🔴 apparie sur l’URL, PAS sur la position', () => {
    // Un template édité hors console peut avoir vu ses boutons réordonnés ; un appariement par index
    // remettrait alors la destination d'un autre bouton.
    const boutons = [
      { type: 'URL', text: 'B', url: 'https://mba.messagingme.app/r/bbbbbbbbbbbb' },
      { type: 'URL', text: 'A', url: 'https://mba.messagingme.app/r/aaaaaaaaaaaa' },
    ];
    const sortie = rehabillerBoutons(boutons, new Map([
      ['https://mba.messagingme.app/r/aaaaaaaaaaaa', 'https://client.fr/a'],
      ['https://mba.messagingme.app/r/bbbbbbbbbbbb', 'https://client.fr/b'],
    ]));
    expect(sortie?.[0]?.url).toBe('https://client.fr/b');
    expect(sortie?.[1]?.url).toBe('https://client.fr/a');
  });

  it('un lien inconnu de la table reste tel quel (template créé avant la feature)', () => {
    const boutons = [{ type: 'URL', text: 'Site', url: 'https://client.fr/direct' }];
    expect(rehabillerBoutons(boutons, new Map())?.[0]?.url).toBe('https://client.fr/direct');
  });
});
