import { describe, it, expect } from 'vitest';
import {
  destinationsTracables, aDesLiensTracables, appliquerLiensRcs, estTracable, URL_TRACABLE_MAX,
} from '../src/links/rcs-liens';
import { liensRcsDesNoeuds, compteursDeClicsRcs } from '../src/links/mesures';
import { TraceurLiensRcs } from '../src/links/traceur-rcs';
import { lienDe, lienPourContact, lienTraceAvecJeton } from '../src/links/rewrite';
import { RcsSender } from '../src/rcs/sender';
import { Reachability } from '../src/rcs/reachability';
import type { ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';
import { makeCampaignSender } from '../src/campaign/sender';
import { lancerCampagne, type DepsMoteurDeTest } from './campagne-canaux';
import type { RecipientStore, CampaignStore } from '../src/campaign/engine';
import type { Campaign, Recipient } from '../src/campaign/types';
import type { RcsOutbound } from '../src/rcs/types';

/**
 * SAVOIR QUI A CLIQUÉ, EN RCS (migration 0107).
 *
 * Julien, le 2026-09-02 : « il faut aussi que ça marche si j'envoie un RCS hein ? ».
 *
 * 🔴 CE QUI REND LE RCS DIFFÉRENT, ET CE QUE CE FICHIER PROTÈGE. Un template WhatsApp est SOUMIS puis figé :
 * son URL ne peut porter qu'un `{{1}}` que chaque envoi doit remplir par un composant de bouton, et se
 * tromper d'un côté comme de l'autre fait échouer l'appel (132000). Un message RCS est composé À L'ENVOI :
 * on y écrit le jeton lui-même. Pas de variable, pas de resoumission, pas de « tout ou rien ».
 */

const btn = (url: string) => ({ kind: 'openUrl' as const, text: 'Voir', url, postbackData: 'p1' });
const BASE = 'https://mba.test';

describe('quelle adresse d’un message RCS est traçable', () => {
  it('les liens du message, ceux de la carte, et ceux de chaque carte d’un carrousel', () => {
    expect(destinationsTracables({ kind: 'text', text: 'Bonjour', suggestions: [btn('https://a.fr/1')] }))
      .toEqual(['https://a.fr/1']);
    expect(destinationsTracables({
      kind: 'card',
      card: { title: 'Offre', suggestions: [btn('https://a.fr/carte')] },
      suggestions: [btn('https://a.fr/pastille')],
    })).toEqual(['https://a.fr/carte', 'https://a.fr/pastille']);
    expect(destinationsTracables({
      kind: 'carousel',
      cards: [{ title: 'A', suggestions: [btn('https://a.fr/1')] }, { title: 'B', suggestions: [btn('https://a.fr/2')] }],
    })).toEqual(['https://a.fr/1', 'https://a.fr/2']);
  });

  it('la MÊME adresse deux fois ne compte qu’une, la maille étant l’adresse', () => {
    // Deux boutons vers la même page partagent un code : c'est la clé de la 0107, et c'est aussi ce qui
    // évite deux allocations pour un seul message.
    expect(destinationsTracables({
      kind: 'card',
      card: { title: 'Offre', suggestions: [btn('https://a.fr/x')] },
      suggestions: [btn('https://a.fr/x')],
    })).toEqual(['https://a.fr/x']);
  });

  it('ignore tout bouton qui n’est pas un lien', () => {
    const msg: RcsOutbound = {
      kind: 'text',
      text: 'Bonjour',
      suggestions: [
        { kind: 'reply', text: 'Oui', postbackData: 'btn:0' },
        { kind: 'dial', text: 'Appeler', phoneNumber: '+33100000000', postbackData: 'p' },
        { kind: 'requestLocation', text: 'Position', postbackData: 'p' },
      ],
    };
    expect(destinationsTracables(msg)).toEqual([]);
    expect(aDesLiensTracables(msg)).toBe(false);
  });

  it('🔴 refuse une URL qui porte une VARIABLE, parce que le RCS ne substitue jamais une URL', () => {
    // `src/rcs/variables.ts` l'écrit noir sur blanc : « PAS les URL ». Tracer `https://a.fr/{{id}}` figerait
    // une adresse cassée derrière un code, et le clic mènerait à une page qui n'existe pas.
    expect(estTracable('https://a.fr/{{id}}')).toBe(false);
    expect(destinationsTracables({ kind: 'text', text: 'x', suggestions: [btn('https://a.fr/{{id}}')] })).toEqual([]);
  });

  it('refuse une adresse que le provider refuserait de toute façon', () => {
    expect(estTracable('exemple.fr/sans-schema')).toBe(false);
    expect(estTracable('https://sansdomaine')).toBe(false);
    expect(estTracable('')).toBe(false);
  });

  it('🔴 refuse une adresse démesurée : la clé d’unicité de la 0107 porte sur la destination', () => {
    // Un index btree refuse une valeur trop longue. L'allocation échouerait, donc l'envoi. On préfère un
    // lien non mesuré à un message qui ne part pas.
    const longue = `https://a.fr/${'x'.repeat(URL_TRACABLE_MAX)}`;
    expect(longue.length).toBeGreaterThan(URL_TRACABLE_MAX);
    expect(estTracable(longue)).toBe(false);
    expect(estTracable(`https://a.fr/${'x'.repeat(URL_TRACABLE_MAX - 20)}`)).toBe(true);
  });
});

describe('la substitution des liens dans un message RCS', () => {
  const liens = new Map([['https://a.fr/x', `${BASE}/r/abcdefghjkmn/jetondujour1234`]]);

  it('remplace le lien du bouton et ne touche à rien d’autre', () => {
    const msg: RcsOutbound = {
      kind: 'card',
      card: { title: 'Offre', description: 'Texte', mediaUrl: 'https://img.fr/1.png', suggestions: [btn('https://a.fr/x')] },
      suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'btn:0' }],
    };
    const out = appliquerLiensRcs(msg, liens) as Extract<RcsOutbound, { kind: 'card' }>;
    expect(out.card.suggestions?.[0]).toMatchObject({ kind: 'openUrl', text: 'Voir', url: liens.get('https://a.fr/x') });
    // Le reste de la carte survit intact : un visuel perdu à l'envoi serait invisible en relecture.
    expect(out.card).toMatchObject({ title: 'Offre', description: 'Texte', mediaUrl: 'https://img.fr/1.png' });
    expect(out.suggestions?.[0]).toEqual({ kind: 'reply', text: 'Oui', postbackData: 'btn:0' });
  });

  it('rend le message TEL QUEL quand il n’y a rien à remplacer', () => {
    // Même référence : le point d'envoi unique chaîne plusieurs mises en forme et teste l'identité pour
    // savoir si le message a bougé.
    const msg: RcsOutbound = { kind: 'text', text: 'Bonjour', suggestions: [btn('https://autre.fr/y')] };
    expect(appliquerLiensRcs(msg, liens)).toBe(msg);
    expect(appliquerLiensRcs(msg, new Map())).toBe(msg);
  });

  it('une adresse absente de la table sort INCHANGÉE, le bouton mène toujours au bon endroit', () => {
    // C'est le comportement voulu quand une allocation a échoué : mesure perdue, message intact.
    const msg: RcsOutbound = { kind: 'text', text: 'x', suggestions: [btn('https://a.fr/x'), btn('https://b.fr/y')] };
    const out = appliquerLiensRcs(msg, liens) as Extract<RcsOutbound, { kind: 'text' }>;
    expect(out.suggestions?.[0]).toMatchObject({ url: liens.get('https://a.fr/x') });
    expect(out.suggestions?.[1]).toMatchObject({ url: 'https://b.fr/y' });
  });

  it('traite chaque carte d’un carrousel', () => {
    const msg: RcsOutbound = {
      kind: 'carousel',
      cards: [{ title: 'A', suggestions: [btn('https://a.fr/x')] }, { title: 'B', suggestions: [btn('https://b.fr/y')] }],
    };
    const out = appliquerLiensRcs(msg, liens) as Extract<RcsOutbound, { kind: 'carousel' }>;
    expect(out.cards[0]!.suggestions?.[0]).toMatchObject({ url: liens.get('https://a.fr/x') });
    expect(out.cards[1]!.suggestions?.[0]).toMatchObject({ url: 'https://b.fr/y' });
  });
});

describe('l’adresse écrite dans un message RCS', () => {
  it('🔴 porte le JETON LUI-MÊME, jamais la variable {{1}} des templates', () => {
    // La distinction porte tout le lot : un `{{1}}` dans un message RCS partirait tel quel chez l'opérateur,
    // et le contact verrait des accolades dans son navigateur.
    expect(lienPourContact(BASE, 'abcdefghjkmn', 'jetondujour1234')).toBe(`${BASE}/r/abcdefghjkmn/jetondujour1234`);
    expect(lienTraceAvecJeton(BASE, 'abcdefghjkmn')).toBe(`${BASE}/r/abcdefghjkmn/{{1}}`);
    expect(lienPourContact(BASE, 'abcdefghjkmn', 'jetondujour1234')).not.toContain('{{');
  });

  it('sans jeton, rend l’adresse nue : le clic compte, il n’est rattaché à personne', () => {
    expect(lienPourContact(BASE, 'abcdefghjkmn')).toBe(lienDe(BASE, 'abcdefghjkmn'));
  });
});

/** Dépôt d'allocation instrumenté : compte les appels, et sait échouer sur commande. */
class DepotEspion {
  readonly appels: Array<{ tenantId: string; destination: string }> = [];
  constructor(private readonly echoue = false) {}
  async allocateRcs(tenantId: string, code: string, destination: string): Promise<string> {
    this.appels.push({ tenantId, destination });
    if (this.echoue) throw new Error('base indisponible');
    // Un code STABLE par adresse, comme l'index unique de la 0107 le garantit en base.
    return `code${destination.length}`;
  }
}

const codes = (): (() => string) => {
  let n = 0;
  return () => `code-neuf-${n++}`;
};

describe('le traceur de liens RCS', () => {
  it('écrit notre adresse de redirection avec le jeton du destinataire', async () => {
    const depot = new DepotEspion();
    const traceur = new TraceurLiensRcs(depot, BASE, codes());
    const out = await traceur.tracer('t1', { kind: 'text', text: 'x', suggestions: [btn('https://a.fr/x')] }, 'jetonducontact1');
    expect((out as Extract<RcsOutbound, { kind: 'text' }>).suggestions?.[0])
      .toMatchObject({ url: `${BASE}/r/code14/jetonducontact1` });
  });

  it('🔴 n’alloue QU’UNE FOIS par adresse, même sur 500 envois', async () => {
    // Sans le cache, une campagne de 5 000 destinataires ferait 5 000 allocations de la même adresse, sur le
    // chemin le plus chaud du produit.
    const depot = new DepotEspion();
    const traceur = new TraceurLiensRcs(depot, BASE, codes());
    const msg: RcsOutbound = { kind: 'text', text: 'x', suggestions: [btn('https://a.fr/x')] };
    for (let i = 0; i < 500; i++) await traceur.tracer('t1', msg, `jeton-${i}`);
    expect(depot.appels).toHaveLength(1);
  });

  it('le même code pour tous, un jeton DIFFÉRENT par destinataire', async () => {
    const traceur = new TraceurLiensRcs(new DepotEspion(), BASE, codes());
    const msg: RcsOutbound = { kind: 'text', text: 'x', suggestions: [btn('https://a.fr/x')] };
    const urls = await Promise.all(['jetonA', 'jetonB'].map(async (j) => {
      const o = await traceur.tracer('t1', msg, j) as Extract<RcsOutbound, { kind: 'text' }>;
      return (o.suggestions?.[0] as { url: string }).url;
    }));
    expect(urls).toEqual([`${BASE}/r/code14/jetonA`, `${BASE}/r/code14/jetonB`]);
  });

  it('🔴 sépare les espaces : le cache est clé par tenant', async () => {
    // Un code partagé entre deux clients ferait compter les clics de l'un chez l'autre.
    const depot = new DepotEspion();
    const traceur = new TraceurLiensRcs(depot, BASE, codes());
    const msg: RcsOutbound = { kind: 'text', text: 'x', suggestions: [btn('https://a.fr/x')] };
    await traceur.tracer('t1', msg);
    await traceur.tracer('t2', msg);
    expect(depot.appels.map((a) => a.tenantId)).toEqual(['t1', 't2']);
  });

  it('🔴 une allocation en échec laisse l’adresse D’ORIGINE : mesure perdue, message intact', async () => {
    const traceur = new TraceurLiensRcs(new DepotEspion(true), BASE, codes());
    const out = await traceur.tracer('t1', { kind: 'text', text: 'x', suggestions: [btn('https://a.fr/x')] }, 'jeton');
    expect((out as Extract<RcsOutbound, { kind: 'text' }>).suggestions?.[0]).toMatchObject({ url: 'https://a.fr/x' });
  });

  it('ne trace pas une adresse qui est DÉJÀ une de nos redirections', async () => {
    // Sinon un renvoi fabriquerait un code qui redirige vers un code, et le compteur d'origine cesserait de
    // bouger sans que rien ne le dise.
    const depot = new DepotEspion();
    const traceur = new TraceurLiensRcs(depot, BASE, codes());
    await traceur.tracer('t1', { kind: 'text', text: 'x', suggestions: [btn(`${BASE}/r/abcdefghjkmn`)] });
    expect(depot.appels).toHaveLength(0);
  });

  it('ne touche pas la base pour un message sans lien', async () => {
    const depot = new DepotEspion();
    const traceur = new TraceurLiensRcs(depot, BASE, codes());
    const msg: RcsOutbound = { kind: 'text', text: 'Bonjour' };
    expect(await traceur.tracer('t1', msg, 'jeton')).toBe(msg);
    expect(depot.appels).toHaveLength(0);
  });
});

class SansCache implements ReachabilityStore {
  async get() { return null; }
  async put() { /* rien */ }
}

function senderAvec(traceur?: ConstructorParameters<typeof RcsSender>[3]) {
  const provider = new FakeRcsProvider();
  const sender = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), { isOptedOut: async () => false }, traceur);
  return { provider, sender };
}

describe('le point d’envoi unique trace les liens', () => {
  const msg: RcsOutbound = { kind: 'text', text: 'x', suggestions: [btn('https://a.fr/x')] };

  it('ce qui part chez l’opérateur porte l’adresse tracée', async () => {
    const { provider, sender } = senderAvec(new TraceurLiensRcs(new DepotEspion(), BASE, codes()));
    await sender.sendTo('t1', 'agent-1', '+33600000001', msg, 'm1', 'jetondujour');
    const envoye = provider.sent[0]!.msg as Extract<RcsOutbound, { kind: 'text' }>;
    expect(envoye.suggestions?.[0]).toMatchObject({ url: `${BASE}/r/code14/jetondujour` });
  });

  it('sans traceur câblé, le message part inchangé (le comportement d’avant)', async () => {
    const { provider, sender } = senderAvec();
    await sender.sendTo('t1', 'agent-1', '+33600000001', msg, 'm1', 'jetondujour');
    expect((provider.sent[0]!.msg as Extract<RcsOutbound, { kind: 'text' }>).suggestions?.[0])
      .toMatchObject({ url: 'https://a.fr/x' });
  });

  it('🔴 un traceur qui LÈVE ne fait pas échouer l’envoi', async () => {
    // Doctrine du canal, écrite dans le sender : un message part toujours. Une panne de mesure ne doit
    // jamais coûter un message à un client.
    const { provider, sender } = senderAvec({ tracer: async () => { throw new Error('boum'); } });
    const out = await sender.sendTo('t1', 'agent-1', '+33600000001', msg, 'm1', 'jeton');
    expect(out).toEqual({ messageId: 'm1' });
    expect(provider.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Le chemin de MASSE : une campagne RCS.
// ---------------------------------------------------------------------------------------------------------

const campagne: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: '', category: 'marketing',
  templateName: '', templateLanguage: '', paramMapping: [], status: 'draft',
  workflowId: null, startNodeId: null, ratePerMinute: null,
  channel: 'rcs', rcsAgentId: 'agent-1', rcsMessage: { kind: 'text', text: 'Offre' },
};

const rec = (id: string, toE164: string): Recipient =>
  ({ id, contactId: `ct-${id}`, toE164, resolvedParams: [], status: 'pending' });

class FakeRecipients implements RecipientStore {
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.pending; }
  async claim(): Promise<boolean> { return true; }
  async relacher(): Promise<void> {}
  async markResult(): Promise<void> {}
}
class FakeCampaigns implements CampaignStore {
  async setStatus(): Promise<void> {}
}

function deps(over: Partial<DepsMoteurDeTest> & { recipients: RecipientStore }): DepsMoteurDeTest {
  return {
    sender: {
      sendMarketing: async () => { throw new Error('sender Meta interdit sur une campagne RCS'); },
      sendTemplate: async () => { throw new Error('sender Meta interdit sur une campagne RCS'); },
    },
    campaigns: new FakeCampaigns(),
    quality: { getRating: async () => 'GREEN' as const },
    now: () => 1_000_000_000,
    ...over,
  };
}

function campagneRcs(message: RcsOutbound) {
  const depot = new DepotEspion();
  const { provider, sender } = senderAvec(new TraceurLiensRcs(depot, BASE, codes()));
  return {
    depot,
    provider,
    channelSender: makeCampaignSender({ channel: 'rcs', tenantId: 't1', agentId: 'agent-1', message, rcs: sender }),
  };
}

describe('une campagne RCS attribue les clics de ses liens', () => {
  const avecLien: RcsOutbound = { kind: 'text', text: 'Offre', suggestions: [btn('https://a.fr/x')] };

  it('🔴 chaque destinataire reçoit SON jeton dans le lien', async () => {
    const { provider, channelSender } = campagneRcs(avecLien);
    await lancerCampagne(campagne, deps({
      recipients: new FakeRecipients([rec('r1', '+33600000001'), rec('r2', '+33600000002')]),
      channelSender,
      jetonsPourContacts: async () => new Map([['ct-r1', 'jetonPourR1xxxx'], ['ct-r2', 'jetonPourR2xxxx']]),
    }));
    const urls = provider.sent.map((s) => ((s.msg as Extract<RcsOutbound, { kind: 'text' }>).suggestions?.[0] as { url: string }).url);
    expect(urls).toEqual([`${BASE}/r/code14/jetonPourR1xxxx`, `${BASE}/r/code14/jetonPourR2xxxx`]);
  });

  it('les jetons sont chargés en UN SEUL énoncé pour toute la campagne', async () => {
    // Une lecture par destinataire ferait de l'attribution un coût proportionnel à la taille de la campagne.
    const { channelSender } = campagneRcs(avecLien);
    let lectures = 0;
    await lancerCampagne(campagne, deps({
      recipients: new FakeRecipients([rec('r1', '+33600000001'), rec('r2', '+33600000002'), rec('r3', '+33600000003')]),
      channelSender,
      jetonsPourContacts: async () => { lectures++; return new Map(); },
    }));
    expect(lectures).toBe(1);
  });

  it('🔴 un message SANS lien ne fabrique AUCUN jeton', async () => {
    // On ne crée pas d'identifiants publics pour des gens à qui on n'envoie rien à cliquer.
    const { channelSender } = campagneRcs({ kind: 'text', text: 'Offre' });
    let lectures = 0;
    await lancerCampagne(campagne, deps({
      recipients: new FakeRecipients([rec('r1', '+33600000001')]),
      channelSender,
      jetonsPourContacts: async () => { lectures++; return new Map(); },
    }));
    expect(lectures).toBe(0);
    expect(channelSender.aBesoinDeJeton).toBe(false);
  });

  it('un chargement de jetons EN ÉCHEC laisse partir la campagne, liens tracés mais anonymes', async () => {
    const { provider, channelSender } = campagneRcs(avecLien);
    const report = await lancerCampagne(campagne, deps({
      recipients: new FakeRecipients([rec('r1', '+33600000001')]),
      channelSender,
      jetonsPourContacts: async () => { throw new Error('base indisponible'); },
    }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(((provider.sent[0]!.msg as Extract<RcsOutbound, { kind: 'text' }>).suggestions?.[0] as { url: string }).url)
      .toBe(`${BASE}/r/code14`);
  });

  it('un contact inconnu part avec un lien tracé mais sans jeton', async () => {
    const { provider, channelSender } = campagneRcs(avecLien);
    await lancerCampagne(campagne, deps({
      recipients: new FakeRecipients([rec('r1', '+33600000001')]),
      channelSender,
      jetonsPourContacts: async () => new Map(),
    }));
    expect(((provider.sent[0]!.msg as Extract<RcsOutbound, { kind: 'text' }>).suggestions?.[0] as { url: string }).url)
      .toBe(`${BASE}/r/code14`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Les MESURES : « a cliqué sur le lien » sur un bloc RCS d'un scénario, comme sur un bloc template.
// ---------------------------------------------------------------------------------------------------------

const grapheRcs = (suggestions: unknown[], type = 'rcs_message') => ({
  nodes: [{ id: 'a', type, data: { text: 'Notre offre', suggestions } }],
  edges: [],
});

describe('les liens mesurables des blocs RCS d’un scénario', () => {
  it('🔴 numérote sur la liste PLATE du bloc, pas sur les seuls boutons réponse', () => {
    // C'est la garde anti-collision. Les sorties d'un bloc RCS s'appellent `btn:0`, `btn:1`… en ne comptant
    // QUE les boutons réponse (`normaliserPostbacks`). Si le lien était numéroté dans cet espace, il
    // s'appellerait `btn:0` ici, comme le bouton « Oui » : deux mesures différentes sous une même clé.
    expect(liensRcsDesNoeuds(grapheRcs([
      { kind: 'reply', text: 'Oui', postbackData: 'btn:0' },
      { kind: 'openUrl', text: 'Voir', url: 'https://client.fr/promo', postbackData: 'p' },
    ]))).toEqual([{ nodeId: 'a', handle: 'lien:1', destination: 'https://client.fr/promo' }]);
  });

  it('ignore les boutons qui ne sont pas des liens', () => {
    expect(liensRcsDesNoeuds(grapheRcs([
      { kind: 'reply', text: 'Oui', postbackData: 'btn:0' },
      { kind: 'dial', text: 'Appeler', phoneNumber: '+33100000000', postbackData: 'p' },
    ]))).toEqual([]);
  });

  it('ignore une adresse qu’on n’aurait pas tracée à l’envoi', () => {
    // La MÊME règle qu'à l'envoi (`estTracable`), sinon la case existerait pour un lien que rien ne trace, et
    // resterait à zéro pour toujours en laissant croire à une absence de clics.
    expect(liensRcsDesNoeuds(grapheRcs([{ kind: 'openUrl', text: 'V', url: 'client.fr/sans-schema', postbackData: 'p' }]))).toEqual([]);
    expect(liensRcsDesNoeuds(grapheRcs([{ kind: 'openUrl', text: 'V', url: 'https://a.fr/{{id}}', postbackData: 'p' }]))).toEqual([]);
  });

  it('ne regarde QUE les blocs RCS', () => {
    expect(liensRcsDesNoeuds(grapheRcs([{ kind: 'openUrl', text: 'V', url: 'https://a.fr/x', postbackData: 'p' }], 'template'))).toEqual([]);
  });

  it('lit un graphe malformé sans lever : c’est un jsonb, on n’en suppose rien', () => {
    expect(liensRcsDesNoeuds(null)).toEqual([]);
    expect(liensRcsDesNoeuds({})).toEqual([]);
    expect(liensRcsDesNoeuds({ nodes: 'pas un tableau' })).toEqual([]);
    expect(liensRcsDesNoeuds({ nodes: [null, { id: 'a', type: 'rcs_message' }, { type: 'rcs_message', data: { suggestions: 3 } }] })).toEqual([]);
  });
});

describe('les compteurs de clics d’un bloc RCS', () => {
  const liens = [{ nodeId: 'a', handle: 'lien:1', destination: 'https://client.fr/promo' }];

  it('porte le compteur de la période', () => {
    expect(compteursDeClicsRcs(liens, new Map([['https://client.fr/promo', 'abcdefghjkmn']]), { abcdefghjkmn: 12 }))
      .toEqual([{ nodeId: 'a', kind: 'url_click', handle: 'lien:1', count: 12, contacts: null }]);
  });

  it('🔴 vaut ZÉRO tant que le scénario n’a jamais tourné, au lieu de disparaître', () => {
    // Le code d'un lien RCS naît au PREMIER ENVOI, pas à l'écriture du scénario. Sans ligne, la case ne
    // serait cochable qu'une fois quelqu'un ayant cliqué, et l'opérateur ne pourrait pas préparer son tableau.
    expect(compteursDeClicsRcs(liens, new Map(), {}))
      .toEqual([{ nodeId: 'a', kind: 'url_click', handle: 'lien:1', count: 0, contacts: null }]);
  });

  it('un code connu mais aucun clic sur la période vaut zéro, pas l’absence', () => {
    expect(compteursDeClicsRcs(liens, new Map([['https://client.fr/promo', 'abcdefghjkmn']]), {})[0]!.count).toBe(0);
  });

  it('🔴 n’identifie personne : `contacts` reste nul', () => {
    // Le fil de l'inbox répond au « qui » (l'indicateur « engagé » de la fiche contact) ; ce compteur-ci
    // répond au « combien ». Prétendre le contraire ferait un décompte de contacts qui n'existe pas.
    expect(compteursDeClicsRcs(liens, new Map(), {})[0]!.contacts).toBeNull();
  });
});
