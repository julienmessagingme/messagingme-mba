import { describe, it, expect } from 'vitest';
import { extractInbound, processInbound } from '../src/webhooks/inbound';
import type { InboxStore, InboundMessage } from '../src/webhooks/inbound';

function payload(messages: unknown[], phoneNumberId = 'pn1', contacts?: unknown[]) {
  return {
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, contacts, messages } }] }],
  };
}

describe('extractInbound', () => {
  it('message texte', () => {
    const r = extractInbound(payload([{ id: 'wamid.1', from: '33611', type: 'text', text: { body: 'coucou' } }]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ phoneNumberId: 'pn1', waId: '33611', messageId: 'wamid.1', type: 'text', body: 'coucou', buttonPayload: null });
  });

  it('un change `standby` est EXTRAIT avec son field (l’inbox doit le voir ; c’est l’avance de scénario qui filtre)', () => {
    const p = { entry: [{ changes: [{ field: 'standby', value: { metadata: { phone_number_id: 'pn1' }, messages: [{ id: 'wamid.s', from: '33611', type: 'text', text: { body: 'hello' } }] } }] }] };
    const r = extractInbound(p);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ messageId: 'wamid.s', field: 'standby' });
  });

  it('un vrai message porte field=messages ; un change SANS field -> field null (rétro-compat fixtures)', () => {
    expect(extractInbound(payload([{ id: 'wamid.f', from: '33611', type: 'text', text: { body: 'x' } }]))[0]).toMatchObject({ field: 'messages' });
    const p = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, messages: [{ id: 'wamid.n', from: '33611', type: 'text', text: { body: 'hi' } }] } }] }] };
    expect(extractInbound(p)[0]).toMatchObject({ field: null });
  });

  /**
   * 🔴 Publicité Click-to-WhatsApp. Meta n'envoie l'objet `referral` que sur le PREMIER message après le
   * clic : ne pas le capter ici, c'est perdre l'origine du lead pour toujours. La forme testée est celle d'un
   * corps RÉELLEMENT capté (dont un `ctwa_clid` VIDE, qui arrive).
   */
  it('🔴 message venu d une PUB : le referral est capté (source_id = l identifiant de la pub)', () => {
    const r = extractInbound(payload([{
      id: 'wamid.ad', from: '33611', type: 'text', text: { body: 'Bonjour' },
      referral: {
        source_url: 'https://fb.me/XXXX',
        source_id: '120212345678901234',
        source_type: 'ad',
        headline: 'Offre de rentrée',
        body: 'Parlez-nous sur WhatsApp',
        media_type: 'image',
        image_url: 'https://exemple/img.jpg',
        ctwa_clid: '',
      },
    }]));
    expect(r[0]!.referral).toEqual({
      adId: '120212345678901234',
      sourceType: 'ad',
      titre: 'Offre de rentrée',
      url: 'https://fb.me/XXXX',
      ctwaClid: null, // vide chez Meta -> null chez nous, jamais une chaîne vide qui passerait pour une valeur
    });
  });

  it('message ordinaire : AUCUN referral (la clé est absente, pas un objet vide)', () => {
    const r = extractInbound(payload([{ id: 'wamid.ord', from: '33611', type: 'text', text: { body: 'coucou' } }]));
    expect(r[0]!.referral).toBeUndefined();
  });

  it('referral SANS source_id : ignoré (rien à router, on n invente pas une origine)', () => {
    const r = extractInbound(payload([{
      id: 'wamid.bad', from: '33611', type: 'text', text: { body: 'x' },
      referral: { source_type: 'ad', headline: 'Sans identifiant' },
    }]));
    expect(r[0]!.referral).toBeUndefined();
  });

  it('tap de bouton quick-reply (type button)', () => {
    const r = extractInbound(payload([{ id: 'wamid.2', from: '33611', type: 'button', button: { text: 'Oui', payload: 'YES' } }]));
    expect(r[0]).toMatchObject({ type: 'button', body: 'Oui', buttonPayload: 'YES' });
  });

  it('bouton interactif (button_reply)', () => {
    const r = extractInbound(payload([{ id: 'wamid.3', from: '33611', type: 'interactive', interactive: { button_reply: { id: 'opt_1', title: 'Intéressé' } } }]));
    expect(r[0]).toMatchObject({ body: 'Intéressé', buttonPayload: 'opt_1' });
  });

  it('liste interactive (list_reply)', () => {
    const r = extractInbound(payload([{ id: 'wamid.3b', from: '33611', type: 'interactive', interactive: { list_reply: { id: 'row_2', title: 'Option B' } } }]));
    expect(r[0]).toMatchObject({ body: 'Option B', buttonPayload: 'row_2' });
  });

  it('fin de WhatsApp Flow (nfm_reply) -> corps + réponse structurée en payload', () => {
    const r = extractInbound(payload([{ id: 'wamid.5', from: '33611', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow_rdv', body: 'Formulaire envoyé', response_json: '{"date":"2026-08-01"}' } } }]));
    expect(r[0]).toMatchObject({ type: 'interactive', body: 'Formulaire envoyé', buttonPayload: '{"date":"2026-08-01"}' });
  });

  it('sous-type interactif inconnu -> [interactif] (pas de perte silencieuse)', () => {
    const r = extractInbound(payload([{ id: 'wamid.6', from: '33611', type: 'interactive', interactive: { type: 'mystery' } }]));
    expect(r[0]).toMatchObject({ body: '[interactif]', buttonPayload: null });
  });

  it('réaction -> emoji', () => {
    const r = extractInbound(payload([{ id: 'wamid.7', from: '33611', type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.orig' } }]));
    expect(r[0]).toMatchObject({ type: 'reaction', body: '👍', buttonPayload: 'wamid.orig' });
  });

  /**
   * L'IDENTIFIANT DU MÉDIA (2026-09-09, migration 0125).
   *
   * 🔴 CE QUI N'EST PAS CAPTÉ ICI EST PERDU POUR TOUJOURS, et c'est ce qui rend ces cas différents des
   * autres de ce fichier. Meta ne transmet pas le fichier dans le webhook : il transmet un identifiant, avec
   * lequel on ira chercher une URL de téléchargement. Avant ce lot, `contentOf` n'en gardait rien, donc tous
   * les vocaux reçus étaient définitivement inatteignables. Meta ne conserve l'identifiant d'un média reçu
   * que SEPT jours (et non trente, comme ce commentaire l'a dit jusqu'au 2026-09-19) : un défaut ici ne se
   * rattrape par aucun correctif ultérieur.
   */
  it('🔴 un vocal porte son identifiant de média ET son mime', () => {
    const r = extractInbound(payload([{ id: 'wamid.v', from: '33611', type: 'audio', audio: { id: 'media-42', mime_type: 'audio/ogg; codecs=opus', voice: true } }]));
    expect(r[0]).toMatchObject({ type: 'audio', body: '[audio]', media: { id: 'media-42', mime: 'audio/ogg; codecs=opus' } });
  });

  it('🔴 `body` ne change PAS : le média voyage À CÔTÉ', () => {
    // La garde qui protège tout l'existant : l'aperçu de l'Inbox, l'historique de l'agent et l'analyse
    // lisent `body`. Y mettre l'identifiant du média, ou le vider, les casserait tous en silence.
    const r = extractInbound(payload([{ id: 'wamid.v2', from: '33611', type: 'audio', audio: { id: 'm1' } }]));
    expect(r[0]!.body).toBe('[audio]');
    const avecLegende = extractInbound(payload([{ id: 'wamid.v3', from: '33611', type: 'image', image: { id: 'm2', caption: 'Ma photo' } }]));
    expect(avecLegende[0]!.body).toBe('Ma photo');
    expect(avecLegende[0]!.media).toEqual({ id: 'm2', mime: null });
  });

  it('🔴 un DOCUMENT porte son nom de fichier, une photo n’en porte pas', () => {
    // Le nom n'existe que dans ce corps (migration 0160) : sans lui, un PDF reçu se télécharge sous un nom
    // inventé et l'opérateur ne sait pas ce qu'il ouvre.
    const doc = extractInbound(payload([{ id: 'wamid.d', from: '33611', type: 'document', document: { id: 'md', mime_type: 'application/pdf', filename: 'facture-mars.pdf' } }]));
    expect(doc[0]).toMatchObject({ type: 'document', body: '[document]', media: { id: 'md', mime: 'application/pdf', nom: 'facture-mars.pdf' } });
    const photo = extractInbound(payload([{ id: 'wamid.p', from: '33611', type: 'image', image: { id: 'mp', mime_type: 'image/jpeg', filename: 'ignore.jpg' } }]));
    expect(photo[0]!.media).toEqual({ id: 'mp', mime: 'image/jpeg' });
  });

  it('un média SANS identifiant ne pose pas de `media` vide', () => {
    // Un objet `media` présent mais à l'identifiant vide ferait croire en aval qu'il y a quelque chose à
    // télécharger, et ferait échouer un appel à Meta pour rien.
    const r = extractInbound(payload([{ id: 'wamid.v4', from: '33611', type: 'audio', audio: {} }]));
    expect(r[0]!.media).toBeUndefined();
  });

  it('un message TEXTE n’a pas de média', () => {
    const r = extractInbound(payload([{ id: 'wamid.t', from: '33611', type: 'text', text: { body: 'coucou' } }]));
    expect(r[0]!.media).toBeUndefined();
  });

  it('image avec légende -> légende ; sans légende -> [image]', () => {
    const withCap = extractInbound(payload([{ id: 'wamid.8', from: '33611', type: 'image', image: { caption: 'Ma photo' } }]));
    expect(withCap[0]).toMatchObject({ type: 'image', body: 'Ma photo' });
    const noCap = extractInbound(payload([{ id: 'wamid.9', from: '33611', type: 'image', image: {} }]));
    expect(noCap[0]).toMatchObject({ type: 'image', body: '[image]' });
  });

  it('localisation -> nom/adresse', () => {
    const r = extractInbound(payload([{ id: 'wamid.10', from: '33611', type: 'location', location: { latitude: 48.8, longitude: 2.3, name: 'Tour Eiffel' } }]));
    expect(r[0]).toMatchObject({ type: 'location', body: 'Tour Eiffel' });
  });

  it('BSUID-native : from absent -> fallback contacts[].wa_id', () => {
    const r = extractInbound(payload([{ id: 'wamid.4', type: 'text', text: { body: 'x' } }], 'pn1', [{ wa_id: '33622', profile: { name: 'Marc' } }]));
    expect(r[0]).toMatchObject({ waId: '33622', profileName: 'Marc' });
  });

  it('sans phone_number_id ou sans id/wa_id -> ignoré', () => {
    expect(extractInbound({ entry: [{ changes: [{ value: { messages: [{ id: 'x', from: 'y', type: 'text' }] } }] }] })).toHaveLength(0);
    expect(extractInbound(payload([{ type: 'text', text: { body: 'x' } }]))).toHaveLength(0); // ni id ni wa_id
  });
});

class FakeInbox implements InboxStore {
  readonly recorded: Array<{ tenantId: string; m: InboundMessage }> = [];
  constructor(private readonly tenant: string | null) {}
  async phoneNumberTenant(): Promise<string | null> {
    return this.tenant;
  }
  async recordInbound(tenantId: string, m: InboundMessage): Promise<void> {
    this.recorded.push({ tenantId, m });
  }
}

describe('processInbound', () => {
  it('mappe au tenant et enregistre', async () => {
    const store = new FakeInbox('t1');
    await processInbound(payload([{ id: 'wamid.1', from: '33611', type: 'text', text: { body: 'hi' } }]), store);
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toMatchObject({ tenantId: 't1', m: { waId: '33611' } });
  });

  it('numéro inconnu (pas de tenant) -> rien enregistré', async () => {
    const store = new FakeInbox(null);
    await processInbound(payload([{ id: 'wamid.1', from: '33611', type: 'text', text: { body: 'hi' } }]), store);
    expect(store.recorded).toHaveLength(0);
  });
});
