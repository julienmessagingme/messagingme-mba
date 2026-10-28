import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { VITRINE } from '../src/http/contact-vitrine';
import {
  registerLivreBlancVitrine, depotSandbox, courrielDeSecours, soumissionHubspot, SOURCE_CONSENTEMENT, SOUMISSION_HUBSPOT,
  TAG_LIVRE_BLANC,
} from '../src/http/livre-blanc-vitrine';
import type { DemandeLivreBlanc, LivreBlancVitrineDeps } from '../src/http/livre-blanc-vitrine';
import type { ContactUpsert } from '../src/crm/import';

type Courriel = Parameters<LivreBlancVitrineDeps['secours']['envoyer']>[0];

function monter(over: Partial<LivreBlancVitrineDeps> = {}) {
  const soumis: DemandeLivreBlanc[] = [];
  const deposes: Array<{ nom: string; telephoneE164: string }> = [];
  const secours: Courriel[] = [];
  const deps: LivreBlancVitrineDeps = {
    hubspot: { soumettre: async (d) => { soumis.push(d); } },
    sandbox: { deposer: async (d) => { deposes.push(d); } },
    secours: { enabled: true, envoyer: async (c) => { secours.push(c); } },
    ...over,
  };
  const app = Fastify({ logger: false });
  registerLivreBlancVitrine(app, deps);
  return { app, soumis, deposes, secours };
}

const FORMULAIRE = { 'content-type': 'application/x-www-form-urlencoded' };
const champs = (over: Record<string, string> = {}) => new URLSearchParams({
  prenom: 'Léa', nom: 'Martin', email: 'lea@ecole.fr', etablissement: 'École Horizon', fonction: 'Directrice des admissions',
  mobile: '06 12 34 56 78', whatsapp: 'oui', site: '', ...over,
}).toString();
const poster = (app: ReturnType<typeof monter>['app'], corps: string, ip = '203.0.113.7') =>
  app.inject({ method: 'POST', url: '/vitrine/livre-blanc', headers: { ...FORMULAIRE, 'cf-connecting-ip': ip }, payload: corps });
const sans = (cle: string) => { const p = new URLSearchParams(champs()); p.delete(cle); return p.toString(); };

const MERCI = `${VITRINE}/livre-blanc/whatsapp-education/merci/`;
const ERREUR = `${VITRINE}/livre-blanc/whatsapp-education/?erreur=champs#formulaire`;

afterEach(() => vi.restoreAllMocks());

describe('POST /vitrine/livre-blanc (le formulaire du livre blanc)', () => {
  it('case cochée et mobile : soumis à HubSpot, déposé dans SANDBOX, renvoyé sur la page du PDF', async () => {
    const { app, soumis, deposes, secours } = monter();
    const res = await poster(app, champs());
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(MERCI);
    expect(soumis).toEqual([{
      prenom: 'Léa', nom: 'Martin', email: 'lea@ecole.fr', etablissement: 'École Horizon',
      fonction: 'Directrice des admissions', mobile: '06 12 34 56 78', whatsapp: 'oui', site: '',
    }]);
    expect(deposes).toEqual([{ nom: 'Léa Martin', telephoneE164: '+33612345678' }]);
    expect(secours).toHaveLength(0);
  });

  it.each([
    ['+33 6 12 34 56 78', '+33612345678'],
    ['0033612345678', '+33612345678'],
    ['06.12.34.56.78', '+33612345678'],
    ['+44 7911 123456', '+447911123456'],
  ])('le mobile « %s » se dépose en %s', async (mobile, attendu) => {
    const { app, deposes } = monter();
    await poster(app, champs({ mobile }));
    expect(deposes).toEqual([{ nom: 'Léa Martin', telephoneE164: attendu }]);
  });

  it.each([
    ['la case décochée', sans('whatsapp')],
    ['la case cochée sans mobile', champs({ mobile: '' })],
    ['un mobile illisible', champs({ mobile: 'pas un numéro' })],
  ])('%s : HubSpot seulement, rien dans SANDBOX, le PDF quand même', async (_cas, corps) => {
    const { app, soumis, deposes } = monter();
    const res = await poster(app, corps);
    expect(res.headers.location).toBe(MERCI);
    expect(soumis).toHaveLength(1);
    expect(deposes).toHaveLength(0);
  });

  it.each([
    ['sans prénom', champs({ prenom: '  ' })],
    ['sans nom', champs({ nom: '' })],
    ['une adresse fausse', champs({ email: 'pas-une-adresse' })],
    ['sans établissement', sans('etablissement')],
    ['sans fonction', champs({ fonction: '' })],
    ['une case à une autre valeur', champs({ whatsapp: 'yes' })],
  ])('refuse %s : retour au formulaire, rien n’est transmis', async (_cas, corps) => {
    const { app, soumis, deposes, secours } = monter();
    const res = await poster(app, corps);
    expect(res.headers.location).toBe(ERREUR);
    expect([soumis, deposes, secours]).toEqual([[], [], []]);
  });

  it('le pot de miel : la même réponse qu’un envoi réussi, rien n’est transmis', async () => {
    const { app, soumis, deposes } = monter();
    expect((await poster(app, champs({ site: 'https://spam.example' }))).headers.location).toBe(MERCI);
    expect([soumis, deposes]).toEqual([[], []]);
  });

  it('HubSpot en panne : le prospect part par courriel à l’équipe, le visiteur a son PDF', async () => {
    const erreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, deposes, secours } = monter({ hubspot: { soumettre: async () => { throw new Error('HubSpot HTTP 500'); } } });
    const res = await poster(app, champs());
    expect(res.headers.location).toBe(MERCI);
    expect(deposes).toHaveLength(1);
    expect(secours).toHaveLength(1);
    expect(secours[0]!.repondreA).toBe('lea@ecole.fr');
    expect(secours[0]!.texte).toContain('Établissement : École Horizon');
    expect(erreur.mock.calls.flat().join(' ')).toContain('livre_blanc_hubspot_echec');
  });

  it('HubSpot non configuré : chaque prospect part par courriel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, secours } = monter({ hubspot: null });
    expect((await poster(app, champs())).headers.location).toBe(MERCI);
    expect(secours).toHaveLength(1);
  });

  it('HubSpot et le courriel en panne : le prospect est perdu, journalisé, et le visiteur a quand même son PDF', async () => {
    const erreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = monter({
      hubspot: { soumettre: async () => { throw new Error('HubSpot HTTP 500'); } },
      secours: { enabled: true, envoyer: async () => { throw new Error('Resend HTTP 500'); } },
    });
    expect((await poster(app, champs())).headers.location).toBe(MERCI);
    expect(erreur.mock.calls.flat().join(' ')).toContain('livre_blanc_prospect_perdu');
  });

  it('SANDBOX refuse (offre pleine, panne) : journalisé, HubSpot reçoit, aucun courriel de secours', async () => {
    const erreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, soumis, secours } = monter({ sandbox: { deposer: async () => { throw new Error('limite de contacts atteinte'); } } });
    expect((await poster(app, champs())).headers.location).toBe(MERCI);
    expect(soumis).toHaveLength(1);
    expect(secours).toHaveLength(0);
    expect(erreur.mock.calls.flat().join(' ')).toContain('livre_blanc_sandbox_echec');
  });

  it('au-delà de cinq envois en dix minutes depuis une même adresse : le PDF, mais plus rien n’est transmis', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, soumis } = monter();
    for (let i = 0; i < 6; i++) expect((await poster(app, champs())).headers.location).toBe(MERCI);
    expect(soumis).toHaveLength(5);
    await poster(app, champs(), '198.51.100.9');
    expect(soumis).toHaveLength(6);
  });

  it('la page anglaise : merci et erreurs reviennent sur les pages anglaises', async () => {
    const { app } = monter();
    expect((await poster(app, champs({ langue: 'en' }))).headers.location).toBe(`${VITRINE}/en/white-paper/whatsapp-education/thanks/`);
    expect((await poster(app, champs({ langue: 'en', email: 'non' }))).headers.location)
      .toBe(`${VITRINE}/en/white-paper/whatsapp-education/?erreur=champs#formulaire`);
  });

  it('le courriel de secours porte tout ce qu’il faut pour saisir le prospect à la main', () => {
    const c = courrielDeSecours({
      prenom: 'Léa', nom: 'Martin', email: 'lea@ecole.fr', etablissement: 'École Horizon', fonction: 'DA',
      mobile: '06 12 34 56 78', whatsapp: 'oui', site: '',
    }, 'fr');
    expect(c.sujet).toBe('[Livre blanc éducation] Léa Martin, École Horizon');
    expect(c.texte).toContain('Mobile : 06 12 34 56 78');
    expect(c.texte).toContain('Recontact sur WhatsApp : accepté');
    expect(c.repondreA).toBe('lea@ecole.fr');
  });
});

describe('soumissionHubspot', () => {
  const demande: DemandeLivreBlanc = {
    prenom: 'Léa', nom: 'Martin', email: 'lea@ecole.fr', etablissement: 'École Horizon', fonction: 'DA',
    mobile: '06 12 34 56 78', whatsapp: 'oui', site: '',
  };
  function fauxFetch(statut = 200, corps = '{}') {
    const appels: Array<{ url: string; init: RequestInit }> = [];
    const envoyer = (async (url: string, init: RequestInit) => {
      appels.push({ url, init });
      return new Response(corps, { status: statut });
    }) as unknown as typeof fetch;
    return { appels, envoyer };
  }

  it('poste au formulaire du portail, chaque champ sous le nom de sa propriété HubSpot, avec la page d’origine', async () => {
    const { appels, envoyer } = fauxFetch();
    await soumissionHubspot({ portail: '139615673', formulaire: 'abc-123' }, envoyer).soumettre(demande, 'fr');
    expect(appels).toHaveLength(1);
    expect(appels[0]!.url).toBe(`${SOUMISSION_HUBSPOT}/139615673/abc-123`);
    expect(appels[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const corps = JSON.parse(String(appels[0]!.init.body));
    expect(corps.fields).toEqual([
      { objectTypeId: '0-1', name: 'firstname', value: 'Léa' },
      { objectTypeId: '0-1', name: 'lastname', value: 'Martin' },
      { objectTypeId: '0-1', name: 'email', value: 'lea@ecole.fr' },
      { objectTypeId: '0-1', name: 'company', value: 'École Horizon' },
      { objectTypeId: '0-1', name: 'jobtitle', value: 'DA' },
      { objectTypeId: '0-1', name: 'mobilephone', value: '06 12 34 56 78' },
      { objectTypeId: '0-1', name: 'recontact_whatsapp', value: 'true' },
    ]);
    expect(corps.context.pageUri).toBe(`${VITRINE}/livre-blanc/whatsapp-education/`);
  });

  it('sans mobile, le champ n’est pas envoyé ; case décochée, la propriété vaut « false »', async () => {
    const { appels, envoyer } = fauxFetch();
    await soumissionHubspot({ portail: '1', formulaire: 'f' }, envoyer).soumettre({ ...demande, mobile: '', whatsapp: undefined }, 'en');
    const corps = JSON.parse(String(appels[0]!.init.body));
    expect(corps.fields.map((f: { name: string }) => f.name)).not.toContain('mobilephone');
    expect(corps.fields).toContainEqual({ objectTypeId: '0-1', name: 'recontact_whatsapp', value: 'false' });
    expect(corps.context.pageUri).toBe(`${VITRINE}/en/white-paper/whatsapp-education/`);
  });

  it('un refus de HubSpot lève, avec son statut et le début de sa réponse', async () => {
    const { envoyer } = fauxFetch(400, '{"errors":[{"errorType":"FIELD_NOT_IN_FORM_DEFINITION"}]}');
    await expect(soumissionHubspot({ portail: '1', formulaire: 'f' }, envoyer).soumettre(demande, 'fr'))
      .rejects.toThrow(/HubSpot HTTP 400 .*FIELD_NOT_IN_FORM_DEFINITION/);
  });
});

describe('depotSandbox', () => {
  // Une classe dont les méthodes lisent `this`, comme le vrai store : une méthode détachée échouerait ici.
  class FauxStore {
    fiches: ContactUpsert[] = [];
    consentements: unknown[][] = [];
    constructor(private readonly issue: 'change' | 'refuse') {}
    async upsertByPhoneReturningId(c: ContactUpsert) { this.fiches.push(c); return { id: 'c1', created: true }; }
    async ecrireConsentementParId(...args: [string, string, 'opted_in' | 'opted_out', string]) {
      this.consentements.push(args);
      return this.issue;
    }
  }

  it('la fiche (nom, tag), puis le consentement par l’écriture dédiée, tracé dans l’audit avec sa source', async () => {
    const store = new FauxStore('change');
    const traces: unknown[][] = [];
    await depotSandbox(store, async (...t) => { traces.push(t); }, 'espace-sandbox')
      .deposer({ nom: 'Léa Martin', telephoneE164: '+33612345678' });
    expect(store.fiches).toEqual([{
      tenantId: 'espace-sandbox', phoneE164: '+33612345678', profileName: 'Léa Martin', fields: {},
      optInStatus: 'unknown', tags: [TAG_LIVRE_BLANC],
    }]);
    expect(store.consentements).toEqual([['espace-sandbox', 'c1', 'opted_in', SOURCE_CONSENTEMENT]]);
    expect(traces).toEqual([['espace-sandbox', { userId: null, email: null }, 'contact.optin', { kind: 'contact', id: 'c1' },
      { source: 'api', consentSource: SOURCE_CONSENTEMENT }]]);
  });

  it('un contact qui a dit STOP : la case ne le réabonne pas, rien n’est tracé, et le dépôt ne lève pas', async () => {
    const store = new FauxStore('refuse');
    const traces: unknown[][] = [];
    await depotSandbox(store, async (...t) => { traces.push(t); }, 'espace-sandbox')
      .deposer({ nom: 'Léa Martin', telephoneE164: '+33612345678' });
    expect(store.fiches).toHaveLength(1);
    expect(traces).toEqual([]);
  });
});
