import { describe, it, expect } from 'vitest';
import { creerEnvoiApplication, phraseApplicationIndisponible, type EnvoiApplication } from '../src/application/envoi';
import { jidDuWaId } from '../src/application/message';
import type { ClientApplication } from '../src/application/client';
import type { CompteApplication, StatutCompte } from '../src/application/comptes';
import { repondreAvecUnMessage, repondreDansLaFenetre, type DepsRepondre } from '../src/inbox/repondre';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import { bancDuFil } from './banc-du-fil';
import { aucunPremierMessage, offresToutOuvert } from './gardes';
import { porteEnMemoire } from './aide/porte-premier';

/**
 * RÉPONDRE, FILIÈRE APPLICATION (plan 2026-10-22, tâche 5). Sur l'application, répondre est toujours possible, par le
 * service de connexions ; hors des 24 heures, la réponse d'une machine est un message écrit en premier, qui passe par la
 * porte (plan 2026-10-23, tâche 3). Le STOP, le numéro bloqué et le détenteur du fil restent la loi. La filière API
 * garde exactement ses refus.
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

  it('un compte absent, banni, endormi ou déconnecté n’envoie rien et le dit, chacun avec sa raison', async () => {
    const envois: string[] = [];
    const attendu = { banni: 'banni', sommeil: 'sommeil', deconnecte: 'non_relie', en_attente: 'non_relie', retire: 'non_relie' } as const;
    for (const statut of [null, ...Object.keys(attendu) as (keyof typeof attendu)[]]) {
      const raison = statut === null ? 'non_relie' : attendu[statut];
      expect(await monter(statut, client(envois)).envoyer(T, '33612345678', 'x'), String(statut)).toEqual({ ok: false, raison });
      expect(await monter(statut, client(envois)).relie(T)).toBe(false);
    }
    expect(envois).toEqual([]);
    expect(await monter('relie', client(envois)).relie(T)).toBe(true);
  });

  it('🔴 un numéro banni dit qu’il est coupé, jamais « reliez-le » ; un numéro endormi dit comment le réveiller', () => {
    const banni = phraseApplicationIndisponible('banni');
    expect(banni).toContain('coupé par WhatsApp');
    expect(banni).not.toMatch(/reliez/i);
    expect(phraseApplicationIndisponible('sommeil')).toBe('le numéro est en sommeil faute de messages : reliez-le de nouveau pour le réveiller (start_whatsapp_connection)');
    expect(phraseApplicationIndisponible('refuse_whatsapp')).toBe('WhatsApp a refusé ce message');
    // Les raisons d'avant gardent leur phrase.
    expect(phraseApplicationIndisponible('non_relie')).toContain('reliez-le de nouveau');
    expect(phraseApplicationIndisponible('service_injoignable')).toContain('ne répond pas');
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
function banc(o: {
  filiere: 'api' | 'application'; windowOpen: boolean; desabonne?: boolean; issue?: Awaited<ReturnType<EnvoiApplication['envoyer']>>;
  /** La porte « écrire en premier » ; absente, y passer lève (`aucunPremierMessage`). */
  ecrirePremier?: DepsRepondre['ecrirePremier'];
  waId?: string;
  /** Le dernier message reçu du contact ; `null` : il ne nous a jamais écrit. */
  lastInboundAt?: string | null;
}) {
  const traces: string[] = [];
  const deps: DepsRepondre = {
    inbox: {
      getConversationContext: async () => ({ waId: o.waId ?? '33612345678', lastInboundAt: o.lastInboundAt === undefined ? '2026-10-01T10:00:00Z' : o.lastInboundAt, windowOpen: o.windowOpen }),
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
    ecrirePremier: o.ecrirePremier ?? aucunPremierMessage,
  };
  return { traces, deps };
}

describe('répondre sur la filière application', () => {
  it('🔴 une conversation de plus de 24 heures reçoit la réponse d’un opérateur, tout de suite : la porte ne sert que les machines', async () => {
    const { traces, deps } = banc({ filiere: 'application', windowOpen: false });
    const res = await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', 'u1', 'humain');
    expect(res).toMatchObject({ messageId: `app:${COMPTE}:WA9` });
    expect(traces).toEqual(['app:33612345678:Bonjour', 'fil:33612345678', `trace:Bonjour:app:${COMPTE}:WA9:humain`]);
  });

  it('dans les 24 heures, la réponse d’une machine part tout de suite, et rien n’est mis en file ni compté', async () => {
    // `aucunPremierMessage` lève : passer par la porte ferait échouer ce cas.
    const { traces, deps } = banc({ filiere: 'application', windowOpen: true });
    const res = await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'mcp');
    expect(res).toMatchObject({ messageId: `app:${COMPTE}:WA9` });
    expect(traces).toEqual(['app:33612345678:Bonjour', 'fil:33612345678', `trace:Bonjour:app:${COMPTE}:WA9:mcp`]);
  });

  it('🔴 hors des 24 heures, la réponse d’une machine est différée par la porte : comptée, en file, rien ne part ni ne prend le fil', async () => {
    // Décision de Julien (2026-10-24) : le contact nous a écrit, la réponse part sans accord coché (mode `conversation`).
    const porte = porteEnMemoire({ optIn: 'unknown' });
    const { traces, deps } = banc({ filiere: 'application', windowOpen: false, ecrirePremier: porte.ecrirePremier });
    const res = await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'mcp');
    expect(res).toEqual({ differe: { id: porte.lignes[0]!.id, prevuLe: porte.lignes[0]!.prevuLe.toISOString() } });
    expect(traces, 'ni envoi direct, ni prise du fil, ni trace : le job s’en charge').toEqual([]);
    expect(porte.demandes).toEqual([{
      tenantId: T, cle: expect.stringMatching(/^reponse:conv-1:[0-9a-f]{16}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), telephone: '33612345678',
      texte: 'Bonjour', origine: 'reponse', reference: null, consentement: { mode: 'conversation' },
    }]);
    expect(porte.gestes.filter((g) => g === 'quota')).toHaveLength(1);
  });

  it('🔴 hors des 24 heures, un contact qui ne nous a JAMAIS écrit : refus premier_contact, même consentant (2026-10-24)', async () => {
    const porte = porteEnMemoire({ optIn: 'opted_in' });
    const { traces, deps } = banc({ filiere: 'application', windowOpen: false, ecrirePremier: porte.ecrirePremier, lastInboundAt: null });
    expect(await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'api'))
      .toEqual({ refus: { motif: 'premier_message', refus: 'premier_contact' } });
    expect(porte.demandes[0]!.consentement).toEqual({ mode: 'exige_opt_in' });
    expect(traces).toEqual([]);
    expect(porte.gestes).toEqual([]);
    expect(porte.lignes).toEqual([]);
  });

  it('🔴 hors des 24 heures, un contact qui a écrit reçoit la réponse en mode conversation, même quand l’appelant déclare un accord', async () => {
    const porte = porteEnMemoire({ optIn: 'unknown' });
    const { deps } = banc({ filiere: 'application', windowOpen: false, ecrirePremier: porte.ecrirePremier });
    const horsFenetre = { origine: 'api' as const, consentement: { mode: 'declare' as const, source: 'formulaire' }, cle: 'api:0123456789abcdef:2026-10-23T10:00' };
    const res = await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'api', null, horsFenetre);
    expect(res).toEqual({ differe: { id: porte.lignes[0]!.id, prevuLe: porte.lignes[0]!.prevuLe.toISOString() } });
    expect(porte.demandes[0]).toMatchObject({ origine: 'api', cle: horsFenetre.cle, consentement: { mode: 'conversation' } });
  });

  it('🔴 hors des 24 heures, un contact qui nous a écrit puis a dit STOP : rien ne part, même par la conversation', async () => {
    const porte = porteEnMemoire({ optIn: 'opted_out' });
    const { traces, deps } = banc({ filiere: 'application', windowOpen: false, ecrirePremier: porte.ecrirePremier });
    expect(await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'mcp'))
      .toEqual({ refus: { motif: 'premier_message', refus: 'desabonne' } });
    expect(traces).toEqual([]);
    expect(porte.lignes).toEqual([]);
  });

  it('hors des 24 heures, un contact masqué (@lid) sans numéro connu : refus sans_telephone, la porte n’est pas appelée', async () => {
    const { traces, deps } = banc({ filiere: 'application', windowOpen: false, waId: '123456789012345@lid' });
    expect(await repondreDansLaFenetre(deps, T, 'conv-1', 'Bonjour', null, 'mcp'))
      .toEqual({ refus: { motif: 'premier_message', refus: 'sans_telephone' } });
    expect(traces).toEqual([]);
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
