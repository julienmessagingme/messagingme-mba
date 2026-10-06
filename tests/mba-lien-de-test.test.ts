import { describe, it, expect, vi } from 'vitest';
import { processTestTokens } from '../src/webhooks/test-token';
import { creerApresLAgent, ATTENTE_AGENT_MAX_MS } from '../src/mba/lien-de-test';
import { PHRASE_LIEN_DE_TEST, TYPE_LIEN_DE_TEST, type EvenementAgent } from '../src/mba/evenement';
import { entrantsDe } from './webhook-fixtures';

/**
 * LE MOT D'UN LIEN DE TEST ARRIVÉ À L'AGENT DE META (essai de Geoffrey du 2026-10-06).
 *
 * Reçu en `standby`, le mot est déjà chez l'agent, qui commence un tour. Lancer le test tout de suite lui reprenait le
 * fil en plein tour, et Meta envoyait son message de passage au milieu du scénario. Le test part désormais APRÈS le
 * tour de l'agent, à qui on a demandé une phrase prévue.
 */

const MOT = 'test-a7k2m9p3';
const payload = (field: string) => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, messages: [{ id: `wamid.${field}`, from: '33611', type: 'text', text: { body: MOT } }] } }] }],
});

function jetons() {
  const trace: string[] = [];
  const differes: Array<() => Promise<void>> = [];
  const deps = {
    findByTestToken: async () => ({ workflowId: 'wf1', tenantId: 't1' }),
    startTestRun: async () => { trace.push('demarre'); return true as const; },
    apresLAgent: (_t: string, _w: string, lancer: () => Promise<void>) => { trace.push('differe'); differes.push(lancer); },
  };
  return { trace, differes, deps };
}

describe('le jeton reçu en standby part après le tour de l’agent', () => {
  it('🔴 en standby : rien ne démarre pendant le traitement du webhook, le lancement est confié à l’attente', async () => {
    const { trace, differes, deps } = jetons();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const consumed = await processTestTokens(await entrantsDe(payload('standby')), deps);
    // Consommé tout de suite : sinon l'avance et les automations le traiteraient pendant l'attente.
    expect(consumed.has('wamid.standby')).toBe(true);
    expect(trace).toEqual(['differe']);
    await differes[0]!();
    expect(trace).toEqual(['differe', 'demarre']);
  });

  it('⚠️ hors standby (l’agent ne l’a pas reçu) : le test démarre tout de suite, comme avant', async () => {
    const { trace, deps } = jetons();
    await processTestTokens(await entrantsDe(payload('messages')), deps);
    expect(trace).toEqual(['demarre']);
  });
});

/** Une horloge fausse : `attendre` avance le temps, et l'agent « répond » au moment voulu. */
function attente(opts: { repondA?: number; refuse?: boolean; leveAuLancement?: boolean } = {}) {
  let maintenant = 0;
  const ordre: string[] = [];
  const evenements: EvenementAgent[] = [];
  const journal: string[] = [];
  const apres = creerApresLAgent({
    numero: async () => 'pn1',
    envoyer: async (_t, _pn, _to, event) => {
      if (opts.refuse) throw new Error('refusé');
      evenements.push(event);
      ordre.push('consigne');
      return { status: 'accepted' };
    },
    dernierMessageDeLAgent: async () => (opts.repondA !== undefined && maintenant >= opts.repondA ? 'echo-2' : 'echo-1'),
    attendre: async (ms) => { maintenant += ms; },
    maintenant: () => maintenant,
    journal: (l) => journal.push(l),
  });
  const lancer = async (): Promise<void> => {
    ordre.push(`lance a ${maintenant}`);
    if (opts.leveAuLancement) throw new Error('base indisponible');
  };
  return { apres, lancer, ordre, evenements, journal };
}

describe('l’attente du tour de l’agent', () => {
  it('🔴 la consigne demande la phrase prévue, et le test part à l’écho de l’agent, pas avant', async () => {
    const a = attente({ repondA: 15_000 });
    await a.apres('t1', '33611', a.lancer);
    expect(a.evenements.map((e) => e.type)).toEqual([TYPE_LIEN_DE_TEST]);
    expect(a.evenements[0]!.description).toContain(`« ${PHRASE_LIEN_DE_TEST} »`);
    // Le payload ne porte pas le mot du lien : c'est un secret de scénario.
    expect(a.evenements[0]!.payload).not.toContain('test-');
    expect(a.ordre).toEqual(['consigne', 'lance a 15000']);
    expect(a.journal.at(-1)).toContain('reponse en 15 s');
  });

  it('⚠️ l’agent ne répond pas : le test part quand même au bout de l’attente maximale', async () => {
    const a = attente();
    await a.apres('t1', '33611', a.lancer);
    expect(a.ordre).toEqual(['consigne', `lance a ${ATTENTE_AGENT_MAX_MS}`]);
    expect(a.journal.at(-1)).toContain('delai');
  });

  it('⚠️ consigne refusée par Meta : on attend quand même le tour, l’agent a reçu le mot', async () => {
    const a = attente({ repondA: 12_000, refuse: true });
    await a.apres('t1', '33611', a.lancer);
    expect(a.ordre).toEqual(['lance a 12000']);
    expect(a.journal.some((l) => l.includes('REFUSÉE'))).toBe(true);
  });

  it('⚠️ un lancement qui lève est journalisé, jamais remonté (personne n’attend cette promesse)', async () => {
    const a = attente({ repondA: 5_000, leveAuLancement: true });
    await expect(a.apres('t1', '33611', a.lancer)).resolves.toBeUndefined();
    expect(a.journal.at(-1)).toContain('base indisponible');
  });
});
