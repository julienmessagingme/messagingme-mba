import { describe, it, expect } from 'vitest';
import { horairesExploitables, mesureurDeTempsOuvre, tempsOuvre } from '../src/lib/heures-ouvrees';
import type { BusinessHours } from '../src/workflow/conditions';

/**
 * LE TEMPS OUVRÉ ENTRE DEUX INSTANTS, la mesure du Quantitatif > Performance.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : un chiffre qui se trompe ne se voit pas, il se CROIT. Une équipe jugée sur ses
 * nuits et ses week-ends paraîtrait lente de soixante heures chaque lundi ; une heure de trop au changement
 * d'heure fausserait tous les temps d'un dimanche. Chaque cas se lit en heures murales de Paris.
 */
const TZ = 'Europe/Paris';
const MIN = 60_000;
const H = 60 * MIN;
const jour = (open: string, close: string) => ({ closed: false, open, close });
const FERME = { closed: true, open: '09:00', close: '18:00' };

/** Lundi au vendredi 9 h - 18 h, week-end fermé. */
const SEMAINE: BusinessHours = {
  '0': FERME, '6': FERME,
  '1': jour('09:00', '18:00'), '2': jour('09:00', '18:00'), '3': jour('09:00', '18:00'),
  '4': jour('09:00', '18:00'), '5': jour('09:00', '18:00'),
};

/** Un instant lu à Paris : `paris('2026-09-08 17:30')`. Septembre est en heure d'été (UTC+2). */
const paris = (mural: string, decalage = '+02:00'): Date => new Date(`${mural.replace(' ', 'T')}:00${decalage}`);

describe('tempsOuvre', () => {
  it('dans la journée : le temps écoulé tel quel', () => {
    expect(tempsOuvre(paris('2026-09-08 10:00'), paris('2026-09-08 10:25'), TZ, SEMAINE)).toBe(25 * MIN);
  });

  it('🔴 la NUIT ne compte pas : mardi 17 h 30 -> mercredi 9 h 15 = 45 minutes', () => {
    expect(tempsOuvre(paris('2026-09-08 17:30'), paris('2026-09-09 09:15'), TZ, SEMAINE)).toBe(45 * MIN);
  });

  it('🔴 le WEEK-END ne compte pas : vendredi 17 h -> lundi 10 h = 2 heures', () => {
    expect(tempsOuvre(paris('2026-09-11 17:00'), paris('2026-09-14 10:00'), TZ, SEMAINE)).toBe(2 * H);
  });

  it('une demande arrivée ET répondue hors des heures d’ouverture a attendu zéro', () => {
    // C'est le vrai temps d'équipe : personne n'était censé répondre. L'écran annonce qu'il compte ainsi.
    expect(tempsOuvre(paris('2026-09-12 10:00'), paris('2026-09-12 16:00'), TZ, SEMAINE)).toBe(0);
  });

  it('🔴 un jour FERMÉ au milieu de la semaine est sauté', () => {
    const sansMercredi: BusinessHours = { ...SEMAINE, '3': FERME };
    // Mardi 17 h -> jeudi 10 h : une heure mardi, rien mercredi, une heure jeudi.
    expect(tempsOuvre(paris('2026-09-08 17:00'), paris('2026-09-10 10:00'), TZ, sansMercredi)).toBe(2 * H);
  });

  it('🔴 le changement d’heure d’AUTOMNE : la nuit de 25 heures garde ses vraies heures ouvertes', () => {
    // Ouvert tous les jours de 0 h à 23 h 59. Du samedi 24 octobre midi au dimanche 25 midi (le 25, 3 h redevient
    // 2 h) : 25 heures se sont écoulées, et seule la minute 23 h 59 -> minuit est fermée. Une arithmétique en
    // « + 24 h » rendrait une heure de moins, ou compterait deux fois la même.
    const toujours: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, jour('00:00', '23:59')]));
    const debut = paris('2026-10-24 12:00');
    const fin = paris('2026-10-25 12:00', '+01:00');
    expect(fin.getTime() - debut.getTime()).toBe(25 * H);
    expect(tempsOuvre(debut, fin, TZ, toujours)).toBe(25 * H - MIN);
  });

  it('🔴 le changement d’heure de PRINTEMPS : la nuit de 23 heures', () => {
    const toujours: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, jour('00:00', '23:59')]));
    const debut = paris('2026-03-28 12:00', '+01:00');
    const fin = paris('2026-03-29 12:00');
    expect(tempsOuvre(debut, fin, TZ, toujours)).toBe(23 * H - MIN);
  });

  it('au changement d’heure, un créneau de jour ouvré reste de neuf heures', () => {
    // Le lundi qui suit (26 octobre) : ouvert 9 h - 18 h en heure d'hiver.
    expect(tempsOuvre(paris('2026-10-23 17:00'), paris('2026-10-26 18:00', '+01:00'), TZ, SEMAINE)).toBe(10 * H);
  });

  it('🔴 et l’ouverture du lundi est à 9 h en heure d’HIVER, pas à 9 h de l’heure d’été du vendredi', () => {
    // Vendredi 17 h 30 (été) -> lundi 9 h 30 (hiver) : une demi-heure chaque jour. Une ouverture calculée en
    // « vendredi 9 h + 72 h » tomberait lundi à 8 h, et compterait une heure et demie le lundi.
    expect(tempsOuvre(paris('2026-10-23 17:30'), paris('2026-10-26 09:30', '+01:00'), TZ, SEMAINE)).toBe(H);
  });

  it('🔴 horaires ABSENTS, ou aucun créneau exploitable : le temps BRUT, que l’écran annonce', () => {
    const debut = paris('2026-09-11 17:00');
    const fin = paris('2026-09-14 10:00');
    expect(tempsOuvre(debut, fin, TZ, null)).toBe(fin.getTime() - debut.getTime());
    const toutFerme: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, FERME]));
    expect(tempsOuvre(debut, fin, TZ, toutFerme)).toBe(fin.getTime() - debut.getTime());
    const malSaisi: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, jour('18:00', '09:00')]));
    expect(tempsOuvre(debut, fin, TZ, malSaisi)).toBe(fin.getTime() - debut.getTime());
    expect(horairesExploitables(TZ, null)).toBe(false);
    expect(horairesExploitables(TZ, toutFerme)).toBe(false);
    expect(horairesExploitables(TZ, malSaisi)).toBe(false);
    expect(horairesExploitables(TZ, SEMAINE)).toBe(true);
  });

  it('une fin antérieure au début, ou un instant invalide : zéro, jamais une durée négative', () => {
    expect(tempsOuvre(paris('2026-09-08 11:00'), paris('2026-09-08 10:00'), TZ, SEMAINE)).toBe(0);
    expect(tempsOuvre(paris('2026-09-08 11:00'), paris('2026-09-08 10:00'), TZ, null)).toBe(0);
    expect(tempsOuvre(new Date(Number.NaN), paris('2026-09-08 10:00'), TZ, SEMAINE)).toBe(0);
  });

  it('le mesureur d’un espace rend exactement ce que rend la fonction, appel après appel', () => {
    const mesurer = mesureurDeTempsOuvre(TZ, SEMAINE);
    const cas: Array<[Date, Date]> = [
      [paris('2026-09-08 17:30'), paris('2026-09-09 09:15')],
      [paris('2026-09-11 17:00'), paris('2026-09-14 10:00')],
      [paris('2026-09-08 17:30'), paris('2026-09-09 09:15')],
    ];
    for (const [d, f] of cas) expect(mesurer(d, f)).toBe(tempsOuvre(d, f, TZ, SEMAINE));
  });
});
