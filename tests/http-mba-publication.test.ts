import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { Geste, OutilAPublier, EtatMeta, RelaisAPublier } from '../src/mba/publication';
import { FakeQueue } from '../src/queue/fake';
import { ErreurPublication } from '../src/mba/appliquer-publication';
import { MetaApiError } from '../src/meta/errors';

/**
 * Publier le catalogue d'outils chez Meta.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, c'est la promesse faite au client : « Engage Me fait foi, la publication
 * écrase ». Écraser n'est acceptable que si l'on montre QUOI avant de le faire, et si un échec en cours de
 * route se DIT au lieu de laisser un état à moitié publié dont personne ne connaît la forme.
 *
 * ⚠️ DEPUIS LE RELAIS (2026-09-21), ce qui part est un connecteur `EngageMe` par espace. Les cas des outils
 * « écartés » (`nonPubliables`, `OutilNonPubliable`) ont disparu avec eux : plus aucun outil n'arrive creux.
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

const RELAIS: RelaisAPublier = { baseUrl: 'https://api.messagingme.app/mba/relais', cleAJour: true };
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Le client demande à rajouter une étiquette.', nePasUtiliser: '',
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
};
const META_VIDE: EtatMeta = { connecteurs: [], outilsParConnecteur: {} };

function monter(opts: { numero?: string | null; echoueSur?: Geste['type']; erreur?: Error; relais?: RelaisAPublier | null; retenir?: Promise<void> } = {}) {
  const appliques: Geste[] = [];
  const contextes: Array<Map<string, unknown>> = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    mbaPublication: {
      numeroDuTenant: async () => (opts.numero === undefined ? '1234840649713976' : opts.numero),
      relais: async () => (opts.relais === undefined ? RELAIS : opts.relais),
      outilsExposes: async () => [ADD_TAG],
      etatMeta: async () => META_VIDE,
      appliquer: async (_t, _pn, g, ctx) => {
        if (opts.retenir) await opts.retenir;
        if (g.type === opts.echoueSur) throw opts.erreur ?? new Error('panne');
        appliques.push(g);
        contextes.push(ctx);
      },
    },
  });
  return { app, appliques, contextes };
}

describe('l’aperçu de publication', () => {
  it('rend le plan SANS rien écrire', async () => {
    const { app, appliques } = monter();
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().gestes.map((g: Geste) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
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
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
  });

  it('🔴 s’ARRÊTE au premier échec, et DIT ce qui a été fait', async () => {
    // Continuer laisserait un état à moitié publié dont personne ne connaît la forme. S'arrêter en le
    // disant permet de rejouer, et la publication étant idempotente, rejouer ne refait pas ce qui a réussi.
    const { app, appliques } = monter({ echoueSur: 'outil_creer' });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Relancez/);
    expect(res.json().faits).toHaveLength(1);
    // ⚠️ Et surtout : le geste SUIVANT n'a pas été tenté.
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer']);
  });

  it('🔴 un refus qui vient de NOUS ne se présente pas comme un refus de Meta', async () => {
    const { app } = monter({ echoueSur: 'outil_creer', erreur: new ErreurPublication('le connecteur EngageMe est introuvable chez Meta') });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).not.toMatch(/Meta a refusé/);
    expect(res.json().error).toMatch(/introuvable chez Meta/);
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

  it('🔴 sans adresse publique réglée, l’aperçu comme la publication REFUSENT en le disant', async () => {
    // Publier poserait chez Meta un connecteur qui n'appelle rien.
    const { app, appliques } = monter({ relais: null });
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({ method, url: `/tenants/${TENANT}/mba-publication`, ...h() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/adresse publique/);
    }
    expect(appliques).toEqual([]);
  });

  it('🔴 sans jeton, les deux routes refusent', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication` })).statusCode).toBe(401);
  });

describe('une publication à la fois, et la vraie cause d’un échec', () => {
  it('🔴 deux publications SIMULTANÉES du même espace : la seconde est refusée, rien ne s’entrelace', async () => {
    // Entrelacées, chacune posait sa clé chez Meta puis révoquait « toutes les autres », donc celle de
    // l'autre : Meta présentait une clé révoquée, et les deux POST rendaient 200.
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((r) => { liberer = r; });
    const { app, appliques } = monter({ retenir });
    const premiere = app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    await new Promise((r) => setTimeout(r, 20));
    const seconde = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(seconde.statusCode).toBe(409);
    expect(seconde.json().error).toMatch(/déjà en cours/);
    liberer();
    expect((await premiere).statusCode).toBe(200);
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
    // Le verrou retombe : une publication suivante passe.
    expect((await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() })).statusCode).toBe(200);
  });

  it('« Meta a refusé » seulement quand c’est Meta ; une panne de chez nous le dit', async () => {
    const meta = monter({ echoueSur: 'connecteur_creer', erreur: new MetaApiError(400, { message: 'Invalid connector request' }) });
    expect((await meta.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() })).json().error)
      .toMatch(/Meta a refusé/);
    const nous = monter({ echoueSur: 'connecteur_creer', erreur: new Error('connexion à la base perdue') });
    const msg = (await nous.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() })).json().error;
    expect(msg).not.toMatch(/Meta a refusé/);
    expect(msg).toMatch(/de notre côté/);
  });

  it('🔴 la publication AMORCE les gestes avec les outils du plan et l’administrateur qui publie', async () => {
    const { app, contextes } = monter();
    await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(contextes[0]!.get('outils')).toEqual([ADD_TAG]);
    expect(contextes[0]!.get('acteur')).toBe('u1');
  });
});
});
