import { describe, it, expect } from 'vitest';
import { MetaPhoneRegisterClient } from '../src/meta/phone-register';
import { MetaApiError } from '../src/meta/errors';

interface Appel { url: string; method: string; body: Record<string, unknown> }

function client(reponses: Array<{ ok: boolean; status?: number; json: unknown }>): { c: MetaPhoneRegisterClient; appels: Appel[] } {
  const appels: Appel[] = [];
  let i = 0;
  const fake = async (url: string, init: RequestInit): Promise<Response> => {
    appels.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const r = reponses[i++] ?? { ok: true, json: {} };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.json } as Response;
  };
  return { c: new MetaPhoneRegisterClient('TOK', 'v25.0', fake as never), appels };
}

describe('MetaPhoneRegisterClient', () => {
  it('la séquence poste les bons corps aux bonnes URL', async () => {
    const { c, appels } = client([{ ok: true, json: { id: 'pn-1' } }, { ok: true, json: {} }, { ok: true, json: {} }]);

    const phoneNumberId = await c.addPhoneNumber('waba-9', '33', '189480136', 'Messaging Me');
    expect(phoneNumberId).toBe('pn-1');
    await c.requestCode(phoneNumberId);
    await c.verifyCode(phoneNumberId, '123456');

    expect(appels.map((a) => a.url)).toEqual([
      'https://graph.facebook.com/v25.0/waba-9/phone_numbers',
      'https://graph.facebook.com/v25.0/pn-1/request_code',
      'https://graph.facebook.com/v25.0/pn-1/verify_code',
    ]);
    expect(appels[0]!.body).toEqual({ cc: '33', phone_number: '189480136', verified_name: 'Messaging Me' });
    // VOICE et langue forcés : sur un numéro VoIP le SMS est déconseillé par Meta, et un code dicté dans une
    // autre langue serait mal transcrit par la reconnaissance vocale française.
    expect(appels[1]!.body).toEqual({ code_method: 'VOICE', language: 'fr' });
    expect(appels[2]!.body).toEqual({ code: '123456' });
  });

  it('l’activation Cloud API n’est PAS ici : une seule source de vérité, celle de l’embarquement', () => {
    // Dupliquer `POST /{phone_number_id}/register` donnerait deux implémentations du même appel Graph, qui
    // divergeraient au premier changement. La séquence OTP réutilise `MetaEmbeddedSignupClient.register`.
    expect('register' in MetaPhoneRegisterClient.prototype).toBe(false);
  });

  it('erreur Meta -> MetaApiError (jamais un succès silencieux)', async () => {
    const { c } = client([{ ok: false, status: 400, json: { error: { message: 'code expired', code: 136024 } } }]);
    await expect(c.verifyCode('pn-1', '123456')).rejects.toBeInstanceOf(MetaApiError);
  });

  it('réponse sans id à la création -> erreur (on ne rend jamais un identifiant vide)', async () => {
    const { c } = client([{ ok: true, json: {} }]);
    await expect(c.addPhoneNumber('waba-9', '33', '189480136', 'X')).rejects.toBeInstanceOf(MetaApiError);
  });
});
