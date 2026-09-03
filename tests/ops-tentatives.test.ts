import { describe, it, expect } from 'vitest';
import { surveillerOps, ipIndicative, SEUIL_ALERTE, FENETRE_MS, REPOS_ALERTE_MS } from '../src/ops/tentatives';
import { buildServer } from '../src/server';
import type { ServerDeps } from '../src/server';
import { FakeQueue } from '../src/queue/fake';

/**
 * LA SURVEILLANCE DE `/ops` (décision de Julien, 2026-09-03).
 *
 * 🔴 Ce qu'elle ferme n'est pas la garde, c'est l'AVEUGLEMENT. `/ops` ouvre la lecture de toutes les
 * conversations de tous les clients ; Fastify tourne en `logger: false` ; donc quelqu'un qui cherchait le
 * jeton toute la nuit ne laissait aucune trace. Le jour où l'adresse passe de `/api/backend/ops/overview`,
 * noyée, à `api.messagingme.app/ops/overview`, devinable, cet aveuglement coûte beaucoup plus cher.
 */
describe('surveillance de /ops : compter, puis alerter', () => {
  const harnais = (debut = 1_000_000) => {
    let t = debut;
    const alertes: string[] = [];
    const journal: string[] = [];
    const s = surveillerOps({
      alerter: (m) => alertes.push(m),
      journaliser: (m) => journal.push(m),
      maintenant: () => t,
    });
    return { s, alertes, journal, avancer: (ms: number) => { t += ms; } };
  };

  it('🔴 un seul échec n’alerte PAS : un jeton mal recopié est le cas courant', () => {
    // Une alerte qui crie pour rien se fait ignorer le jour où elle a raison.
    const { s, alertes, journal } = harnais();
    s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toEqual([]);
    // Mais elle est JOURNALISÉE dès le premier : c'est ce qui permet de reconstituer après coup.
    expect(journal).toHaveLength(1);
  });

  it('🔴 au seuil, l’alerte part', () => {
    const { s, alertes } = harnais();
    for (let i = 0; i < SEUIL_ALERTE; i += 1) s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toContain('tentatives refusées');
  });

  it('🔴 une attaque soutenue prévient UNE fois, pas mille', () => {
    // Sans ce repos, un balayage transformerait le canal d'alerte en source de bruit, et le prochain vrai
    // signal se perdrait dedans.
    const { s, alertes, avancer } = harnais();
    for (let i = 0; i < 100; i += 1) {
      s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
      avancer(1_000);
    }
    expect(alertes).toHaveLength(1);
  });

  it('après le repos, une attaque qui dure re-prévient', () => {
    const { s, alertes, avancer } = harnais();
    for (let i = 0; i < SEUIL_ALERTE; i += 1) s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toHaveLength(1);
    avancer(REPOS_ALERTE_MS + 1_000);
    for (let i = 0; i < SEUIL_ALERTE; i += 1) s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toHaveLength(2);
  });

  it('🔴 des échecs ÉPARPILLÉS dans le temps n’alertent pas : c’est une FENÊTRE', () => {
    // Sinon deux fautes de frappe par mois finiraient par déclencher une alerte, et le seuil ne voudrait
    // plus rien dire.
    const { s, alertes, avancer } = harnais();
    for (let i = 0; i < SEUIL_ALERTE * 3; i += 1) {
      s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
      avancer(FENETRE_MS + 1_000);
    }
    expect(alertes).toEqual([]);
  });

  it('🔴 le jeton PRÉSENTÉ n’apparaît nulle part : ni dans le journal, ni dans l’alerte', () => {
    // La règle qui retournerait la surveillance contre nous si on l'oubliait. Une tentative est presque
    // toujours un secret voisin du vrai : l'écrire reviendrait à publier ce qu'on protège. Le contrat le
    // garantit par construction, `refus()` ne reçoit même pas le jeton.
    const { s, alertes, journal } = harnais();
    for (let i = 0; i < SEUIL_ALERTE; i += 1) s.refus({ chemin: '/ops/overview', ip: '9.9.9.9' });
    const tout = [...alertes, ...journal].join(' ');
    expect(tout).not.toMatch(/token|jeton-|secret/i);
    expect(tout).toContain('9.9.9.9'); // l'IP, elle, sert à quelque chose
  });
});

describe('ipIndicative : savoir d’où ça vient, sans s’y fier', () => {
  it('lit l’en-tête que Cloudflare pose', () => {
    // `req.ip` désigne le PROXY (Fastify est construit sans trustProxy) : sans cet en-tête, toutes les lignes
    // du journal porteraient la même adresse et ne diraient rien.
    expect(ipIndicative({ ip: '172.18.0.5', headers: { 'cf-connecting-ip': '81.2.3.4' } })).toBe('81.2.3.4');
  });

  it('retombe sur req.ip quand l’en-tête est absent ou vide', () => {
    expect(ipIndicative({ ip: '172.18.0.5', headers: {} })).toBe('172.18.0.5');
    expect(ipIndicative({ ip: '172.18.0.5', headers: { 'cf-connecting-ip': '   ' } })).toBe('172.18.0.5');
  });
});

describe('/ops : le refus déclenche bien la surveillance', () => {
  it('🔴 un mauvais jeton est SIGNALÉ, un bon jeton ne l’est pas', async () => {
    // Le câblage : sans lui, le module ci-dessus serait parfait et ne verrait jamais rien passer.
    const vus: Array<{ chemin: string; ip: string }> = [];
    const deps: ServerDeps = {
      queue: new FakeQueue(),
      verifyToken: 'v',
      appSecret: 's',
      opsToken: 'x'.repeat(32),
      ops: { getTenantOverview: async () => [], getGlobalDaily: async () => [], getQueueLoad: async () => [] },
      surveillanceOps: { refus: (i) => vus.push(i) },
    };
    const app = buildServer(deps);

    const mauvais = await app.inject({ method: 'GET', url: '/ops/overview', headers: { 'x-ops-token': 'faux' } });
    expect(mauvais.statusCode).toBe(401);
    expect(vus).toHaveLength(1);
    expect(vus[0]?.chemin).toBe('/ops/overview');

    const bon = await app.inject({ method: 'GET', url: '/ops/overview', headers: { 'x-ops-token': 'x'.repeat(32) } });
    expect(bon.statusCode).toBe(200);
    expect(vus, 'un accès légitime ne doit rien signaler').toHaveLength(1);
    await app.close();
  });
});
