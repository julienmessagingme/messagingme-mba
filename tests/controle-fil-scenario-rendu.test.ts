import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runControlSweep } from '../src/inbox/control-sweep';
import type { ControlSweepDeps } from '../src/inbox/control-sweep';
import type { ControlOwner } from '../src/inbox/store.pg';

/**
 * L'AGENT DE META REPREND LA MAIN, MÊME SUR UN FIL PRIS PAR UN SCÉNARIO.
 *
 * 🔴 CE FICHIER EST LA SOUPAPE DU GESTE `take`, ET IL EST NÉ DE LA QUESTION DE JULIEN (2026-09-14) : « le
 * MBA reprend quoi qu'il arrive la main après un délai (120 min par défaut), il faut que ça continue de
 * marcher ». La réponse était NON pour un fil de scénario, et c'est une régression que le correctif du jour
 * venait d'introduire.
 *
 * Pourquoi elle n'existait pas avant : `reclaimControl` n'écrivait que NOTRE colonne. Meta gardait le fil,
 * donc son agent reprenait la main tout seul, sans que personne ait rien à rendre. C'était précisément le
 * bug (l'agent de Meta répondait à la place du scénario). Depuis qu'on prend le fil POUR DE VRAI, un
 * parcours abandonné le garderait à jamais.
 *
 * ⚠️ LA FIN NORMALE D'UN PARCOURS REND DÉJÀ LE FIL (`releaseToMba`, câblé dans `wiring.ts`). Ce délai ne
 * couvre QUE les parcours qui ne finissent pas : le contact ne répond jamais, le run reste `waiting`.
 */

const HEURE = 60 * 60 * 1000;
const MAINTENANT = new Date('2026-09-14T12:00:00Z').getTime();

function deps(
  held: Array<{ owner: ControlOwner; changedAt: Date | null }>,
  over: Partial<ControlSweepDeps> = {},
): ControlSweepDeps & { ecrits: Array<{ owner: ControlOwner }>; rendus: string[]; vu: { age?: number } } {
  const ecrits: Array<{ owner: ControlOwner }> = [];
  const rendus: string[] = [];
  // ⚠️ UN OBJET MUTABLE, PAS UN GETTER : `Object.assign` plus bas INVOQUE un getter au lieu de le copier,
  // donc la valeur serait figée à `undefined` au moment du montage. Vu en écrivant ce test.
  const vu: { age?: number } = {};
  const d = {
    listHeldControl: async (_limit?: number, ageScenarioMs?: number) => {
      vu.age = ageScenarioMs;
      return held.map((h, i) => ({ tenantId: 't1', waId: `3360000000${i}`, owner: h.owner, changedAt: h.changedAt }));
    },
    setControlOwner: async (_t: string, _w: string, owner: ControlOwner, opts?: { only?: readonly ControlOwner[] }) => {
      // Reproduit la garde du SQL : une écriture qui ne change rien ne prend pas.
      if (opts?.only && !opts.only.includes(owner) && owner === 'app_workflow' && opts.only[0] === 'app_workflow') return false;
      if (opts?.only?.[0] === owner) return false;
      ecrits.push({ owner });
      return true;
    },
    timeouts: { app_human: 2 * HEURE, mba: 24 * HEURE, app_workflow: 24 * HEURE },
    mbaActifParTenant: async () => new Set(['t1']),
    releaseToMba: async (_t: string, waId: string) => { rendus.push(waId); },
    now: () => MAINTENANT,
    ...over,
  };
  return Object.assign(d, { ecrits, rendus, vu }) as never;
}

describe('un fil pris par un SCÉNARIO revient à l’agent de Meta', () => {
  it('🔴 au-delà du délai, il est rendu ET relâché chez Meta', async () => {
    const d = deps([{ owner: 'app_workflow', changedAt: new Date(MAINTENANT - 25 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(1);
    expect(d.ecrits).toEqual([{ owner: 'mba' }]);
    // 🔴 Le relâchement CHEZ META n'est pas un détail : sans lui, notre base dirait « mba » pendant que Meta
    // continuerait de nous croire maîtres du fil, et son agent resterait muet pour toujours.
    expect(d.rendus).toHaveLength(1);
  });

  it('avant le délai, on ne touche à rien', async () => {
    const d = deps([{ owner: 'app_workflow', changedAt: new Date(MAINTENANT - 3 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(0);
    expect(d.ecrits).toEqual([]);
  });

  it('🔴 LE DÉLAI HUMAIN N’A PAS BOUGÉ : 2 h, et il passe toujours à l’agent de Meta', async () => {
    // C'est la question exacte de Julien : « il faut que ça continue de marcher ».
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 3 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(1);
    expect(d.ecrits).toEqual([{ owner: 'mba' }]);
    expect(d.rendus).toHaveLength(1);
  });

  it('un humain dans sa fenêtre de 2 h garde la main', async () => {
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 1 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(0);
  });

  it('sans agent de Meta chez ce client, un fil de scénario n’est pas touché', async () => {
    // La destination vaudrait `app_workflow`, c'est-à-dire la valeur déjà portée : l'écriture ne prend pas.
    const d = deps([{ owner: 'app_workflow', changedAt: new Date(MAINTENANT - 25 * HEURE) }],
      { mbaActifParTenant: async () => new Set<string>() });
    expect(await runControlSweep(d)).toBe(0);
    expect(d.ecrits).toEqual([]);
  });

  it('🔴 le délai de scénario voyage jusqu’au SQL, pour ne pas saturer le lot', async () => {
    // ⚠️ `app_workflow` est l'état NORMAL de toute conversation. Les ramener toutes remplirait le lot de 500
    // avec des fils sains, et les `app_human` à rendre, plus anciens, ne seraient jamais atteints : le
    // balayage humain cesserait de fonctionner SANS rien signaler.
    const d = deps([]);
    await runControlSweep(d);
    expect(d.vu.age).toBe(24 * HEURE);
  });
});

describe('la requête qui alimente le balayage ramène bien ces fils', () => {
  const sql = readFileSync(resolve(__dirname, '../src/inbox/store.pg.ts'), 'utf8');
  const bloc = sql.slice(sql.indexOf('async listHeldControl'), sql.indexOf('async listHeldControl') + 3000);

  it('🔴 n’exclut plus inconditionnellement les fils de scénario', () => {
    // La requête disait `where control_owner <> 'app_workflow'` tout court : le balayage ne VOYAIT pas ces
    // conversations, donc corriger le balayage seul n'aurait rien changé.
    expect(bloc).toContain('make_interval');
  });

  it('⚠️ écarte toujours les conversations qui n’ont JAMAIS basculé', () => {
    // `control_changed_at is null` = personne n'a jamais pris ce fil, il n'y a rien à rendre.
    expect(bloc).toContain('control_changed_at is not null');
  });
});
