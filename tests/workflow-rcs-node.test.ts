import { describe, it, expect } from 'vitest';
import { parseGraph } from '../src/workflow/graph';
import { walk } from '../src/workflow/engine';
import type { EvalContext, BusinessHours } from '../src/workflow/conditions';

const pos = { x: 0, y: 0 };

const BH_9_18: BusinessHours = {
  '0': { closed: true, open: '', close: '' }, '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' }, '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};
const evalCtx = (over: Partial<EvalContext> = {}): EvalContext => ({
  fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
  now: new Date('2026-08-03T12:00:00Z'), timeZone: 'Europe/Paris', businessHours: BH_9_18, ...over,
});

describe('bloc rcs_message', () => {
  it('est accepte par parseGraph', () => {
    const g = parseGraph({
      nodes: [{ id: 'a', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } }],
      edges: [],
    });
    expect(g?.nodes[0]?.type).toBe('rcs_message');
  });

  it('rend la main a l executor avec le statut rcs_send, sans agir lui-meme', () => {
    const g = parseGraph({
      nodes: [
        { id: 'tag', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'promo' } },
        { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } },
      ],
      edges: [{ id: 'e1', source: 'tag', target: 'r' }],
    })!;
    const res = walk(g, 'tag', evalCtx());
    expect(res.rest).toEqual({ status: 'rcs_send', nodeId: 'r' });
    // Les actions accumulées AVANT le bloc partent quand même, comme pour un bloc d'attente.
    expect(res.actions.map((e) => e.action)).toEqual([{ kind: 'tag', tag: 'promo' }]);
  });

  it('n emet AUCUNE action pour le bloc lui-meme (l envoi est fait par l executor)', () => {
    const g = parseGraph({
      nodes: [{ id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } }],
      edges: [],
    })!;
    const res = walk(g, 'r', evalCtx());
    expect(res.actions).toEqual([]);
    expect(res.rest).toEqual({ status: 'rcs_send', nodeId: 'r' });
  });
});
