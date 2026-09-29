import { describe, it, expect, vi } from 'vitest';
import { processWorkflowAdvance } from '../src/webhooks/workflow-advance';
import { aucuneRepriseSurBouton, entrantsDe } from './webhook-fixtures';

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
  it('avance chaque message entrant (espace déjà rattaché)', async () => {
    const calls: string[] = [];
    await processWorkflowAdvance(await entrantsDe(payload), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async (t, w, m) => { calls.push(`${t}:${w}:${m}`); },
    });
    expect(calls).toEqual(['t1:33600:m1', 't1:33601:m2']);
  });

  it('ISOLÉ par message : une erreur sur un contact n\'empêche pas l\'avance des autres', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const done: string[] = [];
    await processWorkflowAdvance(await entrantsDe(payload), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('boom'); done.push(m); },
    });
    expect(done).toEqual(['m2']); // m1 a throw mais m2 est quand même traité
    vi.restoreAllMocks();
  });

  it('numéro non rattaché à un tenant -> pas d\'avance', async () => {
    const calls: string[] = [];
    await processWorkflowAdvance(await entrantsDe(payload, null), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
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
    await processWorkflowAdvance(await entrantsDe(p), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
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
    await processWorkflowAdvance(await entrantsDe(p), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
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
type LigneJournal = {
  tenantId: string; waId: string; messageId: string; erreur: string;
  workflowId?: string | null; runId?: string | null; canal?: string | null;
};

describe('processWorkflowAdvance : l’échec est journalisé', () => {
  it('🔴 une avance en échec est CONSIGNÉE, avec de quoi retrouver le fil', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const journal: LigneJournal[] = [];
    await processWorkflowAdvance(await entrantsDe(payload), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('Meta indisponible'); },
      journaliserEchec: async (e) => { journal.push(e); },
    });
    spy.mockRestore();
    // Le CANAL est connu de ce point d'appel sans rien demander : c'est le webhook Meta, donc WhatsApp. Il
    // était pourtant laissé nul, comme les deux autres colonnes de contexte de la migration 0108.
    expect(journal).toEqual([{ tenantId: 't1', waId: '33600', messageId: 'm1', erreur: 'Meta indisponible', canal: 'whatsapp' }]);
  });

  it('🔴 le PARCOURS et le RUN traversent, quand l’erreur les porte (constat B1)', async () => {
    // Les trois colonnes de contexte de la migration 0108 étaient NULLES sur 100 % des lignes : la jointure
    // qui cherche le nom du scénario ne rendait donc jamais rien, et l'exploitant lisait « ce contact est
    // bloqué » sans savoir dans quel parcours. Le contexte n'existe que dans l'exécuteur, il le rattache
    // désormais à l'erreur qu'il ré-émet.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const journal: LigneJournal[] = [];
    await processWorkflowAdvance(await entrantsDe(payload), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async (_t, _w, m) => {
        if (m !== 'm1') return;
        throw Object.assign(new Error('Meta indisponible'), {
          contexteAvance: { workflowId: 'wf-9', runId: 'run-7', canal: 'rcs' },
        });
      },
      journaliserEchec: async (e) => { journal.push(e); },
    });
    spy.mockRestore();
    expect(journal[0]).toMatchObject({ workflowId: 'wf-9', runId: 'run-7' });
    // Le canal PORTÉ par l'erreur gagne sur le repli du point d'appel : un bloc RCS échoue en RCS, même si
    // c'est un webhook WhatsApp qui a déclenché l'avance.
    expect(journal[0]?.canal).toBe('rcs');
  });

  it('une erreur SANS contexte rend des colonnes nulles, elle ne casse rien', async () => {
    // Panne avant que le run soit trouvé, appelant de test, exécuteur plus ancien : la lecture est défensive
    // par construction. Un journal d'échec ne doit jamais échouer à cause de la FORME de l'échec qu'il observe.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const journal: LigneJournal[] = [];
    await processWorkflowAdvance(await entrantsDe(payload), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async (_t, _w, m) => {
        if (m === 'm1') throw Object.assign(new Error('boum'), { contexteAvance: 'pas un objet' });
      },
      journaliserEchec: async (e) => { journal.push(e); },
    });
    spy.mockRestore();
    expect(journal[0]).toMatchObject({ erreur: 'boum', canal: 'whatsapp' });
    expect(journal[0]?.workflowId).toBeUndefined();
  });

  it('🔴 un journal en PANNE ne casse rien : les autres messages avancent quand même', async () => {
    // Un journal d'échec qui ferait échouer le traitement qu'il observe serait une très mauvaise idée.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const done: string[] = [];
    await processWorkflowAdvance(await entrantsDe(payload), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('boom'); done.push(m); },
      journaliserEchec: async () => { throw new Error('table absente'); },
    });
    spy.mockRestore();
    expect(done).toEqual(['m2']);
  });

  it('numéro inconnu : ni avance ni journal, la ligne n’aurait nulle part où aller', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const journal: unknown[] = [];
    await processWorkflowAdvance(await entrantsDe(payload, null), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async () => { throw new Error('boum'); },
      journaliserEchec: async (e) => { journal.push(e); },
    });
    spy.mockRestore();
    expect(journal).toEqual([]);
  });

  it('une instance SANS journal câblé garde le comportement d’avant', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const done: string[] = [];
    await processWorkflowAdvance(await entrantsDe(payload), { reprendreSurNotreBouton: aucuneRepriseSurBouton,
      advance: async (_t, _w, m) => { if (m === 'm1') throw new Error('boom'); done.push(m); },
    });
    spy.mockRestore();
    expect(done).toEqual(['m2']);
  });
});

describe('processWorkflowAdvance : un tap sur NOS boutons arrivé en standby (2026-09-29)', () => {
  /**
   * Vécu le 2026-09-29 : un scénario lancé depuis l'Inbox envoie un modèle, le contact tape « En savoir plus »,
   * Meta livre ce tap en `standby` et le parcours, qui l'attendait, ne bouge plus : ni assignation, ni escalade.
   */
  const enStandby = (message: Record<string, unknown>) => ({ entry: [{ changes: [{ field: 'standby', value: {
    metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '33600' }], messages: [message],
  } }] }] });
  const bouton = (payload: string) => enStandby({ id: 'mb', from: '33600', type: 'button', button: { text: 'En savoir plus', payload } });

  it('🔴 un parcours attend : on reprend le fil et le scénario avance, sur la bonne branche', async () => {
    const reprises: string[] = [];
    const avances: Array<{ w: string; bp: string | null }> = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await processWorkflowAdvance(await entrantsDe(bouton('btn:0')), {
      reprendreSurNotreBouton: async (t, w) => { reprises.push(`${t}:${w}`); return true; },
      advance: async (_t, w, _m, bp) => { avances.push({ w, bp }); },
    });
    expect(reprises).toEqual(['t1:33600']);
    expect(avances).toEqual([{ w: '33600', bp: 'btn:0' }]);
  });

  it('un bouton de carrousel est aussi à nous', async () => {
    const avances: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await processWorkflowAdvance(await entrantsDe(bouton('card:2:btn:1')), {
      reprendreSurNotreBouton: async () => true,
      advance: async (_t, _w, _m, bp) => { avances.push(String(bp)); },
    });
    expect(avances).toEqual(['card:2:btn:1']);
  });

  it('aucun parcours n’attend, ou Meta refuse : la réponse reste à l’agent de Meta', async () => {
    const avances: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await processWorkflowAdvance(await entrantsDe(bouton('btn:0')), {
      reprendreSurNotreBouton: async () => false,
      advance: async (_t, _w, m) => { avances.push(m); },
    });
    expect(avances).toEqual([]);
  });

  it('🔴 un TEXTE libre en standby ne reprend rien : rien ne dit qu’il s’adresse au scénario', async () => {
    const reprises: string[] = [];
    const avances: string[] = [];
    await processWorkflowAdvance(await entrantsDe(enStandby({ id: 'mt', from: '33600', type: 'text', text: { body: 'bonjour' } })), {
      reprendreSurNotreBouton: async (t) => { reprises.push(t); return true; },
      advance: async (_t, _w, m) => { avances.push(m); },
    });
    expect(reprises).toEqual([]);
    expect(avances).toEqual([]);
  });

  it('un bouton qui n’a pas notre forme (celui d’un autre outil) ne reprend rien', async () => {
    const reprises: string[] = [];
    await processWorkflowAdvance(await entrantsDe(bouton('MBA_QUICK_REPLY_1')), {
      reprendreSurNotreBouton: async (t) => { reprises.push(t); return true; },
      advance: async () => {},
    });
    expect(reprises).toEqual([]);
  });
});
