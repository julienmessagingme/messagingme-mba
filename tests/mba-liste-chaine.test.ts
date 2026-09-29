import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleWebhookJob, type WebhookJobDeps } from '../src/webhooks/handler';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';
import type { WorkflowGraph } from '../src/workflow/graph';
import { creerTransmettreHorsParcours } from '../src/mba/transmettre-hors-parcours';
import { TYPE_HORS_PARCOURS, TYPE_MESSAGE_SANS_SUITE } from '../src/mba/evenement';
import type { InboundMessage } from '../src/webhooks/inbound';
import type { ControlOwner } from '../src/inbox/store.pg';
import { bancDuFil, type OptionsBanc } from './banc-du-fil';
import { aucunNumeroDelie, aucunRoutagePub, aucunSignalReponse, aucuneArriveePub } from './webhook-fixtures';
import { aucunStop, jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';

/**
 * LE MODE LISTE DE BOUT EN BOUT, SUR LES MODULES RÉELS : le job webhook (`handleWebhookJob`), le contrôle du fil
 * (`src/inbox/fil.ts`), la liste de l'agent (`src/mba/liste.ts`) et, pour la réponse imprévue, l'exécuteur et la
 * transmission à l'agent. Le faux n'est que Meta (`tests/banc-du-fil.ts`) et les stores.
 *
 * Mesuré le 2026-09-29 sur le numéro de l'espace de test : en mode liste, Meta range encore des messages en `standby`
 * alors que l'agent se tait ; un contact absent de la liste n'entend jamais l'agent. Sans la réécriture à l'arrivée,
 * une réponse texte à un modèle n'arrivait à personne.
 */

afterEach(() => { vi.restoreAllMocks(); });

const WA = '33612345678';

/** Un lot `standby` (forme mesurée : tout est imbriqué sous `value.standby`) ou `messages`. */
const lot = (field: 'standby' | 'messages', messages: Array<Record<string, unknown>>) => ({
  entry: [{ id: 'waba1', changes: [{ field, value: {
    metadata: { phone_number_id: 'pn1' },
    ...(field === 'standby' ? { standby: { contacts: [{ wa_id: WA }], messages } } : { contacts: [{ wa_id: WA }], messages }),
  } }] }],
});
const texte = (id: string, body: string) => ({ id, from: WA, type: 'text', timestamp: '1789465356', text: { body } });
const bouton = (id: string, payload: string) => ({ id, from: WA, type: 'button', timestamp: '1789465356', button: { text: 'En savoir plus', payload } });

/** La file `webhook` complète sur le banc : ce que chaque étape a vu, et l'état du fil et de la liste. */
function monterLeJob(o: { depart?: ControlOwner; banc?: Omit<OptionsBanc, 'conversations'> } = {}) {
  const b = bancDuFil({ ...o.banc, conversations: { [WA]: { owner: o.depart ?? 'app_workflow' } } });
  const enregistres: InboundMessage[] = [];
  const avances: Array<{ m: string; bp: string | null }> = [];
  const declencheurs: string[] = [];
  const deps: WebhookJobDeps = {
    store: { insertEvent: async () => true },
    inbox: { recordInbound: async (_t, m) => { enregistres.push(m); }, phoneNumberTenant: async () => 't1' },
    arriveesPub: aucuneArriveePub,
    routagePub: aucunRoutagePub,
    signalReponse: aucunSignalReponse,
    numerosDelies: aucunNumeroDelie,
    inboundOptOut: aucunStop,
    detenteur: b.fil,
    listeALArrivee: { agentAllume: async () => o.banc?.mbaEnabled ?? true, presents: (t, w) => b.liste.presents(t, w) },
    triggers: { run: async (_t, ev) => { if (ev.kind === 'message') declencheurs.push(ev.body ?? ''); return 0; } },
    workflowAdvance: { advance: async (_t, _w, m, bp) => { avances.push({ m, bp }); } },
    remiseMbaEntrant: { remettre: b.fil.remettreSiPersonneNeSuit },
  };
  return { b, deps, enregistres, avances, declencheurs };
}

/**
 * 🔴 INVARIANT 3 : agent allumé, un `standby` d'un contact ABSENT de la liste est traité comme un `messages` par
 * l'avance (texte et bouton), les automations et la règle 2. Contact présent : inchangé. Agent éteint : inchangé.
 * Vérifié dans les deux sens : l'appel à `requalifierLesStandby` retiré du handler, les trois premiers cas échouent
 * (aucune avance, aucun déclencheur, aucune remise, et `entrantEnStandby` écrit `mba`).
 */
describe('invariant 3 : un contact absent de la liste parle à la plateforme', () => {
  it('🔴 texte en standby : l’automation le voit, le parcours avance, puis la règle 2 le confie à l’agent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const j = monterLeJob();
    await handleWebhookJob(lot('standby', [texte('wamid.T', 'Je préfère être rappelé')]), j.deps);
    expect(j.declencheurs).toEqual(['Je préfère être rappelé']);
    expect(j.avances).toEqual([{ m: 'wamid.T', bp: null }]);
    // Aucun parcours n'attendait (le banc le dit), donc personne ne suit : confié, puis prévenu.
    expect(j.b.appels).toEqual([`ajout:${WA}`, `release:${WA}`, `evenement:${WA}`]);
    expect(j.b.evenements[0]?.event.type).toBe(TYPE_MESSAGE_SANS_SUITE);
    expect(JSON.parse(j.b.evenements[0]!.event.payload)).toEqual({ message: 'Je préfère être rappelé' });
    // Le champ reçu de Meta reste lisible pour le journal.
    expect(j.enregistres[0]).toMatchObject({ field: 'messages', fieldRecu: 'standby' });
  });

  it('🔴 bouton en standby : le parcours avance, sur la bonne branche', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const j = monterLeJob({ banc: { enAttente: true } });
    await handleWebhookJob(lot('standby', [bouton('wamid.B', 'btn:0')]), j.deps);
    expect(j.avances).toEqual([{ m: 'wamid.B', bp: 'btn:0' }]);
    // Un parcours attend : la règle 2 se tait, l'agent ne parle pas par-dessus le scénario.
    expect(j.b.appels).toEqual([]);
  });

  it('🔴 la correction du détenteur n’écrit plus `mba` pour ce message : un opérateur garde la main', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const j = monterLeJob({ depart: 'app_human' });
    await handleWebhookJob(lot('standby', [texte('wamid.H', 'Bonjour')]), j.deps);
    expect(j.b.etat(WA)?.owner).toBe('app_human');
    expect(j.b.appels).toEqual([]);
  });

  it('contact PRÉSENT sur la liste : rien ne change, l’agent lui parle', async () => {
    const j = monterLeJob({ banc: { surLaListe: [WA] } });
    await handleWebhookJob(lot('standby', [texte('wamid.P', 'Bonjour')]), j.deps);
    expect(j.avances).toEqual([]);
    expect(j.declencheurs).toEqual([]);
    expect(j.b.appels).toEqual([]);
    // Et notre colonne se met d'accord avec Meta, comme avant.
    expect(j.b.etat(WA)?.owner).toBe('mba');
    expect(j.enregistres[0]).toMatchObject({ field: 'standby' });
    expect(j.enregistres[0]?.fieldRecu).toBeUndefined();
  });

  it('agent ÉTEINT : rien ne change, un `standby` y veut dire qu’une autre application tient le fil', async () => {
    const j = monterLeJob({ banc: { mbaEnabled: false } });
    await handleWebhookJob(lot('standby', [texte('wamid.E', 'Bonjour')]), j.deps);
    expect(j.avances).toEqual([]);
    expect(j.declencheurs).toEqual([]);
    expect(j.b.appels).toEqual([]);
    expect(j.b.etat(WA)?.owner).toBe('mba');
  });
});

/**
 * 🔴 INVARIANT 5 : un message que personne ne prend est confié (ajout, release), puis `message_sans_suite` part avec
 * son contenu ; aucun événement si confier échoue. Et plusieurs messages du même contact dans un lot font UN seul
 * événement. Vérifié dans les deux sens : la remise remise message par message dans `processRemiseMbaEntrant`, le
 * dernier cas échoue (deux événements, deux réponses de l'agent).
 */
describe('invariant 5 : le message sans suite', () => {
  it('🔴 confier refusé : aucun événement, la colonne ne bouge pas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const j = monterLeJob({ banc: { ajout: ['refuse'] } });
    await handleWebhookJob(lot('messages', [texte('wamid.R', 'Bonjour')]), j.deps);
    expect(j.b.appels).toEqual([`ajout:${WA}`]);
    expect(j.b.evenements).toEqual([]);
    expect(j.b.etat(WA)?.owner).toBe('app_workflow');
  });

  it('🔴 deux messages du même contact dans un lot : UN événement, leurs textes bout à bout', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const j = monterLeJob();
    await handleWebhookJob(lot('messages', [texte('wamid.1', 'Bonjour'), texte('wamid.2', 'Vous êtes ouverts ?')]), j.deps);
    expect(j.b.appels).toEqual([`ajout:${WA}`, `release:${WA}`, `evenement:${WA}`]);
    expect(JSON.parse(j.b.evenements[0]!.event.payload)).toEqual({ message: 'Bonjour\nVous êtes ouverts ?' });
  });
});

/**
 * 🔴 INVARIANT 4 : une réponse imprévue dans un scénario part VRAIMENT chez l'agent, sur la chaîne réelle : l'exécuteur
 * sort du parcours, `rendreApresParcours` confie la conversation tout de suite (la réponse est plus récente que notre
 * dernier envoi, `demanderReleaseMba` ne diffère pas), et `transmettreHorsParcours`, qui ne parle qu'à un fil `mba`,
 * envoie `reponse_hors_parcours`. L'inventaire du 2026-09-29 avait relevé que des fixtures répondant `mba` cachaient
 * le cas où la remise est différée. Vérifié dans les deux sens : l'écriture de `mba` retirée de `rendreMaintenant`,
 * le premier cas échoue (aucun événement).
 */
describe('invariant 4 : la réponse imprévue dans un scénario, sur la chaîne réelle', () => {
  const n = (id: string, type: string, data: Record<string, unknown> = {}) =>
    ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];
  const graphe: WorkflowGraph = {
    nodes: [n('n1', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] }), n('n2', 'tag', { tag: 'ok' })],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'btn:0' }],
  };

  function monterLeScenario(o: { enVol?: string } = {}) {
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_workflow', ...(o.enVol ? { enVol: o.enVol } : {}) } } });
    const corps = new Map<string, string>([['wamid.X', 'Et pour une livraison demain ?']]);
    const transmettre = creerTransmettreHorsParcours({
      detenteur: async (_t, w) => b.etat(w)?.owner ?? 'app_workflow',
      numero: async () => 'pn1',
      corpsDuMessage: async (_t, id) => corps.get(id) ?? null,
      envoyer: (_t, pn, to, event) => b.client.agentEvent(pn, to, event),
    });
    const run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: WA, currentNode: 'n1', status: 'waiting', lastMessageId: null, grapheFige: null };
    const ex = new WorkflowExecutor({
      ...depsInertes,
      estDesabonne: jamaisDesabonne,
      runs: avecGardesDEtatInertes({
        start: async () => ({ id: 'r1' }),
        findWaitingByWaId: async () => run as unknown as WorkflowRunRow,
        setState: async (_id: string, _s: RunState): Promise<void> => {},
        closeActiveByWaId: async () => [],
      }),
      getGraph: async () => graphe,
      applyTag: async () => {},
      setField: async () => {},
      removeTag: async () => {},
      clearField: async () => {},
      sendTemplate: async () => {},
      sendQuickMessage: async () => {},
      sendFlow: async () => {},
      sendQuestion: async () => {},
      mayAct: b.fil.peutAgir,
      mbaActifPour: async () => true,
      releaseToMba: b.fil.rendreApresParcours,
      transmettreHorsParcours: transmettre,
    });
    return { b, ex };
  }

  it('🔴 un texte libre au lieu du bouton : confié tout de suite, puis `reponse_hors_parcours` avec son texte', async () => {
    const { b, ex } = monterLeScenario();
    await ex.advance('t1', WA, 'wamid.X', null);
    expect(b.appels).toEqual([`ajout:${WA}`, `release:${WA}`, `evenement:${WA}`]);
    expect(b.evenements[0]?.event.type).toBe(TYPE_HORS_PARCOURS);
    expect(JSON.parse(b.evenements[0]!.event.payload)).toEqual({ message: 'Et pour une livraison demain ?' });
    expect(b.etat(WA)?.owner).toBe('mba');
    expect(b.table.has(WA)).toBe(true);
  });

  it('🔴 et la remise « personne ne suit » du même lot ne le prévient PAS une seconde fois', async () => {
    // Le handler appelle la remise après l'avance, pour le même message : sans la garde « déjà confiée », l'agent
    // recevrait deux événements et répondrait deux fois au client.
    const { b, ex } = monterLeScenario();
    await ex.advance('t1', WA, 'wamid.X', null);
    await b.fil.remettreSiPersonneNeSuit('t1', WA, 'Et pour une livraison demain ?');
    expect(b.evenements).toHaveLength(1);
  });

  it('⚠️ un envoi encore en vol : la remise attend son accusé, et l’événement ne part pas (le balayage reste le filet)', async () => {
    // Le cas relevé par l'inventaire, dit ici pour ce qu'il est : il n'arrive que si notre dernier envoi est plus
    // récent que la réponse du client, ce que `demanderReleaseMba` écarte depuis le 2026-09-22.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { b, ex } = monterLeScenario({ enVol: 'wamid.NOTRE' });
    await ex.advance('t1', WA, 'wamid.X', null);
    expect(b.appels).toEqual([]);
    expect(b.etat(WA)?.owner).toBe('app_human');
  });
});
