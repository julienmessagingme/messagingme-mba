import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { accesOps, ADRESSE_OPS } from './acces-ops';
import { FakeQueue } from './fake-queue';
import { capturerJournal } from './journal';
import type { OpsOffreDeps } from '../src/http/ops-offre';
import type { AlertesOffreManuelle, EcritureEntreprise, ReglageEntreprise } from '../src/offres/offre.pg';
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

/** Aucun abonnement Stripe, aucun numéro fourni : rien à signaler à l'exploitant. */
const SANS_ALERTE: AlertesOffreManuelle = { proPayeVivant: false, numeroSeulVivant: false, numeroFourniSansCouverture: false };
/** Les champs du Business (spec du 2026-10-27) d'un espace qui ne l'a jamais eu. */
const SANS_BUSINESS = { business: false, utilisateursBusiness: null } as const;

class MagasinMemoire {
  lectures = 0;
  alertes: AlertesOffreManuelle = SANS_ALERTE;
  /** Les gestes qui suivent la pose ou le retrait, dans l'ordre (spec Business). */
  readonly gestesJoues: string[] = [];
  finiLe: Date | null = null;
  complement = 9_000_000;
  echec: 'passage' | 'credit' | 'fin' | null = null;
  readonly ecritures: Array<{ tenantId: string; reglage: EcritureEntreprise }> = [];
  readonly invalides: string[] = [];
  readonly audits: Array<{ tenant: string; acteur: { userId: string | null; email: string | null }; action: string; cible: { kind: string; id: string }; detail: Record<string, unknown> | undefined }> = [];
  readonly reglages = new Map<string, ReglageEntreprise>([[T1, { ...SANS_BUSINESS, ...ENTREPRISE }]]);
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
          this.reglages.set(t, {
            entreprise: r.entreprise, utilisateurs: r.utilisateurs,
            conservationJours: r.conservationJours === undefined ? avant.conservationJours : r.conservationJours,
            contacts: r.contacts === undefined ? avant.contacts : r.contacts,
            commissionPct: r.commissionPct === undefined ? avant.commissionPct : r.commissionPct,
            // Une seule offre posée à la main : l'Entreprise fait tomber le Business (`PgOffresStore.ecrireEntreprise`).
            business: r.entreprise ? false : r.business === undefined ? avant.business : r.business,
            utilisateursBusiness: r.utilisateursBusiness === undefined ? avant.utilisateursBusiness : r.utilisateursBusiness,
          });
          return true;
        },
        alertes: async () => this.alertes,
      },
      invalider: (t) => { this.invalides.push(t); },
      gestes: {
        passageBusiness: async (t) => { this.gestesJoues.push(`passage:${t}`); if (this.echec === 'passage') throw new Error('base indisponible'); },
        completerCredit: async (t) => {
          this.gestesJoues.push(`credit:${t}`);
          if (this.echec === 'credit') throw new Error('base indisponible');
          return this.complement;
        },
        finOffreManuelle: async (t, finiLe) => {
          this.gestesJoues.push(`fin:${t}`);
          this.finiLe = finiLe;
          if (this.echec === 'fin') throw new Error('base indisponible');
          return 'porte';
        },
      },
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
const ENTREPRISE = { entreprise: true, utilisateurs: null, conservationJours: null, contacts: null, commissionPct: null };

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
    magasin.reglages.set(T1, { ...SANS_BUSINESS, entreprise: true, utilisateurs: 25, conservationJours: 180, contacts: null, commissionPct: null });
    const res = await server.inject({ method: 'GET', url: `/ops/offre/${T1}`, headers: ops });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tenantId: T1, entreprise: true, utilisateurs: 25, conservationJours: 180, contacts: null, commissionPct: null, ...SANS_BUSINESS,
      alertes: SANS_ALERTE, utilisateursProposes: 10,
    });
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
    expect(res.json()).toEqual({
      tenantId: T1, entreprise: false, utilisateurs: null, conservationJours: null, contacts: null, commissionPct: null, ...SANS_BUSINESS,
      alertes: SANS_ALERTE, gestes: { creditOffert: null, finDuNumero: 'porte', echecs: [] }, utilisateursProposes: 10,
    });
    // Quitter l'Entreprise sans autre offre : le numéro fourni que plus rien ne couvre suit le chemin d'un impayé (spec Business).
    expect(magasin.gestesJoues).toEqual([`fin:${T1}`]);
    expect(magasin.ecritures).toEqual([{ tenantId: T1, reglage: { entreprise: false, utilisateurs: null, conservationJours: null } }]);
    expect(magasin.invalides).toEqual([T1]);
    const traces = lignes.filter((l) => l.msg === 'ops_offre');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      lvl: 'warn', tenantId: T1, note: 'essai ramené en Base', par: ADRESSE_OPS,
      avant: { entreprise: true, utilisateurs: null, conservationJours: null, contacts: null, commissionPct: null },
      apres: { entreprise: false, utilisateurs: null, conservationJours: null, contacts: null, commissionPct: null },
    });
    await server.close();
  });

  it('🔴 PUT SANS conservation la laisse telle quelle : changer d’offre ne déclenche jamais une purge', async () => {
    // Relecture finale du lot 6 : la conservation était requise et réécrite à chaque changement d'offre. Ramener un
    // espace en Base avec 30 jours lançait au balayage suivant la purge irréversible de ses conversations plus anciennes.
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { ...SANS_BUSINESS, entreprise: true, utilisateurs: null, conservationJours: 0, contacts: null, commissionPct: null });
    const res = await server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: false, utilisateurs: null, note: 'essai ramené en Base' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ entreprise: false, conservationJours: 0, contacts: null, commissionPct: null });
    expect(magasin.ecritures).toEqual([{ tenantId: T1, reglage: { entreprise: false, utilisateurs: null } }]);
    expect(magasin.reglages.get(T1)).toEqual({ ...SANS_BUSINESS, entreprise: false, utilisateurs: null, conservationJours: 0, contacts: null, commissionPct: null });
    await server.close();
  });

  it('PUT pose l’Entreprise avec sa limite d’utilisateurs et sa conservation', async () => {
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { ...SANS_BUSINESS, entreprise: false, utilisateurs: null, conservationJours: null, contacts: null, commissionPct: null });
    const res = await server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops,
      payload: { entreprise: true, utilisateurs: 10, conservationJours: 365, note: 'devis signé' },
    });
    expect(res.statusCode).toBe(200);
    expect(magasin.reglages.get(T1)).toEqual({ ...SANS_BUSINESS, entreprise: true, utilisateurs: 10, conservationJours: 365, contacts: null, commissionPct: null });
    await server.close();
  });

  it('PUT règle les contacts et la commission d’une Entreprise ; absents, ils restent tels quels (spec offres v2)', async () => {
    const { server, magasin } = monter();
    const pose = await server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops,
      payload: { entreprise: true, utilisateurs: null, contacts: 20000, commissionPct: 7, note: 'devis signé' },
    });
    expect(pose.statusCode).toBe(200);
    expect(pose.json()).toMatchObject({ contacts: 20000, commissionPct: 7 });
    const garde = await server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: true, utilisateurs: 12, note: 'trois de plus' },
    });
    expect(garde.statusCode).toBe(200);
    expect(magasin.reglages.get(T1)).toMatchObject({ utilisateurs: 12, contacts: 20000, commissionPct: 7 });
    await server.close();
  });

  it('🔴 PUT refuse une commission décimale ou hors de 0 à 100, et des contacts à 0 : 400, rien d’écrit', async () => {
    const { server, magasin } = monter();
    for (const extra of [{ commissionPct: 7.5 }, { commissionPct: -1 }, { commissionPct: 101 }, { contacts: 0 }, { contacts: 2.5 }]) {
      const res = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { ...BASE, ...extra } });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(magasin.ecritures).toEqual([]);
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

  it('🔴 PUT pose le Business : écrit, cache vidé, puis les avis du numéro oubliés et le complément du crédit, dans cet ordre', async () => {
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { ...SANS_BUSINESS, ...ENTREPRISE, entreprise: false });
    const res = await server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops,
      payload: { entreprise: false, utilisateurs: null, business: true, utilisateursBusiness: 6, note: 'Business signé, un utilisateur offert' },
    });
    expect(res.statusCode).toBe(200);
    expect(magasin.ecritures).toEqual([{ tenantId: T1, reglage: { entreprise: false, utilisateurs: null, business: true, utilisateursBusiness: 6 } }]);
    expect(magasin.invalides).toEqual([T1]);
    expect(magasin.gestesJoues).toEqual([`passage:${T1}`, `credit:${T1}`]);
    expect(res.json()).toMatchObject({ business: true, utilisateursBusiness: 6, gestes: { creditOffert: 9_000_000, finDuNumero: null, echecs: [] } });
    // Reposé alors qu'il l'est déjà : aucun geste de passage, rien n'est complété deux fois par la route.
    const encore = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: false, utilisateurs: null, business: true, note: 'rien ne change' } });
    expect(encore.json()).toMatchObject({ gestes: { creditOffert: null, finDuNumero: null, echecs: [] } });
    expect(magasin.gestesJoues).toEqual([`passage:${T1}`, `credit:${T1}`]);
    await server.close();
  });

  it('🔴 PUT retire le Business : la fin du numéro fourni est demandée, à la date du retrait', async () => {
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { ...ENTREPRISE, entreprise: false, business: true, utilisateursBusiness: null });
    const avant = Date.now();
    const res = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: false, utilisateurs: null, business: false, note: 'fin de l’essai' } });
    expect(res.statusCode).toBe(200);
    expect(magasin.gestesJoues).toEqual([`fin:${T1}`]);
    expect(magasin.finiLe!.getTime()).toBeGreaterThanOrEqual(avant);
    expect(res.json()).toMatchObject({ business: false, gestes: { creditOffert: null, finDuNumero: 'porte', echecs: [] } });
    await server.close();
  });

  it('🔴 l’Entreprise et le Business demandés ensemble : 400, rien d’écrit ni de geste', async () => {
    const { server, magasin } = monter();
    const res = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: true, utilisateurs: null, business: true, note: 'les deux' } });
    expect(res.statusCode).toBe(400);
    expect([magasin.ecritures.length, magasin.invalides.length, magasin.gestesJoues.length]).toEqual([0, 0, 0]);
    for (const extra of [{ business: 'oui' }, { utilisateursBusiness: 0 }, { utilisateursBusiness: 2.5 }]) {
      expect((await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { ...BASE, ...extra } })).statusCode, JSON.stringify(extra)).toBe(400);
    }
    await server.close();
  });

  it('PUT pose l’Entreprise sur un Business : le Business tombe, sans geste de fin (l’Entreprise couvre le numéro)', async () => {
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { ...ENTREPRISE, entreprise: false, business: true, utilisateursBusiness: 6 });
    const res = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: true, utilisateurs: 20, note: 'devis Entreprise signé' } });
    expect(res.statusCode).toBe(200);
    expect(magasin.reglages.get(T1)).toMatchObject({ entreprise: true, business: false });
    expect(magasin.gestesJoues).toEqual([]);
    await server.close();
  });

  it('🔴 un geste qui échoue n’annule pas la pose : les suivants jouent, la réponse le dit, le journal aussi', async () => {
    const { server, magasin } = monter();
    magasin.reglages.set(T1, { ...SANS_BUSINESS, ...ENTREPRISE, entreprise: false });
    magasin.echec = 'passage';
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({
      method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: false, utilisateurs: null, business: true, note: 'Business signé' },
    }));
    expect(res.statusCode).toBe(200);
    expect(magasin.reglages.get(T1)).toMatchObject({ business: true });
    expect(magasin.gestesJoues).toEqual([`passage:${T1}`, `credit:${T1}`]);
    expect(res.json()).toMatchObject({ gestes: { creditOffert: 9_000_000, echecs: ['passage'] } });
    expect(lignes.filter((l) => l.msg === 'ops_offre_geste_echoue')).toHaveLength(1);
    await server.close();
  });

  it('GET et PUT rendent les alertes : un Pro payé vivant, un numéro payé à part, un numéro fourni que plus rien ne couvrirait', async () => {
    const { server, magasin } = monter();
    magasin.alertes = { proPayeVivant: true, numeroSeulVivant: true, numeroFourniSansCouverture: false };
    expect((await server.inject({ method: 'GET', url: `/ops/offre/${T1}`, headers: ops })).json()).toMatchObject({ alertes: magasin.alertes });
    const res = await server.inject({ method: 'PUT', url: `/ops/offre/${T1}`, headers: ops, payload: { entreprise: true, utilisateurs: null, note: 'inchangé' } });
    expect(res.json()).toMatchObject({ alertes: magasin.alertes });
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
        entreprise: false, utilisateurs: null, conservationJours: 365, contacts: null, commissionPct: null,
        entrepriseAvant: true, utilisateursAvant: null, conservationJoursAvant: null, contactsAvant: null, commissionPctAvant: null,
        business: false, utilisateursBusiness: null, businessAvant: false, utilisateursBusinessAvant: null,
      },
    }]);
    expect(JSON.stringify(magasin.audits)).not.toContain(BASE.note);
    await server.close();
  });
});
