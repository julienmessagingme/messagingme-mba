import { describe, it, expect } from 'vitest';
import { OffresEnCache, VIE_OFFRE_MS } from '../src/offres/cache';
import { DROITS, type Offre } from '../src/offres/offres';
import type { OffreEspace } from '../src/offres/offre.pg';

/**
 * LE CACHE DE L'OFFRE (lot 6, tâche 2) : une lecture par espace et par 30 s au plus, sauf invalidation (le webhook du
 * Pro, l'exploitation). Un espace qui vient de payer est en Pro tout de suite sur la copie qui l'a appris.
 */
function source(offres: Record<string, Offre>) {
  let lectures = 0;
  return {
    get lectures() { return lectures; },
    async offreDe(tenantId: string): Promise<OffreEspace> {
      lectures += 1;
      const offre = offres[tenantId] ?? 'base';
      return { offre, droits: DROITS[offre], retourEnBaseLe: null };
    },
  };
}

describe('OffresEnCache', () => {
  it('la vie du cache est de 30 secondes', () => {
    expect(VIE_OFFRE_MS).toBe(30_000);
  });

  it('une seule lecture tant que l\'entrée est fraîche, une nouvelle après 30 s', async () => {
    let t = 0;
    const s = source({ t1: 'pro' });
    const c = new OffresEnCache(s, () => t);
    expect((await c.offreDe('t1')).offre).toBe('pro');
    t = 29_000;
    await c.offreDe('t1');
    expect(s.lectures).toBe(1);
    t = 30_001;
    await c.offreDe('t1');
    expect(s.lectures).toBe(2);
  });

  it('🔴 invalider fait relire tout de suite : l\'espace qui vient de payer passe en Pro', async () => {
    const offres: Record<string, Offre> = { t1: 'base' };
    const s = source(offres);
    const c = new OffresEnCache(s, () => 0);
    expect((await c.offreDe('t1')).offre).toBe('base');
    offres.t1 = 'pro';
    expect((await c.offreDe('t1')).offre).toBe('base');
    c.invalider('t1');
    expect((await c.offreDe('t1')).offre).toBe('pro');
  });

  it('un espace ne voit jamais l\'offre d\'un autre', async () => {
    const c = new OffresEnCache(source({ t1: 'pro', t2: 'entreprise' }), () => 0);
    expect((await c.offreDe('t1')).offre).toBe('pro');
    expect((await c.offreDe('t2')).offre).toBe('entreprise');
    expect((await c.offreDe('t3')).offre).toBe('base');
  });
});

describe('OffresEnCache, sur une panne', () => {
  it('🔴 une offre illisible LAISSE PASSER (tout ouvert, sans limite), journalise, et n’est pas gardée en mémoire', async () => {
    // Relecture finale du lot 6 : l'étape d'offre et les limites des magasins n'avaient pas de repli, donc une panne de
    // `offre_de_l_espace` rendait 500 partout, l'Inbox d'un espace Entreprise comprise. Le plan dit l'inverse : l'action
    // passe et l'incident est journalisé.
    let panne = true;
    let lectures = 0;
    const journal: Array<{ msg: string; tenantId: unknown }> = [];
    const c = new OffresEnCache(
      { offreDe: async (t: string) => { lectures += 1; if (panne) throw new Error('base indisponible'); return { offre: 'base', droits: DROITS.base, retourEnBaseLe: null, tenantId: t } as OffreEspace; } },
      () => 0,
      (msg, champs) => journal.push({ msg, tenantId: champs.tenantId }),
    );
    const o = await c.offreDe('t1');
    expect(o.droits.fonctions.size).toBe(DROITS.entreprise.fonctions.size);
    expect(o.droits.limites.contacts).toBeNull();
    expect(journal).toEqual([{ msg: 'offre_illisible', tenantId: 't1' }]);
    panne = false;
    expect((await c.offreDe('t1')).offre).toBe('base');
    expect(lectures).toBe(2);
  });
});
