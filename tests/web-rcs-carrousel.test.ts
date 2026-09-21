import { describe, it, expect } from 'vitest';
import {
  versCarrouselRcs, versBrouillonCarrousel, manquesCarrousel, carrouselDepuis, carrouselVide,
  type BrouillonCarrouselRcs,
} from '../web/lib/rcs-carrousel';
import { manquesMessageRcs, libelleFormatRcs, extraitRcs } from '../web/lib/rcs';
import { rcsOutboundSchema } from '../src/rcs/schema';

/**
 * Le carrousel de l'ecran, verifie contre le schema SERVEUR.
 *
 * C'est le point de ce fichier, comme de `web-rcs-brouillon.test.ts` : ce que l'ecran fabrique doit passer la
 * validation de la route, sinon l'operateur decouvre son erreur en 400 au moment d'enregistrer. Les deux
 * vivent dans des tsconfig differents et ne partagent aucun paquet ; seul un test peut tenir l'invariant.
 */
const IMG = 'https://exemple.test/v.jpg';

function deuxCartes(): BrouillonCarrouselRcs {
  return {
    cartes: [
      { title: 'Séjour à Nice', text: 'Dès 99 €', imageUrl: IMG, suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: '' }] },
      { title: '', text: 'Séjour à Lyon', imageUrl: IMG, suggestions: [{ kind: 'openUrl', text: 'Voir', url: 'https://exemple.test/lyon', postbackData: '' }] },
    ],
  };
}

describe('carrousel RCS (ecran) vers message envoyable', () => {
  it('produit un carrousel que la route accepte, visuels en TALL', () => {
    const msg = versCarrouselRcs(deuxCartes());
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
    expect(msg).toEqual({
      kind: 'carousel',
      cards: [
        {
          title: 'Séjour à Nice', description: 'Dès 99 €', mediaUrl: IMG, mediaHeight: 'TALL',
          suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: 'carte1_btn1' }],
        },
        {
          description: 'Séjour à Lyon', mediaUrl: IMG, mediaHeight: 'TALL',
          suggestions: [{ kind: 'openUrl', text: 'Voir', url: 'https://exemple.test/lyon', postbackData: 'carte2_btn1' }],
        },
      ],
    });
  });

  it('ecarte un bouton sans libelle et garde un postbackData deja pose', () => {
    const b = deuxCartes();
    b.cartes[0]!.suggestions = [
      { kind: 'reply', text: '   ', postbackData: '' },
      { kind: 'reply', text: 'Oui', postbackData: 'deja_la' },
    ];
    const msg = versCarrouselRcs(b);
    expect(msg.cards[0]!.suggestions).toEqual([{ kind: 'reply', text: 'Oui', postbackData: 'deja_la' }]);
  });

  it('une carte a titre seul, sans visuel, part sans media', () => {
    const msg = versCarrouselRcs({
      cartes: [
        { title: 'A', text: '', imageUrl: '', suggestions: [] },
        { title: 'B', text: '', imageUrl: '', suggestions: [] },
      ],
    });
    expect(msg.cards).toEqual([{ title: 'A' }, { title: 'B' }]);
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
  });

  it('relit un carrousel stocke, et le reecrit a l identique', () => {
    const msg = versCarrouselRcs(deuxCartes());
    const relu = versBrouillonCarrousel(msg);
    expect(relu).not.toBeNull();
    expect(versCarrouselRcs(relu!)).toEqual(msg);
  });

  it('ne relit comme carrousel que ce qui en est un', () => {
    expect(versBrouillonCarrousel({ kind: 'text', text: 'x' })).toBeNull();
    expect(versBrouillonCarrousel(null)).toBeNull();
  });
});

describe('ce qui manque a un carrousel', () => {
  it('un carrousel neuf manque de nom, et d un visuel ou d un titre sur chaque carte', () => {
    expect(manquesCarrousel('', carrouselVide()).map(([fr]) => fr)).toEqual([
      'le nom du carrousel',
      'le visuel ou le titre de la carte 1',
      'le visuel ou le titre de la carte 2',
    ]);
  });

  it('un carrousel rempli ne manque de rien', () => {
    expect(manquesCarrousel('Rentrée', deuxCartes())).toEqual([]);
  });

  it('un bouton de lien sans adresse est nomme, carte comprise', () => {
    const b = deuxCartes();
    b.cartes[1]!.suggestions = [{ kind: 'openUrl', text: 'Voir', url: '', postbackData: '' }];
    expect(manquesCarrousel('x', b).map(([fr]) => fr)).toEqual(['un bouton complet sur la carte 2 (libellé, lien, numéro ou dates)']);
  });

  it('un texte de plus de 2000 caracteres est nomme', () => {
    const b = deuxCartes();
    b.cartes[0]!.text = 'a'.repeat(2001);
    expect(manquesCarrousel('x', b).map(([fr]) => fr)).toEqual(['un texte plus court sur la carte 1 (2000 caractères au plus)']);
  });

  it('une seule carte ne suffit pas', () => {
    expect(manquesCarrousel('x', { cartes: [deuxCartes().cartes[0]!] }).map(([fr]) => fr)).toEqual(['au moins deux cartes']);
  });
});

describe('relecture stricte d un carrousel venu d un brouillon', () => {
  const valide = versCarrouselRcs(deuxCartes());
  const carte = valide.cards[0]!;

  it('accepte ce que la route accepte', () => {
    expect(rcsOutboundSchema.safeParse(valide).success).toBe(true);
    expect(carrouselDepuis(JSON.parse(JSON.stringify(valide)))).toEqual(valide);
  });

  const casses: Array<[string, unknown]> = [
    ['une seule carte', { kind: 'carousel', cards: [carte] }],
    ['onze cartes', { kind: 'carousel', cards: Array.from({ length: 11 }, () => carte) }],
    ['un bouton de type inconnu', { kind: 'carousel', cards: [{ ...carte, suggestions: [{ kind: 'danse', text: 'x', postbackData: 'p' }] }, carte] }],
    ['un lien sans adresse', { kind: 'carousel', cards: [{ ...carte, suggestions: [{ kind: 'openUrl', text: 'x', url: '', postbackData: 'p' }] }, carte] }],
    ['une carte sans titre ni visuel', { kind: 'carousel', cards: [{ description: 'x' }, carte] }],
    ['cinq boutons sur une carte', { kind: 'carousel', cards: [{ ...carte, suggestions: Array.from({ length: 5 }, () => ({ kind: 'reply', text: 'x', postbackData: 'p' })) }, carte] }],
    ['un titre vide', { kind: 'carousel', cards: [{ ...carte, title: '' }, carte] }],
    ['une date d agenda qui n en est pas une', { kind: 'carousel', cards: [{ ...carte, suggestions: [{ kind: 'calendar', text: 'x', postbackData: 'p', title: 'RDV', startAt: 'demain', endAt: 'demain' }] }, carte] }],
    ['pas un carrousel', { kind: 'text', text: 'x' }],
    ['rien', null],
  ];
  for (const [nom, valeur] of casses) {
    it(`rejette ${nom}, comme la route`, () => {
      expect(carrouselDepuis(valeur)).toBeNull();
      const accepteCommeCarrousel = rcsOutboundSchema.safeParse(valeur).success
        && (valeur as { kind?: unknown } | null)?.kind === 'carousel';
      expect(accepteCommeCarrousel).toBe(false);
    });
  }

  // ⚠️ L'ECART CONNU, ECRIT PLUTOT QUE CACHE : la relecture verifie la FORME, pas le format d'une adresse.
  // Le serveur reste l'autorite et refuse en 400 a la creation, comme pour tout ce que l'assistant envoie.
  it('une adresse mal formee passe la relecture, et la route la refuse', () => {
    const x = { kind: 'carousel', cards: [{ ...carte, mediaUrl: 'pas-une-adresse' }, carte] };
    expect(carrouselDepuis(x)).not.toBeNull();
    expect(rcsOutboundSchema.safeParse(x).success).toBe(false);
  });
});

describe('le message simple dit ce qui lui manque', () => {
  it('nomme chacune des quatre conditions qui grisaient le bouton', () => {
    expect(manquesMessageRcs('', { text: '', imageUrl: '', suggestions: [] }).map(([fr]) => fr))
      .toEqual(['le nom du message', 'le texte du message']);
    expect(manquesMessageRcs('x', { text: 'a'.repeat(2001), imageUrl: IMG, suggestions: [] }).map(([fr]) => fr))
      .toEqual(['un texte plus court (2000 caractères au plus)']);
    // Le même texte SANS visuel tient dans les 3 072 d'un message texte.
    expect(manquesMessageRcs('x', { text: 'a'.repeat(2001), imageUrl: '', suggestions: [] })).toEqual([]);
    expect(manquesMessageRcs('x', { text: 'y', imageUrl: '', suggestions: [{ kind: 'openUrl', text: 'Voir', url: '', postbackData: '' }] }).map(([fr]) => fr))
      .toEqual(['un bouton complet (libellé, lien, numéro ou dates)']);
  });
});

describe('le tableau de la bibliotheque', () => {
  it('dit le format et le debut du texte, carrousel compris', () => {
    const carrousel = versCarrouselRcs(deuxCartes());
    expect(libelleFormatRcs({ kind: 'text', text: 'Bonjour' })).toEqual(['message', 'message']);
    expect(libelleFormatRcs({ kind: 'card', card: { mediaUrl: IMG } })).toEqual(['carte', 'card']);
    expect(libelleFormatRcs(carrousel)).toEqual(['carrousel · 2 cartes', 'carousel · 2 cards']);
    expect(libelleFormatRcs(null)).toEqual(['illisible', 'unreadable']);
    expect(extraitRcs(carrousel)).toBe('Dès 99 €');
    expect(extraitRcs({ kind: 'text', text: 'Bonjour' })).toBe('Bonjour');
    expect(extraitRcs(null)).toBe('');
  });
});
