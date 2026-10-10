import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { accesOps, ADRESSE_OPS } from './acces-ops';
import { FakeQueue } from './fake-queue';
import { capturerJournal } from './journal';
import type { OpsOffreDeps } from '../src/http/ops-offre';
import type { EcritureEntreprise, ReglageEntreprise } from '../src/offres/offre.pg';
import type { AuditSink } from '../src/audit/journal';

/**
 * L'ENTREPRISE D'UN ESPACE, POSÉE PAR L'EXPLOITATION (lot 6, tâche 6), PAR LE VRAI CÂBLAGE (`buildServer`).
 *
 * 🔴 Ce qu'un test du handler seul ne voit pas : que la route est bien derrière la garde d'exploitation, et que
 * l'écriture vide le cache de l'offre de CE process (sans quoi un espace ramené en Base garderait ses fonctions
 * Entreprise jusqu'à l'expiration du cache, en silence).
 */
const T1 = '4169c753-311a-43bb-a334-d8a2cb7caf6f';
const INCONNU = '11111111-2222-4333-8444-555555555555';

class MagasinMemoire {
  lectures = 0;
  readonly ecritures: Array<{ tenantId: string; reglage: EcritureEntreprise }> = [];
  readonly invalides: string[] = [];
  readonly audits: Array<{ tenant: string; acteur: { userId: string | null; email: string | null }; action: string; cible: { kind: string; id: string }; detail: Record<string, unknown> | undefined }> = [];
  readonly reglages = new Map<string, ReglageEntreprise>([[T1, { entreprise: true, utilisateurs: null, conservationJours: null }]]);
  deps(): OpsOffreDeps {
    const audits = this.audits;
    const audit: AuditSink = async (tenant, acteur, action, cible, detail) => { audits.push({ tenant, acteur, action, cible, detail }); };
    return { audit,
      store: {
        lireEntreprise: async (t) => { this.lectures += 1; return this.reglages.get(t) ?? null; },
        ecrireEntreprise: async (t, r) => {
          const avant = this.reglages.get(t);
          if (!avant) return false;
          this.ecritures.push({ tenantId: t, reglage: r });
          // Comme `PgOffresStore.ecrireEntreprise` : une conservation absente n'est pas écrite.
          this.reglages.set(t, { entreprise: r.entreprise, utilisateurs: r.utilisateurs, conservationJours: r.conservationJours === undefined ? avant.conservationJours : r.conservationJours });
          return true;
        },
      },
      invalider: (t) => { this.invalides.push(t); },
    };
  }
}

const acces = accesOps();
const ops: Record<string, string> = { 'content-type': 'application/json' };
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  ops.authorization = `Bearer ${await acces.jeton(s)}`;
  await s.close();
});

function monter() {
  const magasin = new MagasinMemoire();
  const server = buildServer({ queue: new FakeQueue(), auth: acces.auth, opsOffre: magasin.deps() });
  return { server, magasin };
}

const BASE = { entreprise: false, utilisateurs: null, conservationJours: null, note: 'essai ramené en Base' };

describe('la route d’exploitation /ops/offre/:tenantId', () => {
  it('🔴 sans la session d’exploitation, ou avec un faux : 401, rien n’est lu ni écrit', async () => {
    const { server, magasin } = monter();
    for (const entetes of [{}, { authorization: 'Bearer pas-une-session' }]) {
      expect((await server.inject({ method: 'GET', url: `/ops/offre/${T1}`, headers: entetes })).statusCode).toBe(401);
      expect((await server.inject({
        method: 'PUT', url: `/ops/offre/${T1}`, headers: { ...entetes, 'content-type': 'application/json' }, payload: BASE,
      })).statusCode).toBe(401);
    }
    expect([magasin.lectures, magasin.ecritures.length, magasin.invalides.length]).toEqual([0, 0, 0]);
    await server.close();
  });

  it('GET rend le réglage et les 10 utilisateurs proposés ; 404 sur un espace inconnu ou mal formé', async () => {
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { entreprise: true, utilisateurs: 25, conservationJours: 180 });
    const res = await server.inject({ method: 'GET', url: `/ops/offre/${T1}`, headers: ops });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: T1, entreprise: true, utilisateurs: 25, conservationJours: 180, utilisateursProposes: 10 });
    expect((await server.inject({ method: 'GET', url: `/ops/offre/${INCONNU}`, headers: ops })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/ops/offre/pas-un-uuid', headers: ops })).statusCode).toBe(404);
    await server.close();
  });

  it('🔴 PUT exige une NOTE et trois valeurs valides : sinon 400, et rien n’est écrit ni invalidé', async () => {
    const { server, magasin } = monter();
    const invalides: unknown[] = [
      { ...BASE, note: '  ' },
      { ...BASE, entreprise: 'oui' },
      { ...BASE, utilisateurs: 0 },
      { ...BASE, utilisateurs: 2.5 },
      { ...BASE, conservationJours: -1 },
      { ...BASE, conservationJours: 3651 },
      { ...BASE, inconnu: true },
    ];
    for (const payload of invalides) {
      const res = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: payload as object });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect([magasin.ecritures.length, magasin.invalides.length]).toEqual([0, 0]);
    await server.close();
  });

  it('🔴 PUT écrit, VIDE le cache de l’offre, et JOURNALISE le geste avec sa note, son auteur et l’état d’avant', async () => {
    const { server, magasin } = monter();
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: BASE,
    }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: T1, entreprise: false, utilisateurs: null, conservationJours: null, utilisateursProposes: 10 });
    expect(magasin.ecritures).toEqual([{ tenantId: T1, reglage: { entreprise: false, utilisateurs: null, conservationJours: null } }]);
    expect(magasin.invalides).toEqual([T1]);
    const traces = lignes.filter((l) => l.msg === 'ops_offre');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      lvl: 'warn', tenantId: T1, note: 'essai ramené en Base', par: ADRESSE_OPS,
      avant: { entreprise: true, utilisateurs: null, conservationJours: null },
      apres: { entreprise: false, utilisateurs: null, conservationJours: null },
    });
    await server.close();
  });

  it('🔴 PUT SANS conservation la laisse telle quelle : changer d’offre ne déclenche jamais une purge', async () => {
    // Relecture finale du lot 6 : la conservation était requise et réécrite à chaque changement d'offre. Ramener un
    // espace en Base avec 30 jours lançait au balayage suivant la purge irréversible de ses conversations plus anciennes.
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { entreprise: true, utilisateurs: null, conservationJours: 0 });
    const res = await server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: false, utilisateurs: null, note: 'essai ramené en Base' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ entreprise: false, conservationJours: 0 });
    expect(magasin.ecritures).toEqual([{ tenantId: T1, reglage: { entreprise: false, utilisateurs: null } }]);
    expect(magasin.reglages.get(T1)).toEqual({ entreprise: false, utilisateurs: null, conservationJours: 0 });
    await server.close();
  });

  it('PUT pose l’Entreprise avec sa limite d’utilisateurs et sa conservation', async () => {
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { entreprise: false, utilisateurs: null, conservationJours: null });
    const res = await server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops,
      payload: { entreprise: true, utilisateurs: 10, conservationJours: 365, note: 'devis signé' },
    });
    expect(res.statusCode).toBe(200);
    expect(magasin.reglages.get(T1)).toEqual({ entreprise: true, utilisateurs: 10, conservationJours: 365 });
    await server.close();
  });

  it('PUT sur un espace inconnu : 404, rien d’écrit, d’invalidé ni de journalisé', async () => {
    const { server, magasin } = monter();
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({
      method: 'PUT', url: `/ops/offre/${INCONNU}`, headers: ops, payload: BASE,
    }));
    expect(res.statusCode).toBe(404);
    expect([magasin.ecritures.length, magasin.invalides.length]).toEqual([0, 0]);
    expect(lignes.filter((l) => l.msg === 'ops_offre')).toEqual([]);
    await server.close();
  });

  it('⚠️ sans dépendance câblée, la route n’existe pas', async () => {
    const server = buildServer({ queue: new FakeQueue(), auth: acces.auth });
    expect((await server.inject({ method: 'GET', url: `/ops/offre/${T1}`, headers: ops })).statusCode).toBe(404);
    await server.close();
  });
});

describe('l’offre posée par l’exploitation, au journal des actions de l’espace (lot 5)', () => {
  it('🔴 l’exploitant pour acteur, l’espace pour cible, avant et après, jamais la note', async () => {
    const { server, magasin } = monter();
    const res = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { ...BASE, conservationJours: 365 } });
    expect(res.statusCode).toBe(200);
    expect(magasin.audits).toEqual([{
      tenant: T1, acteur: { userId: null, email: ADRESSE_OPS }, action: 'ops.offre_posee', cible: { kind: 'tenant', id: T1 },
      detail: {
        entreprise: false, utilisateurs: null, conservationJours: 365,
        entrepriseAvant: true, utilisateursAvant: null, conservationJoursAvant: null,
      },
    }]);
    expect(JSON.stringify(magasin.audits)).not.toContain(BASE.note);
    await server.close();
  });
});
