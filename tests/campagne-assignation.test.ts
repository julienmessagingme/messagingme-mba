import { describe, expect, it } from 'vitest';
import { assignerReponse, devenirEffectif, prochainAssigne } from '../src/inbox/assignation-campagne';
import type { CampagneAssignante } from '../src/inbox/assignation-campagne';

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
   * 🔴 UN RANG NÉGATIF NE DOIT PAS SORTIR DU TABLEAU NON PLUS. `%` garde en JavaScript le SIGNE de son
   * opérande gauche, donc `-1 % 3` vaut `-1` et `membres[-1]` vaut `undefined` : la conversation
   * tomberait dans « À traiter » sans que rien ne le dise.
   *
   * ⚠️ PLUS AUCUN APPELANT NE PRODUIT DE RANG NÉGATIF depuis que `prendreUnRangDeTourDeRole` rend la
   * valeur nouvelle au lieu de reconstruire l'ancienne par soustraction. Ce cas garde donc une fonction
   * EXPORTÉE honnête sur son propre domaine, il ne décrit plus un chemin vivant. Le dire évite de croire
   * qu'il protège d'un défaut réel, et évite de le retirer en croyant qu'il n'a jamais servi.
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
    campagne?: CampagneAssignante | null;
    prendLeFil?: boolean;
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
    const f = faux({ campagne: { campaignId: 'c1', devenir: null, assignation: 'personne', assignationUserId: 'u-fixe' } });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBe('u-fixe');
    expect(f.journal.assignations).toEqual([['33600000001', 'u-fixe']]);
    // 🔴 UNE ASSIGNATION FIXE NE FAIT PAS TOURNER LE ROULEMENT. Consommer un rang ici décalerait le tour
    // de rôle d'une AUTRE campagne du même espace ? Non : le rang est par campagne. Mais il décalerait
    // celui de CETTE campagne si elle repassait un jour en tour de rôle, et surtout il ferait payer un
    // tour à une répartition qui n'en demande pas.
    expect(f.journal.rangsPris).toEqual([]);
  });

  it('sur un tour de role, prend un rang et suit le roulement', async () => {
    const f = faux({ campagne: { campaignId: 'c1', devenir: null, assignation: 'tour_de_role', assignationUserId: null }, rang: 1 });
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
    const f = faux({ campagne: { campaignId: 'c1', devenir: null, assignation: 'tour_de_role', assignationUserId: null }, membres: [] });
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
    const f = faux({ campagne: { campaignId: 'c1', devenir: null, assignation: 'personne', assignationUserId: null } });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
    expect(f.journal.assignations).toEqual([]);
  });

  /**
   * ⚠️ L'ÉCRITURE PEUT ÉCHOUER SANS LEVER : `setAssigneeByWaId` rend `false` quand la conversation est
   * déjà assignée, ou quand le membre n'est plus de cet espace. On rend alors `null`, c'est-à-dire « la
   * conversation n'a pas été assignée », plutôt que le nom de quelqu'un qui ne l'a pas reçue.
   */
  it('une ecriture refusee rend null, pas un faux succes', async () => {
    const f = faux({ campagne: { campaignId: 'c1', devenir: null, assignation: 'tour_de_role', assignationUserId: null }, assigne: false });
    expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
  });
});

/**
 * CE QUI SE PASSE QUAND LE CONTACT RÉPOND, ÉTAGE PAR ÉTAGE (migration 0144).
 *
 * 🔴 LE CHOIX DE L'OPÉRATEUR EST EXCLUSIF, ET C'EST TOUTE LA RÈGLE. Julien, le 2026-09-14 : « si le user
 * répond "la conversation arrive dans l'Inbox", eh bien ça arrive dans l'Inbox, et s'il répond "l'agent IA
 * prend la main", eh bien l'agent IA prend la main ». Avant ce lot, deux des trois réponses ne quittaient
 * pas le navigateur.
 */
describe('le devenir d’un étage décide qui répond', () => {
  const campagne = (sur: Partial<CampagneAssignante> = {}): CampagneAssignante => ({
    campaignId: 'c1', devenir: null, assignation: null, assignationUserId: null, ...sur,
  });

  describe('devenirEffectif (pur)', () => {
    it('« MBA » ne prend le fil à personne : c’est lui le répondeur du numéro', () => {
      expect(devenirEffectif(campagne({ devenir: 'mba' }))).toEqual({ devenir: 'mba', prendreLeFil: false });
    });

    it('🔴 « Inbox » PREND le fil : un humain reprend, pas un robot qui a déjà répondu', () => {
      expect(devenirEffectif(campagne({ devenir: 'inbox', assignation: 'tour_de_role' })))
        .toEqual({ devenir: 'inbox', prendreLeFil: true });
    });

    it('🔴 une campagne D’AVANT ne prend JAMAIS le fil, et garde son comportement', () => {
      // Sans reprise de données, `devenir` vaut null sur les campagnes existantes. Leur faire prendre le
      // fil aujourd'hui changerait, après coup, ce qui se passe sur des conversations déjà en cours.
      expect(devenirEffectif(campagne({ assignation: 'tour_de_role' })))
        .toEqual({ devenir: 'inbox', prendreLeFil: false });
      expect(devenirEffectif(campagne())).toEqual({ devenir: 'mba', prendreLeFil: false });
    });
  });

  describe('application', () => {
    const monter = (c: CampagneAssignante, opts: { filPris?: boolean } = {}) => {
      const journal = { filsPris: [] as string[], assignations: [] as Array<[string, string]> };
      const deps = {
        campagneDeLaReponse: async () => c,
        membres: async () => ['a', 'b', 'c'],
        prendreUnRang: async () => 1,
        assigner: async (_t: string, waId: string, userId: string) => { journal.assignations.push([waId, userId]); return true; },
        prendreLeFil: async (_t: string, waId: string) => { journal.filsPris.push(waId); return opts.filPris ?? true; },
      };
      return { deps, journal };
    };

    it('« MBA » : on ne touche à rien du tout', async () => {
      const f = monter(campagne({ devenir: 'mba' }));
      expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
      expect(f.journal.filsPris).toEqual([]);
      expect(f.journal.assignations).toEqual([]);
    });


    it('« Inbox » : le fil est pris, personne ne répond, la conversation est répartie', async () => {
      const f = monter(campagne({ devenir: 'inbox', assignation: 'tour_de_role' }));
      expect(await assignerReponse('t1', '33600000001', f.deps)).toBe('b');
      expect(f.journal.filsPris).toEqual(['33600000001']);
    });

    it('🔴 Meta refuse le fil : on n’applique RIEN, ni agent ni assignation', async () => {
      // Son agent répondra quoi qu'on fasse. Lancer le nôtre par-dessus ferait deux messages au contact ;
      // assigner ferait hériter un humain d'un échange qu'un robot a commencé sans qu'il le sache.
      const f = monter(campagne({ devenir: 'inbox', assignation: 'tour_de_role' }), { filPris: false });
      expect(await assignerReponse('t1', '33600000001', f.deps)).toBeNull();
      expect(f.journal.assignations).toEqual([]);
    });

  });
});
