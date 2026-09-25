import { describe, it, expect } from 'vitest';
import { campaignRunJob } from '../src/campaign/run-job';
import type { RunJobDeps } from '../src/campaign/run-job';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  QualityProvider,
} from '../src/campaign/engine';
import type { Campaign, Recipient, QualityRating } from '../src/campaign/types';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';
import { MetaApiError } from '../src/meta/errors';
import { TokenInvalidError } from '../src/meta/credentials';
import { campaignJobExpireSeconds } from '../src/campaign/pacing';
import { BAIL_SECONDES } from '../src/campaign/run-lock';

class FakeSender implements MessageSender {
  readonly calls: string[] = [];
  readonly marketingCalls: string[] = [];
  readonly templateCalls: string[] = [];
  failFor: Set<string> = new Set();
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    const to = p.to ?? p.recipient ?? '';
    if (this.failFor.has(to)) throw new MetaApiError(400, { code: 131049, message: 'blocked' });
    this.calls.push(to);
    this.marketingCalls.push(to);
    return { messageId: `m-${to}` };
  }
  async sendTemplate(to: string, _tpl: TemplateSpec): Promise<SendResult> {
    if (this.failFor.has(to)) throw new MetaApiError(400, { code: 131049, message: 'blocked' });
    this.calls.push(to);
    this.templateCalls.push(to);
    return { messageId: `m-${to}` };
  }
}
class FakeRecipients implements RecipientStore {
  readonly results = new Map<string, { status: string }>();
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> {
    return this.pending;
  }
  async claim(): Promise<boolean> {
    return true;
  }
  async relacher(): Promise<void> {}
  async markResult(id: string, r: { status: 'sent' | 'failed' | 'skipped' }): Promise<void> {
    this.results.set(id, { status: r.status });
  }
}
class FakeCampaigns implements CampaignStore {
  async setStatus(): Promise<void> {}
}
class FakeQuality implements QualityProvider {
  constructor(private readonly rating: QualityRating = 'GREEN') {}
  async getRating(): Promise<QualityRating> {
    return this.rating;
  }
}

const campaign: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft', workflowId: null, ratePerMinute: null, startNodeId: null,
};

function deps(over: Partial<RunJobDeps> & { getCampaign: RunJobDeps['getCampaign'] }): RunJobDeps {
  return {
    senderFor: async () => new FakeSender(),
    recipients: new FakeRecipients([]),
    campaigns: new FakeCampaigns(),
    quality: new FakeQuality(),
    pauserSiNumeroDelie: async () => false,
    ...over,
  };
}

describe('campaignRunJob', () => {
  it('charge la campagne et exécute le run -> report exact', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
      { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ getCampaign: async () => campaign, senderFor: async () => sender, recipients }),
    );
    expect(report).toMatchObject({ sent: 2, failed: 0, paused: false });
    expect(sender.calls).toEqual(['+33611', '+33622']);
  });

  it('campagne utility -> route via sendTemplate à travers l assemblage run-job', async () => {
    const sender = new FakeSender();
    const util: Campaign = { ...campaign, category: 'utility' };
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ getCampaign: async () => util, senderFor: async () => sender, recipients }),
    );
    expect(report.sent).toBe(1);
    expect(sender.templateCalls).toEqual(['+33611']);
    expect(sender.marketingCalls).toEqual([]);
  });

  it('échec sender -> destinataire failed + report exact via run-job', async () => {
    const sender = new FakeSender();
    sender.failFor = new Set(['+33611']);
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
      { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({ getCampaign: async () => campaign, senderFor: async () => sender, recipients }),
    );
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed' });
    expect(recipients.results.get('r2')).toMatchObject({ status: 'sent' });
  });

  it('campagne WORKFLOW : startWorkflow reçoit les params résolus du 1er template (5e arg)', async () => {
    const captured: string[][] = [];
    const wf: Campaign = { ...campaign, workflowId: 'wf1', templateName: '' };
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: ['Julie'], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => wf,
        recipients,
        // Les capacités du moteur voyagent en BLOC depuis le constat C1 : le job les transmet d'un seul
        // spread, il ne les recopie plus une par une.
        moteur: { startWorkflow: async (_t, _w, _waId, _cid, params) => { captured.push(params); } },
      }),
    );
    expect(report.sent).toBe(1);
    expect(captured).toEqual([['Julie']]);
  });

  // Sans ce passthrough, TOUTE campagne node échouerait en prod (« startWorkflowFromNode non câblé ») alors que
  // le test du moteur resterait vert : il prouve que runCampaign appelle le callback, pas que le job le transmet.
  it('campagne NODE : campaignRunJob transmet startWorkflowFromNode au moteur', async () => {
    const captured: string[] = [];
    const node: Campaign = { ...campaign, workflowId: 'wf1', startNodeId: 'n5', templateName: '' };
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'ct1', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => node,
        recipients,
        moteur: {
          startWorkflow: async () => { throw new Error('ne doit pas être appelé sur une cible node'); },
          startWorkflowFromNode: async (_t, wf, nodeId, waId, cid) => { captured.push(`${wf}:${nodeId}:${waId}:${cid}`); },
        },
      }),
    );
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(captured).toEqual(['wf1:n5:33611:ct1']);
  });

  it('débit PAR CAMPAGNE : ratePerMinute posé -> RateLimiter d intervalle ceil(60000/rate), acquire avant chaque envoi', async () => {
    const intervals: number[] = [];
    let acquires = 0;
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
      { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
    ]);
    const staticGate = { acquire: async () => { throw new Error('le limiteur statique ne doit PAS être utilisé quand un débit par campagne est posé'); } };
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => ({ ...campaign, ratePerMinute: 30 }),
        recipients,
        rateLimiter: staticGate, // doit être IGNORÉ au profit du limiteur par campagne
        makeRateLimiter: (ms) => { intervals.push(ms); return { acquire: async () => { acquires += 1; } }; },
      }),
    );
    expect(report.sent).toBe(2);
    expect(intervals).toEqual([2000]); // ceil(60000/30) = 2000 ms, un SEUL limiteur construit pour le run
    expect(acquires).toBe(2); // une acquisition par destinataire
  });

  it('débit PAR CAMPAGNE : ratePerMinute null -> aucun limiteur par campagne, le limiteur statique (s il existe) est utilisé', async () => {
    let made = 0;
    let acquires = 0;
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => ({ ...campaign, ratePerMinute: null }),
        recipients,
        rateLimiter: { acquire: async () => { acquires += 1; } },
        makeRateLimiter: () => { made += 1; return { acquire: async () => {} }; },
      }),
    );
    expect(made).toBe(0); // pas de débit -> pas de limiteur par campagne construit
    expect(acquires).toBe(1); // le limiteur statique fourni est utilisé tel quel
  });

  it('défaut serveur : ratePerMinute null + defaultRatePerMinute 30 -> limiteur construit à 2000 ms, acquire par destinataire', async () => {
    const intervals: number[] = [];
    let acquires = 0;
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
      { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => ({ ...campaign, ratePerMinute: null }),
        recipients,
        defaultRatePerMinute: 30, // le worker l'injecte en prod ; ici on prouve qu'il freine une campagne sans rate
        makeRateLimiter: (ms) => { intervals.push(ms); return { acquire: async () => { acquires += 1; } }; },
      }),
    );
    expect(report.sent).toBe(2);
    expect(intervals).toEqual([2000]); // ceil(60000/30), le défaut serveur s'applique comme un rate posé
    expect(acquires).toBe(2);
  });

  it('défaut serveur : le rate posé sur la campagne PRIME sur le défaut serveur', async () => {
    const intervals: number[] = [];
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => ({ ...campaign, ratePerMinute: 60 }),
        recipients,
        defaultRatePerMinute: 30,
        makeRateLimiter: (ms) => { intervals.push(ms); return { acquire: async () => {} }; },
      }),
    );
    expect(intervals).toEqual([1000]); // ceil(60000/60), le 60 de la campagne l'emporte sur le défaut 30
  });

  it('défaut serveur : defaultRatePerMinute 0 (opt-out) + ratePerMinute null -> aucun limiteur', async () => {
    let made = 0;
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => ({ ...campaign, ratePerMinute: null }),
        recipients,
        defaultRatePerMinute: 0, // opt-out explicite : le défaut serveur désactivé remet le plein régime
        makeRateLimiter: () => { made += 1; return { acquire: async () => {} }; },
      }),
    );
    expect(made).toBe(0); // aucun frein construit
    expect(report.sent).toBe(1);
  });

  it('garde d appartenance : numéro réaffecté à un autre tenant -> aucun envoi, rapport paused', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => campaign,
        senderFor: async () => sender,
        recipients,
        phoneNumberBelongsToTenant: async () => false, // le numéro n'appartient plus au tenant
      }),
    );
    expect(report).toMatchObject({ sent: 0, paused: true });
    expect(report.reason).toMatch(/rattaché/);
    expect(sender.calls).toEqual([]); // rien n'est parti
  });

  it('token révoqué (senderFor throw TokenInvalidError) -> campagne en PAUSE, pas de rejeu pg-boss', async () => {
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    // La résolution du token échoue (WABA marqué invalid). campaignRunJob doit CATCHER et renvoyer un rapport
    // paused, PAS laisser le throw remonter (sinon pg-boss rejoue le job en boucle).
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => campaign,
        senderFor: async () => { throw new TokenInvalidError('waba-x'); },
        recipients,
      }),
    );
    expect(report).toMatchObject({ sent: 0, paused: true });
    expect(report.reason).toMatch(/révoqué|reconnectez/i);
  });

  it('une autre erreur pendant senderFor -> remonte (vraie panne, pas une pause déguisée)', async () => {
    await expect(
      campaignRunJob(
        { campaignId: 'c1' },
        deps({ getCampaign: async () => campaign, senderFor: async () => { throw new Error('réseau'); } }),
      ),
    ).rejects.toThrow(/réseau/);
  });

  it('garde d appartenance : numéro toujours rattaché -> envoi normal', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => campaign,
        senderFor: async () => sender,
        recipients,
        phoneNumberBelongsToTenant: async () => true,
      }),
    );
    expect(report.sent).toBe(1);
    expect(sender.calls).toEqual(['+33611']);
  });

  it('garde d appartenance ABSENTE (deps de test sans la garde) -> envoi normal, e2e non cassé', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([
      { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
    ]);
    // deps() n'injecte PAS phoneNumberBelongsToTenant : la garde est sautée, comportement d'avant préservé.
    const report = await campaignRunJob({ campaignId: 'c1' }, deps({ getCampaign: async () => campaign, senderFor: async () => sender, recipients }));
    expect(report.sent).toBe(1);
  });

  it('campagne inconnue -> throw', async () => {
    await expect(
      campaignRunJob({ campaignId: 'nope' }, deps({ getCampaign: async () => null })),
    ).rejects.toThrow(/inconnue/);
  });

  it('payload sans campaignId -> throw', async () => {
    await expect(
      campaignRunJob({}, deps({ getCampaign: async () => campaign })),
    ).rejects.toThrow(/campaignId/);
  });
});


/**
 * Une campagne AU FIL DE L'EAU arrêtée ne doit PAS repartir. Le moteur remet toute campagne au fil de l'eau en
 * `running` en sortie de run : exécuter un job en retard (enfilé juste avant l'arrêt) la ressusciterait, et
 * enverrait un message que l'opérateur croit avoir coupé.
 */
describe('campaignRunJob : campagne au fil de l eau arrêtée', () => {
  const arretee: Campaign = { ...campaign, webhookId: 'wh1', status: 'completed' };

  it('🔴 un job en retard n envoie RIEN et ne ressuscite pas la campagne', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([{ id: 'r1', contactId: 'ct1', toE164: '+33611', resolvedParams: [], status: 'pending' }]);
    let statuts = 0;
    const rapport = await campaignRunJob({ campaignId: 'c1' }, deps({
      getCampaign: async () => arretee,
      senderFor: async () => sender,
      recipients,
      campaigns: { setStatus: async () => { statuts += 1; } },
    }));
    expect(sender.calls).toEqual([]);
    expect(statuts).toBe(0); // aucun passage en `running` : elle reste arrêtée
    expect(rapport.sent).toBe(0);
    expect(rapport.reason).toContain('arrêtée');
  });

  it('la même campagne EN COURS envoie normalement (la garde ne déborde pas)', async () => {
    const sender = new FakeSender();
    const recipients = new FakeRecipients([{ id: 'r1', contactId: 'ct1', toE164: '+33611', resolvedParams: [], status: 'pending' }]);
    await campaignRunJob({ campaignId: 'c1' }, deps({
      getCampaign: async () => ({ ...arretee, status: 'running' }),
      senderFor: async () => sender,
      recipients,
    }));
    expect(sender.calls).toEqual(['+33611']);
  });

  it('une campagne ORDINAIRE terminée garde son comportement d avant', async () => {
    // Elle n'a pas de webhook : un job en retard la refait tourner comme avant, ce qui est inoffensif
    // (le claim par destinataire empêche tout double envoi) et hors du périmètre de ce lot.
    const sender = new FakeSender();
    const recipients = new FakeRecipients([{ id: 'r1', contactId: 'ct1', toE164: '+33611', resolvedParams: [], status: 'pending' }]);
    await campaignRunJob({ campaignId: 'c1' }, deps({
      getCampaign: async () => ({ ...campaign, status: 'completed' }),
      senderFor: async () => sender,
      recipients,
    }));
    expect(sender.calls).toEqual(['+33611']);
  });
});

/**
 * PAUSE (R13). Le moteur remet toute campagne en `running` à son démarrage : sans cette garde, un job enfilé
 * AVANT la pause et démarré après la ressusciterait, et l'envoi que l'opérateur vient de couper repartirait.
 * Le cas est atteignable : la file ne déduplique rien, plusieurs `campaign-run` peuvent attendre (cf. R1).
 */
describe('campaignRunJob : campagne en pause', () => {
  it("🔴 refuse de démarrer, n'envoie RIEN et ne la remet pas en cours", async () => {
    const sender = new FakeSender();
    const enPause: Campaign = { ...campaign, status: 'paused' };
    const statuts: string[] = [];
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => enPause,
        senderFor: async () => sender,
        recipients: new FakeRecipients([{ id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' }]),
        campaigns: { setStatus: async (_id, s) => { statuts.push(s); } },
      }),
    );
    expect(report).toMatchObject({ sent: 0, paused: true, reason: 'campagne en pause' });
    expect(sender.calls).toEqual([]);
    expect(statuts).toEqual([]);
  });

  it('contrôle : la MÊME campagne en `running` part normalement (la garde ne déborde pas)', async () => {
    const sender = new FakeSender();
    const enCours: Campaign = { ...campaign, status: 'running' };
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => enCours,
        senderFor: async () => sender,
        recipients: new FakeRecipients([{ id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' }]),
      }),
    );
    expect(report).toMatchObject({ sent: 1, paused: false });
    expect(sender.calls).toEqual(['+33611']);
  });
});

/**
 * SÉRIALISATION des runs (R1-bis). Le verrou lui-même est du SQL, prouvé dans
 * `tests/integration/stores.integration.test.ts` ; ici on prouve le CÂBLAGE : qui est appelé, avec quoi, et
 * dans quel ordre. Les deux sont nécessaires, aucun ne remplace l'autre.
 */
class VerrouFake {
  readonly acquis: Array<{ campaignId: string; tenantId: string; leaseSeconds: number }> = [];
  readonly rendus: Array<{ campaignId: string; holder: string }> = [];
  constructor(private readonly jeton: string | null, private readonly rerun = false) {}
  async acquire(campaignId: string, tenantId: string, leaseSeconds: number): Promise<string | null> {
    this.acquis.push({ campaignId, tenantId, leaseSeconds });
    return this.jeton;
  }
  async release(_c: string, _t: string, holder: string): Promise<{ rerunDemande: boolean }> {
    this.rendus.push({ campaignId: _c, holder });
    return { rerunDemande: this.rerun };
  }
  /** Le renouvellement REUSSIT par defaut : un fake qui echouerait ferait sortir tous les runs des tests. */
  renouvelle = 0;
  async renouveler(): Promise<boolean> { this.renouvelle += 1; return true; }
}
function avecVerrou(verrou: VerrouFake, over: Partial<RunJobDeps> & { getCampaign: RunJobDeps['getCampaign'] }, relances: string[] = [], enAttente = 0): RunJobDeps {
  return deps({
    ...over,
    serialisation: {
      verrou,
      enAttente: async () => enAttente,
      relancer: async (id) => { relances.push(id); },
    },
  });
}

describe('campaignRunJob : un seul run vivant par campagne', () => {
  it('🔴 verrou tenu par un run vivant -> ce job N’ENVOIE RIEN et ne lève pas (lever le ferait rejouer en boucle)', async () => {
    const sender = new FakeSender();
    const verrou = new VerrouFake(null);
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      avecVerrou(verrou, {
        getCampaign: async () => campaign,
        senderFor: async () => sender,
        recipients: new FakeRecipients([{ id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' }]),
      }),
    );
    expect(report).toMatchObject({ sent: 0, paused: false, reason: 'un run de cette campagne est déjà en cours' });
    expect(sender.calls).toEqual([]);
    expect(verrou.rendus).toEqual([]); // on ne rend pas un verrou qu'on n'a jamais pris
  });

  it('contrôle : verrou libre -> le run part, puis le verrou est RENDU avec son jeton', async () => {
    const sender = new FakeSender();
    const verrou = new VerrouFake('jeton-1');
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      avecVerrou(verrou, {
        getCampaign: async () => campaign,
        senderFor: async () => sender,
        recipients: new FakeRecipients([{ id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' }]),
      }),
    );
    expect(report).toMatchObject({ sent: 1 });
    expect(verrou.rendus).toEqual([{ campaignId: 'c1', holder: 'jeton-1' }]);
  });

  it('🔴 le bail est COURT et CONSTANT : c’est ce qui rend une campagne reprenable après un worker tué', async () => {
    // Ce test affirmait l'inverse jusqu'au 2026-08-31 : le bail était calé sur l'expiration du job pg-boss,
    // dimensionnée en HEURES. Juste pour un bail qu'on ne renouvelle pas, et faux dès qu'on veut REPRENDRE une
    // campagne interrompue (R4) : le verrou d'un process mort serait resté « vivant » des heures, et le
    // balayage de reprise aurait sagement attendu. Court + renouvelé, un process tué libère en deux minutes.
    const verrou = new VerrouFake('jeton-1');
    await campaignRunJob({ campaignId: 'c1' }, avecVerrou(verrou, { getCampaign: async () => campaign }, [], 1000));
    expect(verrou.acquis[0]).toMatchObject({ campaignId: 'c1', tenantId: 't1' });
    expect(verrou.acquis[0]!.leaseSeconds).toBe(BAIL_SECONDES);
    // Et il ne dépend PAS du nombre de destinataires : mille en attente n'y changent rien.
    expect(verrou.acquis[0]!.leaseSeconds).toBeLessThan(campaignJobExpireSeconds(1000, 0));
  });

  it('🔴 relance demandée pendant le run -> UN relancement, pour le travail que ce run n’a pas vu', async () => {
    const relances: string[] = [];
    await campaignRunJob({ campaignId: 'c1' }, avecVerrou(new VerrouFake('jeton-1', true), { getCampaign: async () => campaign }, relances));
    expect(relances).toEqual(['c1']);
  });

  it('aucune relance demandée -> aucun relancement (sinon les runs s’enchaîneraient sans fin)', async () => {
    const relances: string[] = [];
    await campaignRunJob({ campaignId: 'c1' }, avecVerrou(new VerrouFake('jeton-1', false), { getCampaign: async () => campaign }, relances));
    expect(relances).toEqual([]);
  });

  it('🔴 run en échec : le verrou est RENDU quand même, et SANS relance (pg-boss rejoue déjà ce job)', async () => {
    const relances: string[] = [];
    const verrou = new VerrouFake('jeton-1', true);
    await expect(campaignRunJob(
      { campaignId: 'c1' },
      avecVerrou(verrou, {
        getCampaign: async () => campaign,
        recipients: { listPending: async () => { throw new Error('base indisponible'); }, claim: async () => true, relacher: async () => {}, markResult: async () => {} },
      }, relances),
    )).rejects.toThrow('base indisponible');
    expect(verrou.rendus).toEqual([{ campaignId: 'c1', holder: 'jeton-1' }]);
    expect(relances).toEqual([]);
  });

  it('🔴 une libération qui échoue ne fait PAS échouer le job (ce serait ré-envoyer ce qui vient de partir)', async () => {
    const sender = new FakeSender();
    const verrouCasse = {
      acquire: async () => 'jeton-1',
      release: async () => { throw new Error('base indisponible'); },
      renouveler: async () => true,
    };
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => campaign,
        senderFor: async () => sender,
        recipients: new FakeRecipients([{ id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' }]),
        serialisation: { verrou: verrouCasse, enAttente: async () => 0, relancer: async () => {} },
      }),
    );
    expect(report).toMatchObject({ sent: 1 }); // l'envoi a bien eu lieu, le rapport le dit
    expect(sender.calls).toEqual(['+33611']);
  });

  it('sans sérialisation câblée : comportement d’avant, mot pour mot', async () => {
    const sender = new FakeSender();
    const report = await campaignRunJob(
      { campaignId: 'c1' },
      deps({
        getCampaign: async () => campaign,
        senderFor: async () => sender,
        recipients: new FakeRecipients([{ id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' }]),
      }),
    );
    expect(report).toMatchObject({ sent: 1 });
  });
});

/**
 * LOTS COURTS (lot 5 du programme, 2026-08-31) : quand le run rend la main sur sa durée, c'est le job qui le
 * REPART. Sans cette relance, la campagne attendrait le balayage de reprise (une minute) entre chaque lot,
 * ce qui rallongerait une campagne de plusieurs heures d'autant de minutes qu'elle a de lots.
 */
describe('campaignRunJob : un lot qui rend la main se réenfile', () => {
  it('🔴 rapport avec `reste` -> relance, APRÈS avoir rendu le verrou', async () => {
    const relances: string[] = [];
    const verrou = new VerrouFake('jeton-1', false);
    const rapport = await campaignRunJob(
      { campaignId: 'c1' },
      avecVerrou(verrou, {
        getCampaign: async () => campaign,
        // Deux destinataires, et le moteur s'arrête sur sa durée dès le PREMIER traité : il en reste un.
        recipients: new FakeRecipients([
          { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
          { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
        ]),
        // Idem : la durée maximale et l'horloge sont des capacités du MOTEUR, elles voyagent avec les autres.
        moteur: {
          dureeMaxMs: 1,
          now: (() => { let t = 1_000; return () => { t += 10_000; return t; }; })(),
        },
      }, relances),
    );
    expect(rapport.reste).toBe(true);
    expect(relances).toEqual(['c1']);
    // 🔴 L'ORDRE compte : le verrou est rendu AVANT la relance, sinon le job suivant se heurterait à lui et
    // se contenterait de demander un rerun, ce qui rallongerait le trajet pour rien.
    expect(verrou.rendus).toEqual([{ campaignId: 'c1', holder: 'jeton-1' }]);
  });

  it('un run qui va au bout ne se relance PAS', async () => {
    const relances: string[] = [];
    const rapport = await campaignRunJob(
      { campaignId: 'c1' },
      avecVerrou(new VerrouFake('jeton-1', false), { getCampaign: async () => campaign }, relances),
    );
    expect(rapport.reste).toBeUndefined();
    expect(relances).toEqual([]);
  });
});
