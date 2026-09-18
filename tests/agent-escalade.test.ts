import { describe, it, expect } from 'vitest';
import { creerEscaladeVersHumain } from '../src/agent/escalade';
import type { AgentSessionStore } from '../src/agent/session-store';

/**
 * Tâche 16, troisième piège du plan : l'escalade vers un humain doit CLORE la session, SORTIR le run du bloc
 * agent, PUIS basculer le fil. C'est l'ordre, et rien d'autre, que ce module apporte.
 */

function harnais(over: { sortirRend?: boolean } = {}) {
  const journal: string[] = [];
  const escalader = creerEscaladeVersHumain({
    sessions: {
      clore: async (_t, sessionId, status, sortie) => { journal.push(`clore:${sessionId}:${status}:${sortie}`); },
    } as Pick<AgentSessionStore, 'clore'>,
    sortirDuBlocAgent: async (_t, _w, sessionId, sortie) => {
      journal.push(`sortir:${sessionId}:${sortie}`);
      return over.sortirRend ?? true;
    },
    escalateToHuman: async (_t, waId) => { journal.push(`bascule:${waId}`); return true; },
  });
  return { escalader, journal };
}

describe('escalade vers un humain (tâche 16)', () => {
  it('🔴 clôt, sort du bloc, PUIS bascule le fil, dans cet ordre exact', async () => {
    // L'ordre est contre-intuitif et deux pièges le commandent. Basculer d'abord rendrait la sortie
    // inopérante (`advance` sort en premier sur `mayAct`), et ne pas sortir du tout ferait reprendre l'agent
    // après le passage de l'humain (`runControlSweep` rend automatiquement la main au scénario).
    const { escalader, journal } = harnais();
    await escalader({ tenantId: 't1', waId: '33600', runId: 'r1', sessionId: 's1' });
    expect(journal).toEqual(['clore:s1:sortie:humain', 'sortir:s1:humain', 'bascule:33600']);
  });

  it('bascule quand même si aucun parcours n attendait sur un bloc agent', async () => {
    // Le but premier est qu'un humain reprenne la conversation : un run introuvable ne doit pas laisser le
    // contact sans personne.
    const { escalader, journal } = harnais({ sortirRend: false });
    await escalader({ tenantId: 't1', waId: '33600', runId: 'r1', sessionId: 's1' });
    expect(journal).toContain('bascule:33600');
  });
});
