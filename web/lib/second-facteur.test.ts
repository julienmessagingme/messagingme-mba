import { describe, it, expect, vi, afterEach } from 'vitest';
import { MESSAGE_CODE_INVALIDE, estCorpsCodeRefuse, grouperCle, texteCodesSecours } from './second-facteur';
import { ApiError, request } from './http';
import { ACTIONS_JOURNAL } from './journal';

describe('second facteur : ce qui se calcule sans écran', () => {
  it('la clé à saisir se lit par groupes de quatre', () => {
    expect(grouperCle('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(grouperCle('ABCDEF')).toBe('ABCD EF');
  });

  it('le fichier des codes porte les dix codes, et rien qui dise à quel compte ils ouvrent', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAAAAA${i}-BBBBBBB${i}`);
    const texte = texteCodesSecours(codes, true);
    for (const c of codes) expect(texte).toContain(c);
    expect(texte).not.toMatch(/@/);
  });

  it('seul le texte exact du serveur dit « code refusé »', () => {
    expect(estCorpsCodeRefuse({ error: MESSAGE_CODE_INVALIDE })).toBe(true);
    expect(estCorpsCodeRefuse({ error: 'token invalide ou expiré' })).toBe(false);
    expect(estCorpsCodeRefuse(null)).toBe(false);
  });

  it('les six actions du journal ont leur libellé, en français et en anglais', () => {
    for (const a of ['mfa.active', 'mfa.code_secours_utilise', 'mfa.echec', 'mfa.reinitialise', 'mfa.codes_regeneres', 'mfa.desactive']) {
      const [fr, en] = ACTIONS_JOURNAL[a] ?? ['', ''];
      expect(fr, a).not.toBe('');
      expect(en, a).not.toBe('');
    }
  });
});

/**
 * 🔴 UN CODE REFUSÉ N'EST PAS UNE SESSION TOMBÉE. Le serveur répond 401 aux deux : sans le mode de l'appel, un
 * code mal tapé sur la page Compte vidait la session et renvoyait à la connexion.
 */
describe('request : ce qu’un 401 veut dire', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function repondre401(corps: unknown): { retirees: string[] } {
    const retirees: string[] = [];
    vi.stubGlobal('localStorage', { getItem: () => null, removeItem: (k: string) => { retirees.push(k); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(corps), { status: 401, headers: { 'content-type': 'application/json' } })));
    return { retirees };
  }

  it('par défaut, un 401 vide la session', async () => {
    const { retirees } = repondre401({ error: MESSAGE_CODE_INVALIDE });
    const err = await request('/x', { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(401);
    expect(retirees).toContain('mba.session');
  });

  it('🔴 mode `code` : un code refusé remonte tel quel, et la session reste', async () => {
    const { retirees } = repondre401({ error: MESSAGE_CODE_INVALIDE });
    const err = await request('/auth/mfa/moi/codes', { method: 'POST', body: '{}' }, 'code').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(MESSAGE_CODE_INVALIDE);
    expect(retirees).toEqual([]);
  });

  it('mode `code` : tout autre 401 reste une session tombée', async () => {
    const { retirees } = repondre401({ error: 'token invalide ou expiré' });
    await request('/auth/mfa/moi/codes', { method: 'POST', body: '{}' }, 'code').catch(() => null);
    expect(retirees).toContain('mba.session');
  });

  it('mode `etape` : la raison du serveur remonte, et rien n’est vidé', async () => {
    const { retirees } = repondre401({ error: 'Cette étape a expiré, reconnectez-vous.' });
    const err = await request('/auth/mfa/verifier', { method: 'POST', body: '{}' }, 'etape').catch((e: unknown) => e);
    expect((err as ApiError).message).toBe('Cette étape a expiré, reconnectez-vous.');
    expect(retirees).toEqual([]);
  });
});
