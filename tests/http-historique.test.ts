import { gardeOuverte } from './gardes';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { registerHistorique, LIGNES_HISTORIQUE_PAR_DEFAUT } from '../src/http/historique';
import { MAX_LIGNES_HISTORIQUE, type FiltreHistorique, type LigneHistoriqueLue } from '../src/reglages/historique';

/**
 * LA ROUTE DE LECTURE DE L'HISTORIQUE.
 *
 * 🔴 ELLE N'AVAIT AUCUN TEST, et c'est la seule porte d'un journal à rétention ILLIMITÉE qui porte le contenu
 * des éléments supprimés chez Meta. Trois choses s'y jouent : l'espace, le rôle, et la FORME du filtre, dont
 * la panne est muette (une surface mal formée ne lève rien en lecture, elle rend zéro ligne, ce qui se lit
 * comme « il ne s'est rien passé »).
 */

const UUID = '11111111-2222-3333-4444-555555555555';

const ligne = (sur: Partial<LigneHistoriqueLue> = {}): LigneHistoriqueLue => ({
  id: 'l1', surface: 'mba', surfaceId: null, element: 'faq', operation: 'ajout',
  cible: 'faq_1', libelle: 'FAQ : horaires', avant: null, apres: { q: 'x' },
  origine: 'assistant', acteurEmail: 'julien@messagingme.fr', acteurId: 'u1',
  at: '2026-09-15T08:00:00.000Z', ...sur,
});

function monter(opts: { role?: string; tenantId?: string; lignes?: LigneHistoriqueLue[] } = {}) {
  const vus: FiltreHistorique[] = [];
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { auth?: unknown }).auth = {
      userId: 'u1', tenantId: opts.tenantId ?? 't1', role: opts.role ?? 'admin',
    };
  });
  registerHistorique(app, {
    historique: {
      ecrire: async () => {},
      lister: async (_t, f) => { vus.push(f); return opts.lignes ?? [ligne()]; },
    },
  }, gardeOuverte);
  return { app, vus };
}

const lire = (app: ReturnType<typeof monter>['app'], q: string, tenant = 't1') =>
  app.inject({ method: 'GET', url: `/tenants/${tenant}/historique?${q}` });

describe('le contrôle d’accès', () => {
  it('🔴 un non-admin est refusé : le journal porte le contenu des suppressions', async () => {
    // Un journal plus lisible que ce qu'il décrit serait une fuite : les écritures du MBA sont admin-only.
    const m = monter({ role: 'agent' });
    const r = await lire(m.app, 'surface=mba');
    expect(r.statusCode).toBe(403);
    expect(m.vus).toEqual([]);
  });

  it('🔴 l’espace de l’URL ne décide de rien : c’est celui du jeton', async () => {
    const m = monter({ tenantId: 't1' });
    const r = await lire(m.app, 'surface=mba', 't2');
    expect(r.statusCode).toBe(403);
    expect(m.vus).toEqual([]);
  });
});

describe('la forme du filtre', () => {
  it('une surface inconnue est refusée en 400, pas ignorée', async () => {
    // 🔴 Ignorer la ferait tomber sur un défaut, donc afficher l'historique d'une AUTRE surface.
    expect((await lire(monter().app, 'surface=dinosaure')).statusCode).toBe(400);
    expect((await lire(monter().app, '')).statusCode).toBe(400);
  });

  it('🔴 la surface « agent » EXIGE un agent, et un vrai identifiant', async () => {
    /**
     * Sans lui, le filtre partirait à `null`, ce que la base lit comme « la ligne du MBA » : l'onglet d'un
     * agent montrerait l'historique du Meta Business Agent, sans la moindre erreur.
     */
    const m = monter();
    expect((await lire(m.app, 'surface=agent')).statusCode).toBe(400);
    expect((await lire(m.app, 'surface=agent&agentId=pas-un-uuid')).statusCode).toBe(400);
    expect(m.vus).toEqual([]);
  });

  it('🔴 la surface « mba » REFUSE un agent : il est unique par espace', async () => {
    const m = monter();
    expect((await lire(m.app, `surface=mba&agentId=${UUID}`)).statusCode).toBe(400);
    expect(m.vus).toEqual([]);
  });

  it('⚠️ pour le MBA, le filtre ne porte PAS de surfaceId du tout', async () => {
    // `is not distinct from null` côté store : passer `surfaceId: undefined` et `null` doit donner le même
    // résultat, mais c'est l'ABSENCE qui dit « le MBA », pas une valeur.
    const m = monter();
    expect((await lire(m.app, 'surface=mba')).statusCode).toBe(200);
    expect(m.vus[0]).toMatchObject({ surface: 'mba' });
    expect(m.vus[0]).not.toHaveProperty('surfaceId', UUID);
  });

  it('pour un agent, le filtre porte SON identifiant', async () => {
    const m = monter();
    await lire(m.app, `surface=agent&agentId=${UUID}`);
    expect(m.vus[0]).toMatchObject({ surface: 'agent', surfaceId: UUID });
  });
});

describe('la troncature', () => {
  it('🔴 elle est ANNONCÉE, jamais silencieuse', async () => {
    /**
     * Sur un journal, une liste coupée qui se présente comme complète fait conclure qu'une modification
     * ancienne n'a jamais eu lieu. C'est le pire malentendu possible sur cet écran.
     */
    const m = monter({ lignes: Array.from({ length: LIGNES_HISTORIQUE_PAR_DEFAUT }, (_, i) => ligne({ id: `l${i}` })) });
    const r = await lire(m.app, 'surface=mba');
    expect(r.json().tronquee).toBe(true);
    expect(m.vus[0]?.limite).toBe(LIGNES_HISTORIQUE_PAR_DEFAUT);
  });

  it('et elle est FAUSSE quand la liste tient entière', async () => {
    const r = await lire(monter().app, 'surface=mba');
    expect(r.json().tronquee).toBe(false);
    expect(r.json().lignes).toHaveLength(1);
  });

  it('une limite au-delà du plafond de lecture est refusée, pas rabotée en silence', async () => {
    const r = await lire(monter().app, `surface=mba&limite=${MAX_LIGNES_HISTORIQUE + 1}`);
    expect(r.statusCode).toBe(400);
  });
});

/**
 * 🔴 LA GARDE DE CÂBLAGE. Au lot B, tout un moteur est resté mort parce que rien ne le montait, et treize
 * tests verts n'y voyaient rien : un faux câblage ne dit rien du vrai.
 */
describe('le vrai câblage', () => {
  const serveur = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf8');
  const index = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');

  it('🔴 la route est montée, et en ADMIN', () => {
    const l = serveur.split('\n').find((x) => x.includes("entree('historique'")) ?? '';
    expect(l).toContain('registerHistorique');
    expect(l).toContain('g.admin');
  });

  it('🔴 son dépôt est fourni, sinon la route n’existe pas', () => {
    expect(index).toContain('historique: { historique: historiqueStore }');
  });
});
