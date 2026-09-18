import { describe, it, expect, beforeAll } from 'vitest';
import { GRILLE_DEFAUT } from '../src/stats/prix';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { SettingsRouteDeps } from '../src/http/settings';
import type { FrequenceMentionIa } from '../src/agent/agent-store';
import { lireContexteAgent } from '../src/agent/contexte';
import type { AgentComplet } from '../src/agent/agent-store';
import { ficheVide } from '../src/agent/fiche';

/**
 * « L'IA SE DÉCLARE COMME TELLE », AU NIVEAU DE L'ESPACE (tâche 8, migration 0140).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE N'EST PAS « le réglage s'enregistre », C'EST QU'IL Y EN A UN SEUL ET QU'IL
 * GOUVERNE VRAIMENT LE RUNTIME. Le déplacer depuis la fiche d'agent crée deux risques opposés : laisser une
 * seconde vérité derrière soi (la colonne d'agent, qu'on n'édite plus mais qu'on lirait encore), ou déplacer
 * le réglage sans déplacer ce qui le LIT, auquel cas l'écran promettrait un comportement qui n'existe pas.
 */

const SECRET = 'test-secret';
const AG = '11111111-1111-4111-8111-111111111111';
let adminTok = '';
let managerTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  managerTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'manager' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(depart: FrequenceMentionIa | null = null) {
  const ecrits: FrequenceMentionIa[] = [];
  let courant = depart;
  const settings: SettingsRouteDeps = {
    getSettings: async () => ({
      mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
      controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, optoutRequestId: null, mentionIaFrequence: courant,
      timezone: 'Europe/Paris', businessHours: {}, prix: GRILLE_DEFAUT,
    }),
    setMbaEnabled: async () => {},
    setHubspotListsEnabled: async () => {},
    setAutoRetryEnabled: async () => {},
    setMbaHandoffMode: async () => {},
    setControlHandbackSeconds: async () => {},
    setTimezone: async () => {},
    setBusinessHours: async () => {},
    setMentionIaFrequence: async (_t, f) => { ecrits.push(f); courant = f; },
    listerAgentsPourConformite: async () => [
      { id: AG, label: 'Conseiller séjours', status: 'active', mentionIa: 'Vous échangez avec un assistant automatique.' },
    ],
  };
  return { ecrits, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, settings }) };
}

const URL_IA = '/tenants/t1/settings/mention-ia';

describe('la politique d’annonce d’IA appartient à l’espace', () => {
  /**
   * 🔴 « DÉFAUT APPLIQUÉ » ET « LE CLIENT A CHOISI » NE SE CONFONDENT PAS. Les deux donnent le même
   * comportement, et pas la même responsabilité : sur un écran de conformité, dire « vous avez choisi une
   * fois par conversation » à quelqu'un qui n'a jamais rien choisi serait un faux témoignage.
   */
  it('🔴 rien de réglé -> le défaut EFFECTIF est rendu, et dit comme tel', async () => {
    const { srv } = app(null);
    const res = await srv.inject({ method: 'GET', url: URL_IA, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ frequence: 'session', reglee: false });
    await srv.close();
  });

  it('⚠️ ...et une fois réglé, il le dit aussi', async () => {
    const { srv } = app('jamais');
    expect((await srv.inject({ method: 'GET', url: URL_IA, ...h(adminTok) })).json())
      .toMatchObject({ frequence: 'jamais', reglee: true });
    await srv.close();
  });

  /**
   * 🔴 LA PHRASE DE CHAQUE AGENT EST DANS LA RÉPONSE. Le régime dit QUAND on annonce ; il ne dit pas CE
   * QU'ON ANNONCE. Un écran de conformité qui montrerait le premier sans le second promettrait une
   * vérification qu'il ne permet pas de faire.
   */
  it('🔴 la liste porte la PHRASE de chaque agent, pas seulement son nom', async () => {
    const { srv } = app();
    const b = (await srv.inject({ method: 'GET', url: URL_IA, ...h(adminTok) })).json<{ agents: Array<{ mentionIa: string }> }>();
    expect(b.agents).toHaveLength(1);
    expect(b.agents[0]?.mentionIa).toContain('assistant automatique');
    await srv.close();
  });

  it('un admin règle les trois régimes', async () => {
    const { srv, ecrits } = app();
    for (const f of ['jamais', 'chaque_message', 'session'] as const) {
      const res = await srv.inject({ method: 'PATCH', url: URL_IA, payload: { frequence: f }, ...h(adminTok) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ frequence: f });
    }
    expect(ecrits).toEqual(['jamais', 'chaque_message', 'session']);
    await srv.close();
  });

  it('une valeur inconnue est REFUSÉE en 400, et rien n’est écrit', async () => {
    const { srv, ecrits } = app();
    const res = await srv.inject({ method: 'PATCH', url: URL_IA, payload: { frequence: 'parfois' }, ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('jamais | session | chaque_message');
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('un manager n’y touche pas : c’est une décision de la marque', async () => {
    const { srv, ecrits } = app();
    expect((await srv.inject({ method: 'PATCH', url: URL_IA, payload: { frequence: 'jamais' }, ...h(managerTok) })).statusCode).toBe(403);
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('un autre espace ne voit rien de celui-ci', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: '/tenants/t9/settings/mention-ia', ...h(adminTok) })).statusCode).toBe(403);
    await srv.close();
  });
});

/**
 * 🔴 LE RUNTIME SUIT L'ESPACE, ET C'EST LA MOITIÉ QUI COMPTE VRAIMENT.
 *
 * Déplacer un réglage sans déplacer ce qui le LIT donne un écran qui promet un comportement inexistant. Ces
 * cas passent par `lireContexteAgent`, qui est le POINT DE PASSAGE UNIQUE des deux consommateurs (le tour de
 * production et le bac à sable) : c'est ce qui garantit qu'ils voient la même chose.
 */
describe('le contexte d’un tour lit la politique de l’ESPACE', () => {
  const fiche = {
    id: AG, label: 'A', status: 'active' as const, mentionIa: 'Je suis une IA.', modele: 'm',
    maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000, inactiviteMinutes: 30,
    contactInconnu: 'lecture_seule' as const, contenu: ficheVide(), ficheVersion: 1,
  } satisfies AgentComplet;
  const deps = (politique?: FrequenceMentionIa | null) => ({
    agents: { complet: async () => fiche },
    outils: { listActifs: async () => [] },
    ...(politique === undefined ? {} : { politiqueMentionIa: async () => politique }),
  });

  it('🔴 la politique de l’espace gouverne le tour', async () => {
    const ctx = await lireContexteAgent(deps('chaque_message'), 't1', AG);
    expect(ctx?.mentionIaFrequence).toBe('chaque_message');
  });

  /**
   * ⚠️ LE TÉMOIN DANS L'AUTRE SENS, et il n'est pas décoratif : sans lui, un contexte qui rendrait TOUJOURS
   * `session` passerait le cas précédent... non, il le ferait échouer. Ce qu'il attrape, lui, c'est un
   * contexte qui rendrait `undefined` faute de repli, ce qui enverrait au modèle une consigne vide.
   */
  it('⚠️ un espace qui n’a rien réglé retombe sur `session`, le défaut de 0126', async () => {
    expect((await lireContexteAgent(deps(null), 't1', AG))?.mentionIaFrequence).toBe('session');
    // Et un câblage qui ne fournit même pas la dep (un harnais de test) se comporte pareil.
    expect((await lireContexteAgent(deps(), 't1', AG))?.mentionIaFrequence).toBe('session');
  });

  it('⚠️ `jamais` est transmis TEL QUEL, jamais requalifié en défaut', async () => {
    // Le piège serait un `?? 'session'` posé sur une valeur falsy : `jamais` est une chaîne non vide, mais
    // c'est le régime que quelqu'un pourrait « corriger » par prudence. Il est le choix du client.
    expect((await lireContexteAgent(deps('jamais'), 't1', AG))?.mentionIaFrequence).toBe('jamais');
  });
});
