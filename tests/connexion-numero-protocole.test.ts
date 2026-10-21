import { describe, expect, it } from 'vitest';
import {
  activerNumero,
  connecterNumero,
  type DepsActivationNumero,
  type DepsConnexionNumero,
  type TraceConnexionNumero,
} from '../src/account/connexion-numero';

describe('connexion du numéro possédée par account', () => {
  it('tient l’ordre complet jusqu’à la trace puis au crédit', async () => {
    const appels: string[] = [];
    let pinConserve: string | null = null;
    const deps: DepsConnexionNumero = {
      fournisseurDeLEspace: async () => { appels.push('fournisseur'); return null; },
      numeroDuTenant: async () => { throw new Error('inutile quand les identifiants sont annoncés'); },
      meta: {
        exchangeCode: async () => { appels.push('echange'); return 'jeton'; },
        verifyWaba: async () => { appels.push('preuve'); },
        wabasForToken: async () => { throw new Error('inutile'); },
        listPhones: async () => { throw new Error('inutile'); },
        getPhone: async () => {
          appels.push('numero');
          return {
            displayPhoneNumber: '+33600000000', verifiedName: 'Maison',
            status: 'PENDING', codeVerificationStatus: 'VERIFIED',
          };
        },
        subscribeApp: async () => { appels.push('webhooks'); },
        register: async (_numero, _jeton, pin) => { appels.push('register'); pinConserve = pin; },
      },
      inscriptions: {
        linkTenant: async () => { appels.push('rattachement'); },
        lierCompteSansNumero: async () => { throw new Error('inutile'); },
      },
      saveCredentials: async (_waba, _tenant, _jeton, pin) => {
        appels.push('identifiants');
        expect(pin).toBe(pinConserve);
      },
      offrirCredit: async () => { appels.push('credit'); },
    };
    const traces: TraceConnexionNumero[] = [];

    const r = await connecterNumero(deps, {
      tenantId: 't1', code: 'code', wabaId: 'w1', phoneNumberId: 'p1',
    }, async (trace) => { appels.push('trace'); traces.push(trace); });

    expect(r).toMatchObject({ ok: true, connected: true, wabaId: 'w1', phoneNumberId: 'p1' });
    expect(pinConserve).toMatch(/^\d{6}$/);
    expect(appels).toEqual([
      'fournisseur', 'echange', 'preuve', 'numero', 'rattachement', 'webhooks', 'register', 'identifiants', 'trace', 'credit',
    ]);
    expect(traces).toEqual([{ action: 'numero.connecte', wabaId: 'w1', phoneNumberId: 'p1', avertissements: 0 }]);
  });

  it('active après la vérification et sert le crédit avant le register', async () => {
    const appels: string[] = [];
    let pinMeta = '';
    const deps: DepsActivationNumero = {
      numeroDuTenant: async () => { appels.push('numero'); return 'p1'; },
      etatNumero: async () => { appels.push('etat'); return { status: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED' }; },
      verifierCode: async () => { appels.push('verification'); },
      offrirCredit: async () => { appels.push('credit'); },
      enregistrerNumero: async (_tenant, _numero, pin) => { appels.push('register'); pinMeta = pin; },
      sauverPin: async (_tenant, pin) => { appels.push('pin'); expect(pin).toBe(pinMeta); },
    };

    const r = await activerNumero(deps, { tenantId: 't1', code: '123456' }, async (trace) => {
      appels.push('trace');
      expect(trace).toEqual({ action: 'numero.active', phoneNumberId: 'p1', verificationFaite: true });
    });

    expect(r).toEqual({ ok: true, actif: true, deja: false });
    expect(appels).toEqual(['numero', 'etat', 'verification', 'credit', 'register', 'pin', 'trace']);
  });
});
