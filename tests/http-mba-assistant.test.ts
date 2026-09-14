import { describe, it, expect } from 'vitest';
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
      return {
        texte: null,
        appelsOutils: [{ nom: 'proposer', arguments: { message: 'Très bien.', operations: [{ type: 'faq.ajouter', question: 'Horaires ?', reponse: '9h-18h' }] } }],
        usage: { coutDollars: 0.01 },
      };
    },
    ...sur,
  };

  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { auth?: unknown }).auth = { userId: 'u1', tenantId: 't1', role: opts.role ?? 'admin' };
  });
  registerMbaAssistant(app, deps);
  return { app, journal, lireFil: () => fil };
}

const post = (app: ReturnType<typeof monter>['app'], url: string, payload: unknown) =>
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
      completer: async () => ({ texte: 'Hmm.', appelsOutils: [], usage: { coutDollars: 0.001 } }),
    });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(r.statusCode).toBe(200);
    expect(r.json().operations).toEqual([]);
    expect(m.lireFil()?.messages).toHaveLength(2);
  });

  it('⚠️ un inventaire illisible chez Meta rend 502, sans rien écrire', async () => {
    const m = monter({ inventaire: async () => null });
    const r = await post(m.app, '/tenants/t1/mba/assistant', { message: 'bonjour' });
    expect(r.statusCode).toBe(502);
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
