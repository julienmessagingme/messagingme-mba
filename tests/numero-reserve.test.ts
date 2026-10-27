import { describe, it, expect, vi } from 'vitest';
import { droitAuNumero, numerosDisponibles, servirLAttente, type DepsReserve } from '../src/numero/reserve';

/**
 * La réserve de numéros fournis (`src/numero/reserve.ts`), le seul exemplaire de « un numéro rendu va à l'abonné qui
 * attend » (audit de structure du 2026-10-25 : quatre copies, quatre façons d'échouer).
 */
function reserve(o: { libres?: number; attente?: string[]; attribues?: Record<string, string>; abonnements?: Record<string, string>; attribuerLeve?: boolean } = {}) {
  const gestes: string[] = [];
  const deps: DepsReserve = {
    numeros: {
      attribuer: async (t) => {
        gestes.push(`attribuer:${t}`);
        if (o.attribuerLeve) throw new Error('base indisponible');
        return { numero: '33100000001' };
      },
      compterLibres: async () => o.libres ?? 0,
      numeroDeLEspace: async (t) => (o.attribues?.[t] ? { numero: o.attribues[t]! } : null),
    },
    abonnements: {
      enAttenteDeNumero: async () => o.attente ?? [],
      deLEspace: async (t) => (o.abonnements?.[t] ? { statut: o.abonnements[t]! } : null),
    },
  };
  return { deps, gestes };
}

describe('servirLAttente : un numéro revenu à la réserve', () => {
  it('🔴 va à l’abonné qui attend depuis le plus longtemps, jamais à l’espace qui vient de le rendre', async () => {
    const { deps, gestes } = reserve({ attente: ['t-qui-rend', 't-ancien', 't-recent'] });
    expect(await servirLAttente(deps, 't-qui-rend', 'abandon')).toEqual({ tenantId: 't-ancien', numero: '33100000001' });
    expect(gestes).toEqual(['attribuer:t-ancien']);
  });

  it('une déclaration dans /ops (`sauf` nul) sert le premier de la file', async () => {
    const { deps } = reserve({ attente: ['t-ancien', 't-recent'] });
    expect((await servirLAttente(deps, null, 'declaration_ops'))?.tenantId).toBe('t-ancien');
  });

  it('personne n’attend : rien n’est attribué', async () => {
    const { deps, gestes } = reserve({ attente: ['t-qui-rend'] });
    expect(await servirLAttente(deps, 't-qui-rend', 'liberation')).toBeNull();
    expect(gestes).toEqual([]);
  });

  it('🔴 ne lève JAMAIS : le geste d’avant a réussi, un échec ici se journalise (l’abonné non servi nommé) et rend null', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = reserve({ attente: ['t-ancien'], attribuerLeve: true });
    await expect(servirLAttente(deps, null, 'declaration_ops', { par: 'exploitant@exemple.test' })).resolves.toBeNull();
    const ligne = JSON.parse(String(erreurs.mock.calls.at(-1)?.[0]));
    expect(ligne).toMatchObject({ msg: 'numero_abonne_en_attente_non_servi', tenantId: 't-ancien', origine: 'declaration_ops', par: 'exploitant@exemple.test' });
    const enPanne = { ...deps, abonnements: { ...deps.abonnements, enAttenteDeNumero: async () => { throw new Error('base'); } } };
    await expect(servirLAttente(enPanne, 't', 'suppression_espace')).resolves.toBeNull();
  });
});

describe('numerosDisponibles et droitAuNumero', () => {
  it('les libres moins les abonnés qui attendent, jamais négatif', async () => {
    expect(await numerosDisponibles(reserve({ libres: 5, attente: ['a', 'b'] }).deps)).toBe(3);
    expect(await numerosDisponibles(reserve({ libres: 1, attente: ['a', 'b'] }).deps)).toBe(0);
  });

  it('🔴 pas de numéro avant le paiement : attribué, puis abonnement vivant, puis une offre qui l’inclut, sinon aucun droit', async () => {
    // L'offre qui inclut le numéro se lit dans la grille (`limites.numeroInclus`) : le Pro, le Business et l'Entreprise.
    const offre = (inclus: boolean) => ({ offre: { numeroInclus: async () => inclus } });
    const base = reserve({ attribues: { t1: '331' }, abonnements: { t2: 'actif', t3: 'en_retard', t4: 'resilie' } }).deps;
    expect(await droitAuNumero({ ...base, ...offre(false) }, 't1')).toBe('attribue');
    expect(await droitAuNumero({ ...base, ...offre(false) }, 't2')).toBe('abonne');
    expect(await droitAuNumero({ ...base, ...offre(false) }, 't3')).toBe('abonne');
    expect(await droitAuNumero({ ...base, ...offre(false) }, 't4'), 'un abonnement résilié ne donne rien').toBeNull();
    expect(await droitAuNumero({ ...base, ...offre(true) }, 't4')).toBe('inclus');
    expect(await droitAuNumero({ ...base, ...offre(false) }, 't5')).toBeNull();
  });
});
