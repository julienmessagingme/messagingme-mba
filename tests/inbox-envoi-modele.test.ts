import { describe, it, expect } from 'vitest';
import { creerEnvoiModeleInbox } from '../src/inbox/envoi-modele';
import type { LienTrace } from '../src/links/tracked-links.pg';
import type { MarketingParams, TemplateSpec } from '../src/meta/types';

/**
 * L'envoi manuel d'un template depuis l'Inbox porte les suffixes de ses boutons tracés.
 *
 * 🔴 LE DÉFAUT : l'Inbox construisait ses composants sans `suffixesBoutons`. Un template créé par la console depuis le
 * 2026-09-02 soumet ses boutons « Lien » en `/r/<code>/{{1}}` : sans le composant `url` qui remplit ce `{{1}}`, Meta
 * refuse le message entier (131008). La campagne et le bloc de scénario le fournissaient ; l'Inbox, non.
 */
const JETON = 'abcdefghjkmnpqrs';

function lien(over: Partial<LienTrace> = {}): LienTrace {
  return { code: 'ab12cd34ef56', templateName: 'suivi', templateLanguage: 'fr', cardIndex: null, buttonIndex: 1, destination: 'https://client.fr/commande/{numero_commande}', avecJeton: true, ...over };
}

function envoi(
  liens: () => Promise<LienTrace[]>,
  jeton: () => Promise<string | null> = async () => JETON,
  media: (tenant: string, name: string, language: string) => Promise<string | null> = async () => null,
) {
  const envoyes: Array<{ to: string; spec: TemplateSpec }> = [];
  const marketing: MarketingParams[] = [];
  const lectures: Array<{ tenant: string; e164: string }> = [];
  const send = creerEnvoiModeleInbox({
    client: async () => ({
      sendTemplate: async (to, spec) => { envoyes.push({ to, spec }); return { messageId: 'wamid.1' }; },
      sendMarketing: async (params) => { marketing.push(params); return { messageId: 'wamid.m' }; },
    }),
    trackedLinks: {
      listByTemplates: async () => liens(),
      jetonPourE164: async (tenant, e164) => { lectures.push({ tenant, e164 }); return jeton(); },
    },
    mediaDuModele: media,
  });
  return { send, envoyes, marketing, lectures };
}

/**
 * LA MARKETING MESSAGES API (plan du 2026-10-14) : un modèle que l'écran déclare marketing part par `sendMarketing`,
 * qui prend `/marketing_messages` quand `META_MM_LITE` est allumé ; le reste par `sendTemplate`.
 */
describe('envoi manuel d’un template depuis l’Inbox : la catégorie choisit l’envoi', () => {
  it('🔴 marketing -> sendMarketing, même destinataire, mêmes composants (suffixes tracés compris)', async () => {
    const { send, envoyes, marketing } = envoi(async () => [lien()]);
    expect(await send('t1', 'pn1', '33612345678', { name: 'suivi', language: 'fr', bodyParams: ['Marie'], templateCategory: 'marketing' })).toBe('wamid.m');
    expect(envoyes).toEqual([]);
    expect(marketing).toEqual([{ to: '33612345678', template: { name: 'suivi', language: 'fr', components: [
      { type: 'body', parameters: [{ type: 'text', text: 'Marie' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: JETON }] },
    ] } }]);
  });

  it('utility, ou catégorie absente -> sendTemplate', async () => {
    for (const categorie of [{ templateCategory: 'utility' as const }, {}]) {
      const { send, envoyes, marketing } = envoi(async () => []);
      expect(await send('t1', 'pn1', '33612345678', { name: 'suivi', language: 'fr', bodyParams: [], ...categorie })).toBe('wamid.1');
      expect(envoyes).toHaveLength(1);
      expect(marketing).toEqual([]);
    }
  });
});

const composantsUrl = (spec: TemplateSpec) => (spec.components ?? []).filter((c) => (c as { sub_type?: string }).sub_type === 'url');

describe('envoi manuel d’un template depuis l’Inbox', () => {
  it('🔴 un template à bouton tracé part avec le jeton du contact dans le composant `url`', async () => {
    const { send, envoyes, lectures } = envoi(async () => [lien()]);
    expect(await send('t1', 'pn1', '33612345678', { name: 'suivi', language: 'fr', bodyParams: [] })).toBe('wamid.1');
    expect(composantsUrl(envoyes[0]!.spec)).toEqual([{ type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: JETON }] }]);
    // Le jeton est celui du contact de la conversation, dans l'espace de l'envoi.
    expect(lectures).toEqual([{ tenant: 't1', e164: '33612345678' }]);
  });

  it('sans jeton (contact inconnu), le suffixe anonyme : le lien marche, le clic n’est pas rattaché', async () => {
    const { send, envoyes } = envoi(async () => [lien()], async () => null);
    await send('t1', 'pn1', '33612345678', { name: 'suivi', language: 'fr', bodyParams: [] });
    expect(composantsUrl(envoyes[0]!.spec)).toEqual([{ type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'anon' }] }]);
  });

  it('🔴 un template sans lien à jeton ne reçoit AUCUN composant `url` (132000 sinon), ni lecture de jeton', async () => {
    for (const liens of [[], [lien({ avecJeton: false })], [lien({ cardIndex: 0 })]]) {
      const { send, envoyes, lectures } = envoi(async () => liens);
      await send('t1', 'pn1', '33612345678', { name: 'suivi', language: 'fr', bodyParams: ['Marie'] });
      expect(composantsUrl(envoyes[0]!.spec)).toEqual([]);
      expect(envoyes[0]!.spec.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Marie' }] }]);
      expect(lectures).toEqual([]);
    }
  });

  it('des liens illisibles n’empêchent pas l’envoi : il part sans composant de bouton', async () => {
    const { send, envoyes } = envoi(async () => { throw new Error('base indisponible'); });
    expect(await send('t1', 'pn1', '33612345678', { name: 'suivi', language: 'fr', bodyParams: [] })).toBe('wamid.1');
    expect(envoyes[0]!.spec).toEqual({ name: 'suivi', language: 'fr' });
  });
});

/**
 * L'EN-TÊTE MÉDIA EN `media id` (sous-lot « relancer » de la carte HubSpot, invariant 9) : l'URL du CDN de Meta est
 * acceptée puis refusée en 131053 deux secondes plus tard. Un `headerMediaId` part en `{ id }`, prioritaire sur l'URL.
 */
describe('envoi manuel d’un template : l’en-tête média', () => {
  it('🔴 un headerMediaId part en { id }, jamais en link, même avec une URL à côté', async () => {
    const { send, envoyes } = envoi(async () => []);
    await send('t1', 'pn1', '33612345678', {
      name: 'suivi', language: 'fr', bodyParams: [], headerMediaId: 'media-9', headerMediaUrl: 'https://cdn.meta.example/v.jpg', headerFormat: 'IMAGE',
    });
    expect(envoyes[0]?.spec.components).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { id: 'media-9' } }] }]);
  });
});

/**
 * L'INBOX ENVOIE AUSSI LE VISUEL DU MODÈLE EN `media id` (relecture du sous-lot « relancer », invariant 9) : l'adresse que
 * l'écran passe est celle du CDN de Meta, acceptée puis refusée en 131053. Une préparation impossible retombe sur elle.
 */
describe('envoi manuel d’un template depuis l’Inbox : le visuel du modèle', () => {
  const AVEC_VISUEL = { name: 'suivi', language: 'fr', bodyParams: [], headerMediaUrl: 'https://cdn.meta.example/v.jpg', headerFormat: 'IMAGE' as const };

  it('🔴 le modèle a son visuel : il part en { id }, jamais par l’adresse du CDN', async () => {
    const preparations: string[] = [];
    const { send, envoyes } = envoi(async () => [], undefined, async (_t, name) => { preparations.push(name); return 'media-7'; });
    await send('t1', 'pn1', '33612345678', AVEC_VISUEL);
    expect(preparations).toEqual(['suivi']);
    expect(envoyes[0]?.spec.components).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { id: 'media-7' } }] }]);
  });

  it('pas de visuel au modèle, ou une préparation qui échoue : l’adresse de l’écran, comme avant', async () => {
    const sans = envoi(async () => [], undefined, async () => null);
    await sans.send('t1', 'pn1', '33612345678', AVEC_VISUEL);
    expect(sans.envoyes[0]?.spec.components).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.meta.example/v.jpg' } }] }]);
    const panne = envoi(async () => [], undefined, async () => { throw new Error('Meta injoignable'); });
    await panne.send('t1', 'pn1', '33612345678', AVEC_VISUEL);
    expect(panne.envoyes[0]?.spec.components).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.meta.example/v.jpg' } }] }]);
  });

  it('sans en-tête média, rien n’est préparé', async () => {
    const preparations: string[] = [];
    const { send } = envoi(async () => [], undefined, async (_t, name) => { preparations.push(name); return 'media-7'; });
    await send('t1', 'pn1', '33612345678', { name: 'suivi', language: 'fr', bodyParams: ['Marie'] });
    expect(preparations).toEqual([]);
  });
});
