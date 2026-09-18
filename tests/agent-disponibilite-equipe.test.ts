import { describe, it, expect } from 'vitest';
import {
  disponibiliteEquipe, reouvertureEnClair, MODES_TRANSFERT, MODE_TRANSFERT_DEFAUT,
} from '../src/agent/disponibilite-equipe';
import type { BusinessHours } from '../src/workflow/conditions';

/**
 * L'ÉQUIPE EST-ELLE JOIGNABLE QUAND L'AGENT PASSE LA MAIN ? (lot 1 du plan du 2026-09-18)
 *
 * 🔴 CE QUE CES TESTS GARDENT. Un agent qui transfère hors horaires ne doit pas laisser croire qu'un
 * conseiller arrive, et la date qu'il annonce doit être VRAIE. Julien, 2026-09-18 : « un client qui nous
 * contacte un samedi alors que c'est fermé tout le week-end, faut pas lui dire on vous contacte demain à 9h
 * mais on vous contacte lundi à 9h ».
 *
 * ⚠️ Les dates sont écrites en heure de PARIS via un décalage explicite, jamais en heure locale de la
 * machine : un test qui dépend du fuseau de celui qui le lance passe chez moi et casse en CI.
 */

/** Ouvert du lundi au vendredi, 9 h - 18 h. Fermé le samedi et le dimanche. */
const SEMAINE: BusinessHours = {
  0: { closed: true, open: '09:00', close: '18:00' },
  1: { closed: false, open: '09:00', close: '18:00' },
  2: { closed: false, open: '09:00', close: '18:00' },
  3: { closed: false, open: '09:00', close: '18:00' },
  4: { closed: false, open: '09:00', close: '18:00' },
  5: { closed: false, open: '09:00', close: '18:00' },
  6: { closed: true, open: '09:00', close: '18:00' },
} as unknown as BusinessHours;

const TZ = 'Europe/Paris';
/** Samedi 20 septembre 2026, 15 h à Paris (UTC+2 en septembre). */
const SAMEDI_APREM = new Date('2026-09-20T13:00:00Z');
/** Mardi 22 septembre 2026, 10 h à Paris : en plein créneau. */
const MARDI_MATIN = new Date('2026-09-22T08:00:00Z');
/** Mardi 22 septembre 2026, 23 h à Paris : fermé, mais le lendemain est ouvert. */
const MARDI_NUIT = new Date('2026-09-22T21:00:00Z');

describe('disponibiliteEquipe', () => {
  it('`always` : l’équipe est toujours joignable, les horaires ne sont même pas lus', () => {
    // Le défaut d'usine, donc le comportement de TOUS les espaces qui n'ont rien réglé : il ne doit pas
    // bouger d'un pouce le jour où ce code arrive en production.
    expect(disponibiliteEquipe('always', SAMEDI_APREM, TZ, null)).toEqual({ disponible: true, reouverture: null });
    expect(disponibiliteEquipe('always', SAMEDI_APREM, TZ, SEMAINE)).toEqual({ disponible: true, reouverture: null });
  });

  it('🔴 `never` : indisponible, et SANS date, parce qu’il n’y a rien à promettre', () => {
    // Le commentaire de la migration 0067 l'avait déjà écrit pour le MBA : « never s'accompagne toujours
    // d'un message qui ne promet aucun conseiller ». Rendre une date ici ferait annoncer un retour que
    // personne n'a prévu.
    expect(disponibiliteEquipe('never', MARDI_MATIN, TZ, SEMAINE)).toEqual({ disponible: false, reouverture: null });
  });

  it('`business_hours` : joignable pendant le créneau', () => {
    expect(disponibiliteEquipe('business_hours', MARDI_MATIN, TZ, SEMAINE))
      .toEqual({ disponible: true, reouverture: null });
  });

  it('🔴 un SAMEDI, la réouverture est le LUNDI, pas « demain »', () => {
    // C'est le cas que Julien a nommé, et celui qu'un modèle qui calculerait lui-même raterait.
    const r = disponibiliteEquipe('business_hours', SAMEDI_APREM, TZ, SEMAINE);
    expect(r.disponible).toBe(false);
    expect(reouvertureEnClair(r.reouverture!, TZ)).toBe('lundi 21 septembre à 9 h');
  });

  it('la nuit d’un jour ouvré, la réouverture est le lendemain matin', () => {
    const r = disponibiliteEquipe('business_hours', MARDI_NUIT, TZ, SEMAINE);
    expect(r.disponible).toBe(false);
    expect(reouvertureEnClair(r.reouverture!, TZ)).toBe('mercredi 23 septembre à 9 h');
  });

  /**
   * 🔴 LE CAS QUI SE PÈSE DANS LES DEUX SENS. Un espace qui demande « seulement aux heures ouvrées » sans
   * jamais déclarer ses horaires ne nous a pas dit quand il répond. Le traiter comme `always` ferait
   * promettre un conseiller à 3 h du matin, ce que le réglage existe pour empêcher ; le traiter comme une
   * indisponibilité sans date coûte une phrase moins précise, sur une conversation qui arrive de toute
   * façon dans « À traiter ».
   */
  it('🔴 sans horaires déclarés, `business_hours` bascule vers l’INDISPONIBILITÉ, jamais l’inverse', () => {
    expect(disponibiliteEquipe('business_hours', MARDI_MATIN, TZ, null))
      .toEqual({ disponible: false, reouverture: null });
  });

  it('⚠️ une semaine entièrement fermée est indisponible SANS date, pas indisponible pour toujours à une date inventée', () => {
    const ferme = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((j) => [j, { closed: true, open: '09:00', close: '18:00' }])) as unknown as BusinessHours;
    expect(disponibiliteEquipe('business_hours', MARDI_MATIN, TZ, ferme))
      .toEqual({ disponible: false, reouverture: null });
  });

  it('le vocabulaire est celui du MBA, et le défaut est le sien', () => {
    // Deux réglages voisins avec deux vocabulaires différents seraient impossibles à rapprocher sur un écran
    // où les deux agents cohabitent.
    expect([...MODES_TRANSFERT]).toEqual(['always', 'business_hours', 'never']);
    expect(MODE_TRANSFERT_DEFAUT).toBe('always');
  });
});

describe('reouvertureEnClair', () => {
  it('rend une date FRANÇAISE dans le fuseau de l’espace, prête à être lue', () => {
    expect(reouvertureEnClair(new Date('2026-09-21T07:00:00Z'), TZ)).toBe('lundi 21 septembre à 9 h');
  });

  it('les minutes n’apparaissent que si elles comptent', () => {
    // « à 9 h » et pas « à 9 h 00 » : c'est une phrase envoyée à un contact sur WhatsApp, pas un horaire de train.
    expect(reouvertureEnClair(new Date('2026-09-21T06:30:00Z'), TZ)).toBe('lundi 21 septembre à 8 h 30');
  });

  it('🔴 le FUSEAU décide, pas la machine qui exécute', () => {
    // Le même instant, lu à Paris et à New York, n'est pas le même jour : un test qui passerait en heure
    // locale serait vert chez moi et faux pour un client.
    const instant = new Date('2026-09-21T01:00:00Z');
    expect(reouvertureEnClair(instant, TZ)).toContain('lundi 21 septembre');
    expect(reouvertureEnClair(instant, 'America/New_York')).toContain('dimanche 20 septembre');
  });
});
