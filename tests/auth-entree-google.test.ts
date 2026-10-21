import { describe, expect, it, vi } from 'vitest';
import { entrerParGoogle } from '../src/auth/entree-google';
import type { CompteParAdresse } from '../src/auth/comptes';
import type { GoogleIdentity } from '../src/auth/google';

const identite = { email: 'alice@example.com', name: 'Alice', emailVerified: true, sub: 'google-1' } satisfies GoogleIdentity;

function deps(comptes: CompteParAdresse[] = []) {
  const createTenantWithAdmin = vi.fn(async () => ({ tenantId: 'tenant-new', userId: 'user-new' }));
  const touchLastLogin = vi.fn(async () => {});
  return {
    dependances: {
      verifyGoogle: vi.fn(async (_idToken: string): Promise<GoogleIdentity | null> => identite),
      comptes: { getByEmail: vi.fn(async () => comptes), createTenantWithAdmin, touchLastLogin },
    },
    createTenantWithAdmin,
    touchLastLogin,
  };
}

describe('entrée Google partagée', () => {
  it('refuse un jeton invalide ou une adresse non vérifiée avant de lire les comptes', async () => {
    for (const valeur of [null, { ...identite, emailVerified: false }]) {
      const d = deps();
      d.dependances.verifyGoogle.mockResolvedValueOnce(valeur);
      expect(await entrerParGoogle(d.dependances, 'jeton', 'console')).toEqual({ statut: 'invalide' });
      expect(d.dependances.comptes.getByEmail).not.toHaveBeenCalled();
    }
  });

  it('ne rend que les comptes actifs et distingue une adresse entièrement révoquée', async () => {
    const actif = { id: 'u-2', tenantId: 't-2', tenantName: 'Deux', role: 'agent', disabled: false };
    const revoque = { id: 'u-1', tenantId: 't-1', tenantName: 'Un', role: 'admin', disabled: true };
    const mixte = deps([revoque, actif]);
    expect(await entrerParGoogle(mixte.dependances, 'jeton')).toMatchObject({
      statut: 'ouverte', nouveau: false, comptes: [actif],
    });
    const aucun = deps([revoque]);
    expect(await entrerParGoogle(aucun.dependances, 'jeton')).toMatchObject({ statut: 'revoquee' });
  });

  it('signale une adresse inconnue sans créer quand aucune origine n’est autorisée', async () => {
    const d = deps();
    expect(await entrerParGoogle(d.dependances, 'jeton')).toMatchObject({ statut: 'inconnue' });
    expect(d.createTenantWithAdmin).not.toHaveBeenCalled();
  });

  it.each(['console', 'claude_code', 'client_mcp'] as const)(
    'crée un espace sans mot de passe avec l’origine %s et marque la connexion',
    async (origine) => {
      const d = deps();
      const resultat = await entrerParGoogle(d.dependances, 'jeton', origine);
      expect(resultat).toMatchObject({
        statut: 'ouverte', nouveau: true,
        comptes: [{ id: 'user-new', tenantId: 'tenant-new', tenantName: 'Espace de Alice', role: 'admin', disabled: false }],
      });
      expect(d.createTenantWithAdmin).toHaveBeenCalledWith(
        'Espace de Alice',
        { email: identite.email, name: identite.name, passwordHash: null },
        origine,
      );
      expect(d.touchLastLogin).toHaveBeenCalledWith('user-new');
    },
  );

  it('retombe sur « Mon espace » quand le nom Google est absent ou refusé', async () => {
    for (const name of [null, 'Alice\nMartin', 'Alice\u202Eevil']) {
      const d = deps();
      d.dependances.verifyGoogle.mockResolvedValueOnce({ ...identite, name });
      await entrerParGoogle(d.dependances, 'jeton', 'console');
      expect(d.createTenantWithAdmin).toHaveBeenCalledWith(
        'Mon espace',
        expect.objectContaining({ name }),
        'console',
      );
    }
  });

  it('n’attend pas l’horodatage de connexion et absorbe son échec', async () => {
    const d = deps();
    d.touchLastLogin.mockRejectedValueOnce(new Error('base indisponible'));
    await expect(entrerParGoogle(d.dependances, 'jeton', 'console')).resolves.toMatchObject({ statut: 'ouverte' });
  });
});
