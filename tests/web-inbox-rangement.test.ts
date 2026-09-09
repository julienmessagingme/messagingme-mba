import { describe, it, expect } from 'vitest';
import {
  destinationsEnLot, estActionRangement, libelleRangement,
  type ActionRangement, type DossierLike,
} from '../web/lib/inbox-rangement';

/**
 * Helper PUR du menu « Ranger dans... » de l'Inbox (web/lib/inbox-rangement.ts), testé depuis la suite
 * racine par import RELATIF (aucune dépendance React/Next).
 *
 * 🔴 CE QUE CES TESTS TIENNENT, ET QU'AUCUN AUTRE NE PEUT VOIR. Le menu de la SÉLECTION propose des
 * destinations déduites du dossier ouvert. Un menu qui les proposerait TOUTES, en permanence, passerait tous
 * les tests de route et tous les tests d'intégration : les appels partiraient, le serveur répondrait 200, et
 * l'écran ne changerait pas. Le défaut n'existe qu'ICI, dans le choix des options.
 */
const t = (fr: string) => fr;

describe('Inbox, les destinations proposées à une sélection', () => {
  it('depuis un dossier ordinaire, les trois destinations demandées par Julien', () => {
    expect(destinationsEnLot('toutes', false)).toEqual(['a-traiter', 'signaler', 'archiver']);
  });

  it('🔴 ne propose JAMAIS le dossier où l’on est déjà', () => {
    // La garde qui compte : sans elle, « À traiter » depuis « À traiter » et « Signalé » depuis « Signalé »
    // seraient des allers vers l'endroit où l'on se trouve. L'appel réussirait, rien ne bougerait.
    expect(destinationsEnLot('aTraiter', false)).not.toContain('a-traiter');
    expect(destinationsEnLot('signalees', true)).not.toContain('signaler');
    expect(destinationsEnLot('archivees', false)).not.toContain('archiver');
  });

  it('🔴 depuis « Archivé », SEUL « Désarchiver » est proposé', () => {
    // Marquer « Signalé » ou « À traiter » une conversation ARCHIVÉE écrit bien en base, mais les deux
    // dossiers concernés excluent les archivées : elle ne réapparaîtrait nulle part. Proposer le geste
    // reviendrait à promettre un effet qui n'arrive pas.
    expect(destinationsEnLot('archivees', false)).toEqual(['desarchiver']);
    expect(destinationsEnLot('archivees', true)).toEqual(['desarchiver']);
  });

  it('🔴 « Ne plus signaler » n’apparaît que si la sélection porte un signalement HUMAIN', () => {
    // Une conversation signalée par le MODÈLE ne se désignale pas à la main : le constat de l'analyse est
    // recalculé, pas effaçable. Proposer le geste ferait cliquer deux fois avant de conclure à une panne.
    expect(destinationsEnLot('signalees', false)).not.toContain('ne-plus-signaler');
    expect(destinationsEnLot('signalees', true)).toContain('ne-plus-signaler');
  });

  it('depuis « À traiter », on peut encore signaler et archiver', () => {
    expect(destinationsEnLot('aTraiter', false)).toEqual(['signaler', 'archiver']);
  });

  it('un dossier de collaborateur se comporte comme un dossier ordinaire', () => {
    // L'affectation est ORTHOGONALE au rangement : être dans le dossier de Marie n'interdit aucun geste.
    expect(destinationsEnLot({ membre: 'u1' }, false)).toEqual(['a-traiter', 'signaler', 'archiver']);
    expect(destinationsEnLot('nonAffectees', false)).toEqual(['a-traiter', 'signaler', 'archiver']);
  });

  it('aucune destination n’est proposée deux fois', () => {
    const dossiers: DossierLike[] = ['toutes', 'aTraiter', 'signalees', 'archivees', 'nonAffectees', { membre: 'u1' }];
    for (const d of dossiers) {
      for (const manuel of [false, true]) {
        const dest = destinationsEnLot(d, manuel);
        expect(new Set(dest).size).toBe(dest.length);
      }
    }
  });
});

describe('Inbox, le vocabulaire du rangement', () => {
  it('🔴 une valeur inconnue n’est PAS un geste', () => {
    // Le trou que ce garde ferme : le menu terminait par `archiver(action === 'archiver')`, donc TOUTE
    // valeur inattendue DÉSARCHIVAIT en silence. Le titre du menu (chaîne vide) doit aussi être refusé.
    expect(estActionRangement('')).toBe(false);
    expect(estActionRangement('supprimer')).toBe(false);
    expect(estActionRangement('Archiver')).toBe(false);
  });

  it('les cinq gestes sont reconnus, et chacun a un libellé non vide', () => {
    const actions: ActionRangement[] = ['a-traiter', 'signaler', 'ne-plus-signaler', 'archiver', 'desarchiver'];
    for (const a of actions) {
      expect(estActionRangement(a)).toBe(true);
      expect(libelleRangement(a, t)).not.toBe('');
    }
    // Deux gestes ne partagent jamais un libellé : « Signalé » et « Ne plus signaler » sont proposés au même
    // endroit, les confondre rendrait le menu illisible.
    expect(new Set(actions.map((a) => libelleRangement(a, t))).size).toBe(actions.length);
  });
});
