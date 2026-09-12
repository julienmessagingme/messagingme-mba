import { describe, expect, it } from 'vitest';
import { assignerReponse, prochainAssigne } from '../src/inbox/assignation-campagne';

describe('prochainAssigne', () => {
  it('tourne sur les membres', () => {
    expect(prochainAssigne(['a', 'b', 'c'], 0)).toBe('a');
    expect(prochainAssigne(['a', 'b', 'c'], 1)).toBe('b');
    expect(prochainAssigne(['a', 'b', 'c'], 3)).toBe('a');
  });

  // ⚠️ Une equipe VIDE ne doit pas planter ni assigner a personne en silence : la conversation
  // tombe dans « À traiter », comme si aucune assignation n'avait été demandée.
  it('sans membre, rend null', () => {
    expect(prochainAssigne([], 0)).toBeNull();
  });

  // 🔴 Le rang peut depasser la taille de l equipe apres un depart de collaborateur.
  it('un rang plus grand que l equipe ne sort pas du tableau', () => {
    expect(prochainAssigne(['a', 'b'], 99)).toBe('b');
  });

  /**
   * 🔴 UN RANG NÉGATIF NE DOIT PAS SORTIR DU TABLEAU NON PLUS. Le rang vient d'un `returning
   * tour_de_role_rang - 1`, donc d'une soustraction : sur une colonne remise à zéro à la main, ou sur un
   * `smallint` qui aurait débordé, il peut être négatif. `%` de JavaScript garde le SIGNE de l'opérande
   * gauche, donc `-1 % 3` vaut `-1` et `membres[-1]` vaut `undefined` : la conversation tomberait dans
   * « À traiter » sans que rien ne le dise, exactement le cas que « sans membre » existe pour couvrir.
   */
  it('un rang negatif reste dans le tableau', () => {
    expect(prochainAssigne(['a', 'b', 'c'], -1)).toBe('c');
    expect(prochainAssigne(['a', 'b', 'c'], -4)).toBe('c');
  });
});

/**
 * L'ORCHESTRATION : qui reçoit la conversation quand une réponse arrive.
 *
 * 🔴 LE TOUR DE RÔLE SE JOUE À L'ARRIVÉE DE LA RÉPONSE, PAS AU LANCEMENT. Répartir cinq mille
 * conversations d'avance attribuerait des conversations qui n'existeront JAMAIS (la plupart des
 * destinataires ne répondent pas) et fausserait tous les compteurs de charge de l'équipe. Le rang vit
 * sur la campagne et avance quand une conversation devient réelle.
 */
describe('assignerReponse', () => {
  const faux = (sur: {
    campagne?: { campaignId: string; assignation: 'personne' | 'tour_de_role'; assignationUserId: string | null } | null;
    membres?: string[];
    rang?: number;
    assigne?: boolean;
  } = {}) => {
    const journal: { rangsPris: string[]; assignations: Array<[string, string]> } = { rangsPris: [], assignations: [] };
    const deps = {
      campagneDeLaReponse: async () => sur.campagne ?? null,
      membres: async () => sur.membres ?? ['a', 'b', 'c'],
      prendreUnRang: async (_t: string, campaignId: string) => { journal.rangsPris.push(campaignId); return sur.rang ?? 0; },
      assigner: async (_t: string, waId: string, userId: string) => {
        journal.assignations.push([waId, userId]);
        return sur.assigne ?? true;
      },
    };
    return { deps, journal };
  };

  it('assigne a la personne designee, sans consommer de rang', async () => {
    const f = faux({ campagne: { campaignId: 'c1', assignation: 'personne', assignationUserId: 'u-fixe' } });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBe('u-fixe');
    expect(f.journal.assignations).toEqual([['33600000001', 'u-fixe']]);
    // 🔴 UNE ASSIGNATION FIXE NE FAIT PAS TOURNER LE ROULEMENT. Consommer un rang ici décalerait le tour
    // de rôle d'une AUTRE campagne du même espace ? Non : le rang est par campagne. Mais il décalerait
    // celui de CETTE campagne si elle repassait un jour en tour de rôle, et surtout il ferait payer un
    // tour à une répartition qui n'en demande pas.
    expect(f.journal.rangsPris).toEqual([]);
  });

  it('sur un tour de role, prend un rang et suit le roulement', async () => {
    const f = faux({ campagne: { campaignId: 'c1', assignation: 'tour_de_role', assignationUserId: null }, rang: 1 });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBe('b');
    expect(f.journal.rangsPris).toEqual(['c1']);
  });

  /**
   * 🔴 AUCUNE CAMPAGNE ASSIGNANTE = AUCUNE ÉCRITURE, ET SURTOUT AUCUN RANG CONSOMMÉ. C'est le cas de
   * l'écrasante majorité des messages entrants de la console (une conversation ordinaire, une réponse à
   * un scénario). Prendre un rang ici ferait avancer le roulement d'une campagne à chaque message reçu
   * par l'espace, et la répartition n'aurait plus aucun rapport avec les réponses de la campagne.
   */
  it('sans campagne assignante, ne touche a rien', async () => {
    const f = faux({ campagne: null });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
    expect(f.journal.rangsPris).toEqual([]);
    expect(f.journal.assignations).toEqual([]);
  });

  // ⚠️ Une équipe VIDE (tous les comptes révoqués) ne doit rien assigner : la conversation tombe dans
  // « À traiter ». On ne consomme pas de rang non plus, puisque personne ne l'a reçu.
  it('sans membre, n assigne personne', async () => {
    const f = faux({ campagne: { campaignId: 'c1', assignation: 'tour_de_role', assignationUserId: null }, membres: [] });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
    expect(f.journal.assignations).toEqual([]);
  });

  /**
   * 🔴 `personne` SANS PERSONNE N'ASSIGNE PAS AU PREMIER VENU. La colonne est nullable et la personne
   * peut avoir quitté l'espace depuis (`on delete set null` de 0134) : retomber sur le tour de rôle
   * donnerait la conversation à quelqu'un que l'opérateur n'a pas choisi, sur une campagne qui affiche
   * « assignée à une personne ».
   */
  it('une personne designee qui a quitte l espace n assigne personne', async () => {
    const f = faux({ campagne: { campaignId: 'c1', assignation: 'personne', assignationUserId: null } });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
    expect(f.journal.assignations).toEqual([]);
  });

  /**
   * ⚠️ L'ÉCRITURE PEUT ÉCHOUER SANS LEVER : `setAssigneeByWaId` rend `false` quand la conversation est
   * déjà assignée, ou quand le membre n'est plus de cet espace. On rend alors `null`, c'est-à-dire « la
   * conversation n'a pas été assignée », plutôt que le nom de quelqu'un qui ne l'a pas reçue.
   */
  it('une ecriture refusee rend null, pas un faux succes', async () => {
    const f = faux({ campagne: { campaignId: 'c1', assignation: 'tour_de_role', assignationUserId: null }, assigne: false });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
  });
});
