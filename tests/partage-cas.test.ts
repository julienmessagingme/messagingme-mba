import { describe, it, expect } from 'vitest';
import { isSendableButtonUrl } from '../web/lib/partage/button-url';
import { dureeDeLaTete } from '../web/lib/partage/pub-video';
import { exempleUrl } from '../web/lib/champs-url';

/**
 * LES CAS DES RÈGLES PARTAGÉES (`web/lib/partage/`), repris des tests de parité qu'elles ont remplacés (audit de
 * simplicité du 2026-10-09, lot B). Ces tables comparaient deux copies ; il n'y a plus qu'une règle, donc chaque cas
 * porte désormais son résultat ATTENDU, sans quoi la règle pourrait changer sans qu'aucun test ne le dise.
 */

describe('isSendableButtonUrl : une URL de bouton que Meta acceptera', () => {
  // Le formulaire refuse ce que le serveur refuserait : sinon l'opérateur récupère le message de chemin JSON de Meta.
  const CAS: Array<[string, boolean]> = [
    ['https://exemple.fr', true],
    ['http://exemple.fr/page?a=1#b', true],
    ['https://sous.domaine.exemple.fr/chemin', true],
    ['exemple.fr', false], // le cas réel : adresse sans schéma
    ['www.exemple.fr', false],
    ['', false],
    ['   ', false],
    ['https://', false],
    ['https://exemple', false], // pas de domaine de premier niveau
    ['https://exemple.fr /x', false], // espace collée en fin de saisie
    ['ftp://exemple.fr', false],
    ['javascript:alert(1)', false],
    ['{{1}}', false],
    // URL DYNAMIQUE d'un bouton de premier niveau : Meta l'accepte, la règle ne doit PAS la rejeter. Le refus des
    // variables est propre au carrousel, et vit ailleurs.
    ['https://exemple.fr/produit/{{1}}', true],
  ];
  for (const [url, attendu] of CAS) {
    it(`« ${url} » -> ${attendu}`, () => expect(isSendableButtonUrl(url)).toBe(attendu));
  }
});

describe('exempleUrl : l’aperçu de la console encode comme la redirection', () => {
  it('chaque champ remplacé par un exemple encodé, et rien quand l’adresse n’en porte pas ou est refusée', () => {
    expect(exempleUrl('https://client.fr/commande/{numero_commande}')).toBe('https://client.fr/commande/A1234');
    expect(exempleUrl('https://client.fr/?t={telephone}')).toBe('https://client.fr/?t=%2B33612345678');
    expect(exempleUrl('https://client.fr/promo')).toBeNull();
    // Un champ dans l'hôte ferait de notre domaine un redirecteur ouvert : refusé, donc aucun aperçu.
    expect(exempleUrl('https://{prenom}.client.fr/')).toBeNull();
  });
});

describe('dureeDeLaTete : la durée lue dans la boîte `mvhd`, sans décoder la vidéo', () => {
  const boite = (nom: string, contenu: Uint8Array = new Uint8Array(0), etendue = false): Uint8Array => {
    const entete = etendue ? 16 : 8;
    const out = new Uint8Array(entete + contenu.byteLength);
    const v = new DataView(out.buffer);
    if (etendue) { v.setUint32(0, 1); v.setUint32(12, out.byteLength); } else v.setUint32(0, out.byteLength);
    for (let i = 0; i < 4; i += 1) out[4 + i] = nom.charCodeAt(i);
    out.set(contenu, entete);
    return out;
  };
  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.byteLength; }
    return out;
  };
  const mvhd = (version: 0 | 1, echelle: number, haut: number, bas: number): Uint8Array => {
    const corps = new Uint8Array(version === 1 ? 108 : 96);
    const v = new DataView(corps.buffer);
    v.setUint8(0, version);
    if (version === 1) { v.setUint32(20, echelle); v.setUint32(24, haut); v.setUint32(28, bas); } else { v.setUint32(12, echelle); v.setUint32(16, bas); }
    return boite('mvhd', corps);
  };
  const FTYP = boite('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));
  const complet = concat(FTYP, boite('moov', mvhd(0, 1000, 0, 45_000)));

  const CAS: Array<[string, Uint8Array, number | null]> = [
    ['v0 au début', complet, 45],
    ['v1 au début', concat(FTYP, boite('moov', mvhd(1, 600, 0, 600 * 75))), 75],
    // 2^32 + 5 unités à un million par seconde : la partie haute compte.
    ['v1 sur plus de 32 bits', concat(FTYP, boite('moov', mvhd(1, 1_000_000, 1, 5))), 4294.967301],
    ['moov à taille étendue', concat(FTYP, boite('moov', mvhd(0, 1000, 0, 30_000), true)), 30],
    ['free avant moov', concat(FTYP, boite('free', new Uint8Array(16)), boite('moov', mvhd(0, 90_000, 0, 90_000 * 30))), 30],
    ['moov derrière mdat, dans la tête lue', concat(FTYP, boite('mdat', new Uint8Array(64)), boite('moov', mvhd(0, 1000, 0, 5000))), 5],
    ['durée inconnue v0', concat(FTYP, boite('moov', mvhd(0, 1000, 0, 0xffffffff))), null],
    ['durée inconnue v1', concat(FTYP, boite('moov', mvhd(1, 1000, 0xffffffff, 0xffffffff))), null],
    ['échelle nulle', concat(FTYP, boite('moov', mvhd(0, 0, 0, 1000))), null],
    ['tronquée dans mvhd', complet.slice(0, complet.length - 80), null],
    ['boîte incohérente', concat(FTYP, new Uint8Array([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65])), null],
    ['taille zéro hors moov', concat(FTYP, new Uint8Array([0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74])), null],
    ['moov sans mvhd en tête', concat(FTYP, boite('moov', boite('trak', new Uint8Array(40)))), null],
    ['vide', new Uint8Array(0), null],
  ];
  for (const [nom, tete, attendu] of CAS) {
    it(`${nom} -> ${attendu}`, () => {
      const lu = dureeDeLaTete(tete);
      if (attendu === null) expect(lu).toBeNull();
      else expect(lu).toBeCloseTo(attendu, 6);
    });
  }
});
