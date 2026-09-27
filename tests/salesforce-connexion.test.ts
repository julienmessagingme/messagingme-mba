import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { connecter, deconnecter, versionAuMoins, ETAPES_GUIDE, type DepsConnexion } from '../src/salesforce/connexion';
import { SalesforceApiError, type ClientSalesforce, type MethodeHttp } from '../src/salesforce/client';
import type { DebutConnexion, IssueDebutConnexion, VueOrgSalesforce } from '../src/salesforce/store.pg';

/**
 * LA CONNEXION D'UNE ORG, contre un faux client et un faux store : l'ORDRE des écritures, et chaque manque
 * rendu avec son étape du guide.
 */
const ORIGINE = 'https://acme.my.salesforce.com';
const ORG = '00DQL00000ch3nx2AA';
const TENANT = '11111111-1111-4111-8111-111111111111';

type Reponse = { statut: number; donnees: unknown } | SalesforceApiError;

function monter(o: {
  reponses?: Partial<Record<string, Reponse>>;
  jeton?: SalesforceApiError;
  debut?: IssueDebutConnexion;
  resolution?: { ok: boolean; raison?: string };
  org?: VueOrgSalesforce | null;
} = {}) {
  const journal: string[] = [];
  const reponses: Record<string, Reponse> = {
    'GET organization': { statut: 200, donnees: { records: [{ Id: ORG, IsSandbox: false, OrganizationType: 'Enterprise Edition' }] } },
    'GET etat': { statut: 200, donnees: { version: '0.1', manques: [] } },
    'PUT secret': { statut: 204, donnees: null },
    'DELETE secret': { statut: 204, donnees: null },
    ...o.reponses,
  } as Record<string, Reponse>;
  const cle = (methode: MethodeHttp, chemin: string): string =>
    `${methode} ${chemin.includes('Organization') ? 'organization' : chemin.endsWith('/etat') ? 'etat' : 'secret'}`;
  let secretPose: unknown = null;
  const client: ClientSalesforce = {
    async jeton() {
      journal.push('jeton');
      if (o.jeton) throw o.jeton;
      return { accessToken: 'j', origine: ORIGINE, orgId: ORG, userId: '005QL00000abcdeYAB' };
    },
    oublierJeton() { journal.push('oublierJeton'); },
    async requete<T>(_origine: string, methode: MethodeHttp, chemin: string, _schema: z.ZodType<T>, corps?: unknown) {
      const k = cle(methode, chemin);
      journal.push(k);
      if (k === 'PUT secret') secretPose = (corps as { secret: string }).secret;
      const r = reponses[k];
      if (r instanceof SalesforceApiError) throw r;
      return r as { statut: number; donnees: T | null };
    },
  };
  let debutRecu: DebutConnexion | null = null;
  const deps: DepsConnexion = {
    client,
    verifierResolution: async () => o.resolution ?? { ok: true },
    genererSecret: () => 'secret-tire',
    store: {
      async commencerConnexion(_t, d) { journal.push('store:commencer'); debutRecu = d; return o.debut ?? 'ok'; },
      async confirmerConnexion() { journal.push('store:confirmer'); return true; },
      async supprimer() { journal.push('store:supprimer'); return true; },
      async lire() { return o.org === undefined ? null : o.org; },
    },
  };
  return { deps, journal, secretPose: () => secretPose, debut: () => debutRecu };
}

const refus = (status: number, errorCode: string | null = null) => new SalesforceApiError('refus', status, false, 'refus', errorCode);

describe('connecter', () => {
  it('🔴 dans l ordre : jeton, org, package, secret CHEZ NOUS, secret DANS L ORG, puis connectée', async () => {
    const m = monter();
    const r = await connecter(m.deps, TENANT, ORIGINE, 'auteur');
    expect(r).toEqual({ ok: true, orgId: ORG, sandbox: false });
    expect(m.journal).toEqual(['jeton', 'GET organization', 'GET etat', 'store:commencer', 'PUT secret', 'store:confirmer']);
    // Le secret posé dans l'org est celui qu'on a écrit chez nous.
    expect(m.secretPose()).toBe('secret-tire');
    expect(m.debut()).toMatchObject({ orgId: ORG, myDomain: ORIGINE, secretClair: 'secret-tire', versionPackage: '0.1', connecteePar: 'auteur' });
  });

  it('🔴 si la pose du secret dans l org échoue, la connexion n est JAMAIS confirmée', async () => {
    const m = monter({ reponses: { 'PUT secret': new SalesforceApiError('injoignable', null, true, 'panne') } });
    const r = await connecter(m.deps, TENANT, ORIGINE, null);
    expect(r.ok).toBe(false);
    expect(m.journal).toContain('store:commencer');
    expect(m.journal).not.toContain('store:confirmer');
  });

  it('une adresse illisible est un manque « adresse », sans aucun appel', async () => {
    const m = monter();
    const r = await connecter(m.deps, TENANT, 'https://login.salesforce.com', null);
    expect(r).toMatchObject({ ok: false, manques: [{ etape: 'adresse' }] });
    expect(m.journal).toEqual([]);
  });

  it('une adresse qui résout vers l intérieur est refusée avant le jeton', async () => {
    const m = monter({ resolution: { ok: false, raison: 'adresse interne' } });
    expect(await connecter(m.deps, TENANT, ORIGINE, null)).toMatchObject({ ok: false, manques: [{ etape: 'adresse' }] });
    expect(m.journal).toEqual([]);
  });

  it('un jeton refusé renvoie à l étape « run-as » du guide', async () => {
    const m = monter({ jeton: new SalesforceApiError('jeton_refuse', 400, false, 'refus', 'invalid_client') });
    expect(await connecter(m.deps, TENANT, ORIGINE, null)).toMatchObject({ ok: false, manques: [{ etape: 'run-as' }] });
  });

  it('un package absent (404) ou trop ancien renvoie à l étape « package »', async () => {
    expect(await connecter(monter({ reponses: { 'GET etat': refus(404, 'NOT_FOUND') } }).deps, TENANT, ORIGINE, null))
      .toMatchObject({ ok: false, manques: [{ etape: 'package' }] });
    expect(await connecter(monter({ reponses: { 'GET etat': { statut: 200, donnees: { version: '0.0.9', manques: [] } } } }).deps, TENANT, ORIGINE, null))
      .toMatchObject({ ok: false, manques: [{ etape: 'package' }] });
  });

  it('des droits manquants (dits par le package, ou un 403) renvoient à l étape « droits », sans écrire', async () => {
    const m = monter({ reponses: { 'GET etat': { statut: 200, donnees: { version: '0.1', manques: ['Lead.MobilePhone'] } } } });
    const r = await connecter(m.deps, TENANT, ORIGINE, null);
    expect(r).toMatchObject({ ok: false, manques: [{ etape: 'droits' }] });
    if (!r.ok && 'manques' in r) expect(r.manques[0]!.message).toContain('Lead.MobilePhone');
    expect(m.journal).not.toContain('store:commencer');
    expect(await connecter(monter({ reponses: { 'GET etat': refus(403) } }).deps, TENANT, ORIGINE, null))
      .toMatchObject({ ok: false, manques: [{ etape: 'droits' }] });
  });

  it('une org déjà reliée ailleurs, ou un espace relié à une autre org : étape « org », rien de posé', async () => {
    for (const debut of ['org_ailleurs', 'autre_org'] as const) {
      const m = monter({ debut });
      expect(await connecter(m.deps, TENANT, ORIGINE, null)).toMatchObject({ ok: false, manques: [{ etape: 'org' }] });
      expect(m.journal).not.toContain('PUT secret');
    }
  });

  it('un quota épuisé ou une panne sont PASSAGERS, jamais un manque', async () => {
    expect(await connecter(monter({ jeton: new SalesforceApiError('quota_epuise', 403, false, 'q', 'REQUEST_LIMIT_EXCEEDED') }).deps, TENANT, ORIGINE, null))
      .toMatchObject({ ok: false, passager: true });
    expect(await connecter(monter({ reponses: { 'GET organization': new SalesforceApiError('injoignable', null, true, 'x') } }).deps, TENANT, ORIGINE, null))
      .toMatchObject({ ok: false, passager: true });
  });

  it('chaque étape rendue appartient au guide (les ancres de la page tuto)', () => {
    expect(ETAPES_GUIDE).toEqual(['adresse', 'package', 'utilisateur', 'run-as', 'droits', 'org']);
  });
});

describe('deconnecter', () => {
  const org = { myDomain: ORIGINE } as VueOrgSalesforce;

  it('efface le secret dans l org, oublie le jeton, puis supprime la ligne', async () => {
    const m = monter({ org });
    expect(await deconnecter(m.deps, TENANT)).toEqual({ ok: true, effaceDansOrg: true });
    expect(m.journal).toEqual(['DELETE secret', 'oublierJeton', 'store:supprimer']);
  });

  it('🔴 une org injoignable n empêche pas d oublier chez nous, et on le dit', async () => {
    const m = monter({ org, reponses: { 'DELETE secret': new SalesforceApiError('jeton_refuse', 401, false, 'x') } });
    expect(await deconnecter(m.deps, TENANT)).toEqual({ ok: true, effaceDansOrg: false });
    expect(m.journal).toContain('store:supprimer');
  });

  it('sans org reliée : aucune_org', async () => {
    expect(await deconnecter(monter().deps, TENANT)).toEqual({ ok: false, raison: 'aucune_org' });
  });
});

describe('versionAuMoins', () => {
  it('compare des nombres, pas du texte', () => {
    expect(versionAuMoins('0.10', '0.9')).toBe(true);
    expect(versionAuMoins('0.1', '0.1')).toBe(true);
    expect(versionAuMoins('0.1.1', '0.1')).toBe(true);
    expect(versionAuMoins('0.0.9', '0.1')).toBe(false);
    expect(versionAuMoins('1', '0.9')).toBe(true);
  });
});
