import { describe, it, expect, vi } from 'vitest';
import { creerReveilCourt, REVEIL_COURT_MAX_MS } from '../src/workflow/reveil-court';
import type { DueRun } from '../src/workflow/wake-sweep';

/**
 * Le réveil court tient une pause de moins d'une minute à la seconde, là où le balayage ne passe qu'une fois par
 * minute. Les minuteries sont injectées (`poser`) : chaque test déclenche lui-même l'échéance.
 */
const du = (id: string): DueRun => ({ id, workflowId: 'wf', tenantId: 't1', waId: '33600', currentNode: 'w', grapheFige: null, lastMessageId: null });

function minuteries() {
  const posees: Array<{ ms: number; f: () => void }> = [];
  return { posees, poser: (ms: number, f: () => void) => { posees.push({ ms, f }); } };
}

/** Laisse les promesses en cours se résoudre (réclamation puis reprise). */
const vider = () => new Promise((r) => setTimeout(r, 0));

describe('creerReveilCourt', () => {
  it('pose la minuterie à l’échéance, réclame CE parcours puis le reprend', async () => {
    const m = minuteries();
    const reclamer = vi.fn(async (_t: string, id: string) => du(id));
    const reprendre = vi.fn(async () => true);
    const reveil = creerReveilCourt({ reclamer, reprendre, concurrence: 4, poser: m.poser });

    reveil.armer('t1', 'r1', new Date(10_000 + 4000), 10_000);
    expect(m.posees.map((p) => p.ms)).toEqual([4000]);
    expect(reclamer).not.toHaveBeenCalled(); // rien avant l'échéance

    m.posees[0]!.f();
    await vider();
    expect(reclamer).toHaveBeenCalledWith('t1', 'r1');
    expect(reprendre).toHaveBeenCalledWith(du('r1'));
  });

  it('une échéance d’une minute ou plus reste au balayage', () => {
    const m = minuteries();
    const reveil = creerReveilCourt({ reclamer: vi.fn(), reprendre: vi.fn(), concurrence: 4, poser: m.poser });
    reveil.armer('t1', 'r1', new Date(REVEIL_COURT_MAX_MS), 0);
    expect(m.posees).toEqual([]);
  });

  it('une échéance déjà passée part tout de suite (délai 0)', () => {
    const m = minuteries();
    const reveil = creerReveilCourt({ reclamer: vi.fn(), reprendre: vi.fn(), concurrence: 4, poser: m.poser });
    reveil.armer('t1', 'r1', new Date(5000), 6000);
    expect(m.posees.map((p) => p.ms)).toEqual([0]);
  });

  it('une réclamation qui rend `null` (déjà pris par le balayage, clos) ne reprend rien', async () => {
    const m = minuteries();
    const reprendre = vi.fn(async () => true);
    const reveil = creerReveilCourt({ reclamer: async () => null, reprendre, concurrence: 4, poser: m.poser });
    reveil.armer('t1', 'r1', new Date(1000), 0);
    m.posees[0]!.f();
    await vider();
    expect(reprendre).not.toHaveBeenCalled();
  });

  it('dix échéances simultanées : jamais plus de `concurrence` reprises en vol, et toutes finissent', async () => {
    const m = minuteries();
    let enVol = 0;
    let pic = 0;
    const liberer: Array<() => void> = [];
    const repris: string[] = [];
    const reprendre = async (run: DueRun) => {
      enVol += 1;
      pic = Math.max(pic, enVol);
      await new Promise<void>((r) => liberer.push(r));
      enVol -= 1;
      repris.push(run.id);
      return true;
    };
    const reveil = creerReveilCourt({ reclamer: async (_t, id) => du(id), reprendre, concurrence: 4, poser: m.poser });
    for (let i = 0; i < 10; i += 1) reveil.armer('t1', `r${i}`, new Date(1000), 0);
    for (const p of m.posees) p.f();
    for (let tour = 0; tour < 10; tour += 1) {
      await vider();
      liberer.splice(0).forEach((f) => f());
    }
    await vider();
    expect(pic).toBe(4);
    expect(repris.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`).sort());
  });

  it('🔴 après l’arrêt du processus, plus aucune réclamation : une échéance qui sonne encore ne reprend rien', async () => {
    // Sans ça, des reprises partaient pendant que l'arrêt fermait la file et le pool, et une reprise coupée entre l'envoi
    // et l'écriture laissait le parcours sous bail : le balayage du worker suivant renvoyait le même message.
    const m = minuteries();
    const reclamer = vi.fn(async (_t: string, id: string) => du(id));
    const reveil = creerReveilCourt({ reclamer, reprendre: async () => true, concurrence: 4, poser: m.poser });
    reveil.armer('t1', 'r1', new Date(1000), 0);
    expect(await reveil.arreter(1000)).toBe(0);
    m.posees[0]!.f();
    reveil.armer('t1', 'r2', new Date(1000), 0);
    m.posees.at(-1)?.f();
    await vider();
    expect(reclamer).not.toHaveBeenCalled();
  });

  it('l’arrêt attend les reprises en vol, borné, et dit combien il en a coupé', async () => {
    const m = minuteries();
    let liberer: () => void = () => {};
    const reprendre = () => new Promise<boolean>((r) => { liberer = () => r(true); });
    const reveil = creerReveilCourt({ reclamer: async (_t, id) => du(id), reprendre, concurrence: 4, poser: m.poser });
    reveil.armer('t1', 'r1', new Date(1000), 0);
    m.posees[0]!.f();
    await vider();
    expect(await reveil.arreter(20)).toBe(1); // borne atteinte, la reprise tourne encore
    const attente = reveil.arreter(1000);
    liberer();
    expect(await attente).toBe(0);
  });

  it('une reprise qui lève est journalisée et n’empêche pas la suivante', async () => {
    const m = minuteries();
    const erreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repris: string[] = [];
    const reprendre = async (run: DueRun) => {
      if (run.id === 'r1') throw new Error('réseau');
      repris.push(run.id);
      return true;
    };
    const reveil = creerReveilCourt({ reclamer: async (_t, id) => du(id), reprendre, concurrence: 1, poser: m.poser });
    reveil.armer('t1', 'r1', new Date(1000), 0);
    reveil.armer('t1', 'r2', new Date(1000), 0);
    for (const p of m.posees) p.f();
    await vider();
    await vider();
    expect(repris).toEqual(['r2']);
    expect(erreur).toHaveBeenCalled();
    erreur.mockRestore();
  });
});
