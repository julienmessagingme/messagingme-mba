import { describe, it, expect } from 'vitest';
import { composerPassageEquipe, pushHandoffJob, type PushHandoffDeps } from '../src/analysis/push-handoff';
import { flagSelonLeChoix, pousserHandoff, HubspotServiceError, type CorpsHandoff, type IssueHandoff } from '../src/crm/hubspot-service';
import type { EtatPassage } from '../src/analysis/enrichment';
import { ATTENTE_RECENTE_MS, FENETRE_MS } from '../src/emails-produit/alertes';
import { signRequest } from '../src/lib/signature';
import type { HttpTransport, HttpResponse } from '../src/meta/http';

/**
 * LE PASSAGE À L'ÉQUIPE POUSSÉ À HUBSPOT (lot 1 de la reprise humaine, 2026-10-23) : la composition qui enfile, le
 * job qui relit et pousse, le client de `POST /service/handoff`. Le câblage d'un scénario (aucun chemin de masse
 * n'enfile) est gardé dans `tests/controle-du-fil-cablage.test.ts`, celui du socle dans `tests/socle.test.ts`.
 */

const ESCALADEE = new Date('2026-10-23T09:15:30.123Z');
const DERNIER_IN = new Date('2026-10-23T09:14:00.000Z');
const etat = (over: Partial<EtatPassage> = {}): EtatPassage => ({
  conversationId: 'conv-1', contactE164: '+33600000001', nom: 'Camille', whatsappLine: '+33525680250',
  dernierEntrantLe: DERNIER_IN, escaladeeLe: ESCALADEE, controlOwner: 'app_human', dernierSens: 'in', ...over,
});

function banc(over: Partial<PushHandoffDeps> = {}, e: EtatPassage | null = etat()) {
  const pousses: CorpsHandoff[] = [];
  const lus: string[][] = [];
  const inscrits: Array<{ occasion: string; nature: string; depuis: Date; conversationId: string; tenantId: string }> = [];
  const clos: string[] = [];
  const d: PushHandoffDeps = {
    passageBranche: async () => true,
    lireEtat: async (t, w) => { lus.push([t, w]); return e; },
    numeros: { getHubspotGateStatus: async () => ({ connected: true, pausedAt: null }) },
    lienConversation: (id) => `https://console.exemple.test/inbox?c=${encodeURIComponent(id)}`,
    pousser: async (c) => { pousses.push(c); return { issue: 'fait', created: true, taskId: 'task-1' }; },
    estDesabonne: async () => false,
    passages: {
      inscrire: async (p) => { inscrits.push(p); return true; },
      clore: async (o) => { clos.push(o); },
    },
    ...over,
  };
  return { d, pousses, lus, inscrits, clos };
}

describe('composerPassageEquipe : l’e-mail ET l’enfilement, sans jamais faire échouer l’appelant', () => {
  it('🔴 enfile la référence seule, puis envoie l’e-mail', async () => {
    const appels: unknown[] = [];
    const prevenir = composerPassageEquipe(
      async (t, w) => { appels.push(['email', t, w]); },
      async (job) => { appels.push(['enfile', job]); },
    );
    await prevenir('t1', '33600000001');
    expect(appels).toEqual([['enfile', { tenantId: 't1', waId: '33600000001' }], ['email', 't1', '33600000001']]);
  });

  it('🔴 un enfilement qui échoue ne remonte pas, et l’e-mail part quand même', async () => {
    const appels: unknown[] = [];
    const prevenir = composerPassageEquipe(
      async (t) => { appels.push(['email', t]); },
      async () => { throw new Error('pg-boss indisponible'); },
    );
    await expect(prevenir('t1', 'w')).resolves.toBeUndefined();
    expect(appels).toEqual([['email', 't1']]);
  });

  it('sans connecteur (`enfiler` nul) : l’e-mail seul, la même fonction', () => {
    const email = async (): Promise<void> => {};
    expect(composerPassageEquipe(email, null)).toBe(email);
  });
});

describe('pushHandoffJob : relit l’état frais, s’arrête sans escalade ni portail, pousse le contrat', () => {
  it('🔴 pousse le corps du contrat : occasion = conversation:escaladee_le ISO, fin de fenêtre = dernier entrant + 24 h', async () => {
    const { d, pousses, lus } = banc();
    await pushHandoffJob({ tenantId: 't1', waId: '33600000001' }, d);
    expect(lus).toEqual([['t1', '33600000001']]);
    expect(pousses).toEqual([{
      tenantId: 't1',
      e164: '+33600000001',
      nom: 'Camille',
      conversationId: 'conv-1',
      lienConversation: 'https://console.exemple.test/inbox?c=conv-1',
      finFenetre: new Date(DERNIER_IN.getTime() + FENETRE_MS).toISOString(),
      occasion: 'conv-1:2026-10-23T09:15:30.123Z',
    }]);
    expect(pousses[0]!.occasion.length).toBeLessThanOrEqual(200);
  });

  it('un nom vide part nul', async () => {
    const { d, pousses } = banc({}, etat({ nom: '   ' }));
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
    expect(pousses[0]).toMatchObject({ nom: null });
  });

  it('🔴 la garde de masse : un contact silencieux (jamais écrit, ou dernier entrant vieux d’une heure) n’est PAS poussé, ni la porte lue', async () => {
    // Une automation `avant_date` qui passe la main sur 300 contacts : l'escalade est posée, personne n'a rien demandé.
    const silencieux = [null, new Date(ESCALADEE.getTime() - 60 * 60 * 1000), new Date(ESCALADEE.getTime() - ATTENTE_RECENTE_MS - 1)];
    for (const dernierEntrantLe of silencieux) {
      let porteLue = false;
      const { d, pousses } = banc({ numeros: { getHubspotGateStatus: async () => { porteLue = true; return { connected: true, pausedAt: null }; } } }, etat({ dernierEntrantLe }));
      await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
      expect(pousses).toEqual([]);
      expect(porteLue).toBe(false);
    }
  });

  it('🔴 un entrant dans le quart d’heure qui précède l’escalade, ou postérieur, est poussé (les passages légitimes passent)', async () => {
    for (const dernierEntrantLe of [new Date(ESCALADEE.getTime() - ATTENTE_RECENTE_MS), new Date(ESCALADEE.getTime() + 5 * 60 * 1000)]) {
      const { d, pousses } = banc({}, etat({ dernierEntrantLe }));
      await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
      expect(pousses).toHaveLength(1);
    }
  });

  it('🔴 `escaladee_le` nul (escalade close, ou échec sans drapeau) : rien n’est poussé, ni la porte lue', async () => {
    let porteLue = false;
    const { d, pousses } = banc({ numeros: { getHubspotGateStatus: async () => { porteLue = true; return { connected: true, pausedAt: null }; } } }, etat({ escaladeeLe: null }));
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
    expect(pousses).toEqual([]);
    expect(porteLue).toBe(false);
  });

  it('conversation introuvable dans cet espace : rien n’est poussé', async () => {
    const { d, pousses } = banc({}, null);
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
    expect(pousses).toEqual([]);
  });

  it('🔴 ligne non reliée à HubSpot, ou en pause : rien n’est poussé, et la porte est lue sur la ligne de la conversation', async () => {
    for (const porte of [{ connected: false, pausedAt: null }, { connected: false, pausedAt: '2026-10-22 10:00:00+00' }]) {
      const lignes: string[][] = [];
      const { d, pousses } = banc({ numeros: { getHubspotGateStatus: async (t, l) => { lignes.push([t, l]); return porte; } } });
      await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
      expect(pousses).toEqual([]);
      expect(lignes).toEqual([['t1', '+33525680250']]);
    }
  });

  it('🔴 404 (espace sans portail) et refus terminal (400, 401, 409) : le job FINIT, il ne se rejoue pas', async () => {
    const issues: IssueHandoff[] = [
      { issue: 'non_relie' },
      { issue: 'refuse', status: 400, code: 'invalid_body' },
      { issue: 'refuse', status: 401, code: undefined },
      { issue: 'refuse', status: 409, code: 'portal_uninstalled' },
    ];
    for (const issue of issues) {
      const { d } = banc({ pousser: async () => issue });
      await expect(pushHandoffJob({ tenantId: 't1', waId: 'w' }, d)).resolves.toBeUndefined();
    }
  });

  it('🔴 5xx, 429 ou réseau : le job LÈVE, pg-boss le rejoue', async () => {
    const { d } = banc({ pousser: async () => { throw new HubspotServiceError(503, undefined, true); } });
    await expect(pushHandoffJob({ tenantId: 't1', waId: 'w' }, d)).rejects.toBeInstanceOf(HubspotServiceError);
  });

  it('payload invalide : le job lève (DLQ visible dans /ops), sans rien lire', async () => {
    const { d, lus } = banc();
    for (const p of [null, {}, { tenantId: 't1' }, { tenantId: '', waId: 'w' }, { tenantId: 't1', waId: 42 }]) {
      await expect(pushHandoffJob(p, d)).rejects.toThrow(/payload invalide/);
    }
    expect(lus).toEqual([]);
  });
});

class FauxTransport implements HttpTransport {
  readonly posts: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly reponse: HttpResponse) {}
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.posts.push({ url, body, headers });
    return this.reponse;
  }
}

describe('pousserHandoff : le client de POST /service/handoff', () => {
  const SECRET = 'svc-secret';
  const corps: CorpsHandoff = {
    tenantId: 't1', e164: '+33600000001', nom: null, conversationId: 'conv-1',
    lienConversation: 'https://console.exemple.test/inbox?c=conv-1', finFenetre: null, occasion: 'conv-1:2026-10-23T09:15:30.123Z',
  };
  const connecteur = (t: HttpTransport) => ({ baseUrl: 'http://connector', secret: SECRET, transport: t });

  it('🔴 poste le corps signé (format v1, chemin /service/handoff) et rend l’issue de la réponse', async () => {
    const t = new FauxTransport({ status: 200, json: { taskId: 'task-9', contactId: 'ct-1', created: true } });
    expect(await pousserHandoff(connecteur(t), corps)).toEqual({ issue: 'fait', created: true, taskId: 'task-9' });
    expect(t.posts[0]!.url).toBe('http://connector/service/handoff');
    expect(t.posts[0]!.body).toEqual(corps);
    const entete = t.posts[0]!.headers['x-mm-service-signature'] ?? '';
    const m = /^v1=(\d+)\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(entete);
    expect(m).not.toBeNull();
    expect(entete).toBe(signRequest(SECRET, { ts: Number(m![1]), nonce: m![2]!, method: 'POST', path: '/service/handoff', body: JSON.stringify(corps) }));
  });

  it('un rejeu (created faux) et une réponse illisible restent des succès : rien ne se rejoue', async () => {
    expect(await pousserHandoff(connecteur(new FauxTransport({ status: 200, json: { taskId: null, contactId: 'ct-1', created: false } })), corps))
      .toEqual({ issue: 'fait', created: false, taskId: null });
    expect(await pousserHandoff(connecteur(new FauxTransport({ status: 200, json: { autre: 1 } })), corps))
      .toEqual({ issue: 'fait', created: null, taskId: null });
  });

  it('🔴 404 tenant_not_connected : « non relié », une fin normale', async () => {
    const t = new FauxTransport({ status: 404, json: { error: 'tenant_not_connected' } });
    expect(await pousserHandoff(connecteur(t), corps)).toEqual({ issue: 'non_relie' });
  });

  it('🟡 tout AUTRE 404 (route absente, objet introuvable) est un refus, jamais « non relié »', async () => {
    for (const json of [{ error: 'hubspot_object_not_found' }, { message: 'Route POST:/service/handoff not found', error: 'Not Found' }, {}]) {
      const t = new FauxTransport({ status: 404, json });
      expect(await pousserHandoff(connecteur(t), corps)).toMatchObject({ issue: 'refuse', status: 404 });
    }
  });

  it('🔴 400, 401, 409 : un refus terminal, RENDU et non levé (sinon pg-boss le rejouerait), en un seul appel', async () => {
    for (const [status, error] of [[400, 'invalid_body'], [401, 'bad_signature'], [409, 'portal_uninstalled'], [409, 'reconsent_required']] as const) {
      const t = new FauxTransport({ status, json: { error } });
      expect(await pousserHandoff(connecteur(t), corps)).toEqual({ issue: 'refuse', status, code: error });
      expect(t.posts).toHaveLength(1);
    }
  });

  it('🔴 une erreur que le client ne sait pas qualifier remonte : le job la laisse à pg-boss', async () => {
    const t: HttpTransport = { post: async () => { throw new Error('boom'); } };
    await expect(pousserHandoff(connecteur(t), corps)).rejects.toThrow('boom');
  });
});

describe('pushHandoffJob : le choix du client (lot 1bis)', () => {
  it('🔴 tâche immédiate NON branchée -> l’état n’est même pas relu, rien n’est poussé', async () => {
    const { d, pousses, lus } = banc({ passageBranche: async () => false });
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
    expect(lus).toHaveLength(0);
    expect(pousses).toHaveLength(0);
  });

  it('branchée -> le chemin d’avant, inchangé, et le choix lu pour l’espace du job', async () => {
    const choix: string[] = [];
    const { d, pousses } = banc({ passageBranche: async (t) => { choix.push(t); return true; } });
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
    expect(choix).toEqual(['t1']);
    expect(pousses).toHaveLength(1);
  });
});

describe('flagSelonLeChoix : le contact injoignable selon le choix du client (lot 1bis)', () => {
  it('🔴 signal éteint -> rien n’est flagué, et c’est un succès (la clôture qui suit ne doit pas bloquer)', async () => {
    const flags: string[][] = [];
    const f = flagSelonLeChoix(async () => false, async (t, e) => { flags.push([t, e]); });
    await expect(f('t1', '+33600000001')).resolves.toBeUndefined();
    expect(flags).toHaveLength(0);
  });

  it('signal allumé -> flagué pour l’espace et le numéro, et une erreur du flag remonte comme avant', async () => {
    const flags: string[][] = [];
    await flagSelonLeChoix(async () => true, async (t, e) => { flags.push([t, e]); })('t1', '+33600000001');
    expect(flags).toEqual([['t1', '+33600000001']]);
    await expect(flagSelonLeChoix(async () => true, async () => { throw new Error('connecteur 500'); })('t1', 'x')).rejects.toThrow('connecteur 500');
  });
});

describe('pushHandoffJob : lot 2b (la clôture, la relance, STOP)', () => {
  const RELANCE = { occasion: 'conv-1:relance:2026-10-23T09:14:00.000Z' };

  it('🔴 décision A : une escalade poussée s’inscrit (son occasion, sa nature, l’instant de l’escalade), le corps du lot 1 inchangé', async () => {
    const { d, pousses, inscrits } = banc();
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, d);
    expect(pousses[0]).not.toHaveProperty('nature');
    expect(inscrits).toEqual([{ occasion: 'conv-1:2026-10-23T09:15:30.123Z', tenantId: 't1', conversationId: 'conv-1', nature: 'escalade', depuis: ESCALADEE }]);
  });

  it('🔴 décision D : un contact STOP n’ouvre aucune tâche, escalade comme relance (la relance inscrite se clôt)', async () => {
    const a = banc({ estDesabonne: async () => true });
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, a.d);
    expect(a.pousses).toHaveLength(0);
    expect(a.inscrits).toHaveLength(0);
    const b = banc({ estDesabonne: async () => true }, etat({ escaladeeLe: null }));
    await pushHandoffJob({ tenantId: 't1', waId: 'w', relance: RELANCE }, b.d);
    expect(b.pousses).toHaveLength(0);
    expect(b.clos).toEqual([RELANCE.occasion]);
  });

  it('🔴 décision C : une relance due part avec sa nature et SON occasion, et ne s’inscrit pas une seconde fois', async () => {
    const { d, pousses, inscrits, clos } = banc({}, etat({ escaladeeLe: null }));
    await pushHandoffJob({ tenantId: 't1', waId: 'w', relance: RELANCE }, d);
    expect(pousses).toEqual([expect.objectContaining({ occasion: RELANCE.occasion, nature: 'relance', finFenetre: new Date(DERNIER_IN.getTime() + FENETRE_MS).toISOString() })]);
    expect(inscrits).toHaveLength(0);
    expect(clos).toHaveLength(0);
  });

  it('🔴 une relance qui n’est plus due (un robot tient le fil, une escalade s’est ouverte, l’équipe a répondu) : rien ne part, elle se clôt', async () => {
    for (const e of [etat({ escaladeeLe: null, controlOwner: 'mba' }), etat({ escaladeeLe: ESCALADEE }), etat({ escaladeeLe: null, dernierSens: 'out' })]) {
      const { d, pousses, clos } = banc({}, e);
      await pushHandoffJob({ tenantId: 't1', waId: 'w', relance: RELANCE }, d);
      expect(pousses).toHaveLength(0);
      expect(clos).toEqual([RELANCE.occasion]);
    }
  });

  it('une relance sur une ligne non reliée, un espace sans portail ou un refus : elle se clôt ; l’escalade, elle, ne s’inscrit pas', async () => {
    const nonReliee = banc({ numeros: { getHubspotGateStatus: async () => ({ connected: false, pausedAt: null }) } }, etat({ escaladeeLe: null }));
    await pushHandoffJob({ tenantId: 't1', waId: 'w', relance: RELANCE }, nonReliee.d);
    expect(nonReliee.clos).toEqual([RELANCE.occasion]);
    const refus = banc({ pousser: async () => ({ issue: 'refuse', status: 400, code: undefined }) }, etat({ escaladeeLe: null }));
    await pushHandoffJob({ tenantId: 't1', waId: 'w', relance: RELANCE }, refus.d);
    expect(refus.clos).toEqual([RELANCE.occasion]);
    const sansPortail = banc({ pousser: async () => ({ issue: 'non_relie' }) });
    await pushHandoffJob({ tenantId: 't1', waId: 'w' }, sansPortail.d);
    expect(sansPortail.inscrits).toHaveLength(0);
  });
});
