import { describe, expect, it, vi } from 'vitest';
import {
  activerNumero,
  connecterNumero,
  EVENEMENT_COEXISTENCE,
  type DepsActivationNumero,
  type DepsConnexionNumero,
  type MetaInscriptionDep,
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
        surApplication: async () => { appels.push('application'); return false; },
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
      // Hors coexistence, l'appareil lié par QR code n'est jamais retiré : l'ordre attendu le dit.
      retirerCompteApplication: async () => { appels.push('retrait'); return 'aucun'; },
    };
    const traces: TraceConnexionNumero[] = [];

    const r = await connecterNumero(deps, {
      tenantId: 't1', code: 'code', wabaId: 'w1', phoneNumberId: 'p1',
    }, async (trace) => { appels.push('trace'); traces.push(trace); });

    expect(r).toMatchObject({ ok: true, connected: true, wabaId: 'w1', phoneNumberId: 'p1', coexistence: false });
    expect(pinConserve).toMatch(/^\d{6}$/);
    expect(appels).toEqual([
      'fournisseur', 'echange', 'preuve', 'numero', 'application', 'rattachement', 'webhooks', 'register', 'identifiants', 'trace', 'credit',
    ]);
    expect(traces).toEqual([{ action: 'numero.connecte', wabaId: 'w1', phoneNumberId: 'p1', avertissements: 0, coexistence: false }]);
  });

  it('active après la vérification et sert le crédit avant le register', async () => {
    const appels: string[] = [];
    let pinMeta = '';
    const deps: DepsActivationNumero = {
      numeroDuTenant: async () => { appels.push('numero'); return 'p1'; },
      enCoexistence: async () => { appels.push('coexistence'); return false; },
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
    // La coexistence se lit avant Meta : un numéro en coexistence n'a rien à activer (`tests/numero-activation.test.ts`).
    expect(appels).toEqual(['numero', 'coexistence', 'etat', 'verification', 'credit', 'register', 'pin', 'trace']);
  });
});

/**
 * LA COEXISTENCE (plan `docs/superpowers/plans/2026-10-24-coexistence.md`, tâche 2) : le numéro reste dans l'application
 * WhatsApp Business et passe aussi sur l'API Cloud. 🔴 Jamais `/register` sur un tel numéro (l'application l'a déjà
 * enregistré), et un espace relié par QR code ne garde pas deux filières vivantes : son appareil lié se retire.
 */
describe('connexion en coexistence', () => {
  /** Un numéro vérifié qui n'est pas encore `CONNECTED` : hors coexistence, le parcours ordinaire l'enregistre. */
  const PHONE: Awaited<ReturnType<MetaInscriptionDep['getPhone']>> = {
    displayPhoneNumber: '+44 1555 479304', verifiedName: 'Maison', status: 'PENDING', codeVerificationStatus: 'VERIFIED',
  };

  /** `surApplication` : ce que Meta dit du numéro ; absent, il le dit dans l'application (le cas réel d'une coexistence). */
  function monter(o: {
    surApplication?: boolean | null;
    retrait?: () => Promise<'retire' | 'aucun' | 'echec'>;
    phone?: typeof PHONE;
  } = {}) {
    const appels: string[] = [];
    const lies: Array<{ coexistence: boolean }> = [];
    const pins: Array<string | null> = [];
    const deps: DepsConnexionNumero = {
      fournisseurDeLEspace: async () => null,
      numeroDuTenant: async () => { throw new Error('inutile quand les identifiants sont annoncés'); },
      meta: {
        exchangeCode: async () => 'jeton',
        verifyWaba: async () => {},
        wabasForToken: async () => { throw new Error('inutile'); },
        listPhones: async () => { throw new Error('inutile'); },
        getPhone: async () => { appels.push('numero'); return o.phone ?? PHONE; },
        surApplication: async () => { appels.push('application'); return o.surApplication === undefined ? true : o.surApplication; },
        subscribeApp: async () => { appels.push('webhooks'); },
        register: async () => { appels.push('register'); },
      },
      inscriptions: {
        linkTenant: async (input) => { appels.push('rattachement'); lies.push({ coexistence: input.coexistence }); },
        lierCompteSansNumero: async () => { throw new Error('inutile'); },
      },
      saveCredentials: async (_waba, _tenant, _jeton, pin) => { appels.push('identifiants'); pins.push(pin); },
      offrirCredit: async () => { appels.push('credit'); },
      retirerCompteApplication: async () => { appels.push('retrait'); return o.retrait ? o.retrait() : 'retire'; },
    };
    const traces: TraceConnexionNumero[] = [];
    const connecter = (evenement?: string) => connecterNumero(deps, {
      tenantId: 't1', code: 'code', wabaId: 'w1', phoneNumberId: 'p1', ...(evenement !== undefined ? { evenement } : {}),
    }, async (trace) => { appels.push('trace'); traces.push(trace); });
    return { connecter, appels, lies, pins, traces };
  }

  it('🔴 coexistence annoncée par la fenêtre : aucun register, aucun PIN, rattachée en coexistence, crédit offert', async () => {
    const m = monter();
    const r = await m.connecter(EVENEMENT_COEXISTENCE);
    expect(r).toEqual({
      ok: true, connected: true, wabaId: 'w1', phoneNumberId: 'p1', displayPhoneNumber: '+44 1555 479304',
      aActiver: false, coexistence: true, warnings: [],
    });
    expect(m.appels).not.toContain('register');
    // Meta est interrogé quand même, une fois : seul son signal ouvre le crédit (jamais l'événement, que le navigateur envoie).
    expect(m.appels.filter((a) => a === 'application')).toHaveLength(1);
    expect(m.lies).toEqual([{ coexistence: true }]);
    expect(m.pins).toEqual([null]);
    expect(m.appels).toContain('credit');
    expect(m.traces).toEqual([{ action: 'numero.connecte', wabaId: 'w1', phoneNumberId: 'p1', avertissements: 0, coexistence: true }]);
  });

  it('🔴 coexistence lue chez Meta sans l’événement (un parcours rejoué n’annonce rien) : la même issue', async () => {
    const m = monter({ surApplication: true });
    const r = await m.connecter('FINISH');
    expect(r).toMatchObject({ ok: true, connected: true, aActiver: false, coexistence: true, warnings: [] });
    expect(m.appels.indexOf('application')).toBeGreaterThan(m.appels.indexOf('numero'));
    expect(m.appels).not.toContain('register');
    expect(m.lies).toEqual([{ coexistence: true }]);
    expect(m.pins).toEqual([null]);
    expect(m.appels).toContain('credit');
  });

  it('🔴 l’événement seul, Meta contraire ou muet, sur un numéro NOT_VERIFIED : ni register, ni « à activer », et AUCUN crédit', async () => {
    // L'événement est une chaîne que le navigateur envoie librement à la route : il saute /register et retire l'appareil lié
    // (des effets qui ne touchent que l'espace du demandeur), il n'ouvre jamais le crédit. Sinon la fenêtre ordinaire, un
    // numéro laissé NOT_VERIFIED et un corps qui annonce la coexistence récolteraient l'offre fermée le 2026-09-29.
    const avertis = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const surApplication of [false, null] as const) {
        for (const codeVerificationStatus of ['NOT_VERIFIED', null] as const) {
          const cas = `is_on_biz_app ${String(surApplication)}, ${String(codeVerificationStatus)}`;
          const m = monter({ surApplication, phone: { ...PHONE, codeVerificationStatus } });
          expect(await m.connecter(EVENEMENT_COEXISTENCE), cas).toMatchObject({ ok: true, aActiver: false, coexistence: true });
          // Meta est toujours interrogé, et rien de ce qu'il dit n'autorise l'offre.
          expect(m.appels, cas).toContain('application');
          expect(m.appels, cas).not.toContain('register');
          expect(m.appels, cas).not.toContain('credit');
        }
      }
      // Le désaccord entre la fenêtre et Meta est journalisé.
      expect(avertis.mock.calls.flat().join(' ')).toContain('Meta rend is_on_biz_app faux');
    } finally {
      avertis.mockRestore();
    }
  });

  it('🔴 l’événement et Meta d’accord (is_on_biz_app vrai), sur un numéro NOT_VERIFIED : le crédit est offert', async () => {
    const m = monter({ surApplication: true, phone: { ...PHONE, codeVerificationStatus: 'NOT_VERIFIED' } });
    expect(await m.connecter(EVENEMENT_COEXISTENCE)).toMatchObject({ ok: true, aActiver: false, coexistence: true, warnings: [] });
    expect(m.appels).not.toContain('register');
    expect(m.appels).toContain('credit');
  });

  it('🔴 surApplication en échec (null) : le parcours ordinaire, intact (un register, hors coexistence)', async () => {
    const m = monter({ surApplication: null });
    const r = await m.connecter();
    expect(r).toMatchObject({ ok: true, connected: true, coexistence: false });
    expect(m.appels.filter((a) => a === 'register')).toHaveLength(1);
    expect(m.lies).toEqual([{ coexistence: false }]);
    expect(m.pins[0]).toMatch(/^\d{6}$/);
    expect(m.appels).not.toContain('retrait');
  });

  it('🔴 espace relié par QR code : l’appareil lié se retire APRÈS le rattachement, et seulement en coexistence', async () => {
    const m = monter();
    await m.connecter(EVENEMENT_COEXISTENCE);
    expect(m.appels.indexOf('retrait')).toBeGreaterThan(m.appels.indexOf('rattachement'));
    // Le parcours ordinaire ne retire jamais rien.
    const ordinaire = monter({ surApplication: false });
    await ordinaire.connecter('FINISH');
    expect(ordinaire.appels).not.toContain('retrait');
  });

  it('🔴 le retrait en échec : l’issue reste un succès, avec l’avertissement, jamais un refus', async () => {
    const avertissement = 'L’appareil lié par QR code n’a pas pu être retiré de notre côté : WhatsApp l’a déjà délié, et l’espace passe par l’API.';
    const echec = monter({ retrait: async () => 'echec' });
    expect(await echec.connecter(EVENEMENT_COEXISTENCE)).toMatchObject({ ok: true, connected: true, coexistence: true, warnings: [avertissement] });
    // Une panne qui lève (la base) vaut un échec : le rattachement est fait, il ne se défait pas.
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const panne = monter({ retrait: async () => { throw new Error('base indisponible'); } });
      expect(await panne.connecter(EVENEMENT_COEXISTENCE)).toMatchObject({ ok: true, connected: true, coexistence: true, warnings: [avertissement] });
      expect(panne.appels).toContain('credit');
    } finally {
      erreurs.mockRestore();
    }
    // Rien à retirer (aucun compte, ou déjà retiré) : rien à dire.
    const aucun = monter({ retrait: async () => 'aucun' });
    expect(await aucun.connecter(EVENEMENT_COEXISTENCE)).toMatchObject({ ok: true, warnings: [] });
  });
});
