import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { processRemiseMbaEntrant } from '../src/webhooks/remise-mba-entrant';
import { entrantsDe } from './webhook-fixtures';
import { bancDuFil } from './banc-du-fil';

/**
 * L'AGENT DE META REPREND LA MAIN QUAND UN CLIENT REVIENT ET QUE PERSONNE NE SUIT (2026-09-15), ET IL Y RÉPOND TOUT
 * DE SUITE (mode liste, 2026-09-29 : la conversation lui est confiée, et un événement lui passe le message).
 *
 * 🔴 CE QUE CES TESTS GARDENT, ET POURQUOI ILS EXISTENT. Deux incidents mesurés en production le même jour :
 * un message resté sans réponse parce que notre base disait `mba` quand Meta pensait l'inverse, et une
 * conversation invisible ET muette parce qu'elle portait la valeur PAR DÉFAUT `app_workflow`. Les deux se
 * réparent au même endroit, à l'ARRIVÉE du message, seul instant où la fenêtre de 24 h est ouverte.
 */

const PAYLOAD = (over: { field?: string; from?: string; id?: string } = {}): unknown => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba1',
    changes: [{
      field: over.field ?? 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '33525680250', phone_number_id: 'pn1' },
        messages: [{
          from: over.from ?? '33685973811',
          id: over.id ?? 'wamid.AAA',
          timestamp: '1789465356',
          type: 'text',
          text: { body: 'bonjour, je reviens vers vous' },
        }],
      },
    }],
  }],
});

function harnais(tenant: string | null = 't1') {
  const remises: Array<{ tenantId: string; waId: string; contenu: string }> = [];
  return {
    remises,
    tenant,
    deps: {
      remettre: async (tenantId: string, waId: string, contenu: string) => { remises.push({ tenantId, waId, contenu }); },
    },
  };
}

/** Plusieurs messages dans un même lot. */
const LOT = (messages: Array<Record<string, unknown>>): unknown => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '33525680250', phone_number_id: 'pn1' }, messages,
  } }] }],
});

describe('remise du fil à l’agent de Meta sur un message entrant', () => {
  it('🔴 un client qui revient déclenche la remise', async () => {
    // L'incident 1, rejoué : 33685973811 écrit après huit jours de silence et personne ne répondait.
    const h = harnais();
    await processRemiseMbaEntrant(await entrantsDe(PAYLOAD(), h.tenant), h.deps);
    // Avec son texte : l'agent y répond tout de suite, au lieu d'attendre le message suivant.
    expect(h.remises).toEqual([{ tenantId: 't1', waId: '33685973811', contenu: 'bonjour, je reviens vers vous' }]);
  });

  it('🔴 plusieurs messages du même contact dans un lot : UN seul geste, leurs textes mis bout à bout', async () => {
    // Deux gestes feraient deux événements, donc deux réponses de l'agent au même client.
    const h = harnais();
    await processRemiseMbaEntrant(await entrantsDe(LOT([
      { from: '33600000001', id: 'wamid.1', timestamp: '1789465356', type: 'text', text: { body: 'Bonjour' } },
      { from: '33600000002', id: 'wamid.2', timestamp: '1789465356', type: 'text', text: { body: 'Autre contact' } },
      { from: '33600000001', id: 'wamid.3', timestamp: '1789465357', type: 'image', image: { id: 'media-1', caption: 'ma facture' } },
      { from: '33600000001', id: 'wamid.4', timestamp: '1789465358', type: 'audio', audio: { id: 'media-2' } },
    ]), h.tenant), h.deps);
    expect(h.remises).toEqual([
      { tenantId: 't1', waId: '33600000001', contenu: 'Bonjour\nma facture\n[audio]' },
      { tenantId: 't1', waId: '33600000002', contenu: 'Autre contact' },
    ]);
  });

  it('⚠️ une réaction confie la conversation, mais ne dit rien à l’agent', async () => {
    // Son corps est un emoji posé sur un de nos messages, pas une question à laquelle répondre.
    const h = harnais();
    await processRemiseMbaEntrant(await entrantsDe(LOT([
      { from: '33600000001', id: 'wamid.r', timestamp: '1789465356', type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.nous' } },
    ]), h.tenant), h.deps);
    expect(h.remises).toEqual([{ tenantId: 't1', waId: '33600000001', contenu: '' }]);
  });

  it('🔴 un `standby` ne déclenche RIEN : l’agent tient déjà le fil', async () => {
    /**
     * La première garde, et elle n'est pas décorative. Un `standby` est la COPIE que Meta nous envoie quand
     * son agent détient le fil. Lui « rendre » un fil qu'il a déjà serait au mieux inutile, au pire une
     * reprise déguisée : c'est exactement ce que le produit cherche à éviter depuis le lot du 2026-09-14.
     */
    const h = harnais();
    await processRemiseMbaEntrant(await entrantsDe(PAYLOAD({ field: 'message_echoes' }), h.tenant), h.deps);
    expect(h.remises).toEqual([]);
  });

  it('🔴 un message DÉJÀ consommé ne déclenche rien', async () => {
    // Un message qui vient de démarrer un parcours, ou qu'un jeton de test a avalé, n'est pas un client qui
    // revient sans que rien ne soit prévu : c'est le contraire exact.
    const h = harnais();
    await processRemiseMbaEntrant(await entrantsDe(PAYLOAD({ id: 'wamid.BBB' }), h.tenant), h.deps, new Set(['wamid.BBB']));
    expect(h.remises).toEqual([]);
  });

  it('⚠️ un numéro inconnu ne déclenche rien, et n’échoue pas', async () => {
    const h = harnais(null);
    await processRemiseMbaEntrant(await entrantsDe(PAYLOAD(), h.tenant), h.deps);
    expect(h.remises).toEqual([]);
  });

  it('🔴 un échec de remise n’emporte pas le traitement du webhook', async () => {
    /**
     * Ce webhook porte AUSSI les statuts de livraison, l'inbox et les flows. Une passation ratée qui ferait
     * échouer le job les rejouerait tous, et le balayage de contrôle reste de toute façon le filet. On
     * échangerait un silence contre une perte.
     */
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = {
      remettre: async () => { throw new Error('Meta a refusé'); },
    };
    await expect(processRemiseMbaEntrant(await entrantsDe(PAYLOAD()), deps)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('⚠️ un échec sur UN contact laisse passer les autres du même lot', async () => {
    // Meta groupe plusieurs contacts dans un seul webhook. L'isolation est par message, comme chez les voisins.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const vus: string[] = [];
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba1',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '33525680250', phone_number_id: 'pn1' },
            messages: [
              { from: '33600000001', id: 'wamid.1', timestamp: '1789465356', type: 'text', text: { body: 'a' } },
              { from: '33600000002', id: 'wamid.2', timestamp: '1789465357', type: 'text', text: { body: 'b' } },
            ],
          },
        }],
      }],
    };
    await processRemiseMbaEntrant(await entrantsDe(payload), {
      remettre: async (_t: string, waId: string) => {
        vus.push(waId);
        if (waId === '33600000001') throw new Error('boum');
      },
    });
    expect(vus).toEqual(['33600000001', '33600000002']);
    spy.mockRestore();
  });
});

describe('ce que ce module ne porte pas : l’ordre du job, et les gardes du geste du fil', () => {
  const lire = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
  /** Sans les commentaires : un test qui passerait grâce à une PHRASE ne prouverait rien. */
  const sansCommentaires = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('🔴 la remise passe APRÈS l’avance des parcours, et l’ordre EST le correctif', () => {
    /**
     * `processWorkflowAdvance` peut faire avancer un parcours, donc laisser un run EN ATTENTE de la prochaine
     * réponse : c'est précisément ce que la garde du câblage lit pour REFUSER la remise. Placée avant, elle
     * lirait l'état d'AVANT l'avance et donnerait à l'agent de Meta un fil qu'un scénario vivant s'apprête à
     * utiliser. L'ordre n'est donc pas une préférence de lecture, c'est la correction elle-même.
     */
    const h = sansCommentaires(lire('../src/webhooks/handler.ts'));
    const avance = h.indexOf('processWorkflowAdvance(entrants');
    const remise = h.indexOf('processRemiseMbaEntrant(entrants');
    expect(avance, 'l’avance doit être appelée').toBeGreaterThan(-1);
    expect(remise, 'la remise doit être appelée').toBeGreaterThan(-1);
    expect(remise, 'la remise doit venir APRÈS l’avance').toBeGreaterThan(avance);
  });

  /**
   * Les trois cas suivants lisaient le texte du câblage ; les gardes vivent désormais dans le geste
   * (`ControleDuFil.remettreSiPersonneNeSuit`, `src/inbox/fil.ts`), et ils l'EXÉCUTENT.
   */
  it('🔴 les trois gardes du geste sont là : agent allumé, aucun parcours en attente, et `only`', async () => {
    const eteint = bancDuFil({ mbaEnabled: false, conversations: { w: { owner: 'app_workflow' } } });
    await eteint.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    expect(eteint.appels, 'l’agent doit être allumé').toEqual([]);

    const attendu = bancDuFil({ enAttente: true, conversations: { w: { owner: 'app_workflow' } } });
    await attendu.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    expect(attendu.appels, 'un parcours en attente doit REFUSER la remise').toEqual([]);

    const libre = bancDuFil({ conversations: { w: { owner: 'app_workflow' } } });
    await libre.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    expect(libre.appels, 'la remise doit appeler Meta, pas seulement écrire').toEqual(['ajout:w', 'release:w', 'evenement:w']);
    expect(libre.etat('w')?.owner).toBe('mba');
  });

  it('🔴 un humain sur la conversation est lu AVANT l’appel Meta, pas seulement dans `only`', async () => {
    /**
     * 🔴 DÉFAUT GRAVE TROUVÉ EN REVUE LE 2026-09-15, quelques heures après la livraison de ce geste.
     *
     * `only: ['app_workflow', 'mba']` ne protège que NOTRE colonne. L'appel à Meta, lui, transfère le fil
     * POUR DE VRAI. Un opérateur en train de répondre dans l'Inbox se faisait donc prendre le fil au message
     * suivant du client : l'écriture locale était bien refusée, mais Meta avait déjà basculé et l'agent
     * répondait par-dessus lui. Exactement ce que ce geste annonçait empêcher.
     *
     * ⚠️ CE CAS VÉRIFIE L'EFFET, pas la présence : aucun appel à Meta, et la colonne intacte.
     */
    const b = bancDuFil({ conversations: { w: { owner: 'app_human' } } });
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    expect(b.appels, 'un humain doit faire SORTIR avant l’appel Meta').toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('🔴 `only` contient app_workflow et mba, et surtout PAS app_human', async () => {
    /**
     * Les trois valeurs comptent, chacune pour une raison différente, et se tromper sur une seule rouvre un
     * des deux incidents ou en crée un troisième :
     *  - `app_workflow` est la valeur PAR DÉFAUT : sans elle, la conversation née d'un envoi sortant reste
     *    invisible (« À traiter » l'exclut) et muette. C'est l'incident 2.
     *  - `mba` : notre colonne peut dire `mba` quand Meta pense l'inverse. C'est l'incident 1.
     *  - `app_human` doit rester DEHORS : un opérateur qui travaille dans l'Inbox ne se fait pas doubler.
     */
    const b = bancDuFil({ conversations: { w: { owner: 'app_workflow' } } });
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    const seulement = b.ecritures[0]?.opts?.only;
    expect(seulement, 'la remise doit borner les états qu’elle écrase').toBeDefined();
    expect(seulement).toContain('app_workflow');
    expect(seulement).toContain('mba');
    expect(seulement, 'un humain sur la conversation ne doit JAMAIS être doublé').not.toContain('app_human');
  });
});
