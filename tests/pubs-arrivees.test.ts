import { describe, it, expect } from 'vitest';
import { arriveeDepuisMessage, processArriveesPub, type ArriveePub, type IssueArrivee } from '../src/webhooks/arrivees-pub';
import { handleWebhookJob } from '../src/webhooks/handler';
import { aucunSignalReponse, aucunNumeroDelie } from './webhook-fixtures';

const referral = {
  source_url: 'https://fb.me/x', source_id: '120212345678901234', source_type: 'ad',
  headline: 'Offre de rentrée', body: 'Parlez-nous', ctwa_clid: 'clid-1',
};

const payload = (messages: unknown[], field = 'messages') => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, messages } }] }],
});

const message = (id: string, from: string, ref?: unknown) =>
  ({ id, from, type: 'text', text: { body: 'Bonjour' }, ...(ref ? { referral: ref } : {}) });

describe('arriveeDepuisMessage', () => {
  it('traduit le referral en arrivée', () => {
    expect(arriveeDepuisMessage({
      messageId: 'wamid.1', field: 'messages',
      referral: { adId: 'ad1', sourceType: 'ad', titre: 'T', url: 'u', ctwaClid: 'c' },
    })).toEqual({ messageId: 'wamid.1', adId: 'ad1', sourceType: 'ad', titre: 'T', url: 'u', ctwaClid: 'c', enStandby: false });
  });

  it('un message en standby donne une arrivée « en standby »', () => {
    expect(arriveeDepuisMessage({
      messageId: 'wamid.2', field: 'standby',
      referral: { adId: 'ad1', sourceType: null, titre: null, url: null, ctwaClid: null },
    })?.enStandby).toBe(true);
  });

  it('sans referral, pas d’arrivée', () => {
    expect(arriveeDepuisMessage({ messageId: 'wamid.3', field: 'messages' })).toBeNull();
  });
});

describe('processArriveesPub', () => {
  const capte = () => {
    const ecrites: Array<{ tenant: string; waId: string; a: ArriveePub }> = [];
    return {
      ecrites,
      deps: {
        phoneNumberTenant: async () => 't1',
        enregistrer: async (tenant: string, waId: string, a: ArriveePub): Promise<IssueArrivee> => {
          ecrites.push({ tenant, waId, a });
          return 'ecrite';
        },
      },
    };
  };

  it('écrit une arrivée par message qui porte un referral, et ignore les autres', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.a', '33611', referral), message('wamid.b', '33612')]), deps);
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]).toMatchObject({
      tenant: 't1', waId: '33611',
      a: { messageId: 'wamid.a', adId: '120212345678901234', ctwaClid: 'clid-1', enStandby: false },
    });
  });

  it('🔴 le STANDBY n’est PAS exclu : c’est la mesure que le lot 3 attend', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.s', '33611', referral)], 'standby'), deps);
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]?.a.enStandby).toBe(true);
  });

  it('`ctwa_clid` vide chez Meta : gardé à null, et l’arrivée est quand même écrite', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.v', '33611', { ...referral, ctwa_clid: '' })]), deps);
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]?.a.ctwaClid).toBeNull();
  });

  it('numéro inconnu : rien n’est écrit', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.x', '33611', referral)]), { ...deps, phoneNumberTenant: async () => null });
    expect(ecrites).toHaveLength(0);
  });

  it('🔴 une erreur sur un message n’empêche pas les autres, et ne lève jamais', async () => {
    const ok: string[] = [];
    await expect(processArriveesPub(payload([message('wamid.ko', 'KO', referral), message('wamid.ok', 'OK', referral)]), {
      phoneNumberTenant: async () => 't1',
      enregistrer: async (_t, waId) => {
        if (waId === 'KO') throw new Error('base indisponible');
        ok.push(waId);
        return 'ecrite';
      },
    })).resolves.toBeUndefined();
    expect(ok).toEqual(['OK']);
  });
});

describe('handleWebhookJob : l’arrivée publicitaire', () => {
  /**
   * 🔴 L'ORDRE DES TROIS ÉTAPES EST LA MOITIÉ DE LEUR COMPORTEMENT, et aucune ne le dit toute seule.
   *
   * L'upsert d'abord, parce que l'arrivée retrouve la fiche par son `wa_id` : avant lui, elle n'en trouve
   * aucune et la ligne est perdue pour toujours (Meta n'envoie `ctwa_clid` qu'une fois). Le routage ensuite,
   * parce qu'il ANNOTE la ligne que l'arrivée vient d'écrire : avant elle, il annoterait une ligne qui
   * n'existe pas. Et les déclencheurs après le routage, puisque c'est eux qu'il restreint, ce que garde le
   * test voisin (`tests/pubs-routage-cablage.test.ts`).
   */
  it('🔴 arrivée APRÈS l’upsert du contact, routage APRÈS l’arrivée', async () => {
    const ordre: string[] = [];
    await handleWebhookJob(payload([message('wamid.h', '33611', referral)]), {
      store: { insertEvent: async () => true },
      inbox: { phoneNumberTenant: async () => 't1', recordInbound: async () => {} },
      signalReponse: aucunSignalReponse,
      numerosDelies: aucunNumeroDelie,
      inboundContactUpsert: async () => { ordre.push('upsert'); return 'created'; },
      arriveesPub: {
        phoneNumberTenant: async () => 't1',
        enregistrer: async () => { ordre.push('arrivee'); return 'ecrite'; },
      },
      routagePub: {
        phoneNumberTenant: async () => { ordre.push('routage'); return null; },
        campagneConnue: async () => null,
        resoudreChezMeta: async () => null,
        publiciteDeLaCampagne: async () => null,
        contactBloque: async () => false,
        estDesabonne: async () => false,
        reprendreLeFil: async () => true,
        rendreLeFil: async () => {},
        noterIssue: async () => {},
      },
    });
    expect(ordre).toEqual(['upsert', 'arrivee', 'routage']);
  });
});
