import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentTestRouteDeps } from '../src/http/agent-test';
import type { ContexteAgentComplet, GatewayBrainDeps } from '../src/agent/brain.gateway';
import type { ChatMessage, ReponseChat } from '../src/agent/llm/chat-client';
import type { JournalAppels, OutilDefini, ToolCatalog } from '../src/agent/catalog';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import { ficheVide } from '../src/agent/fiche';

/**
 * Le bac à sable : parler à son agent depuis la console.
 *
 * 🔴 CE QU'IL PROUVE. Il fait tourner le VRAI cerveau, avec le vrai prompt et les vrais outils exposés. Ce
 * qu'il ne peut pas faire, il le DIT : les outils à effet sont simulés, parce qu'il n'y a ni contact, ni
 * conversation, ni parcours. Aucune session n'est ouverte, aucun run n'est touché, rien n'est persisté.
 */
const SECRET = 'test-secret';
const AG = '11111111-1111-4111-8111-111111111111';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const OUTIL: OutilDefini = {
  id: 'o1', tenantId: 't1', agentId: AG, origin: 'mba', name: 'mba_poser_tag',
  description: 'Tague.', params: [{ name: 'tag', type: 'string', source: 'modele', required: true }],
  binding: { handler: 'poser_tag' }, outputPaths: [], risk: 'write',
  timeoutMs: 8000, maxBytes: 16384, autonome: false,
};

const AGENT: ContexteAgentComplet = {
  modele: 'modele-test',
  mentionIa: 'Vous échangez avec un assistant automatique.',
  sorties: [{ code: 'fini', label: 'Fini' }],
  contenu: { ...ficheVide(), objectif: 'Aider.' },
  outilsActifs: [OUTIL],
  plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 },
};

const texte = (t: string): ReponseChat => ({
  texte: t, appelsOutils: [], finish: 'stop',
  usage: { tokensIn: 10, tokensOut: 5, coutDollars: 0.00001 }, generationId: null,
});
const appelOutil = (nom: string, args: string): ReponseChat => ({
  texte: null, appelsOutils: [{ id: 'c1', nom, argumentsJson: args }], finish: 'tool_calls',
  usage: { tokensIn: 10, tokensOut: 5, coutDollars: 0.00001 }, generationId: null,
});

function app(opts: { reponses?: ReponseChat[]; agentConnu?: boolean; sansCerveau?: boolean; indisponible?: boolean } = {}) {
  const cap = { messages: [] as ChatMessage[][], journalises: 0 };
  let i = 0;
  const catalogue: ToolCatalog = {
    byName: async (_t, _a, name) => (name === OUTIL.name ? OUTIL : null),
    listActifs: async () => AGENT.outilsActifs,
  };
  // Le journal du bac à sable est MUET : `agent_tool_calls.session_id` référence une session, et il n'y en a
  // aucune ici. On compte quand même les appels pour vérifier qu'il n'écrit rien.
  const journal: JournalAppels = {
    ouvrir: async () => { cap.journalises += 1; return ''; },
    clore: async () => {},
  };
  const cerveau: GatewayBrainDeps = {
    completer: async ({ messages }) => {
      cap.messages.push(messages);
      const liste = opts.reponses ?? [texte('Bonjour, comment puis-je aider ?')];
      const r = liste[Math.min(i, liste.length - 1)]!;
      i += 1;
      return r;
    },
    contexte: async () => (opts.agentConnu === false ? null : AGENT),
    outils: {
      catalogue,
      journal,
      resolveurs: { mba: creerResolveurSimulation({ connaissance: { chercher: async () => [] } }) },
      compterAppel: async () => {},
    },
  };
  const deps: AgentTestRouteDeps = {
    disponible: opts.indisponible !== true,
    ...(opts.sansCerveau ? {} : { cerveau }),
  };
  return { cap, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agentTest: deps }) };
}

const url = (tenant: string, agentId = AG) => `/tenants/${tenant}/agents/${agentId}/test`;
const bonjour = { messages: [{ role: 'user', content: 'Bonjour, vous avez une piscine ?' }] };

describe('bac à sable de l’agent', () => {
  it('rend ce que l’agent répond, et ce que ça a coûté', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ texte: 'Bonjour, comment puis-je aider ?', sortie: null, appels: [] });
    expect(res.json().usage.tokensIn).toBe(10);
    // Le VRAI prompt, avec la mention légale d'IA : c'est ce que le client vient éprouver.
    expect(cap.messages[0]![0]!.content).toContain('Vous échangez avec un assistant automatique.');
  });

  it('🔴 un outil à EFFET est simulé, et la trace le dit', async () => {
    const { srv } = app({ reponses: [appelOutil('mba_poser_tag', '{"tag":"vip"}'), texte('C’est noté.')] });
    const res = await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
    const body = res.json();
    expect(body.appels).toHaveLength(1);
    expect(body.appels[0]).toMatchObject({ nom: 'mba_poser_tag', arguments: '{"tag":"vip"}', status: 'ok' });
    expect(body.appels[0].contenu.simule).toBe(true);
    expect(body.texte).toBe('C’est noté.');
  });

  it('🔴 rien n’est journalisé : il n’y a AUCUNE session à référencer', async () => {
    // `agent_tool_calls.session_id` référence `agent_sessions` et n'est pas nullable. Un journal réel ferait
    // violer la clé étrangère à chaque essai.
    const { cap, srv } = app({ reponses: [appelOutil('mba_poser_tag', '{"tag":"vip"}'), texte('ok')] });
    await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
    // Le tronc commun APPELLE bien le journal (il est best-effort), mais celui du bac à sable n'écrit rien.
    expect(cap.journalises).toBe(1);
  });

  it('la sortie empruntée est rendue, pour que le client voie par où l’agent est parti', async () => {
    const { srv } = app({ reponses: [appelOutil('mba_poser_tag', '{"tag":"vip"}')] });
    // Aucun outil `terminer` actif ici : c'est le plafond d'allers-retours qui sort, et il se voit.
    const res = await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
    expect(res.json().sortie).toBe('plafond');
  });

  it('🔴 sans modèle configuré, 503 et AUCUN appel', async () => {
    for (const opts of [{ sansCerveau: true }, { indisponible: true }]) {
      const { cap, srv } = app(opts);
      const res = await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
      expect(res.statusCode).toBe(503);
      expect(cap.messages).toHaveLength(0);
    }
  });

  it('🔴 une panne du fournisseur rend 502, jamais 500', async () => {
    // Cloudflare remplace le corps d'une 5xx par sa page d'erreur : un 500 ne dirait rien au client.
    const { srv } = app();
    const casse = buildServer({
      queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
      agentTest: {
        disponible: true,
        cerveau: {
          completer: async () => { throw new Error('gateway indisponible'); },
          contexte: async () => AGENT,
          outils: { catalogue: { byName: async () => null, listActifs: async () => [] }, journal: { ouvrir: async () => '', clore: async () => {} }, resolveurs: {}, compterAppel: async () => {} },
        },
      },
    });
    const res = await casse.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('gateway indisponible');
    expect((await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour })).statusCode).toBe(200);
  });

  it('un agent introuvable, ou un identifiant mal formé, rend 404', async () => {
    expect((await app({ agentConnu: false }).srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour })).statusCode).toBe(404);
    expect((await app().srv.inject({ method: 'POST', url: url('t1', 'pas-un-uuid'), ...h(adminTok), payload: bonjour })).statusCode).toBe(404);
  });

  it('🔴 le tenant de l’URL ne peut pas dépasser celui du jeton, et rien n’est appelé', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'POST', url: url('t2'), ...h(adminTok), payload: bonjour })).statusCode).toBe(403);
    expect(cap.messages).toHaveLength(0);
  });

  it('un corps invalide est refusé en 400', async () => {
    const { srv } = app();
    for (const payload of [{}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'user', content: '' }] }]) {
      expect((await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('réservé aux administrateurs', async () => {
    expect((await app().srv.inject({ method: 'POST', url: url('t1'), ...h(agentTok), payload: bonjour })).statusCode).toBe(403);
  });
});
