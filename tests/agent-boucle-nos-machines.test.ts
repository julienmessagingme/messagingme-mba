import { describe, it, expect } from 'vitest';
import { jamaisDesabonne, jamaisNosMachines } from './consentement';
import { runTurn, type RunTurnDeps } from '../src/agent/run-turn';
import { ecritParUneMachine, FENETRE_NOS_MACHINES_SECONDES } from '../src/agent/nos-machines.pg';
import type { FicheAgent } from '../src/agent/agent-store';
import type { AgentSession } from '../src/agent/session-store';
import type { OrigineMessage } from '../src/inbox/origine';
import { FakeAgentBrain } from './fake-agent-brain';

/**
 * 🔴 LA BOUCLE DU 2026-10-30, rejouée. L'espace de démo (numéro en 0247) et l'espace newCompany (le WhatsApp Business du
 * téléphone de Julien, relié par QR code) ont chacun un agent IA. Julien touche la bulle de la démo depuis ce téléphone :
 * le message part, à la main, du numéro de newCompany vers celui de la démo. Sans garde, chaque agent répond à l'autre
 * jusqu'au plafond de tours de sa session. Avec elle, la démo répond une fois, et l'agent de newCompany se tait.
 *
 * La lecture en base (`creerEcritParNosMachines`) est tenue par `tests/integration/nos-machines.integration.test.ts` ;
 * ici, la même règle sur un journal en mémoire, et le VRAI `runTurn` des deux côtés.
 */

const DEMO = { tenant: 'demo', numero: '33100000247' };
const NEWCO = { tenant: 'newco', numero: '441555479304' };
const ESPACES = [DEMO, NEWCO];

const FICHE: FicheAgent = {
  id: 'ag', tenantId: 'x', mentionIa: 'Je suis une IA.', mentionIaFrequence: 'session' as const, modele: 'm', status: 'active',
  plafonds: { maxTours: 20, maxAppelsOutils: 12, budgetMicroEur: 1_000_000 },
  inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
};

interface Sortant { tenant: string; waId: string; origin: OrigineMessage; at: number }

function monde(ecritParNosMachines: RunTurnDeps['ecritParNosMachines'] | 'journal') {
  let maintenant = Date.parse('2026-10-30T19:28:00Z');
  const sortants: Sortant[] = [];
  const tours = new Map<string, number>();
  const aJouer: Array<{ tenant: string; waId: string }> = [];
  const reponses: Record<string, number> = { demo: 0, newco: 0 };

  /** Ce qu'un message envoyé par `de` à `waId` produit chez nous : un tour d'agent dans l'espace que sert ce numéro. */
  const livrer = (de: string, waId: string) => {
    const dest = ESPACES.find((e) => e.numero === waId);
    const exp = ESPACES.find((e) => e.tenant === de)!;
    if (dest) aJouer.push({ tenant: dest.tenant, waId: exp.numero });
  };

  /** La règle de `creerEcritParNosMachines`, sur le journal en mémoire. */
  const parLeJournal = async (tenantId: string, waId: string): Promise<boolean> => {
    const eux = ESPACES.find((e) => e.numero === waId && e.tenant !== tenantId);
    const nous = ESPACES.find((e) => e.tenant === tenantId)!;
    if (!eux) return false;
    const dernier = sortants
      .filter((s) => s.tenant === eux.tenant && s.waId === nous.numero && s.at > maintenant - FENETRE_NOS_MACHINES_SECONDES * 1000)
      .at(-1);
    return ecritParUneMachine(dernier ? { origin: dernier.origin, senderUserId: null, type: 'text' } : null);
  };

  const deps = (tenant: string): RunTurnDeps => ({
    estDesabonne: jamaisDesabonne,
    estRepondeur: async () => true,
    numeroBloque: async () => false,
    ecritParNosMachines: ecritParNosMachines === 'journal' ? parLeJournal : ecritParNosMachines,
    sessions: {
      prendreLeTour: async (): Promise<AgentSession> => {
        const n = (tours.get(tenant) ?? 0) + 1;
        tours.set(tenant, n);
        return {
          id: `s-${tenant}`, tenantId: tenant, runId: `r-${tenant}`, agentId: 'ag', nodeId: 'a', waId: '',
          tours: n, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-10-30T19:28:00.000Z',
        };
      },
      clore: async () => {},
      ajouterAuTranscript: async () => {},
      ajouterCout: async () => {},
      finirLeTour: async () => {},
      sortieAppliquee: async () => {},
    },
    brain: new FakeAgentBrain({ texte: 'Ha ha, je comprends la confusion ! 😄', sortie: null }),
    lireRun: async () => ({ status: 'waiting', currentNode: 'a' }),
    agents: { byId: async () => FICHE },
    envoyer: async (t, waId) => {
      reponses[t] = (reponses[t] ?? 0) + 1;
      sortants.push({ tenant: t, waId, origin: 'ia', at: maintenant });
      livrer(t, waId);
    },
    now: () => maintenant,
  });

  /** Joue les tours jusqu'au calme, cinq secondes par tour, comme le soir du 30. */
  const jouer = async () => {
    for (let i = 0; i < 100 && aJouer.length > 0; i++) {
      const { tenant, waId } = aJouer.shift()!;
      maintenant += 5_000;
      await runTurn({
        tenantId: tenant, runId: `r-${tenant}`, sessionId: `s-${tenant}`, workflowId: 'wf', nodeId: 'a', waId,
        raison: 'message', tours: tours.get(tenant) ?? 0,
      }, deps(tenant));
    }
  };

  /** Julien tape un message sur le téléphone de newCompany : l'écho l'enregistre `humain` dans newCompany. */
  const tapeALaMain = (de: typeof DEMO, vers: typeof DEMO) => {
    sortants.push({ tenant: de.tenant, waId: vers.numero, origin: 'humain', at: maintenant });
    livrer(de.tenant, vers.numero);
  };

  return {
    jouer, tapeALaMain, reponses,
    avancer: (ms: number) => { maintenant += ms; },
    /** Un tour qui arrive en retard dans `tenant`, pour un message de `waId` (pg-boss qui rejoue, une file engorgée). */
    tourEnRetard: (tenant: string, waId: string) => { aJouer.push({ tenant, waId }); },
  };
}

describe('deux agents de Messaging Me qui se répondent', () => {
  it('🔴 sans la garde, la boucle court jusqu’au plafond de tours (le soir du 30)', async () => {
    const m = monde(jamaisNosMachines);
    m.tapeALaMain(NEWCO, DEMO);
    await m.jouer();
    expect(m.reponses.demo).toBeGreaterThan(5);
    expect(m.reponses.newco).toBeGreaterThan(5);
  });

  it('🔴 avec la garde, la démo répond une fois et l’agent de newCompany se tait', async () => {
    const m = monde('journal');
    m.tapeALaMain(NEWCO, DEMO);
    await m.jouer();
    expect(m.reponses).toEqual({ demo: 1, newco: 0 });
  });

  it('un second message tapé à la main depuis le téléphone a encore sa réponse', async () => {
    const m = monde('journal');
    m.tapeALaMain(NEWCO, DEMO);
    await m.jouer();
    m.avancer(10_000);
    m.tapeALaMain(NEWCO, DEMO);
    await m.jouer();
    expect(m.reponses).toEqual({ demo: 2, newco: 0 });
  });

  it('une réponse d’agent sortie de la fenêtre ne fait plus taire, et la boucle s’arrête quand même au tour suivant', async () => {
    const m = monde('journal');
    m.tapeALaMain(NEWCO, DEMO);
    await m.jouer();
    m.avancer((FENETRE_NOS_MACHINES_SECONDES + 1) * 1000);
    m.tourEnRetard(NEWCO.tenant, DEMO.numero);
    await m.jouer();
    expect(m.reponses).toEqual({ demo: 1, newco: 1 });
  });
});

describe('ecritParUneMachine', () => {
  it.each([
    ['ia', null, true], ['scenario', null, true], ['campagne', null, true], ['mba', null, true], ['api', null, true],
    ['mcp', null, true], ['mcp', 'u1', false], ['humain', null, false],
  ] as const)('%s (signé %s) : %s', (origin, senderUserId, attendu) => {
    expect(ecritParUneMachine({ origin, senderUserId, type: 'text' })).toBe(attendu);
  });

  it('sans sortant récent, ou sans origine, ce n’est pas une machine', () => {
    expect(ecritParUneMachine(null)).toBe(false);
    expect(ecritParUneMachine({ origin: null, senderUserId: null, type: 'text' })).toBe(false);
  });
});
