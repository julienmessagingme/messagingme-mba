import { describe, it, expect, vi, afterEach } from 'vitest';
import { MetaClientFactory } from '../src/meta/factory';
import { MetaCredentialsResolver, type CredentialsResolverDeps } from '../src/meta/credentials';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import { MetaApiError, estPlafondNumero } from '../src/meta/errors';
import { creerListeDeLAgent, RetraitDeLaListeRefuse, type ListeDeLAgent } from '../src/mba/liste';
import { listeEnMemoire } from './banc-du-fil';

/** Aucun numéro délié (migration 0180) : ces tests ne portent pas sur le geste de l'Accueil, et le DISENT. */
const jamaisDelie = async (): Promise<boolean> => false;
/**
 * Aucun contact sur la liste de l'agent de Meta : le retrait avant un modèle ne fait rien, comme avant le mode liste.
 * Ces tests ne portent pas sur la liste, et le DISENT.
 */
const listeToujoursVide: Pick<ListeDeLAgent, 'retirerAvantUnModele'> = { retirerAvantUnModele: async () => {} };

// Transport factice : capture le header Authorization de chaque envoi, réponse programmable (pour simuler une 401).
class FakeTransport implements HttpTransport {
  readonly bearers: string[] = [];
  constructor(private readonly responses: HttpResponse[] = []) {}
  async post(_url: string, _body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.bearers.push(headers['Authorization'] ?? '');
    return this.responses.shift() ?? { status: 200, json: { messages: [{ id: 'wamid.ok' }] } };
  }
}

function resolver(over: {
  tenants?: Record<string, string>;
  creds?: Record<string, { businessTokenEnc: string; tokenStatus: 'active' | 'invalid' }>;
} = {}) {
  const tenants = over.tenants ?? {};
  const creds = over.creds ?? {};
  const invalidated: string[] = [];
  const deps: CredentialsResolverDeps = {
    getWabaIdForTenant: async (t) => tenants[t] ?? null,
    credentials: {
      getCredentialsByWaba: async (w) => creds[w] ?? null,
      markTokenInvalid: async (w) => { invalidated.push(w); },
    },
    decrypt: (enc) => enc.replace(/^enc:/, ''),
    fallbackToken: 'GLOBAL',
  };
  return { resolver: new MetaCredentialsResolver(deps), invalidated };
}

function factory(r: MetaCredentialsResolver, transport: HttpTransport) {
  return new MetaClientFactory({ resolver: r, transport, version: 'v25.0', marketingViaLite: false, numerosDelies: { estDelie: jamaisDelie }, listeDeLAgent: listeToujoursVide });
}

describe('MetaClientFactory (B1 : câblage par tenant)', () => {
  it('deux tenants -> deux senders qui envoient avec des Bearer différents', async () => {
    const t = new FakeTransport();
    const { resolver: r } = resolver({
      tenants: { tA: 'wA', tB: 'wB' },
      creds: { wA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' }, wB: { businessTokenEnc: 'enc:TOK_B', tokenStatus: 'active' } },
    });
    const f = factory(r, t);
    await (await f.senderForTenant('tA', 'pnA')).sendTemplate('33600000001', { name: 'promo', language: 'fr' });
    await (await f.senderForTenant('tB', 'pnB')).sendTemplate('33600000002', { name: 'promo', language: 'fr' });
    expect(t.bearers).toEqual(['Bearer TOK_A', 'Bearer TOK_B']);
  });

  it('SOMMEIL : un tenant sans credentials -> le sender envoie avec le token global', async () => {
    const t = new FakeTransport();
    const { resolver: r } = resolver({ tenants: { tA: 'wA' }, creds: {} });
    const f = factory(r, t);
    await (await f.senderForTenant('tA', 'pnA')).sendTemplate('33600000001', { name: 'promo', language: 'fr' });
    expect(t.bearers).toEqual(['Bearer GLOBAL']);
  });

  it('intercepteur : une 401 (OAuthException) à l\'envoi invalide le WABA du tenant', async () => {
    const t = new FakeTransport([{ status: 401, json: { error: { code: 190, type: 'OAuthException', message: 'token révoqué' } } }]);
    const { resolver: r, invalidated } = resolver({
      tenants: { tA: 'wA' },
      creds: { wA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' } },
    });
    const f = factory(r, t);
    const sender = await f.senderForTenant('tA', 'pnA');
    await expect(sender.sendTemplate('33600000001', { name: 'promo', language: 'fr' })).rejects.toBeTruthy();
    expect(invalidated).toEqual(['wA']); // le WABA est marqué invalide (on n'enverra plus dessus)
  });

  it('intercepteur : en SOMMEIL (wabaId null), une 401 n\'invalide rien', async () => {
    const t = new FakeTransport([{ status: 401, json: { error: { code: 190, type: 'OAuthException', message: 'x' } } }]);
    const { resolver: r, invalidated } = resolver({ tenants: { tA: 'wA' }, creds: {} }); // pas de credentials -> fallback
    const f = factory(r, t);
    const sender = await f.senderForTenant('tA', 'pnA');
    await expect(sender.sendTemplate('33600000001', { name: 'promo', language: 'fr' })).rejects.toBeTruthy();
    expect(invalidated).toEqual([]); // token global : aucun WABA propre à invalider
  });

  it('intercepteur : couvre AUSSI clientForTenant (envois workflow), pas seulement senderForTenant', async () => {
    const t = new FakeTransport([{ status: 401, json: { error: { code: 190, type: 'OAuthException', message: 'x' } } }]);
    const { resolver: r, invalidated } = resolver({
      tenants: { tA: 'wA' },
      creds: { wA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' } },
    });
    const f = factory(r, t);
    const client = await f.clientForTenant('tA', 'pnA'); // le chemin des envois workflow (sendTemplate/interactive/flow)
    await expect(client.sendText('33600000001', 'coucou')).rejects.toBeTruthy();
    expect(invalidated).toEqual(['wA']); // un token révoqué détecté sur un envoi workflow s'auto-invalide aussi
  });
});

/**
 * FREIN PAR NUMÉRO (lot 4 du programme, 2026-08-31).
 *
 * 🔴 C'est ICI que le lot se joue, et pas dans l'arbitre. L'arbitre seul ne freine rien : c'est le fait que
 * la fabrique donne à CHAQUE client la porte de SON numéro qui fait qu'une campagne, un scénario, une
 * automation et une réponse d'inbox se partagent un budget. Un jour où cette ligne saute, l'arbitre continue
 * de rendre des portes que plus personne n'acquiert, et rien ne le signale.
 */
describe('MetaClientFactory : le frein par numéro est réellement câblé', () => {
  function arbitreEspion() {
    const demandes: string[] = [];
    const acquisitions: string[] = [];
    const portes = new Map<string, { acquire: () => Promise<void> }>();
    return {
      demandes,
      acquisitions,
      arbitre: {
        pour(pn: string) {
          demandes.push(pn);
          let p = portes.get(pn);
          if (!p) { p = { acquire: async () => { acquisitions.push(pn); } }; portes.set(pn, p); }
          return p;
        },
      },
    };
  }

  it('🔴 envoyer consomme la porte DU NUMÉRO', async () => {
    const t = new FakeTransport();
    const { resolver: r } = resolver({ tenants: { t1: 'w1' }, creds: { w1: { businessTokenEnc: 'enc:TOK', tokenStatus: 'active' } } });
    const espion = arbitreEspion();
    const f = new MetaClientFactory({ resolver: r, transport: t, version: 'v25.0', marketingViaLite: false, arbitreDebit: espion.arbitre, numerosDelies: { estDelie: jamaisDelie }, listeDeLAgent: listeToujoursVide });

    const client = await f.clientForTenant('t1', 'pn-42');
    await client.sendText('33600000001', 'bonjour');
    await client.sendText('33600000002', 'bonjour');

    expect(espion.demandes).toEqual(['pn-42']); // la porte est demandée à la construction du client
    expect(espion.acquisitions).toEqual(['pn-42', 'pn-42']); // et acquise à CHAQUE envoi
  });

  it('🔴 deux clients du MÊME numéro partagent la même porte (campagne + inbox = un seul budget)', async () => {
    const t = new FakeTransport();
    const { resolver: r } = resolver({ tenants: { t1: 'w1' }, creds: { w1: { businessTokenEnc: 'enc:TOK', tokenStatus: 'active' } } });
    const espion = arbitreEspion();
    const f = new MetaClientFactory({ resolver: r, transport: t, version: 'v25.0', marketingViaLite: false, arbitreDebit: espion.arbitre, numerosDelies: { estDelie: jamaisDelie }, listeDeLAgent: listeToujoursVide });

    // Deux constructions distinctes, comme le font le moteur de campagne et la route d'inbox.
    const campagne = await f.senderForTenant('t1', 'pn-42');
    const inbox = await f.clientForTenant('t1', 'pn-42');
    await campagne.sendTemplate('33600000001', { name: 'promo', language: 'fr' });
    await inbox.sendText('33600000002', 'je vous réponds');

    // Les DEUX envois ont consommé le budget du même numéro : c'est exactement ce qui manquait.
    expect(espion.acquisitions).toEqual(['pn-42', 'pn-42']);
  });

  it('sans arbitre injecté (fixtures de test) -> aucun frein, comportement d’avant', async () => {
    const t = new FakeTransport();
    const { resolver: r } = resolver({ tenants: { t1: 'w1' }, creds: { w1: { businessTokenEnc: 'enc:TOK', tokenStatus: 'active' } } });
    const client = await factory(r, t).clientForTenant('t1', 'pn-42');
    await expect(client.sendText('33600000001', 'bonjour')).resolves.toMatchObject({ messageId: 'wamid.ok' });
  });
});

/**
 * 🔴 RÈGLE 1 DU MODE LISTE : AUCUN MODÈLE NE PART VERS UN CONTACT QUE L'AGENT DE META A SUR SA LISTE.
 *
 * Mesuré le 2026-09-29 : un modèle rend la conversation à l'agent chez Meta, et la réponse du contact arrive en
 * `standby`. Sur la liste, l'agent y répond à la place du scénario. La fabrique est le point de passage de tous les
 * envois (scénario, campagne, Inbox) : c'est elle qui retire le destinataire, AVANT l'envoi, et un retrait refusé
 * veut dire aucun envoi. Vérifié dans les deux sens : l'enveloppe retirée de `clientForTenant`, les deux premiers
 * cas échouent (l'envoi part et le contact reste sur la liste).
 */
describe('MetaClientFactory : le destinataire quitte la liste de l’agent avant tout modèle', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** La vraie liste, sur une table en mémoire, et un faux client MBA qui écrit dans le même journal que l'envoi. */
  function monter(o: { surLaListe?: string[]; retrait?: 'accepte' | 'refuse' } = {}) {
    const journal: string[] = [];
    const transport: HttpTransport = {
      post: async (_url, body) => {
        const b = body as { to?: string; recipient?: string; type?: string };
        journal.push(`envoi:${b.type}:${b.to ?? b.recipient}`);
        return { status: 200, json: { messages: [{ id: 'wamid.ok' }] } };
      },
    };
    const table = listeEnMemoire(o.surLaListe ?? []);
    const liste = creerListeDeLAgent({
      store: table.store,
      clientMba: async () => ({
        listAllowlist: async () => [],
        addToAllowlist: async () => { throw new Error('aucun ajout ici'); },
        removeFromAllowlist: async (_pn: string, entree: string) => {
          journal.push(`retrait:${entree}`);
          if (o.retrait === 'refuse') throw new MetaApiError(403, { message: 'refusé' });
        },
      }),
      attendre: async () => {},
    });
    const { resolver: r } = resolver({ tenants: { t1: 'w1' }, creds: { w1: { businessTokenEnc: 'enc:TOK', tokenStatus: 'active' } } });
    const f = new MetaClientFactory({ resolver: r, transport, version: 'v25.0', marketingViaLite: false, numerosDelies: { estDelie: jamaisDelie }, listeDeLAgent: liste });
    return { f, journal, table: table.lignes };
  }
  const MODELE = { name: 'promo', language: 'fr' };

  it('🔴 un contact sur la liste en est retiré AVANT le modèle, par `sendTemplate` comme par `sendMarketing`', async () => {
    const m = monter({ surLaListe: ['33600000001', '33600000002'] });
    const client = await m.f.clientForTenant('t1', 'pn1');
    await client.sendTemplate('+33600000001', MODELE);
    await client.sendMarketing({ to: '33600000002', template: MODELE });
    expect(m.journal).toEqual([
      'retrait:entree-33600000001', 'envoi:template:+33600000001',
      'retrait:entree-33600000002', 'envoi:template:33600000002',
    ]);
    expect([...m.table.keys()]).toEqual([]);
  });

  it('🔴 le client de campagne (`senderForTenant`) passe par la MÊME garde', async () => {
    const m = monter({ surLaListe: ['33600000001'] });
    await (await m.f.senderForTenant('t1', 'pn1')).sendTemplate('+33600000001', MODELE);
    expect(m.journal).toEqual(['retrait:entree-33600000001', 'envoi:template:+33600000001']);
  });

  it('🔴 un retrait refusé veut dire AUCUN envoi, et l’erreur est un refus temporaire, jamais un plafond du numéro', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = monter({ surLaListe: ['33600000001'], retrait: 'refuse' });
    const client = await m.f.clientForTenant('t1', 'pn1');
    const err = await client.sendTemplate('+33600000001', MODELE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetraitDeLaListeRefuse);
    expect((err as MetaApiError).retryable, 'classify la range en rejouable').toBe(true);
    // Un plafond mettrait toute la campagne en pause pour le refus d'un seul contact.
    expect(estPlafondNumero(err)).toBe(false);
    await expect(client.sendMarketing({ to: '33600000001', template: MODELE })).rejects.toBeInstanceOf(RetraitDeLaListeRefuse);
    expect(m.journal.filter((l) => l.startsWith('envoi:')), 'un modèle est parti vers un contact de la liste').toEqual([]);
    expect(m.table.has('33600000001')).toBe(true);
  });

  it('un contact absent de la liste : aucun appel à Meta, le modèle part', async () => {
    const m = monter();
    await (await m.f.clientForTenant('t1', 'pn1')).sendTemplate('33600000001', MODELE);
    expect(m.journal).toEqual(['envoi:template:33600000001']);
  });

  it('⚠️ un message libre ne retire rien : il nous donne la conversation chez Meta', async () => {
    const m = monter({ surLaListe: ['33600000001'] });
    const client = await m.f.clientForTenant('t1', 'pn1');
    await client.sendText('33600000001', 'bonjour');
    await client.sendInteractive('33600000001', 'Oui ou non ?', [{ text: 'Oui' }]);
    expect(m.journal).toEqual(['envoi:text:33600000001', 'envoi:interactive:33600000001']);
    expect(m.table.has('33600000001')).toBe(true);
  });

  it('⚠️ un BSUID n’est jamais sur la liste : il ne se réduit pas aux chiffres d’un numéro', async () => {
    const m = monter({ surLaListe: ['13491208655'] });
    await (await m.f.clientForTenant('t1', 'pn1')).sendTemplate('US.13491208655', MODELE);
    expect(m.journal).toEqual(['envoi:template:US.13491208655']);
    expect(m.table.has('13491208655')).toBe(true);
  });

  it('🔴 la liste est REQUISE par le type de la fabrique', () => {
    const { resolver: r } = resolver();
    // @ts-expect-error `listeDeLAgent` manque : un câblage qui l'oublierait laisserait partir le modèle.
    const sansListe = new MetaClientFactory({ resolver: r, transport: { post: async () => ({ status: 200, json: {} }) }, version: 'v25.0', marketingViaLite: false, numerosDelies: { estDelie: jamaisDelie } });
    expect(sansListe).toBeInstanceOf(MetaClientFactory);
  });
});
