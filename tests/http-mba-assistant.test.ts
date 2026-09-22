import { gardeOuverte } from './gardes';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { registerMbaAssistant, type MbaAssistantDeps } from '../src/http/mba-assistant';
import { calculerCompletion, type EntreeCompletion } from '../src/mba/completion';
import { ENTRETIEN_MBA_VIERGE, type EntretienMba } from '../src/mba/assistant/entretien-store';

/**
 * LA ROUTE DE L'ASSISTANT DU MBA.
 *
 * 🔴 CE QU'ELLE NE FAIT PAS EST AUSSI IMPORTANT QUE CE QU'ELLE FAIT : elle PROPOSE, elle n'écrit rien chez
 * Meta. L'écriture passe par `/appliquer`, sur un geste explicite. C'est la règle qui protège contre le jour
 * où l'onglet disparaîtrait : la conversation n'a aucun pouvoir que les onglets n'aient déjà.
 */
const VIDE: EntreeCompletion = { settings: null, businessInfo: null, faqs: null, skills: null, websites: null, files: null };

function monter(sur: Partial<MbaAssistantDeps> = {}, opts: { role?: string; depense?: number; fil?: EntretienMba } = {}) {
  const journal = { appelsModele: 0, ecrits: [] as EntretienMba[], depenses: [] as number[], appliques: [] as unknown[][] };
  let fil: EntretienMba | null = opts.fil ?? null;

  const deps: MbaAssistantDeps = {
    inventaire: async () => ({
      completion: calculerCompletion({
        ...VIDE, settings: {} as never, businessInfo: { business_description: '' } as never,
        faqs: [], skills: [], websites: [], files: [],
      }),
      resume: { description: '', faqs: [], competences: [], sites: [], fichiers: [], enService: false },
    }),
    entretiens: {
      lire: async () => fil,
      ecrire: async (_t, e) => { fil = e; journal.ecrits.push(e); },
      effacer: async () => { fil = null; },
    },
    depenses: {
      lire: async () => opts.depense ?? 0,
      ajouter: async (_t, _m, micro) => { journal.depenses.push(micro); },
    },
    plafondEuros: 2,
    modele: 'test/modele',
    tauxEurParDollar: 0.92,
    agentIdDuTenant: async () => 'ag-meta-1',
    application: () => ({
      numeroDuTenant: async () => '123',
      client: async () => ({} as never),
      journaliser: async () => {},
      acteur: { id: 'u1', email: null },
    }),
    completer: async () => {
      journal.appelsModele += 1;
      // ⚠️ LA FORME RÉELLE : les arguments arrivent en JSON BRUT (`argumentsJson`), pas en objet. Un faux
      // qui rendrait un objet ferait passer un test que le vrai câblage échouerait.
      return {
        texte: null,
        finish: 'tool_calls',
        appelsOutils: [{
          id: 'c1', nom: 'proposer',
          argumentsJson: JSON.stringify({ message: 'Très bien.', operations: [{ type: 'faq.ajouter', question: 'Horaires ?', reponse: '9h-18h' }] }),
        }],
        usage: { tokensIn: 10, tokensOut: 5, coutDollars: 0.01 },
      } as never;
    },
    ...sur,
  };

  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { auth?: unknown }).auth = { userId: 'u1', tenantId: 't1', role: opts.role ?? 'admin' };
  });
  registerMbaAssistant(app, deps, gardeOuverte);
  return { app, journal, lireFil: () => fil };
}

const post = (app: ReturnType<typeof monter>['app'], url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload });

describe('le contrôle d’accès', () => {
  it('🔴 un non-admin est refusé : la conversation ne contourne pas le RBAC', async () => {
    // Un collaborateur qui ne peut pas modifier le MBA au formulaire ne doit pas pouvoir le faire en le
    // demandant à un robot.
    const m = monter({}, { role: 'agent' });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(r.statusCode).toBe(403);
    expect(m.journal.appelsModele).toBe(0);
  });

  it('⚠️ sans agent Meta rattaché, 404 plutôt qu’un écran vide', async () => {
    const m = monter({ agentIdDuTenant: async () => null });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(r.statusCode).toBe(404);
  });
});

describe('un tour', () => {
  it('propose des opérations, et n’écrit RIEN chez Meta', async () => {
    const m = monter();
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'ajoute mes horaires' });
    expect(r.statusCode).toBe(200);
    expect(r.json().operations).toHaveLength(1);
    // 🔴 Aucune application : la route PROPOSE.
    expect(m.journal.appliques).toHaveLength(0);
  });

  it('🔴 le fil CONSERVE tout, y compris le message de l’utilisateur', async () => {
    const m = monter();
    await post(m.app, '/tenants/t1/mba/assistant', { message: 'ajoute mes horaires' });
    const fil = m.lireFil()!;
    expect(fil.messages.map((x) => x.content)).toEqual(['ajoute mes horaires', 'Très bien.']);
    // L'auteur du message utilisateur, `null` pour l'assistant.
    expect(fil.auteurs).toEqual(['u1', null]);
  });

  it('⚠️ la dépense est notée APRÈS l’appel, avec le coût réel', async () => {
    const m = monter();
    await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    // 0,01 $ × 0,92 = 9 200 micro-euros.
    expect(m.journal.depenses).toEqual([9200]);
  });

  it('🔴 au plafond, il le DIT, ne coûte rien, et les onglets restent', async () => {
    // Ce n'est pas une panne : c'est une limite volontaire. Un 4xx afficherait un message d'infrastructure,
    // un 5xx serait remplacé par la page d'erreur de Cloudflare.
    const m = monter({}, { depense: 2_000_000 });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(r.statusCode).toBe(200);
    expect(r.json().message).toMatch(/mois prochain/i);
    expect(r.json().ongletsUtilisables).toBe(true);
    expect(m.journal.appelsModele).toBe(0);
  });

  it('⚠️ un modèle qui répond de travers ne casse PAS le fil', async () => {
    // Refuser en 422 laisserait un écran mort sur une erreur que le client ne peut pas corriger.
    const m = monter({
      completer: async () => ({ texte: 'Hmm.', finish: 'stop', appelsOutils: [], usage: { tokensIn: 5, tokensOut: 2, coutDollars: 0.001 } } as never),
    });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(r.statusCode).toBe(200);
    expect(r.json().operations).toEqual([]);
    expect(m.lireFil()?.messages).toHaveLength(2);
  });

  it('⚠️ un inventaire illisible chez Meta rend 422 avec la raison, sans rien écrire', async () => {
    // 422 et pas 502 : Cloudflare remplace le corps de toute 5xx, et l'écran affiche ce message.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ inventaire: async () => null });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    const lignes = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/illisible chez Meta/);
    expect(lignes.some((l) => l.includes('mba_assistant_inventaire_illisible'))).toBe(true);
    expect(m.journal.ecrits).toHaveLength(0);
  });
});

describe('l’ouverture du fil', () => {
  it('🔴 l’accueil est rédigé par le SERVEUR, et seulement sur un fil vide', async () => {
    const m = monter();
    const vide = await m.app.inject({ method: 'GET', url: '/tenants/t1/mba/assistant' });
    expect(vide.json().accueil).toMatch(/Il reste/);

    const m2 = monter({}, { fil: { ...ENTRETIEN_MBA_VIERGE, messages: [{ role: 'user', content: 'déjà parlé' }], auteurs: ['u1'] } });
    const repris = await m2.app.inject({ method: 'GET', url: '/tenants/t1/mba/assistant' });
    // Le renvoyer à chaque ouverture ferait répéter un bilan que la conversation a déjà dépassé.
    expect(repris.json().accueil).toBeNull();
  });

  it('⚠️ l’écran ne reçoit pas un fil sans fin, et connaît le total', async () => {
    const long = Array.from({ length: 260 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    const m = monter({}, { fil: { ...ENTRETIEN_MBA_VIERGE, messages: long, auteurs: long.map(() => 'u1') } });
    const r = await m.app.inject({ method: 'GET', url: '/tenants/t1/mba/assistant' });
    expect(r.json().messages).toHaveLength(200);
    expect(r.json().total).toBe(260);
  });
});

describe('appliquer', () => {
  it('🔴 REVALIDE les opérations : ce corps vient du NAVIGATEUR, pas du modèle', async () => {
    // Sans cette passe, n'importe qui pourrait poster une opération que le schéma de proposition interdit,
    // et la frontière de sécurité ne servirait plus à rien.
    const m = monter();
    const r = await post(m.app, '/tenants/t1/mba/assistant/appliquer', {
      operations: [{ type: 'activation.retirer' }],
    });
    expect(r.statusCode).toBe(422);
  });

  it('🔴 refuse DEUX suppressions, même postées directement', async () => {
    const m = monter();
    const r = await post(m.app, '/tenants/t1/mba/assistant/appliquer', {
      operations: [
        { type: 'faq.supprimer', cible: 'f1', libelle: 'A' },
        { type: 'faq.supprimer', cible: 'f2', libelle: 'B' },
      ],
    });
    expect(r.statusCode).toBe(422);
  });

  it('un non-admin ne peut pas appliquer', async () => {
    const m = monter({}, { role: 'agent' });
    const r = await post(m.app, '/tenants/t1/mba/assistant/appliquer', { operations: [] });
    expect(r.statusCode).toBe(403);
  });
});

/**
 * 🔴 LA GARDE QUE LA REVUE DU LOT B A RENDUE NÉCESSAIRE.
 *
 * Tout le moteur était écrit, testé, vert — et MORT : `registerMbaAssistant` n'était appelé nulle part, et
 * rien ne construisait l'inventaire. Treize tests passaient sur du code qu'aucune requête ne pouvait
 * atteindre. C'est le motif « capacité câblée sur zéro consommateur », déjà attrapé au lot A avec la colonne
 * `auteurs`, et aucun test unitaire ne peut le voir : un faux câblage ne dit rien du vrai.
 */
describe('le vrai câblage : la route EXISTE', () => {
  const serveur = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf8');
  const index = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');

  it('🔴 elle est montée dans le registre de modules', () => {
    expect(serveur).toContain("entree('mbaAssistant'");
    expect(serveur).toContain('registerMbaAssistant');
  });

  it('🔴 elle est montée en ADMIN, comme les écritures MBA', () => {
    // La conversation ne doit pas être un chemin plus permissif que le formulaire.
    const ligne = serveur.split('\n').find((l) => l.includes("entree('mbaAssistant'")) ?? '';
    expect(ligne).toContain('g.admin');
  });

  it('🔴 ses dépendances sont fournies, sinon la route n’existe pas', () => {
    expect(index).toContain('mbaAssistant: {');
    // L'inventaire a un producteur réel : sans lui, le moteur n'a rien à lire.
    expect(index).toContain('lireInventaireMba');
  });

  it('🔴 elle passe par NOTRE clé, jamais par le crédit du client', () => {
    const bloc = index.slice(index.indexOf('mbaAssistant: {'), index.indexOf('mba: {', index.indexOf('mbaAssistant: {')));
    expect(bloc).toContain('gatewayAide.completer');
    expect(bloc).toContain('AUCUN_ESPACE_PAYEUR');
  });
});

/**
 * 🔴 CE QUE LA REVUE GLOBALE DU 2026-09-15 A TROUVÉ SUR CETTE ROUTE.
 *
 * L'appel au modèle n'était ni BORNÉ ni RATTRAPÉ, alors que son jumeau de `src/http/agent-setup.ts` l'était
 * des deux côtés. Une panne du fournisseur levait donc ici, Fastify rendait 500, et Cloudflare remplace le
 * corps de toute 5xx par sa page d'erreur : le client voyait un écran qui n'explique rien.
 */
describe('quand le fournisseur de modèle lâche', () => {
  it('🔴 422 avec un message, JAMAIS un 5xx dont Cloudflare détruirait le corps', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ completer: async () => { throw new Error('upstream 503'); } });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    const lignes = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/n’a pas répondu/);
    // Journalisé en plus : le corps peut se perdre en route, le log reste.
    expect(lignes.find((l) => l.includes('mba_assistant_tour_echec'))).toContain('upstream 503');
  });

  it('🔴 et le fil n’est PAS écrit : un tour qui n’a pas eu lieu ne laisse rien', async () => {
    // Sinon le message du client resterait dans le fil, sans réponse en face, et le tour suivant
    // repartirait d'une conversation qui a l'air d'avoir été ignorée.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ completer: async () => { throw new Error('upstream 503'); } });
    await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    spy.mockRestore();
    expect(m.journal.ecrits).toHaveLength(0);
    expect(m.lireFil()).toBeNull();
  });

  it('🔴 l’appel est BORNÉ dans le temps', async () => {
    // Sans signal, un fournisseur qui traîne tient la requête ouverte indéfiniment, et le navigateur avec.
    let vu: unknown = null;
    const m = monter({
      completer: async (i: { signal?: AbortSignal }) => {
        vu = i.signal;
        return { texte: 'ok', finish: 'stop', appelsOutils: [], usage: { tokensIn: 1, tokensOut: 1, coutDollars: 0 } } as never;
      },
    } as never);
    await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(vu).toBeInstanceOf(AbortSignal);
  });
});

describe('le JSON du modèle', () => {
  it('⚠️ un `__proto__` dans les arguments ne casse pas le tour', async () => {
    // `secureJsonParse` REFUSE ce JSON là où `JSON.parse` l'acceptait : dans les deux cas rien ne doit
    // atteindre l'objet manipulé, et dans les deux cas la conversation doit survivre.
    const m = monter({
      completer: async () => ({
        texte: 'Hmm.', finish: 'tool_calls',
        appelsOutils: [{ id: 'c1', nom: 'proposer', argumentsJson: '{"__proto__":{"pollue":1},"message":"x"}' }],
        usage: { tokensIn: 1, tokensOut: 1, coutDollars: 0 },
      } as never),
    });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(r.statusCode).toBe(200);
    expect(({} as Record<string, unknown>).pollue).toBeUndefined();
    expect(r.json().operations).toEqual([]);
  });
});
