import { describe, it, expect } from 'vitest';
import { creerEnvoiApplication, type EnvoiApplication } from '../src/application/envoi';
import { jidDuWaId } from '../src/application/message';
import type { ClientApplication } from '../src/application/client';
import type { CompteApplication, StatutCompte } from '../src/application/comptes';
import { repondreAvecUnMessage, repondreDansLaFenetre, type DepsRepondre } from '../src/inbox/repondre';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import { bancDuFil } from './banc-du-fil';
import { offresToutOuvert } from './gardes';

/**
 * RÉPONDRE, FILIÈRE APPLICATION (plan 2026-10-22, tâche 5). Sur l'application, la fenêtre de 24 heures ne s'applique
 * pas : répondre est toujours possible, par le service de connexions. Le STOP, le numéro bloqué et le détenteur du fil
 * restent la loi. La filière API garde exactement ses refus.
 */
const T = 'bbbbbbbb-0000-4000-8000-000000000002';
const COMPTE = 'aaaaaaaa-0000-4000-8000-000000000001';

const compte = (statut: StatutCompte): CompteApplication => ({
  id: COMPTE, tenantId: T, numero: '447700900000', jid: null, statut, fourniId: null,
  relieLe: null, dernierMessageLe: null, statutChangeLe: new Date(0),
});

function client(envois: string[], issue: Awaited<ReturnType<ClientApplication['envoyer']>> = { ok: true, messageId: 'WA9' }): ClientApplication {
  const non = async () => ({ ok: false as const, raison: 'refuse' as const });
  return {
    relier: non, sommeil: non, retirer: non, qr: non, verifier: non,
    async envoyer(id, dest, texte) { envois.push(`${id}:${dest}:${texte}`); return issue; },
  };
}

describe('l’adresse WhatsApp d’un contact', () => {
  it('un numéro devient une adresse de numéro, un identifiant masqué reste tel quel, le reste est refusé', () => {
    expect(jidDuWaId('33612345678')).toBe('33612345678@s.whatsapp.net');
    expect(jidDuWaId('123456789012345@lid')).toBe('123456789012345@lid');
    expect(jidDuWaId('120363000000000000@g.us')).toBeNull();
    expect(jidDuWaId('abc')).toBeNull();
  });
});

describe('l’envoi par le service de connexions', () => {
  const monter = (statut: StatutCompte | null, c: ClientApplication | null) => creerEnvoiApplication({
    comptes: {
      parEspace: async () => (statut ? compte(statut) : null),
      filiereDe: async () => (statut ? 'application' : null),
    },
    client: c,
  });

  it('un compte relié envoie, et l’identifiant rendu est préfixé par le compte', async () => {
    const envois: string[] = [];
    expect(await monter('relie', client(envois)).envoyer(T, '33612345678', 'Bonjour')).toEqual({ ok: true, messageId: `app:${COMPTE}:WA9` });
    expect(envois).toEqual([`${COMPTE}:33612345678@s.whatsapp.net:Bonjour`]);
  });

  it('un compte absent, banni ou déconnecté n’envoie rien et le dit', async () => {
    const envois: string[] = [];
    for (const statut of [null, 'banni', 'deconnecte', 'sommeil'] as const) {
      expect(await monter(statut, client(envois)).envoyer(T, '33612345678', 'x')).toEqual({ ok: false, raison: 'non_relie' });
      expect(await monter(statut, client(envois)).relie(T)).toBe(false);
    }
    expect(envois).toEqual([]);
    expect(await monter('relie', client(envois)).relie(T)).toBe(true);
  });

  it('sans service configuré, la filière est fermée : injoignable', async () => {
    expect(await monter('relie', null).envoyer(T, '33612345678', 'x')).toEqual({ ok: false, raison: 'service_injoignable' });
  });

  it('une adresse qui n’est pas celle d’un contact individuel est refusée', async () => {
    const envois: string[] = [];
    expect(await monter('relie', client(envois)).envoyer(T, '120363000000000000@g.us', 'x')).toEqual({ ok: false, raison: 'refuse' });
    expect(envois).toEqual([]);
  });
});

/** Un espace, une conversation, et chaque geste noté. */
function banc(o: { filiere: 'api' | 'application'; windowOpen: boolean; desabonne?: boolean; issue?: Awaited<ReturnType<EnvoiApplication['envoyer']>> }) {
  const traces: string[] = [];
  const deps: DepsRepondre = {
    inbox: {
      getConversationContext: async () => ({ waId: '33612345678', lastInboundAt: '2026-10-01T10:00:00Z', windowOpen: o.windowOpen }),
      async recordOutbound(_c, body, messageId, origine) { traces.push(`trace:${body}:${messageId}:${origine}`); },
    },
    repo: { getTenantPhoneNumberId: async () => (o.filiere === 'api' ? 'pn1' : null) },
    sendReply: async (_t, pn, to, text) => { traces.push(`meta:${pn}:${to}:${text}`); return 'wamid.1'; },
    takeControl: async (_t, waId) => { traces.push(`fil:${waId}`); },
    estDesabonne: async () => o.desabonne === true,
    filTenuParLApplication: async () => false,
    application: {
      filiere: async () => o.filiere,
      async envoyer(_t, waId, texte) {
        traces.push(`app:${waId}:${texte}`);
        return o.issue ?? { ok: true, messageId: `app:${COMPTE}:WA9` };
      },
    },
  };
  return { traces, deps };
}

describe('répondre sur la filière application', () => {
  it('🔴 une conversation de plus de 24 heures reçoit la réponse : la fenêtre ne s’applique pas', async () => {
    const { traces, deps } = banc({ filiere: 'application', windowOpen: false });
    const res = await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'mcp');
    expect(res).toMatchObject({ messageId: `app:${COMPTE}:WA9` });
    expect(traces).toEqual(['app:33612345678:Bonjour', 'fil:33612345678', `trace:Bonjour:app:${COMPTE}:WA9:mcp`]);
  });

  it('🔴 cas 4 : un contact désabonné ne reçoit rien d’une machine, même sans fenêtre', async () => {
    const { traces, deps } = banc({ filiere: 'application', windowOpen: false, desabonne: true });
    expect(await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'mcp')).toEqual({ refus: { motif: 'contact_desabonne' } });
    expect(traces).toEqual([]);
  });

  it('un compte qui n’est plus relié rend un refus qui le dit, sans trace ni prise du fil', async () => {
    const { traces, deps } = banc({ filiere: 'application', windowOpen: true, issue: { ok: false, raison: 'non_relie' } });
    expect(await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'mcp'))
      .toEqual({ refus: { motif: 'application_indisponible', raison: 'non_relie' } });
    expect(traces).toEqual(['app:33612345678:Bonjour']);
  });

  it('un message au format de Meta (média, boutons) ne part pas par l’application', async () => {
    const { traces, deps } = banc({ filiere: 'application', windowOpen: true });
    const envoyerMessage = async () => { traces.push('meta-message'); return 'wamid.2'; };
    const message = { corps: { type: 'image' }, trace: '[image]', type: 'image' };
    expect(await repondreAvecUnMessage(deps, envoyerMessage, T, 'conv-1', message, null, 'mcp')).toEqual({ refus: { motif: 'format_non_pris_en_charge' } });
    expect(traces).toEqual([]);
  });

  it('🔴 la filière API garde exactement ses refus de fenêtre, et n’appelle jamais le service', async () => {
    const fermee = banc({ filiere: 'api', windowOpen: false });
    expect(await repondreDansLaFenetre(fermee.deps, T, 'conv-1', 'Bonjour', null, 'mcp')).toEqual({ refus: { motif: 'fenetre_fermee' } });
    const ouverte = banc({ filiere: 'api', windowOpen: true });
    await repondreDansLaFenetre(ouverte.deps, T, 'conv-1', 'Bonjour', null, 'mcp');
    expect(ouverte.traces[0]).toBe('meta:pn1:33612345678:Bonjour');
    expect(ouverte.traces.some((t) => t.startsWith('app:'))).toBe(false);
  });
});

describe('l’agent IA répond par l’application', () => {
  const runtime = (application: EnvoiApplication, ecrits: string[]) => {
    const inerte = {} as never;
    return buildWorkflowRuntime({
      pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      queue: { enqueue: async () => {} },
      dryRun: false, repo: inerte, contactStore: inerte,
      inboxStore: {
        recordOutboundByWaId: async (_t: string, waId: string, m: { messageId: string | null; origine: string }) => { ecrits.push(`${waId}:${m.messageId}:${m.origine}`); },
      } as never,
      settingsStore: inerte, workflowStore: inerte, metaCredentials: inerte, metaFactory: inerte,
      rcsProvider: 'fake', emailTemplates: inerte, emailResolver: inerte, numeroDeLEspace: async () => null, runStore: inerte,
      fil: inerte, offres: offresToutOuvert, prevenirEquipe: async () => {},
      application,
    });
  };

  it('🔴 sa réponse part par le service et s’inscrit dans le fil comme une réponse d’IA', async () => {
    const ecrits: string[] = [];
    const envois: string[] = [];
    const application: EnvoiApplication = {
      filiere: async () => 'application', relie: async () => true,
      envoyer: async (_t, waId, texte) => { envois.push(`${waId}:${texte}`); return { ok: true, messageId: `app:${COMPTE}:WA9` }; },
    };
    expect(await runtime(application, ecrits).envoyerTexteAgent(T, '33612345678', 'Bonjour')).toBeUndefined();
    expect(envois).toEqual(['33612345678:Bonjour']);
    expect(ecrits).toEqual([`33612345678:app:${COMPTE}:WA9:ia`]);
  });

  it('un envoi refusé rend un refus, et le tour sort par sa branche d’échec', async () => {
    const application: EnvoiApplication = {
      filiere: async () => 'application', relie: async () => false,
      envoyer: async () => ({ ok: false, raison: 'non_relie' }),
    };
    expect(await runtime(application, []).envoyerTexteAgent(T, '33612345678', 'Bonjour')).toEqual(expect.stringContaining('non_relie'));
  });
});

describe('le contrôle du fil confie le message au répondeur IA', () => {
  it('🔴 un espace sans numéro Meta mais au compte de l’application relié démarre son répondeur', async () => {
    const app = bancDuFil({ repondeurAgentId: 'ag1', mbaEnabled: false, numero: null, applicationReliee: true });
    await app.fil.remettreSiPersonneNeSuit(T, 'w', 'Bonjour', { rouverte: false });
    expect(app.demarrages).toHaveLength(1);
    const rien = bancDuFil({ repondeurAgentId: 'ag1', mbaEnabled: false, numero: null });
    await rien.fil.remettreSiPersonneNeSuit(T, 'w', 'Bonjour', { rouverte: false });
    expect(rien.demarrages).toEqual([]);
  });
});
