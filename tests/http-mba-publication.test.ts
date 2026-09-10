import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { Geste, SourceAPublier, OutilAPublier, EtatMeta } from '../src/mba/publication';
import { FakeQueue } from '../src/queue/fake';

/**
 * Publier le catalogue d'outils chez Meta.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, c'est la promesse faite au client : « Engage Me fait foi, la publication
 * écrase ». Écraser n'est acceptable que si l'on montre QUOI avant de le faire, et si un échec en cours de
 * route se DIT au lieu de laisser un état à moitié publié dont personne ne connaît la forme.
 */
const TENANT = 't1';
const SECRET = 'test-secret';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

let adminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: TENANT, role: 'admin' }, SECRET);
});
/** ⚠️ Une FONCTION : un objet figé au chargement capturerait un jeton encore vide. */
const h = (): { headers: Record<string, string> } => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok}` },
});

const SRC: SourceAPublier = {
  id: 's1', label: 'Shopify', baseUrl: 'https://api.shopify.com/v1',
  authKind: 'bearer', authHeaderName: null, aAuthentification: true,
};
const OUT: OutilAPublier = {
  id: 'o1', sourceId: 's1', name: 'check_order_status', description: 'État d’une commande.',
  nePasUtiliser: 'Jamais pour annuler.', methode: 'GET', chemin: '/orders/{id}',
};
const META_VIDE: EtatMeta = { connecteurs: [], outilsParConnecteur: {} };

function monter(opts: { numero?: string | null; echoueSur?: Geste['type'] } = {}) {
  const appliques: Geste[] = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    mbaPublication: {
      numeroDuTenant: async () => (opts.numero === undefined ? '1234840649713976' : opts.numero),
      sources: async () => [SRC],
      secretDeLaSource: async () => 'SECRET',
      outilsExposes: async () => [OUT],
      etatMeta: async () => META_VIDE,
      appliquer: async (_t, _pn, g) => {
        if (g.type === opts.echoueSur) throw new Error('Meta a refusé');
        appliques.push(g);
      },
    },
  });
  return { app, appliques };
}

describe('l’aperçu de publication', () => {
  it('rend le plan SANS rien écrire', async () => {
    const { app, appliques } = monter();
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().gestes.map((g: Geste) => g.type)).toEqual(['connecteur_creer', 'secret_poser', 'outil_creer']);
    expect(appliques).toEqual([]);
  });

  it('sans numéro connecté, l’aperçu est vide plutôt qu’en erreur', async () => {
    // Un espace sans WhatsApp n'a rien à publier : ce n'est pas une panne, et l'écran doit pouvoir
    // s'afficher sans message rouge.
    const { app } = monter({ numero: null });
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gestes: [], phoneNumberId: null });
  });
});

describe('la publication', () => {
  it('applique les gestes DANS L’ORDRE du plan', async () => {
    // L'ordre n'est pas indifférent : un outil ne peut pas être créé avant son connecteur.
    const { app, appliques } = monter();
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer', 'secret_poser', 'outil_creer']);
  });

  it('🔴 s’ARRÊTE au premier échec, et DIT ce qui a été fait', async () => {
    // Continuer laisserait un état à moitié publié dont personne ne connaît la forme. S'arrêter en le
    // disant permet de rejouer, et la publication étant idempotente, rejouer ne refait pas ce qui a réussi.
    const { app, appliques } = monter({ echoueSur: 'secret_poser' });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Relancez/);
    expect(res.json().faits).toHaveLength(1);
    // ⚠️ Et surtout : le geste SUIVANT n'a pas été tenté.
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer']);
  });

  it('🔴 un échec sort en 409, jamais en 500', async () => {
    // Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur : le message qui dit quoi faire
    // n'arriverait jamais à l'écran.
    const { app } = monter({ echoueSur: 'connecteur_creer' });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
  });

  it('sans numéro connecté, publier REFUSE en le disant', async () => {
    const { app } = monter({ numero: null });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Aucun numéro/);
  });

  it('🔴 sans jeton, les deux routes refusent', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication` })).statusCode).toBe(401);
  });
});
