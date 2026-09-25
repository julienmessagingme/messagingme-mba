import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentTestRouteDeps } from '../src/http/agent-test';
import type { ContexteAgentComplet, GatewayBrainDeps } from '../src/agent/brain.gateway';
import type { ChatMessage, ReponseChat } from '../src/agent/llm/chat-client';
import type { JournalAppels, OutilDefini, ToolCatalog } from '../src/agent/catalog';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import { ficheVide } from '../src/agent/fiche';
import { ESSAIS_AFFICHES, RETENTION_ESSAIS_JOURS, type EssaiAEcrire, type EssaiAgent, type TestRunStore } from '../src/agent/test-runs';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE, GESTE_MUET } from './gestes';
import { LlmApiError } from '../src/llm/errors';
import { capturerJournal } from './journal';

/**
 * Le bac à sable : parler à son agent depuis la console.
 *
 * 🔴 CE QU'IL PROUVE. Il fait tourner le VRAI cerveau, avec le vrai prompt et les vrais outils exposés. Ce
 * qu'il ne peut pas faire, il le DIT : les outils à effet sont simulés, parce qu'il n'y a ni contact, ni
 * conversation, ni parcours. Aucune session n'est ouverte, aucun run n'est touché. Seul l'ESSAI est
 * persisté, depuis le 2026-09-08, pour qu'on puisse le relire et le rejouer : c'est le dernier `describe`.
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

const OUTIL: OutilDefini = { ...SANS_MCP, ...AUCUN_GESTE(),
  id: 'o1', tenantId: 't1', origin: 'mba', name: 'mba_poser_tag',
  description: 'Tague.', params: [{ name: 'tag', type: 'string', source: 'modele', required: true }],
  binding: { handler: 'poser_tag' }, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'write',
  timeoutMs: 8000, maxBytes: 16384, autonome: false,
};

const AGENT: ContexteAgentComplet = {
  modele: 'modele-test',
  mentionIa: 'Vous échangez avec un assistant automatique.', mentionIaFrequence: 'session' as const,
  sorties: [{ code: 'fini', label: 'Fini' }],
  contenu: { ...ficheVide(), objectif: 'Aider.' },
  outilsActifs: [OUTIL],
  plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 },
  contactInconnu: 'tous',
};

const texte = (t: string): ReponseChat => ({
  texte: t, appelsOutils: [], finish: 'stop',
  usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 }, generationId: null,
});
const appelOutil = (nom: string, args: string): ReponseChat => ({
  texte: null, appelsOutils: [{ id: 'c1', nom, argumentsJson: args }], finish: 'tool_calls',
  usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 }, generationId: null,
});

/**
 * Un faux historique. Il RETIENT ce qu'on lui demande d'ecrire (c'est ce que les tests lisent) et note les
 * arguments de lecture, parce que le tenant et le plafond passes a `lister` sont eux-memes le contrat.
 */
function fauxHistorique(opts: { casse?: boolean; contenu?: EssaiAgent[] } = {}) {
  const ecrits: Array<{ tenant: string; agent: string; essai: EssaiAEcrire }> = [];
  const lectures: Array<{ tenant: string; agent: string; limite: number }> = [];
  const store: TestRunStore = {
    ecrire: async (tenant, agent, essai) => {
      if (opts.casse) throw new Error('base indisponible');
      ecrits.push({ tenant, agent, essai });
    },
    lister: async (tenant, agent, limite) => { lectures.push({ tenant, agent, limite }); return opts.contenu ?? []; },
    purger: async () => 0,
  };
  return { ecrits, lectures, store };
}

function app(opts: {
  reponses?: ReponseChat[]; agentConnu?: boolean; sansCerveau?: boolean; indisponible?: boolean;
  solde?: number; sansHistorique?: boolean; historiqueCasse?: boolean; essais?: EssaiAgent[];
} = {}) {
  const hist = fauxHistorique({ ...(opts.historiqueCasse ? { casse: true } : {}), ...(opts.essais ? { contenu: opts.essais } : {}) });
  const cap = {
    messages: [] as ChatMessage[][], journalises: 0, debits: [] as Array<{ montant: number; note: string }>,
    essaisEcrits: hist.ecrits, lectures: hist.lectures,
  };
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
      executerGeste: GESTE_MUET,
    },
  };
  const deps: AgentTestRouteDeps = {
    disponible: opts.indisponible !== true,
    ...(opts.sansHistorique ? {} : { essais: hist.store }),
    ...(opts.sansCerveau ? {} : { cerveau }),
    ...(opts.solde === undefined ? {} : {
      solde: async () => opts.solde!,
      debiter: async (_t: string, montant: number, note: string) => { cap.debits.push({ montant, note }); },
    }),
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

  /** Un serveur dont le cerveau casse là où on le lui demande : au modèle, ou à la lecture de l'agent. */
  const serveurQuiCasse = (cerveau: { completer?: () => Promise<never>; contexte?: () => Promise<never> }) => buildServer({
    queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
    agentTest: {
      disponible: true,
      cerveau: {
        completer: cerveau.completer ?? (async () => { throw new Error('jamais appelé'); }),
        contexte: cerveau.contexte ?? (async () => AGENT),
        outils: { catalogue: { byName: async () => null, listActifs: async () => [] }, journal: { ouvrir: async () => '', clore: async () => {} }, resolveurs: {}, compterAppel: async () => {}, executerGeste: GESTE_MUET },
      },
    },
  });

  it('🔴 une panne du fournisseur rend 422 avec une raison RÉDIGÉE, jamais un 5xx', async () => {
    // Cloudflare remplace le corps d'une 5xx par sa page d'erreur : en 502, l'écran du bac à sable
    // n'affichait que « Erreur 502 », pour une cause que le serveur connaissait. Le texte brut du fournisseur
    // (anglais, écrit pour un développeur) reste dans le journal, pas à l'écran.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { srv } = app();
    const casse = serveurQuiCasse({ completer: async () => { throw new LlmApiError(503, 'gateway indisponible', true); } });
    const res = await casse.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
    const lignes = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('indisponible pour le moment');
    expect(res.json().error).not.toContain('gateway indisponible');
    // Journalisée en plus : le corps peut se perdre en route, le log reste.
    expect(lignes.find((l) => l.includes('agent_test_echec'))).toContain('gateway indisponible');
    expect((await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour })).statusCode).toBe(200);
  });

  /**
   * 🔴 RELEVÉ PAR LA RELECTURE DU 2026-09-22. Le `catch` de cette route couvre TOUT le tour, lecture de l'agent
   * en base comprise, et rendait `err.message` en 422 pour tout ce qu'il attrapait. Tant que c'était un 502,
   * Cloudflare détruisait le corps ; en 422, le texte d'une panne de NOTRE base partait au navigateur.
   */
  it('🔴 une panne de NOTRE base sort en 500 opaque, sans son texte', async () => {
    const panne = new Error('password authentication failed for user "postgres.abcdef"', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
    });
    const casse = serveurQuiCasse({ contexte: async () => { throw panne; } });
    const { resultat: res, lignes } = await capturerJournal(() => casse.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour }));
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Internal Server Error');
    expect(res.body).not.toContain('password');
    expect(res.body).not.toContain('postgres');
    // Le texte reste CÔTÉ SERVEUR, avec sa CAUSE : c'est la ligne du gestionnaire global qui voit ces 500.
    expect(lignes.find((l) => l.msg === 'unhandled_route_error')).toMatchObject({
      lvl: 'error', tenantId: 't1', err: expect.stringContaining('password'), errCause: 'ECONNREFUSED connect ECONNREFUSED 10.0.0.5:5432',
    });
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

  /**
   * 🔴 UN ESSAI CONSOMME POUR DE VRAI, et doit donc descendre le solde prépayé comme une conversation.
   *
   * Ce que le bac à sable simule, ce sont les outils à EFFET, jamais l'appel de modèle : le fournisseur
   * facture un essai exactement comme un message de contact. Le laisser hors du solde ouvrirait une porte
   * gratuite et illimitée sur un compte prépayé, et ferait mentir le solde affiché juste à côté.
   */
  describe('le solde prépayé', () => {
    it('🔴 un essai DÉBITE le solde du workspace, et la note explique le mouvement', async () => {
      // 0,00001 $ au taux par défaut de 1 = 10 micro-euros. La note est la seule explication possible : un
      // essai n'ouvre aucune session, donc le journal n'a rien d'autre pour dire d'où vient la dépense.
      const { cap, srv } = app({ solde: 5_000_000 });
      expect((await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour })).statusCode).toBe(200);
      expect(cap.debits).toEqual([{ montant: 10, note: 'essai depuis la console' }]);
    });

    it('🔴 un solde ÉPUISÉ refuse l’essai AVANT d’appeler le modèle, en 409', async () => {
      // Avant, pour ne pas payer un appel qu'on ne pourra pas facturer. 409 et non 5xx : c'est un état du
      // compte, et Cloudflare remplacerait le corps d'une 5xx par sa page d'erreur.
      for (const solde of [0, -1200]) {
        const { cap, srv } = app({ solde });
        const res = await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
        expect(res.statusCode, String(solde)).toBe(409);
        expect(res.json().error).toContain('solde');
        expect(cap.messages).toHaveLength(0);
        expect(cap.debits).toEqual([]);
      }
    });

    it('un essai qui ÉCHOUE après avoir déjà payé débite quand même, que la panne soit celle du fournisseur ou la nôtre', async () => {
      // Même règle qu'en production : le fournisseur facture chaque aller-retour, et un essai qui casse au
      // second n'a aucune raison d'être offert.
      // 🔴 LES DEUX CAS, parce que la route les sépare : la panne du fournisseur sort en 422, la nôtre est
      // relancée en 500 opaque. Le débit doit passer AVANT l'une comme l'autre ; la cause se lit SOUS
      // `TourInterrompu`, qui enveloppe toute erreur survenue après un premier appel payé.
      for (const { erreur, attendu } of [
        { erreur: new LlmApiError(503, 'gateway indisponible', true), attendu: 422 },
        { erreur: new Error('connexion au pool perdue'), attendu: 500 },
      ]) {
        const cap = { debits: [] as number[] };
        let appels = 0;
        const casse = buildServer({
          queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
          agentTest: {
            disponible: true,
            solde: async () => 5_000_000,
            debiter: async (_t: string, montant: number) => { cap.debits.push(montant); },
            cerveau: {
              completer: async () => {
                appels += 1;
                if (appels > 1) throw erreur;
                return appelOutil('mba_poser_tag', '{"tag":"vip"}');
              },
              contexte: async () => AGENT,
              outils: {
                catalogue: { byName: async () => OUTIL, listActifs: async () => AGENT.outilsActifs },
                journal: { ouvrir: async () => '', clore: async () => {} },
                resolveurs: { mba: creerResolveurSimulation({ connaissance: { chercher: async () => [] } }) },
                compterAppel: async () => {},
                executerGeste: GESTE_MUET,
              },
            },
          },
        });
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await casse.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
        const lignes = spy.mock.calls.map((c) => String(c[0]));
        spy.mockRestore();
        expect(res.statusCode, erreur.message).toBe(attendu);
        expect(res.body, erreur.message).not.toContain(erreur.message);
        expect(cap.debits, erreur.message).toEqual([10]);
        if (attendu === 422) {
          // Le chemin 422 journalise lui aussi la CAUSE, pas l'enveloppe : sa pile montre qui a levé.
          const trace = lignes.map((l) => { try { return JSON.parse(l) as { msg?: string; stack?: string }; } catch { return {}; } })
            .find((l) => l.msg === 'agent_test_echec');
          expect(trace?.stack).toBeDefined();
          expect(trace?.stack).not.toMatch(/^TourInterrompu/);
        }
        if (attendu === 500) {
          // ⚠️ C'est la CAUSE qui est relancée, pas `TourInterrompu` : la pile journalisée doit montrer la
          // fonction qui a levé, sans quoi le journal ne dirait que « penserTrace ».
          const trace = lignes.map((l) => { try { return JSON.parse(l) as { msg?: string; stack?: string }; } catch { return {}; } })
            .find((l) => l.msg === 'unhandled_route_error');
          expect(trace?.stack).toMatch(/^Error: connexion au pool perdue/);
        }
      }
    });

    it('sans solde câblé, l’essai marche comme avant', async () => {
      // Suites à deps minimales : une instance qui n'a pas câblé le prépayé ne doit pas voir ses essais
      // refusés.
      const { cap, srv } = app();
      expect((await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour })).statusCode).toBe(200);
      expect(cap.debits).toEqual([]);
    });
  });

  /**
   * 🔴 L'HISTORIQUE DES ESSAIS. Julien, le 2026-09-08 : « j'ai voulu réappuyer et j'ai plus la trace de ce
   * que j'ai lu ». Régler un agent, c'est COMPARER : on change une consigne, on repose la même question, et
   * on regarde si la réponse a bougé. Sans trace, la comparaison se fait de mémoire, donc mal.
   */
  describe('l’historique des essais', () => {
    const liste = (tenant: string, agentId = AG) => `/tenants/${tenant}/agents/${agentId}/tests`;

    it('un essai est ARCHIVÉ avec ce qui permet de le comparer', async () => {
      const { cap, srv } = app({ reponses: [appelOutil('mba_poser_tag', '{"tag":"vip"}'), texte('C’est noté.')] });
      expect((await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour })).statusCode).toBe(200);
      expect(cap.essaisEcrits).toHaveLength(1);
      expect(cap.essaisEcrits[0]).toMatchObject({ tenant: 't1', agent: AG });
      expect(cap.essaisEcrits[0]!.essai).toMatchObject({
        messages: bonjour.messages,
        reponse: 'C’est noté.',
        // Le NOM et le STATUT de chaque outil : c'est ce qui distingue « il n'a pas trouvé » de « il n'a
        // même pas cherché », la première question qu'on se pose devant une mauvaise réponse.
        appels: [{ nom: 'mba_poser_tag', status: 'ok' }],
        // Deux allers-retours à 10/5 jetons : le coût est la MOITIÉ de ce qu'on juge (une réponse deux fois
        // meilleure qui coûte dix fois plus cher n'est pas un progrès, et ça ne se retrouve pas après coup).
        tokensEntree: 20, tokensSortie: 10, coutMicroEur: 20,
      });
      // Ce que l'outil a RENDU n'est pas gardé : volumineux, et rempli par un site tiers.
      expect(JSON.stringify(cap.essaisEcrits[0]!.essai.appels)).not.toContain('simule');
    });

    it('🔴 un historique EN PANNE ne fait pas perdre au client la réponse qu’il vient de payer', async () => {
      // Le modèle a déjà répondu et le solde est déjà débité : échouer parce que la TRACE n'a pas pu
      // s'écrire échangerait la fonctionnalité contre la commodité qui la sert.
      const { cap, srv } = app({ historiqueCasse: true, solde: 5_000_000 });
      const res = await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour });
      expect(res.statusCode).toBe(200);
      expect(res.json().texte).toBe('Bonjour, comment puis-je aider ?');
      expect(cap.debits).toEqual([{ montant: 10, note: 'essai depuis la console' }]);
    });

    it('la liste rend les essais de CET agent, plafonnés à ce que l’écran montre', async () => {
      const archive: EssaiAgent = {
        id: 'e1', messages: bonjour.messages as EssaiAgent['messages'], reponse: 'Oui, avec sauna.',
        sortie: null, appels: [{ nom: 'chercher_connaissance', status: 'ok' }],
        tokensEntree: 10, tokensSortie: 5, coutMicroEur: 10, createdAt: '2026-09-08T10:00:00.000Z',
      };
      const { cap, srv } = app({ essais: [archive] });
      const res = await srv.inject({ method: 'GET', url: liste('t1'), ...h(adminTok) });
      expect(res.statusCode).toBe(200);
      expect(res.json().essais).toEqual([archive]);
      expect(cap.lectures).toEqual([{ tenant: 't1', agent: AG, limite: ESSAIS_AFFICHES }]);
    });

    it('🔴 le tenant de l’URL ne peut pas dépasser celui du jeton, et RIEN n’est lu', async () => {
      // Le pooler est superuser, la RLS est contournée : ce filtrage est le seul contrôle d'isolation.
      const { cap, srv } = app();
      expect((await srv.inject({ method: 'GET', url: liste('t2'), ...h(adminTok) })).statusCode).toBe(403);
      expect(cap.lectures).toEqual([]);
    });

    it('sans historique câblé, la liste est VIDE et l’essai marche comme avant', async () => {
      // 200 avec une liste vide, jamais 404 ni 503 : l'écran doit pouvoir poser la question sans savoir si
      // le serveur tient une trace, et c'est ce qui permet de le déployer avant la table.
      const { srv } = app({ sansHistorique: true });
      const res = await srv.inject({ method: 'GET', url: liste('t1'), ...h(adminTok) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ essais: [] });
      expect((await srv.inject({ method: 'POST', url: url('t1'), ...h(adminTok), payload: bonjour })).statusCode).toBe(200);
    });

    it('un identifiant d’agent mal formé rend 404, et la liste est réservée aux administrateurs', async () => {
      expect((await app().srv.inject({ method: 'GET', url: liste('t1', 'pas-un-uuid'), ...h(adminTok) })).statusCode).toBe(404);
      expect((await app().srv.inject({ method: 'GET', url: liste('t1'), ...h(agentTok) })).statusCode).toBe(403);
    });

    it('la rétention est de 14 jours, et l’écran l’annonce', async () => {
      // Choisie par Julien : assez pour comparer deux essais dans la journée et revenir le lendemain, assez
      // court pour ne pas accumuler des mois de brouillons. Le texte de `AgentTest.tsx` dit « 14 jours » ;
      // les deux builds ne partagent pas cette constante, c'est ici qu'elle est ancrée.
      expect(RETENTION_ESSAIS_JOURS).toBe(14);
      expect(ESSAIS_AFFICHES).toBe(20);
    });
  });
});
