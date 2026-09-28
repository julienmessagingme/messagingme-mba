import { describe, it, expect } from 'vitest';
import {
  cadrageDe, dureeDuFichier, dureeRetenue, dureeTropLongue, morceauSuivant, refusVideo, typeVideoDe, TAILLE_VIDEO_MAX,
} from './pub-video';

/**
 * LE CONTRÔLE D'UNE VIDÉO AVANT L'ENVOI : 100 Mo, 60 secondes, MP4 ou MOV.
 *
 * 🔴 Ce que ces cas défendent : une vidéo qui sera refusée n'est pas envoyée (cent mégaoctets pour rien), et une
 * vidéo dont on ne sait pas lire la durée n'est pas laissée passer, parce que ce contrôle est le seul qui tienne la
 * règle des 60 secondes quand le fichier ne porte pas sa durée au début.
 */

const MP4 = { type: 'video/mp4', name: 'pub.mp4', size: 20 * 1024 * 1024 };

describe('le contrôle avant l’envoi', () => {
  it('une vidéo de 20 Mo et 30 secondes passe', () => {
    expect(refusVideo(MP4, 30)).toBeNull();
  });

  it('🔴 au-delà de 100 Mo : refusée, et exactement 100 Mo passe', () => {
    expect(refusVideo({ ...MP4, size: TAILLE_VIDEO_MAX + 1 }, 30)).toBe('taille');
    expect(refusVideo({ ...MP4, size: TAILLE_VIDEO_MAX }, 30)).toBeNull();
  });

  it('🔴 au-delà de 60 secondes : refusée ; 60,3 s (un « 60 s » de téléphone) passe', () => {
    expect(refusVideo(MP4, 61)).toBe('duree');
    expect(refusVideo(MP4, 60.3)).toBeNull();
    expect(dureeTropLongue(60.6)).toBe(true);
  });

  it('🔴 une durée ILLISIBLE est un refus, pas un feu vert', () => {
    for (const d of [null, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(refusVideo(MP4, d), String(d)).toBe('duree_illisible');
    }
  });

  it('un fichier qui n’est pas une vidéo MP4 ou MOV est refusé avant tout le reste', () => {
    expect(refusVideo({ type: 'video/webm', name: 'a.webm', size: 10 }, 10)).toBe('type');
    expect(refusVideo({ type: 'image/png', name: 'a.png', size: TAILLE_VIDEO_MAX + 1 }, null)).toBe('type');
  });
});

describe('le type d’une vidéo', () => {
  it('lu sur ce qu’annonce le navigateur', () => {
    expect(typeVideoDe({ type: 'video/mp4', name: 'x' })).toBe('video/mp4');
    expect(typeVideoDe({ type: 'video/quicktime', name: 'x' })).toBe('video/quicktime');
  });

  it('⚠️ à défaut de type annoncé, sur l’extension (un .mov arrive parfois sans type)', () => {
    expect(typeVideoDe({ type: '', name: 'Tournage.MOV' })).toBe('video/quicktime');
    expect(typeVideoDe({ type: '', name: 'a.m4v' })).toBe('video/mp4');
    expect(typeVideoDe({ type: '', name: 'a.avi' })).toBeNull();
  });

  it('🔴 un type annoncé AUTRE ne se rattrape pas par l’extension', () => {
    expect(typeVideoDe({ type: 'text/html', name: 'piege.mp4' })).toBeNull();
  });
});

describe('le conseil de cadrage (jamais un refus)', () => {
  it('9:16 est vertical, 4:5 est le fil, le reste est autre', () => {
    expect(cadrageDe(1080, 1920)).toBe('vertical');
    expect(cadrageDe(1080, 1918)).toBe('vertical');
    expect(cadrageDe(1080, 1350)).toBe('fil');
    expect(cadrageDe(1920, 1080)).toBe('autre');
    expect(cadrageDe(0, 0)).toBeNull();
  });
});

describe('le morceau suivant', () => {
  it('rend ce que Meta demande', () => {
    expect(morceauSuivant(null, { debut: 0, fin: 100 }, 300)).toEqual({ debut: 0, fin: 100 });
    expect(morceauSuivant({ debut: 0, fin: 100 }, { debut: 100, fin: 300 }, 300)).toEqual({ debut: 100, fin: 300 });
  });

  it('des décalages égaux : tout est reçu', () => {
    expect(morceauSuivant({ debut: 100, fin: 300 }, { debut: 300, fin: 300 }, 300)).toBe('fini');
  });

  it('🔴 un Meta qui n’avance plus, ou qui demande au-delà du fichier : on s’arrête au lieu de boucler', () => {
    expect(morceauSuivant({ debut: 100, fin: 200 }, { debut: 100, fin: 200 }, 300)).toBeNull();
    expect(morceauSuivant(null, { debut: 0, fin: 400 }, 300)).toBeNull();
  });

  it('🔴 une réponse sans décalages n’est PAS « tout est reçu » : deux `undefined` égaux ne closent rien', () => {
    const vide = {} as { debut: number; fin: number };
    expect(morceauSuivant({ debut: 0, fin: 100 }, vide, 300)).toBeNull();
    expect(morceauSuivant(null, { debut: Number.NaN, fin: Number.NaN }, 300)).toBeNull();
  });
});

/* ── La durée lue dans le fichier (`mvhd`) ─────────────────────────────────────────────────────── */

/** Une boîte ISO BMFF : 4 octets de taille, 4 de nom, puis le contenu. */
function boite(nom: string, contenu: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + contenu.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = nom.charCodeAt(i);
  out.set(contenu, 8);
  return out;
}

/** Une boîte à taille étendue (`size = 1`, taille réelle sur 64 bits) : la forme d'un `mdat` de plus de 4 Go. */
function boiteEtendue(nom: string, contenu: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + contenu.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 1);
  for (let i = 0; i < 4; i += 1) out[4 + i] = nom.charCodeAt(i);
  v.setUint32(8, 0);
  v.setUint32(12, out.byteLength);
  out.set(contenu, 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.byteLength; }
  return out;
}

/** Une boîte `mvhd` de version 0 ou 1 : échelle et durée à leur place. */
function mvhd(version: 0 | 1, echelle: number, duree: number): Uint8Array {
  const corps = new Uint8Array(version === 1 ? 108 : 96);
  const v = new DataView(corps.buffer);
  v.setUint8(0, version);
  if (version === 1) { v.setUint32(20, echelle); v.setUint32(24, 0); v.setUint32(28, duree); } else { v.setUint32(12, echelle); v.setUint32(16, duree); }
  return boite('mvhd', corps);
}

const FTYP = boite('ftyp', new Uint8Array([0x71, 0x74, 0x20, 0x20, 0, 0, 2, 0])); // « qt  », un MOV d'iPhone

/** Un faux fichier : il rend les octets demandés, et compte ce qu'on lui a fait lire. */
function fichier(octets: Uint8Array): { lire: (a: number, b: number) => Promise<Uint8Array>; lus: () => number; taille: number } {
  let lus = 0;
  return {
    lire: async (a, b) => { lus += Math.max(0, b - a); return octets.slice(a, b); },
    lus: () => lus,
    taille: octets.byteLength,
  };
}

describe('la durée lue dans le fichier, sans décodeur', () => {
  it('`moov` au début (fast start) : lue', async () => {
    const f = fichier(concat(FTYP, boite('moov', mvhd(0, 600, 600 * 42)), boite('mdat', new Uint8Array(1000))));
    expect(await dureeDuFichier(f.lire, f.taille)).toBe(42);
  });

  it('🔴 `moov` À LA FIN, derrière un gros `mdat` (un MOV d’iPhone non réexporté) : lue, sans lire `mdat`', async () => {
    // C'est le cas qui refusait un MOV HEVC conforme sous Chrome Windows : le décodeur ne le lit pas, et la tête du
    // fichier ne porte pas la durée. On saute `mdat` par son en-tête au lieu de le lire.
    const mdat = boite('mdat', new Uint8Array(3 * 1024 * 1024));
    const f = fichier(concat(FTYP, mdat, boite('moov', mvhd(1, 90_000, 90_000 * 58))));
    expect(await dureeDuFichier(f.lire, f.taille)).toBe(58);
    expect(f.lus()).toBeLessThan(2048);
  });

  it('un `mdat` à taille étendue (64 bits) se saute aussi', async () => {
    const f = fichier(concat(FTYP, boiteEtendue('mdat', new Uint8Array(5000)), boite('moov', mvhd(0, 1000, 61_000))));
    expect(await dureeDuFichier(f.lire, f.taille)).toBe(61);
  });

  it('🔴 aucune `moov`, une boîte incohérente, ou `mvhd` absent : `null`, jamais une durée devinée', async () => {
    const sansMoov = fichier(concat(FTYP, boite('mdat', new Uint8Array(100))));
    expect(await dureeDuFichier(sansMoov.lire, sansMoov.taille)).toBeNull();
    const incoherent = concat(FTYP, new Uint8Array([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]));
    const f = fichier(incoherent);
    expect(await dureeDuFichier(f.lire, f.taille)).toBeNull();
    const sansMvhd = fichier(concat(FTYP, boite('moov', boite('trak', new Uint8Array(40)))));
    expect(await dureeDuFichier(sansMvhd.lire, sansMvhd.taille)).toBeNull();
  });

  it('🔴 un MP4 FRAGMENTÉ (`mvhd` à 0) : c’est le décodeur qui répond, pas un refus « durée illisible »', async () => {
    // MediaRecorder de Chrome, OBS : la durée vit dans les fragments, `mvhd` porte 0.
    const f = fichier(concat(FTYP, boite('moov', mvhd(0, 1000, 0)), boite('moof', new Uint8Array(40))));
    const conteneur = await dureeDuFichier(f.lire, f.taille);
    expect(conteneur).toBe(0);
    expect(dureeRetenue(conteneur, 42.5)).toBe(42.5);
    expect(refusVideo({ type: 'video/mp4', name: 'enregistrement.mp4', size: f.taille }, dureeRetenue(conteneur, 42.5))).toBeNull();
  });

  it('la durée du conteneur l’emporte quand elle est une vraie durée ; sinon, le décodeur', () => {
    expect(dureeRetenue(30, 29.9)).toBe(30);
    expect(dureeRetenue(30, null)).toBe(30);
    for (const c of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(dureeRetenue(c, 12), String(c)).toBe(12);
    expect(dureeRetenue(null, null)).toBeNull();
  });

  it('⚠️ une durée lue au-delà de la borne reste un refus : la lecture ne change pas la règle', async () => {
    const f = fichier(concat(FTYP, boite('mdat', new Uint8Array(10)), boite('moov', mvhd(0, 1000, 75_000))));
    const duree = await dureeDuFichier(f.lire, f.taille);
    expect(refusVideo({ type: 'video/quicktime', name: 'IMG_0001.MOV', size: f.taille }, duree)).toBe('duree');
  });
});
