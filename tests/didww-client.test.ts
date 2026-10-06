import { describe, it, expect } from 'vitest';
import { creerClientDidww, ErreurDidww } from '../src/didww/client';

/**
 * LE CLIENT DIDWW DES NUMÉROS FOURNIS (lot 3a). Ce que ces cas tiennent, et qui a été MESURÉ sur le compte réel le
 * 2026-10-02 : la version d'API dans un en-tête, JSON:API, des chemins à soulignés, et le corps du branchement joué à la
 * main ce jour-là. Une réponse illisible est un refus, jamais un succès supposé.
 */

const CONFIG = { cle: 'cle-de-test', url: 'https://api.didww.test/v3' };

interface Appel { url: string; method: string; headers: Record<string, string>; body?: string }

function faux(reponses: Array<{ status: number; corps: unknown }>) {
  const appels: Appel[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    appels.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, ...(init.body ? { body: String(init.body) } : {}) });
    const r = reponses[Math.min(i, reponses.length - 1)]!;
    i += 1;
    return new Response(r.corps === undefined ? '' : JSON.stringify(r.corps), { status: r.status });
  }) as unknown as typeof fetch;
  return { client: creerClientDidww(CONFIG, fetchImpl), appels };
}

const did = (id: string, number: string) => ({ id, type: 'dids', attributes: { number } });

describe('trouverDid', () => {
  it('🔴 la clé, la version d’API et le filtre exact ; seul le numéro EXACT est rendu', async () => {
    const { client, appels } = faux([{ status: 200, corps: { data: [did('d0', '4420712345670'), did('d1', '442071234567')] } }]);
    expect(await client.trouverDid('442071234567')).toEqual({ id: 'd1', numero: '442071234567' });
    expect(appels[0]!.url).toBe('https://api.didww.test/v3/dids?filter[number]=442071234567');
    expect(appels[0]!.headers).toMatchObject({ 'Api-Key': 'cle-de-test', 'X-DIDWW-API-Version': '2026-04-16' });
  });

  it('absent de l’inventaire : null', async () => {
    const { client } = faux([{ status: 200, corps: { data: [] } }]);
    expect(await client.trouverDid('442071234567')).toBeNull();
  });

  it('🔴 une clé refusée : une erreur qui porte le statut et le détail de DIDWW, jamais la clé', async () => {
    const { client } = faux([{ status: 401, corps: { errors: [{ title: 'Unauthorized', detail: 'Authorization failed' }] } }]);
    const err = await client.trouverDid('442071234567').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErreurDidww);
    expect((err as ErreurDidww).statut).toBe(401);
    expect((err as ErreurDidww).message).toBe('DIDWW a refusé (401) : Authorization failed');
    expect((err as ErreurDidww).message).not.toContain('cle-de-test');
  });

  it('une réponse d’une autre forme : un refus, pas une liste vide', async () => {
    const { client } = faux([{ status: 200, corps: { donnees: [] } }]);
    await expect(client.trouverDid('442071234567')).rejects.toBeInstanceOf(ErreurDidww);
  });
});

describe('brancher', () => {
  it('🔴 le PATCH joué à la main le 2026-10-02 : relation `voice_in_trunk`, au type `voice_in_trunks`', async () => {
    const { client, appels } = faux([{ status: 200, corps: { data: did('d1', '442071234567') } }]);
    await client.brancher('d1', 'trunk-1');
    expect(appels[0]!.method).toBe('PATCH');
    expect(appels[0]!.url).toBe('https://api.didww.test/v3/dids/d1');
    expect(appels[0]!.headers['Content-Type']).toBe('application/vnd.api+json');
    expect(JSON.parse(appels[0]!.body!)).toEqual({
      data: { id: 'd1', type: 'dids', relationships: { voice_in_trunk: { data: { type: 'voice_in_trunks', id: 'trunk-1' } } } },
    });
  });

  it('🔴 un succès qui rend un AUTRE numéro, ou rien de lisible : un refus', async () => {
    await expect(faux([{ status: 200, corps: { data: did('d2', '442071234568') } }]).client.brancher('d1', 'trunk-1')).rejects.toBeInstanceOf(ErreurDidww);
    await expect(faux([{ status: 200, corps: undefined }]).client.brancher('d1', 'trunk-1')).rejects.toBeInstanceOf(ErreurDidww);
  });

  it('DIDWW injoignable : une erreur sans statut', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await creerClientDidww(CONFIG, fetchImpl).brancher('d1', 'trunk-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErreurDidww);
    expect((err as ErreurDidww).statut).toBeNull();
  });
});

describe('resilier (lot 4, livraison B)', () => {
  const resilie = (id: string, terminated: boolean) => ({ data: { id, type: 'dids', attributes: { number: '441259797311', terminated } } });

  it('🔴 un PATCH de l’attribut `terminated` (mesuré sur le compte réel le 2026-10-06 : l’attribut existe, à false)', async () => {
    const { client, appels } = faux([{ status: 200, corps: resilie('d1', true) }]);
    await client.resilier('d1');
    expect(appels[0]!.method).toBe('PATCH');
    expect(appels[0]!.url).toBe('https://api.didww.test/v3/dids/d1');
    expect(appels[0]!.headers['Content-Type']).toBe('application/vnd.api+json');
    expect(JSON.parse(appels[0]!.body!)).toEqual({ data: { id: 'd1', type: 'dids', attributes: { terminated: true } } });
  });

  it('🔴 un succès qui ne dit pas `terminated: true`, ou un autre numéro, ou rien de lisible : un refus', async () => {
    await expect(faux([{ status: 200, corps: resilie('d1', false) }]).client.resilier('d1')).rejects.toBeInstanceOf(ErreurDidww);
    await expect(faux([{ status: 200, corps: resilie('d2', true) }]).client.resilier('d1')).rejects.toBeInstanceOf(ErreurDidww);
    await expect(faux([{ status: 200, corps: undefined }]).client.resilier('d1')).rejects.toBeInstanceOf(ErreurDidww);
  });

  it('un refus de DIDWW remonte avec son statut', async () => {
    const err = await faux([{ status: 403, corps: { errors: [{ detail: 'Access denied' }] } }]).client.resilier('d1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErreurDidww);
    expect((err as ErreurDidww).statut).toBe(403);
  });
});
