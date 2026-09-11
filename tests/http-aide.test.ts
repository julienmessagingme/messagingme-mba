import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAide } from '../src/http/aide';
import type { QuestionAide, ReponseAide } from '../src/aide/repondre';

/**
 * LA ROUTE DU BOT D'AIDE.
 *
 * 🔴 CE QU'ELLE PROTÈGE. Le RÔLE vient du jeton et jamais du corps : le lire dans la requête laisserait
 * n'importe qui se déclarer administrateur pour obtenir la carte complète de la console. Et chaque question
 * coûte un appel de modèle sur NOTRE clé, donc le plafond de débit est compté par ESPACE, pas par personne.
 */
const vide: ReponseAide = { sait: false, texte: '', sources: [], ecrans: [] };

/**
 * Monte la route avec une authentification simulée.
 *
 * ⚠️ `userId` est MUTABLE, et ce n'est pas un détail de confort : sans lui, le test du plafond de débit
 * frappait toujours avec la même personne, donc une clé « par utilisateur » et une clé « par espace » se
 * comportaient à l'identique. Le test passait dans les DEUX sens, c'est-à-dire ne prouvait rien, tout en
 * annonçant dans son titre qu'il gardait le contraire. Relevé par mutation le 2026-09-11.
 */
function app(over: { repondre?: (q: QuestionAide) => Promise<ReponseAide> } = {}, auth: { tenantId: string; role: string } | null = { tenantId: 't1', role: 'admin' }) {
  let userId = 'u1';
  const server = Fastify();
  const garde = async (req: { auth?: unknown }): Promise<void> => {
    if (auth) (req as { auth?: unknown }).auth = { tenantId: auth.tenantId, userId, role: auth.role };
  };
  registerAide(server, over.repondre ? { repondre: over.repondre } : {}, garde as never);
  return Object.assign(server, { changerUtilisateur: (u: string) => { userId = u; } });
}

const post = (payload: Record<string, unknown>) => ({ method: 'POST' as const, url: '/tenants/t1/aide', payload });

describe('route d’aide', () => {
  it('répond 200 avec ce que rend le moteur', async () => {
    const r = await app({ repondre: async () => ({ sait: true, texte: 'Ouvrez Campagnes.', sources: ['Lancer une campagne'], ecrans: [] }) })
      .inject(post({ question: 'comment lancer une campagne' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sait: true, texte: 'Ouvrez Campagnes.' });
  });

  it('🔴 le RÔLE vient du jeton, jamais du corps', async () => {
    // Sans ça, n'importe qui se déclarerait administrateur pour obtenir la carte complète de la console.
    const repondre = vi.fn().mockResolvedValue(vide);
    await app({ repondre }, { tenantId: 't1', role: 'agent' })
      .inject(post({ question: 'q', role: 'admin' }));
    expect(repondre.mock.calls[0]![0]).toMatchObject({ role: 'agent' });
  });

  it('🔴 un jeton d’un AUTRE espace est refusé', async () => {
    const r = await app({ repondre: async () => vide }, { tenantId: 't2', role: 'admin' })
      .inject(post({ question: 'q' }));
    expect(r.statusCode).toBe(403);
  });

  it('une question vide est refusée en 400', async () => {
    const r = await app({ repondre: async () => vide }).inject(post({ question: '   ' }));
    expect(r.statusCode).toBe(400);
  });

  it('⚠️ une question trop longue est refusée en 400, avec la limite dans le message', async () => {
    // 4xx et pas 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur, et le client
    // ne lirait jamais la raison.
    const r = await app({ repondre: async () => vide }).inject(post({ question: 'a'.repeat(501) }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/500/);
  });

  it('🔴 sans moteur câblé : 503, jamais un repli muet', async () => {
    // Un repli silencieux ferait croire que le bot « ne sait pas », alors qu'il n'est pas branché du tout.
    const r = await app().inject(post({ question: 'q' }));
    expect(r.statusCode).toBe(503);
  });

  it('une PANNE du moteur rend 502, et le corps ne fuit rien', async () => {
    const r = await app({ repondre: async () => { throw new Error('gateway 503 clef=secrete'); } })
      .inject(post({ question: 'q' }));
    expect(r.statusCode).toBe(502);
    expect(JSON.stringify(r.json())).not.toContain('secrete');
  });

  it('⚠️ l’écran courant et la langue sont transmis, bornés', async () => {
    const repondre = vi.fn().mockResolvedValue(vide);
    await app({ repondre }).inject(post({ question: 'q', ecranCourant: 'workflows', langue: 'en' }));
    expect(repondre.mock.calls[0]![0]).toMatchObject({ ecranCourant: 'workflows', langue: 'en' });
    const repondre2 = vi.fn().mockResolvedValue(vide);
    await app({ repondre: repondre2 }).inject(post({ question: 'q', langue: 'klingon' }));
    // Une langue inconnue retombe sur le français, elle ne fait pas échouer la question.
    expect(repondre2.mock.calls[0]![0]).toMatchObject({ langue: 'fr', ecranCourant: null });
  });

  it('🔴 le plafond de débit est compté par ESPACE, pas par personne', async () => {
    // Chaque question coûte un appel de modèle sur NOTRE clé : ce qu'on protège est notre facture, et c'est
    // l'ESPACE qui la consomme. Une clé par personne laisserait une équipe de dix multiplier le plafond par
    // dix sans que rien ne le dise.
    const server = app({ repondre: async () => vide });
    let dernier = 200;
    for (let i = 0; i < 25; i += 1) {
      dernier = (await server.inject(post({ question: 'q' }))).statusCode;
    }
    expect(dernier).toBe(429);
    // 🔴 LE POINT DU TEST : une AUTRE personne du même espace est refusée elle aussi. Sans cette moitié, une
    // clé « par utilisateur » passerait exactement pareil, et ce test ne garderait rien.
    server.changerUtilisateur('u2');
    expect((await server.inject(post({ question: 'q' }))).statusCode).toBe(429);
  });

  it('⚠️ un AUTRE espace garde son propre plafond', async () => {
    // Le miroir, sinon le test précédent passerait aussi sur un plafond GLOBAL, qui laisserait un seul
    // client couper l'aide pour tous les autres.
    const server = app({ repondre: async () => vide });
    for (let i = 0; i < 25; i += 1) await server.inject(post({ question: 'q' }));
    const autre = await server.inject({ method: 'POST', url: '/tenants/t1/aide', payload: { question: 'q' } });
    expect(autre.statusCode).toBe(429);
    const neuf = app({ repondre: async () => vide });
    expect((await neuf.inject(post({ question: 'q' }))).statusCode).toBe(200);
  });
});
