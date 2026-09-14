import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { registerAgentKnowledge, type AgentKnowledgeRouteDeps } from '../src/http/agent-knowledge';
import { registerAgentSetup, type AgentSetupRouteDeps } from '../src/http/agent-setup';
import { ENTRETIEN_VIERGE, type EntretienComplet } from '../src/agent/setup/entretien-store';
import { ficheVide } from '../src/agent/fiche';
import type { FicheConnaissance } from '../src/agent/knowledge';

/**
 * L'HISTORIQUE CÔTÉ AGENT IA.
 *
 * 🔴 IL N'Y A PAS DE CORBEILLE ICI NON PLUS. Une fiche de connaissance supprimée disparaît de la base : la
 * ligne d'historique en est le seul exemplaire, exactement comme pour le Meta Business Agent. C'est aussi le
 * seul endroit qui réponde à « qui a retiré ça de ce que le robot sait dire ? ».
 *
 * 🔴 ET LES DEUX CHEMINS DE SUPPRESSION COMPTENT. Celui qui efface DEUX CENTS fiches d'un coup est justement
 * celui qu'on regretterait, et c'est le motif « une capacité câblée sur un consommateur sur deux » que ce
 * dépôt a payé plusieurs fois.
 */

const AG = '11111111-1111-1111-1111-111111111111';
const F1 = '22222222-2222-2222-2222-222222222222';
const F2 = '33333333-3333-3333-3333-333333333333';

const fiche = (id: string, titre: string): FicheConnaissance => ({
  id, titre, corps: `corps de ${titre}`, sourceUrl: null, sourceType: null, sourceNom: null,
  createdAt: '2026-09-15T08:00:00.000Z', updatedAt: '2026-09-15T08:00:00.000Z',
} as FicheConnaissance);

function monterConnaissance(opts: { sansJournal?: boolean } = {}) {
  const lignes: Array<{ tenant: string; agentId: string; cible: string; libelle: string; avant: unknown; acteurId: string | null }> = [];
  let base = [fiche(F1, 'Horaires'), fiche(F2, 'Livraisons')];

  const deps: AgentKnowledgeRouteDeps = {
    lister: async () => base,
    creer: async () => null,
    modifier: async () => null,
    supprimer: async (_t, _a, id) => {
      const avant = base.length;
      base = base.filter((f) => f.id !== id);
      return base.length < avant;
    },
    ...(opts.sansJournal ? {} : {
      journaliserSuppression: async (tenant, agentId, l) => { lignes.push({ tenant, agentId, ...l }); },
    }),
  } as AgentKnowledgeRouteDeps;

  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { auth?: unknown }).auth = { userId: 'u1', tenantId: 't1', role: 'admin' };
  });
  registerAgentKnowledge(app, deps);
  return { app, lignes, reste: () => base };
}

const urlFiche = (id: string) => `/tenants/t1/agents/${AG}/knowledge/${id}`;

describe('la suppression d’une fiche', () => {
  it('🔴 journalise le CONTENU effacé : c’est le seul exemplaire qui en restera', async () => {
    const m = monterConnaissance();
    const r = await m.app.inject({ method: 'DELETE', url: urlFiche(F1) });
    expect(r.statusCode).toBe(204);
    expect(m.lignes).toHaveLength(1);
    expect(m.lignes[0]).toMatchObject({ tenant: 't1', agentId: AG, cible: F1, acteurId: 'u1' });
    expect(m.lignes[0]?.libelle).toContain('Horaires');
    // 🔴 LE CONTENU, pas seulement le titre : c'est ce qui permet de recréer la fiche.
    expect((m.lignes[0]?.avant as FicheConnaissance).corps).toBe('corps de Horaires');
  });

  it('🔴 la suppression EN MASSE journalise aussi, une ligne par fiche', async () => {
    // C'est le geste qui peut effacer deux cents fiches d'un coup : le journaliser sur un seul des deux
    // chemins reviendrait à ne pas le journaliser du tout.
    const m = monterConnaissance();
    const r = await m.app.inject({
      method: 'POST', url: `/tenants/t1/agents/${AG}/knowledge/supprimer`, payload: { ids: [F1, F2] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().supprimees).toBe(2);
    expect(m.lignes.map((l) => l.cible)).toEqual([F1, F2]);
    expect(m.lignes.every((l) => (l.avant as FicheConnaissance).corps !== undefined)).toBe(true);
  });

  it('⚠️ une fiche DÉJÀ supprimée ne laisse aucune ligne', async () => {
    // Journaliser un geste qui n'a pas eu lieu ferait chercher une cause qui n'existe pas.
    const m = monterConnaissance();
    await m.app.inject({ method: 'DELETE', url: urlFiche(F1) });
    m.lignes.length = 0;
    const r = await m.app.inject({ method: 'DELETE', url: urlFiche(F1) });
    expect(r.statusCode).toBe(404);
    expect(m.lignes).toEqual([]);
  });

  it('⚠️ sans journal, la suppression marche quand même', async () => {
    // Une instance sans historique doit continuer de fonctionner : un journal manquant n'est pas une panne.
    const m = monterConnaissance({ sansJournal: true });
    expect((await m.app.inject({ method: 'DELETE', url: urlFiche(F1) })).statusCode).toBe(204);
    expect(m.reste().map((f) => f.id)).toEqual([F2]);
  });
});

function monterSetup(opts: { entretien?: EntretienComplet; emails?: Record<string, string>; sansResolveur?: boolean } = {}) {
  let appels = 0;
  const deps = {
    etatCourant: async () => ({
      label: 'Agent', mentionIaFrequence: 'session' as const, inactiviteMinutes: 30,
      fiche: { ...ficheVide(), objectif: 'Aider.' }, outils: [], titresConnaissance: [],
    }),
    entretiens: {
      lire: async () => opts.entretien ?? ENTRETIEN_VIERGE,
      ecrire: async () => {},
      effacer: async () => {},
    },
    modele: 'test/modele',
    ...(opts.sansResolveur ? {} : {
      emailsDesMembres: async () => { appels += 1; return opts.emails ?? { u1: 'julien@messagingme.fr' }; },
    }),
  } as unknown as AgentSetupRouteDeps;

  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { auth?: unknown }).auth = { userId: 'u1', tenantId: 't1', role: 'admin' };
  });
  registerAgentSetup(app, deps);
  return { app, appels: () => appels };
}

const fil = (messages: EntretienComplet['messages'], auteurs: Array<string | null>): EntretienComplet =>
  ({ ...ENTRETIEN_VIERGE, messages, auteurs });

describe('l’auteur du fil', () => {
  it('🔴 le serveur rend des ADRESSES, jamais les identifiants du jsonb', async () => {
    // Le fil ne porte que des identifiants (0147, et c'est le bon choix) ; l'écran ne peut afficher qu'un nom.
    // Le faire résoudre par le navigateur donnerait à voir la liste des comptes pour afficher deux adresses.
    const m = monterSetup({ entretien: fil([{ role: 'user', content: 'bonjour' }, { role: 'assistant', content: 'oui' }], ['u1', null]) });
    const r = await m.app.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/setup` });
    expect(r.statusCode).toBe(200);
    expect(r.json().auteurs).toEqual(['julien@messagingme.fr', null]);
  });

  it('🔴 un compte supprimé rend `null`, jamais un nom inventé', async () => {
    const m = monterSetup({
      entretien: fil([{ role: 'user', content: 'bonjour' }], ['parti']), emails: { u1: 'julien@messagingme.fr' },
    });
    const r = await m.app.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/setup` });
    expect(r.json().auteurs).toEqual([null]);
  });

  it('⚠️ un fil SANS aucun auteur ne coûte AUCUNE requête', async () => {
    // Les tours d'avant la migration 0147 et les réponses de l'assistant sont anonymes : résoudre pour eux
    // ferait payer une requête à chaque ouverture d'onglet, pour rien.
    const m = monterSetup({ entretien: fil([{ role: 'assistant', content: 'bonjour' }], [null]) });
    await m.app.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/setup` });
    expect(m.appels()).toBe(0);
  });

  it('⚠️ sans résolveur, l’écran s’ouvre quand même', async () => {
    const m = monterSetup({ entretien: fil([{ role: 'user', content: 'x' }], ['u1']), sansResolveur: true });
    const r = await m.app.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/setup` });
    expect(r.statusCode).toBe(200);
    expect(r.json().auteurs).toEqual([null]);
  });

  it('⚠️ les auteurs restent ALIGNÉS sur les messages quand le fil est borné', async () => {
    // Deux tableaux parallèles tronqués différemment feraient afficher, sur chaque tour, le nom du précédent.
    const longs = Array.from({ length: 260 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    const m = monterSetup({ entretien: fil(longs, longs.map(() => 'u1')) });
    const r = await m.app.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/setup` });
    expect(r.json().auteurs).toHaveLength(r.json().messages.length);
    expect(r.json().total).toBe(260);
  });
});

/** 🔴 LE CÂBLAGE : un journal qu'aucune route n'appelle, et un onglet qu'aucune page ne monte, sont morts. */
describe('le vrai câblage', () => {
  const index = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');
  const page = readFileSync(resolve(__dirname, '../web/app/agents/page.tsx'), 'utf8');

  it('🔴 la journalisation des fiches est fournie, et elle vise la surface « agent »', () => {
    const bloc = index.slice(index.indexOf('agentKnowledge: {'), index.indexOf('agentTools: {'));
    expect(bloc).toContain('journaliserSuppression');
    expect(bloc).toContain("surface: 'agent'");
    expect(bloc).toContain("element: 'connaissance'");
  });

  it('🔴 le résolveur d’adresses est fourni, sinon le fil reste anonyme', () => {
    expect(index).toContain('emailsDesMembres:');
    expect(index).toContain('userStore.list(tenant)');
  });

  it('🔴 l’onglet Historique est monté sur la page des agents, avec SA surface', () => {
    expect(page).toContain("'historique'");
    expect(page).toContain('surface="agent"');
    expect(page).toContain('agentId={ouvert.id}');
  });
});
