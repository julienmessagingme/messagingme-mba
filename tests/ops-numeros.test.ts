import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { buildServer } from '../src/server';
import { accesOps } from './acces-ops';
import { FakeQueue } from './fake-queue';
import { ErreurDidww, type ClientDidww } from '../src/didww/client';
import { DidDejaDeclare, type NumeroEtDernierCode, type NumeroFourni } from '../src/otp/store.pg';
import { numeroEnChiffres, type OpsNumerosDeps } from '../src/http/ops-numeros';

/**
 * LA RÉSERVE DE NUMÉROS FOURNIS DANS /ops (lot 3a). Déclarer un numéro le retrouve dans l'inventaire DIDWW, le branche
 * sur le trunk de l'Asterisk, PUIS l'inscrit : un refus de DIDWW n'inscrit rien, et un numéro inscrit sans être branché
 * ne recevrait jamais l'appel de Meta.
 */

afterEach(() => { vi.restoreAllMocks(); });

const TRUNK = '39af006a-5a4f-4a1a-866b-f14ab322a266';
const acces = accesOps();
const ops: Record<string, string> = { 'content-type': 'application/json' };
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  ops.authorization = `Bearer ${await acces.jeton(s)}`;
  await s.close();
});

/** Un identifiant de la réserve, au format que la route de sortie exige. */
const ID_AILLEURS = 'a09d4af6-b35a-466f-bb7a-70dda6706294';

function monter(o: { didww?: Partial<ClientDidww> | null; deja?: 'meme' | 'autre'; enAttente?: string[]; attribuerLeve?: boolean; sortirRendRien?: boolean } = {}) {
  const gestes: string[] = [];
  const inscrits: NumeroFourni[] = [];
  const client: ClientDidww = {
    trouverDid: async (numero) => { gestes.push(`trouver:${numero}`); return numero === '442071234567' ? { id: 'did-1', numero } : null; },
    brancher: async (didId, trunkId) => { gestes.push(`brancher:${didId}:${trunkId}`); },
    // /ops ne résilie jamais : la résiliation appartient à la libération (lot 4, livraison B).
    resilier: async (didId) => { gestes.push(`resilier:${didId}`); },
    ...o.didww,
  };
  const deps: OpsNumerosDeps = {
    numeros: {
      declarer: async (numero, didwwDidId) => {
        gestes.push(`declarer:${numero}`);
        if (o.deja === 'autre') throw new DidDejaDeclare(didwwDidId);
        const n: NumeroFourni = { id: 'n1', numero, didwwDidId, statut: 'libre', tenantId: null, attribueLe: null, creeLe: new Date() };
        if (o.deja === 'meme') return { numero: n, cree: false };
        inscrits.push(n);
        return { numero: n, cree: true };
      },
      lister: async (): Promise<NumeroEtDernierCode[]> => [
        { id: 'n1', numero: '442071234567', didwwDidId: 'did-1', statut: 'libre', tenantId: null, attribueLe: null, creeLe: new Date(), ailleurs: null,
          dernierCode: { appelId: 'a1', recuLe: new Date(), code: '863801', transcription: 'your code is 8 6 3 8 0 1', cause: null } },
        { id: 'n2', numero: '442071234568', didwwDidId: 'did-2', statut: 'attribue', tenantId: 't1', attribueLe: new Date(), creeLe: new Date(), ailleurs: null, dernierCode: null },
        // Libre en base, mais l'application WhatsApp Business de quelqu'un s'en sert : jamais attribué, pas compté.
        { id: ID_AILLEURS, numero: '442071234569', didwwDidId: 'did-3', statut: 'libre', tenantId: null, attribueLe: null, creeLe: new Date(), ailleurs: 'application', dernierCode: null },
      ],
      sortirDeLaReserve: async (id) => {
        gestes.push(`sortir:${id}`);
        return o.sortirRendRien ? null : '442071234569';
      },
      attribuer: async (tenantId) => {
        gestes.push(`attribuer:${tenantId}`);
        if (o.attribuerLeve) throw new Error('base indisponible');
        return { id: 'n1', numero: '442071234567', didwwDidId: 'did-1', statut: 'attribue', tenantId, attribueLe: new Date(), creeLe: new Date() };
      },
    },
    abonnes: { enAttenteDeNumero: async () => o.enAttente ?? [] },
    didww: o.didww === null ? null : { client, trunkId: TRUNK },
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: acces.auth, opsNumeros: deps }), gestes, inscrits };
}

const declarer = (numero: string, note = 'achat DIDWW du 5 octobre') => ({
  method: 'POST' as const, url: '/ops/numeros-fournis', headers: ops, payload: JSON.stringify({ numero, note }),
});

const sortir = (id: string, note = 'le numéro de l’application de Julien') => ({
  method: 'POST' as const, url: `/ops/numeros-fournis/${id}/sortir`, headers: ops, payload: JSON.stringify({ note }),
});

describe('/ops/numeros-fournis', () => {
  it('🔴 sans session d’exploitation : 401, et DIDWW n’est jamais appelé', async () => {
    const { server, gestes } = monter();
    const res = await server.inject({ method: 'POST', url: '/ops/numeros-fournis', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ numero: '+44 20 7123 4567', note: 'essai' }) });
    expect(res.statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/ops/numeros-fournis' })).statusCode).toBe(401);
    expect(gestes).toEqual([]);
    await server.close();
  });

  it('🔴 déclarer : retrouver, BRANCHER sur le trunk, PUIS inscrire, dans cet ordre', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { server, gestes, inscrits } = monter();
    const res = await server.inject(declarer('+44 20 7123 4567'));
    expect(res.statusCode).toBe(201);
    expect(gestes).toEqual(['trouver:442071234567', `brancher:did-1:${TRUNK}`, 'declarer:442071234567']);
    expect(inscrits).toHaveLength(1);
    await server.close();
  });

  it('🔴 un numéro absent de l’inventaire, ou un branchement refusé : rien n’est inscrit, le refus est lisible (4xx)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const absent = monter();
    const r1 = await absent.server.inject(declarer('+44 20 7999 9999'));
    expect(r1.statusCode).toBe(404);
    expect(absent.inscrits).toEqual([]);
    await absent.server.close();
    const refuse = monter({ didww: { brancher: async () => { throw new ErreurDidww(422, 'DIDWW a refusé (422) : trunk inconnu'); } } });
    const r2 = await refuse.server.inject(declarer('+44 20 7123 4567'));
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toEqual({ error: 'DIDWW a refusé (422) : trunk inconnu' });
    expect(refuse.gestes).not.toContain('declarer:442071234567');
    await refuse.server.close();
  });

  it('🔴 un abonné attend son numéro (la réserve s’était vidée) : le numéro déclaré lui revient, au plus ancien d’abord', async () => {
    const avertis = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { server, gestes } = monter({ enAttente: ['t-ancien', 't-recent'] });
    const res = await server.inject(declarer('+44 20 7123 4567'));
    // La trace de l'attribution est signée de son auteur, comme toute écriture de /ops.
    const lignes = avertis.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lignes.find((l) => l.msg === 'numero_attribue_a_un_abonne_en_attente')).toMatchObject({ tenantId: 't-ancien', par: 'exploitant@exploitation.test' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ attribueA: 't-ancien' });
    expect(gestes.at(-1)).toBe('attribuer:t-ancien');
    await server.close();
  });

  it('🔴 l’attribution à l’abonné échoue : le numéro est déclaré, la réponse le dit (201), jamais un 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server, inscrits, gestes } = monter({ enAttente: ['t-ancien'], attribuerLeve: true });
    const res = await server.inject(declarer('+44 20 7123 4567'));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ cree: true, attribueA: null });
    expect(inscrits).toHaveLength(1);
    expect(gestes.at(-1), 'l’attribution a bien été tentée').toBe('attribuer:t-ancien');
    await server.close();
  });

  it('personne n’attend, ou un numéro déjà déclaré : rien n’est attribué', async () => {
    const libre = monter();
    expect((await libre.server.inject(declarer('+44 20 7123 4567'))).json()).toMatchObject({ attribueA: null });
    expect(libre.gestes.filter((g) => g.startsWith('attribuer'))).toEqual([]);
    const deja = monter({ deja: 'meme', enAttente: ['t-ancien'] });
    await deja.server.inject(declarer('+44 20 7123 4567'));
    expect(deja.gestes.filter((g) => g.startsWith('attribuer'))).toEqual([]);
    await libre.server.close();
    await deja.server.close();
  });

  it('DIDWW non configuré : 503 à la déclaration, la lecture marche et le dit', async () => {
    const { server, gestes } = monter({ didww: null });
    expect((await server.inject(declarer('+44 20 7123 4567'))).statusCode).toBe(503);
    expect(gestes).toEqual([]);
    const lu = await server.inject({ method: 'GET', url: '/ops/numeros-fournis', headers: ops });
    expect(lu.statusCode).toBe(200);
    expect(lu.json()).toMatchObject({ configure: false, libres: 1 });
    await server.close();
  });

  it('déjà déclaré : 200 sans rien réinscrire ; le même numéro DIDWW sous un autre numéro : 409', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meme = monter({ deja: 'meme' });
    expect((await meme.server.inject(declarer('442071234567'))).statusCode).toBe(200);
    await meme.server.close();
    const autre = monter({ deja: 'autre' });
    expect((await autre.server.inject(declarer('442071234567'))).statusCode).toBe(409);
    await autre.server.close();
  });

  it('un numéro illisible ou une note absente : 400, DIDWW n’est pas appelé', async () => {
    const { server, gestes } = monter();
    expect((await server.inject(declarer('020 7123'))).statusCode).toBe(400);
    expect((await server.inject(declarer('+44 20 7123 4567', ' '))).statusCode).toBe(400);
    expect(gestes).toEqual([]);
    await server.close();
  });

  it('la lecture : la réserve, le nombre de libres et le dernier code capté par numéro', async () => {
    const { server } = monter();
    const res = await server.inject({ method: 'GET', url: '/ops/numeros-fournis', headers: ops });
    expect(res.statusCode).toBe(200);
    const corps = res.json();
    expect(corps).toMatchObject({ configure: true, libres: 1 });
    expect(corps.numeros[0].dernierCode).toMatchObject({ code: '863801' });
    await server.close();
  });

  it('🔴 un numéro libre utilisé ailleurs ne compte pas parmi les libres, et la lecture dit pourquoi', async () => {
    const { server } = monter();
    const corps = (await server.inject({ method: 'GET', url: '/ops/numeros-fournis', headers: ops })).json();
    expect(corps.libres).toBe(1);
    expect(corps.numeros.find((n: { id: string }) => n.id === ID_AILLEURS)).toMatchObject({ statut: 'libre', ailleurs: 'application' });
    await server.close();
  });
});

describe('/ops/numeros-fournis/:id/sortir', () => {
  it('🔴 sans session d’exploitation : 401 ; sans note ou avec un identifiant illisible : 400 ; la réserve n’est pas touchée', async () => {
    const { server, gestes } = monter();
    const sansSession = await server.inject({ ...sortir(ID_AILLEURS), headers: { 'content-type': 'application/json' } });
    expect(sansSession.statusCode).toBe(401);
    expect((await server.inject(sortir(ID_AILLEURS, ' '))).statusCode).toBe(400);
    expect((await server.inject(sortir('pas-un-identifiant'))).statusCode).toBe(400);
    expect(gestes).toEqual([]);
    await server.close();
  });

  it('🔴 un numéro libre sort de la réserve : la réponse le nomme, la trace porte son auteur et la note', async () => {
    const avertis = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { server, gestes } = monter();
    const res = await server.inject(sortir(ID_AILLEURS));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ numero: '442071234569' });
    expect(gestes).toEqual([`sortir:${ID_AILLEURS}`]);
    const lignes = avertis.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lignes.find((l) => l.msg === 'ops_numero_sorti_de_la_reserve')).toMatchObject({
      numero: '442071234569', par: 'exploitant@exploitation.test', note: 'le numéro de l’application de Julien',
    });
    await server.close();
  });

  it('un numéro attribué, déjà sorti ou inconnu : 409, rien d’écrit', async () => {
    const { server } = monter({ sortirRendRien: true });
    const res = await server.inject(sortir(ID_AILLEURS));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/libre/);
    await server.close();
  });
});

describe('numeroEnChiffres', () => {
  it('« +44 20 7123 4567 », « (44) 20-7123-4567 » et « 442071234567 » désignent le même numéro', () => {
    for (const s of ['+44 20 7123 4567', '(44) 20-7123-4567', '442071234567']) expect(numeroEnChiffres(s), s).toBe('442071234567');
  });
  it('un numéro trop court, une lettre, un zéro en tête : null', () => {
    for (const s of ['12345', '+44 20 71A3 4567', '0207123456']) expect(numeroEnChiffres(s), s).toBeNull();
  });
});
