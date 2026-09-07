import { describe, it, expect } from 'vitest';
import { compterParLien } from '../src/channels-me/conversions';

/**
 * Ce que ce compteur promet, et ce qu'il ne promet pas.
 *
 * 🔴 IL NE COMPTE NI DES CLICS NI DES CONVERSATIONS DEMARREES. Un appui sur un lien `wa.me` ouvre WhatsApp
 * sur le telephone de l'abonne sans traverser nos serveurs : ce geste nous est invisible. Et un message
 * recu n'a pas forcement demarre quoi que ce soit, parce que le moteur applique trois filtres de plus que
 * la correspondance du mot-cle (automation allumee, anti-rebond, plafond horaire). Ce qui est compte, c'est
 * exactement ce qui est observe : des PERSONNES qui ont envoye le message du bouton. Ces tests figent la
 * difference pour que personne ne rebaptise la fonction en chemin.
 */
const M = (waId: string, body: string) => ({ waId, body });

describe('compterParLien', () => {
  const LIENS = [{ id: 'l1', phrase: 'Je veux le guide' }];

  it('compte des CONTACTS distincts, pas des messages', () => {
    // Un abonne qui envoie trois fois le message est UNE personne. Compter les messages ferait passer un
    // bouton pour un succes alors qu il n a touche qu une personne.
    const r = compterParLien(LIENS, [
      M('33600000001', 'Je veux le guide'),
      M('33600000001', 'Je veux le guide'),
      M('33600000002', 'Je veux le guide'),
    ]);
    expect(r).toEqual([{ linkId: 'l1', contacts: 2 }]);
  });

  it('🔴 les POSTS DEJA PUBLIES comptent encore : leur texte porte la phrase ET l ancien jeton', () => {
    // Avant le 2026-09-07 le texte pre-rempli valait `phrase (cm-xxxx)`. Ces posts circulent pour toujours
    // et ne peuvent plus etre modifies. Un comptage en egalite stricte les aurait effaces des chiffres du
    // jour au lendemain, exactement comme un declenchement en `equals` aurait tue leurs boutons.
    const r = compterParLien(LIENS, [M('33600000001', 'Je veux le guide (cm-a7k2m9p3)')]);
    expect(r[0]!.contacts).toBe(1);
  });

  it('🔴 la comparaison est celle qui DECLENCHE : accents, casse et espaces ignores', () => {
    // C est tout l interet de compter en JS avec `normalizeText` plutot qu en SQL : `lower()` n enleve pas
    // les accents, et un compteur qui compte autrement que ce qui declenche est pire que pas de compteur.
    const liens = [{ id: 'l1', phrase: 'Réserver ma place' }];
    const r = compterParLien(liens, [
      M('33600000001', 'reserver ma place'),
      M('33600000002', 'RÉSERVER   MA   PLACE svp'),
    ]);
    expect(r[0]!.contacts).toBe(2);
  });

  it('preuve inverse : un message qui ne contient pas la phrase ne compte pas', () => {
    // Sans ce sens-la, une fonction qui rendrait tout le trafic passerait les tests precedents.
    const r = compterParLien(LIENS, [
      M('33600000001', 'Bonjour, vous etes ouverts demain ?'),
      M('33600000002', 'je veux le guid'),
    ]);
    expect(r).toEqual([{ linkId: 'l1', contacts: 0 }]);
  });

  it('🔴 une phrase VIDE ne compte rien, au lieu de tout compter', () => {
    // `''.includes` est vrai partout : sans cette garde, un lien a la phrase vide afficherait l integralite
    // du trafic entrant du client comme etant le sien.
    const r = compterParLien([{ id: 'l1', phrase: '   ' }], [M('33600000001', 'bonjour')]);
    expect(r[0]!.contacts).toBe(0);
  });

  it('chaque lien a son propre compte, et un lien sans correspondance rend zero (pas d absence)', () => {
    // Un lien absent de la reponse forcerait l ecran a deviner entre « zero » et « pas mesure ».
    const r = compterParLien(
      [{ id: 'l1', phrase: 'Je veux le guide' }, { id: 'l2', phrase: 'Je veux un rendez-vous' }],
      [M('33600000001', 'Je veux un rendez-vous')],
    );
    expect(r).toEqual([
      { linkId: 'l1', contacts: 0 },
      { linkId: 'l2', contacts: 1 },
    ]);
  });

  it('aucun message -> chaque lien rend zero', () => {
    expect(compterParLien(LIENS, [])).toEqual([{ linkId: 'l1', contacts: 0 }]);
  });
});
