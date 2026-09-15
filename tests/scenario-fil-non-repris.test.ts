import { jamaisDesabonne } from './consentement';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * UN SCÉNARIO NE DÉMARRE PAS SUR UN FIL QU'ON N'A PAS PU REPRENDRE.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, ET CE QUE ÇA A COÛTÉ DE NE PAS L'AVOIR. Julien, le 2026-09-14 : une campagne
 * « test4 » avec un scénario attaché, et « le MBA s'est déclenché, la règle n'a pas été respectée ». Mesuré
 * en production, minute par minute : template parti à 16:47:47 et scénario `waiting` ; le contact répond à
 * 16:48:14 ; le parcours n'avance PAS (`updated_at` resté égal à `created_at`, zéro ligne dans
 * `workflow_advance_failures`) ; l'agent de Meta répond à sa place à 16:48:24 ; il rend la main à 16:48:25
 * avec le motif `business_missing_info`. Dix secondes trop tard, et le parcours n'est jamais reparti.
 *
 * 🔴 LA CAUSE : `reclaimControl` n'écrivait QUE notre colonne `control_owner`. Chez Meta, l'agent est le
 * répondeur PRIMAIRE du numéro : tant qu'on ne lui a pas pris le fil par `thread_control`, il reçoit la
 * réponse du contact et répond, quoi que dise notre base. Le geste `take` existait pourtant, posé le
 * 2026-09-11 sur le BOUTON « Reprendre la main » de l'Inbox, et sur lui seul. C'est le motif « une capacité
 * câblée sur un consommateur sur deux », déjà payé plusieurs fois dans ce dépôt.
 *
 * ⚠️ ET LE DÉMARRAGE IGNORAIT LE RÉSULTAT DE LA REPRISE. `reclaimControl` rendait `void`, donc un échec était
 * indiscernable d'un succès : le parcours démarrait quand même et se faisait geler à la première réponse. Un
 * démarrage qu'on sait condamné doit échouer TOUT DE SUITE, avec sa raison.
 */

const graphe: WorkflowGraph = {
  nodes: [{ id: 'a', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Voici votre code : PROMO10' } }],
  edges: [],
};

/** `reclaim` décide du sort de la reprise : `false` = Meta a refusé, `true` = pris, `undefined` = câblage muet. */
function monter(reclaim: boolean | void) {
  const envois: string[] = [];
  const demarrages: string[] = [];
  const deps: WorkflowExecutorDeps = {
    estDesabonne: jamaisDesabonne,
    runs: {
      start: async () => { demarrages.push('r1'); return { id: 'r1' }; },
      findWaitingByWaId: async () => null,
      setState: async () => {},
      closeActiveByWaId: async () => [],
    },
    getGraph: async () => graphe,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async (_t, _w, texte) => { envois.push(texte); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    // Le fil appartient à l'agent de Meta : c'est tout le sujet.
    mayAct: async () => false,
    reclaimControl: async () => reclaim,
  };
  return { ex: new WorkflowExecutor(deps), envois, demarrages };
}

describe('un scénario ne démarre pas sur un fil que Meta a refusé de rendre', () => {
  it('🔴 REFUS : rien ne démarre, rien ne part, et la raison est rendue', async () => {
    const { ex, envois, demarrages } = monter(false);
    const issue = await ex.startInWindow('t1', 'wf1', graphe, { waId: '33600000000', contactId: null },
      { ignoreHumanControl: true });

    // La raison remonte en clair : c'est elle qui atterrit dans `campaign_recipients.error`, le seul
    // endroit où quelqu'un ira la lire.
    expect(typeof issue).toBe('string');
    expect(String(issue)).toContain('agent de Meta');
    // 🔴 ET SURTOUT : rien n'est parti et aucun run n'existe. Un run créé ici serait un parcours mort,
    // gelé dès la première réponse du contact, exactement le défaut du 2026-09-14.
    expect(demarrages).toEqual([]);
    expect(envois).toEqual([]);
  });

  it('REPRISE RÉUSSIE : le scénario part normalement', async () => {
    const { ex, envois } = monter(true);
    expect(await ex.startInWindow('t1', 'wf1', graphe, { waId: '33600000000', contactId: null },
      { ignoreHumanControl: true })).toBe(true);
    // ⚠️ L'observable est l'ENVOI, pas la création d'un run : ce graphe d'un seul bloc se termine sans
    // attendre, donc il ne persiste aucun run. C'est ce qui distingue « parti » de « non parti ».
    expect(envois).toEqual(['Voici votre code : PROMO10']);
  });

  it('CÂBLAGE MUET (`void`) : comportement historique, le scénario part', async () => {
    // ⚠️ Les tests et l'e2e câblent un `reclaimControl` qui ne rend rien. Le traiter comme un refus
    // casserait toute la suite sans qu'aucun défaut réel n'existe : seul `false` arrête.
    const { ex, envois } = monter(undefined);
    expect(await ex.startInWindow('t1', 'wf1', graphe, { waId: '33600000000', contactId: null },
      { ignoreHumanControl: true })).toBe(true);
    expect(envois).toEqual(['Voici votre code : PROMO10']);
  });
});

/**
 * 🔴 LA GARDE QUE LE FAUX CÂBLAGE NE PEUT PAS DONNER. Les trois cas ci-dessus montent un `reclaimControl`
 * de test : ils prouvent que l'exécuteur RÉAGIT au verdict, jamais que le vrai câblage prend réellement le
 * fil chez Meta. Or c'est exactement ce qui manquait, et un test unitaire ne l'aurait jamais vu, « parce
 * qu'un faux câblage bouge avec le code ». On lit donc le câblage réel.
 */
describe('le vrai câblage prend le fil CHEZ META avant d’écrire chez nous', () => {
  const wiring = readFileSync(resolve(__dirname, '../src/workflow/wiring.ts'), 'utf8');
  /**
   * ⚠️ LE GESTE A ÉTÉ EXTRAIT le 2026-09-14 : il a désormais DEUX consommateurs (le démarrage d'un
   * parcours, et le devenir « la conversation arrive dans l'Inbox » d'un étage de campagne). Ces gardes
   * lisent donc le geste lui-même, plus le bloc `reclaimControl` qui s'y délègue. Le cas exercé est
   * inchangé : Meta d'abord, notre colonne ensuite, et rien d'écrit chez nous si Meta refuse.
   */
  const bloc = wiring.slice(wiring.indexOf('const reprendreLeFilPourLApp'), wiring.indexOf('Envoi réel du bloc'));
  /**
   * ⚠️ LA PRISE DU FIL EST PASSÉE DANS UNE FONCTION D'AIDE le 2026-09-14 (le rejeu unique sur un échec
   * transitoire, relevé en revue). Ces gardes lisaient `takeThreadChezMeta` DANS le bloc `reclaimControl` ;
   * elles suivent maintenant l'indirection au lieu d'être affaiblies, sinon elles ne vérifieraient plus
   * rien tout en restant vertes. Le cas exercé est inchangé : Meta d'abord, notre colonne ensuite, et rien
   * d'écrit chez nous si Meta refuse.
   */
  const aide = wiring.slice(wiring.indexOf('const prendreLeFilAvecUnRejeu'), wiring.indexOf('const reprendreLeFilPourLApp'));

  it('appelle bien Meta', () => {
    expect(bloc).toContain('prendreLeFilAvecUnRejeu');
    // ⚠️ Le REJEU a été extrait dans `src/inbox/controle-du-fil.ts` le 2026-09-15 : le câblage ne nomme donc
    // plus une prise intermédiaire, il passe la VRAIE prise du fil au module qui rejoue. Cette garde suit
    // l'indirection au lieu d'être affaiblie, sinon elle ne vérifierait plus rien tout en restant verte.
    expect(aide).toContain('creerPrendreLeFilAvecUnRejeu');
    expect(aide, 'le rejeu doit recevoir la VRAIE prise du fil chez Meta').toContain('creerPrendreLeFil({');
  });

  it('🔴 appelle Meta AVANT d’écrire notre colonne', () => {
    // L'ordre inverse produirait le pire des deux mondes : le scénario se croirait maître et répondrait
    // PAR-DESSUS l'agent de Meta, donc deux messages au contact.
    expect(bloc.indexOf('prendreLeFilAvecUnRejeu')).toBeLessThan(bloc.indexOf('setControlOwner'));
  });

  it('🔴 n’écrit PAS notre colonne quand Meta refuse', () => {
    // Le `return false` doit précéder l'écriture locale : c'est la doctrine de `controle-du-fil.ts`,
    // « un état local qui annonce ce que Meta n'a pas fait ».
    expect(bloc.indexOf('return false')).toBeLessThan(bloc.indexOf('setControlOwner'));
  });

  it('🔴 le démarrage de parcours DÉLÈGUE au geste partagé, il ne le réimplémente pas', () => {
    // Deux exemplaires de cette prise de fil divergeraient : c'est le motif qui a cassé la production le
    // 2026-08-15 (constructeur de composants Meta, préparation des visuels de carousel).
    expect(wiring).toContain('reclaimControl: reprendreLeFilPourLApp,');
  });

  /**
   * ⚠️ UN CAS A ÉTÉ RETIRÉ ICI, ET SON REMPLAÇANT EST NOMMÉ (lot du 2026-09-15).
   *
   * Il s'appelait « rejoue UNE fois un échec transitoire, et jamais un refus définitif » et il cherchait les
   * chaînes `err.retryable` et `tentative < 2` dans le TEXTE de `wiring.ts`. Il prouvait donc qu'un motif
   * était ÉCRIT : ni qu'on rejoue une fois, ni qu'on ne rejoue pas un refus définitif, ni combien on attend.
   *
   * Le rejeu vit désormais dans `src/inbox/controle-du-fil.ts`, avec ses vraies dépendances injectées, et
   * `tests/controle-du-fil-cablage.test.ts` l'EXERCE : un seul appel du premier coup, un rejeu qui réussit au
   * second, deux appels au maximum, aucun rejeu sur un refus définitif, l'attente qui vaut le `Retry-After`
   * de Meta plafonné à 2 s, et le contrat « aucun numéro connecté » qui était implicite.
   */
});
