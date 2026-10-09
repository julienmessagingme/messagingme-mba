import { describe, it, expect } from 'vitest';
import { PLAFONDS_ENTETE, telechargerEntete, type DepsTelechargement } from '../src/api/entete-par-url';

/**
 * L'EN-TÊTE D'UN MODÈLE PAR SON ADRESSE (lot 13, domaine 3) : notre serveur télécharge un fichier à une adresse saisie
 * par un client, donc avec toutes les gardes d'une telle adresse (SSRF), et le type est décidé par les octets.
 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(8)]);
const PDF = Buffer.from('%PDF-1.7\n...');

const deps = (rep: Response | (() => Promise<Response>), ok = true): DepsTelechargement & { appels: number } => {
  const d = {
    appels: 0,
    verifier: async () => (ok ? { ok: true } : { ok: false, raison: 'ce nom pointe vers une adresse interne' }),
    fetch: (async () => {
      d.appels += 1;
      return typeof rep === 'function' ? rep() : rep;
    }) as unknown as typeof fetch,
  };
  return d;
};
const URL_OK = 'https://exemple.fr/fichier';

describe('le téléchargement d’un en-tête', () => {
  it('🔴 une image, une vidéo, un document : les octets et le type lu dans leur signature', async () => {
    expect(await telechargerEntete(deps(new Response(JPEG)), 'IMAGE', URL_OK)).toEqual({ octets: JPEG, mime: 'image/jpeg' });
    expect(await telechargerEntete(deps(new Response(MP4)), 'VIDEO', URL_OK)).toEqual({ octets: MP4, mime: 'video/mp4' });
    expect(await telechargerEntete(deps(new Response(PDF)), 'DOCUMENT', URL_OK)).toEqual({ octets: PDF, mime: 'application/pdf' });
  });

  it('🔴 une vidéo : MP4 seulement, pas un autre fichier de la famille ISO (HEIC, MOV)', async () => {
    const famille = (marque: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${marque}`), Buffer.alloc(8)]);
    for (const marque of ['heic', 'qt  ', 'M4A ']) {
      expect(await telechargerEntete(deps(new Response(famille(marque))), 'VIDEO', URL_OK), marque).toEqual({ refus: expect.stringMatching(/MP4/) });
    }
    expect(await telechargerEntete(deps(new Response(famille('isom'))), 'VIDEO', URL_OK)).toMatchObject({ mime: 'video/mp4' });
  });

  it('un statut d’échec : le corps est rendu tout de suite, la connexion ne reste pas tenue', async () => {
    let annule = false;
    const corps = new ReadableStream({ cancel() { annule = true; } });
    expect(await telechargerEntete(deps(new Response(corps, { status: 500 })), 'IMAGE', URL_OK)).toEqual({ refus: expect.stringMatching(/500/) });
    expect(annule).toBe(true);
  });

  it('🔴 le type DÉCLARÉ ne compte pas : un PDF annoncé image/jpeg est refusé pour une image', async () => {
    const r = await telechargerEntete(deps(new Response(PDF, { headers: { 'content-type': 'image/jpeg' } })), 'IMAGE', URL_OK);
    expect(r).toEqual({ refus: expect.stringMatching(/JPEG ou PNG/) });
  });

  it('🔴 une adresse interne n’est jamais appelée, ni par son texte ni par sa résolution', async () => {
    for (const url of ['https://localhost/a.jpg', 'https://169.254.169.254/a.jpg', 'http://exemple.fr/a.jpg']) {
      const d = deps(new Response(JPEG));
      expect(await telechargerEntete(d, 'IMAGE', url), url).toEqual({ refus: expect.any(String) });
      expect(d.appels, url).toBe(0);
    }
    const d = deps(new Response(JPEG), false);
    expect(await telechargerEntete(d, 'IMAGE', URL_OK)).toEqual({ refus: expect.stringMatching(/adresse interne/) });
    expect(d.appels).toBe(0);
  });

  it('🔴 trop lourd : refusé à la lecture, au plafond du format', async () => {
    const gros = Buffer.concat([JPEG, Buffer.alloc(PLAFONDS_ENTETE.IMAGE)]);
    expect(await telechargerEntete(deps(new Response(gros)), 'IMAGE', URL_OK)).toEqual({ refus: expect.stringMatching(/5 Mo/) });
  });

  it('une redirection, un statut d’échec, une panne ou un délai : un refus lisible, jamais une exception', async () => {
    expect(await telechargerEntete(deps(new Response(null, { status: 404 })), 'IMAGE', URL_OK)).toEqual({ refus: expect.stringMatching(/404/) });
    const redirection = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    expect(await telechargerEntete(deps(() => Promise.reject(redirection)), 'IMAGE', URL_OK)).toEqual({ refus: expect.stringMatching(/redirection/) });
    expect(await telechargerEntete(deps(() => Promise.reject(new Error('ECONNRESET'))), 'IMAGE', URL_OK)).toEqual({ refus: expect.stringMatching(/téléchargé/) });
    const lent: DepsTelechargement = {
      verifier: async () => ({ ok: true }),
      delaiMs: 20,
      fetch: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch,
    };
    expect(await telechargerEntete(lent, 'IMAGE', URL_OK)).toEqual({ refus: expect.stringMatching(/pas de réponse/) });
  });

  it('🔴 aucune redirection n’est suivie : le fetch la refuse lui-même', async () => {
    let options: RequestInit | undefined;
    const d: DepsTelechargement = {
      verifier: async () => ({ ok: true }),
      fetch: (async (_u: string, init: RequestInit) => { options = init; return new Response(JPEG); }) as unknown as typeof fetch,
    };
    await telechargerEntete(d, 'IMAGE', URL_OK);
    expect(options?.redirect).toBe('error');
  });
});
