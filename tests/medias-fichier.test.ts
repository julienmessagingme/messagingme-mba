import { describe, it, expect } from 'vitest';
import { typeFichier, verifierVideo } from '../src/medias/fichier';

/**
 * RECONNAÎTRE UN FICHIER DE LA MÉDIATHÈQUE À SES OCTETS (spec médias du 2026-10-14, § 3.1), et lire l'encodage d'une
 * vidéo AVANT de l'accepter : Meta accepte le téléversement d'un MP4 qu'il ne livrera pas (HEVC), ou qu'Android ne lira
 * pas (H.264 profil High avec images B). Les vidéos sont construites ici, boîte par boîte : aucun fichier vidéo au dépôt.
 */
const ascii = (s: string) => Buffer.from(s, 'ascii');
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
/** Une boîte MP4 : taille (4 octets), type (4 caractères), contenu. */
const boite = (type: string, ...contenus: Buffer[]): Buffer => {
  const corps = Buffer.concat(contenus);
  return Buffer.concat([u32(8 + corps.length), ascii(type), corps]);
};
const pleine = (type: string, ...contenus: Buffer[]) => boite(type, Buffer.alloc(4), ...contenus); // version + drapeaux

const ftyp = (marque = 'isom') => boite('ftyp', ascii(marque), u32(512), ascii('isomiso2avc1mp41'));
/** L'entrée d'échantillon VISUELLE : 78 octets de champs fixes, puis ses boîtes filles (avcC). */
const entreeVideo = (codec: string, profil: number) =>
  boite(codec, Buffer.alloc(78), boite('avcC', Buffer.from([1, profil, 0, 31, 0xff])));
const entreeSon = (codec: string) => boite(codec, Buffer.alloc(28));
const piste = (genre: 'vide' | 'soun', entree: Buffer, enPlus: Buffer[] = []) =>
  boite('trak', boite('mdia',
    pleine('hdlr', Buffer.alloc(4), ascii(genre), Buffer.alloc(12)),
    boite('minf', boite('stbl', pleine('stsd', u32(1), entree), ...enPlus)),
  ));
const ctts = pleine('ctts', u32(0));
const mp4 = (...pistes: Buffer[]) => Buffer.concat([ftyp(), boite('moov', pleine('mvhd', Buffer.alloc(96)), ...pistes)]);

const H264_MAIN = 77;
const H264_HIGH = 100;

describe('typeFichier : la signature tranche, jamais le type annoncé', () => {
  it('reconnaît les images, un MP4 et un PDF', () => {
    expect(typeFichier(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(typeFichier(mp4(piste('vide', entreeVideo('avc1', H264_MAIN))))).toBe('video/mp4');
    expect(typeFichier(ascii('%PDF-1.7\n%âãÏÓ'))).toBe('application/pdf');
  });

  it('🔴 point de revue 1 : un MOV renommé en .mp4 (marque « qt  ») est refusé, Meta ne le livrerait pas', () => {
    expect(typeFichier(Buffer.concat([ftyp('qt  '), boite('moov')]))).toBeNull();
  });

  it('refuse un 3GP (MP4 seulement, décision du 2026-10-14), un SVG, du HTML, un fichier vide ou tronqué', () => {
    expect(typeFichier(Buffer.concat([ftyp('3gp4'), boite('moov')]))).toBeNull();
    expect(typeFichier(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(typeFichier(ascii('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(typeFichier(Buffer.alloc(0))).toBeNull();
    expect(typeFichier(ascii('\0\0\0\x18ft'))).toBeNull();
  });
});

describe('verifierVideo : ce que WhatsApp livre, et ce qu’Android lit', () => {
  it('accepte du H.264 profil Main, avec images B (ctts) et un son AAC', () => {
    expect(verifierVideo(mp4(piste('vide', entreeVideo('avc1', H264_MAIN), [ctts]), piste('soun', entreeSon('mp4a'))))).toBeNull();
  });

  it('accepte du H.264 profil High SANS images B, et une vidéo sans son', () => {
    expect(verifierVideo(mp4(piste('vide', entreeVideo('avc1', H264_HIGH))))).toBeNull();
    expect(verifierVideo(mp4(piste('vide', entreeVideo('avc3', H264_MAIN))))).toBeNull();
  });

  it('🔴 refuse le HEVC d’un iPhone, en disant quoi faire', () => {
    for (const codec of ['hvc1', 'hev1']) {
      const raison = verifierVideo(mp4(piste('vide', boite(codec, Buffer.alloc(78)))));
      expect(raison).toMatch(/HEVC/);
      expect(raison).toMatch(/H\.264/);
    }
  });

  it('🔴 refuse le profil High AVEC images B : Android ne le lit pas', () => {
    const raison = verifierVideo(mp4(piste('vide', entreeVideo('avc1', H264_HIGH), [ctts])));
    expect(raison).toMatch(/Android/);
    expect(raison).toMatch(/Main|Baseline/);
  });

  it('refuse un son qui n’est pas en AAC, et plus d’une piste son', () => {
    expect(verifierVideo(mp4(piste('vide', entreeVideo('avc1', H264_MAIN)), piste('soun', entreeSon('Opus'))))).toMatch(/AAC/);
    expect(verifierVideo(mp4(piste('vide', entreeVideo('avc1', H264_MAIN)), piste('soun', entreeSon('mp4a')), piste('soun', entreeSon('mp4a')))))
      .toMatch(/piste/);
  });

  it('lit une vidéo dont l’index (moov) est en FIN de fichier, après les données', () => {
    const fin = Buffer.concat([ftyp(), boite('mdat', Buffer.alloc(64, 7)), boite('moov', piste('vide', entreeVideo('avc1', H264_MAIN)))]);
    expect(verifierVideo(fin)).toBeNull();
  });

  it('refuse une vidéo sans piste vidéo, ou dont l’index est illisible, sans jamais lever', () => {
    expect(verifierVideo(mp4(piste('soun', entreeSon('mp4a'))))).toMatch(/vidéo/);
    expect(verifierVideo(Buffer.concat([ftyp(), boite('mdat', Buffer.alloc(16))]))).toMatch(/illisible/);
    // Une boîte qui annonce plus d'octets qu'il n'en reste.
    const tronque = Buffer.concat([ftyp(), u32(9999), ascii('moov'), Buffer.alloc(8)]);
    expect(verifierVideo(tronque)).toMatch(/illisible/);
  });
});

describe('le nom gardé, l’adresse rendue, le plafond (spec médias, § 3.1 et point de revue 5)', () => {
  it('🔴 un nom hostile perd son chemin et ses caractères de contrôle, et reste borné', async () => {
    const { nomDeFichier } = await import('../src/medias/fichier');
    expect(nomDeFichier('..\\..\\/etc/pass\u0000wd.pdf')).toBe('passwd.pdf');
    expect(nomDeFichier('C:\\Users\\moi\\Devis 2026.pdf')).toBe('Devis 2026.pdf');
    expect(nomDeFichier('x'.repeat(300))).toHaveLength(120);
    expect(nomDeFichier('  ')).toBeNull();
    expect(nomDeFichier(42)).toBeNull();
  });

  it('l’adresse publique finit par l’extension du type RÉEL', async () => {
    const { urlFichier } = await import('../src/medias/fichier');
    expect(urlFichier('https://api.messagingme.app/', 'abc', 'video/mp4')).toBe('https://api.messagingme.app/m/abc.mp4');
    expect(urlFichier('https://api.messagingme.app', 'abc', 'application/pdf')).toBe('https://api.messagingme.app/m/abc.pdf');
    expect(urlFichier('https://api.messagingme.app', 'abc', 'image/jpeg')).toBe('https://api.messagingme.app/m/abc.jpg');
  });

  it('16 Mo pour une vidéo ou un PDF : la constante de l’en-tête vidéo des templates', async () => {
    const { TAILLE_VIDEO_PDF_MAX } = await import('../src/medias/fichier');
    expect(TAILLE_VIDEO_PDF_MAX).toBe(16 * 1024 * 1024);
  });
});

describe('genreParAdresse : l’extension d’une adresse /m/ dit le genre du fichier (spec médias, § 3.3)', () => {
  it('image, vidéo, document, et null pour une adresse sans extension connue (traitée comme avant)', async () => {
    const { genreParAdresse } = await import('../src/medias/fichier');
    expect(genreParAdresse('https://api.messagingme.app/m/abc.png')).toBe('image');
    expect(genreParAdresse('https://api.messagingme.app/m/abc.JPG')).toBe('image');
    expect(genreParAdresse('https://api.messagingme.app/m/abc.mp4')).toBe('video');
    expect(genreParAdresse('https://api.messagingme.app/m/abc.pdf?v=2')).toBe('document');
    expect(genreParAdresse('https://exemple.fr/visuel')).toBeNull();
    expect(genreParAdresse('pas une adresse')).toBeNull();
  });
});

describe('🔴 la vidéo d’un iPhone est un MOV : son refus dit quoi faire (relecture du lot C, n° 3)', () => {
  it('reconnaît un QuickTime à sa marque, pour le nommer dans le refus', async () => {
    const { estQuickTime } = await import('../src/medias/fichier');
    const u = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    expect(estQuickTime(Buffer.concat([u(20), Buffer.from('ftypqt  ', 'ascii'), u(0)]))).toBe(true);
    expect(estQuickTime(Buffer.concat([u(20), Buffer.from('ftypisom', 'ascii'), u(0)]))).toBe(false);
    expect(estQuickTime(Buffer.alloc(3))).toBe(false);
  });

  it('le conseil HEVC mène au MP4 H.264, jamais à un autre MOV', async () => {
    const { verifierVideo } = await import('../src/medias/fichier');
    const u = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const boite = (t: string, ...c: Buffer[]) => { const x = Buffer.concat(c); return Buffer.concat([u(8 + x.length), Buffer.from(t, 'ascii'), x]); };
    const pleine = (t: string, ...c: Buffer[]) => boite(t, Buffer.alloc(4), ...c);
    const hevc = Buffer.concat([boite('ftyp', Buffer.from('isom', 'ascii'), u(1)), boite('moov', boite('trak', boite('mdia',
      pleine('hdlr', Buffer.alloc(4), Buffer.from('vide', 'ascii'), Buffer.alloc(12)),
      boite('minf', boite('stbl', pleine('stsd', u(1), boite('hvc1', Buffer.alloc(78))))))))]);
    const raison = verifierVideo(hevc)!;
    expect(raison).toMatch(/MP4/);
    expect(raison).not.toMatch(/Le plus compatible/);
  });
});

describe('le parseur face aux MP4 réels (relecture du lot C, n° 4)', () => {
  const u = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const boite = (t: string, ...c: Buffer[]) => { const x = Buffer.concat(c); return Buffer.concat([u(8 + x.length), Buffer.from(t, 'ascii'), x]); };
  const pleine = (t: string, ...c: Buffer[]) => boite(t, Buffer.alloc(4), ...c);
  const trak = (profil: number) => boite('trak', boite('mdia',
    pleine('hdlr', Buffer.alloc(4), Buffer.from('vide', 'ascii'), Buffer.alloc(12)),
    boite('minf', boite('stbl', pleine('stsd', u(1), boite('avc1', Buffer.alloc(78), boite('avcC', Buffer.from([1, profil, 0, 31]))))))));
  const ftyp = boite('ftyp', Buffer.from('isom', 'ascii'), u(1));

  it('🔴 un MP4 FRAGMENTÉ en profil High est refusé : ses images B ne se voient pas dans moov, Android ne le lirait pas', async () => {
    const { verifierVideo } = await import('../src/medias/fichier');
    expect(verifierVideo(Buffer.concat([ftyp, boite('moov', trak(100), boite('mvex', pleine('trex', Buffer.alloc(20))))]))).toMatch(/Android/);
    expect(verifierVideo(Buffer.concat([ftyp, boite('moov', trak(77), boite('mvex', pleine('trex', Buffer.alloc(20))))]))).toBeNull();
  });

  it('des octets parasites APRÈS la dernière boîte ne font pas refuser une vidéo correcte', async () => {
    const { verifierVideo } = await import('../src/medias/fichier');
    const correcte = Buffer.concat([ftyp, boite('moov', trak(77)), boite('mdat', Buffer.alloc(32, 1))]);
    expect(verifierVideo(Buffer.concat([correcte, Buffer.from([0, 0, 0xff, 0xff, 1, 2, 3])]))).toBeNull();
    // Une traîne qui ressemble à une boîte mais annonce une taille impossible (certains téléphones en ajoutent une).
    expect(verifierVideo(Buffer.concat([correcte, u(0x00100000), Buffer.from('SEFT', 'ascii'), Buffer.alloc(8)]))).toBeNull();
  });
});

describe('le nom d’un fichier se borne en CARACTÈRES, jamais au milieu d’un émoji (relecture du lot C, n° 8)', () => {
  it('120 caractères, l’émoji du bord gardé entier', async () => {
    const { nomDeFichier } = await import('../src/medias/fichier');
    const n = nomDeFichier(`${'x'.repeat(119)}\u{1F600}yy.pdf`)!;
    expect(Array.from(n)).toHaveLength(120);
    expect(n.endsWith('\u{1F600}')).toBe(true);
    // Aucune moitié orpheline : ni une haute sans sa basse, ni une basse sans sa haute.
    expect(n).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
