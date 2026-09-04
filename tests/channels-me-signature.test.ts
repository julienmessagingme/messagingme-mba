import { describe, it, expect } from 'vitest';
import { corpsCanonique, signer } from '../src/channels-me/signature';

/**
 * Signature des appels Channels Me (module PUR : ni base, ni réseau).
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. 🔴 LE VECTEUR D'OR de la documentation du fournisseur. C'est le seul point de contact avec une
 *     vérité extérieure au dépôt : s'il bouge, plus aucun appel n'est authentifié, et l'API répond 401
 *     sans dire pourquoi. Il fige d'un coup la canonicalisation, l'algorithme et l'encodage de sortie
 *     (base64 des octets BRUTS, pas de leur représentation hexadécimale, piège déjà payé sur Zadarma).
 *  2. 🔴 LE TRI ALPHABÉTIQUE EN PROFONDEUR. La signature porte sur la structure IMBRIQUÉE, ce qui a été
 *     MESURÉ (spec du 2026-09-04, §2.2), pas supposé. Le vecteur d'or ne peut pas le prouver : il n'a
 *     qu'une seule clé plate, donc un tri de surface le passe aussi, puis casse tous les POST réels,
 *     dont le corps est `{message:{...}}`.
 */

// Vecteur d'or publié par le fournisseur. `secret` est la valeur LITTÉRALE de sa documentation : aucun
// secret de production ici, et la valeur est figée pour rendre l'assertion lisible.
const VECTEUR_CORPS = { user_id: 'azerty_1234' };
const VECTEUR_SECRET = 'secret';
const VECTEUR_SIGNATURE = 'NmkAFERlEbTraKnBkYuHSVygdSA65X5oPU4duO5bRMY=';

describe('corpsCanonique + signer : vecteur d or', () => {
  it('🔴 reproduit EXACTEMENT la signature publiée par le fournisseur', () => {
    expect(signer(corpsCanonique(VECTEUR_CORPS), VECTEUR_SECRET)).toBe(VECTEUR_SIGNATURE);
  });

  it('la chaîne canonique du vecteur est le JSON compact attendu', () => {
    expect(corpsCanonique(VECTEUR_CORPS)).toBe('{"user_id":"azerty_1234"}');
  });
});

// Mêmes données, clés écrites dans un autre ordre À TOUS LES NIVEAUX. C'est la forme réelle d'un POST de
// message : ce qui compte est imbriqué sous `message`, pas à la surface.
const POST_ORDRE_A = {
  message: { text: 'Notre newsletter (cm-a7k2m9p3)', kind: 'text', media_url: null },
  apply_utms: false,
};
const POST_ORDRE_B = {
  apply_utms: false,
  message: { media_url: null, kind: 'text', text: 'Notre newsletter (cm-a7k2m9p3)' },
};

describe('tri alphabétique EN PROFONDEUR', () => {
  it('🔴 mêmes données, clés écrites dans un ordre différent : MÊME chaîne canonique', () => {
    expect(corpsCanonique(POST_ORDRE_A)).toBe(corpsCanonique(POST_ORDRE_B));
  });

  it('🔴 et cette chaîne a ses clés triées jusque DANS l objet imbriqué', () => {
    // Le test précédent tombe déjà sur un tri de surface. Celui-ci dit en plus à quoi la chaîne doit
    // ressembler, donc il attrape aussi un tri inversé ou un tri par longueur, qui rendraient eux aussi
    // deux fois la même chaîne fausse.
    expect(corpsCanonique(POST_ORDRE_A)).toBe(
      '{"apply_utms":false,"message":{"kind":"text","media_url":null,"text":"Notre newsletter (cm-a7k2m9p3)"}}',
    );
  });
});

describe('ce que la chaîne canonique garantit au client', () => {
  it('l ordre d un TABLEAU n est jamais touché : c est une donnée, pas une présentation', () => {
    expect(corpsCanonique({ z: [3, 1, 2], a: 'x' })).toBe('{"a":"x","z":[3,1,2]}');
  });

  it('ni espaces, ni slash échappé : l URL wa.me du post traverse telle quelle', () => {
    expect(corpsCanonique({ text: 'https://wa.me/33525680250?text=Bonjour' }))
      .toBe('{"text":"https://wa.me/33525680250?text=Bonjour"}');
  });

  it('🔴 c est du JSON VALIDE qui redonne les mêmes données : c est LUI qui part comme corps', () => {
    expect(JSON.parse(corpsCanonique(POST_ORDRE_A))).toEqual(POST_ORDRE_A);
  });

  it('signer dépend du secret ET de la chaîne', () => {
    const canonique = corpsCanonique(POST_ORDRE_A);
    expect(signer(canonique, 'secret-a')).not.toBe(signer(canonique, 'secret-b'));
    expect(signer(canonique, 'secret-a'))
      .not.toBe(signer(corpsCanonique({ ...POST_ORDRE_A, apply_utms: true }), 'secret-a'));
  });

  it('🔴 base64 des octets BRUTS : 44 caractères, jamais 88 (piège Zadarma)', () => {
    // 32 octets -> 44 caractères base64. 88 voudrait dire qu'on a encodé les 64 caractères hexadécimaux,
    // ce qui rend une signature bien formée et systématiquement refusée.
    expect(signer('nimporte quoi', 'secret')).toHaveLength(44);
  });

  it('une fonction ou un Symbol en valeur : la propriété est SUPPRIMÉE, jamais "clé":null', () => {
    // JSON.stringify natif laisse tomber une propriété dont la valeur est une fonction ou un Symbol,
    // exactement comme il le fait pour `undefined`. Un tri de surface qui ne filtrerait que `undefined`
    // rendrait `{"a":1,"b":null}`, une divergence inoffensive aujourd'hui mais un piège pour un appelant
    // futur qui ferait confiance à cette parité avec JSON.stringify.
    expect(corpsCanonique({ a: 1, b: () => {} })).toBe('{"a":1}');
  });
});
