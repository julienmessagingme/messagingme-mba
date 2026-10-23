import { describe, it, expect } from 'vitest';
import { avanceDuParcours } from '../src/webhooks/workflow-advance';

/**
 * UN PARCOURS GELÉ N'AVALE PLUS LE MESSAGE (relecture des correctifs de la filière application, 2026-10-22). Après une
 * prise de main, le parcours du répondeur reste en attente ; l'avance, gelée faute que le fil soit à nous, disait quand
 * même « un parcours attendait », la remise sautait, et la demande de réouverture d'une conversation « Traité » ne
 * s'ouvrait jamais. Elle ne prend désormais le message que si le fil est à nous.
 */
const ENTRANT = { reaction: false, formulaire: false };

function banc(o: { enAttente: boolean; aNous: boolean }) {
  const avances: string[] = [];
  const lus: string[] = [];
  const avance = avanceDuParcours({
    trouverEnAttente: async () => (o.enAttente ? { id: 'run-1' } : null),
    peutAgir: async () => { lus.push('peutAgir'); return o.aNous; },
    avancer: async (_t, _w, m) => { avances.push(m); },
  });
  return { avance, avances, lus };
}

describe('l’avance du parcours en attente', () => {
  it('🔴 un parcours en attente sur un fil à nous reçoit le message : la remise le laisse', async () => {
    const b = banc({ enAttente: true, aNous: true });
    expect(await b.avance('t1', '33612345678', 'M1', null, ENTRANT)).toBe(true);
    expect(b.avances).toEqual(['M1']);
  });

  it('🔴 un parcours gelé (le fil tenu par l’équipe) ne prend pas le message : la remise décide', async () => {
    const b = banc({ enAttente: true, aNous: false });
    expect(await b.avance('t1', '33612345678', 'M1', null, ENTRANT)).toBe(false);
    // L'avance est tentée quand même : l'exécuteur journalise le gel, comme avant.
    expect(b.avances).toEqual(['M1']);
  });

  it('sans parcours en attente : faux, et le détenteur du fil n’est pas lu', async () => {
    const b = banc({ enAttente: false, aNous: true });
    expect(await b.avance('t1', '33612345678', 'M1', null, ENTRANT)).toBe(false);
    expect(b.lus).toEqual([]);
  });
});
