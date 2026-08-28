import { describe, it, expect } from 'vitest';
import { creerPoserTagAgent, normaliserTag, type DepsPoserTagAgent } from '../src/agent/poser-tag';

/**
 * Poser un tag depuis un agent.
 *
 * 🔴 CE TEST EXISTE PARCE QUE CETTE RÈGLE A DÉJÀ MENTI. L'outil `mba_poser_tag` posait le tag sur le contact
 * et s'arrêtait là, alors que sa description, montrée au client dans la console, promet « pour le retrouver
 * dans le mini-CRM ou DÉCLENCHER UNE AUTOMATION ». Un client qui règle une automation sur tag et instruit
 * son agent de le poser ne voyait jamais rien se déclencher, et rien ne le lui disait.
 */
function make(added: string[] = ['vip']) {
  const cap = { poses: [] as string[], declares: [] as string[], emis: [] as string[] };
  const deps: DepsPoserTagAgent = {
    ajouterAuContact: async (_t, _w, tag) => { cap.poses.push(tag); return { added }; },
    declarer: async (_t, tag) => { cap.declares.push(tag); },
    emettre: async (_t, _w, tag) => { cap.emis.push(tag); },
  };
  return { cap, poser: creerPoserTagAgent(deps) };
}

describe('creerPoserTagAgent', () => {
  it('🔴 fait les TROIS effets : le contact, le référentiel, et la file d’automations', async () => {
    const { cap, poser } = make();
    await poser('t1', '33600', 'vip');
    expect(cap.poses).toEqual(['vip']);
    expect(cap.declares).toEqual(['vip']);
    expect(cap.emis).toEqual(['vip']);
  });

  it('🔴 n’émet PAS quand le tag était déjà là', async () => {
    // Un agent qui repose le même tag à chaque tour relancerait l'automation pour un non-événement, donc
    // enverrait un message au contact chaque fois qu'il se répète.
    const { cap, poser } = make([]);
    await poser('t1', '33600', 'vip');
    expect(cap.poses).toEqual(['vip']);
    expect(cap.declares).toEqual(['vip']); // la déclaration, elle, reste : le référentiel est un union
    expect(cap.emis).toEqual([]);
  });

  it('une déclaration en échec n’empêche NI la pose NI l’émission', async () => {
    // Un référentiel incomplet est un désagrément, un outil qui lève est un tour d'agent mort.
    const cap = { emis: [] as string[] };
    const poser = creerPoserTagAgent({
      ajouterAuContact: async () => ({ added: ['vip'] }),
      declarer: async () => { throw new Error('référentiel injoignable'); },
      emettre: async (_t, _w, tag) => { cap.emis.push(tag); },
    });
    await expect(poser('t1', '33600', 'vip')).resolves.toBeUndefined();
    expect(cap.emis).toEqual(['vip']);
  });

  it('normalise avant tout, et de la MÊME façon pour les trois effets', async () => {
    // Sans ça « vip » et « vip  » seraient deux tags, et un tag posé sur le contact ne correspondrait pas à
    // celui déclaré ni à celui annoncé à l'automation.
    const { cap, poser } = make();
    await poser('t1', '33600', `  vip${'x'.repeat(100)}  `);
    expect(cap.poses[0]).toHaveLength(64);
    expect(cap.declares[0]).toBe(cap.poses[0]);
    expect(cap.emis[0]).toBe(cap.poses[0]);
  });

  it('un tag vide ne fait RIEN, et surtout n’émet pas', async () => {
    const { cap, poser } = make();
    for (const vide of ['', '   ', '\t\n ']) await poser('t1', '33600', vide);
    expect(cap.poses).toEqual([]);
    expect(cap.emis).toEqual([]);
  });

  it('`normaliserTag` est la même règle que celle du reste du produit', () => {
    expect(normaliserTag('  vip  ')).toBe('vip');
    expect(normaliserTag('x'.repeat(100))).toHaveLength(64);
    expect(normaliserTag('   ')).toBe('');
  });
});
