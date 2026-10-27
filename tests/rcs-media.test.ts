import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import {
  typeImage, extensionDe, mimeDeExtension, octetsDepuisDataUrl, urlImageRcs, TAILLE_IMAGE_MAX,
} from '../src/rcs/image';
import type { MimeImage } from '../src/rcs/image';
import { urlFichier, type MimeFichier } from '../src/medias/fichier';
import { Readable } from 'node:stream';
import type { RcsMediaServi, IssueSuppression } from '../src/rcs/media-store.pg';
import { LimiteOffreError } from '../src/offres/refus';

/** Signatures REELLES, suivies de remplissage : `typeImage` ne lit que les premiers octets. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7', 'ascii'), Buffer.alloc(16, 7)]);
const CODE = 'abcdefghjkmnpqrstvwxyz0123';

describe('Reconnaitre une image a ses octets', () => {
  it('reconnait les trois formats que l operateur accepte', () => {
    expect(typeImage(PNG)).toBe('image/png');
    expect(typeImage(JPEG)).toBe('image/jpeg');
    expect(typeImage(GIF)).toBe('image/gif');
  });

  /**
   * 🔴 Le coeur du sujet. Ces fichiers finissent servis sur une URL PUBLIQUE : servir un fichier pour ce qu'il
   * PRETEND etre est la facon classique de transformer un hebergeur d'images en hebergeur de pages. C'est la
   * signature qui tranche, jamais le type annonce par le navigateur.
   */
  it('REFUSE ce qui n est pas une de ces trois images, quel que soit le type annonce', () => {
    expect(typeImage(PDF)).toBeNull();
    expect(typeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'ascii'))).toBeNull();
    expect(typeImage(Buffer.from('<!doctype html><script>alert(1)</script>', 'ascii'))).toBeNull();
    expect(typeImage(Buffer.alloc(0))).toBeNull();
    expect(typeImage(Buffer.from([0x89, 0x50]))).toBeNull(); // signature tronquee
  });

  it('donne l extension attendue par le fournisseur, et sait la relire', () => {
    expect(extensionDe('image/jpeg')).toBe('jpg');
    expect(extensionDe('image/png')).toBe('png');
    expect(extensionDe('image/gif')).toBe('gif');
    expect(mimeDeExtension('JPG')).toBe('image/jpeg');
    expect(mimeDeExtension('jpeg')).toBe('image/jpeg');
    expect(mimeDeExtension('webp')).toBeNull();
    expect(mimeDeExtension('')).toBeNull();
  });

  it('lit une data URL, et ne leve jamais sur une forme inattendue', () => {
    expect(octetsDepuisDataUrl(`data:image/png;base64,${PNG.toString('base64')}`)).toEqual(PNG);
    for (const brut of ['', 'pas une data url', 'data:image/png;base64,', 'data:image/png,abc', 'http://x/i.png']) {
      expect(octetsDepuisDataUrl(brut)).toBeNull();
    }
  });

  // L'extension est portee par le CHEMIN : c'est ce que le fournisseur regarde, une URL sans extension est
  // refusee a l'envoi quelle que soit l'en-tete de reponse.
  it('construit une URL publique qui FINIT par l extension', () => {
    expect(urlImageRcs('https://mba.messagingme.app/', CODE, 'image/jpeg'))
      .toBe(`https://mba.messagingme.app/m/${CODE}.jpg`);
    expect(urlImageRcs('https://mba.messagingme.app', CODE, 'image/gif'))
      .toBe(`https://mba.messagingme.app/m/${CODE}.gif`);
  });
});

const SECRET = 'test-secret';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

async function jeton(role: 'admin' | 'agent'): Promise<string> {
  return signSession({ userId: 'u1', tenantId: 't1', role }, SECRET);
}

function appWith(
  stocke: { bytes: Buffer; mime: MimeImage; auBucket?: boolean } | null,
  o: { quotaAtteint?: boolean; suppression?: IssueSuppression; prive?: { bytes: Buffer; mime: MimeFichier; nom: string | null } } = {},
) {
  const crees: Array<{ mime: MimeFichier; taille: number; nom: string | null }> = [];
  const supprimes: Array<{ tenant: string; code: string }> = [];
  /** Les flux rendus par le faux magasin (fichier au bucket) : un flux ouvert pour rien doit être fermé. */
  const flux: Readable[] = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    rcsMedia: {
      medias: {
        getByCode: async (code): Promise<RcsMediaServi | null> => {
          if (code !== CODE || !stocke) return null;
          if (!stocke.auBucket) return { contenu: stocke.bytes, mime: stocke.mime, taille: stocke.bytes.length };
          const f = Readable.from([stocke.bytes]);
          flux.push(f);
          return { contenu: f, mime: stocke.mime, taille: stocke.bytes.length };
        },
      },
      create: async (t, input) => {
        if (o.quotaAtteint) throw new LimiteOffreError(t, 'stockageOctets', 100 * 1024 * 1024);
        crees.push({ mime: input.mime, taille: input.bytes.length, nom: input.nom });
        return {
          media: { id: 'm1', code: CODE, mime: input.mime, taille: input.bytes.length, nom: input.nom, createdAt: '' },
          url: urlFichier('https://mba.messagingme.app', CODE, input.mime),
          existant: false,
        };
      },
      lister: async () => ({
        fichiers: [{ id: 'm1', code: CODE, mime: 'image/png' as const, taille: 1234, nom: 'visuel.png', createdAt: '2026-10-15T00:00:00.000Z', url: `https://mba.messagingme.app/m/${CODE}.png` }],
        occupation: 1234,
        quota: 100 * 1024 * 1024,
      }),
      supprimer: async (tenant, code) => {
        supprimes.push({ tenant, code });
        return o.suppression ?? { issue: 'supprime' };
      },
      lire: async (tenant, code) => (tenant === 't1' && code === CODE && o.prive ? o.prive : null),
    },
  });
  return { app, crees, supprimes, flux };
}

describe('La médiathèque : quota, liste, suppression (spec médias, lot B)', () => {
  const entetes = async (role: 'admin' | 'agent') => ({ 'content-type': 'application/json', authorization: `Bearer ${await jeton(role)}` });

  it('🔴 un dépôt au-delà du quota rend le refus de l’offre (402, plan_limit_reached), pas une erreur serveur', async () => {
    const { app, crees } = appWith(null, { quotaAtteint: true });
    const r = await app.inject({
      method: 'POST', url: '/tenants/t1/rcs/media', headers: await entetes('admin'),
      payload: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    });
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ code: 'plan_limit_reached', limite: 'stockageOctets' });
    expect(crees).toHaveLength(0);
  });

  it('liste les fichiers avec leur adresse, l’occupation et le quota, pour tout membre de l’espace', async () => {
    const { app } = appWith(null);
    const r = await app.inject({ method: 'GET', url: '/tenants/t1/rcs/media', headers: { authorization: `Bearer ${await jeton('agent')}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ occupation: 1234, quota: 100 * 1024 * 1024, fichiers: [{ code: CODE, nom: 'visuel.png' }] });
  });

  it('supprime un fichier inutilisé (204), dans l’espace de la session', async () => {
    const { app, supprimes } = appWith(null);
    const r = await app.inject({ method: 'DELETE', url: `/tenants/t1/rcs/media/${CODE}`, headers: { authorization: `Bearer ${await jeton('admin')}` } });
    expect(r.statusCode).toBe(204);
    expect(supprimes).toEqual([{ tenant: 't1', code: CODE }]);
  });

  it('🔴 refuse de supprimer un fichier encore utilisé (409), en disant ce qui l’utilise', async () => {
    const { app } = appWith(null, { suppression: { issue: 'utilise', utilisations: [{ lieu: 'scenario', nom: 'Bienvenue' }] } });
    const r = await app.inject({ method: 'DELETE', url: `/tenants/t1/rcs/media/${CODE}`, headers: { authorization: `Bearer ${await jeton('admin')}` } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'media_utilise', utilisations: [{ lieu: 'scenario', nom: 'Bienvenue' }] });
  });

  it('rend 404 pour un fichier introuvable, et pour un code mal formé sans toucher au store', async () => {
    const { app, supprimes } = appWith(null, { suppression: { issue: 'introuvable' } });
    const h = { authorization: `Bearer ${await jeton('admin')}` };
    expect((await app.inject({ method: 'DELETE', url: `/tenants/t1/rcs/media/${CODE}`, headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/tenants/t1/rcs/media/pas-un-code', headers: h })).statusCode).toBe(404);
    expect(supprimes).toHaveLength(1);
  });

  it('réserve la suppression aux admins', async () => {
    const { app, supprimes } = appWith(null);
    const r = await app.inject({ method: 'DELETE', url: `/tenants/t1/rcs/media/${CODE}`, headers: { authorization: `Bearer ${await jeton('agent')}` } });
    expect(r.statusCode).toBe(403);
    expect(supprimes).toHaveLength(0);
  });
});

describe('Televerser un visuel RCS', () => {
  it('accepte une image et rend son ADRESSE PUBLIQUE, avec la bonne extension', async () => {
    const { app, crees } = appWith(null);
    const r = await app.inject({
      method: 'POST',
      url: '/tenants/t1/rcs/media',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('admin')}` },
      payload: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, nom: 'visuel.png' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().url).toBe(`https://mba.messagingme.app/m/${CODE}.png`);
    expect(crees).toEqual([{ mime: 'image/png', taille: PNG.length, nom: 'visuel.png' }]);
  });

  // 🔴 Le type REEL prime sur le type annonce : ici un PDF se presente en `image/png`.
  it('REFUSE un fichier qui n est pas un type accepte, meme s il se declare image', async () => {
    const { app, crees } = appWith(null);
    const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'ascii');
    const r = await app.inject({
      method: 'POST',
      url: '/tenants/t1/rcs/media',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('admin')}` },
      payload: { dataUrl: `data:image/png;base64,${HTML.toString('base64')}`, nom: 'piege.png' },
    });
    expect(r.statusCode).toBe(415);
    expect(crees).toHaveLength(0);
  });

  // Depuis le lot C, un PDF est accepte : deguise en PNG, il reste un PDF (son type REEL), jamais une image servie par /m/.
  it('un PDF qui se declare image est range comme PDF, son type reel', async () => {
    const { app, crees } = appWith(null);
    const r = await app.inject({
      method: 'POST',
      url: '/tenants/t1/rcs/media',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('admin')}` },
      payload: { dataUrl: `data:image/png;base64,${PDF.toString('base64')}`, nom: 'piege.png' },
    });
    expect(r.statusCode).toBe(201);
    expect(crees.map((c) => c.mime)).toEqual(['application/pdf']);
  });

  it('REFUSE une image trop lourde', async () => {
    const { app, crees } = appWith(null);
    const gros = Buffer.concat([PNG, Buffer.alloc(TAILLE_IMAGE_MAX, 3)]);
    const r = await app.inject({
      method: 'POST',
      url: '/tenants/t1/rcs/media',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('admin')}` },
      payload: { dataUrl: `data:image/png;base64,${gros.toString('base64')}` },
    });
    expect(r.statusCode).toBe(413);
    expect(crees).toHaveLength(0);
  });

  it('reserve le televersement aux admins', async () => {
    const { app, crees } = appWith(null);
    const r = await app.inject({
      method: 'POST',
      url: '/tenants/t1/rcs/media',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('agent')}` },
      payload: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    });
    expect(r.statusCode).toBe(403);
    expect(crees).toHaveLength(0);
  });
});

describe('Servir un visuel RCS (route PUBLIQUE)', () => {
  it('sert le fichier SANS session : c est l operateur telecom qui le telecharge', async () => {
    const { app } = appWith({ bytes: PNG, mime: 'image/png' });
    const r = await app.inject({ method: 'GET', url: `/m/${CODE}.png` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    // 🔴 Un JOUR, pas un an, et surtout pas `immutable` : mesure du 2026-08-24, Cloudflare met ces images en
    // cache au bord et continuait de servir un visuel SUPPRIME pendant que l'origine repondait 404.
    expect(r.headers['cache-control']).toBe('public, max-age=86400');
    expect(r.headers['cache-control']).not.toContain('immutable');
    expect(r.rawPayload.equals(PNG)).toBe(true);
  });

  // Lot A des medias : au bucket, la route recoit un FLUX, et l'envoie avec le poids de la fiche.
  it('sert un fichier du bucket en flux, memes en-tetes, avec son poids', async () => {
    const { app } = appWith({ bytes: PNG, mime: 'image/png', auBucket: true });
    const r = await app.inject({ method: 'GET', url: `/m/${CODE}.png` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('public, max-age=86400');
    expect(r.headers['content-length']).toBe(String(PNG.length));
    expect(r.rawPayload.equals(PNG)).toBe(true);
  });

  it('un flux du bucket ouvert pour une mauvaise extension est FERME (sa connexion ne reste pas prise)', async () => {
    const { app, flux } = appWith({ bytes: PNG, mime: 'image/png', auBucket: true });
    expect((await app.inject({ method: 'GET', url: `/m/${CODE}.jpg` })).statusCode).toBe(404);
    expect(flux).toHaveLength(1);
    expect(flux[0]!.destroyed).toBe(true);
  });

  // Servir un PNG sous une adresse en `.jpg` trompe le cache autant que l'operateur.
  it('REFUSE une extension qui ne correspond pas au fichier stocke', async () => {
    const { app } = appWith({ bytes: PNG, mime: 'image/png' });
    expect((await app.inject({ method: 'GET', url: `/m/${CODE}.jpg` })).statusCode).toBe(404);
  });

  it('REFUSE un code inconnu, une forme de code invalide, et une extension inconnue', async () => {
    const { app } = appWith({ bytes: PNG, mime: 'image/png' });
    for (const url of [
      '/m/00000000000000000000000000.png',
      '/m/trop-court.png',
      `/m/${CODE}.webp`,
      `/m/${CODE}`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});

/** Un MP4 minimal, boîte par boîte (les mêmes que `tests/medias-fichier.test.ts`). */
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const boite = (type: string, ...contenus: Buffer[]): Buffer => { const c = Buffer.concat(contenus); return Buffer.concat([u32(8 + c.length), Buffer.from(type, 'ascii'), c]); };
const pleine = (type: string, ...c: Buffer[]) => boite(type, Buffer.alloc(4), ...c);
const mp4 = (codec: string) => Buffer.concat([
  boite('ftyp', Buffer.from('isom', 'ascii'), u32(512)),
  boite('moov', boite('trak', boite('mdia',
    pleine('hdlr', Buffer.alloc(4), Buffer.from('vide', 'ascii'), Buffer.alloc(12)),
    boite('minf', boite('stbl', pleine('stsd', u32(1), boite(codec, Buffer.alloc(78), boite('avcC', Buffer.from([1, 77, 0, 31]))))))))),
]);

describe('La médiathèque accepte la vidéo MP4 et le PDF (spec médias, lot C)', () => {
  const poster = async (app: ReturnType<typeof appWith>['app'], mime: string, octets: Buffer, nom?: string) => app.inject({
    method: 'POST', url: '/tenants/t1/rcs/media',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('admin')}` },
    payload: { dataUrl: `data:${mime};base64,${octets.toString('base64')}`, ...(nom !== undefined ? { nom } : {}) },
  });

  it('accepte un MP4 en H.264 et un PDF, chacun sous son type RÉEL', async () => {
    const { app, crees } = appWith(null);
    expect((await poster(app, 'video/mp4', mp4('avc1'), 'demo.mp4')).statusCode).toBe(201);
    expect((await poster(app, 'application/pdf', PDF, 'devis.pdf')).statusCode).toBe(201);
    expect(crees.map((c) => c.mime)).toEqual(['video/mp4', 'application/pdf']);
  });

  it('🔴 refuse le HEVC d’un iPhone (415), avec la raison qui dit quoi faire', async () => {
    const { app, crees } = appWith(null);
    const r = await poster(app, 'video/mp4', mp4('hvc1'));
    expect(r.statusCode).toBe(415);
    expect(r.json().error).toMatch(/HEVC/);
    expect(crees).toHaveLength(0);
  });

  it('16 Mo pour une vidéo ou un PDF, 2 Mo pour une image', async () => {
    const { app, crees } = appWith(null);
    const gros = Buffer.concat([PDF, Buffer.alloc(16 * 1024 * 1024, 1)]);
    expect((await poster(app, 'application/pdf', gros)).statusCode).toBe(413);
    expect(crees).toHaveLength(0);
  });

  it('🔴 point de revue 5 : un nom hostile est nettoyé (ni chemin, ni caractère de contrôle, borné)', async () => {
    const { app, crees } = appWith(null);
    await poster(app, 'application/pdf', PDF, '..\\..\\/etc/pass\u0000wd.pdf');
    await poster(app, 'application/pdf', PDF, 'x'.repeat(300));
    expect(crees[0]!.nom).toBe('passwd.pdf');
    expect(crees[1]!.nom).toHaveLength(120);
  });

  it('🔴 /m/ ne sert JAMAIS une vidéo ni un PDF : leur adresse n’est pas publique', async () => {
    const { app } = appWith({ bytes: PDF, mime: 'application/pdf' as never });
    expect((await app.inject({ method: 'GET', url: `/m/${CODE}.pdf` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/m/${CODE}.mp4` })).statusCode).toBe(404);
  });

  it('ouvre un fichier de l’espace sous session, en pièce jointe pour un PDF, avec nosniff', async () => {
    const { app } = appWith(null, { prive: { bytes: PDF, mime: 'application/pdf', nom: 'devis.pdf' } });
    const r = await app.inject({ method: 'GET', url: `/tenants/t1/rcs/media/${CODE}/fichier`, headers: { authorization: `Bearer ${await jeton('agent')}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
    expect(r.rawPayload.equals(PDF)).toBe(true);
    const absent = await app.inject({ method: 'GET', url: '/tenants/t1/rcs/media/00000000000000000000000000/fichier', headers: { authorization: `Bearer ${await jeton('agent')}` } });
    expect(absent.statusCode).toBe(404);
  });
});

describe('🔴 un MOV d’iPhone est refusé en le NOMMANT (relecture du lot C, n° 3)', () => {
  it('415 avec la marche à suivre vers le MP4', async () => {
    const { app, crees } = appWith(null);
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  ', 'ascii'), Buffer.alloc(12)]);
    const r = await app.inject({
      method: 'POST', url: '/tenants/t1/rcs/media',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('admin')}` },
      payload: { dataUrl: `data:video/quicktime;base64,${mov.toString('base64')}` },
    });
    expect(r.statusCode).toBe(415);
    expect(r.json().error).toMatch(/MOV/);
    expect(r.json().error).toMatch(/MP4/);
    expect(crees).toHaveLength(0);
  });
});
