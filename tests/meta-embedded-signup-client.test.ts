import { describe, it, expect, afterEach } from 'vitest';
import { MetaEmbeddedSignupClient } from '../src/meta/embedded-signup';

/**
 * Le repêchage des identifiants quand la popup se taît (client qui rouvre un parcours déjà abouti).
 * Ce client n'avait aucun test : la première version s'authentifiait avec le mauvais des deux tokens et Meta
 * refusait (« #100 You must provide an app access token »), erreur découverte seulement en production.
 */
const vraiFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = vraiFetch; });

/** Remplace fetch et journalise les URL appelées. `json` est le corps rendu. */
function fausseReponse(json: unknown, ok = true): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return { ok, status: ok ? 200 : 400, json: async () => json } as Response;
  }) as typeof fetch;
  return urls;
}

const client = () => new MetaEmbeddedSignupClient('APP_ID', 'APP_SECRET', 'v25.0');

describe('wabasForToken', () => {
  it('🔴 s’authentifie avec le TOKEN D’APPLICATION, pas avec celui du client', () => {
    // input_token = le token INSPECTÉ (client) ; access_token = l'autorisation (app). Les confondre rend #100.
    const urls = fausseReponse({ data: { granular_scopes: [] } });
    return client().wabasForToken('TOKEN_CLIENT').then(() => {
      expect(urls[0]).toContain('input_token=TOKEN_CLIENT');
      expect(urls[0]).toContain(`access_token=${encodeURIComponent('APP_ID|APP_SECRET')}`);
    });
  });

  it('extrait les comptes des granular_scopes, sans doublon', async () => {
    fausseReponse({
      data: {
        granular_scopes: [
          { scope: 'whatsapp_business_management', target_ids: ['waba-1'] },
          { scope: 'whatsapp_business_messaging', target_ids: ['waba-1', 'waba-2'] },
          { scope: 'public_profile', target_ids: ['ignoré'] },
        ],
      },
    });
    expect(await client().wabasForToken('T')).toEqual(['waba-1', 'waba-2']);
  });

  it('token NON scopé (target_ids null) -> tableau vide, jamais d’exception', async () => {
    // Mesuré sur notre propre token System User : `target_ids: null`. L'appelant doit pouvoir le dire à
    // l'utilisateur, pas planter.
    fausseReponse({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: null }] } });
    expect(await client().wabasForToken('T')).toEqual([]);
    fausseReponse({});
    expect(await client().wabasForToken('T')).toEqual([]);
  });

  it('refus de Meta -> exception portant son message (il remonte jusqu’à l’écran)', async () => {
    fausseReponse({ error: { message: 'You must provide an app access token', code: 100 } }, false);
    await expect(client().wabasForToken('T')).rejects.toThrow('app access token');
  });
});

describe('listPhones', () => {
  it('lit les numéros du compte avec le token du CLIENT (c’est lui qui possède le compte)', async () => {
    const urls = fausseReponse({ data: [{ id: 'pn-1', display_phone_number: '+33525680301', status: 'PENDING' }] });
    const phones = await client().listPhones('waba-1', 'TOKEN_CLIENT');
    expect(phones).toEqual([{ id: 'pn-1', displayPhoneNumber: '+33525680301', verifiedName: null, status: 'PENDING' }]);
    expect(urls[0]).toContain('/waba-1/phone_numbers');
  });

  it('réponse vide ou entrées sans identifiant -> écartées', async () => {
    fausseReponse({ data: [{ display_phone_number: 'sans id' }] });
    expect(await client().listPhones('waba-1', 'T')).toEqual([]);
    fausseReponse({});
    expect(await client().listPhones('waba-1', 'T')).toEqual([]);
  });
});
