import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { processInbound, type InboxStore, type InboundMessage } from '../src/webhooks/inbound';
import { handleWebhookJob } from '../src/webhooks/handler';
import { reconnaissanceDesWidgets } from '../src/widgets/reconnaissance';
import {
  arriveeParWidget, automationDuWidget, creerArriveeParWidget, demarrageParLeRunner, etiquetteDuWidget,
  type ArriveeParWidget,
} from '../src/widgets/arrivee';
import type { TirsDuWidget } from '../src/widgets/tirs.pg';
import { creerPoseEtiquette } from '../src/crm/poser-etiquette';
import type { WidgetRow } from '../src/widgets/store.pg';
import { POSSESSEUR_WIDGET, type AutomationEvent } from '../src/automation/match';
import type { AutomationRunnerDeps } from '../src/automation/runner';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import { creerLancements, type TypeDeLancementAutomatisme } from '../src/workflow/lancements';
import type { WorkflowGraph } from '../src/workflow/graph';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { aucunStop } from './consentement';
import { offresToutOuvert } from './gardes';
import { plusAnciennesJamaisLues } from './gardes';
import {
  agentEteintALArrivee, aucuneArriveePub, aucuneCorrectionDuDetenteur, aucunNumeroDelie, aucunRoutagePub,
  aucunSignalReponse, entrantsDe,
} from './webhook-fixtures';

/**
 * LE WIDGET À L'ARRIVÉE D'UN MESSAGE (lot 3 du plan `docs/superpowers/plans/2026-10-02-widget-whatsapp.md`).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE D'ABORD : LE CHEMIN DE RÉCEPTION. Chaque message entrant de chaque client passe par
 * `processInbound`, et ce lot y ajoute une étape. Le premier `describe` compare donc le MÊME lot de messages traité
 * avec et sans le widget : pour un message qui ne porte aucune phrase, rien ne doit différer, ni les écritures, ni
 * leur ordre, ni ce que le job donne ensuite aux automations, à l'avance et à l'agent de Meta.
 *
 * Les démarrages de scénario passent par le VRAI runner (`runAutomations`) et le VRAI exécuteur : l'anti-rebond, le
 * plafond, le contact bloqué, la garde du fil et celle du désabonnement sont les leurs, et c'est tout le sujet de la
 * décision de Julien (démarrage direct, gardes réutilisées, jamais recopiées). Le câblage du runner reproduit celui
 * du worker ; le dernier `describe` va lire le worker, parce qu'un faux câblage bouge avec ce qu'il garde.
 */

const T = 't-widget';
const AUTRE = 't-voisin';
const PHRASE = 'Bonjour, je viens du site Messaging Me';
const CODE = 'k3j4h5m6n7p8';

function widget(sur: Partial<WidgetRow> = {}): WidgetRow {
  return {
    id: 'w1', tenantId: T, code: CODE, nom: 'Site vitrine', phrase: PHRASE,
    devenir: null, agentId: null, workflowId: null,
    couleur: '#25d366', position: 'bas_droite', libelle: null, avatarUrl: null, badge: true, actif: true,
    maxParHeure: null, createdAt: '2026-10-02T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z',
    ...sur,
  };
}

/** Le dépôt des widgets : `lister` ne rend que ceux de l'espace demandé, comme le SQL (`tenant_id = $1`). */
function depot(widgets: WidgetRow[]) {
  const lectures: string[] = [];
  return {
    lectures,
    lister: async (tenantId: string) => {
      lectures.push(tenantId);
      return widgets.filter((w) => w.tenantId === tenantId);
    },
  };
}

type Brut = Record<string, unknown>;
const texte = (id: string, body: string, from = '33611'): Brut => ({ id, from, type: 'text', text: { body } });
const lot = (messages: Brut[], field = 'messages') => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, messages } }] }],
});

/** Le scénario du widget : il ouvre par un message rapide, ce qu'un visiteur qui vient d'écrire peut recevoir. */
const graphe: WorkflowGraph = {
  nodes: [{ id: 'a', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Bienvenue ! Que cherchez-vous ?' } }],
  edges: [],
};

/**
 * Le banc : le vrai runner, le vrai exécuteur, des tirs en mémoire (le pendant de `widget_tirs`), et les étiquettes
 * posées sur les contacts, dédoublonnées comme le fait le SQL (`array_agg(distinct ...)`).
 */
function banc(o: {
  widgets: WidgetRow[];
  desabonne?: boolean;
  bloque?: boolean;
  /** Qui tient le fil ; absent = l'app. */
  fil?: 'operateur' | 'agent';
  /** Meta refuse de retirer le contact de la liste de son agent. */
  repriseRefusee?: boolean;
  plafondInstance?: number;
} ) {
  let horloge = Date.parse('2026-10-02T10:00:00Z');
  const envois: string[] = [];
  const etiquettes = new Map<string, Set<string>>();
  const posees: Array<[string, string, string]> = [];
  const tirs = new Map<string, Date>();
  const effaces: string[] = [];
  const declenches: Array<{ type: TypeDeLancementAutomatisme; fenetreOuverte: boolean }> = [];
  const reprises: string[] = [];

  const execDeps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: async () => o.desabonne === true,
    runs: avecGardesDEtatInertes({
      start: async () => ({ id: 'r1' }),
      findWaitingByWaId: async () => null,
      setState: async () => {},
      closeActiveByWaId: async () => [],
    }),
    getGraph: async () => graphe,
    applyTag: async () => true,
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async (_t, waId, corps) => { envois.push(`${waId}:${corps}`); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    // Le fil est à nous, sauf quand le cas dit qu'un opérateur ou l'agent de Meta le tient. `mayAct` ne sert qu'aux
    // démarrages ordinaires ; la reprise imite `ControleDuFil.reprendrePourLApp` : l'opérateur est épargné quand on le
    // demande (`'operateur'`), Meta peut refuser (`false`), sinon le contact quitte la liste de l'agent.
    mayAct: async () => o.fil === undefined,
    reclaimControl: async (_t, waId, opts) => {
      if (o.fil === 'operateur' && opts?.saufOperateur === true) return 'operateur';
      if (o.repriseRefusee === true) return false;
      reprises.push(waId);
      return true;
    },
  };
  const ex = new WorkflowExecutor(execDeps);
  const lancements = creerLancements({
    executor: ex,
    scenarios: { getById: async () => ({ graph: graphe }) },
    contacts: { findIdByWaId: async () => null },
    offres: offresToutOuvert,
  });

  /** Les dépendances des automations du worker, telles que `src/worker.ts` les câble. */
  const runner: AutomationRunnerDeps = {
    contacts: { isBlockedByWaId: async () => o.bloque === true },
    automations: {
      // 🔴 Le widget ne lit JAMAIS les automations de l'espace : sa seule source est l'automation équivalente, en
      // mémoire. Une lecture ici voudrait dire qu'une automation ordinaire peut partir à sa place.
      listEnabled: async () => { throw new Error('le widget a lu les automations de l’espace'); },
      lastFiredAt: async () => { throw new Error('le widget a lu les tirs des automations'); },
      markFired: async () => { throw new Error('le widget a écrit dans les tirs des automations'); },
      clearFired: async () => { throw new Error('le widget a effacé un tir d’automation'); },
      plusAnciennes: plusAnciennesJamaisLues,
    },
    evalContext: async () => null,
    // Le MÊME câblage que `src/worker.ts` : la demande du runner (type de lancement et preuve de fenêtre compris) est
    // transmise telle quelle à l'entrée des lancements, rien n'est posé ici.
    startWorkflow: async (demande) => {
      declenches.push({ type: demande.type, fenetreOuverte: demande.fenetreOuverte });
      return (await lancements.lancer(demande)) ?? false;
    },
    defaultCooldownSeconds: 3600,
    maxFiresPerHour: o.plafondInstance ?? 200,
    now: () => horloge,
    offres: offresToutOuvert,
  };

  const tirsPour = (tenantId: string): TirsDuWidget => ({
    lastFiredAt: async (id, waId) => tirs.get(`${tenantId}|${id}|${waId}`) ?? null,
    markFired: async (id, waId) => { tirs.set(`${tenantId}|${id}|${waId}`, new Date(horloge)); return true; },
    clearFired: async (id, waId) => { effaces.push(waId); tirs.delete(`${tenantId}|${id}|${waId}`); },
    firedSince: async (id, since) => [...tirs].filter(([k, d]) => k.startsWith(`${tenantId}|${id}|`) && d >= since).length,
  });

  const lecture = depot(o.widgets);
  const arrivee = creerArriveeParWidget({
    widgetDuMessage: reconnaissanceDesWidgets(lecture),
    poserEtiquette: async (tenantId, waId, etiquette) => {
      posees.push([tenantId, waId, etiquette]);
      const cle = `${tenantId}|${waId}`;
      etiquettes.set(cle, new Set([...(etiquettes.get(cle) ?? []), etiquette]));
    },
    demarrerScenario: demarrageParLeRunner(runner, tirsPour),
  });

  return {
    arrivee, runner, lecture, envois, etiquettes, posees, tirs, effaces, declenches, reprises,
    avancer: (ms: number) => { horloge += ms; },
  };
}

/** L'Inbox et les dépendances de `processInbound`, chaque appel noté dans l'ordre. */
function inbox() {
  const trace: string[] = [];
  const store: InboxStore = {
    recordInbound: async (t, m) => { trace.push(`record:${t}:${m.messageId}`); return { rouverte: m.messageId.endsWith('rouverte') }; },
  };
  const deps = {
    upsertContact: async (t: string, m: InboundMessage) => { trace.push(`upsert:${t}:${m.waId}`); return 'updated' as const; },
    optOut: async (t: string, waId: string, id: string) => { trace.push(`stop:${t}:${waId}:${id}`); return 'c1'; },
    assignation: async (t: string, waId: string) => { trace.push(`affectation:${t}:${waId}`); return null; },
    signalReponse: async (t: string, m: InboundMessage) => { trace.push(`signal:${t}:${m.messageId}`); },
    detenteur: { entrantEnStandby: async (t: string, waId: string) => { trace.push(`standby:${t}:${waId}`); } },
  };
  return { trace, store, deps };
}

/**
 * `processInbound` sur ce lot. Ce que l'étape du widget rend (un scénario est parti, donc le message est consommé)
 * est capté ici comme le fait `handleWebhookJob` ; c'est l'enveloppe RÉELLE du job que gardent les tests qui passent
 * par `handleWebhookJob`, plus bas.
 */
async function traiter(payload: unknown, widget?: ArriveeParWidget, espace: string = T) {
  const i = inbox();
  const prisParUnWidget = new Set<string>();
  const capte: ArriveeParWidget | undefined = widget
    ? async (t, m) => {
        const pris = await widget(t, m);
        if (pris) prisParUnWidget.add(m.messageId);
        return pris;
      }
    : undefined;
  const rouvertes = await processInbound(await entrantsDe(payload, espace), i.store, { ...i.deps, ...(capte ? { widget: capte } : {}) });
  return { trace: i.trace, rouvertes, prisParUnWidget };
}

describe('🔴 non-régression : un message SANS phrase de widget ne change RIEN au chemin de réception', () => {
  /** Un lot ordinaire : du texte, un média, un bouton, un STOP, une réouverture, deux contacts. */
  const ordinaire = () => lot([
    texte('wamid.1', 'Bonjour, une question sur ma commande'),
    { id: 'wamid.2', from: '33611', type: 'image', image: { id: 'media-1', caption: 'ma facture' } },
    { id: 'wamid.3', from: '33622', type: 'button', button: { text: 'Oui', payload: 'oui' } },
    texte('wamid.4', 'STOP', '33622'),
    texte('wamid.5-rouverte', 'je reviens vers vous', '33633'),
  ]);

  it('🔴 mêmes écritures, même ordre, rien de consommé, aucune étiquette, aucun scénario', async () => {
    // L'espace a un widget ACTIF à scénario : le cas où le widget a le plus de pouvoir, et donc le plus à ne pas faire.
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
    const sans = await traiter(ordinaire());
    const avec = await traiter(ordinaire(), b.arrivee);

    expect(avec.trace).toEqual(sans.trace);
    expect([...avec.rouvertes]).toEqual([...sans.rouvertes]);
    expect([...avec.rouvertes]).toEqual(['wamid.5-rouverte']);
    expect([...avec.prisParUnWidget], 'un message sans phrase a été consommé par un widget').toEqual([]);
    expect(b.posees, 'une étiquette de widget a été posée sur un message sans phrase').toEqual([]);
    expect(b.envois, 'un scénario de widget est parti sur un message sans phrase').toEqual([]);
    expect(b.tirs.size).toBe(0);
    // Le coût : une lecture par message TEXTE (le STOP compris), aucune pour le média et le bouton.
    expect(b.lecture.lectures).toEqual([T, T, T]);
  });

  it('🔴 le job donne ces messages aux automations, à l’avance et à l’agent de Meta, exactement comme sans widget', async () => {
    const vu = async (avecWidget: boolean) => {
      const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
      const automations: AutomationEvent[] = [];
      const avances: string[] = [];
      const remises: string[] = [];
      await handleWebhookJob(lot([texte('wamid.1', 'Bonjour, une question sur ma commande'), texte('wamid.2', 'et la livraison ?')]), {
        store: { insertEvent: async () => true },
        inbox: { phoneNumberTenant: async () => T, recordInbound: async () => ({ rouverte: false }) },
        arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse,
        numerosDelies: aucunNumeroDelie, inboundOptOut: aucunStop, detenteur: aucuneCorrectionDuDetenteur,
        listeALArrivee: agentEteintALArrivee,
        triggers: { run: async (_t, ev) => { automations.push(ev); return 0; } },
        workflowAdvance: { advance: async (_t, _w, id) => { avances.push(id); return false; } },
        remiseMbaEntrant: { remettre: async (_t, waId, contenu) => { remises.push(`${waId}:${contenu}`); } },
        ...(avecWidget ? { inboundWidget: b.arrivee } : {}),
      });
      return { automations, avances, remises };
    };
    const sans = await vu(false);
    const avec = await vu(true);
    expect(avec).toEqual(sans);
    expect(avec.avances).toEqual(['wamid.1', 'wamid.2']);
    expect(avec.automations).toHaveLength(2);
  });

  it('un message SANS TEXTE ne lit rien et ne fait rien, même si sa légende ou son bouton porte la phrase', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
    const r = await traiter(lot([
      { id: 'wamid.m', from: '33611', type: 'image', image: { id: 'media-1', caption: PHRASE } },
      { id: 'wamid.b', from: '33611', type: 'button', button: { text: PHRASE, payload: 'x' } },
      { id: 'wamid.v', from: '33611', type: 'text', text: {} },
    ]), b.arrivee);
    expect(b.lecture.lectures, 'un message sans texte a coûté une lecture').toEqual([]);
    expect(b.posees).toEqual([]);
    expect(b.envois).toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
  });
});

describe('la reconnaissance : widgetDuMessage(tenantId, texte)', () => {
  it('sans texte, aucune lecture en base', async () => {
    const d = depot([widget()]);
    const reconnaitre = reconnaissanceDesWidgets(d);
    expect(await reconnaitre(T, null)).toBeNull();
    expect(await reconnaitre(T, '')).toBeNull();
    expect(await reconnaitre(T, '   \n ')).toBeNull();
    expect(d.lectures).toEqual([]);
  });

  it('un espace sans widget coûte UNE lecture, celle de l’espace du message', async () => {
    const d = depot([]);
    expect(await reconnaissanceDesWidgets(d)(T, PHRASE)).toBeNull();
    expect(d.lectures).toEqual([T]);
  });

  it('la phrase est reconnue CONTENUE, à la casse, aux accents et aux espaces près', async () => {
    const reconnaitre = reconnaissanceDesWidgets(depot([widget({ phrase: 'Je viens du site, je voudrais un devis' })]));
    expect((await reconnaitre(T, 'JE   VIENS du site, je voudrais un dévis   merci'))?.id).toBe('w1');
    expect(await reconnaitre(T, 'je voudrais un devis')).toBeNull();
  });

  it('un widget ÉTEINT ne reconnaît rien', async () => {
    expect(await reconnaissanceDesWidgets(depot([widget({ actif: false })]))(T, PHRASE)).toBeNull();
  });

  it('🔴 une phrase que la normalisation réduit à rien ne capte PAS tous les messages', async () => {
    // Un accent combinant seul passe le CHECK `\S` de la base, et la normalisation le retire : la phrase vaut ''.
    // Écrit par son point de code : un caractère combinant littéral est invisible à la relecture.
    const accentsSeuls = String.fromCharCode(0x301, 0x301);
    expect(/\S/.test(accentsSeuls), 'le cas doit passer le CHECK de la base, sinon il ne prouve rien').toBe(true);
    const reconnaitre = reconnaissanceDesWidgets(depot([widget({ phrase: accentsSeuls })]));
    expect(await reconnaitre(T, 'bonjour')).toBeNull();
  });

  it('deux phrases contenues : la plus longue, la plus précise, gagne', async () => {
    const reconnaitre = reconnaissanceDesWidgets(depot([
      widget({ id: 'court', phrase: 'Bonjour' }),
      widget({ id: 'long', phrase: 'Bonjour, je viens du blog' }),
    ]));
    expect((await reconnaitre(T, 'Bonjour, je viens du blog'))?.id).toBe('long');
  });

  it('🔴 isolation : la phrase d’un espace ne reconnaît rien dans le message d’un autre', async () => {
    const d = depot([widget()]);
    expect(await reconnaissanceDesWidgets(d)(AUTRE, PHRASE)).toBeNull();
    expect(d.lectures).toEqual([AUTRE]);
  });
});

describe('le devenir à l’arrivée', () => {
  it('🔴 \'scenario\' : le scénario démarre, le message est CONSOMMÉ, et il reprend le fil sans le prendre à un opérateur', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
    const r = await traiter(lot([texte('wamid.w', `${PHRASE} !`)]), b.arrivee);
    expect(b.envois).toEqual(['33611:Bienvenue ! Que cherchez-vous ?']);
    expect([...r.prisParUnWidget]).toEqual(['wamid.w']);
    // Comme la publicité (lot 3b) : fenêtre prouvée ouverte, reprise du fil, opérateur épargné.
    expect(b.declenches).toEqual([{ type: 'automatisme_publicite_ou_widget', fenetreOuverte: true }]);
    expect(b.reprises).toEqual(['33611']);
    expect(b.tirs.size).toBe(1);
  });

  it('🔴 le même contact qui renvoie la phrase dans l’anti-rebond ne redémarre pas, et au-delà, si', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
    await traiter(lot([texte('wamid.1', PHRASE)]), b.arrivee);
    b.avancer(30 * 60_000);
    const second = await traiter(lot([texte('wamid.2', PHRASE)]), b.arrivee);
    expect(b.envois).toHaveLength(1);
    // Non consommé : comme pour un mot-clé en anti-rebond, le message reste au parcours qui l'attend peut-être.
    expect([...second.prisParUnWidget]).toEqual([]);
    b.avancer(31 * 60_000);
    const troisieme = await traiter(lot([texte('wamid.3', PHRASE)]), b.arrivee);
    expect(b.envois, 'le témoin : passé l’anti-rebond, le scénario repart').toHaveLength(2);
    expect([...troisieme.prisParUnWidget]).toEqual(['wamid.3']);
  });

  it('🔴 au-delà de max_par_heure, le démarrage est refusé', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1', maxParHeure: 1 })] });
    await traiter(lot([texte('wamid.a', PHRASE, '33611')]), b.arrivee);
    const refuse = await traiter(lot([texte('wamid.b', PHRASE, '33622')]), b.arrivee);
    expect(b.envois).toEqual(['33611:Bienvenue ! Que cherchez-vous ?']);
    expect([...refuse.prisParUnWidget]).toEqual([]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('plafond de 1 déclenchements/heure'))).toBe(true);
    spy.mockRestore();
  });

  it('max_par_heure à null : c’est le plafond de l’instance qui s’applique, pas « aucun plafond »', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1', maxParHeure: null })], plafondInstance: 1 });
    await traiter(lot([texte('wamid.a', PHRASE, '33611')]), b.arrivee);
    await traiter(lot([texte('wamid.b', PHRASE, '33622')]), b.arrivee);
    expect(b.envois).toHaveLength(1);
    spy.mockRestore();
  });

  it('🔴 un contact DÉSABONNÉ ne démarre rien, et le tir est effacé', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })], desabonne: true });
    const r = await traiter(lot([texte('wamid.d', PHRASE)]), b.arrivee);
    spy.mockRestore();
    spyErr.mockRestore();
    expect(b.envois, 'un scénario de widget a écrit à un contact qui a dit STOP').toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
    // Rien n'est parti : garder le tir ferait taire sa prochaine vraie demande pendant tout l'anti-rebond.
    expect(b.effaces).toEqual(['33611']);
    expect(b.tirs.size).toBe(0);
    // La source, elle, se pose : on refuse de lui parler, pas de noter d'où il vient.
    expect(b.posees).toEqual([[T, '33611', `widget-${CODE}`]]);
  });

  it('un contact BLOQUÉ ne démarre rien, et aucun tir n’est écrit', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })], bloque: true });
    const r = await traiter(lot([texte('wamid.x', PHRASE)]), b.arrivee);
    expect(b.envois).toEqual([]);
    expect(b.tirs.size).toBe(0);
    expect([...r.prisParUnWidget]).toEqual([]);
  });

  it('🔴 un fil tenu par un OPÉRATEUR : le scénario ne part pas, rien n’est repris, le message reste à l’Inbox', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })], fil: 'operateur' });
    const r = await traiter(lot([texte('wamid.f', PHRASE)]), b.arrivee);
    spy.mockRestore();
    expect(b.envois, 'le scénario d’un widget a écrit par-dessus un opérateur').toEqual([]);
    expect(b.reprises).toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
    // Rien n'est parti : le tir s'efface, sa prochaine vraie demande n'attendra pas l'anti-rebond.
    expect(b.effaces).toEqual(['33611']);
  });

  it('🔴 un fil tenu par l’AGENT DE META : le scénario part, et il reprend le fil (lot 3b)', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })], fil: 'agent' });
    const r = await traiter(lot([texte('wamid.f', PHRASE)]), b.arrivee);
    expect(b.envois).toEqual(['33611:Bienvenue ! Que cherchez-vous ?']);
    // La reprise n'est pas un détail : sans elle, l'agent de Meta répondrait à la place du scénario.
    expect(b.reprises).toEqual(['33611']);
    expect([...r.prisParUnWidget]).toEqual(['wamid.f']);
  });

  it('Meta refuse de rendre le fil : rien ne part, et le tir est effacé', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })], fil: 'agent', repriseRefusee: true });
    const r = await traiter(lot([texte('wamid.f', PHRASE)]), b.arrivee);
    spies.forEach((s) => s.mockRestore());
    expect(b.envois).toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
    expect(b.effaces).toEqual(['33611']);
  });

  it('🔴 un `standby` (l’agent de Meta tient le fil) démarre le scénario, qui reprend le fil (lot 3b)', async () => {
    // Le cas de tout espace où l'agent de Meta est allumé : sans la reprise, le devenir 'scenario' n'y partirait jamais.
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })], fil: 'agent' });
    const r = await traiter(lot([texte('wamid.s', PHRASE)], 'standby'), b.arrivee);
    expect(b.posees).toHaveLength(1);
    expect(b.envois).toEqual(['33611:Bienvenue ! Que cherchez-vous ?']);
    expect(b.declenches).toEqual([{ type: 'automatisme_publicite_ou_widget', fenetreOuverte: true }]);
    expect(b.reprises).toEqual(['33611']);
    expect([...r.prisParUnWidget]).toEqual(['wamid.s']);
  });

  it('un entrant d’un autre `field` que messages et standby pose la source mais ne démarre rien', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
    const r = await traiter(lot([texte('wamid.e', PHRASE)], 'un_field_inconnu'), b.arrivee);
    expect(b.posees).toHaveLength(1);
    expect(b.envois).toEqual([]);
    expect(b.declenches).toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
  });

  it('🔴 \'agent\' se comporte EXACTEMENT comme null, sans erreur, que l’agent existe encore ou non', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const issue = async (w: WidgetRow) => {
      const b = banc({ widgets: [w] });
      const r = await traiter(lot([texte('wamid.g', PHRASE)]), b.arrivee);
      return { trace: r.trace, pris: [...r.prisParUnWidget], posees: b.posees, envois: b.envois, declenches: b.declenches };
    };
    const neutre = await issue(widget({ devenir: null }));
    expect(await issue(widget({ devenir: 'agent', agentId: 'agent-1' }))).toEqual(neutre);
    expect(await issue(widget({ devenir: 'agent', agentId: null }))).toEqual(neutre);
    expect(neutre.envois).toEqual([]);
    expect(neutre.pris).toEqual([]);
    expect(erreurs).not.toHaveBeenCalled();
    erreurs.mockRestore();
  });

  it('\'mba\' ne prend rien : aucun démarrage, rien de consommé, l’agent de Meta répond s’il est actif', async () => {
    const demarrer = vi.fn(async () => 1);
    const arrivee = creerArriveeParWidget({
      widgetDuMessage: reconnaissanceDesWidgets(depot([widget({ devenir: 'mba' })])),
      poserEtiquette: async () => {},
      demarrerScenario: demarrer,
    });
    const r = await traiter(lot([texte('wamid.m', PHRASE)]), arrivee);
    expect(demarrer).not.toHaveBeenCalled();
    expect([...r.prisParUnWidget]).toEqual([]);
  });

  it('\'scenario\' dont le scénario a été supprimé retombe sur le réglage de l’espace, sans erreur', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: null })] });
    const r = await traiter(lot([texte('wamid.z', PHRASE)]), b.arrivee);
    expect(b.posees).toHaveLength(1);
    expect(b.declenches).toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
  });

  it('🔴 widget ÉTEINT : rien du tout, ni source ni scénario', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1', actif: false })] });
    const r = await traiter(lot([texte('wamid.e', PHRASE)]), b.arrivee);
    expect(b.posees).toEqual([]);
    expect(b.envois).toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
  });

  it('🔴 isolation : le widget d’un espace ne se déclenche jamais sur le message d’un autre espace', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
    const r = await traiter(lot([texte('wamid.v', PHRASE)]), b.arrivee, AUTRE);
    expect(b.lecture.lectures).toEqual([AUTRE]);
    expect(b.posees).toEqual([]);
    expect(b.envois).toEqual([]);
    expect([...r.prisParUnWidget]).toEqual([]);
  });
});

describe('🔴 l’étiquette de source', () => {
  it('posée pour TOUS les devenirs, la même pour un widget donné', async () => {
    for (const sur of [
      { devenir: null }, { devenir: 'agent' as const, agentId: 'a1' }, { devenir: 'mba' as const },
      { devenir: 'scenario' as const, workflowId: 'wf1' },
    ]) {
      const b = banc({ widgets: [widget(sur)] });
      await traiter(lot([texte('wamid.t', PHRASE)]), b.arrivee);
      expect(b.posees, `devenir ${String(sur.devenir)}`).toEqual([[T, '33611', `widget-${CODE}`]]);
    }
  });

  it('🔴 stable quand le widget est RENOMMÉ, nom et phrase compris : elle dérive du code, immuable', async () => {
    const avant = banc({ widgets: [widget()] });
    await traiter(lot([texte('wamid.1', PHRASE)]), avant.arrivee);
    const apres = banc({ widgets: [widget({ nom: 'Page tarifs', phrase: 'Bonjour, je viens de la page tarifs' })] });
    await traiter(lot([texte('wamid.2', 'Bonjour, je viens de la page tarifs')]), apres.arrivee);
    expect(apres.posees[0]![2]).toBe(avant.posees[0]![2]);
    expect(etiquetteDuWidget(CODE)).toBe(`widget-${CODE}`);
  });

  it('sans doublon : la même arrivée répétée laisse UNE étiquette sur le contact', async () => {
    const b = banc({ widgets: [widget()] });
    await traiter(lot([texte('wamid.1', PHRASE)]), b.arrivee);
    await traiter(lot([texte('wamid.2', `re ${PHRASE}`)]), b.arrivee);
    expect(b.posees.map((p) => p[2])).toEqual([`widget-${CODE}`, `widget-${CODE}`]);
    expect([...(b.etiquettes.get(`${T}|33611`) ?? [])]).toEqual([`widget-${CODE}`]);
  });
});

describe('🔴 un échec du widget n’empêche ni l’enregistrement ni l’affectation de campagne', () => {
  const deuxMessages = () => lot([texte('wamid.1', PHRASE, '33611'), texte('wamid.2', 'autre chose', '33622')]);

  it('la lecture des widgets lève : les DEUX messages sont enregistrés et affectés, et rien ne remonte', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const enPanne = creerArriveeParWidget({
      widgetDuMessage: async () => { throw new Error('base indisponible'); },
      poserEtiquette: async () => {},
      demarrerScenario: async () => 1,
    });
    const sans = await traiter(deuxMessages());
    const avec = await traiter(deuxMessages(), enPanne);
    expect(avec.trace).toEqual(sans.trace);
    expect(avec.trace).toContain(`affectation:${T}:33611`);
    expect(avec.trace).toContain(`record:${T}:wamid.2`);
    expect(spy).toHaveBeenCalledWith('processInbound: widget ignoré:', 'base indisponible');
    spy.mockRestore();
  });

  it('l’étiquette lève : le scénario part quand même', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const demarrer = vi.fn(async () => 1);
    const arrivee = creerArriveeParWidget({
      widgetDuMessage: reconnaissanceDesWidgets(depot([widget({ devenir: 'scenario', workflowId: 'wf1' })])),
      poserEtiquette: async () => { throw new Error('fiche verrouillée'); },
      demarrerScenario: demarrer,
    });
    const r = await traiter(lot([texte('wamid.1', PHRASE)]), arrivee);
    expect(demarrer).toHaveBeenCalledTimes(1);
    expect([...r.prisParUnWidget]).toEqual(['wamid.1']);
    spy.mockRestore();
  });

  it('le scénario lève : rien ne remonte, rien n’est consommé, l’enregistrement et l’affectation ont eu lieu', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const arrivee = creerArriveeParWidget({
      widgetDuMessage: reconnaissanceDesWidgets(depot([widget({ devenir: 'scenario', workflowId: 'wf1' })])),
      poserEtiquette: async () => {},
      demarrerScenario: async () => { throw new Error('scénario refusé'); },
    });
    const sans = await traiter(deuxMessages());
    const avec = await traiter(deuxMessages(), arrivee);
    expect(avec.trace).toEqual(sans.trace);
    expect([...avec.prisParUnWidget]).toEqual([]);
    spy.mockRestore();
  });
});

describe('🔴 le message pris par un widget n’est donné à personne d’autre dans le job', () => {
  it('ni aux automations, ni à l’avance d’un parcours, ni à l’agent de Meta ; le message voisin, si', async () => {
    const b = banc({ widgets: [widget({ devenir: 'scenario', workflowId: 'wf1' })] });
    const automations: string[] = [];
    const avances: string[] = [];
    const remises: string[] = [];
    await handleWebhookJob(lot([texte('wamid.w', PHRASE, '33611'), texte('wamid.o', 'bonjour', '33622')]), {
      store: { insertEvent: async () => true },
      inbox: { phoneNumberTenant: async () => T, recordInbound: async () => ({ rouverte: false }) },
      arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse,
      numerosDelies: aucunNumeroDelie, inboundOptOut: aucunStop, detenteur: aucuneCorrectionDuDetenteur,
      listeALArrivee: agentEteintALArrivee,
      // Une automation « nouveau contact » démarrerait un second scénario par-dessus celui du widget. Elle rend 0
      // (évaluée, rien de parti) : sinon elle consommerait le message voisin, et l'avance ne le verrait plus.
      inboundContactUpsert: async () => 'created',
      triggers: { run: async (_t, ev) => { automations.push(ev.waId); return 0; } },
      workflowAdvance: { advance: async (_t, waId) => { avances.push(waId); return false; } },
      remiseMbaEntrant: { remettre: async (_t, waId) => { remises.push(waId); } },
      inboundWidget: b.arrivee,
    });
    expect(b.envois).toEqual(['33611:Bienvenue ! Que cherchez-vous ?']);
    expect(automations).toEqual(['33622']);
    expect(avances).toEqual(['33622']);
    expect(remises).toEqual(['33622']);
  });
});

describe('🔴 l’émission d’événements d’automation est décidée par le chemin appelant', () => {
  function sansCommentaires(source: string): string {
    return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  it('🔴 l’étiquette de source n’émet RIEN : aucun module du widget ne publie d’événement d’automation', () => {
    // Le chemin de réception décide une fois qui prend la conversation : une publication « tag ajouté » laisserait
    // une automation démarrer un second scénario sur la même arrivée, par la file, hors de l'anti-rebond du widget.
    // Depuis le 2026-10-04, la pose passe par le module commun (`src/crm/poser-etiquette.ts`), qui SAIT publier :
    // `publier: true` est donc interdit ici aussi. Le cas qui l'exécute est l'assemblage de production, plus bas.
    const dossier = join(process.cwd(), 'src', 'widgets');
    const fichiers = readdirSync(dossier).filter((f) => f.endsWith('.ts'));
    expect(fichiers).toContain('arrivee.ts');
    for (const f of fichiers) {
      const code = sansCommentaires(readFileSync(join(dossier, f), 'utf8'));
      expect(code, `${f} publie un événement d’automation`).not.toMatch(/tag_added|enfilerEvenementAutomation|emitTagAdded|AUTOMATION_EVENT_QUEUE|publier:\s*true/);
    }
  });

  it('🔴 le scénario d’un widget démarre par le startWorkflow du runner, celui des démarrages unitaires', async () => {
    const startWorkflow = vi.fn(async () => true);
    const runner: AutomationRunnerDeps = {
      automations: {
        listEnabled: async () => [], lastFiredAt: async () => null, markFired: async () => true, clearFired: async () => {},
        plusAnciennes: plusAnciennesJamaisLues,
      },
      evalContext: async () => null,
      startWorkflow,
      defaultCooldownSeconds: 0,
      offres: offresToutOuvert,
    };
    const tirs: TirsDuWidget = { lastFiredAt: async () => null, markFired: async () => true, clearFired: async () => {}, firedSince: async () => 0 };
    const m: InboundMessage = { phoneNumberId: 'pn1', waId: '33611', messageId: 'wamid.1', type: 'text', body: PHRASE, buttonPayload: null, profileName: null, field: 'messages' };
    const partis = await demarrageParLeRunner(runner, () => tirs)(T, widget({ devenir: 'scenario', workflowId: 'wf1' }), 'wf1', m);
    expect(partis).toBe(1);
    expect(startWorkflow).toHaveBeenCalledWith({
      type: 'automatisme_publicite_ou_widget', tenantId: T, workflowId: 'wf1', waId: '33611', blocDeDepart: null, fenetreOuverte: true,
    });
  });

  it('l’automation équivalente : mot-clé = la phrase en contains, son scénario, son plafond, le widget pour propriétaire', () => {
    const a = automationDuWidget(T, widget({ id: 'w9', maxParHeure: 40 }), 'wf9');
    expect(a).toMatchObject({
      id: 'w9', tenantId: T, enabled: true, triggerKind: 'keyword',
      triggerConfig: { keywords: [PHRASE], mode: 'contains' }, conditionGroup: null,
      workflowId: 'wf9', startNodeId: null, possedePar: POSSESSEUR_WIDGET, cooldownSeconds: null, maxFiresPerHour: 40,
    });
  });
});

describe('l’assemblage de production (`arriveeParWidget`), sur un faux pool', () => {
  it('🔴 il pose l’étiquette par le VRAI module de pose : déclarée, JAMAIS publiée ; et chaque requête des tirs porte l’espace en $1', async () => {
    const requetes: Array<{ sql: string; params: unknown[] }> = [];
    const brut = {
      id: 'w1', tenant_id: T, code: CODE, nom: 'Site vitrine', phrase: PHRASE, devenir: 'scenario', agent_id: null,
      workflow_id: 'wf1', couleur: '#25d366', position: 'bas_droite', libelle: null, avatar_url: null, badge: true,
      actif: true, max_par_heure: null, created_at: new Date(), updated_at: new Date(),
    };
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        requetes.push({ sql, params });
        if (/from widgets where tenant_id = \$1 order by/.test(sql)) return { rows: params[0] === T ? [brut] : [], rowCount: 1 };
        if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    const ajouts: Array<[string, string, string[]]> = [];
    const declarees: string[] = [];
    const publiees: string[] = [];
    const startWorkflow = vi.fn(async () => true);
    const arrivee = arriveeParWidget(pool, {
      // Le VRAI module (`src/crm/poser-etiquette.ts`), celui que `buildWorkflowRuntime` construit pour le worker.
      etiquettes: creerPoseEtiquette({
        ajouterAuContact: async (t, w, tags) => { ajouts.push([t, w, tags]); return { added: tags }; },
        waIdDeLaFiche: async () => null,
        declarer: async (t, tag) => { declarees.push(`${t}:${tag}`); },
        emettre: async (t, w, tag) => { publiees.push(`${t}:${w}:${tag}`); },
      }),
      runner: {
        automations: {
          listEnabled: async () => { throw new Error('lu les automations'); },
          lastFiredAt: async () => null, markFired: async () => true, clearFired: async () => {},
          plusAnciennes: plusAnciennesJamaisLues,
        },
        evalContext: async () => null,
        startWorkflow,
        defaultCooldownSeconds: 3600,
        maxFiresPerHour: 200,
        offres: offresToutOuvert,
      },
    });
    const m: InboundMessage = { phoneNumberId: 'pn1', waId: '33611', messageId: 'wamid.1', type: 'text', body: PHRASE, buttonPayload: null, profileName: null, field: 'messages' };
    expect(await arrivee(T, m)).toBe(true);
    expect(ajouts).toEqual([[T, '33611', [`widget-${CODE}`]]]);
    expect(declarees).toEqual([`${T}:widget-${CODE}`]);
    // L'étiquette était nouvelle, et rien n'est publié pour autant : c'est le chemin appelant qui décide.
    expect(publiees).toEqual([]);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    const tirs = requetes.filter((r) => /widget_tirs/.test(r.sql));
    // Lecture de l'anti-rebond, compte du plafond, écriture du tir : les trois, chacune sous l'espace du message.
    expect(tirs).toHaveLength(3);
    for (const r of tirs) {
      expect(r.sql).toMatch(/tenant_id = \$1/);
      expect(r.params[0]).toBe(T);
    }
    // Aucune requête ne touche les automations de l'espace ni leurs tirs.
    expect(requetes.some((r) => /automation/.test(r.sql))).toBe(false);
  });
});

describe('🔴 le câblage réel du worker', () => {
  const worker = readFileSync(join(process.cwd(), 'src', 'worker.ts'), 'utf8');

  it('le job webhook passe l’arrivée par widget, avec l’objet MÊME des automations', () => {
    expect(worker).toMatch(/inboundWidget: arriveeParWidget\(pool, \{ etiquettes, runner: automationRunnerDeps \}\)/);
    // `etiquettes` est la pose du socle, la même que celle de l'agent et du bloc de scénario.
    expect(worker).toMatch(/poserTagDepuisAgent, etiquettes,\s*\} = workflowRuntime;/);
    // Le même objet que celui des automations déclenchées par un message : mêmes gardes, même `startWorkflow`.
    expect(worker).toMatch(/run: \(tenant, ev, opts\) => runAutomations\(tenant, ev, automationRunnerDeps, opts\)/);
  });
});
