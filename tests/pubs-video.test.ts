import { describe, it, expect } from 'vitest';
import {
  DUREE_VIDEO_PUB_MAX_S, MorceauDeTailleInattendue, TAILLE_VIDEO_PUB_MAX,
  dureeDeLaTete, dureeTropLongue, estVideoMp4OuMov, lireTete, suiteBornee,
} from '../src/pubs/video';

/**
 * LA VIDÉO D'UNE PUBLICITÉ, LUE SANS ÊTRE DÉCODÉE (`src/pubs/video.ts`).
 *
 * 🔴 Ce que ces tests défendent : ce qui part chez Meta sous l'identité du client est bien une vidéo (signature
 * `ftyp`), sa durée est vérifiée quand le fichier la porte au début, et un morceau relayé fait EXACTEMENT la taille
 * annoncée, ni plus (on ne lit pas au-delà) ni moins.
 */

/** Une boîte ISO BMFF : 4 octets de taille, 4 de nom, puis le contenu. */
function boite(nom: string, contenu: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + contenu.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = nom.charCodeAt(i);
  out.set(contenu, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.byteLength; }
  return out;
}

/** Une boîte `mvhd` de version 0 ou 1, avec son échelle et sa durée. */
function mvhd(version: 0 | 1, echelle: number, duree: number | 'inconnue'): Uint8Array {
  const corps = new Uint8Array(version === 1 ? 108 : 96);
  const v = new DataView(corps.buffer);
  v.setUint8(0, version);
  if (version === 1) {
    v.setUint32(20, echelle);
    if (duree === 'inconnue') { v.setUint32(24, 0xffffffff); v.setUint32(28, 0xffffffff); } else { v.setUint32(24, Math.floor(duree / 2 ** 32)); v.setUint32(28, duree % 2 ** 32); }
  } else {
    v.setUint32(12, echelle);
    v.setUint32(16, duree === 'inconnue' ? 0xffffffff : duree);
  }
  return boite('mvhd', corps);
}

const FTYP = boite('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));

describe('la signature d’une vidéo', () => {
  it('un fichier qui commence par une boîte `ftyp` est un MP4 ou un MOV', () => {
    expect(estVideoMp4OuMov(concat(FTYP, boite('mdat')))).toBe(true);
  });

  it('🔴 une image, un texte ou un fichier trop court ne le sont pas, quoi qu’en dise le navigateur', () => {
    expect(estVideoMp4OuMov(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))).toBe(false);
    expect(estVideoMp4OuMov(new TextEncoder().encode('<html><body>'))).toBe(false);
    expect(estVideoMp4OuMov(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79]))).toBe(false);
  });
});

describe('la durée lue dans la tête du fichier', () => {
  it('moov au début (fast start), mvhd version 0 : 45 secondes', () => {
    expect(dureeDeLaTete(concat(FTYP, boite('moov', mvhd(0, 1000, 45_000)), boite('mdat')))).toBe(45);
  });

  it('mvhd version 1 (dates sur 64 bits) : lue au bon endroit', () => {
    expect(dureeDeLaTete(concat(FTYP, boite('moov', mvhd(1, 600, 600 * 75))))).toBe(75);
  });

  it('une boîte `free` entre `ftyp` et `moov` est sautée', () => {
    expect(dureeDeLaTete(concat(FTYP, boite('free', new Uint8Array(16)), boite('moov', mvhd(0, 90_000, 90_000 * 30))))).toBe(30);
  });

  it('🔴 moov À LA FIN, derrière mdat : `null`, jamais une durée devinée', () => {
    // La tête lue s'arrête dans `mdat` : on ne sait pas, et c'est le contrôle du navigateur qui tient la règle.
    const mdat = new Uint8Array(8);
    new DataView(mdat.buffer).setUint32(0, 5_000_000);
    mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
    expect(dureeDeLaTete(concat(FTYP, mdat, new Uint8Array(100)))).toBeNull();
  });

  it('une durée « inconnue » (tout à un) ou une échelle nulle ne sont pas des durées', () => {
    expect(dureeDeLaTete(concat(FTYP, boite('moov', mvhd(0, 1000, 'inconnue'))))).toBeNull();
    expect(dureeDeLaTete(concat(FTYP, boite('moov', mvhd(1, 1000, 'inconnue'))))).toBeNull();
    expect(dureeDeLaTete(concat(FTYP, boite('moov', mvhd(0, 0, 1000))))).toBeNull();
  });

  it('une tête tronquée au milieu de mvhd rend `null`', () => {
    const complet = concat(FTYP, boite('moov', mvhd(0, 1000, 45_000)));
    expect(dureeDeLaTete(complet.slice(0, FTYP.byteLength + 8 + 20))).toBeNull();
  });

  it('une boîte de taille incohérente ne fait pas boucler la lecture', () => {
    const casse = concat(FTYP, new Uint8Array([0, 0, 0, 3, 0x66, 0x72, 0x65, 0x65]), new Uint8Array(32));
    expect(dureeDeLaTete(casse)).toBeNull();
  });
});

describe('la borne de durée', () => {
  it(`🔴 ${DUREE_VIDEO_PUB_MAX_S} secondes au plus, arrondies : un « 60 s » de téléphone fait souvent 60,03 s`, () => {
    expect(dureeTropLongue(59)).toBe(false);
    expect(dureeTropLongue(60.03)).toBe(false);
    expect(dureeTropLongue(60.4)).toBe(false);
    expect(dureeTropLongue(60.6)).toBe(true);
    expect(dureeTropLongue(90)).toBe(true);
  });

  it('100 Mo, décision de Julien', () => {
    expect(TAILLE_VIDEO_PUB_MAX).toBe(100 * 1024 * 1024);
  });
});

/** Un flux qui compte ce qu'on lui a demandé : c'est ce qui montre qu'on ne lit pas plus loin qu'il ne faut. */
function flux(morceaux: Uint8Array[]): { it: AsyncIterator<Uint8Array>; lus: () => number } {
  let lus = 0;
  const it = (async function* () {
    for (const m of morceaux) { lus += 1; yield m; }
  })();
  return { it, lus: () => lus };
}

const octets = (n: number, v = 7): Uint8Array => new Uint8Array(n).fill(v);

async function vider(g: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of g) parts.push(p);
  return concat(...parts);
}

describe('la tête, puis la suite, bornées', () => {
  it('la tête s’arrête au premier morceau qui atteint `n`, et la suite reprend exactement là', async () => {
    const f = flux([octets(10, 1), octets(10, 2), octets(10, 3)]);
    const { tete, fini } = await lireTete(f.it, 15);
    expect(tete.byteLength).toBe(20);
    expect(fini).toBe(false);
    expect(f.lus()).toBe(2);
    const tout = await vider(suiteBornee(tete, f.it, fini, 30));
    expect([...tout]).toEqual([...octets(10, 1), ...octets(10, 2), ...octets(10, 3)]);
  });

  it('🔴 un flux PLUS LONG que le morceau annoncé : levée, et on ne lit pas au-delà', async () => {
    const f = flux([octets(10), octets(10), octets(10), octets(10)]);
    const { tete, fini } = await lireTete(f.it, 5);
    await expect(vider(suiteBornee(tete, f.it, fini, 15))).rejects.toBeInstanceOf(MorceauDeTailleInattendue);
    // Le deuxième morceau dépasse : le troisième n'a jamais été demandé.
    expect(f.lus()).toBe(2);
  });

  it('🔴 un flux PLUS COURT : levée à la fin, pas un morceau tronqué envoyé comme complet', async () => {
    const f = flux([octets(10), octets(10)]);
    const { tete, fini } = await lireTete(f.it, 5);
    await expect(vider(suiteBornee(tete, f.it, fini, 25))).rejects.toBeInstanceOf(MorceauDeTailleInattendue);
  });

  it('un flux entièrement lu par la tête se relaie tel quel', async () => {
    const f = flux([octets(4, 9)]);
    const { tete, fini } = await lireTete(f.it, 64);
    expect(fini).toBe(true);
    expect([...await vider(suiteBornee(tete, f.it, fini, 4))]).toEqual([9, 9, 9, 9]);
  });
});
