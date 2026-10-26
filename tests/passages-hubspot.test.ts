import { describe, it, expect } from 'vitest';
import { balayerPassages, occasionRelance, type PassagesHubspot, type PassageAClore, type RelanceDue } from '../src/analysis/passages-hubspot';
import { cloreHandoff, HubspotServiceError } from '../src/crm/hubspot-service';
import { signRequest } from '../src/lib/signature';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import type { IssueCloture } from '../src/crm/hubspot-service';

/**
 * LE BALAYAGE `hubspot-clotures` (lot 2b de la reprise humaine) : clore ce qui l'est chez le connecteur, puis enfiler les
 * relances dues. Ses requêtes SQL sont éprouvées par `tests/integration/passages-hubspot.integration.test.ts` (CI).
 */

function magasin(aClore: PassageAClore[] = [], dues: RelanceDue[] = [], dejaInscrites: string[] = []) {
  const clos: string[] = [];
  const inscrites: string[] = [];
  const oubliees: string[] = [];
  const reportes: string[] = [];
  let relancesLues = 0;
  const store: PassagesHubspot = {
    inscrire: async (p) => { if (dejaInscrites.includes(p.occasion)) return false; inscrites.push(p.occasion); return true; },
    clore: async (o) => { clos.push(o); },
    oublier: async (o) => { oubliees.push(o); },
    reporter: async (o) => { reportes.push(o); },
    aClore: async () => aClore,
    relancesDues: async () => { relancesLues += 1; return dues; },
  };
  return { store, clos, inscrites, oubliees, reportes, relancesLues: () => relancesLues };
}

const P = (n: number): PassageAClore => ({ occasion: `conv-${n}:x`, tenantId: 't1', conversationId: `conv-${n}` });
const DEPUIS = new Date('2026-10-26T12:00:00.000Z');

describe('balayerPassages', () => {
  it('🔴 clos ou sans objet chez le connecteur : le passage se clôt ; refusé ou en panne : il reste ouvert, le tour continue', async () => {
    const m = magasin([P(1), P(2), P(3), P(4)]);
    const issues: Record<string, IssueCloture | 'leve'> = { 'conv-1:x': 'clos', 'conv-2:x': 'sans_objet', 'conv-3:x': { refuse: 409, code: 'reconsent_required' }, 'conv-4:x': 'leve' };
    const n = await balayerPassages({
      passages: m.store,
      clore: async (c) => { const i = issues[c.occasion]!; if (i === 'leve') throw new Error('503'); return i; },
      enfilerRelance: async () => {},
      relanceMinutes: 10,
    });
    expect(m.clos).toEqual(['conv-1:x', 'conv-2:x']);
    // Refusé ou en panne : reporté d'une heure, pour ne pas occuper la tête de file des autres espaces.
    expect(m.reportes).toEqual(['conv-3:x', 'conv-4:x']);
    expect(n).toBe(2);
  });

  it('🔴 une relance due s’inscrit PUIS s’enfile avec son occasion ; déjà inscrite, elle ne part pas une seconde fois', async () => {
    const due: RelanceDue = { tenantId: 't1', waId: '33600000001', conversationId: 'conv-9', depuis: DEPUIS };
    const deja: RelanceDue = { ...due, conversationId: 'conv-8' };
    const m = magasin([], [due, deja], [occasionRelance('conv-8', DEPUIS)]);
    const enfiles: unknown[] = [];
    await balayerPassages({ passages: m.store, clore: async () => 'clos', enfilerRelance: async (j) => { enfiles.push(j); }, relanceMinutes: 10 });
    expect(m.inscrites).toEqual(['conv-9:relance:2026-10-26T12:00:00.000Z']);
    expect(enfiles).toEqual([{ tenantId: 't1', waId: '33600000001', relance: { occasion: 'conv-9:relance:2026-10-26T12:00:00.000Z' } }]);
  });

  it('un enfilement raté oublie l’inscription (le tour suivant la retente) ; 0 minute éteint la relance', async () => {
    const due: RelanceDue = { tenantId: 't1', waId: 'w', conversationId: 'conv-9', depuis: DEPUIS };
    const m = magasin([], [due]);
    await balayerPassages({ passages: m.store, clore: async () => 'clos', enfilerRelance: async () => { throw new Error('pg-boss'); }, relanceMinutes: 10 });
    expect(m.oubliees).toEqual([occasionRelance('conv-9', DEPUIS)]);
    const eteinte = magasin([], [due]);
    await balayerPassages({ passages: eteinte.store, clore: async () => 'clos', enfilerRelance: async () => {}, relanceMinutes: 0 });
    expect(eteinte.relancesLues()).toBe(0);
  });
});

describe('cloreHandoff : le client de POST /service/handoff-clos', () => {
  const SECRET = 'svc-secret';
  const corps = { tenantId: 't1', occasion: 'conv-1:2026-10-23T09:15:30.123Z' };
  class FauxTransport implements HttpTransport {
    readonly posts: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    constructor(private readonly reponse: HttpResponse) {}
    async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
      this.posts.push({ url, body, headers });
      return this.reponse;
    }
  }
  const connecteur = (t: HttpTransport) => ({ baseUrl: 'http://connector', secret: SECRET, transport: t });

  it('🔴 poste le corps signé (format v1, chemin /service/handoff-clos) ; 2xx = clos', async () => {
    const t = new FauxTransport({ status: 200, json: { clos: true } });
    expect(await cloreHandoff(connecteur(t), corps)).toBe('clos');
    expect(t.posts[0]!.url).toBe('http://connector/service/handoff-clos');
    expect(t.posts[0]!.body).toEqual(corps);
    const entete = t.posts[0]!.headers['x-mm-service-signature'] ?? '';
    const m = /^v1=(\d+)\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(entete);
    expect(m).not.toBeNull();
    expect(entete).toBe(signRequest(SECRET, { ts: Number(m![1]), nonce: m![2]!, method: 'POST', path: '/service/handoff-clos', body: JSON.stringify(corps) }));
  });

  it('404 occasion inconnue ou espace sans portail : sans objet ; un autre 404 (route absente) : refusé, le passage reste ouvert', async () => {
    const avec = (json: unknown) => cloreHandoff(connecteur(new FauxTransport({ status: 404, json })), corps);
    expect(await avec({ error: 'occasion_inconnue' })).toBe('sans_objet');
    expect(await avec({ error: 'tenant_not_connected' })).toBe('sans_objet');
    expect(await avec({})).toEqual({ refuse: 404, code: undefined });
  });

  it('une panne (5xx) lève : le balayage la journalise et réessaie au tour suivant', async () => {
    await expect(cloreHandoff(connecteur(new FauxTransport({ status: 503, json: {} })), corps)).rejects.toBeInstanceOf(HubspotServiceError);
  });
});
