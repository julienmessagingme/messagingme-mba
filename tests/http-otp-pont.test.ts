import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signRequest } from '../src/lib/signature';
import { PLAFOND_APPELS_PAR_HEURE, TAILLE_MAX_ENREGISTREMENT, type OtpPontRouteDeps } from '../src/http/otp-pont';
import type { NumeroFourni, ResultatAppel } from '../src/otp/store.pg';

/**
 * LE PONT DU CODE (lot 3a). L'adresse est publique : c'est la signature qui la ferme, et elle couvre le CHEMIN, donc le
 * numéro appelé et l'identifiant d'appel. Un appel sans code certain s'écrit quand même, avec sa cause, et rend 200 :
 * le script efface le fichier sur tout 2xx, et le rejouer donnerait le même résultat.
 */

afterEach(() => { vi.restoreAllMocks(); });

const SECRET = 'secret-du-pont-assez-long-pour-la-configuration';
const NOW = 1_786_000_000_000;
const NUMERO = '442071234567';
const APPEL = '1728137328.12';
const AUDIO = Buffer.from('RIFF....WAVEfmt fausse-trame-audio');

const FOURNI: NumeroFourni = {
  id: 'n1', numero: NUMERO, didwwDidId: 'did-1', statut: 'libre', tenantId: null, attribueLe: null, creeLe: new Date(NOW),
};

function app(over: Partial<OtpPontRouteDeps> = {}, o: { recents?: number } = {}) {
  const ecrits: Array<{ numeroId: string; r: ResultatAppel }> = [];
  /** Fidèle à `PgNumerosFournisStore` : un appel lu ne se réécrit pas, une transcription en panne se remplace. */
  const lignes = new Map<string, ResultatAppel>();
  const deps: OtpPontRouteDeps = {
    secret: SECRET,
    numeros: {
      parNumero: async (n) => (n === NUMERO ? FOURNI : null),
      ecrireCode: async (numeroId, r) => {
        const avant = lignes.get(r.appelId);
        if (avant && !(avant.code === null && avant.cause === 'transcription_indisponible')) return false;
        lignes.set(r.appelId, r);
        ecrits.push({ numeroId, r });
        return true;
      },
      appelDejaLu: async (appelId) => {
        const l = lignes.get(appelId);
        return l !== undefined && !(l.code === null && l.cause === 'transcription_indisponible');
      },
      appelsRecents: async () => o.recents ?? lignes.size,
    },
    transcrire: async () => 'Your verification code is 8 6 3 8 0 1. Again, your verification code is 8 6 3 8 0 1.',
    now: () => NOW,
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), otpPont: deps }), ecrits };
}

const chemin = (numero = NUMERO, appel = APPEL) => `/internes/otp/appels/${numero}/${appel}`;

/** Signe comme le script de l'Asterisk : même format canonique que nos autres services, sur le chemin et le son. */
function envoi(o: { url?: string; signeSur?: string; secret?: string; ts?: number; corps?: Buffer } = {}) {
  const url = o.url ?? chemin();
  const corps = o.corps ?? AUDIO;
  const sig = signRequest(o.secret ?? SECRET, {
    ts: o.ts ?? NOW, nonce: randomBytes(8).toString('hex'), method: 'POST', path: o.signeSur ?? url, body: corps,
  });
  return { method: 'POST' as const, url, headers: { 'content-type': 'audio/wav', 'x-mm-service-signature': sig }, payload: corps };
}

describe('POST /internes/otp/appels/:numero/:appel', () => {
  it('appel signé sur un numéro de la réserve : le code est lu et écrit, sans repartir dans la réponse', async () => {
    const { server, ecrits } = app();
    const res = await server.inject(envoi());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recu: true, code: true, deja: false });
    expect(res.body).not.toContain('863801');
    expect(ecrits).toEqual([{ numeroId: 'n1', r: expect.objectContaining({ appelId: APPEL, code: '863801' }) }]);
    await server.close();
  });

  it('🔴 signature absente, d’un autre secret, ou PÉRIMÉE : 401, et rien n’est lu ni écrit', async () => {
    const transcrire = vi.fn(async () => 'code 863801');
    const { server, ecrits } = app({ transcrire });
    const sans = await server.inject({ method: 'POST', url: chemin(), headers: { 'content-type': 'audio/wav' }, payload: AUDIO });
    expect(sans.statusCode).toBe(401);
    expect((await server.inject(envoi({ secret: 'un-autre-secret-tout-aussi-long-que-le-vrai' }))).statusCode).toBe(401);
    expect((await server.inject(envoi({ ts: NOW - 10 * 60 * 1000 }))).statusCode).toBe(401);
    expect(transcrire).not.toHaveBeenCalled();
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('🔴 le CHEMIN est signé : la signature d’un numéro ne vaut pas pour un autre, ni pour un autre appel', async () => {
    const { server, ecrits } = app();
    expect((await server.inject(envoi({ url: chemin('442079999999'), signeSur: chemin() }))).statusCode).toBe(401);
    expect((await server.inject(envoi({ url: chemin(NUMERO, 'autre.1'), signeSur: chemin() }))).statusCode).toBe(401);
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('🔴 le CORPS est signé : un autre enregistrement sous la même signature est refusé', async () => {
    const { server, ecrits } = app();
    const vrai = envoi();
    const res = await server.inject({ ...vrai, payload: Buffer.from('un autre son') });
    expect(res.statusCode).toBe(401);
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('un numéro hors de la réserve : 404, rien n’est transcrit', async () => {
    const transcrire = vi.fn(async () => '');
    const { server, ecrits } = app({ transcrire });
    const res = await server.inject(envoi({ url: chemin('442079999999') }));
    expect(res.statusCode).toBe(404);
    expect(transcrire).not.toHaveBeenCalled();
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('un chemin hors format ou un corps vide : refusés, même signés', async () => {
    const { server, ecrits } = app();
    expect((await server.inject(envoi({ url: chemin('+442071234567') }))).statusCode).toBe(400);
    expect((await server.inject(envoi({ corps: Buffer.alloc(0) }))).statusCode).toBe(415);
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('🔴 transcription en panne : la ligne s’écrit (pour /ops), la réponse est 503 (le script GARDE le fichier), et le rejeu la remplace', async () => {
    // Relecture du lot 3a : rendue en 200, une panne passagère du service faisait effacer l'enregistrement, et le code
    // était perdu sans rejeu possible.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let enPanne = true;
    const { server, ecrits } = app({
      transcrire: async () => { if (enPanne) throw new Error('service indisponible'); return 'your code is 8 6 3 8 0 1'; },
    });
    const res = await server.inject(envoi());
    expect(res.statusCode).toBe(503);
    expect(ecrits).toEqual([{ numeroId: 'n1', r: { appelId: APPEL, code: null, transcription: '', cause: 'transcription_indisponible' } }]);
    enPanne = false;
    const rejeu = await server.inject(envoi());
    expect(rejeu.statusCode).toBe(200);
    expect(ecrits[1]).toEqual({ numeroId: 'n1', r: expect.objectContaining({ appelId: APPEL, code: '863801' }) });
    await server.close();
  });

  it('🔴 au-delà du plafond horaire du numéro : 429, et RIEN n’est transcrit sur notre clé', async () => {
    const transcrire = vi.fn(async () => 'code 863801');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { server, ecrits } = app({ transcrire }, { recents: PLAFOND_APPELS_PAR_HEURE });
    const res = await server.inject(envoi());
    expect(res.statusCode).toBe(429);
    expect(transcrire).not.toHaveBeenCalled();
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('🔴 un en-tête de signature mal formé tombe AVANT la lecture du corps', async () => {
    const transcrire = vi.fn(async () => '');
    const { server } = app({ transcrire });
    const res = await server.inject({ ...envoi(), headers: { 'content-type': 'audio/wav', 'x-mm-service-signature': 'v1=pas-une-signature' } });
    expect(res.statusCode).toBe(401);
    expect(transcrire).not.toHaveBeenCalled();
    await server.close();
  });

  it('🔴 un vrai enregistrement de 90 s (1,5 Mo, au-delà du plafond global de 1 Mo) passe ; au-delà de 4 Mo : 413', async () => {
    const { server, ecrits } = app();
    const gros = Buffer.alloc(1_500_000, 7);
    expect((await server.inject(envoi({ corps: gros }))).statusCode).toBe(200);
    expect(ecrits).toHaveLength(1);
    const trop = Buffer.alloc(TAILLE_MAX_ENREGISTREMENT + 1, 7);
    expect((await server.inject(envoi({ corps: trop, url: chemin(NUMERO, 'trop.1') }))).statusCode).toBe(413);
    await server.close();
  });

  it('un JSON correctement signé n’est pas un enregistrement : 415', async () => {
    const { server, ecrits } = app();
    const corps = Buffer.from(JSON.stringify({ code: '863801' }));
    const signe = envoi({ corps });
    const res = await server.inject({ ...signe, headers: { ...signe.headers, 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(415);
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('🔴 aucun code certain (deux codes différents) : écrit en `code_introuvable`, avec la transcription pour le dépannage', async () => {
    const texte = 'your code is 863801, again your code is 863807';
    const { server, ecrits } = app({ transcrire: async () => texte });
    const res = await server.inject(envoi());
    expect(res.statusCode).toBe(200);
    expect(ecrits).toEqual([{ numeroId: 'n1', r: { appelId: APPEL, code: null, transcription: texte, cause: 'code_introuvable' } }]);
    await server.close();
  });

  it('le même appel rejoué : 200, `deja`, rien n’est réécrit ni RETRANSCRIT (notre clé)', async () => {
    const transcrire = vi.fn(async () => 'your code is 863801');
    const { server, ecrits } = app({ transcrire });
    await server.inject(envoi());
    const res = await server.inject(envoi());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deja: true });
    expect(ecrits).toHaveLength(1);
    expect(transcrire).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it('sans secret configuré, la route n’existe pas', async () => {
    const server = buildServer({ queue: new FakeQueue() });
    expect((await server.inject(envoi())).statusCode).toBe(404);
    await server.close();
  });
});
