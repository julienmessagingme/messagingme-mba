import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleWebhookJob, type WebhookJobDeps } from '../src/webhooks/handler';
import {
  ecarterLesInconnusDesEspacesPleins, messagesEcartes, sansCesMessages, type EcrituresDuStop, type EspacesPleins,
} from '../src/webhooks/espace-plein';
import type { InboundMessage } from '../src/webhooks/inbound';
import type { EntrantRattache } from '../src/webhooks/rattachement';
import { agentEteintALArrivee, aucunNumeroDelie, aucuneArriveePub, aucuneCorrectionDuDetenteur, aucunRoutagePub } from './webhook-fixtures';

/**
 * LA PORTE D'UNE FREE PLEINE (décision de Julien du 2026-10-25, plan `docs/superpowers/plans/2026-10-25-free-100-contacts.md`).
 * Une Free ne gère jamais plus de contacts que sa limite, quelle que soit leur origine : quand elle est pleine, le message
 * d'un inconnu n'entre pas (ni fiche, ni conversation, ni message, ni journal brut, ni scénario, ni agent IA, ni
 * automation), sauf son STOP, retenu seul ; les administrateurs sont prévenus. Le Pro ne passe jamais ici.
 */

afterEach(() => { vi.restoreAllMocks(); });

type Change = { field: string; value: Record<string, unknown> };
const payload = (...changes: Change[]): unknown => ({ entry: [{ id: 'waba1', changes }] });
const texte = (id: string, from: string, body: string) => ({ id, from, type: 'text', timestamp: '1790000000', text: { body } });
const messages = (pnid: string, liste: unknown[], extra: Record<string, unknown> = {}): Change =>
  ({ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid }, contacts: [{ wa_id: '33600000002', profile: { name: 'Inconnu' } }], messages: liste, ...extra } });
const accuse = { id: 'wamid.s', status: 'delivered', recipient_id: '33600000001' };

const CONNU = '33600000001';
const INCONNU = '33600000002';

/** Une Free pleine où seul `CONNU` a une fiche : ce que `PgContactStore.inconnusRefuses` rendrait. */
function freePleine(limite = 100) {
  const prevenus: Array<[string, number]> = [];
  const lus: Array<[string, readonly string[]]> = [];
  const deps: EspacesPleins = {
    refuses: async (t, waIds) => {
      lus.push([t, waIds]);
      const refuses = waIds.filter((w) => w !== CONNU);
      return refuses.length === 0 ? null : { waIds: new Set(refuses), limite };
    },
    prevenir: async (t, l) => { prevenus.push([t, l]); },
  };
  return { deps, prevenus, lus };
}

/**
 * Le Pro plein, l'Entreprise ou une Free sous sa limite : personne n'est refusé. Ses alertes sont NOTÉES, jamais levées :
 * la porte avale une alerte qui échoue, et un faux qui lèverait laisserait vert un test qui affirme « personne n'est
 * prévenu » (relecture du lot).
 */
function personneRefuse() {
  const prevenus: Array<[string, number]> = [];
  const deps: EspacesPleins = { refuses: async () => null, prevenir: async (t, l) => { prevenus.push([t, l]); } };
  return { deps, prevenus };
}

function ecritures() {
  const traces: string[] = [];
  const stop: EcrituresDuStop = {
    upsertContact: async (t, m) => { traces.push(`fiche:${t}:${m.waId}`); return 'created'; },
    optOut: async (t, waId, id) => { traces.push(`stop:${t}:${waId}:${id}`); return 'c1'; },
  };
  return { traces, stop };
}

const message = (waId: string, messageId: string, body: string, type = 'text'): InboundMessage => ({
  phoneNumberId: 'pn1', waId, messageId, type, body, buttonPayload: null, profileName: null, field: 'messages',
});
const rattache = (m: InboundMessage, tenantId: string | null = 't1'): EntrantRattache => ({ message: m, tenantId });

describe('🔴 qui la porte écarte (`messagesEcartes`)', () => {
  it('Free pleine : l’inconnu est écarté, le connu entre, l’espace est prévenu UNE fois pour le lot, avec sa limite', async () => {
    const f = freePleine();
    const { traces, stop } = ecritures();
    const ecartes = await messagesEcartes([
      rattache(message(INCONNU, 'wamid.1', 'Bonjour')), rattache(message(CONNU, 'wamid.2', 'Re')), rattache(message(INCONNU, 'wamid.3', 'Vous êtes là ?')),
    ], f.deps, stop);
    expect([...ecartes].sort()).toEqual(['wamid.1', 'wamid.3']);
    // Une lecture par espace pour tout le lot.
    expect(f.lus).toEqual([['t1', [INCONNU, CONNU, INCONNU]]]);
    expect(f.prevenus).toEqual([['t1', 100]]);
    // Rien n'est écrit pour un message qui n'est pas un STOP.
    expect(traces).toEqual([]);
  });

  it('🔴 le STOP d’un inconnu est retenu, et rien d’autre : sa fiche, puis son refus ; le message reste écarté', async () => {
    const f = freePleine();
    const { traces, stop } = ecritures();
    const ecartes = await messagesEcartes([rattache(message(INCONNU, 'wamid.stop', 'STOP'))], f.deps, stop);
    expect([...ecartes]).toEqual(['wamid.stop']);
    expect(traces).toEqual([`fiche:t1:${INCONNU}`, `stop:t1:${INCONNU}:wamid.stop`]);
    // L'alerte parle d'un client qui n'est pas entré : un STOP seul ne la fait pas partir (sa fiche existe).
    expect(f.prevenus).toEqual([]);
  });

  it('un bouton dont le libellé commence par « Stop » n’est pas un STOP : rien n’est écrit', async () => {
    const { traces, stop } = ecritures();
    await messagesEcartes([rattache(message(INCONNU, 'wamid.b', 'Stopper la simulation', 'button'))], freePleine().deps, stop);
    expect(traces).toEqual([]);
  });

  it('🔴 un STOP qui ne s’écrit pas n’est PAS écarté : le chemin commun le refait et garde son message ; l’échec est journalisé', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const erreurs: string[] = [];
    const avertissements: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: string) => { erreurs.push(l); });
    vi.spyOn(console, 'warn').mockImplementation((l: string) => { avertissements.push(l); });
    // Écarté, il serait perdu sans trace (ni journal brut, ni rejeu), et un import le croirait consentant.
    const enPanne: EcrituresDuStop = { optOut: async () => { throw new Error('base indisponible'); } };
    const f = freePleine();
    await expect(messagesEcartes([rattache(message(INCONNU, 'wamid.stop', 'STOP'))], f.deps, enPanne)).resolves.toEqual(new Set());
    expect(erreurs.some((l) => l.includes('stop_espace_plein_impossible'))).toBe(true);
    // Un refus qui ne trouve aucune fiche à désabonner n'est pas écrit non plus : même chemin.
    const sansFiche: EcrituresDuStop = { optOut: async () => null };
    await expect(messagesEcartes([rattache(message(INCONNU, 'wamid.stop2', 'STOP'))], f.deps, sansFiche)).resolves.toEqual(new Set());
    expect(avertissements.some((l) => l.includes('stop_espace_plein_sans_fiche'))).toBe(true);
    expect(f.prevenus).toEqual([]);
  });

  it('personne n’est refusé (Pro plein, Free sous sa limite) : rien n’est écarté, personne n’est prévenu', async () => {
    const { traces, stop } = ecritures();
    const p = personneRefuse();
    expect(await messagesEcartes([rattache(message(INCONNU, 'wamid.1', 'Bonjour')), rattache(message(INCONNU, 'wamid.2', 'STOP'))], p.deps, stop))
      .toEqual(new Set());
    expect(traces).toEqual([]);
    expect(p.prevenus).toEqual([]);
  });

  it('🔴 une lecture en échec laisse tout entrer : une limite commerciale ne coupe jamais la réception', async () => {
    const lignes: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((l: string) => { lignes.push(l); });
    const enPanne: EspacesPleins = { refuses: async () => { throw new Error('base indisponible'); }, prevenir: async () => {} };
    expect(await messagesEcartes([rattache(message(INCONNU, 'wamid.1', 'Bonjour'))], enPanne, ecritures().stop)).toEqual(new Set());
    expect(lignes.some((l) => l.includes('espace_plein_illisible'))).toBe(true);
  });

  it('un numéro business inconnu (espace `null`) n’est pas lu', async () => {
    const f = freePleine();
    expect(await messagesEcartes([rattache(message(INCONNU, 'wamid.1', 'Bonjour'), null)], f.deps, ecritures().stop)).toEqual(new Set());
    expect(f.lus).toEqual([]);
  });

  it('🔴 l’écart est journalisé sans le numéro de qui écrit, ni son message', async () => {
    const lignes: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => { lignes.push(l); });
    await messagesEcartes([rattache(message(INCONNU, 'wamid.1', 'Mon adresse est 3 rue des Lilas'))], freePleine().deps, ecritures().stop);
    const ecart = lignes.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'entrant_ecarte_espace_plein');
    expect(ecart).toEqual({ lvl: 'info', msg: 'entrant_ecarte_espace_plein', tenantId: 't1', phoneNumberId: 'pn1', messageId: 'wamid.1', stop: false });
    expect(lignes.join('\n')).not.toContain(INCONNU);
    expect(lignes.join('\n')).not.toContain('Lilas');
  });
});

describe('le payload sans les messages écartés (`sansCesMessages`)', () => {
  it('retire par identifiant, garde les accusés et les autres messages, sans toucher au payload reçu', () => {
    const recu = payload(messages('pn1', [texte('wamid.1', INCONNU, 'a'), texte('wamid.2', CONNU, 'b')], { statuses: [accuse] }));
    const copie = JSON.parse(JSON.stringify(recu)) as unknown;
    const filtre = sansCesMessages(recu, new Set(['wamid.1']));
    expect(filtre).toEqual(payload(messages('pn1', [texte('wamid.2', CONNU, 'b')], { statuses: [accuse] })));
    expect(recu).toEqual(copie);
  });

  it('rien à retirer : le payload reçu, tel quel', () => {
    const recu = payload(messages('pn1', [texte('wamid.2', CONNU, 'b')]));
    expect(sansCesMessages(recu, new Set(['wamid.9']))).toBe(recu);
    expect(sansCesMessages(recu, new Set())).toBe(recu);
  });

  it('un `standby` : le message est retiré là où Meta l’a posé, sous `value.standby`', () => {
    const recu = payload({
      field: 'standby',
      value: { metadata: { phone_number_id: 'pn1' }, standby: { contacts: [{ wa_id: INCONNU }], messages: [texte('wamid.1', INCONNU, 'a')] } },
    });
    expect(sansCesMessages(recu, new Set(['wamid.1']))).toEqual(payload({
      field: 'standby',
      value: { metadata: { phone_number_id: 'pn1' }, standby: { contacts: [{ wa_id: INCONNU }], messages: [] } },
    }));
  });
});

describe('la porte sur un payload de Meta (`ecarterLesInconnusDesEspacesPleins`)', () => {
  it('un lot d’accusés purs ne lit ni numéro ni espace', async () => {
    const recu = payload(messages('pn1', [], { statuses: [accuse] }));
    const lectures: string[] = [];
    expect(await ecarterLesInconnusDesEspacesPleins(recu, async (pn) => { lectures.push(pn); return 't1'; }, freePleine().deps, ecritures().stop)).toBe(recu);
    expect(lectures).toEqual([]);
  });

  it('🔴 un espace illisible laisse le payload tel quel : le rattachement qui suit relira, et fera rejouer le job s’il le faut', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recu = payload(messages('pn1', [texte('wamid.1', INCONNU, 'a')]));
    expect(await ecarterLesInconnusDesEspacesPleins(recu, async () => { throw new Error('base indisponible'); }, freePleine().deps, ecritures().stop)).toBe(recu);
  });
});

/**
 * Toutes les étapes de la file `webhook`, qui notent ce qu'elles reçoivent, derrière la porte donnée. `refusEnPanne` : le
 * nombre de premiers appels du refus (`inboundOptOut`) qui échouent, comme une base indisponible.
 */
function job(espacesPleins: EspacesPleins, refusEnPanne = 0) {
  const vus: string[] = [];
  const lectures: string[] = [];
  let pannes = refusEnPanne;
  const deps: WebhookJobDeps = {
    // Le journal brut voit passer chaque événement gardé, accusés compris : c'est lui qui prouve ce qui est entré.
    store: { insertEvent: async (e) => { vus.push(`journal:${e.dedupKey}`); return true; } },
    inbox: {
      phoneNumberTenant: async (pn) => { lectures.push(pn); return 't1'; },
      recordInbound: async (_t, m) => { vus.push(`message:${m.messageId}`); return { rouverte: false }; },
    },
    numerosDelies: aucunNumeroDelie,
    espacesPleins,
    inboundOptOut: async (t, waId, id) => {
      if (pannes > 0) { pannes -= 1; throw new Error('base indisponible'); }
      vus.push(`stop:${t}:${waId}:${id}`);
      return 'c1';
    },
    detenteur: aucuneCorrectionDuDetenteur,
    listeALArrivee: agentEteintALArrivee,
    inboundContactUpsert: async (t, m) => { vus.push(`fiche:${t}:${m.waId}`); return 'created'; },
    signalReponse: async (t, m) => { vus.push(`signal:${m.messageId}`); },
    arriveesPub: aucuneArriveePub,
    routagePub: aucunRoutagePub,
    triggers: { run: async (_t, ev) => { vus.push(`automation:${ev.waId}`); return 0; } },
    workflowAdvance: { advance: async (_t, waId) => { vus.push(`avance:${waId}`); } },
    remiseMbaEntrant: { remettre: async (_t, waId) => { vus.push(`remise:${waId}`); } },
  };
  return { deps, vus, lectures };
}

describe('🔴 la réception de Meta et de 360dialog (`handleWebhookJob`) derrière la porte', () => {
  it('Free pleine : le message d’un inconnu n’entre pas, ni fiche, ni journal brut, ni message, ni scénario, ni agent', async () => {
    const f = freePleine();
    const j = job(f.deps);
    await handleWebhookJob(payload(messages('pn1', [texte('wamid.1', INCONNU, 'Bonjour')])), j.deps);
    expect(j.vus).toEqual([]);
    expect(f.prevenus).toEqual([['t1', 100]]);
    // Le numéro n'est lu qu'une fois pour tout le job : la porte et le rattachement partagent la même lecture.
    expect(j.lectures).toEqual(['pn1']);
  });

  it('🔴 Free pleine : un contact déjà présent écrit, et tout se passe comme avant', async () => {
    const avec = job(freePleine().deps);
    const sans = job(personneRefuse().deps);
    const recu = payload(messages('pn1', [texte('wamid.2', CONNU, 'Bonjour')]));
    await handleWebhookJob(recu, avec.deps);
    await handleWebhookJob(recu, sans.deps);
    expect(avec.vus).toEqual(sans.vus);
    expect(avec.vus).toEqual(['journal:msg:wamid.2', `fiche:t1:${CONNU}`, 'message:wamid.2', 'signal:wamid.2', `automation:${CONNU}`, `avance:${CONNU}`, `remise:${CONNU}`]);
  });

  it('🔴 Free pleine : le STOP d’un inconnu crée sa fiche en STOP, et rien d’autre', async () => {
    const f = freePleine();
    const j = job(f.deps);
    await handleWebhookJob(payload(messages('pn1', [texte('wamid.stop', INCONNU, 'STOP')])), j.deps);
    expect(j.vus).toEqual([`fiche:t1:${INCONNU}`, `stop:t1:${INCONNU}:wamid.stop`]);
    expect(f.prevenus).toEqual([]);
  });

  it('les accusés du même lot passent, comme pour un numéro délié', async () => {
    const j = job(freePleine().deps);
    await handleWebhookJob(payload(messages('pn1', [texte('wamid.1', INCONNU, 'Bonjour')], { statuses: [accuse] })), j.deps);
    expect(j.vus).toContain('journal:status:wamid.s:delivered');
    expect(j.vus.some((v) => v.includes('wamid.1'))).toBe(false);
  });

  it('🔴 le Pro plein, ou une Free sous sa limite : l’inconnu entre comme aujourd’hui', async () => {
    const p = personneRefuse();
    const j = job(p.deps);
    await handleWebhookJob(payload(messages('pn1', [texte('wamid.1', INCONNU, 'Bonjour')])), j.deps);
    expect(j.vus).toEqual(['journal:msg:wamid.1', `fiche:t1:${INCONNU}`, 'message:wamid.1', 'signal:wamid.1', `automation:${INCONNU}`, `avance:${INCONNU}`, `remise:${INCONNU}`]);
    expect(p.prevenus).toEqual([]);
  });

  it('🔴 Free pleine : un STOP qui ne s’écrit pas à la porte entre par le chemin commun, journal brut et message compris', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = freePleine();
    // La porte et le chemin commun partagent le même refus (`inboundOptOut`) : en panne au premier appel, celui de la
    // porte, il réussit au second, celui du chemin commun.
    const j = job(f.deps, 1);
    await handleWebhookJob(payload(messages('pn1', [texte('wamid.stop', INCONNU, 'STOP')])), j.deps);
    expect(j.vus).toContain('journal:msg:wamid.stop');
    expect(j.vus).toContain(`stop:t1:${INCONNU}:wamid.stop`);
    expect(f.prevenus).toEqual([]);
  });
});
