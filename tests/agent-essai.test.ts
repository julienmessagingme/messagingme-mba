import { describe, it, expect } from 'vitest';
import type { ContexteAgentComplet, GatewayBrainDeps } from '../src/agent/brain.gateway';
import type { ReponseChat } from '../src/agent/llm/chat-client';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import { ficheVide } from '../src/agent/fiche';
import { essayerAgent, type DepsEssai } from '../src/agent/essai';
import type { EssaiAEcrire } from '../src/agent/test-runs';
import { GESTE_MUET } from './gestes';

/**
 * L'ESSAI, HORS DE LA ROUTE (lot 8a) : ce que l'outil MCP `test_agent` recevra. La route est tenue par
 * `tests/http-agent-test.test.ts`. Ici, ce que seule la porte change : la NOTE du débit, seule explication du
 * mouvement dans le journal du solde. Le reste (solde exigé, débit au prix client, archivage) est le même chemin.
 */
const AG = '11111111-1111-4111-8111-111111111111';

const AGENT: ContexteAgentComplet = {
  modele: 'modele-test',
  mentionIa: 'Vous échangez avec un assistant automatique.', mentionIaFrequence: 'session' as const,
  sorties: [{ code: 'fini', label: 'Fini' }],
  contenu: { ...ficheVide(), objectif: 'Aider.' },
  outilsActifs: [],
  plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 },
  contactInconnu: 'tous',
};

const REPONSE: ReponseChat = {
  texte: 'Bonjour !', appelsOutils: [], finish: 'stop',
  usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 }, generationId: null,
};

function monter(solde: number) {
  const cap = { debits: [] as Array<{ montant: number; note: string }>, essais: [] as EssaiAEcrire[] };
  const cerveau: GatewayBrainDeps = {
    client: { completer: async () => REPONSE },
    contexte: async () => AGENT,
    commissionPct: 0,
    outils: {
      catalogue: { byName: async () => null, listActifs: async () => [] },
      journal: { ouvrir: async () => '', clore: async () => {} },
      resolveurs: { mba: creerResolveurSimulation({ connaissance: { chercher: async () => [] } }) },
      sessions: { compterAppel: async () => {} },
      executerGeste: GESTE_MUET,
    },
  };
  const deps: DepsEssai = {
    essais: { lister: async () => [], ecrire: async (_t, _a, e) => { cap.essais.push(e); }, purger: async () => 0 },
    cerveau,
    disponible: true,
    credits: { solde: async () => solde },
    debiter: async (_t, montant, note) => { cap.debits.push({ montant, note }); },
  };
  return { cap, deps };
}

describe('essayerAgent', () => {
  it('🔴 un essai par le MCP débite le MÊME montant que par la console, sous une note qui DIT la porte', async () => {
    const parConsole = monter(1_000_000);
    const parMcp = monter(1_000_000);
    const a = await essayerAgent(parConsole.deps, 't1', AG, { messages: [{ role: 'user', content: 'Bonjour' }] }, 'formulaire');
    const b = await essayerAgent(parMcp.deps, 't1', AG, { messages: [{ role: 'user', content: 'Bonjour' }] }, 'mcp');
    expect(b).toEqual(a);
    expect(parConsole.cap.debits).toEqual([{ montant: 10, note: 'essai depuis la console' }]);
    expect(parMcp.cap.debits).toEqual([{ montant: 10, note: 'essai depuis le serveur MCP' }]);
    // Et l'essai est archivé dans les deux cas : l'écran le relit, d'où qu'il vienne.
    expect(parMcp.cap.essais).toHaveLength(1);
  });

  it('solde épuisé : 409, ni appel de modèle ni débit', async () => {
    const m = monter(0);
    expect(await essayerAgent(m.deps, 't1', AG, { messages: [{ role: 'user', content: 'Bonjour' }] }, 'mcp'))
      .toMatchObject({ ok: false, statut: 409 });
    expect(m.cap.debits).toEqual([]);
  });

  it('les bornes du corps sont celles de la console : 31 messages, c’est un 400', async () => {
    const m = monter(1_000_000);
    const messages = Array.from({ length: 31 }, () => ({ role: 'user', content: 'x' }));
    expect(await essayerAgent(m.deps, 't1', AG, { messages }, 'mcp')).toMatchObject({ ok: false, statut: 400 });
  });
});
