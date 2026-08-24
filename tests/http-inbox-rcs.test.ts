import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { InboxRouteDeps } from '../src/http/inbox';

const SECRET = 'test-secret';
let token = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

type Journal = Array<{ body: string; type?: string; canal?: string; sender?: string | null }>;

/** `windowOpen` FERMEE par defaut : c'est le cas qui compte pour le RCS. */
function app(over: Partial<InboxRouteDeps> = {}, windowOpen = false) {
  const journal: Journal = [];
  const priseDeControle: string[] = [];
  const deps: InboxRouteDeps = {
    listConversations: async () => [],
    getConversationContext: async (id) => (id === 'c1' ? { waId: '33611', windowOpen, lastInboundAt: null } : null),
    getMessages: async () => [],
    recordOutbound: async (_id, body, _msg, type, _cat, _name, sender, canal) => {
      journal.push({ body, type, canal, sender });
    },
    takeControl: async (_t, waId) => { priseDeControle.push(waId); },
    getTenantPhoneNumberId: async () => 'pn1',
    sendReply: async () => 'wamid.OUT',
    sendTemplateMessage: async () => 'wamid.TPL',
    sendRcsFromLibrary: async () => ({ messageId: 'rcs-1', apercu: 'Bonjour Julien' }),
    ...over,
  };
  const a = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, inbox: deps });
  return { a, journal, priseDeControle };
}

const envoi = (payload: Record<string, unknown> = { rcsMessageId: 'lib-1' }) =>
  ({ method: 'POST' as const, url: '/tenants/t1/conversations/c1/send-rcs', ...auth(), payload });

describe('Envoyer un RCS depuis l inbox', () => {
  /**
   * 🔴 LE point de cette route. La fenetre de 24 h est une regle de WhatsApp, pas une regle du monde : le RCS
   * n'en a pas. C'est meme precisement quand la fenetre est fermee qu'il devient le moyen de reprendre
   * contact sans template a faire approuver. Une garde de fenetre ici serait une limite inventee.
   */
  it('envoie MEME quand la fenetre WhatsApp de 24 h est fermee', async () => {
    const { a, journal } = app({}, false);
    const r = await a.inject(envoi());
    expect(r.statusCode).toBe(200);
    expect(r.json().messageId).toBe('rcs-1');
    expect(journal).toEqual([{ body: 'Bonjour Julien', type: 'rcs', canal: 'rcs', sender: 'u1' }]);
    await a.close();
  });

  it('l operateur PREND le fil, comme sur une reponse texte', async () => {
    const { a, priseDeControle } = app();
    await a.inject(envoi());
    expect(priseDeControle).toEqual(['33611']);
    await a.close();
  });

  /**
   * Chaque refus porte sa RAISON : « le canal n'est pas active » et « ce contact s'est desabonne » demandent
   * deux gestes differents. Et en 422, jamais en 5xx, dont Cloudflare remplace le corps par sa page d'erreur.
   */
  it('rend la RAISON du refus en 422, et n enregistre rien', async () => {
    const { a, journal } = app({ sendRcsFromLibrary: async () => ({ refus: 'Ce contact s’est désabonné du RCS.' }) });
    const r = await a.inject(envoi());
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain('désabonné');
    expect(journal).toHaveLength(0);
    await a.close();
  });

  it('repond 422 quand le canal RCS n est pas cable du tout', async () => {
    const { a } = app({ sendRcsFromLibrary: undefined });
    const r = await a.inject(envoi());
    expect(r.statusCode).toBe(422);
    await a.close();
  });

  it('exige un message de la bibliotheque', async () => {
    const { a, journal } = app();
    expect((await a.inject(envoi({}))).statusCode).toBe(400);
    expect((await a.inject(envoi({ rcsMessageId: '  ' }))).statusCode).toBe(400);
    expect(journal).toHaveLength(0);
    await a.close();
  });

  it('404 sur une conversation qui n est pas de ce workspace', async () => {
    const { a } = app();
    const r = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/inconnue/send-rcs', ...auth(), payload: { rcsMessageId: 'lib-1' } });
    expect(r.statusCode).toBe(404);
    await a.close();
  });

  /**
   * Meme garde que la reponse texte : un AGENT n'ecrit pas dans le fil confie a quelqu'un d'autre. (Un admin
   * ou un manager, lui, peut toujours reprendre la main : c'est la regle de `peutEcrire`, et la proteger ici
   * reviendrait a la reecrire.) Sans cette ligne dans la route, le RCS serait la porte ouverte pendant que
   * les deux autres restent fermees.
   */
  it('REFUSE a un AGENT le fil confie a un autre', async () => {
    const jetonAgent = await signSession({ userId: 'u-autre', tenantId: 't1', role: 'agent' }, SECRET);
    const { a, journal } = app({ getAssignee: async () => 'u-affecte', setAssignee: async () => true });
    const r = await a.inject({
      method: 'POST',
      url: '/tenants/t1/conversations/c1/send-rcs',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jetonAgent}` },
      payload: { rcsMessageId: 'lib-1' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('assigned_to_other');
    expect(journal).toHaveLength(0);
    await a.close();
  });
});

/**
 * Les variables d'un template, resolues sur la fiche du contact ouvert.
 *
 * 🔴 Pourquoi : l'ecran d'envoi demandait `{{1}}`, `{{2}}` en texte libre, sans dire ce qu'ils attendaient.
 * L'operateur devait se souvenir que `{{1}}` etait le prenom et le retaper, alors que la fiche le porte et
 * que le template dit deja quel champ l'alimente.
 */
describe('Variables d un template resolues pour la conversation', () => {
  const url = '/tenants/t1/conversations/c1/template-params?name=rdv&language=fr&count=2';

  it('rend les valeurs DEJA remplies, et le libelle du champ qui les alimente', async () => {
    const { a } = app({
      resolveTemplateParams: async (_t, waId, tpl) => {
        expect(waId).toBe('33611');
        expect(tpl).toEqual({ name: 'rdv', language: 'fr', count: 2 });
        return { values: ['Julien', 'Lyon'], labels: ['prenom', 'ville'] };
      },
    });
    const r = await a.inject({ method: 'GET', url, ...auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ values: ['Julien', 'Lyon'], labels: ['prenom', 'ville'] });
    await a.close();
  });

  it('rend du VIDE plutot qu une erreur quand la resolution n est pas cablee', async () => {
    const { a } = app({ resolveTemplateParams: undefined });
    const r = await a.inject({ method: 'GET', url, ...auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ values: [], labels: [] });
    await a.close();
  });

  it('refuse une demande mal formee, et une conversation d un autre workspace', async () => {
    const { a } = app();
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/template-params?count=2', ...auth() })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/template-params?name=rdv&language=fr&count=99', ...auth() })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/conversations/inconnue/template-params?name=rdv&language=fr&count=1', ...auth() })).statusCode).toBe(404);
    await a.close();
  });
});
