import { describe, it, expect } from 'vitest';
import { normaliserDate, raisonDateLisible } from '../src/crm/date-iso';
import { validateFieldValue, canonicalizeFieldValue } from '../src/crm/fields';

/**
 * Dates venues d'un TIERS : on normalise ce qui est NON AMBIGU, on refuse le reste EN LE DISANT.
 *
 * L'enjeu n'est pas cosmétique. Une date mal devinée ne ressemble pas à un bug : elle ressemble à une date.
 * Elle ne se voit qu'au moment où un rappel part un mois trop tôt, chez le client.
 */

describe('formes acceptées', () => {
  it('ISO complet, avec ou sans secondes, fraction, fuseau', () => {
    for (const v of [
      '2026-08-23T15:40',
      '2026-08-23T15:40:00',
      '2026-08-23T15:40:00.123',
      '2026-08-23T15:40:00Z',
      '2026-08-23T15:40:00+02:00',
      '2026-08-23T15:40:00+0200',
    ]) {
      expect(normaliserDate(v, 'datetime'), v).toEqual({ ok: true, iso: v });
    }
  });

  it('🔴 l’ESPACE au lieu du T est acceptée et normalisée : c’est ce qu’envoient les bases et les tableurs', () => {
    // Le cas qui a motivé ce module : un webhook tiers émettait `2026-08-23 15:40:00` et se faisait refuser,
    // alors que la valeur ne prête à aucune confusion.
    expect(normaliserDate('2026-08-23 15:40:00', 'datetime')).toEqual({ ok: true, iso: '2026-08-23T15:40:00' });
    expect(normaliserDate('2026-08-23  15:40', 'datetime')).toEqual({ ok: true, iso: '2026-08-23T15:40' });
    expect(normaliserDate('2026-08-23 15:40:00Z', 'datetime')).toEqual({ ok: true, iso: '2026-08-23T15:40:00Z' });
  });

  it('epoch en secondes (10 chiffres) et en millisecondes (13)', () => {
    expect(normaliserDate('1787506800', 'datetime')).toEqual({ ok: true, iso: '2026-08-23T17:40:00.000Z' });
    expect(normaliserDate('1787506800000', 'datetime')).toEqual({ ok: true, iso: '2026-08-23T17:40:00.000Z' });
  });

  it('🔴 une date COMPACTE n’est pas prise pour un epoch', () => {
    // `20260823` fait 8 chiffres. Le lire comme un epoch en donnerait le 23 août... 1970.
    expect(normaliserDate('20260823', 'datetime').ok).toBe(false);
  });

  it('un champ `date` accepte le jour seul, et extrait le jour d’un instant complet', () => {
    expect(normaliserDate('2026-08-23', 'date')).toEqual({ ok: true, iso: '2026-08-23' });
    expect(normaliserDate('2026-08-23T15:40:00Z', 'date')).toEqual({ ok: true, iso: '2026-08-23' });
    expect(normaliserDate('1787506800', 'date')).toEqual({ ok: true, iso: '2026-08-23' });
  });
});

describe('formes refusées', () => {
  it('🔴 jour/mois/année est AMBIGU, et refusé même quand le jour dépasse 12', () => {
    // `03/04/2026` peut être le 3 avril ou le 4 mars. `23/08/2026` serait, lui, déchiffrable (23 ne peut pas
    // être un mois), mais accepter l'un et refuser l'autre rendrait la MÊME intégration tantôt bonne tantôt
    // cassée selon le jour du mois. On refuse uniformément, c'est prévisible.
    for (const v of ['03/04/2026', '23/08/2026', '03-04-2026', '3.4.26', '03/04/2026 15:40']) {
      expect(normaliserDate(v, 'datetime'), v).toEqual({ ok: false, raison: 'ambigu' });
    }
  });

  it('🔴 un JOUR SEUL dans un champ date et heure est refusé, et on n’invente pas minuit', () => {
    // Un rappel réglé « 2 h avant » sur une valeur devinée à minuit partirait à 22 h la VEILLE, sans que
    // rien ne le signale. Contrat déjà écrit avant ce module (« date nue = pas datetime »), et qui compte
    // encore plus depuis qu'un déclencheur temporel peut s'appuyer dessus.
    expect(normaliserDate('2026-08-23', 'datetime')).toEqual({ ok: false, raison: 'sans_heure' });
  });

  it('🔴 une date qui n’existe pas est refusée, au lieu de dériver sur le mois suivant', () => {
    // `Date.parse` accepte volontiers le 30 février en le décalant au 2 mars.
    for (const v of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-08-32']) {
      expect(normaliserDate(v, 'date').ok, v).toBe(false);
    }
    expect(normaliserDate('2026-02-30T10:00', 'datetime').ok).toBe(false);
    expect(normaliserDate('2026-08-23T25:00', 'datetime').ok).toBe(false);
    expect(normaliserDate('2026-08-23T10:75', 'datetime').ok).toBe(false);
  });

  it('le vide et le texte libre sont refusés', () => {
    for (const v of ['', '   ', 'demain', 'la semaine prochaine', 'null']) {
      expect(normaliserDate(v, 'datetime').ok, v).toBe(false);
    }
  });

  it('🔴 chaque refus DIT quoi envoyer à la place', () => {
    // Un refus muet renvoie l'intégrateur chercher un bug là où il n'y a qu'un format.
    expect(raisonDateLisible('ambigu')).toMatch(/2026-08-23T15:40:00Z/);
    expect(raisonDateLisible('sans_heure')).toMatch(/il manque l'heure/);
    expect(raisonDateLisible('illisible')).toMatch(/2026-08-23T15:40:00Z/);
  });
});

describe('branchement sur les champs de contact', () => {
  it('la validation d’un champ suit exactement ces règles', () => {
    expect(validateFieldValue('datetime', '2026-08-23 15:40:00')).toBe(true);
    expect(validateFieldValue('datetime', '2026-08-23')).toBe(false);
    expect(validateFieldValue('datetime', '03/04/2026')).toBe(false);
    expect(validateFieldValue('date', '2026-08-23')).toBe(true);
  });

  it('🔴 la valeur est STOCKÉE sous sa forme internationale, quelle que soit celle reçue', () => {
    // C'est ce qui permet de la comparer et de la trier ensuite, et à un futur déclencheur temporel de
    // savoir quand elle tombe.
    expect(canonicalizeFieldValue('datetime', '2026-08-23 15:40:00')).toBe('2026-08-23T15:40:00');
    expect(canonicalizeFieldValue('datetime', '1787506800')).toBe('2026-08-23T17:40:00.000Z');
    expect(canonicalizeFieldValue('date', '2026-08-23T15:40:00Z')).toBe('2026-08-23');
  });

  it('une valeur non normalisable ressort telle quelle, sans lever', () => {
    // `canonicalizeFieldValue` est défensive par contrat : la barrière est `validateFieldValue`, en amont.
    expect(canonicalizeFieldValue('datetime', 'demain')).toBe('demain');
  });
});
