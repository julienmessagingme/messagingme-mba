import { describe, it, expect, vi } from 'vitest';
import { processRoutagePub, type RoutagePubDeps } from '../src/webhooks/routage-pub';
import { processTriggers } from '../src/webhooks/triggers';
import { runAutomations } from '../src/automation/runner';
import { POSSESSEUR_PUBLICITE } from '../src/automation/match';
import type { AutomationEvent, AutomationRow } from '../src/automation/match';
import type { IssueRoutage, PubDuLead } from '../src/pubs/routage';

/**
 * LE ROUTAGE D'UN LEAD PUBLICITAIRE, CÂBLÉ, ET CE QUI EN SORT.
 *
 * 🔴 CES TESTS LISENT CE QUI PART, PAS CE QUE LES FONCTIONS RENDENT. Ce qui compte n'est pas la valeur de
 * retour de `processRoutagePub`, c'est : a-t-on appelé Meta pour prendre le fil, qu'a-t-on inscrit sur
 * l'arrivée, et quelles automations ont réellement tourné. Un test qui n'éprouverait que la fonction pure
 * resterait vert en débranchant tout le câblage : c'est le défaut mesuré dans ce dépôt (« une garde qu'on
 * peut débrancher sans qu'aucun test ne tombe n'est pas une garde »).
 */

const referral = (adId = 'ad-1', sourceType: string | null = 'ad') => ({
  source_url: 'https://fb.me/x', source_id: adId, source_type: sourceType,
  headline: 'Offre', body: 'Parlez-nous', ctwa_clid: 'clid-1',
});

const payload = (messages: unknown[], field = 'messages') => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, messages } }] }],
});

const message = (id: string, ref?: unknown) =>
  ({ id, from: '33611223344', type: 'text', text: { body: 'Bonjour' }, ...(ref ? { referral: ref } : {}) });

const PUB_SCENARIO: PubDuLead = { campagneId: 'camp-1', destination: 'scenario', automationId: 'auto-pub' };
const PUB_AGENT: PubDuLead = { campagneId: 'camp-2', destination: 'agent_meta', automationId: null };

/** Un faux qui RETIENT ce qui sort. Tout part de `pub` : c'est la seule chose que chaque cas fait varier. */
function monter(over: Partial<RoutagePubDeps> & { pub?: PubDuLead | null } = {}) {
  const reprises: string[] = [];
  const notes: Array<{ messageId: string; campagneId: string | null; issue: IssueRoutage; avecHeure: boolean }> = [];
  const memorisees: Array<{ adId: string }> = [];
  const pub = over.pub === undefined ? PUB_SCENARIO : over.pub;
  const deps: RoutagePubDeps = {
    phoneNumberTenant: async () => 't1',
    campagneConnue: async () => (pub === null ? null : pub.campagneId),
    resoudreChezMeta: async (_t, adId) => { memorisees.push({ adId }); return null; },
    publiciteDeLaCampagne: async () => pub,
    contactBloque: async () => false,
    estDesabonne: async () => false,
    reprendreLeFil: async (_t, waId) => { reprises.push(waId); return true; },
    noterIssue: async (_t, messageId, v) => {
      notes.push({ messageId, campagneId: v.campagneId, issue: v.issue, avecHeure: v.repriseLe !== null });
    },
    ...over,
  };
  return { deps, reprises, notes, memorisees };
}

describe('processRoutagePub : ce qui part, et ce qui s’inscrit sur l’arrivée', () => {
  it('message NORMAL sur une pub « scénario » : aucune reprise, issue `scenario`, restriction sur SON automation', async () => {
    const { deps, reprises, notes } = monter();
    const routes = await processRoutagePub(payload([message('wamid.1', referral())]), deps);
    expect(reprises).toEqual([]);
    expect(notes).toEqual([{ messageId: 'wamid.1', campagneId: 'camp-1', issue: 'scenario', avecHeure: false }]);
    expect(routes.get('wamid.1')).toEqual({ restriction: { sorte: 'seule', automationId: 'auto-pub' }, campagneId: 'camp-1' });
  });

  it('🔴 message STANDBY sur une pub « scénario » : LE FIL EST REPRIS, et l’heure est inscrite', async () => {
    const { deps, reprises, notes } = monter();
    const routes = await processRoutagePub(payload([message('wamid.2', referral())], 'standby'), deps);
    // C'est l'appel à Meta qui compte : sans lui, le scénario partirait sur un fil que l'agent de Meta tient.
    expect(reprises).toEqual(['33611223344']);
    expect(notes).toEqual([{ messageId: 'wamid.2', campagneId: 'camp-1', issue: 'reprise_reussie', avecHeure: true }]);
    expect(routes.get('wamid.2')?.restriction).toEqual({ sorte: 'seule', automationId: 'auto-pub' });
  });

  it('🔴 reprise REFUSÉE par Meta : issue `reprise_refusee`, AUCUNE heure, et plus aucun déclencheur', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, notes } = monter({ reprendreLeFil: async () => false });
    const routes = await processRoutagePub(payload([message('wamid.3', referral())], 'standby'), deps);
    spy.mockRestore();
    expect(notes).toEqual([{ messageId: 'wamid.3', campagneId: 'camp-1', issue: 'reprise_refusee', avecHeure: false }]);
    // L'agent de Meta garde le lead : répondre par-dessus ferait recevoir DEUX messages au contact.
    expect(routes.get('wamid.3')?.restriction).toEqual({ sorte: 'aucun' });
  });

  it('pub « agent de Meta » : aucun déclencheur, aucune reprise, aucune lecture de l’état du contact', async () => {
    const bloqueAppele: string[] = [];
    const { deps, reprises, notes } = monter({
      pub: PUB_AGENT,
      contactBloque: async (_t, waId) => { bloqueAppele.push(waId); return false; },
    });
    const routes = await processRoutagePub(payload([message('wamid.4', referral())]), deps);
    expect(reprises).toEqual([]);
    expect(notes[0]?.issue).toBe('agent_meta');
    expect(routes.get('wamid.4')?.restriction).toEqual({ sorte: 'aucun' });
    // ⚠️ L'ÉCONOMIE EST MESURÉE, pas supposée : deux requêtes de moins sur le chemin chaud de chaque
    // message publicitaire, et elle n'est sûre que parce que la règle pure ne lit pas ces faits ici.
    expect(bloqueAppele).toEqual([]);
  });

  it('campagne INCONNUE : rien n’est restreint, et l’état du contact n’est pas lu non plus', async () => {
    const lectures: string[] = [];
    const { deps, notes } = monter({
      pub: null,
      contactBloque: async () => { lectures.push('bloque'); return false; },
      estDesabonne: async () => { lectures.push('desabonne'); return false; },
    });
    const routes = await processRoutagePub(payload([message('wamid.5', referral())]), deps);
    expect(notes).toEqual([{ messageId: 'wamid.5', campagneId: null, issue: 'inchange', avecHeure: false }]);
    expect(routes.get('wamid.5')).toEqual({ restriction: { sorte: 'tous' }, campagneId: null });
    expect(lectures).toEqual([]);
  });

  it('contact BLOQUÉ sur une pub « scénario » : rien ne part, et l’arrivée le dit', async () => {
    const { deps, reprises, notes } = monter({ contactBloque: async () => true });
    const routes = await processRoutagePub(payload([message('wamid.6', referral())], 'standby'), deps);
    expect(reprises).toEqual([]);
    expect(notes[0]?.issue).toBe('bloque');
    expect(routes.get('wamid.6')?.restriction).toEqual({ sorte: 'aucun' });
  });

  it('🔴 contact DÉSABONNÉ : rien ne part, et surtout aucun fil n’est pris chez Meta', async () => {
    const { deps, reprises, notes } = monter({ estDesabonne: async () => true });
    await processRoutagePub(payload([message('wamid.7', referral())], 'standby'), deps);
    // Prendre le fil pour quelqu'un à qui l'on n'a pas le droit d'écrire serait un geste chez Meta pour
    // rien, et un fil retiré à l'agent qui, lui, pouvait encore répondre.
    expect(reprises).toEqual([]);
    expect(notes[0]?.issue).toBe('desabonne');
  });
});

describe('la résolution d’une publicité jamais vue', () => {
  it('une pub inconnue est demandée à Meta', async () => {
    const { deps, memorisees } = monter({ pub: null, campagneConnue: async () => null });
    await processRoutagePub(payload([message('wamid.8', referral('ad-neuve'))]), deps);
    expect(memorisees).toEqual([{ adId: 'ad-neuve' }]);
  });

  it('🔴 un `referral` de PUBLICATION n’est jamais demandé à Meta', async () => {
    // Un identifiant de publication n'est pas un identifiant de pub : l'appel rendrait un 400 à chaque lead
    // d'une page qui marche, sur le chemin chaud d'un message entrant.
    const { deps, memorisees, notes } = monter({ pub: null, campagneConnue: async () => null });
    await processRoutagePub(payload([message('wamid.9', referral('post-1', 'post'))]), deps);
    expect(memorisees).toEqual([]);
    expect(notes[0]?.issue).toBe('inchange');
  });

  it('⚠️ un `source_type` ABSENT est quand même tenté : son absence ne prouve rien', async () => {
    const { deps, memorisees } = monter({ pub: null, campagneConnue: async () => null });
    await processRoutagePub(payload([message('wamid.10', referral('ad-sans-type', null))]), deps);
    expect(memorisees).toEqual([{ adId: 'ad-sans-type' }]);
  });

  it('🔴 un échec de résolution laisse le lead sur le chemin ORDINAIRE, il ne le fait pas disparaître', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, notes } = monter({
      pub: null,
      campagneConnue: async () => null,
      resoudreChezMeta: async () => { throw new Error('Meta ne répond pas'); },
    });
    const routes = await processRoutagePub(payload([message('wamid.11', referral())]), deps);
    spy.mockRestore();
    expect(notes[0]?.issue).toBe('inchange');
    expect(routes.get('wamid.11')?.restriction).toEqual({ sorte: 'tous' });
  });
});

describe('isolation : un lead qui échoue ne prive pas les autres', () => {
  it('le second message est routé même si le premier lève', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let premier = true;
    const { deps, notes } = monter({
      publiciteDeLaCampagne: async () => {
        if (premier) { premier = false; throw new Error('base indisponible'); }
        return PUB_SCENARIO;
      },
    });
    const routes = await processRoutagePub(
      payload([message('wamid.a', referral()), message('wamid.b', referral())]), deps,
    );
    spy.mockRestore();
    expect(notes.map((n) => n.messageId)).toEqual(['wamid.b']);
    // ⚠️ Le message en échec n'entre dans AUCUNE restriction, donc il suit le chemin ordinaire : c'est le
    // repli le moins surprenant, et il est délibéré.
    expect(routes.has('wamid.a')).toBe(false);
  });
});

/**
 * LA DOCTRINE DU `standby`, ET SON UNIQUE EXCEPTION.
 *
 * 🔴 Ces quatre tests sont les seuls du dépôt à toucher cette règle, et les deux sens comptent autant l'un
 * que l'autre : sans l'exception, un lead de publicité ne démarre JAMAIS son scénario sur le numéro du
 * pilote (l'agent de Meta y tient tous les fils), et c'est le défaut n°3 que la spec a relevé. Sans la
 * règle, n'importe quel message reçu pendant que l'agent de Meta parle reprendrait le contrôle en silence.
 */
describe('processTriggers : la doctrine du standby, et son unique exception', () => {
  const capte = () => {
    const appels: Array<{ ev: AutomationEvent; seule: string | null }> = [];
    return {
      appels,
      deps: {
        phoneNumberTenant: async () => 't1',
        isNewContact: async () => false,
        run: async (_t: string, ev: AutomationEvent, opts: { seuleAutomation: string | null }) => {
          appels.push({ ev, seule: opts.seuleAutomation });
          return 1;
        },
      },
    };
  };

  it('🔴 un standby ORDINAIRE (aucun routage) ne déclenche toujours rien', async () => {
    const { deps, appels } = capte();
    await processTriggers(payload([message('wamid.s1')], 'standby'), deps);
    expect(appels).toEqual([]);
  });

  it('🔴 un standby dont le routage a REPRIS le fil déclenche, et SEULEMENT l’automation de la pub', async () => {
    const { deps, appels } = capte();
    await processTriggers(
      payload([message('wamid.s2', referral())], 'standby'), deps, undefined,
      new Map([['wamid.s2', { restriction: { sorte: 'seule' as const, automationId: 'auto-pub' }, campagneId: 'camp-1' }]]),
    );
    expect(appels).toHaveLength(1);
    expect(appels[0]?.seule).toBe('auto-pub');
  });

  it('🔴 un standby dont la reprise a ÉCHOUÉ ne déclenche rien : la restriction `aucun` ne perce pas la règle', async () => {
    const { deps, appels } = capte();
    await processTriggers(
      payload([message('wamid.s3', referral())], 'standby'), deps, undefined,
      new Map([['wamid.s3', { restriction: { sorte: 'aucun' as const }, campagneId: 'camp-1' }]]),
    );
    expect(appels).toEqual([]);
  });

  it('un message NORMAL écarté par le routage ne déclenche rien non plus', async () => {
    const { deps, appels } = capte();
    await processTriggers(
      payload([message('wamid.n1', referral())]), deps, undefined,
      new Map([['wamid.n1', { restriction: { sorte: 'aucun' as const }, campagneId: 'camp-2' }]]),
    );
    expect(appels).toEqual([]);
  });

  it('la CAMPAGNE voyage jusqu’à l’événement, sans quoi l’automation de la pub se refuserait elle-même', async () => {
    const { deps, appels } = capte();
    await processTriggers(
      payload([message('wamid.n2', referral())]), deps, undefined,
      new Map([['wamid.n2', { restriction: { sorte: 'seule' as const, automationId: 'auto-pub' }, campagneId: 'camp-1' }]]),
    );
    const ev = appels[0]?.ev;
    expect(ev?.kind === 'message' ? ev.campagneId : undefined).toBe('camp-1');
    expect(ev?.kind === 'message' ? ev.adId : undefined).toBe('ad-1');
  });

  it('sans routage du tout, rien ne change : aucune restriction, aucune campagne', async () => {
    const { deps, appels } = capte();
    await processTriggers(payload([message('wamid.n3', referral())]), deps);
    expect(appels).toHaveLength(1);
    expect(appels[0]?.seule).toBeNull();
    const ev = appels[0]?.ev;
    expect(ev?.kind === 'message' ? ev.campagneId : undefined).toBeUndefined();
  });
});

/**
 * « TOUTES LES PUBS » NE PART PLUS POUR UNE CAMPAGNE RELIÉE.
 *
 * 🔴 C'EST UN CHANGEMENT DE COMPORTEMENT POUR LES AUTOMATIONS DÉJÀ CRÉÉES, assumé par la spec (§ 9) et
 * invisible de tout le reste : l'automation « toutes les pubs » continue de CORRESPONDRE, c'est la
 * restriction qui l'écarte. Un test qui n'éprouverait que `matchesTrigger` ne verrait rien.
 */
describe('la restriction écarte réellement les autres automations', () => {
  const auto = (over: Partial<AutomationRow>): AutomationRow => ({
    id: 'a', tenantId: 't1', name: 'x', enabled: true, triggerKind: 'ctwa_ad', triggerConfig: {},
    conditionGroup: null, workflowId: 'wf', startNodeId: null, cooldownSeconds: 0,
    maxFiresPerHour: null, possedePar: null, ...over,
  });

  const ev: AutomationEvent = {
    kind: 'message', waId: '33611223344', body: 'Bonjour', isNewContact: true,
    channel: 'whatsapp', adId: 'ad-1', campagneId: 'camp-1',
  };

  const monterRunner = (rows: AutomationRow[]) => {
    const partis: string[] = [];
    return {
      partis,
      deps: {
        listEnabled: async () => rows,
        lastFiredAt: async () => null,
        markFired: async () => true,
        clearFired: async () => {},
        evalContext: async () => null,
        startWorkflow: async (_t: string, _w: string, _waId: string, o: { reprendLaMain: boolean }) => {
          partis.push(`${_w}:${o.reprendLaMain ? 'reprise' : 'sans'}`);
          return true;
        },
        defaultCooldownSeconds: 0,
      },
    };
  };

  const toutesLesPubs = auto({ id: 'auto-catch', workflowId: 'wf-catch' });
  const nouveauContact = auto({ id: 'auto-neuf', triggerKind: 'new_contact', workflowId: 'wf-neuf' });
  const celleDeLaPub = auto({
    id: 'auto-pub', triggerKind: 'ctwa_ad', triggerConfig: { campaignId: 'camp-1' },
    workflowId: 'wf-pub', possedePar: POSSESSEUR_PUBLICITE, maxFiresPerHour: 0,
  });

  it('🔴 SANS restriction, les trois partent : c’est le comportement d’AVANT ce lot', async () => {
    const { deps, partis } = monterRunner([toutesLesPubs, nouveauContact, celleDeLaPub]);
    expect(await runAutomations('t1', ev, deps)).toBe(3);
    expect(partis.sort()).toEqual(['wf-catch:sans', 'wf-neuf:sans', 'wf-pub:reprise']);
  });

  it('🔴 AVEC la restriction, SEULE celle de la pub part, et elle reprend la main', async () => {
    const { deps, partis } = monterRunner([toutesLesPubs, nouveauContact, celleDeLaPub]);
    expect(await runAutomations('t1', ev, deps, { seuleAutomation: 'auto-pub' })).toBe(1);
    expect(partis).toEqual(['wf-pub:reprise']);
  });

  it('🔴 une automation de pub réglée sur une AUTRE campagne ne part pas, même nommée par la restriction', async () => {
    // La restriction choisit QUI est évaluée ; elle ne dispense pas de la correspondance. Sans ce sens-là,
    // nommer une automation suffirait à la faire partir sur n'importe quel lead.
    const ailleurs = auto({
      id: 'auto-pub', triggerKind: 'ctwa_ad', triggerConfig: { campaignId: 'camp-AUTRE' },
      workflowId: 'wf-pub', possedePar: POSSESSEUR_PUBLICITE,
    });
    const { deps, partis } = monterRunner([ailleurs]);
    expect(await runAutomations('t1', ev, deps, { seuleAutomation: 'auto-pub' })).toBe(0);
    expect(partis).toEqual([]);
  });
});
