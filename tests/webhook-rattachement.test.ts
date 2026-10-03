import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleWebhookJob, type WebhookJobDeps } from '../src/webhooks/handler';
import type { InboundMessage } from '../src/webhooks/inbound';
import { agentEteintALArrivee, aucunNumeroDelie, aucuneArriveePub, aucunRoutagePub, aucunSignalReponse, aucuneCorrectionDuDetenteur } from './webhook-fixtures';
import { aucunStop, jamaisDesabonne } from './consentement';

/**
 * LA RÉCEPTION RATTACHE L'ESPACE UNE SEULE FOIS.
 *
 * 🔴 Ce que ces tests gardent : `handleWebhookJob` lit le numéro vers l'espace une fois par numéro distinct du
 * payload, et passe aux étapes des éléments déjà rattachés. Aucune étape ne lit le numéro elle-même : sinon un
 * message entrant coûte une lecture par étape (l'Inbox, l'arrivée publicitaire, le routage, les automations,
 * l'avance, la remise à l'agent de Meta), sur le chemin chaud de chaque message. Le compteur est la seule source
 * de ces lectures, puisque le numéro ne se lit plus que dans `inbox`.
 *
 * ⚠️ Et le rattachement ne change pas ce que chaque étape reçoit : chaque étape voit l'espace du message, dans
 * l'ordre du handler, et un numéro inconnu n'atteint aucune étape.
 */

type Change = { field: string; value: Record<string, unknown> };
const payload = (...changes: Change[]): unknown => ({ entry: [{ id: 'waba1', changes }] });
const messages = (pnid: string, liste: unknown[], field = 'messages'): Change =>
  ({ field, value: { metadata: { phone_number_id: pnid }, messages: liste } });
const texte = (id: string, from: string, body: string, extra: Record<string, unknown> = {}) =>
  ({ id, from, type: 'text', timestamp: '1790000000', text: { body }, ...extra });
const REFERRAL = { referral: { source_id: 'ad-1', source_type: 'ad', ctwa_clid: 'clid-1' } };
/** Un écho de l'agent de Meta : `standby`, sous `value.standby`, `metadata` restant au premier niveau. */
const echo = (pnid: string): Change => ({
  field: 'standby',
  value: {
    metadata: { phone_number_id: pnid },
    standby: { message_echoes: [{ id: 'wamid.echo', message: { to: '33600000009', type: 'text', text: { body: 'Réponse de l’agent' } } }] },
  },
});
/** Un passage de main réel : aucun `metadata`, le numéro business est dans `recipient`. */
const passageDeMain = (pnid: string): Change => ({
  field: 'messaging_handovers',
  value: {
    type: 'control_passed',
    sender: { phone_number: '33600000008' },
    recipient: { phone_number_id: pnid },
    control_passed: { previous_owner_app_role: 'meta_business_agent' },
  },
});

/** L'Inbox, qui compte ses lectures du numéro vers l'espace. */
function inboxQuiCompte(espaces: Record<string, string | null>) {
  const lectures: string[] = [];
  const enregistres: string[] = [];
  return {
    lectures,
    enregistres,
    inbox: {
      phoneNumberTenant: async (pnid: string) => { lectures.push(pnid); return espaces[pnid] ?? null; },
      recordInbound: async (_t: string, m: InboundMessage) => { enregistres.push(m.messageId); return { rouverte: false }; },
    },
  };
}

/** Toutes les étapes de la file `webhook`, chacune notant l'espace qu'elle reçoit. */
function toutesLesEtapes(inbox: ReturnType<typeof inboxQuiCompte>['inbox'], vus: string[]): WebhookJobDeps {
  return {
    store: { insertEvent: async () => true },
    inbox,
    numerosDelies: aucunNumeroDelie,
    inboundOptOut: aucunStop, detenteur: aucuneCorrectionDuDetenteur, listeALArrivee: agentEteintALArrivee,
    inboundContactUpsert: async (t) => { vus.push(`upsert:${t}`); return 'updated'; },
    signalReponse: async (t) => { vus.push(`signal:${t}`); },
    arriveesPub: { enregistrer: async (t) => { vus.push(`arrivee:${t}`); return 'ecrite'; } },
    routagePub: {
      campagneConnue: async (t) => { vus.push(`routage:${t}`); return null; },
      resoudreChezMeta: async () => null,
      publiciteDeLaCampagne: async () => null,
      contactBloque: async () => false,
      estDesabonne: jamaisDesabonne,
      reprendreLeFil: async () => true,
      rendreLeFil: async () => {},
      noterIssue: async () => {},
    },
    testTokens: {
      findByTestToken: async () => ({ workflowId: 'wf1', tenantId: 't1' }),
      startTestRun: async (t) => { vus.push(`test:${t}`); return true; },
    },
    triggers: { run: async (t) => { vus.push(`automation:${t}`); return 0; } },
    workflowAdvance: { advance: async (t) => { vus.push(`avance:${t}`); } },
    remiseMbaEntrant: { remettre: async (t) => { vus.push(`remise:${t}`); } },
    handover: {
      marquerEscalade: async (t) => { vus.push(`escalade:${t}`); },
      recordAgentMessage: async (t) => { vus.push(`echo:${t}`); },
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('le numéro vers l’espace se lit une fois par numéro', () => {
  it('🔴 un message entrant : UNE lecture, et chaque étape reçoit l’espace, dans l’ordre du handler', async () => {
    const i = inboxQuiCompte({ pn1: 't1' });
    const vus: string[] = [];
    await handleWebhookJob(payload(messages('pn1', [texte('wamid.1', '33600000001', 'bonjour', REFERRAL)])), toutesLesEtapes(i.inbox, vus));
    expect(i.lectures).toEqual(['pn1']);
    expect(vus).toEqual(['upsert:t1', 'signal:t1', 'arrivee:t1', 'routage:t1', 'automation:t1', 'avance:t1', 'remise:t1']);
  });

  it('🔴 plusieurs messages et un écho sur le même numéro : toujours UNE lecture', async () => {
    const i = inboxQuiCompte({ pn1: 't1' });
    const vus: string[] = [];
    await handleWebhookJob(payload(
      messages('pn1', [
        texte('wamid.1', '33600000001', 'bonjour', REFERRAL),
        texte('wamid.2', '33600000002', 'test-a7k2m9p3'),
        texte('wamid.3', '33600000003', 'je veux un rdv'),
      ]),
      echo('pn1'),
    ), toutesLesEtapes(i.inbox, vus));
    expect(i.lectures).toEqual(['pn1']);
    expect(i.enregistres).toEqual(['wamid.1', 'wamid.2', 'wamid.3']);
    // Le jeton de test a bien été vu, avec son espace, et l'écho aussi : le rattachement n'a rien perdu en route.
    expect(vus).toContain('test:t1');
    expect(vus).toContain('echo:t1');
  });

  it('🔴 trois numéros distincts, dont un que seul un passage de main nomme : trois lectures, une par numéro', async () => {
    const i = inboxQuiCompte({ pn1: 't1', pn2: 't2', pn3: 't3' });
    const vus: string[] = [];
    await handleWebhookJob(payload(
      messages('pn1', [texte('wamid.1', '33600000001', 'a'), texte('wamid.2', '33600000002', 'b')]),
      messages('pn2', [texte('wamid.3', '33600000003', 'c')]),
      echo('pn2'),
      passageDeMain('pn3'),
    ), toutesLesEtapes(i.inbox, vus));
    expect(i.lectures).toEqual(['pn1', 'pn2', 'pn3']);
    expect(vus.filter((v) => v.startsWith('avance:'))).toEqual(['avance:t1', 'avance:t1', 'avance:t2']);
    expect(vus).toContain('echo:t2');
    expect(vus).toContain('escalade:t3');
  });

  it('un numéro inconnu est lu une fois, et n’atteint aucune étape', async () => {
    const i = inboxQuiCompte({});
    const vus: string[] = [];
    await handleWebhookJob(payload(
      messages('pn9', [texte('wamid.1', '33600000001', 'a', REFERRAL), texte('wamid.2', '33600000002', 'test-a7k2m9p3')]),
    ), toutesLesEtapes(i.inbox, vus));
    expect(i.lectures).toEqual(['pn9']);
    expect(i.enregistres).toEqual([]);
    expect(vus).toEqual([]);
  });

  it('un lot d’accusés purs ne lit aucun numéro', async () => {
    const i = inboxQuiCompte({ pn1: 't1' });
    await handleWebhookJob(payload({
      field: 'messages',
      value: { metadata: { phone_number_id: 'pn1' }, statuses: [{ id: 'wamid.s', status: 'delivered', recipient_id: '336' }] },
    }), toutesLesEtapes(i.inbox, []));
    expect(i.lectures).toEqual([]);
  });
});

describe('une lecture en échec garde son sort d’avant', () => {
  it('🔴 le numéro d’un message illisible fait échouer le job, avant tout enregistrement : pg-boss le rejoue', async () => {
    const i = inboxQuiCompte({ pn1: 't1' });
    i.inbox.phoneNumberTenant = async () => { throw new Error('base indisponible'); };
    await expect(handleWebhookJob(payload(messages('pn1', [texte('wamid.1', '33600000001', 'a')])), toutesLesEtapes(i.inbox, [])))
      .rejects.toThrow('base indisponible');
    expect(i.enregistres).toEqual([]);
  });

  it('⚠️ un numéro que seul un passage de main nomme, illisible, écarte CETTE bascule sans faire rejouer le job', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const i = inboxQuiCompte({ pn1: 't1', pn2: 't2' });
    const lire = i.inbox.phoneNumberTenant;
    i.inbox.phoneNumberTenant = async (pnid) => { if (pnid === 'pn3') throw new Error('base indisponible'); return lire(pnid); };
    const vus: string[] = [];
    await expect(handleWebhookJob(payload(
      messages('pn1', [texte('wamid.1', '33600000001', 'a')]),
      echo('pn2'),
      passageDeMain('pn3'),
    ), toutesLesEtapes(i.inbox, vus))).resolves.toBeUndefined();
    expect(i.enregistres).toEqual(['wamid.1']);
    expect(vus).not.toContain('escalade:t3');
    // L'étape n'est pas rejouée : une bascule illisible ne doit pas emporter ses voisines du même payload.
    expect(vus).toContain('echo:t2');
  });
});

describe('le type tient ce que le rattachement suppose', () => {
  it('🔴 l’écriture du STOP est requise avec l’Inbox, et une étape rattachée n’existe pas sans elle', () => {
    const base = { store: { insertEvent: async () => true } };
    const inbox = { phoneNumberTenant: async () => 't1', recordInbound: async () => ({ rouverte: false }) };
    // @ts-expect-error `inboundOptOut` manque : une dépendance de consentement n'est jamais optionnelle.
    const sansStop: WebhookJobDeps = { ...base, inbox, arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse, numerosDelies: aucunNumeroDelie, detenteur: aucuneCorrectionDuDetenteur, listeALArrivee: agentEteintALArrivee };
    // @ts-expect-error `detenteur` manque : sans lui, un `standby` ne corrigerait plus notre colonne (relecture du lot 4).
    const sansDetenteur: WebhookJobDeps = { ...base, inbox, arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse, numerosDelies: aucunNumeroDelie, inboundOptOut: aucunStop, listeALArrivee: agentEteintALArrivee };
    // @ts-expect-error `listeALArrivee` manque : sans elle, la réponse texte d'un contact absent de la liste de l'agent à un modèle n'arriverait à personne.
    const sansListe: WebhookJobDeps = { ...base, inbox, arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse, numerosDelies: aucunNumeroDelie, inboundOptOut: aucunStop, detenteur: aucuneCorrectionDuDetenteur };
    // @ts-expect-error une étape qui lit l'espace d'un entrant sans l'Inbox qui le rattache.
    const sansInbox: WebhookJobDeps = { ...base, triggers: { run: async () => 0 } };
    expect([sansStop, sansDetenteur, sansListe, sansInbox]).toHaveLength(4);
  });
});
