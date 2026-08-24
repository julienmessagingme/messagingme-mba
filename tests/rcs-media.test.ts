import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import {
  typeImage, extensionDe, mimeDeExtension, octetsDepuisDataUrl, urlImageRcs, TAILLE_IMAGE_MAX,
} from '../src/rcs/image';
import type { MimeImage } from '../src/rcs/image';
import type { RcsMediaResume, RcsMediaFichier } from '../src/rcs/media-store.pg';

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

function appWith(stocke: { bytes: Buffer; mime: MimeImage } | null) {
  const crees: Array<{ mime: MimeImage; taille: number; nom: string | null }> = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    rcsMedia: {
      list: async (): Promise<RcsMediaResume[]> => [],
      create: async (_t, input) => {
        crees.push({ mime: input.mime, taille: input.bytes.length, nom: input.nom });
        return {
          media: { id: 'm1', code: CODE, mime: input.mime, taille: input.bytes.length, nom: input.nom, createdAt: '' },
          url: urlImageRcs('https://mba.messagingme.app', CODE, input.mime),
        };
      },
      remove: async () => true,
      getByCode: async (code): Promise<RcsMediaFichier | null> => (code === CODE && stocke ? stocke : null),
    },
  });
  return { app, crees };
}

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
  it('REFUSE un fichier qui n est pas une image, meme s il se declare comme telle', async () => {
    const { app, crees } = appWith(null);
    const r = await app.inject({
      method: 'POST',
      url: '/tenants/t1/rcs/media',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await jeton('admin')}` },
      payload: { dataUrl: `data:image/png;base64,${PDF.toString('base64')}`, nom: 'piege.png' },
    });
    expect(r.statusCode).toBe(415);
    expect(crees).toHaveLength(0);
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
    expect(r.headers['cache-control']).toContain('immutable');
    expect(r.rawPayload.equals(PNG)).toBe(true);
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
