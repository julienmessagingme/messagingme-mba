import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { SalesforceRouteDeps } from '../src/http/salesforce';
import type { IssueConnexion } from '../src/salesforce/connexion';
import type { VueOrgSalesforce } from '../src/salesforce/store.pg';

/**
 * LES ROUTES DE PARAMÈTRES > INTÉGRATIONS > SALESFORCE (plan 2026-09-26, lot L1), montées par le REGISTRE (c'est lui
 * qui pose l'étape d'espace sur chaque route `:tenantId`) : admin seulement, aucun refus en 5xx ni en 401, le
 * secret jamais rendu, l'extinction refusée tant qu'une org est reliée.
 */
const SECRET = 'test-secret';
let admin = '';
let agent = '';
let autreEspace = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  autreEspace = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const en = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });
const URL_T1 = '/tenants/t1/integrations/salesforce';
const CIBLE = { kind: 'integration', id: 'salesforce' };
const ORG: VueOrgSalesforce = {
  orgId: '00DQL00000ch3nx2AA', myDomain: 'https://acme.my.salesforce.com', sandbox: false, etat: 'connectee', motifCoupure: null,
  utilisateurIntegration: '005QL00000abcdeYAB', versionPackage: '0.1', quota: null, consentementLead: null, consentementContact: null,
  envoyerResume: false, proprietaireRepli: null, connecteeLe: '2026-09-27T10:00:00.000Z', majLe: '2026-09-27T10:00:00.000Z',
};

function monter(o: { org?: VueOrgSalesforce | null; actif?: boolean; issue?: IssueConnexion; cleAppPosee?: boolean; chiffrementPret?: boolean } = {}) {
  const trace = {
    actif: [] as boolean[],
    connexions: [] as Array<{ tenant: string; adresse: string; auteur: string | null }>,
    deconnexions: [] as string[],
    reglages: [] as unknown[],
    audit: [] as Array<{ action: string; cible: unknown; detail: unknown }>,
  };
  let org = o.org === undefined ? null : o.org;
  let actif = o.actif ?? true;
  const deps: SalesforceRouteDeps = {
    orgs: {
      lire: async () => org,
      enregistrerReglages: async (_t, r) => { trace.reglages.push(r); return org !== null; },
    },
    reglages: {
      salesforceActif: async () => actif,
      setSalesforceActif: async (_t, a) => { trace.actif.push(a); actif = a; },
    },
    connecter: async (tenant, adresse, auteur) => { trace.connexions.push({ tenant, adresse, auteur }); return o.issue ?? { ok: true, orgId: ORG.orgId, sandbox: false }; },
    deconnecter: async (tenant) => { trace.deconnexions.push(tenant); if (!org) return { ok: false, raison: 'aucune_org' }; org = null; return { ok: true, effaceDansOrg: true }; },
    cleAppPosee: o.cleAppPosee ?? true,
    chiffrementPret: o.chiffrementPret ?? true,
    liensInstallation: null,
    audit: async (_t, _acteur, action, cible, detail) => { trace.audit.push({ action, cible, detail }); },
  };
  const app = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, salesforce: deps });
  return { app, trace };
}

describe('la lecture', () => {
  it('rend l interrupteur, la configuration de l instance et l org, jamais un secret', async () => {
    const { app } = monter({ org: ORG });
    const r = await app.inject({ method: 'GET', url: URL_T1, ...en(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ actif: true, cleAppPosee: true, chiffrementPret: true, liensInstallation: null, org: ORG });
    expect(JSON.stringify(r.json())).not.toMatch(/secret/i);
  });

  it('🔴 un agent est refusé, lecture comprise', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'GET', url: URL_T1, ...en(agent) })).statusCode).toBe(403);
  });

  it('🔴 l espace d un autre client est refusé', async () => {
    const { app, trace } = monter();
    const r = await app.inject({ method: 'POST', url: `${URL_T1}/connexion`, ...en(autreEspace), payload: { adresse: 'https://acme.my.salesforce.com' } });
    expect(r.statusCode).toBe(403);
    expect(trace.connexions).toEqual([]);
  });
});

describe('l interrupteur', () => {
  it('allume, et le journal nomme l outil', async () => {
    const { app, trace } = monter({ actif: false });
    const r = await app.inject({ method: 'PATCH', url: `${URL_T1}/actif`, ...en(admin), payload: { actif: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ salesforceActif: true });
    expect(trace.audit).toEqual([{ action: 'salesforce.allumee', cible: CIBLE, detail: {} }]);
  });

  it('🔴 refuse d éteindre tant qu une org est reliée (409), sans rien écrire', async () => {
    const { app, trace } = monter({ org: ORG });
    const r = await app.inject({ method: 'PATCH', url: `${URL_T1}/actif`, ...en(admin), payload: { actif: false } });
    expect(r.statusCode).toBe(409);
    expect(trace.actif).toEqual([]);
  });

  it('un corps hors contrat est refusé (booléen strict, clé inconnue)', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'PATCH', url: `${URL_T1}/actif`, ...en(admin), payload: { actif: 'oui' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `${URL_T1}/actif`, ...en(admin), payload: { actif: true, autre: 1 } })).statusCode).toBe(400);
  });
});

describe('la connexion', () => {
  const connecter = (app: ReturnType<typeof monter>['app'], adresse = 'https://acme.my.salesforce.com') =>
    app.inject({ method: 'POST', url: `${URL_T1}/connexion`, ...en(admin), payload: { adresse } });

  it('relie l org, avec l auteur, et journalise sans secret', async () => {
    const { app, trace } = monter();
    const r = await connecter(app);
    expect(r.statusCode).toBe(200);
    expect(trace.connexions).toEqual([{ tenant: 't1', adresse: 'https://acme.my.salesforce.com', auteur: 'u1' }]);
    expect(trace.audit).toEqual([{ action: 'salesforce.connectee', cible: CIBLE, detail: { orgId: ORG.orgId, sandbox: false } }]);
  });

  it('🔴 un manque sort en 422 avec les étapes du guide, JAMAIS en 401 ni en 5xx', async () => {
    const { app } = monter({ issue: { ok: false, manques: [{ etape: 'run-as', message: 'désignez l utilisateur' }] } });
    const r = await connecter(app);
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: 'désignez l utilisateur', manques: [{ etape: 'run-as', message: 'désignez l utilisateur' }] });
  });

  it('🔴 une panne passagère de Salesforce sort aussi en 422, marquée passagère', async () => {
    const { app } = monter({ issue: { ok: false, passager: true, message: 'réessayez' } });
    const r = await connecter(app);
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: 'réessayez', passager: true });
  });

  it('refuse sans clé d app ni chiffrement (503 lisible), et quand l interrupteur est éteint (409), sans appeler Salesforce', async () => {
    for (const [o, code] of [[{ cleAppPosee: false }, 503], [{ chiffrementPret: false }, 503], [{ actif: false }, 409]] as const) {
      const { app, trace } = monter(o);
      expect((await connecter(app)).statusCode).toBe(code);
      expect(trace.connexions).toEqual([]);
    }
  });

  it('un corps hors contrat est refusé avant tout appel', async () => {
    const { app, trace } = monter();
    expect((await app.inject({ method: 'POST', url: `${URL_T1}/connexion`, ...en(admin), payload: { adresse: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${URL_T1}/connexion`, ...en(admin), payload: { adresse: 'x', secret: 'y' } })).statusCode).toBe(400);
    expect(trace.connexions).toEqual([]);
  });
});

describe('les réglages et la déconnexion', () => {
  const reglages = { consentementLead: { champ: 'WhatsApp_OK__c', valeurOui: null, valeurNon: null }, consentementContact: null, envoyerResume: true, proprietaireRepli: null };

  it('enregistre les réglages d une org reliée, et refuse sans org (404)', async () => {
    const avec = monter({ org: ORG });
    expect((await avec.app.inject({ method: 'PUT', url: `${URL_T1}/reglages`, ...en(admin), payload: reglages })).statusCode).toBe(200);
    expect(avec.trace.audit[0]).toMatchObject({ action: 'salesforce.modifiee', detail: { consentementLead: 'WhatsApp_OK__c', envoyerResume: true } });
    const sans = monter();
    expect((await sans.app.inject({ method: 'PUT', url: `${URL_T1}/reglages`, ...en(admin), payload: reglages })).statusCode).toBe(404);
  });

  it('refuse un propriétaire de repli qui n est pas un identifiant Salesforce d utilisateur ou de file', async () => {
    const { app } = monter({ org: ORG });
    expect((await app.inject({ method: 'PUT', url: `${URL_T1}/reglages`, ...en(admin), payload: { ...reglages, proprietaireRepli: 'robert' } })).statusCode).toBe(400);
  });

  it('déconnecte, et dit si le secret a pu être effacé dans l org', async () => {
    const { app, trace } = monter({ org: ORG });
    const r = await app.inject({ method: 'DELETE', url: URL_T1, ...en(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ effaceDansOrg: true });
    expect(trace.audit).toEqual([{ action: 'salesforce.deconnectee', cible: CIBLE, detail: { effaceDansOrg: true } }]);
  });

  it('sans org reliée, la déconnexion rend 404', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'DELETE', url: URL_T1, ...en(admin) })).statusCode).toBe(404);
  });
});
