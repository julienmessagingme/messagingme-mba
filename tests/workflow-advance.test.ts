import { describe, it, expect, vi } from 'vitest';
import { processWorkflowAdvance } from '../src/webhooks/workflow-advance';

const payload = {
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'PN1' },
    contacts: [{ wa_id: '33600' }],
    messages: [
      { id: 'm1', from: '33600', type: 'text', text: { body: 'oui' } },
      { id: 'm2', from: '33601', type: 'text', text: { body: 'ok' } },
    ],
  } }] }],
};

describe('processWorkflowAdvance', () => {
  it('avance chaque message entrant (tenant résolu via phoneNumberTenant)', async () => {
    const calls: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => 't1',
      advance: async (t, w, m) => { calls.push(`${t}:${w}:${m}`); },
    });
    expect(calls).toEqual(['t1:33600:m1', 't1:33601:m2']);
  });

  it('ISOLÉ par message : une erreur sur un contact n\'empêche pas l\'avance des autres', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const done: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => 't1',
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('boom'); done.push(m); },
    });
    expect(done).toEqual(['m2']); // m1 a throw mais m2 est quand même traité
    vi.restoreAllMocks();
  });

  it('numéro non rattaché à un tenant -> pas d\'avance', async () => {
    const calls: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => null,
      advance: async (_t, _w, m) => { calls.push(m); },
    });
    expect(calls).toEqual([]);
  });

  it('transmet le bouton tapé à advance (type button -> payload) ; texte -> null', async () => {
    const seen: Array<{ w: string; bp: string | null }> = [];
    const p = { entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PN1' },
      contacts: [{ wa_id: '33600' }],
      messages: [
        { id: 'm1', from: '33600', type: 'text', text: { body: 'oui' } },
        { id: 'm2', from: '33602', type: 'button', button: { text: 'Non', payload: 'btn:1' } },
      ],
    } }] }] };
    await processWorkflowAdvance(p, {
      phoneNumberTenant: async () => 't1',
      advance: async (_t, w, _m, bp) => { seen.push({ w, bp }); },
    });
    expect(seen).toEqual([{ w: '33600', bp: null }, { w: '33602', bp: 'btn:1' }]);
  });

  it('un change `standby` (MBA tient le fil) NE fait PAS avancer le scénario', async () => {
    const calls: string[] = [];
    const p = { entry: [{ changes: [{ field: 'standby', value: {
      metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '33600' }],
      messages: [{ id: 'ms', from: '33600', type: 'text', text: { body: 'coucou' } }],
    } }] }] };
    await processWorkflowAdvance(p, {
      phoneNumberTenant: async () => 't1',
      advance: async (_t, _w, m) => { calls.push(m); },
    });
    expect(calls).toEqual([]); // le message est vu par l'inbox (processInbound), mais le scénario n'avance pas
  });
});

/**
 * 🔴 UNE PANNE D'AVANCE CESSE D'ÊTRE INVISIBLE (lot 4 du plan post-audit, 2026-09-02, migration 0108).
 *
 * Avant : l'exception était attrapée par message, un `console.error` était écrit, et le job webhook se
 * terminait EN SUCCÈS. Donc aucun rejeu, aucune DLQ, aucune trace consultable. Le contact restait bloqué sur
 * son bloc et personne ne l'apprenait jamais.
 *
 * ⚠️ L'isolation par message NE CHANGE PAS et reste testée juste au-dessus : une erreur sur un contact ne doit
 * pas emporter les autres messages du même webhook. C'est l'acquittement SILENCIEUX qu'on ferme, pas l'isolation.
 */
describe('processWorkflowAdvance : l’échec est journalisé', () => {
  it('🔴 une avance en échec est CONSIGNÉE, avec de quoi retrouver le fil', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const journal: Array<{ tenantId: string; waId: string; messageId: string; erreur: string }> = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => 't1',
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('Meta indisponible'); },
      journaliserEchec: async (e) => { journal.push(e); },
    });
    spy.mockRestore();
    expect(journal).toEqual([{ tenantId: 't1', waId: '33600', messageId: 'm1', erreur: 'Meta indisponible' }]);
  });

  it('🔴 un journal en PANNE ne casse rien : les autres messages avancent quand même', async () => {
    // Un journal d'échec qui ferait échouer le traitement qu'il observe serait une très mauvaise idée.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const done: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => 't1',
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('boom'); done.push(m); },
      journaliserEchec: async () => { throw new Error('table absente'); },
    });
    spy.mockRestore();
    expect(done).toEqual(['m2']);
  });

  it('sans numéro rattaché à un espace, on ne journalise PAS : la ligne n’aurait nulle part où aller', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const journal: unknown[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => { throw new Error('base injoignable'); },
      advance: async () => {},
      journaliserEchec: async (e) => { journal.push(e); },
    });
    spy.mockRestore();
    expect(journal).toEqual([]);
  });

  it('une instance SANS journal câblé garde le comportement d’avant', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const done: string[] = [];
    await processWorkflowAdvance(payload, {
      phoneNumberTenant: async () => 't1',
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('boom'); done.push(m); },
    });
    spy.mockRestore();
    expect(done).toEqual(['m2']);
  });
});
