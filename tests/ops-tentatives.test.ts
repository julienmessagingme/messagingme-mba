import { describe, it, expect } from 'vitest';
import { surveillerOps, ipIndicative, SEUIL_ALERTE, FENETRE_MS, REPOS_ALERTE_MS } from '../src/ops/tentatives';
import { buildServer } from '../src/server';
import type { ServerDeps } from '../src/server';
import { FakeQueue } from './fake-queue';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps } from './acces-ops';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import { verrousEnMemoire } from './verrous';

/**
 * LA SURVEILLANCE DE `/ops` (décision de Julien, 2026-09-03).
 *
 * 🔴 Ce qu'elle ferme n'est pas la garde, c'est l'AVEUGLEMENT. `/ops` ouvre la lecture de toutes les
 * conversations de tous les clients ; Fastify tourne en `logger: false` ; donc quelqu'un qui cherchait une
 * entrée toute la nuit ne laissait aucune trace. Elle reste sur la session d'exploitation nominative.
 */
describe('surveillance de /ops : compter, puis alerter', () => {
  /**
   * Une « base » (le compteur et les verrous partagés), et autant de copies de l'API qu'on veut dessus. L'horloge
   * part d'un multiple de la fenêtre : les fenêtres sont celles qu'aurait la base.
   */
  const harnais = (debut = 3 * FENETRE_MS) => {
    let t = debut;
    const alertes: string[] = [];
    const journal: string[] = [];
    const compteur = new CompteurDebitMemoire(() => t);
    const verrous = verrousEnMemoire(() => t);
    const copie = () => surveillerOps({
      alerter: (m) => alertes.push(m),
      journaliser: (m) => journal.push(m),
      compteur,
      verrous,
    });
    return { s: copie(), copie, alertes, journal, avancer: (ms: number) => { t += ms; } };
  };

  it('🔴 un seul échec n’alerte PAS : un jeton mal recopié est le cas courant', async () => {
    // Une alerte qui crie pour rien se fait ignorer le jour où elle a raison.
    const { s, alertes, journal } = harnais();
    await s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toEqual([]);
    // Mais elle est JOURNALISÉE dès le premier : c'est ce qui permet de reconstituer après coup.
    expect(journal).toHaveLength(1);
  });

  it('🔴 au seuil, l’alerte part', async () => {
    const { s, alertes } = harnais();
    for (let i = 0; i < SEUIL_ALERTE; i += 1) await s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toContain('tentatives refusées');
  });

  it('🔴 une attaque soutenue prévient UNE fois, pas mille', async () => {
    // Sans ce repos, un balayage transformerait le canal d'alerte en source de bruit, et le prochain vrai
    // signal se perdrait dedans.
    const { s, alertes, avancer } = harnais();
    for (let i = 0; i < 100; i += 1) {
      await s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
      avancer(1_000);
    }
    expect(alertes).toHaveLength(1);
  });

  it('après le repos, une attaque qui dure re-prévient', async () => {
    const { s, alertes, avancer } = harnais();
    for (let i = 0; i < SEUIL_ALERTE; i += 1) await s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toHaveLength(1);
    avancer(REPOS_ALERTE_MS + 1_000);
    for (let i = 0; i < SEUIL_ALERTE; i += 1) await s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toHaveLength(2);
  });

  it('🔴 des échecs ÉPARPILLÉS dans le temps n’alertent pas : c’est une FENÊTRE', async () => {
    // Sinon deux fautes de frappe par mois finiraient par déclencher une alerte, et le seuil ne voudrait
    // plus rien dire.
    const { s, alertes, avancer } = harnais();
    for (let i = 0; i < SEUIL_ALERTE * 3; i += 1) {
      await s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
      avancer(FENETRE_MS + 1_000);
    }
    expect(alertes).toEqual([]);
  });

  it('🔴 le jeton PRÉSENTÉ n’apparaît nulle part : ni dans le journal, ni dans l’alerte', async () => {
    // La règle qui retournerait la surveillance contre nous si on l'oubliait. Une tentative est presque
    // toujours un secret voisin du vrai : l'écrire reviendrait à publier ce qu'on protège. Le contrat le
    // garantit par construction, `refus()` ne reçoit même pas le jeton.
    const { s, alertes, journal } = harnais();
    for (let i = 0; i < SEUIL_ALERTE; i += 1) await s.refus({ chemin: '/ops/overview', ip: '9.9.9.9' });
    const tout = [...alertes, ...journal].join(' ');
    expect(tout).not.toMatch(/token|jeton-|secret/i);
    expect(tout).toContain('9.9.9.9'); // l'IP, elle, sert à quelque chose
  });

  it('🔴 PLUSIEURS COPIES : un balayage réparti atteint le seuil au TOTAL, et n’alerte qu’UNE fois', async () => {
    // Lot B (2026-09-28) : compté par copie, un balayage réparti sur trois copies (deux refus sur chacune) ne
    // dépassait le seuil nulle part ; et une attaque soutenue aurait prévenu une fois PAR COPIE.
    const { copie, alertes } = harnais();
    const copies = [copie(), copie(), copie()];
    for (let i = 0; i < 6; i += 1) await copies[i % 3]!.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes).toHaveLength(1);
    for (let i = 0; i < 30; i += 1) await copies[i % 3]!.refus({ chemin: '/ops/overview', ip: '1.2.3.4' });
    expect(alertes, 'le repos est commun à toutes les copies').toHaveLength(1);
  });

  it('🔴 une RAFALE de refus simultanés : un seul comptage en vol, le compte reste exact, une seule prise du repos', async () => {
    // Un refus est anonyme et l'appelant n'attend pas : une écriture par requête, sans contre-pression, prendrait
    // toutes les connexions du pool. Les refus arrivés pendant un comptage partent ensemble dans le suivant.
    let t = 3 * FENETRE_MS;
    const base = new CompteurDebitMemoire(() => t);
    const verrous = verrousEnMemoire(() => t);
    let comptages = 0;
    let prises = 0;
    const alertes: string[] = [];
    const s = surveillerOps({
      alerter: (m) => alertes.push(m),
      compteur: { compter: (c) => { comptages += 1; return base.compter(c); }, lister: (p, d) => base.lister(p, d) },
      verrous: { prendre: (c) => { prises += 1; return verrous.prendre(c); } },
    });
    await Promise.all(Array.from({ length: 50 }, () => s.refus({ chemin: '/ops/usage', ip: '1.2.3.4' })));
    expect(comptages, 'au plus deux comptages pour cinquante refus simultanés').toBeLessThanOrEqual(2);
    const lignes = await base.lister('ops.refus', 0);
    expect(lignes.reduce((total, l) => total + l.n, 0), 'le compte reste exact').toBe(50);
    expect(prises).toBeLessThanOrEqual(1);
    expect(alertes).toHaveLength(1);
    // Une seconde rafale dans le repos : ni nouvelle prise du verrou, ni nouvelle alerte.
    t += 1_000;
    await Promise.all(Array.from({ length: 50 }, () => s.refus({ chemin: '/ops/usage', ip: '1.2.3.4' })));
    expect(prises).toBeLessThanOrEqual(1);
    expect(alertes).toHaveLength(1);
  });

  it('🔴 base muette : le refus est JOURNALISÉ quand même, rien ne lève, et aucune alerte n’est inventée', async () => {
    const alertes: string[] = [];
    const journal: string[] = [];
    const s = surveillerOps({
      alerter: (m) => alertes.push(m),
      journaliser: (m) => journal.push(m),
      compteur: { compter: async () => { throw new Error('connexion perdue'); }, lister: async () => [] },
      verrous: { prendre: async () => { throw new Error('connexion perdue'); } },
    });
    for (let i = 0; i < SEUIL_ALERTE; i += 1) await expect(s.refus({ chemin: '/ops/overview', ip: '1.2.3.4' })).resolves.toBeUndefined();
    expect(journal).toHaveLength(SEUIL_ALERTE);
    expect(JSON.parse(journal[0]!)).toMatchObject({ msg: 'ops_refus', dansLaFenetre: null });
    expect(alertes).toEqual([]);
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
  it('🔴 une session fausse est SIGNALÉE, une vraie ne l’est pas, et une adresse retirée l’est', async () => {
    // Le câblage : sans lui, le module ci-dessus serait parfait et ne verrait jamais rien passer.
    const vus: Array<{ chemin: string; ip: string }> = [];
    const acces = accesOps();
    const deps: ServerDeps = {
      queue: new FakeQueue(),
      verifyToken: 'v',
      appSecret: 's',
      auth: acces.auth,
      ops: { ...opsInerte, exploitation: { ...exploitationInerte, getTenantOverview: async () => [], getGlobalDaily: async () => [], getQueueLoad: async () => [] } },
      surveillanceOps: { refus: async (i) => { vus.push(i); } },
    };
    const app = buildServer(deps);

    const mauvais = await app.inject({ method: 'GET', url: '/ops/overview', headers: { authorization: 'Bearer faux' } });
    expect(mauvais.statusCode).toBe(401);
    expect(vus).toHaveLength(1);
    expect(vus[0]?.chemin).toBe('/ops/overview');

    const bon = await app.inject({ method: 'GET', url: '/ops/overview', headers: await acces.entetes(app) });
    expect(bon.statusCode).toBe(200);
    expect(vus, 'un accès légitime ne doit rien signaler').toHaveLength(1);

    // Une session valide dont l'adresse a quitté la liste est un refus comme un autre : elle se compte.
    acces.liste.length = 0;
    const retire = await app.inject({ method: 'GET', url: '/ops/overview', headers: await acces.entetes(app) });
    expect(retire.statusCode).toBe(401);
    expect(vus).toHaveLength(2);
    await app.close();
  });
});
