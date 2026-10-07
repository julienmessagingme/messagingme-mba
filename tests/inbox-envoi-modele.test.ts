import { describe, it, expect } from 'vitest';
import { creerEnvoiModeleInbox } from '../src/inbox/envoi-modele';
import type { LienTrace } from '../src/links/tracked-links.pg';
import type { TemplateSpec } from '../src/meta/types';

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

function envoi(liens: () => Promise<LienTrace[]>, jeton: () => Promise<string | null> = async () => JETON) {
  const envoyes: Array<{ to: string; spec: TemplateSpec }> = [];
  const lectures: Array<{ tenant: string; e164: string }> = [];
  const send = creerEnvoiModeleInbox({
    client: async () => ({ sendTemplate: async (to, spec) => { envoyes.push({ to, spec }); return { messageId: 'wamid.1' }; } }),
    trackedLinks: {
      listByTemplates: async () => liens(),
      jetonPourE164: async (tenant, e164) => { lectures.push({ tenant, e164 }); return jeton(); },
    },
  });
  return { send, envoyes, lectures };
}

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
