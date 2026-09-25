import { describe, it, expect, beforeAll } from 'vitest';
import { MetaClientFactory } from '../src/meta/factory';
import { MetaCredentialsResolver } from '../src/meta/credentials';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import { NumeroDelieError, MESSAGE_NUMERO_DELIE, creerGardeNumeroDelie } from '../src/meta/numero-delie';
import { campaignRunJob, type RunJobDeps } from '../src/campaign/run-job';
import { RAISON_NUMERO_RELIE_ENTRE_TEMPS } from '../src/campaign/engine';
import { lancerCampagne, type DepsMoteurDeTest } from './campagne-canaux';
import type { RecipientStore, CampaignStore, QualityProvider } from '../src/campaign/engine';
import type { Campaign, Recipient } from '../src/campaign/types';
import type { MotifDePause } from '../src/campaign/pause';
import { messageDePause } from '../src/campaign/pause';
import { ecarterLesNumerosDelies, ecarterLesEntrantsDelies, numerosAInterroger } from '../src/webhooks/numeros-delies';
import { handleWebhookJob } from '../src/webhooks/handler';
import type { InboundMessage } from '../src/webhooks/inbound';
import { aucuneArriveePub, aucunRoutagePub, aucunSignalReponse } from './webhook-fixtures';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { InboxRouteDeps } from '../src/http/inbox';
import { jamaisDesabonne } from './consentement';

/**
 * LE NUMÉRO DÉLIÉ (migration 0180, bloc « Canaux et services » de l'Accueil) : les trois effets qui se tiennent
 * sans base. Aucun envoi ne part (le point de passage des envois), une campagne lancée malgré tout se met en
 * pause `numero_delie`, et un entrant de ce numéro n'est pas enregistré (le webhook l'écarte, accusés gardés).
 * Ce que les gestes écrivent en base est tenu par `tests/integration/numero-delie.integration.test.ts`.
 */

// --------------------------------------------------------------------------------------------------------
// Le point de passage des envois
// --------------------------------------------------------------------------------------------------------

class Transport implements HttpTransport {
  readonly appels: string[] = [];
  async post(url: string): Promise<HttpResponse> {
    this.appels.push(url);
    return { status: 200, json: { messages: [{ id: 'wamid.ok' }] } };
  }
}

function fabrique(delies: ReadonlySet<string>, transport: Transport, resolutions: string[]) {
  const resolver = new MetaCredentialsResolver({
    getWabaIdForTenant: async (t) => { resolutions.push(t); return null; },
    getCredentialsByWaba: async () => null,
    markTokenInvalid: async () => {},
    decrypt: (e) => e,
    fallbackToken: 'GLOBAL',
  });
  return new MetaClientFactory({
    resolver, transport, version: 'v25.0', marketingViaLite: false,
    numeroDelie: async (pn) => delies.has(pn),
  });
}

describe('le point de passage des envois refuse un numéro délié', () => {
  it('🔴 numéro délié : NumeroDelieError, AVANT le jeton, et rien ne part chez Meta', async () => {
    const transport = new Transport();
    const resolutions: string[] = [];
    const f = fabrique(new Set(['pn-delie']), transport, resolutions);
    await expect(f.clientForTenant('t1', 'pn-delie')).rejects.toBeInstanceOf(NumeroDelieError);
    // Le chemin des campagnes passe par la MÊME porte.
    await expect(f.senderForTenant('t1', 'pn-delie')).rejects.toBeInstanceOf(NumeroDelieError);
    expect(resolutions).toEqual([]);
    expect(transport.appels).toEqual([]);
  });

  it('numéro relié : l’envoi part comme avant', async () => {
    const transport = new Transport();
    const f = fabrique(new Set(['pn-delie']), transport, []);
    const client = await f.clientForTenant('t1', 'pn-relie');
    await expect(client.sendText('33600000001', 'bonjour')).resolves.toMatchObject({ messageId: 'wamid.ok' });
    expect(transport.appels).toHaveLength(1);
  });

  it('le refus porte un code 409 et une phrase lisible, sans identifiant', () => {
    const e = new NumeroDelieError('pn-secret-42');
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe(MESSAGE_NUMERO_DELIE);
    expect(e.message).not.toContain('pn-secret-42');
  });
});

describe('la garde mise en cache (NUMERO_DELIE_TTL_MS)', () => {
  it('une lecture par numéro dans la fenêtre, relue après, et vidée par le geste', async () => {
    let t = 0;
    const lectures: string[] = [];
    let delie = false;
    const g = creerGardeNumeroDelie(async (pn) => { lectures.push(pn); return delie; }, 5_000, () => t);
    expect(await g.estDelie('pn1')).toBe(false);
    delie = true;
    t = 4_999;
    expect(await g.estDelie('pn1')).toBe(false); // encore en cache : c'est la fenêtre assumée
    expect(lectures).toEqual(['pn1']);
    t = 10_000;
    expect(await g.estDelie('pn1')).toBe(true); // relu à l'expiration
    delie = false;
    g.invaliderTout();
    expect(await g.estDelie('pn1')).toBe(false); // le geste vide le cache de SON process : aucune fenêtre
    expect(lectures).toEqual(['pn1', 'pn1', 'pn1']);
  });
});

// --------------------------------------------------------------------------------------------------------
// Une campagne lancée ou reprise pendant que le numéro est délié
// --------------------------------------------------------------------------------------------------------

class Destinataires implements RecipientStore {
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.pending; }
  async claim(): Promise<boolean> { return true; }
  async relacher(): Promise<void> {}
  async markResult(): Promise<void> {}
}
class Campagnes implements CampaignStore {
  readonly statuts: Array<{ status: string; pause?: { raison: MotifDePause; reprise: Date | null } }> = [];
  async setStatus(_id: string, status: Campaign['status'], pause?: { raison: MotifDePause; reprise: Date | null }): Promise<void> {
    this.statuts.push({ status, ...(pause ? { pause } : {}) });
  }
}
const qualite: QualityProvider = { getRating: async () => 'GREEN' };
const UN: Recipient[] = [{ id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' }];

const whatsapp: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'running', workflowId: null, ratePerMinute: null, startNodeId: null,
};

/**
 * La pause conditionnelle (`PgNumeroDelieStore.pauserCampagne`) : ce que le run lui a demandé, et ce que la base
 * aurait répondu (`ecrite` = le numéro est encore délié en base ET la campagne tournait encore).
 */
function base(ecrite: boolean): { appels: Array<[string, string, string]>; pauser: RunJobDeps['pauserSiNumeroDelie'] } {
  const appels: Array<[string, string, string]> = [];
  return { appels, pauser: async (id, tenant, pn) => { appels.push([id, tenant, pn]); return ecrite; } };
}

function depsRun(campagne: Campaign, campagnes: Campagnes, over: Partial<RunJobDeps> = {}): RunJobDeps {
  return {
    getCampaign: async () => campagne,
    senderFor: async (_c, pn) => { throw new NumeroDelieError(pn); },
    recipients: new Destinataires(UN),
    campaigns: campagnes,
    quality: qualite,
    pauserSiNumeroDelie: async () => true,
    ...over,
  };
}

describe('campagne et numéro délié', () => {
  it('🔴 le point de passage refuse : la pause `numero_delie` est ÉCRITE, par l’écriture conditionnelle, sans échéance', async () => {
    const campagnes = new Campagnes();
    const enBase = base(true);
    const report = await campaignRunJob({ campaignId: 'c1' }, depsRun(whatsapp, campagnes, { pauserSiNumeroDelie: enBase.pauser }));
    expect(report).toMatchObject({ sent: 0, failed: 0, paused: true });
    expect(report.reason).toBe(messageDePause('numero_delie', null, undefined));
    // 🔴 UNE instruction, sur la campagne, son espace et le numéro que le refus nomme : jamais une relecture
    // suivie d'un `setStatus` sans condition, qu'un « Relier » pouvait croiser (relecture du 2026-09-25).
    expect(enBase.appels).toEqual([['c1', 't1', 'pn1']]);
    expect(campagnes.statuts).toEqual([]);
  });

  /**
   * 🔴 LA GARDE MISE EN CACHE PEUT DIRE « DÉLIÉ » JUSTE APRÈS « RELIER ». Une pause écrite sur cette réponse ne se
   * lèverait jamais : le balayage de reprise ignore ce motif, et « Relier » a déjà eu lieu. La base tranche.
   */
  it('🔴 refus d’une garde périmée, numéro RELIÉ en base : AUCUNE pause écrite, la campagne reste en cours', async () => {
    const campagnes = new Campagnes();
    const report = await campaignRunJob({ campaignId: 'c1' }, depsRun(whatsapp, campagnes, { pauserSiNumeroDelie: base(false).pauser }));
    expect(campagnes.statuts).toEqual([]);
    expect(report).toEqual({ sent: 0, skipped: 0, failed: 0, paused: false, reason: RAISON_NUMERO_RELIE_ENTRE_TEMPS });
  });

  it('🔴 même quand WhatsApp n’est qu’un étage de REPLI : la campagne entière attend, personne n’échoue', async () => {
    const campagnes = new Campagnes();
    const rcsAvecRepli: Campaign = {
      ...whatsapp, phoneNumberId: '', channel: 'rcs', rcsAgentId: 'agent-1', rcsMessage: { kind: 'text', text: 'Offre' },
      chaine: [
        { rang: 1, canal: 'rcs', rcsMessage: { kind: 'text', text: 'Offre' } },
        { rang: 2, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
      ],
    };
    const enBase = base(true);
    const report = await campaignRunJob({ campaignId: 'c1' }, depsRun(rcsAvecRepli, campagnes, {
      numeroDuTenant: async () => 'pn1',
      rcsSenderFor: async () => ({ send: async () => ({ messageId: 'rcs-1' }) }) as never,
      pauserSiNumeroDelie: enBase.pauser,
    }));
    expect(report).toMatchObject({ paused: true, sent: 0, failed: 0 });
    expect(enBase.appels).toEqual([['c1', 't1', 'pn1']]);
  });

  it('le message dit QUI peut la relancer', () => {
    expect(messageDePause('numero_delie', null, undefined)).toMatch(/administrateur reliera le numéro/);
  });
});

// --------------------------------------------------------------------------------------------------------
// Pendant le run : un scénario démarré par destinataire construit un client PAR MESSAGE
// --------------------------------------------------------------------------------------------------------

/** Ce que le moteur a fait de chaque destinataire, dans l'ordre. */
class DestinatairesTraces implements RecipientStore {
  readonly gestes: string[] = [];
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.pending; }
  async claim(id: string): Promise<boolean> { this.gestes.push(`claim ${id}`); return true; }
  async relacher(id: string): Promise<void> { this.gestes.push(`relacher ${id}`); }
  async markResult(id: string, r: { status: string; error?: string }): Promise<void> {
    this.gestes.push(`${r.status} ${id}${r.error !== undefined ? ` (${r.error})` : ''}`);
  }
}
const DEUX: Recipient[] = [
  { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
  { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
];
const envoiInterdit: DepsMoteurDeTest['sender'] = {
  sendMarketing: async () => { throw new Error('aucun modèle direct dans ces cas'); },
  sendTemplate: async () => { throw new Error('aucun modèle direct dans ces cas'); },
};
const pausesDe = (c: Campagnes) => c.statuts.filter((s) => s.status === 'paused');

describe('campagne de scénario et numéro délié, en cours de run (le moteur)', () => {
  function monter(campagne: Campaign, delieEnBase: boolean) {
    const destinataires = new DestinatairesTraces(DEUX);
    const campagnes = new Campagnes();
    const demarrages: string[] = [];
    const enBase = base(delieEnBase);
    const refus = async (): Promise<boolean> => {
      demarrages.push('démarrage');
      throw new NumeroDelieError('pn1');
    };
    const deps: DepsMoteurDeTest = {
      sender: envoiInterdit, recipients: destinataires, campaigns: campagnes, quality: qualite,
      startWorkflow: refus,
      startWorkflowFromNode: refus,
      pauserSiNumeroDelie: enBase.pauser,
    };
    return { run: () => lancerCampagne(campagne, deps), destinataires, campagnes, demarrages, enBase };
  }

  /**
   * 🔴 LE DESTINATAIRE EST RENDU À LA FILE, JAMAIS `failed`. Un `failed` n'est pas repris par « Relier » : la
   * personne était perdue pour un état qu'un clic défait, et chaque suivant l'était aussi.
   */
  it.each([
    ['campagne de scénario', { ...whatsapp, workflowId: 'wf1' }],
    ['cible `node` (/v1/sends)', { ...whatsapp, workflowId: 'wf1', startNodeId: 'n1' }],
  ])('🔴 %s : destinataire RENDU à la file, pause `numero_delie`, et le suivant n’est pas tenté', async (_nom, campagne) => {
    const m = monter(campagne, true);
    const report = await m.run();
    expect(m.destinataires.gestes).toEqual(['claim r1', 'relacher r1']);
    expect(m.demarrages).toEqual(['démarrage']); // UN seul : r2 n'est pas tenté
    expect(report).toMatchObject({ sent: 0, failed: 0, paused: true, reason: messageDePause('numero_delie', null, undefined) });
    // La pause part par l'écriture conditionnelle, jamais par un `setStatus` sans condition.
    expect(m.enBase.appels).toEqual([['c1', 't1', 'pn1']]);
    expect(pausesDe(m.campagnes)).toEqual([]);
  });

  it('🔴 garde périmée, numéro RELIÉ en base : destinataire rendu à la file, AUCUNE pause, run arrêté', async () => {
    const m = monter({ ...whatsapp, workflowId: 'wf1' }, false);
    const report = await m.run();
    expect(m.destinataires.gestes).toEqual(['claim r1', 'relacher r1']);
    expect(pausesDe(m.campagnes)).toEqual([]);
    // Ni `completed` : il reste du monde en file, que le balayage des campagnes gelées reprendra.
    expect(m.campagnes.statuts.map((s) => s.status)).not.toContain('completed');
    expect(report).toMatchObject({ paused: false, reason: RAISON_NUMERO_RELIE_ENTRE_TEMPS });
  });

  /**
   * 🔴 « MESSAGE ET SCÉNARIO » : le message part par son canal (ici RCS), puis le scénario bute sur le numéro
   * délié. Ce destinataire reste `sent` (le rendre à la file lui renverrait le message), mais on s'arrête après
   * lui : chaque suivant recevrait son message sans jamais sa suite.
   */
  it('🔴 message et scénario : le destinataire reste `sent` avec sa raison, et le run s’arrête APRÈS lui', async () => {
    const destinataires = new DestinatairesTraces(DEUX.map((r) => ({ ...r, etageCourant: 2 })));
    const campagnes = new Campagnes();
    const envoisRcs: string[] = [];
    const campagne: Campaign = {
      ...whatsapp,
      channel: 'whatsapp',
      chaine: [
        { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
        { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'le repli' }, workflowId: 'wf-42' },
      ],
    };
    const enBase = base(true);
    const report = await lancerCampagne(campagne, {
      sender: envoiInterdit, recipients: destinataires, campaigns: campagnes, quality: qualite,
      canaux: { rcs: { sender: { sendTo: async (r) => { envoisRcs.push(r.toE164); return { messageId: `rcs-${r.id}` }; } } } },
      startWorkflow: async () => { throw new NumeroDelieError('pn1'); },
      pauserSiNumeroDelie: enBase.pauser,
    });
    expect(envoisRcs).toEqual(['+33611']);
    expect(destinataires.gestes).toEqual(['claim r1', `sent r1 (Scénario non démarré : ${MESSAGE_NUMERO_DELIE})`]);
    expect(report).toMatchObject({ sent: 1, failed: 0, paused: true });
    expect(enBase.appels).toEqual([['c1', 't1', 'pn1']]);
  });

  /**
   * 🔴 LE DERNIER DESTINATAIRE NE MET PAS LA CAMPAGNE EN PAUSE (relecture du 2026-09-25). Il ne reste personne à
   * protéger : s'arrêter là sautait le statut de sortie, et la campagne restait `running` sans destinataire en
   * attente, que le balayage des campagnes gelées ne relance jamais. L'écran la disait « en cours » à vie.
   */
  it('🔴 message et scénario, DERNIER destinataire : pas de pause, la campagne sort `completed`', async () => {
    const destinataires = new DestinatairesTraces([{ ...DEUX[0]!, etageCourant: 2 }]);
    const campagnes = new Campagnes();
    const enBase = base(true);
    const campagne: Campaign = {
      ...whatsapp,
      channel: 'whatsapp',
      chaine: [
        { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
        { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'le repli' }, workflowId: 'wf-42' },
      ],
    };
    const report = await lancerCampagne(campagne, {
      sender: envoiInterdit, recipients: destinataires, campaigns: campagnes, quality: qualite,
      canaux: { rcs: { sender: { sendTo: async (r) => ({ messageId: `rcs-${r.id}` }) } } },
      startWorkflow: async () => { throw new NumeroDelieError('pn1'); },
      pauserSiNumeroDelie: enBase.pauser,
    });
    expect(destinataires.gestes).toEqual(['claim r1', `sent r1 (Scénario non démarré : ${MESSAGE_NUMERO_DELIE})`]);
    expect(report).toMatchObject({ sent: 1, failed: 0, paused: false });
    expect(enBase.appels).toEqual([]);
    // `running` à l'entrée du run, puis le statut de SORTIE : c'est lui que l'arrêt anticipé sautait.
    expect(campagnes.statuts).toEqual([{ status: 'running' }, { status: 'completed' }]);
  });
});

// --------------------------------------------------------------------------------------------------------
// Le webhook : les entrants d'un numéro délié sont écartés, accusés gardés
// --------------------------------------------------------------------------------------------------------

const change = (pn: string, value: Record<string, unknown>, field = 'messages') => ({
  field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pn, display_phone_number: '33500' }, ...value },
});
const payloadDe = (...changes: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes }] });
const message = (id: string, from = '33611') => ({ id, from, type: 'text', text: { body: 'coucou' }, timestamp: '1758790000' });
const accuse = (id: string) => ({ id, status: 'delivered', recipient_id: '33611', timestamp: '1758790000' });

describe('l’écart des entrants (fonction pure)', () => {
  it('🔴 retire les messages du numéro délié, GARDE ses accusés, ne touche pas à un autre numéro', () => {
    const p = payloadDe(
      change('pn-delie', { messages: [message('w1')], statuses: [accuse('s1')], contacts: [{ wa_id: '33611' }] }),
      change('pn-relie', { messages: [message('w2')] }),
    );
    const { payload, ecartes } = ecarterLesNumerosDelies(p, new Set(['pn-delie']));
    expect(ecartes).toEqual([{ phoneNumberId: 'pn-delie', elements: 1 }]);
    const changes = (payload as { entry: Array<{ changes: Array<{ value: Record<string, unknown> }> }> }).entry[0]!.changes;
    expect(changes).toHaveLength(2);
    expect(changes[0]!.value['messages']).toBeUndefined();
    expect(changes[0]!.value['contacts']).toBeUndefined();
    expect(changes[0]!.value['statuses']).toEqual([accuse('s1')]);
    expect(changes[1]!.value['messages']).toEqual([message('w2')]);
    // Le payload reçu n'est jamais modifié.
    expect((p.entry[0]!.changes[0] as { value: Record<string, unknown> }).value['messages']).toEqual([message('w1')]);
  });

  it('🔴 un standby (messages imbriqués sous `value.standby`) et une bascule de contrôle sont écartés aussi', () => {
    const standby = { field: 'standby', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'pn-delie' }, standby: { messages: [message('w3')] } } };
    const bascule = { field: 'messaging_handovers', value: { recipient: { phone_number_id: 'pn-delie' }, sender: { phone_number: '33611' } } };
    const { payload, ecartes } = ecarterLesNumerosDelies(payloadDe(standby, bascule), new Set(['pn-delie']));
    expect(ecartes).toEqual([{ phoneNumberId: 'pn-delie', elements: 1 }, { phoneNumberId: 'pn-delie', elements: 1 }]);
    expect((payload as { entry: Array<{ changes: unknown[] }> }).entry[0]!.changes).toEqual([]);
  });

  it('aucun numéro délié : le MÊME objet ressort, rien n’est recopié', () => {
    const p = payloadDe(change('pn-relie', { messages: [message('w1')] }));
    expect(ecarterLesNumerosDelies(p, new Set()).payload).toBe(p);
    expect(ecarterLesNumerosDelies(p, new Set(['pn-autre'])).payload).toBe(p);
  });

  it('🔴 un lot d’ACCUSÉS purs ne demande aucune lecture', () => {
    expect(numerosAInterroger(payloadDe(change('pn-delie', { statuses: [accuse('s1')] })))).toEqual([]);
    expect(numerosAInterroger(payloadDe(change('pn-delie', { messages: [message('w1')] })))).toEqual(['pn-delie']);
  });
});

describe('l’écart des entrants dans le job webhook', () => {
  function inbox() {
    const enregistres: string[] = [];
    return {
      enregistres,
      store: { phoneNumberTenant: async () => 't1', recordInbound: async (_t: string, m: InboundMessage) => { enregistres.push(m.messageId); } },
    };
  }
  const bruts: string[] = [];
  const store = { insertEvent: async (e: { dedupKey: string }) => { bruts.push(e.dedupKey); return true; } };

  it('🔴 un entrant du numéro délié n’est ni journalisé brut ni enregistré ; celui d’un autre numéro l’est', async () => {
    bruts.length = 0;
    const lectures: Array<readonly string[]> = [];
    const i = inbox();
    await handleWebhookJob(
      payloadDe(change('pn-delie', { messages: [message('w-delie')] }), change('pn-relie', { messages: [message('w-relie', '33622')] })),
      {
        store, inbox: i.store, arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse,
        numerosDelies: async (ids) => { lectures.push(ids); return new Set(['pn-delie']); },
      },
    );
    expect(i.enregistres).toEqual(['w-relie']);
    expect(bruts).toEqual(['msg:w-relie']);
    // UNE lecture pour tout le lot, avec les deux clés.
    expect(lectures).toEqual([['pn-delie', 'pn-relie']]);
  });

  it('🔴 une lecture qui ÉCHOUE ne fait pas échouer le job : le lot est traité comme avant', async () => {
    const i = inbox();
    await expect(handleWebhookJob(payloadDe(change('pn-x', { messages: [message('w-x')] })), {
      store, inbox: i.store, arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse,
      numerosDelies: async () => { throw new Error('base indisponible'); },
    })).resolves.toBeUndefined();
    expect(i.enregistres).toEqual(['w-x']);
  });

  it('écart journalisé, sans le contenu du message', async () => {
    const lignes: string[] = [];
    const log = console.log;
    console.log = (l: string) => { lignes.push(l); };
    try {
      await ecarterLesEntrantsDelies(payloadDe(change('pn-delie', { messages: [message('w1')] })), async () => new Set(['pn-delie']));
    } finally {
      console.log = log;
    }
    expect(lignes).toHaveLength(1);
    expect(JSON.parse(lignes[0]!)).toEqual({ lvl: 'info', msg: 'entrant_ecarte_numero_delie', phoneNumberId: 'pn-delie', elements: 1 });
    expect(lignes[0]).not.toContain('coucou');
  });
});

// --------------------------------------------------------------------------------------------------------
// Le refus arrive lisible à l'écran
// --------------------------------------------------------------------------------------------------------

const SECRET = 'test-secret';
let jeton = '';
beforeAll(async () => { jeton = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET); });
const aucunUtilisateur: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

describe('une réponse d’Inbox depuis un numéro délié', () => {
  it('🔴 409 avec la phrase, jamais un 500 opaque, et rien n’est enregistré comme parti', async () => {
    const traces: string[] = [];
    const deps: InboxRouteDeps = {
      estDesabonne: jamaisDesabonne,
      listConversations: async () => [],
      getConversationContext: async () => ({ waId: '33611', windowOpen: true, lastInboundAt: '2026-09-25T00:00:00.000Z' }),
      getMessages: async () => [],
      recordOutbound: async () => { traces.push('trace'); },
      getTenantPhoneNumberId: async () => 'pn1',
      sendReply: async (_t, pn) => { throw new NumeroDelieError(pn); },
      sendTemplateMessage: async () => 'wamid.TPL',
    };
    const serveur = buildServer({ queue: new FakeQueue(), auth: { users: aucunUtilisateur, secret: SECRET }, inbox: deps });
    const res = await serveur.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/reply',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` }, payload: { text: 'Bonjour' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: MESSAGE_NUMERO_DELIE });
    expect(traces).toEqual([]);
    await serveur.close();
  });
});
