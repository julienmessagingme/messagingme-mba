import { describe, it, expect } from 'vitest';
import { prochaineOuverture } from '../src/lib/heures-ouvrees';
import type { BusinessHours } from '../src/workflow/conditions';

/**
 * « Quand est le prochain créneau ouvert ? »
 *
 * 🔴 CE QUE CES CAS PROTÈGENT, et qui se trompe silencieusement : un envoi programmé au mauvais moment
 * n'échoue pas, il PART. Trois chemins dépendront de cette fonction (bloc Attente, envoi de campagne,
 * reprise d'une campagne coupée par la fermeture) ; une erreur ici les fait tous les trois envoyer la nuit,
 * ou jamais.
 */

const TZ = 'Europe/Paris';
const jour = (open: string, close: string) => ({ closed: false, open, close });
const FERME = { closed: true, open: '09:00', close: '18:00' };

/** Lundi au vendredi 9 h - 18 h, week-end fermé. */
const SEMAINE: BusinessHours = {
  '0': FERME, '6': FERME,
  '1': jour('09:00', '18:00'), '2': jour('09:00', '18:00'), '3': jour('09:00', '18:00'),
  '4': jour('09:00', '18:00'), '5': jour('09:00', '18:00'),
};

/** Lit l'instant rendu comme un humain le lirait à Paris : « 2026-09-09 09:00 ». */
const lire = (d: Date | null): string | null =>
  d === null ? null : new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(d);

describe('prochaineOuverture', () => {
  it('🔴 déjà ouvert -> rend l’instant TEL QUEL, il n’y a rien à attendre', () => {
    // C'est ce qui permet à l'appelant de programmer toujours pour l'instant rendu, sans distinguer les cas.
    const mardi14h = new Date('2026-09-08T12:00:00Z'); // 14 h à Paris
    expect(prochaineOuverture(mardi14h, TZ, SEMAINE)).toBe(mardi14h);
  });

  it('🔴 avant l’ouverture -> l’ouverture du JOUR MÊME', () => {
    // Le cas de Julien : « s'il est 01:00, le message ne s'envoie qu'à 9:00 ».
    const mardi1h = new Date('2026-09-07T23:00:00Z'); // 01 h mardi à Paris
    expect(lire(prochaineOuverture(mardi1h, TZ, SEMAINE))).toBe('2026-09-08 09:00');
  });

  it('🔴 après la fermeture -> l’ouverture du LENDEMAIN, pas celle d’aujourd’hui', () => {
    // Le piège du signe : l'ouverture du jour même est déjà passée. La prendre enverrait dans le passé,
    // c'est-à-dire tout de suite, c'est-à-dire la nuit.
    const mardi22h = new Date('2026-09-08T20:00:00Z'); // 22 h mardi à Paris
    expect(lire(prochaineOuverture(mardi22h, TZ, SEMAINE))).toBe('2026-09-09 09:00');
  });

  it('🔴 un jour FERMÉ est sauté : vendredi soir -> lundi matin', () => {
    const vendredi22h = new Date('2026-09-11T20:00:00Z'); // vendredi 22 h à Paris
    expect(lire(prochaineOuverture(vendredi22h, TZ, SEMAINE))).toBe('2026-09-14 09:00');
  });

  it('samedi en pleine journée -> lundi matin (le week-end entier est sauté)', () => {
    const samedi15h = new Date('2026-09-12T13:00:00Z');
    expect(lire(prochaineOuverture(samedi15h, TZ, SEMAINE))).toBe('2026-09-14 09:00');
  });

  it('🔴 TOUTE la semaine fermée -> null, jamais une date lointaine ni l’instant courant', () => {
    // Les deux replis tentants sont faux : rendre l'instant courant enverrait tout de suite ce qu'on voulait
    // retenir, rendre une date lointaine bloquerait le parcours pour toujours. L'appelant doit décider.
    const tousFermes: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, FERME]));
    expect(prochaineOuverture(new Date('2026-09-08T20:00:00Z'), TZ, tousFermes)).toBeNull();
  });

  it('🔴 une plage inexploitable (fermeture avant ouverture) ne crée PAS de créneau', () => {
    // `withinBusinessHours` traite déjà ce cas comme « jamais ouvert » : la prochaine ouverture doit être
    // d'accord avec lui, sinon on programmerait un envoi dans un créneau que personne ne considère ouvert.
    const absurde: BusinessHours = { ...SEMAINE, '2': jour('18:00', '09:00') };
    const mardi1h = new Date('2026-09-07T23:00:00Z');
    expect(lire(prochaineOuverture(mardi1h, TZ, absurde))).toBe('2026-09-09 09:00'); // mercredi, pas mardi
  });

  it('🔴 l’heure d’ouverture est une heure MURALE : elle suit le changement d’heure', () => {
    // Le dernier dimanche d'octobre, Paris repasse à UTC+1. « 9 h » reste 9 h pour le client, donc l'instant
    // UTC change. Un calcul en millisecondes depuis un instant de référence se décalerait d'une heure une
    // fois par an, dans un sens seulement, et personne ne verrait pourquoi.
    const dimancheSoir = new Date('2026-10-25T22:00:00Z'); // dimanche 23 h à Paris (déjà UTC+1)
    const ouverture = prochaineOuverture(dimancheSoir, TZ, SEMAINE)!;
    expect(lire(ouverture)).toBe('2026-10-26 09:00');
    expect(ouverture.toISOString()).toBe('2026-10-26T08:00:00.000Z'); // 9 h Paris en hiver = 08:00 UTC
  });

  it('un fuseau AUTRE que Paris est respecté', () => {
    // Le fuseau vient de l'espace : un client à New York ouvre à 9 h chez lui, pas à 9 h chez nous.
    const ny = 'America/New_York';
    const mardi1hNy = new Date('2026-09-08T05:00:00Z'); // 01 h mardi à New York
    const d = prochaineOuverture(mardi1hNy, ny, SEMAINE)!;
    expect(new Intl.DateTimeFormat('sv-SE', { timeZone: ny, dateStyle: 'short', timeStyle: 'short' }).format(d))
      .toBe('2026-09-08 09:00');
  });

  it('une date invalide rend null plutôt que de partir en boucle', () => {
    expect(prochaineOuverture(new Date('pas une date'), TZ, SEMAINE)).toBeNull();
  });
});
