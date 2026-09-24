import { describe, it, expect } from 'vitest';
import { construireDestinataires, marquerDoublons, trierDestinataires, type DestinataireResolu } from '../src/api/sends-build';
import type { ContactEnvoi } from '../src/campaign/build';
import type { TemplateParam } from '../src/crm/template';

/**
 * LE TRI DES DESTINATAIRES D'UN ENVOI PAR L'API (spec 2026-09-24, § 3 « Aucune perte silencieuse »).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : chaque destinataire finit ENVOYÉ ou ÉCARTÉ, avec son motif et son index. Le
 * défaut 1 de la spec était un contact bloqué compté dans `matched`, puis retiré par la lecture des fiches :
 * ni destinataire, ni écart.
 *
 * ⚠️ Les cas de l'ancien `buildApiRecipients` (tests/api-sends-build.test.ts) sont CONSERVÉS ici, sous leurs
 * nouveaux codes : `not_opted_in` devient `no_consent` (marketing sans opt-in) ou `opted_out` (désabonné),
 * `out_of_window` devient `window_closed`, et le doublon silencieux devient `duplicate`.
 */
const ct = (over: Partial<ContactEnvoi> & Pick<ContactEnvoi, 'id'>): ContactEnvoi => ({
  phone_e164: '+33600000001', bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in', bloque: false, rcsDesabonne: false, ...over,
});
const vers = (index: number, contactId: string): DestinataireResolu => ({ index, contactId });

describe('marquerDoublons', () => {
  it('la seconde désignation d’une même fiche devient `duplicate`, la première reste', () => {
    expect(marquerDoublons([vers(0, 'a'), vers(1, 'b'), vers(2, 'a')])).toEqual([vers(0, 'a'), vers(1, 'b'), { index: 2, ecart: 'duplicate' }]);
  });

  it('un écart déjà posé passe tel quel, et le marquage est idempotent', () => {
    const une = marquerDoublons([{ index: 0, ecart: 'invalid_phone' }, vers(1, 'a'), vers(2, 'a')]);
    expect(une).toEqual([{ index: 0, ecart: 'invalid_phone' }, vers(1, 'a'), { index: 2, ecart: 'duplicate' }]);
    expect(marquerDoublons(une)).toEqual(une);
  });
});

describe('trierDestinataires', () => {
  const base = { category: 'utility' as const, ouverture: 'whatsapp_template' as const };

  it('🔴 défaut 1 : un contact BLOQUÉ est écarté `blocked_contact`, jamais perdu en silence', () => {
    const r = trierDestinataires({ ...base, resolus: [vers(0, 'b')], contacts: [ct({ id: 'b', bloque: true })] });
    expect(r.eligibles).toEqual([]);
    expect(r.ecarts).toEqual([{ index: 0, reason: 'blocked_contact' }]);
  });

  it('le blocage passe avant tout : bloqué ET désabonné est `blocked_contact`', () => {
    expect(trierDestinataires({ ...base, resolus: [vers(0, 'a')], contacts: [ct({ id: 'a', bloque: true, optInStatus: 'opted_out' })] }).ecarts)
      .toEqual([{ index: 0, reason: 'blocked_contact' }]);
  });

  it('une fiche SANS aucune adresse (ni numéro ni BSUID) est écartée `no_phone`, en WhatsApp aussi', () => {
    const r = trierDestinataires({ ...base, resolus: [vers(0, 'a')], contacts: [ct({ id: 'a', phone_e164: null, bsuid: null })] });
    expect(r.eligibles).toEqual([]);
    expect(r.ecarts).toEqual([{ index: 0, reason: 'no_phone' }]);
  });

  it('une fiche absente de la lecture (supprimée entre-temps) est écartée `unknown_contact`', () => {
    expect(trierDestinataires({ ...base, resolus: [vers(0, 'x')], contacts: [] }).ecarts).toEqual([{ index: 0, reason: 'unknown_contact' }]);
  });

  it('marketing : l’opt-in part, l’inconnu est `no_consent`, le désabonné `opted_out` (ancien `not_opted_in`)', () => {
    const r = trierDestinataires({
      category: 'marketing', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a'), vers(1, 'b'), vers(2, 'c')],
      contacts: [ct({ id: 'a' }), ct({ id: 'b', optInStatus: 'unknown' }), ct({ id: 'c', optInStatus: 'opted_out' })],
    });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'no_consent' }, { index: 2, reason: 'opted_out' }]);
  });

  it('utility : le consentement inconnu passe, le désabonné reste écarté', () => {
    const r = trierDestinataires({ ...base, resolus: [vers(0, 'a'), vers(1, 'b')], contacts: [ct({ id: 'a', optInStatus: 'unknown' }), ct({ id: 'b', optInStatus: 'opted_out' })] });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'opted_out' }]);
  });

  it('ouverture RCS : STOP RCS -> `opted_out`, fiche sans numéro -> `no_phone` ; en WhatsApp le STOP RCS ne compte pas', () => {
    const contacts = [ct({ id: 'a', rcsDesabonne: true }), ct({ id: 'b', phone_e164: null, bsuid: 'BS-b' })];
    const rcs = trierDestinataires({ ...base, ouverture: 'rcs', resolus: [vers(0, 'a'), vers(1, 'b')], contacts });
    expect(rcs.ecarts).toEqual([{ index: 0, reason: 'opted_out' }, { index: 1, reason: 'no_phone' }]);
    const wa = trierDestinataires({ ...base, resolus: [vers(0, 'a'), vers(1, 'b')], contacts });
    expect(wa.eligibles.map((x) => x.index)).toEqual([0, 1]);
  });

  it('ouverture de session : fenêtre fermée ou inconnue -> `window_closed` (ancien `out_of_window`)', () => {
    const r = trierDestinataires({
      ...base, ouverture: 'whatsapp_session',
      resolus: [vers(0, 'a'), vers(1, 'b'), vers(2, 'c')],
      contacts: [ct({ id: 'a' }), ct({ id: 'b' }), ct({ id: 'c' })],
      fenetreOuverteParContact: new Map([['a', true], ['b', false]]),
    });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'window_closed' }, { index: 2, reason: 'window_closed' }]);
  });

  it('⚠️ ouverture de session SANS lecture de fenêtre : tout est fermé, jamais tout ouvert', () => {
    expect(trierDestinataires({ ...base, ouverture: 'whatsapp_session', resolus: [vers(0, 'a')], contacts: [ct({ id: 'a' })] }).ecarts)
      .toEqual([{ index: 0, reason: 'window_closed' }]);
  });

  it('un doublon qui arrive au tri sans marquage est écarté `duplicate` (ancien doublon silencieux)', () => {
    const r = trierDestinataires({ ...base, resolus: [vers(0, 'a'), vers(1, 'a')], contacts: [ct({ id: 'a' })] });
    expect(r.eligibles.map((x) => x.index)).toEqual([0]);
    expect(r.ecarts).toEqual([{ index: 1, reason: 'duplicate' }]);
  });
});

describe('construireDestinataires', () => {
  const prenom: TemplateParam[] = [{ position: 1, source: { type: 'field', key: 'prenom' } }];

  it('une variable manquante est `missing_variable` À L’INDEX du destinataire, et les écarts sont triés par index', () => {
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a'), { index: 1, ecart: 'invalid_phone' }, vers(2, 'b')],
      contacts: [ct({ id: 'a', fields: {} }), ct({ id: 'b', phone_e164: '+33600000002', fields: { prenom: 'Léa' } })],
    });
    const { recipients, ecarts } = construireDestinataires('utility', prenom, tri, new Date('2026-09-24T10:00:00Z'));
    expect(recipients).toEqual([{ contactId: 'b', toE164: '+33600000002', resolvedParams: ['Léa'] }]);
    expect(ecarts).toEqual([{ index: 0, reason: 'missing_variable' }, { index: 1, reason: 'invalid_phone' }]);
  });

  it('l’adresse vient de la FICHE : le numéro, sinon le BSUID', () => {
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a'), vers(1, 'b')],
      contacts: [ct({ id: 'a', phone_e164: '+33600000003', bsuid: 'BS-a' }), ct({ id: 'b', phone_e164: null, bsuid: 'BS-b' })],
    });
    expect(construireDestinataires('utility', [], tri, new Date()).recipients.map((r) => r.toE164)).toEqual(['+33600000003', 'BS-b']);
  });

  it('un numéro VIDE vaut absence : la fiche part sur son BSUID, sans écart', () => {
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a')],
      contacts: [ct({ id: 'a', phone_e164: '', bsuid: 'BS-x' })],
    });
    const { recipients, ecarts } = construireDestinataires('utility', [], tri, new Date());
    expect(recipients).toEqual([{ contactId: 'a', toE164: 'BS-x', resolvedParams: [] }]);
    expect(ecarts).toEqual([]);
  });

  it('🔴 deux fiches DISTINCTES à la même adresse : la seconde est `duplicate`, jamais ni envoyée ni écartée', () => {
    // La construction partagée dédoublonne par ADRESSE, en silence. La base l'interdit aujourd'hui (index
    // uniques sur le numéro et sur le BSUID), mais le tri ne doit pas en dépendre pour ne rien perdre.
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [vers(0, 'a'), vers(1, 'b')],
      contacts: [ct({ id: 'a', phone_e164: '+33600000004' }), ct({ id: 'b', phone_e164: '+33600000004' })],
    });
    const { recipients, ecarts } = construireDestinataires('utility', [], tri, new Date());
    expect(recipients.map((r) => r.contactId)).toEqual(['a']);
    expect(ecarts).toEqual([{ index: 1, reason: 'duplicate' }]);
  });
});

describe('les variables d’un destinataire (lot 3 de l’API publique)', () => {
  it('🔴 elles voyagent du tri à la construction, et résolvent la source « variable »', () => {
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [{ index: 0, contactId: 'a', variables: { commande: '8412' } }, vers(1, 'b')],
      contacts: [ct({ id: 'a' }), ct({ id: 'b', phone_e164: '+33600000002' })],
    });
    const params: TemplateParam[] = [{ position: 1, source: { type: 'variable', key: 'commande' } }];
    const { recipients, ecarts } = construireDestinataires('utility', params, tri, new Date());
    expect(recipients).toEqual([{ contactId: 'a', toE164: '+33600000001', resolvedParams: ['8412'], variables: { commande: '8412' } }]);
    expect(ecarts).toEqual([{ index: 1, reason: 'missing_variable' }]);
  });

  it('🔴 elles ne touchent JAMAIS la fiche chargée : seule la copie envoyée à la construction les porte', () => {
    const fiche = ct({ id: 'a' });
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [{ index: 0, contactId: 'a', variables: { commande: '8412' } }], contacts: [fiche],
    });
    construireDestinataires('utility', [], tri, new Date());
    expect(fiche).not.toHaveProperty('variables');
    expect(tri.eligibles[0]!.contact).not.toHaveProperty('variables');
  });

  it('le canal atteint la construction : sur une campagne RCS, une fiche sans numéro est écartée no_phone', () => {
    // Le tri l'écarte déjà sur une ouverture rcs ; ici, un tri WhatsApp isole la construction.
    const tri = trierDestinataires({ category: 'utility', ouverture: 'whatsapp_template', resolus: [vers(0, 'b')], contacts: [ct({ id: 'b', phone_e164: null, bsuid: 'BS-b' })] });
    expect(construireDestinataires('utility', [], tri, new Date(), 'rcs').ecarts).toEqual([{ index: 0, reason: 'no_phone' }]);
    // Ancre positive : sans le canal, la même fiche part sur son BSUID, comme au lot 2.
    expect(construireDestinataires('utility', [], tri, new Date()).recipients.map((r) => r.toE164)).toEqual(['BS-b']);
  });
});
