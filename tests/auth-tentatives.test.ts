import { describe, expect, it, vi } from 'vitest';
import { MESSAGE_PLAFOND_INDISPONIBLE } from '../src/auth/plafond-partage';
import { empreinteTentative, verifierTentative } from '../src/auth/tentatives';

describe('tentatives d’authentification', () => {
  it('produit une empreinte stable et bornée sans conserver l’adresse ni le jeton', () => {
    const premiere = empreinteTentative({ ip: '203.0.113.10' }, 'secret-google');
    expect(premiere).toBe(empreinteTentative({ ip: '203.0.113.10' }, 'secret-google'));
    expect(premiere).toHaveLength(64);
    expect(premiere).not.toContain('203.0.113.10');
    expect(premiere).not.toContain('secret-google');
  });

  it('distingue une limite atteinte d’un compteur indisponible', async () => {
    const consommer = vi.fn()
      .mockResolvedValueOnce({ accepte: true, indisponible: false, attenteMs: 0 })
      .mockResolvedValueOnce({ accepte: false, indisponible: false, attenteMs: 12_000 })
      .mockResolvedValueOnce({ accepte: false, indisponible: true, attenteMs: 5_000 });
    const plafond = { consommer };

    expect(await verifierTentative(plafond, 'cle')).toEqual({ acceptee: true });
    expect(await verifierTentative(plafond, 'cle')).toEqual({
      acceptee: false,
      attenteMs: 12_000,
      message: 'trop de tentatives, réessaie plus tard',
    });
    expect(await verifierTentative(plafond, 'cle')).toEqual({
      acceptee: false,
      attenteMs: 5_000,
      message: MESSAGE_PLAFOND_INDISPONIBLE,
    });
  });
});
