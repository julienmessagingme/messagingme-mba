import { describe, it, expect } from 'vitest';
import { ZadarmaClient, ZadarmaApiError, signZadarma, zadarmaQuery } from '../src/zadarma/client';
import { listerNumeros, appelsEntrantsRecents, lireTranscription } from '../src/zadarma/api';

function client(json: unknown, ok = true): { c: ZadarmaClient; urls: string[]; auth: string[]; envois: RequestInit[] } {
  const urls: string[] = [];
  const auth: string[] = [];
  const envois: RequestInit[] = [];
  const fake = async (url: string, init: RequestInit): Promise<Response> => {
    urls.push(url);
    envois.push(init);
    auth.push(String((init.headers as Record<string, string>).Authorization));
    return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(json) } as Response;
  };
  return { c: new ZadarmaClient('KEY', 'SECRET', fake as never), urls, auth, envois };
}

describe('signature Zadarma', () => {
  it('🔴 56 caractères : c’est le base64 du HMAC HEXADÉCIMAL, pas des octets bruts', () => {
    // Le piège qui fait croire que les clés sont mauvaises alors que c'est le code : 28 caractères = octets
    // bruts signés, et l'API répond 401 sans rien expliquer. Vérifié en réel sur /v1/info/balance/.
    expect(signZadarma('SECRET', '/v1/info/balance/', 'format=json')).toHaveLength(56);
  });

  it('paramètres triés par nom et espaces en « + » (RFC 1738, pas %20)', () => {
    expect(zadarmaQuery({ zebre: 'a', alpha: 'b' })).toBe('alpha=b&zebre=a');
    expect(zadarmaQuery({ start: '2026-08-16 18:00:00' })).toBe('start=2026-08-16+18%3A00%3A00');
  });

  it('signature stable pour les mêmes entrées, différente si le secret change', () => {
    const a = signZadarma('SECRET', '/v1/x/', 'format=json');
    expect(signZadarma('SECRET', '/v1/x/', 'format=json')).toBe(a);
    expect(signZadarma('AUTRE', '/v1/x/', 'format=json')).not.toBe(a);
  });
});

describe('ZadarmaClient', () => {
  it('envoie l’en-tête « clé:signature » et ajoute format=json', async () => {
    const { c, urls, auth } = client({ status: 'success' });
    await c.call('GET', '/v1/info/balance/');
    expect(urls[0]).toBe('https://api.zadarma.com/v1/info/balance/?format=json');
    expect(auth[0]).toMatch(/^KEY:.{56}$/);
  });

  it('🔴 en ÉCRITURE les paramètres vont dans le corps, l’URL reste nue', async () => {
    // Mesuré en réel le 2026-08-16 : un PUT dont les paramètres restent dans l'URL est reçu SANS paramètres,
    // sa signature est recalculée sur une chaîne vide, et Zadarma répond « 401 Not authorized » (on accuse
    // alors les clés, qui sont bonnes). Paramètres dans le corps -> 404, donc bien authentifié.
    const { c, urls, envois } = client({ status: 'success' });
    await c.call('PUT', '/v1/speech_recognition/', { call_id: 'c1', lang: 'fr-FR' });
    expect(urls[0]).toBe('https://api.zadarma.com/v1/speech_recognition/'); // aucune query string
    expect(envois[0]!.body).toBe('call_id=c1&format=json&lang=fr-FR');
    expect((envois[0]!.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('en LECTURE les paramètres restent dans l’URL et il n’y a pas de corps', async () => {
    const { c, urls, envois } = client({ status: 'success' });
    await c.call('GET', '/v1/speech_recognition/', { call_id: 'c1' });
    expect(urls[0]).toBe('https://api.zadarma.com/v1/speech_recognition/?call_id=c1&format=json');
    expect(envois[0]!.body).toBeUndefined();
  });

  it('🔴 HTTP 200 avec status:"error" -> exception : un échec métier ne doit pas passer pour un succès', async () => {
    const { c } = client({ status: 'error', message: 'option non souscrite' });
    await expect(c.call('GET', '/v1/speech_recognition/', { call_id: 'x' })).rejects.toThrow('option non souscrite');
  });

  it('5xx -> erreur rejouable ; réponse illisible -> erreur, jamais un objet vide', async () => {
    const { c } = client({}, false);
    await expect(c.call('GET', '/v1/x/')).rejects.toMatchObject({ retryable: true });
    const brut = new ZadarmaClient('K', 'S', (async () => ({ ok: true, status: 200, text: async () => '<html>' })) as never);
    await expect(brut.call('GET', '/v1/x/')).rejects.toBeInstanceOf(ZadarmaApiError);
  });
});

describe('lecture des ressources Zadarma', () => {
  it('numéros : forme réelle du compte (vérifiée en direct le 2026-08-16)', async () => {
    const { c } = client({
      status: 'success',
      info: [{ number: '33189480136', status: 'on', country: 'France', description: 'Paris', number_name: 'Gan prevoyance', receive_sms: 'false', monthly_fee: 4, currency: 'EUR' }],
    });
    // ⚠️ `receive_sms` arrive en CHAÎNE « false », pas en booléen : un test de véracité naïf le lirait vrai.
    expect(await listerNumeros(c)).toEqual([
      { numero: '33189480136', statut: 'on', pays: 'France', description: 'Paris', nom: 'Gan prevoyance', recoitSms: false, fraisMensuel: 4, devise: 'EUR' },
    ]);
  });

  it('appels entrants : fenêtre large et sens « in »', async () => {
    const { c, urls } = client({ status: 'success', stats: [{ call_id: 'c1', clid: '12025551234', destination: '33189480136', disposition: 'answered', is_recorded: true, callstart: '2026-08-16 18:00:00' }] });
    const appels = await appelsEntrantsRecents(c, Date.parse('2026-08-16T18:00:00Z'), 6);
    expect(appels).toEqual([{ callId: 'c1', appelant: '12025551234', destination: '33189480136', etat: 'answered', enregistre: true, debut: '2026-08-16 18:00:00' }]);
    expect(urls[0]).toContain('call_type=in');
    expect(urls[0]).toContain('start=2026-08-16+12%3A00%3A00'); // 6 h avant
    expect(urls[0]).toContain('end=2026-08-17+00%3A00%3A00'); // 6 h après : le fuseau du compte n'est pas garanti
  });

  it('transcription : prête seulement si « recognized » ; accepte phrases ET mots', async () => {
    const { c: enPhrases } = client({ status: 'success', recognitionStatus: 'recognized', phrases: [{ result: 'votre code est 123456' }] });
    expect(await lireTranscription(enPhrases, 'c1')).toEqual({ pret: true, texte: 'votre code est 123456', etat: 'recognized' });

    const { c: enMots } = client({ status: 'success', recognitionStatus: 'recognized', words: [{ w: 'code' }, { w: '123456' }] });
    expect((await lireTranscription(enMots, 'c1')).texte).toBe('code 123456');

    const { c: enCours } = client({ status: 'success', recognitionStatus: 'in progress' });
    expect(await lireTranscription(enCours, 'c1')).toEqual({ pret: false, texte: '', etat: 'in progress' });
  });
});
