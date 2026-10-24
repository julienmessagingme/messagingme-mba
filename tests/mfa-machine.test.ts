import { describe, expect, it } from 'vitest';
import { creerMachineMfa, type ActionMfa, type OptionsSuite } from '../src/auth/mfa';
import { hashPasswordSync } from '../src/auth/password';
import { signEnrolement, signMfa, type EtapeConnexion } from '../src/auth/token';
import { EMETTEUR_TOTP, genererCodesSecours, uriOtpauth } from '../src/auth/totp';
import type { AuthUser } from '../src/auth/store';
import { MfaEnMemoire, comptesDe, identiteDe } from './mfa';

const SECRET = 'secret-machine-mfa';
const ADMIN: AuthUser = {
  id: 'u-admin',
  tenantId: 't1',
  email: 'admin@x.fr',
  role: 'admin',
  passwordHash: hashPasswordSync('mot-de-passe'),
};
const ETAPE: EtapeConnexion = {
  identityId: identiteDe(ADMIN.email),
  email: ADMIN.email,
  comptes: [{ userId: ADMIN.id, tenantId: ADMIN.tenantId, role: ADMIN.role }],
};

/**
 * Ce faux a délibérément la forme du store de production : ses méthodes lisent `this`. Une méthode recopiée
 * ou détachée de l'instance fait donc échouer le test au lieu de masquer le défaut par une flèche sans état.
 */
class MfaLiee extends MfaEnMemoire {
  readonly appels: string[] = [];

  override async lire(identityId: string) {
    this.appels.push('lire');
    return super.lire(identityId);
  }

  override async lireParCompte(userId: string) {
    this.appels.push('lireParCompte');
    return super.lireParCompte(userId);
  }

  override async marquerPas(identityId: string, pas: number) {
    this.appels.push('marquerPas');
    return super.marquerPas(identityId, pas);
  }

  override async noterReussite(identityId: string) {
    this.appels.push('noterReussite');
    return super.noterReussite(identityId);
  }
}

describe('machine d’état MFA', () => {
  it('🔴 garde le store lié à son instance pendant une connexion complète', async () => {
    const mfa = new MfaLiee(comptesDe([ADMIN]), ['t1']);
    mfa.poserFacteur(ADMIN.email);
    const suites: Array<{ etape: EtapeConnexion; options?: OptionsSuite }> = [];
    const machine = creerMachineMfa(
      { secret: SECRET, mfa },
      async (etape, options) => {
        suites.push({ etape, options });
        return { token: 'session' };
      },
    );

    const resultat = await machine({
      type: 'verifier_connexion',
      jeton: await signMfa(ETAPE, SECRET),
      code: mfa.codeSuivant(ADMIN.email),
    });

    expect(resultat).toEqual({ kind: 'succes', corps: { token: 'session' } });
    expect(suites).toEqual([{ etape: ETAPE, options: { facteur: 'totp' } }]);
    expect(mfa.appels).toEqual(['lire', 'marquerPas', 'noterReussite']);
  });

  it('rend un résultat nommé et ne journalise jamais le code refusé', async () => {
    const mfa = new MfaLiee(comptesDe([ADMIN]), ['t1']);
    mfa.poserFacteur(ADMIN.email);
    const journal: Array<{ action: ActionMfa; detail?: Record<string, unknown> }> = [];
    const machine = creerMachineMfa(
      {
        secret: SECRET,
        mfa,
        auditMfa: async (_identityId, action, detail) => {
          journal.push({ action, ...(detail ? { detail } : {}) });
        },
      },
      async () => ({ token: 'jamais' }),
    );

    const resultat = await machine({
      type: 'verifier_connexion',
      jeton: await signMfa(ETAPE, SECRET),
      code: '000000',
    });

    expect(resultat).toEqual({ kind: 'code_invalide' });
    expect(journal).toEqual([{ action: 'mfa.echec', detail: { etape: 'connexion' } }]);
    expect(JSON.stringify(journal)).not.toContain('000000');
  });

  it('conserve dans l’URI d’enrôlement l’adresse signée dans l’étape', async () => {
    const mfa = new MfaLiee(comptesDe([ADMIN]), ['t1']);
    const machine = creerMachineMfa({ secret: SECRET, mfa }, async () => ({}));
    const etape = { ...ETAPE, email: 'Admin@X.FR' };

    const resultat = await machine({
      type: 'commencer_enrolement_connexion',
      jeton: await signEnrolement(etape, SECRET),
    });

    expect(resultat.kind).toBe('succes');
    if (resultat.kind !== 'succes') return;
    const { secret, uri } = resultat.corps as { secret: string; uri: string };
    expect(uri).toBe(uriOtpauth(EMETTEUR_TOTP, etape.email, secret));
  });

  it('journalise un code de secours consommé avant une suite de connexion en échec', async () => {
    const mfa = new MfaLiee(comptesDe([ADMIN]), ['t1']);
    mfa.poserFacteur(ADMIN.email);
    const secours = genererCodesSecours();
    await mfa.remplacerCodesSecours(ETAPE.identityId, secours.empreintes);
    const actions: ActionMfa[] = [];
    const machine = creerMachineMfa(
      {
        secret: SECRET,
        mfa,
        auditMfa: async (_identityId, action) => { actions.push(action); },
      },
      async () => { throw new Error('session indisponible'); },
    );

    await expect(machine({
      type: 'verifier_connexion',
      jeton: await signMfa(ETAPE, SECRET),
      code: secours.clairs[0]!,
    })).rejects.toThrow('session indisponible');

    expect(actions).toEqual(['mfa.code_secours_utilise']);
  });

  it('refuse la désactivation obligatoire avant de vérifier ou consommer le code', async () => {
    const mfa = new MfaLiee(comptesDe([ADMIN]), ['t1']);
    mfa.poserFacteur(ADMIN.email);
    const machine = creerMachineMfa({ secret: SECRET, mfa }, async () => ({}));

    const resultat = await machine({
      type: 'desactiver_compte',
      userId: ADMIN.id,
      code: mfa.codeSuivant(ADMIN.email),
    });

    expect(resultat).toEqual({ kind: 'facteur_obligatoire', raison: 'espace' });
    expect(mfa.estActif(ADMIN.email)).toBe(true);
    expect(mfa.appels).toEqual(['lireParCompte', 'lire']);
  });
});
