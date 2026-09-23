import { describe, it, expect, beforeAll } from 'vitest';
import { sansPortailHubspot } from './hubspot';
import { GRILLE_DEFAUT } from '../src/stats/prix';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { StatsRouteDeps } from '../src/http/stats';
import type { AnalyzedConversationsFilter } from '../src/stats/conversation-stats.pg';
import type { SettingsRouteDeps } from '../src/http/settings';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
// De VRAIS uuid : la route des contacts touches refuse desormais un identifiant de campagne mal forme (il
// partait sinon dans un `::uuid[]` et sortait en 500, donc en page Cloudflare cote client).
const CAMP_A = '11111111-1111-4111-8111-111111111111';
const CAMP_B = '22222222-2222-4222-8222-222222222222';
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function app(over: { stats?: Partial<StatsRouteDeps>; settings?: Partial<SettingsRouteDeps> } = {}) {
  const stats: StatsRouteDeps = {
    getDashboard: async () => ({
      contacts: [{ date: '2026-07-09', count: 3 }],
      // ⚠️ PLUS BAS QUE LES CUMULÉS, DÉLIBÉRÉMENT : une fixture où les deux courbes seraient égales ferait
      // passer un écran qui affiche la mauvaise, sans que rien ne bronche.
      contactsActifs: [{ date: '2026-07-09', count: 2 }],
      templates: { utility: [{ date: '2026-07-09', count: 1 }], marketing: [{ date: '2026-07-09', count: 2 }] },
      exchanged: [{ date: '2026-07-09', count: 5 }],
      service: [{ date: '2026-07-09', count: 2 }],
      // Le total retombe sur celui de `service` : c'est l'invariant de la ventilation (cf. store).
      serviceParOrigine: { ia: 1, scenario: 1, humain: 0, indeterminee: 0 },
      // ⚠️ ET LE DÉTAIL RETOMBE SUR LE THÈME : `agent + mba + mcp` vaut `ia`. Une fixture qui s'en écarterait
      // décrirait un état que le store ne peut pas produire, donc ferait passer les tests sur une fiction.
      serviceIaDetail: { agent: 1, mba: 0, mcp: 0 },
    }),
    // La marge de l espace, REQUISE : une fixture qui l oublierait ne compile pas, et c est le but.
    margeTemplate: async () => 100,
    getTemplateBreakdown: async () => [{ name: 'promo', category: 'marketing', count: 4 }],
    getPricing: async () => ({ byCategory: { marketing: { category: 'marketing', cost: 0.5724, volume: 4, ratePerMessage: 0.1431 } }, totalCost: 0.5724, currency: 'EUR' }),
    getCampaignFunnel: async () => ({ sent: 10, delivered: 8, read: 5, replied: 3, failed: 1, sansAccuse: 0, buttonReplies: 2, urlClicks: 4, contactsVises: 10, parCanal: [] }),
    getErrorBreakdown: async () => [
      { code: 131049, count: 4, templateName: 'promo', campaignId: CAMP_A, campaignName: 'Promo ete' },
      { code: 131047, count: 2, templateName: null, campaignId: CAMP_B, campaignName: 'Relance' },
    ],
    getErrorContacts: async () => [
      { recipientId: 'r1', campaignId: CAMP_A, campaignName: 'Promo ete', telephone: '+33600000001', contactId: 'ct1', contactNom: 'Julie', code: 131049, message: 'Re-engagement message', origine: 'envoi' as const, at: '2026-09-05T10:00:00.000Z' },
    ],
    getCostSeries: async () => ({ marketing: [{ date: '2026-07-09', count: 0.57 }], utility: [], total: 0.57, hasRates: true, currency: 'EUR', nonChiffrables: 0, sansCategorie: 0, sansTarif: 0 }),
    getConversationSummary: async () => ({
      enabled: true, retentionDays: 365, total: 3,
      sentiment: { positif: 1, neutre: 1, negatif: 1 },
      intent: { demande_devis: 2, sav: 1, reclamation: 0, information: 0, prise_rdv: 0, autre: 0 },
      resolution: { resolved: 2, unresolved: 1, rate: 2 / 3 },
      handledBy: { humain: 1, automatise: 2, mba: 0 },
      exchanges: { avg: 3.5, median: 3 },
      actions: { creer_devis: 2, rappeler: 0, relancer: 0, escalader: 1, aucune: 0 },
      topTopics: [{ topic: 'devis', count: 2 }],
      // ⚠️ Les sujets RANGES SOUS LEUR INTENTION (2026-09-17). Le champ est REQUIS par le contrat, et c'est
      // ce qui a fait tomber cette fixture au typecheck plutot qu'au runtime : un `?` l'aurait laissee
      // passer, et l'ecran aurait boucle sur `undefined` en production.
      topicsParIntention: { demande_devis: [{ topic: 'devis', count: 2 }] },
      confidence: { lt50: 0, from50to70: 1, from70to90: 1, gte90: 1 },
    }),
    getCoutParCampagne: async () => ({
      lignes: [
        { campaignId: CAMP_A, nom: 'Promo ete', template: 'promo', envoyes: 10, envois: 10, cout: 1.43, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: 4, coutParClic: 0.3575 },
        { campaignId: CAMP_B, nom: 'Relance', template: null, envoyes: 5, envois: 5, cout: null, nonChiffrables: 5, sansCategorie: 5, sansTarif: 0, clics: null, coutParClic: null },
      ],
      currency: 'EUR',
      hasRates: true,
      tronque: false,
    }),
    getDetailCoutCampagne: async (_t, id) => (id === CAMP_A ? {
      campaignId: CAMP_A, nom: 'Promo ete', template: 'promo', workflowId: null, devise: 'EUR',
      lancement: {
        envoyes: 10, cout: 1.43, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0,
        echecs: 1, clics: 4, coutParClic: 0.3575, reponses: 3, boutons: 2,
      },
      relances: { envoyes: 0, cout: null, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0 },
      etapes: [],
      clicsAnonymes: 0,
    } : null),
    getNuageQualitatif: async () => ({
      points: [{ satisfaction: 0, urgence: 9, n: 2 }, { satisfaction: 8, urgence: 1, n: 1 }],
      moyenne: { satisfaction: 8 / 3, urgence: 19 / 3 },
      mesurees: 3,
      sansMesure: 11,
    }),
    listAnalyzedConversations: async (_t, _r, f) => [
      { conversationId: 'cv1', waId: '33600', profileName: 'Julie', sentiment: f.sentiment ?? 'positif', intent: 'demande_devis', topic: 'devis', resolved: true, actionSuggestion: 'creer_devis', confidence: 0.9, justification: 'demande un devis', handledBy: 'humain', exchangesCount: 3, analyzedAt: '2026-07-17T10:00:00.000Z', inboxHref: '/inbox?c=cv1', summary: 'Le client demande un devis pour 50 unites.', entities: { quantite: 50 }, origines: ['humain'] },
    ],
    ...over.stats,
  };
  const settings: SettingsRouteDeps = {
    // Aucun portail lie : c est le defaut, et la fixture le DIT (cf. `tests/hubspot.ts`).
    hubspotPortalConnecte: sansPortailHubspot,
    getSettings: async () => ({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, agentsPeuventPrendre: false, optoutRequestId: null, mentionIaFrequence: null, timezone: 'Europe/Paris', businessHours: {}, prix: GRILLE_DEFAUT }),
    setMbaEnabled: async () => {},
    setHubspotListsEnabled: async () => {},
    setMbaHandoffMode: async () => {},
    setControlHandbackSeconds: async () => {},
    setTimezone: async () => {},
    setBusinessHours: async () => {},
    ...over.settings,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, stats, settings });
}

describe('stats route', () => {
  it('GET /stats -> 3 séries', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ contacts: unknown[]; templates: { utility: unknown[]; marketing: unknown[] }; exchanged: unknown[] }>();
    expect(b.contacts).toHaveLength(1);
    expect(b.templates.marketing[0]).toEqual({ date: '2026-07-09', count: 2 });
    expect(b.exchanged[0]).toEqual({ date: '2026-07-09', count: 5 });
    await a.close();
  });

  it('agent -> 403 sur les stats (dashboard réservé admin, Feature 2 RBAC)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('GET /stats/conversations -> agrégats + enabled ; agent 403 ; tenant croisé 403 ; plage invalide 400', async () => {
    const a = app();
    const ok = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations?days=30', ...h(adminTok) });
    expect(ok.statusCode).toBe(200);
    const s = ok.json<{ enabled: boolean; total: number; sentiment: { positif: number }; resolution: { rate: number } }>();
    expect(s).toMatchObject({ enabled: true, total: 3 });
    expect(s.sentiment.positif).toBe(1);
    expect(s.resolution.rate).toBeCloseTo(2 / 3);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations', ...h(agentTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats/conversations', ...h(adminTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations?from=2026-07-10&to=2026-07-01', ...h(adminTok) })).statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats/conversations/list -> quali + filtres enum valides seulement, inboxHref', async () => {
    const captured: unknown[] = [];
    const a = app({ stats: { listAnalyzedConversations: async (_t, _r, f) => { captured.push(f); return [{ conversationId: 'cv1', waId: '33600', profileName: null, sentiment: 'negatif', intent: 'sav', topic: 't', resolved: false, actionSuggestion: 'escalader', confidence: 0.6, justification: 'j', handledBy: 'automatise', exchangesCount: 5, analyzedAt: '2026-07-17T10:00:00.000Z', inboxHref: '/inbox?c=cv1', summary: null, entities: {}, origines: ['humain', 'mba'] }]; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/list?days=30&sentiment=negatif&intent=sav&action=escalader&limit=25&junk=xxx', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ conversations: Array<{ inboxHref: string }> }>().conversations[0]?.inboxHref).toBe('/inbox?c=cv1');
    // Seuls les filtres d'enum VALIDES sont passés au store ; une valeur hors enum serait ignorée (pas d'injection).
    expect(captured[0]).toEqual({ sentiment: 'negatif', intent: 'sav', action: 'escalader', limit: 25 });
    const bad = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/list?days=30&sentiment=PIRATE&action=drop', ...h(adminTok) });
    expect(bad.statusCode).toBe(200);
    expect(captured[1]).toEqual({}); // aucune valeur d'enum valide -> aucun filtre
    await a.close();
  });

  it('🔴 le filtre par SUJET passe au store, borné en longueur, et une chaîne vide ne filtre pas', async () => {
    // Le sujet est du texte libre (écrit par le LLM), donc pas d'énumération à opposer : ce qui protège
    // ici, c'est le paramètre lié côté store plus cette borne de longueur. Les deux sens comptent : un
    // sujet légitime doit ARRIVER au store, une chaîne vide ne doit PAS devenir un filtre qui ne ramène
    // jamais rien, et un sujet absurdement long ne doit pas descendre jusqu'à la base.
    const captured: AnalyzedConversationsFilter[] = [];
    const a = app({ stats: { listAnalyzedConversations: async (_t, _r, f) => { captured.push(f); return []; } } });
    const url = (q: string) => `/tenants/t1/stats/conversations/list?days=30&${q}`;

    expect((await a.inject({ method: 'GET', url: url('topic=retard%20de%20livraison'), ...h(adminTok) })).statusCode).toBe(200);
    expect(captured[0]).toEqual({ topic: 'retard de livraison' });

    await a.inject({ method: 'GET', url: url('topic='), ...h(adminTok) });
    expect(captured[1]).toEqual({});

    await a.inject({ method: 'GET', url: url(`topic=${'x'.repeat(121)}`), ...h(adminTok) });
    expect(captured[2]).toEqual({});

    // Exactement la borne : accepté. Sinon la borne refuserait un sujet que la base sait stocker.
    await a.inject({ method: 'GET', url: url(`topic=${'x'.repeat(120)}`), ...h(adminTok) });
    expect(captured[3]).toEqual({ topic: 'x'.repeat(120) });
    await a.close();
  });

  it('GET /stats/cost/campaigns -> une ligne par campagne, avec ses cases VIDES', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ lignes: Array<{ cout: number | null; clics: number | null; coutParClic: number | null }>; currency: string; hasRates: boolean }>();
    expect(b.lignes).toHaveLength(2);
    expect(b.lignes[0]).toMatchObject({ cout: 1.43, clics: 4 });
    // 🔴 Les `null` traversent le transport tels quels. Une campagne à scénario n'a PAS zéro clic : elle
    // n'a rien de mesurable, et un zéro se lirait « personne n'a cliqué ». Un JSON qui remplacerait ces
    // absences par des zéros ferait mentir l'écran sans qu'aucune erreur ne se voie.
    expect(b.lignes[1]).toMatchObject({ cout: null, clics: null, coutParClic: null });
    expect(b.currency).toBe('EUR');
    await a.close();
  });

  it('🔴 la bascule des archivées arrive au câblage, et son absence vaut « exclues » (lot 4)', async () => {
    // Une flèche à deux paramètres est assignable à un contrat qui en déclare trois : c'est ce test, pas le
    // compilateur, qui dit que la route TRANSMET la bascule.
    const vus: Array<{ inclureArchivees: boolean }> = [];
    const a = app({ stats: { getCoutParCampagne: async (_t, _r, opts) => { vus.push(opts); return { lignes: [], currency: null, hasRates: false, tronque: false }; } } });
    await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns?days=30', ...h(adminTok) });
    await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns?days=30&archivees=1', ...h(adminTok) });
    await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns?days=30&archivees=oui', ...h(adminTok) });
    expect(vus).toEqual([{ inclureArchivees: false }, { inclureArchivees: true }, { inclureArchivees: false }]);
    await a.close();
  });

  it('🔴 coût par campagne sans câblage -> 503, jamais un tableau vide', async () => {
    // Un tableau vide se lirait « aucune campagne n'a envoyé sur la période ». La vérité serait « rien
    // n'est branché ». Même choix que ses voisines.
    const a = app({ stats: { getCoutParCampagne: undefined } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(503);
    await a.close();
  });

  it('GET /stats/cost/campaigns : agent -> 403, tenant croisé -> 403, plage invalide -> 400', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns?days=30', ...h(agentTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats/cost/campaigns?days=30', ...h(adminTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns?from=2026-01-10&to=2026-01-01', ...h(adminTok) })).statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats/conversations/nuage -> le damier + la moyenne + ce qui n’est pas mesuré', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/nuage?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ points: Array<{ satisfaction: number; urgence: number; n: number }>; mesurees: number; sansMesure: number }>();
    expect(b.points).toHaveLength(2);
    // 🔴 Le zéro survit au transport. Une satisfaction de 0 est une MESURE (client très mécontent), pas une
    // absence : un `?? null` ou un `|| undefined` posé quelque part sur ce chemin ferait disparaître de
    // l'écran exactement les conversations qui alarment.
    expect(b.points[0]).toEqual({ satisfaction: 0, urgence: 9, n: 2 });
    expect(b.sansMesure).toBe(11);
    await a.close();
  });

  it('🔴 nuage sans câblage -> 503, jamais un nuage vide', async () => {
    // Un nuage vide se lirait « aucune conversation mesurée sur la période », qui est une affirmation.
    // La vérité serait « rien n'est branché ». Même choix que les contacts touchés.
    const a = app({ stats: { getNuageQualitatif: undefined } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/nuage?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(503);
    await a.close();
  });

  it('GET /stats/conversations/nuage : agent -> 403, tenant croisé -> 403, plage invalide -> 400', async () => {
    // La route est NEUVE : elle doit hériter des mêmes gardes que ses voisines, pas s'ouvrir à côté.
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/nuage?days=30', ...h(agentTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats/conversations/nuage?days=30', ...h(adminTok) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/conversations/nuage?from=2026-01-10&to=2026-01-01', ...h(adminTok) })).statusCode).toBe(400);
    await a.close();
  });

  it('tenant != token -> 403', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('sans token -> 401', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats' });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('GET /stats/templates -> breakdown + pricing', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ breakdown: Array<{ name: string; count: number }>; pricing: { totalCost: number; byCategory: Record<string, { ratePerMessage: number }> } }>();
    expect(b.breakdown[0]).toEqual({ name: 'promo', category: 'marketing', count: 4 });
    expect(b.pricing.byCategory.marketing?.ratePerMessage).toBeCloseTo(0.1431);
    await a.close();
  });

  it('GET /stats/templates agent -> 403 (admin-only)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('GET /stats/templates pricing null (Meta indispo) -> 200, breakdown seul', async () => {
    const a = app({ stats: { getPricing: async () => null } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ pricing: unknown }>().pricing).toBeNull();
    await a.close();
  });

  it('GET /stats/campaign-funnel?campaignId -> le funnel complet, clics compris', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/campaign-funnel?campaignId=c1', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    // ⚠️ ÉGALITÉ COMPLÈTE, PAS `toMatchObject`, et c'est ce qui fait son travail : la route relaie ce que le
    // store rend, donc c'est ici qu'un champ ajouté en base se voit arriver dans la charge utile.
    expect(res.json()).toEqual({
      sent: 10, delivered: 8, read: 5, replied: 3, failed: 1, sansAccuse: 0, buttonReplies: 2, urlClicks: 4,
      contactsVises: 10, parCanal: [],
    });
    await a.close();
  });

  it('🔴 un template SANS lien tracé rend urlClicks = null, pas 0', async () => {
    // 0 se lirait « personne n'a cliqué » ; null dit « il n'y a rien à cliquer », et l'écran masque l'étape.
    const a = app({ stats: { getCampaignFunnel: async () => ({ sent: 10, delivered: 8, read: 5, replied: 3, failed: 1, sansAccuse: 0, buttonReplies: 0, urlClicks: null, contactsVises: 10, parCanal: [] }) } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/campaign-funnel?campaignId=c1', ...h(adminTok) });
    expect(res.json<{ urlClicks: number | null }>().urlClicks).toBeNull();
    await a.close();
  });

  it('GET /stats/campaign-funnel sans campaignId -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/campaign-funnel', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats/errors -> { errors: [...] } trié, avec templateName', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ errors: Array<{ code: number; count: number; templateName: string | null }> }>().errors[0])
      .toEqual({ code: 131049, count: 4, templateName: 'promo', campaignId: CAMP_A, campaignName: 'Promo ete' });
    await a.close();
  });

  // 🔴 La CAMPAGNE voyage avec la ligne : c'est elle qui rend le filtre par campagne possible cote ecran
  // sans une seconde requete. Sans ce champ, le filtre ne pourrait porter que sur le template.
  it('GET /stats/errors -> chaque ligne porte SA campagne', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors?days=30', ...h(adminTok) });
    const errs = res.json<{ errors: Array<{ campaignId: string; campaignName: string }> }>().errors;
    expect(errs.map((e) => e.campaignId)).toEqual([CAMP_A, CAMP_B]);
    expect(errs.map((e) => e.campaignName)).toEqual(['Promo ete', 'Relance']);
    await a.close();
  });

  it('GET /stats/errors?templateName -> filtre transmis au store + réponse porte templateName', async () => {
    let captured: string | undefined = 'UNSET';
    const a = app({ stats: { getErrorBreakdown: async (_t, _r, tpl) => { captured = tpl; return [{ code: 131049, count: 4, templateName: 'promo', campaignId: CAMP_A, campaignName: 'Promo ete' }]; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors?days=30&templateName=promo', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(captured).toBe('promo');
    expect(res.json<{ errors: Array<{ templateName: string | null }> }>().errors[0]!.templateName).toBe('promo');
    await a.close();
  });

  it('GET /stats/errors/:code/contacts -> la liste des contacts touches', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/tenants/t1/stats/errors/131049/contacts?days=30`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ contacts: Array<{ telephone: string; contactNom: string | null }>; tronque: boolean; plafond: number }>();
    expect(b.contacts[0]).toMatchObject({ telephone: '+33600000001', contactNom: 'Julie', campaignName: 'Promo ete' });
    expect(b.tronque).toBe(false);
    expect(b.plafond).toBe(200);
    await a.close();
  });

  it('🔴 GET /stats/errors/:code/contacts : le CODE et les deux filtres arrivent au store', async () => {
    // Sans cette verification, une route qui ignore ses filtres rendrait quand meme 200 avec une liste :
    // l ecran afficherait « les contacts touches par 131049 » en montrant ceux de tous les codes.
    let vu: { code: number; ids?: string[]; tpls?: string[] } | null = null;
    const a = app({ stats: { getErrorContacts: async (_t, _r, code, f) => { vu = { code, ids: f.campaignIds, tpls: f.templateNames }; return []; } } });
    const res = await a.inject({
      method: 'GET',
      url: `/tenants/t1/stats/errors/131047/contacts?days=30&campaignIds=${CAMP_A},${CAMP_B}&templateNames=promo`,
      ...h(adminTok),
    });
    expect(res.statusCode).toBe(200);
    expect(vu).toEqual({ code: 131047, ids: [CAMP_A, CAMP_B], tpls: ['promo'] });
    await a.close();
  });

  it('🔴 GET /stats/errors/:code/contacts : un code non entier -> 400 (pas 500)', async () => {
    // Le code arrive du CHEMIN, donc en texte. Sans conversion validee, un `NaN` partait en `::int` et
    // Postgres refusait la conversion a l execution : 500, dont Cloudflare remplace le corps par sa page.
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors/abc/contacts?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('🔴 un campaignIds mal forme -> 400, et la requete ne part PAS', async () => {
    // Meme famille : ces valeurs partent dans un `::uuid[]`. Et on REFUSE au lieu de jeter les mauvaises,
    // sinon le filtre deviendrait vide, c est a dire « tout » : l ecran montrerait PLUS que le demande.
    let appele = false;
    const a = app({ stats: { getErrorContacts: async () => { appele = true; return []; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors/131049/contacts?days=30&campaignIds=pas-un-uuid', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    expect(appele).toBe(false);
    await a.close();
  });

  it('🔴 le meme garde protege /stats/cost : campaignIds mal forme -> 400', async () => {
    let appele = false;
    const a = app({ stats: { getCostSeries: async () => { appele = true; return { marketing: [], utility: [], total: 0, hasRates: true, currency: 'EUR', nonChiffrables: 0, sansCategorie: 0, sansTarif: 0 }; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost?days=30&campaignIds=pas-un-uuid', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    expect(appele).toBe(false);
    await a.close();
  });

  /**
   * 🔴 LA FICHE D UNE CAMPAGNE, ET CE BLOC EXISTE POUR UNE RAISON PRECISE : c est le SEUL endroit qui
   * prouve que la route est REELLEMENT ATTEIGNABLE. Les tests e2e de l ecran interceptent l API, donc ils
   * passeraient tous avec une capacite branchee dans `src/index.ts` et jamais transmise a `registerStats`.
   * Le depot a deja paye exactement ce defaut en production (deux capacites cablees dans le worker,
   * absentes du contrat, toutes les campagnes a lien trace en echec).
   */
  it('🔴 la route de la fiche existe et rend le detail', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/tenants/t1/stats/cost/campaigns/${CAMP_A}`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lancement.envoyes).toBe(10);
    expect(body.lancement.echecs).toBe(1);
    await a.close();
  });

  it('🔴 campagne inconnue -> 404, jamais une fiche a zero', async () => {
    // « cette campagne n existe pas ici » et « elle n a rien coute » sont deux reponses differentes, et la
    // seconde serait une affirmation fausse posee sur un ecran ou le client decide de son budget.
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/tenants/t1/stats/cost/campaigns/${CAMP_B}`, ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('🔴 identifiant mal forme -> 400, et la base n est jamais appelee', async () => {
    // Sans la garde, le texte partirait dans un parametre `uuid` et Postgres leverait : un 500, donc la
    // page d erreur de Cloudflare a la place du corps, cote client.
    let appele = false;
    const a = app({ stats: { getDetailCoutCampagne: async () => { appele = true; return null; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost/campaigns/pas-un-uuid', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    expect(appele).toBe(false);
    await a.close();
  });

  it('un agent n a pas acces a la fiche de couts', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/tenants/t1/stats/cost/campaigns/${CAMP_A}`, ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('🔴 un AUTRE espace ne peut pas lire la fiche', async () => {
    // `scopeTenant` echoue ferme : le tenant vient de la session, jamais de l URL. C est LE controle
    // d isolation, la RLS etant contournee par le pooler.
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/tenants/t-autre/stats/cost/campaigns/${CAMP_A}`, ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('🔴 la liste est PLAFONNEE, et le dit', async () => {
    // Un code d erreur peut frapper une campagne entiere. Le store rend une ligne de plus que le plafond
    // pour qu on sache qu on tronque ; l afficher serait annoncer 200 en en montrant 201.
    const trop = Array.from({ length: 201 }, (_v, i) => ({
      recipientId: `r${i}`, campaignId: CAMP_A, campaignName: 'Promo ete', telephone: `+3360000${i}`,
      contactId: `ct${i}`, contactNom: null, code: 131049, message: null,
      origine: 'envoi' as const, at: '2026-09-05T10:00:00.000Z',
    }));
    const a = app({ stats: { getErrorContacts: async () => trop } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors/131049/contacts?days=30', ...h(adminTok) });
    const b = res.json<{ contacts: unknown[]; tronque: boolean }>();
    expect(b.contacts).toHaveLength(200);
    expect(b.tronque).toBe(true);
    await a.close();
  });

  it('🔴 sans cablage -> 503, jamais une liste vide', async () => {
    // Une liste vide se lirait « personne n a ete touche », qui est une affirmation. La verite serait
    // « rien n est branche ». Meme choix que les mesures de scenario.
    const a = app({ stats: { getErrorContacts: undefined } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors/131049/contacts?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(503);
    await a.close();
  });

  it('GET /stats/errors/:code/contacts agent -> 403 (admin-only)', async () => {
    // La route est NOUVELLE : elle doit entrer dans le groupe admin comme ses voisines, pas a cote.
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/errors/131049/contacts?days=30', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('GET /stats/cost -> série marketing/utility + total', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost?days=30&templateName=promo', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ total: number; hasRates: boolean; marketing: unknown[] }>();
    expect(b.total).toBe(0.57);
    expect(b.hasRates).toBe(true);
    await a.close();
  });

  it('GET /stats/cost agent -> 403 (admin-only)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/cost', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('GET /stats?from&to valides -> 200', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2026-01-01&to=2026-01-31', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('GET /stats to dans le futur -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2020-01-01&to=2999-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats from > to -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2026-02-01&to=2026-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats span > 366j -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2024-01-01&to=2026-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('GET /stats un seul de from/to -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats?from=2026-01-01', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});

describe('settings route', () => {
  it('GET /settings admin -> mbaEnabled', async () => {
    const a = app({ settings: { getSettings: async () => ({ mbaEnabled: true, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, agentsPeuventPrendre: false, optoutRequestId: null, mentionIaFrequence: null, timezone: 'Europe/Paris', businessHours: {}, prix: GRILLE_DEFAUT }) } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ mbaEnabled: boolean }>().mbaEnabled).toBe(true);
    await a.close();
  });

  it('PATCH /settings/timezone : IANA valide -> 200 + posé ; invalide -> 400 ; agent -> 403', async () => {
    let saved: [string, string] | null = null;
    const ok = app({ settings: { setTimezone: async (t, tz) => { saved = [t, tz]; } } });
    const r1 = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/timezone', ...h(adminTok), payload: { timezone: 'America/New_York' } });
    expect(r1.statusCode).toBe(200);
    expect(saved).toEqual(['t1', 'America/New_York']);
    const bad = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/timezone', ...h(adminTok), payload: { timezone: 'Mars/Olympus' } });
    expect(bad.statusCode).toBe(400);
    const agent = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/timezone', ...h(agentTok), payload: { timezone: 'Europe/Paris' } });
    expect(agent.statusCode).toBe(403);
    // tenant croisé (token scopé t1 -> /tenants/AUTRE) -> 403
    const cross = await ok.inject({ method: 'PATCH', url: '/tenants/AUTRE/settings/timezone', ...h(adminTok), payload: { timezone: 'Europe/Paris' } });
    expect(cross.statusCode).toBe(403);
    await ok.close();
  });

  it('PATCH /settings/business-hours : 7 jours valides -> 200 ; plage inversée -> 400 ; jour manquant -> 400', async () => {
    let saved: unknown = null;
    const ok = app({ settings: { setBusinessHours: async (_t, h2) => { saved = h2; } } });
    const week = (open: string, close: string) => Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), d === 0 || d === 6 ? { closed: true, open: '', close: '' } : { closed: false, open, close }]));
    const good = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/business-hours', ...h(adminTok), payload: { businessHours: week('09:00', '18:00') } });
    expect(good.statusCode).toBe(200);
    expect((saved as Record<string, { open: string }>)['1']!.open).toBe('09:00');
    const inverted = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/business-hours', ...h(adminTok), payload: { businessHours: week('18:00', '09:00') } });
    expect(inverted.statusCode).toBe(400);
    const missing = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/business-hours', ...h(adminTok), payload: { businessHours: { '1': { closed: false, open: '09:00', close: '18:00' } } } });
    expect(missing.statusCode).toBe(400);
    // tenant croisé -> 403
    const cross = await ok.inject({ method: 'PATCH', url: '/tenants/AUTRE/settings/business-hours', ...h(adminTok), payload: { businessHours: week('09:00', '18:00') } });
    expect(cross.statusCode).toBe(403);
    await ok.close();
  });

  it('GET /settings agent -> 403 (admin-only, Feature 2 RBAC)', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('PUT /settings admin -> 200 + persiste', async () => {
    let saved: [string, boolean] | null = null;
    const a = app({ settings: { setMbaEnabled: async (t, e) => { saved = [t, e]; } } });
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(adminTok), payload: { mbaEnabled: true } });
    expect(res.statusCode).toBe(200);
    expect(saved).toEqual(['t1', true]);
    await a.close();
  });

  it('PUT /settings agent -> 403 (admin-only)', async () => {
    const a = app();
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(agentTok), payload: { mbaEnabled: true } });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('PATCH /settings/hubspot-lists admin -> 200 + persiste ; agent -> 403 ; body invalide -> 400', async () => {
    let saved: [string, boolean] | null = null;
    const ok = app({ settings: { setHubspotListsEnabled: async (t, e) => { saved = [t, e]; } } });
    const r1 = await ok.inject({ method: 'PATCH', url: '/tenants/t1/settings/hubspot-lists', ...h(adminTok), payload: { enabled: true } });
    expect(r1.statusCode).toBe(200);
    expect(saved).toEqual(['t1', true]);
    await ok.close();
    const ag = app();
    expect((await ag.inject({ method: 'PATCH', url: '/tenants/t1/settings/hubspot-lists', ...h(agentTok), payload: { enabled: true } })).statusCode).toBe(403);
    await ag.close();
    const bad = app();
    expect((await bad.inject({ method: 'PATCH', url: '/tenants/t1/settings/hubspot-lists', ...h(adminTok), payload: { enabled: 'oui' } })).statusCode).toBe(400);
    await bad.close();
  });

  it('⚠️ PATCH /settings/auto-retry n’existe plus : la relance obéit à la case de chaque campagne (0165)', async () => {
    // Remplace le test F6 de la route : le réglage d'espace a quitté l'écran, et une route qui l'écrirait encore
    // changerait sans écran le sort des campagnes d'avant 0165.
    const a = app();
    expect((await a.inject({ method: 'PATCH', url: '/tenants/t1/settings/auto-retry', ...h(adminTok), payload: { enabled: true } })).statusCode).toBe(404);
    await a.close();
  });

  it('PUT /settings body invalide -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'PUT', url: '/tenants/t1/settings', ...h(adminTok), payload: { mbaEnabled: 'oui' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});

/**
 * Durée du gel après prise de main, réglable par client.
 *
 * La validation compte autant que l'écriture : ce réglage décide combien de temps un client final peut
 * rester sans réponse. Une valeur aberrante acceptée en silence casserait la promesse « le client finit
 * toujours par avoir une réponse », et rien à l'écran ne le signalerait.
 */
describe('PATCH /settings/control-handback', () => {
  const url = '/tenants/t1/settings/control-handback';

  it('accepte une durée en secondes et la renvoie', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    const res = await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds: 1800 } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ controlHandbackSeconds: number }>().controlHandbackSeconds).toBe(1800);
    expect(poses).toEqual([1800]);
    await a.close();
  });

  it('accepte null (retour au défaut du serveur) et 0 (jamais de reprise auto)', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    expect((await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds: null } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds: 0 } })).statusCode).toBe(200);
    expect(poses).toEqual([null, 0]);
    await a.close();
  });

  it('refuse ce qui laisserait un client sans réponse trop longtemps ou pour toujours', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    // Au-delà de 7 jours ce n'est plus un gel, c'est un abandon. Négatif, décimal et non-nombre sont
    // des erreurs de saisie qu'il vaut mieux refuser que coercer en silence.
    for (const seconds of [7 * 24 * 3600 + 1, -1, 1.5, '1800', true, undefined]) {
      const res = await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { seconds } });
      expect(res.statusCode).toBe(400);
    }
    expect(poses).toEqual([]); // aucune écriture sur une valeur refusée
    await a.close();
  });

  it('un agent ne peut pas changer ce réglage (admin seulement)', async () => {
    const poses: Array<number | null> = [];
    const a = app({ settings: { setControlHandbackSeconds: async (_t: string, sec: number | null) => { poses.push(sec); } } });
    const res = await a.inject({ method: 'PATCH', url, ...h(agentTok), payload: { seconds: 60 } });
    expect(res.statusCode).toBe(403);
    expect(poses).toEqual([]);
    await a.close();
  });
});

/**
 * Quand l'agent de Meta passe la main à un humain. Le choix vit en base (c'est lui qui pilote le balayage
 * horaire) et il est appliqué chez Meta dans la foulée, en best-effort.
 */
describe('PATCH /settings/mba-handoff', () => {
  const url = '/tenants/t1/settings/mba-handoff';
  /** Stub commun : enregistre le mode posé en base et l'état appliqué chez Meta. */
  const espion = (over: Record<string, unknown> = {}) => {
    const modes: string[] = [];
    const appliques: boolean[] = [];
    const a = app({ settings: {
      setMbaHandoffMode: async (_t: string, m: string) => { modes.push(m); },
      applyMbaHandoffEnabled: async (_t: string, e: boolean) => { appliques.push(e); },
      ...over,
    } });
    return { a, modes, appliques };
  };

  it('« toujours » -> enregistré, et le passage de main allumé chez Meta', async () => {
    const { a, modes, appliques } = espion();
    const res = await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { mode: 'always' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ mbaHandoffMode: string }>().mbaHandoffMode).toBe('always');
    expect(modes).toEqual(['always']);
    expect(appliques).toEqual([true]);
    await a.close();
  });

  it('« jamais » -> l’agent garde le fil', async () => {
    const { a, modes, appliques } = espion();
    expect((await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { mode: 'never' } })).statusCode).toBe(200);
    expect(modes).toEqual(['never']);
    expect(appliques).toEqual([false]);
    await a.close();
  });

  it('« heures d’ouverture » -> applique l’état de L’INSTANT (ici : fermé)', async () => {
    // Sinon le client règle son outil un dimanche et voit le passage de main allumé jusqu'au balayage suivant.
    const tousFermes = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: true, open: '', close: '' }]));
    const { a, modes, appliques } = espion({
      // Aucun portail lie : c est le defaut, et la fixture le DIT (cf. `tests/hubspot.ts`).
    hubspotPortalConnecte: sansPortailHubspot,
    getSettings: async () => ({
        mbaEnabled: true, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
        controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, agentsPeuventPrendre: false, timezone: 'Europe/Paris', businessHours: tousFermes,
      }),
    });
    expect((await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { mode: 'business_hours' } })).statusCode).toBe(200);
    expect(modes).toEqual(['business_hours']);
    expect(appliques).toEqual([false]);
    await a.close();
  });

  it('🔴 Meta injoignable -> le choix est quand même enregistré (le balayage rattrapera)', async () => {
    const { a, modes } = espion({ applyMbaHandoffEnabled: async () => { throw new Error('502'); } });
    const res = await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { mode: 'always' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ appliqueChezMeta: boolean }>().appliqueChezMeta).toBe(false);
    expect(modes).toEqual(['always']); // enregistré : refuser priverait le client de son propre réglage
    await a.close();
  });

  it('mode inconnu -> 400, et rien n’est écrit', async () => {
    const { a, modes, appliques } = espion();
    for (const mode of ['parfois', '', null, undefined, true]) {
      expect((await a.inject({ method: 'PATCH', url, ...h(adminTok), payload: { mode } })).statusCode).toBe(400);
    }
    expect(modes).toEqual([]);
    expect(appliques).toEqual([]);
    await a.close();
  });

  it('un agent ne peut pas changer ce réglage (admin seulement)', async () => {
    const { a, modes } = espion();
    expect((await a.inject({ method: 'PATCH', url, ...h(agentTok), payload: { mode: 'never' } })).statusCode).toBe(403);
    expect(modes).toEqual([]);
    await a.close();
  });
});


describe('GET /tenants/:t/stats/workflow/:workflowId — mesures par bloc', () => {
  const COUNTS = [
    { nodeId: 'n1', kind: 'sent' as const, handle: null, count: 12, contacts: 12 },
    { nodeId: 'n1', kind: 'reply_button' as const, handle: 'btn:0', count: 5, contacts: 4 },
  ];

  it('rend les compteurs BRUTS du scénario sur la plage', async () => {
    // Bruts, et non un tableau tout fait : deux tableaux différents lisent les mêmes lignes, et agréger côté
    // serveur obligerait à rejouer la requête à chaque changement de sélection à l'écran.
    const recus: Array<{ workflowId: string; range: unknown }> = [];
    const a = app({ stats: { getWorkflowNodeCounts: async (_t: string, workflowId: string, range: unknown) => { recus.push({ workflowId, range }); return COUNTS; } } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/workflow/wf-1?from=2026-08-01&to=2026-08-19', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ counts: unknown[] }>().counts).toEqual(COUNTS);
    expect(recus[0]?.workflowId).toBe('wf-1');
    await a.close();
  });

  it('🔴 instance sans mesures câblées -> 503, PAS une liste vide', async () => {
    // Une liste vide se lirait « ce scénario n'a rien produit », ce qui est le contraire de « rien n'est
    // branché ». C'est la même règle que pour le journal d'audit.
    const a = app({ stats: { getWorkflowNodeCounts: undefined } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/workflow/wf-1?days=30', ...h(adminTok) });
    expect(res.statusCode).toBe(503);
    await a.close();
  });

  it('plage invalide -> 400, comme les autres routes de stats', async () => {
    const a = app({ stats: { getWorkflowNodeCounts: async () => COUNTS } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/workflow/wf-1?from=pasunedate&to=2026-08-19', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('réservée aux admins', async () => {
    const a = app({ stats: { getWorkflowNodeCounts: async () => COUNTS } });
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/stats/workflow/wf-1?days=30', ...h(agentTok) })).statusCode).toBe(403);
    await a.close();
  });
});

/**
 * LA GRILLE DE PRIX A QUITTE LES REGLAGES DU CLIENT (lot 8 du 2026-09-23, migration 0168).
 *
 * 🔴 CE QUI A CHANGE, ET POURQUOI CE BLOC N EST PLUS ICI. `PATCH /tenants/:t/settings/prix` existait pour
 * fermer un vrai trou : les six colonnes de 0154 etaient en base et aucun chemin ne les ecrivait. Mais
 * l ecran qui l appelait etait celui du CLIENT, donc le client fixait ce qu on lui facture. Julien a
 * tranche : une seule grille, pour tous les espaces, reglee dans /ops.
 *
 * ⚠️ LES SEPT CAS DE CE BLOC N ONT PAS ETE PERDUS, ils sont dans `tests/ops-prix.test.ts`. Cinq s y
 * transposent tels quels (les six champs d un coup, le 400 qui NOMME le champ, le refus d une grille
 * incomplete, le 503 d un cablage absent, la lecture) ; les DEUX qui portaient sur le tenant (un agent
 * refuse, un tenant etranger refuse) disparaissent avec leur sujet, parce que la route n a plus de tenant.
 * Leur equivalent est l autorite separee de /ops, gardee par `tests/ops.test.ts`.
 */

/**
 * LA MARGE VOYAGE AVEC CE QU ELLE EXPLIQUE.
 *
 * 🔴 CE QU ELLE SERT A DIRE. La page des couts pose cote a cote un cout ESTIME (prix de vente, marge
 * comprise) et le total FACTURE par Meta. La phrase qui reconcilie les deux attribuait tout l ecart au
 * tarif moyen par categorie : avec une marge de 150, l ecart est de 50 % et sa cause dominante n etait
 * nommee nulle part. L ecran ne peut la nommer que si le serveur la lui rend.
 */
describe('GET /tenants/:t/stats/templates rend la marge de l espace', () => {
  const h = (tok: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });

  it('la marge accompagne le pricing', async () => {
    const a = app({ stats: { margeTemplate: async () => 150 } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ margeTemplate: number }>().margeTemplate).toBe(150);
    await a.close();
  });

  it('🔴 la marge est celle de l espace du JETON, pas de celui de l URL', async () => {
    // Un prix de vente est une donnee commerciale : la lire pour un autre espace serait une fuite.
    const vus: string[] = [];
    const a = app({ stats: { margeTemplate: async (t) => { vus.push(t); return 120; } } });
    await a.inject({ method: 'GET', url: '/tenants/t1/stats/templates', ...h(adminTok) });
    expect(vus).toEqual(['t1']);
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/stats/templates', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(vus, 'aucune lecture pour un espace refuse').toEqual(['t1']);
    await a.close();
  });
});
