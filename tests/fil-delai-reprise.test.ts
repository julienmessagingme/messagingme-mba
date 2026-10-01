import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAUSE_REOUVERTURE } from '../src/inbox/fil';
import { delaiHumainMs, repriseDue } from '../src/inbox/delai-reprise';
import { handleWebhookJob, type WebhookJobDeps } from '../src/webhooks/handler';
import { processRemiseMbaEntrant } from '../src/webhooks/remise-mba-entrant';
import { TYPE_MESSAGE_SANS_SUITE } from '../src/mba/evenement';
import { DELAI_REPRISE_DEFAUT_MS, bancDuFil, type OptionsBanc } from './banc-du-fil';
import { aucunNumeroDelie, aucunRoutagePub, aucunSignalReponse, aucuneArriveePub, entrantsDe } from './webhook-fixtures';
import { aucunStop } from './consentement';

/**
 * LE DÉLAI DE REPRISE DE L'ÉQUIPE, À L'ARRIVÉE D'UN MESSAGE (décisions de Julien du 2026-09-30).
 *
 * Constat du matin : une conversation tenue par l'équipe, marquée « Traité », puis le client réécrit, l'équipe
 * répond et remarque « Traité » : aucune demande dans le Quantitatif > Performance. Et un client qui réécrit bien
 * après le délai restait à l'équipe jusqu'au passage du balayage, qui saute d'ailleurs une fenêtre fermée.
 *
 *  - B : délai écoulé (la règle du balayage, `src/inbox/delai-reprise.ts`), le client qui écrit dans un fil de
 *    l'équipe est confié à l'agent de Meta TOUT DE SUITE, et l'agent répond à CE message ;
 *  - C : avant le délai (ou délai à 0, ou agent éteint), un client qui ROUVRE une conversation « Traité » ou archivée
 *    que l'équipe tient encore ouvre une nouvelle demande (`escaladee`, sans bascule).
 *
 * Le module réel (`src/inbox/fil.ts`) sur le banc (`tests/banc-du-fil.ts`). Le « Traité » qui relance le délai (A) est
 * en SQL : `tests/inbox-evenements.test.ts` (sa forme) et `tests/integration/inbox-traite.integration.test.ts`.
 */

afterEach(() => { vi.restoreAllMocks(); });

const HEURE = 3600_000;
const MSG = 'Re-bonjour, j’ai une autre question';
const il = (ms: number): Date => new Date(Date.now() - ms);
/** Le fil `w`, tenu par l'équipe depuis `depuis` ; le reste du banc en options. */
const equipe = (depuis: number, o: Omit<OptionsBanc, 'conversations'> & { escalade?: boolean } = {}) => {
  const { escalade, ...banc } = o;
  return bancDuFil({ ...banc, conversations: { w: { owner: 'app_human', changedAt: il(depuis), escaladeeLe: escalade ? il(depuis) : null } } });
};

describe('la règle partagée par le balayage et la remise', () => {
  it('le délai de l’espace prime sur le défaut, et 0 veut dire « jamais »', () => {
    expect(delaiHumainMs(null, DELAI_REPRISE_DEFAUT_MS)).toBe(DELAI_REPRISE_DEFAUT_MS);
    expect(delaiHumainMs(600, DELAI_REPRISE_DEFAUT_MS)).toBe(600_000);
    expect(repriseDue({ owner: 'app_human', depuisMs: 30 * HEURE, escaladee: false }, 0)).toBe(false);
  });

  it('échu au délai, jamais sur une escalade sans réponse, et un fil non daté est échu', () => {
    expect(repriseDue({ owner: 'app_human', depuisMs: 2 * HEURE, escaladee: false }, 2 * HEURE)).toBe(true);
    expect(repriseDue({ owner: 'app_human', depuisMs: 2 * HEURE - 1, escaladee: false }, 2 * HEURE)).toBe(false);
    expect(repriseDue({ owner: 'app_human', depuisMs: 30 * HEURE, escaladee: true }, 2 * HEURE)).toBe(false);
    expect(repriseDue({ owner: 'app_human', depuisMs: null, escaladee: false }, 2 * HEURE)).toBe(true);
  });

  it('🔴 une seule écriture : le balayage et la remise appellent la même règle, aucun ne la recopie', () => {
    for (const fichier of ['../src/inbox/control-sweep.ts', '../src/inbox/fil.ts']) {
      const source = readFileSync(new URL(fichier, import.meta.url), 'utf8');
      expect(source, fichier).toMatch(/\brepriseDue\(/);
      // La comparaison au délai ne vit que dans la règle partagée.
      expect(source, fichier).not.toMatch(/getTime\(\)\s*<\s*ms\b/);
    }
  });
});

/**
 * 🔴 B : APRÈS LE DÉLAI, LE CLIENT QUI ÉCRIT EST CONFIÉ À L'AGENT, QUI RÉPOND À CE MESSAGE. Vérifié dans les deux sens :
 * la garde d'avant remise (`app_human` : rien), les cas 🔴 échouent (aucun appel, le fil reste à l'équipe).
 */
describe('B : un fil de l’équipe dont le délai est écoulé', () => {
  it('🔴 confié à l’agent de Meta, `mba`, et l’agent est prévenu avec le texte du client', async () => {
    const b = equipe(3 * HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(b.appels).toEqual(['ajout:w', 'release:w', 'evenement:w']);
    expect(b.etat('w')?.owner).toBe('mba');
    expect(b.evenements[0]?.event.type).toBe(TYPE_MESSAGE_SANS_SUITE);
    expect(JSON.parse(b.evenements[0]!.event.payload)).toEqual({ message: MSG });
    // La frise le dit : c'est le délai, pas un collaborateur, et l'écriture ne prend que depuis l'équipe.
    expect(b.ecritures.at(-1)?.opts).toMatchObject({ par: { cause: 'automatique : le contact réécrit après le délai de reprise' }, only: ['app_human'], saufEscalade: true });
    expect(b.demandes).toEqual([]);
  });

  it('🔴 même après plus de 24 h de silence : c’est le client qui vient d’ouvrir la fenêtre', async () => {
    const b = equipe(30 * HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(b.etat('w')?.owner).toBe('mba');
    expect(b.evenements).toHaveLength(1);
  });

  it('🔴 le délai réglé par l’espace prime sur le défaut', async () => {
    const b = equipe(20 * 60_000, { delaiRepriseSecondes: 600 });
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(b.etat('w')?.owner).toBe('mba');
  });

  it('délai pas encore écoulé : le fil reste à l’équipe, aucun appel', async () => {
    const b = equipe(HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(b.appels).toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('🔴 une escalade sans réponse reste à l’équipe, même délai écoulé', async () => {
    const b = equipe(3 * HEURE, { escalade: true });
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(b.appels).toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('délai à 0 : la main ne revient jamais toute seule', async () => {
    const b = equipe(30 * HEURE, { delaiRepriseSecondes: 0 });
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(b.appels).toEqual([]);
  });

  it('🔴 le contact a dit STOP : jamais confié, le fil reste à l’équipe', async () => {
    const b = equipe(3 * HEURE, { desabonnes: ['w'] });
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', 'STOP', { rouverte: false });
    expect(b.appels).toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('agent éteint, ou un parcours attend : le fil reste à l’équipe', async () => {
    for (const o of [{ mbaEnabled: false }, { enAttente: true }]) {
      const b = equipe(3 * HEURE, o);
      await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
      expect(b.appels, JSON.stringify(o)).toEqual([]);
      expect(b.etat('w')?.owner).toBe('app_human');
    }
  });
});

/**
 * 🔴 C : AVANT LE DÉLAI, UN CLIENT QUI ROUVRE UNE CONVERSATION DE L'ÉQUIPE OUVRE UNE DEMANDE. Vérifié dans les deux sens :
 * `laisserALEquipe` vidé (plus d'`ouvrirUneDemande`), les cas 🔴 échouent (aucune demande).
 */
describe('C : un client rouvre une conversation « Traité » ou archivée que l’équipe tient encore', () => {
  it('🔴 avant le délai : une demande pour l’équipe, avec sa cause, et rien chez Meta', async () => {
    const b = equipe(HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: true });
    expect(b.demandes).toEqual([{ waId: 'w', cause: CAUSE_REOUVERTURE }]);
    expect(CAUSE_REOUVERTURE).toBe('automatique : le contact réécrit après « Traité » ou l’archivage');
    expect(b.appels).toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  /**
   * 🔴 ESSAI RÉEL DU 2026-10-01 : un « Ok » envoyé dans la minute qui suivait « Traité » est resté à l'équipe, puis le
   * balayage a rendu la conversation à l'agent de Meta au délai compté depuis le clic, le message sans réponse de
   * personne. Décision de Julien : la réouverture est une escalade. Vérifié dans les deux sens : sans l'escalade posée
   * par `ouvrirUneDemande` (banc et store), ce cas échoue (la remise confie le message suivant à l'agent).
   */
  it('🔴 la réouverture est une ESCALADE : délai écoulé, le message suivant reste à l’équipe tant que personne n’a répondu', async () => {
    const b = equipe(HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: true });
    expect(b.etat('w')?.escaladeeLe).not.toBeNull();
    // Le délai s'écoule sans réponse de l'équipe.
    b.etat('w')!.changedAt = il(3 * HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', 'Vous êtes là ?', { rouverte: false });
    expect(b.appels).toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
    expect(repriseDue({ owner: 'app_human', depuisMs: 3 * HEURE, escaladee: true }, 2 * HEURE)).toBe(false);
  });

  it('un message qui ne rouvre rien n’ouvre aucune demande', async () => {
    const b = equipe(HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(b.demandes).toEqual([]);
  });

  it('🔴 délai à 0, ou agent éteint : l’équipe garde le fil, la réouverture ouvre une demande', async () => {
    for (const o of [{ delaiRepriseSecondes: 0 }, { mbaEnabled: false }]) {
      const b = equipe(30 * HEURE, o);
      await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: true });
      expect(b.demandes, JSON.stringify(o)).toEqual([{ waId: 'w', cause: CAUSE_REOUVERTURE }]);
    }
  });

  it('🔴 APRÈS le délai : aucune demande, la conversation part à l’agent de Meta', async () => {
    const b = equipe(3 * HEURE);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: true });
    expect(b.demandes).toEqual([]);
    expect(b.etat('w')?.owner).toBe('mba');
  });

  it('⚠️ après le délai mais Meta refuse l’ajout : le fil reste à l’équipe, la demande s’ouvre, et l’erreur remonte', async () => {
    const b = equipe(3 * HEURE, { ajout: ['refuse'] });
    await expect(b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: true })).rejects.toThrow();
    expect(b.demandes).toEqual([{ waId: 'w', cause: CAUSE_REOUVERTURE }]);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('une conversation que l’équipe ne tient pas n’ouvre aucune demande', async () => {
    for (const owner of ['mba', 'app_workflow'] as const) {
      const b = bancDuFil({ mbaEnabled: false, conversations: { w: { owner } } });
      await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: true });
      expect(b.demandes, owner).toEqual([]);
    }
  });
});

/**
 * 🔴 L'INFORMATION VIENT DE L'ÉCRITURE DE L'ENTRANT, PAS D'UNE RELECTURE : le dépôt rend `rouverte` (`recordInbound`),
 * `processInbound` la garde par message, le job la passe à la remise. Vérifié dans les deux sens : `rouvertes` retiré
 * de l'appel à `processRemiseMbaEntrant` dans le handler, le premier cas échoue (aucune demande).
 */
describe('du webhook à la demande, sur le vrai job', () => {
  const WA = '33612345678';
  const lot = (messages: Array<Record<string, unknown>>) => ({
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn1' }, contacts: [{ wa_id: WA }], messages } }] }],
  });
  const texte = (id: string, body: string) => ({ id, from: WA, type: 'text', timestamp: '1789465356', text: { body } });

  function monterLeJob(rouvre: readonly string[]) {
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_human' } } });
    const deps: WebhookJobDeps = {
      store: { insertEvent: async () => true },
      inbox: { recordInbound: async (_t, m) => ({ rouverte: rouvre.includes(m.messageId) }), phoneNumberTenant: async () => 't1' },
      arriveesPub: aucuneArriveePub,
      routagePub: aucunRoutagePub,
      signalReponse: aucunSignalReponse,
      numerosDelies: aucunNumeroDelie,
      inboundOptOut: aucunStop,
      detenteur: b.fil,
      listeALArrivee: { agentAllume: async () => true, presents: (t, w) => b.liste.presents(t, w) },
      remiseMbaEntrant: { remettre: b.fil.remettreSiPersonneNeSuit },
    };
    return { b, deps };
  }

  it('🔴 le message qui retire « Traité » ouvre une demande pour l’équipe', async () => {
    const { b, deps } = monterLeJob(['wamid.R']);
    await handleWebhookJob(lot([texte('wamid.R', 'Finalement, une question')]), deps);
    expect(b.demandes).toEqual([{ waId: WA, cause: CAUSE_REOUVERTURE }]);
  });

  it('un message qui ne rouvre rien n’en ouvre aucune', async () => {
    const { b, deps } = monterLeJob([]);
    await handleWebhookJob(lot([texte('wamid.S', 'Merci')]), deps);
    expect(b.demandes).toEqual([]);
  });

  it('⚠️ une réaction qui sort d’Archivé ne demande rien à l’équipe', async () => {
    const remises: boolean[] = [];
    const reaction = { id: 'wamid.E', from: WA, type: 'reaction', timestamp: '1789465356', reaction: { message_id: 'wamid.NOTRE', emoji: '👍' } };
    await processRemiseMbaEntrant(await entrantsDe(lot([reaction]), 't1'), {
      remettre: async (_t, _w, _c, entree) => { remises.push(entree.rouverte); },
    }, undefined, new Set(['wamid.E']));
    expect(remises).toEqual([false]);
  });
});
