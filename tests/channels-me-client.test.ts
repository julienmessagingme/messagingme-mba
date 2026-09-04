import { describe, it, expect } from 'vitest';
import { ChannelsMeClient, ChannelsMeApiError } from '../src/channels-me/client';
import { signer } from '../src/channels-me/signature';
import type { Connexion } from '../src/channels-me/types';

/**
 * Client HTTP de Channels Me, teste avec un faux `fetch` injecte. Aucun reseau.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Le corps ENVOYE est exactement la chaine SIGNEE. Deux derivations separees produiraient une
 *     signature qui ne correspond pas au corps, l'API repondrait 401, et on accuserait les cles.
 *  2. `Accept: application/json` est pose sur TOUS les appels, GET compris : sans lui l'API rend une page
 *     HTML d'erreur Rails en 500, donc un echec deguise en panne de notre cote.
 *  3. La signature n'est posee que sur les ECRITURES.
 *  4. 🔴 Le corps distant ne se relaie JAMAIS : ni la page HTML, ni un champ voisin du JSON d'erreur, ni
 *     le message d'une exception reseau. Seuls le statut et `error.message` tronque survivent.
 *  5. Une 200 dont le corps n'a pas la forme attendue est un ECHEC, pas un succes aux champs vides.
 */

// Valeurs FICTIVES (aucun secret) : figees pour rendre les assertions lisibles.
const CX: Connexion = { orgId: 'org_1', channelId: 'ch_1', apiKey: 'cle-fictive', secret: 'secret-fictif' };

/** Faux fetch : enregistre les appels et rend des reponses scriptees. Le corps est garde en CHAINE BRUTE,
 *  jamais re-analyse : c'est justement l'octet-pour-octet qu'on veut comparer a ce qui a ete signe. */
function faux(reponses: Array<{ status?: number; body: string; contentType?: string }>) {
  const appels: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  let i = 0;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const r = reponses[Math.min(i, reponses.length - 1)]!;
    i += 1;
    appels.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    });
  };
  return { impl: impl as unknown as typeof fetch, appels };
}

/** Faux fetch qui echoue avant toute reponse. */
function fauxEnPanne(err: Error) {
  const impl = async (): Promise<Response> => { throw err; };
  return impl as unknown as typeof fetch;
}

describe('lectures', () => {
  it('GET organisation : Accept pose, cle d API posee, AUCUNE signature, enveloppe data depliee', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: { id: 7, name: 'Ma chaine' } }) }]);
    const org = await new ChannelsMeClient({ fetch: impl }).getOrganisation(CX);
    expect(org).toEqual({ id: '7', name: 'Ma chaine' });
    expect(appels[0]!.url).toBe('https://api.channels.me/v1/organisations/org_1');
    expect(appels[0]!.method).toBe('GET');
    expect(appels[0]!.headers.Accept).toBe('application/json');
    expect(appels[0]!.headers['X-Api-Key']).toBe('cle-fictive');
    // La signature n'est pas requise sur les GET : en poser une obligerait a canonicaliser une query string.
    expect(appels[0]!.headers['X-Signature']).toBeUndefined();
    expect(appels[0]!.body).toBeUndefined();
  });

  it('GET chaines : la liste est rendue en un appel, sous data', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: [{ id: 1, name: 'A', messages_count: 85 }] }) }]);
    const chaines = await new ChannelsMeClient({ fetch: impl }).listChannels(CX);
    expect(chaines).toEqual([{ id: '1', name: 'A', messages_count: 85 }]);
    expect(appels[0]!.url).toBe('https://api.channels.me/v1/organisations/org_1/message_channels');
    expect(appels[0]!.headers.Accept).toBe('application/json');
  });

  it('GET messages : chemin sous la chaine, liste complete', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }) }]);
    const msgs = await new ChannelsMeClient({ fetch: impl }).getMessages(CX);
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(appels[0]!.url).toBe('https://api.channels.me/v1/organisations/org_1/message_channels/ch_1/messages');
  });
});

describe('ecriture', () => {
  it('🔴 le corps ENVOYE est exactement la chaine SIGNEE', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: { id: 'msg_1' } }) }]);
    const msg = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'Bonjour' });
    expect(msg.id).toBe('msg_1');
    const a = appels[0]!;
    expect(a.method).toBe('POST');
    expect(a.url).toBe('https://api.channels.me/v1/organisations/org_1/message_channels/ch_1/messages');
    expect(a.headers['Content-Type']).toBe('application/json');
    expect(a.headers.Accept).toBe('application/json');
    // La preuve, et elle ne depend d'aucune connaissance de la forme canonique : re-signer le corps
    // REELLEMENT transmis redonne la signature REELLEMENT posee.
    expect(signer(a.body!, CX.secret)).toBe(a.headers['X-Signature']);
    // Et la signature porte sur la structure IMBRIQUEE, pas sur des cles a plat `message[kind]`.
    expect(JSON.parse(a.body!)).toEqual({ message: { kind: 'text', publish_now: true, text: 'Bonjour' } });
  });

  it('avec une image : kind image et media_url, dans le corps signe', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: { id: 'msg_2' } }) }]);
    await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'Voir', mediaUrl: 'https://exemple.test/a.jpg' });
    expect(JSON.parse(appels[0]!.body!)).toEqual({
      message: { kind: 'image', media_url: 'https://exemple.test/a.jpg', publish_now: true, text: 'Voir' },
    });
    expect(signer(appels[0]!.body!, CX.secret)).toBe(appels[0]!.headers['X-Signature']);
  });
});

describe('echecs : le corps distant ne se relaie jamais', () => {
  it('401 : le statut est porte, le reste du corps est jete', async () => {
    const { impl } = faux([{
      status: 401,
      body: JSON.stringify({ error: { message: 'Invalid signature' }, debug: 'donnee-d-un-autre-espace' }),
    }]);
    const err = await new ChannelsMeClient({ fetch: impl }).getOrganisation(CX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelsMeApiError);
    expect((err as ChannelsMeApiError).status).toBe(401);
    expect((err as ChannelsMeApiError).detail).toBe('Invalid signature');
    expect((err as Error).message).not.toContain('donnee-d-un-autre-espace');
  });

  it('422 : seul error.message remonte, tronque a 200 caracteres', async () => {
    const long = 'x'.repeat(300);
    const { impl } = faux([{ status: 422, body: JSON.stringify({ error: { message: long } }) }]);
    const err = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'y' }).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).status).toBe(422);
    expect((err as ChannelsMeApiError).detail).toHaveLength(200);
  });

  it('500 en HTML : rien du corps ne remonte', async () => {
    const { impl } = faux([{ status: 500, body: '<html><body>Rails backtrace secret</body></html>', contentType: 'text/html' }]);
    const err = await new ChannelsMeClient({ fetch: impl }).getMessages(CX).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).status).toBe(500);
    expect((err as ChannelsMeApiError).detail).toBe('');
    expect((err as Error).message).not.toContain('Rails');
  });

  it('panne reseau : statut 0, et le message de l exception ne fuite pas', async () => {
    const client = new ChannelsMeClient({ fetch: fauxEnPanne(new Error('getaddrinfo ENOTFOUND api.channels.me')) });
    const err = await client.getOrganisation(CX).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).status).toBe(0);
    expect((err as Error).message).not.toContain('ENOTFOUND');
  });
});

describe('reponses 200 mal formees', () => {
  it('200 sans enveloppe data : echec', async () => {
    const { impl } = faux([{ body: JSON.stringify({ id: 'msg_1' }) }]);
    const err = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'x' }).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).detail).toBe('reponse inattendue');
  });

  it('🔴 200 dont le message n a pas d identifiant : echec, pas un succes au champ vide', async () => {
    const { impl } = faux([{ body: JSON.stringify({ data: { text: 'publie' } }) }]);
    const err = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelsMeApiError);
    expect((err as ChannelsMeApiError).detail).toBe('reponse inattendue');
  });

  it('200 au corps illisible : echec', async () => {
    const { impl } = faux([{ body: 'pas du json du tout' }]);
    const err = await new ChannelsMeClient({ fetch: impl }).getMessages(CX).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).detail).toBe('reponse inattendue');
  });
});
