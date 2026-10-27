import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { DROITS } from '../src/offres/offres';
import { grilleDesOffres, type VueOffre } from '../src/offres/vue';

/**
 * L'OFFRE DE L'ESPACE, LUE PAR LA CONSOLE ET PAR CLAUDE (lot 6, tâche 6) : la même vue des deux côtés. Tout MEMBRE la
 * lit (la console grise ses menus d'après elle) ; l'isolation entre espaces est tenue par `tests/scope-tenant.test.ts`,
 * qui sonde chaque route d'espace, et la visibilité de `get_plan` pour une clé de lecture par `tests/mcp-agent.test.ts`,
 * qui dérive ses listes de `OUTILS`.
 */
const SECRET = 'test-secret';
let admin = '';
let agent = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const personne: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

/** Les limites telles que la vue les montre : sans la commission (spec Business). */
function sansMarge(l: typeof DROITS.base.limites): VueOffre['limites'] {
  const { commissionPct: _marge, ...vue } = l;
  return vue;
}

const VUE_BASE: VueOffre = {
  offre: 'free', fonctions: [], limites: sansMarge(DROITS.base.limites),
  usage: { envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 }, contactsToutesOrigines: true, contactsEnTrop: 0,
  grille: grilleDesOffres(), prixPro: { moisCentimes: 4900, anCentimes: 49000 }, prixBusiness: { moisCentimes: 34900, siegeMoisCentimes: 1000 },
  suiteDuNumero: null, essai: { jours: 14, possible: true, finLe: null }, sieges: null, prixSiege: { moisCentimes: 1500, anCentimes: 15000 },
  abonnement: null, upgradeUrl: 'https://console.test/offre',
};

function monter() {
  const lus: string[] = [];
  const server = buildServer({
    queue: new FakeQueue(), auth: { users: personne, secret: SECRET },
    offre: { vue: async (t) => { lus.push(t); return VUE_BASE; } },
  });
  return { server, lus };
}

describe('GET /tenants/:tenantId/offre', () => {
  it('🔴 un membre (pas seulement un admin) lit la vue de SON espace', async () => {
    const { server, lus } = monter();
    for (const jeton of [admin, agent]) {
      const res = await server.inject({ method: 'GET', url: '/tenants/t1/offre', headers: { authorization: `Bearer ${jeton}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(VUE_BASE);
    }
    expect(lus).toEqual(['t1', 't1']);
    await server.close();
  });

  it('sans session : 401, et la vue n’est pas calculée', async () => {
    const { server, lus } = monter();
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/offre' })).statusCode).toBe(401);
    expect(lus).toEqual([]);
    await server.close();
  });

  it('🔴 la lecture de l’offre n’est jamais gardée par l’offre : une Base la lit (sinon elle ne saurait pas quoi acheter)', async () => {
    const server = buildServer({
      queue: new FakeQueue(), auth: { users: personne, secret: SECRET },
      offres: { offreDe: async () => ({ offre: 'base', droits: DROITS.base, retourEnBaseLe: null }) },
      offre: { vue: async () => VUE_BASE },
    });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/offre', headers: { authorization: `Bearer ${agent}` } });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});

describe('l’outil MCP get_plan', () => {
  const outil = OUTILS.find((o) => o.nom === 'get_plan');

  it('🔴 il est en lecture (mcp:read), sans argument, et n’exige pas de personne', () => {
    expect(outil).toBeDefined();
    expect(outil!.scope).toBe('mcp:read');
    expect(outil!.exigePersonne).not.toBe(true);
    expect(outil!.entree).toEqual({ type: 'object', properties: {} });
  });

  it('🔴 il rend la MÊME vue que la console, pour l’espace du jeton', async () => {
    const lus: string[] = [];
    const deps = { offre: { vue: async (t: string) => { lus.push(t); return VUE_BASE; } } } as Pick<DepsMcp, 'offre'>;
    expect(await outil!.executer(deps as DepsMcp, 't1', {}, null)).toEqual(VUE_BASE);
    expect(lus).toEqual(['t1']);
  });

  it('sa description nomme les deux codes de refus et la fenêtre de 24 h', () => {
    expect(outil!.description).toContain('plan_limit_reached');
    expect(outil!.description).toContain('plan_feature_unavailable');
    // En anglais depuis le 2026-10-14 (répertoire de Claude).
    expect(outil!.description).toContain('24-hour window');
  });

  it('🔴 sa description dit ce que compte la limite de contacts, et ce que devient un nouveau client d’une Free pleine (2026-10-25)', () => {
    expect(outil!.description).toContain('contactsToutesOrigines');
    expect(outil!.description).toMatch(/in Free every contact counts, including those who wrote first/);
    expect(outil!.description).toMatch(/a full Free workspace does not let a new customer in/);
    expect(outil!.description).not.toMatch(/contacts created, automations on/);
  });

  it('🔴 sa description dit ce que vaut contactsEnTrop, et nomme les deux outils qui suppriment (2026-10-26)', () => {
    expect(outil!.description).toContain('contactsEnTrop');
    expect(outil!.description).toContain('prepare_contacts_deletion');
    expect(outil!.description).toContain('delete_contacts');
  });
});
