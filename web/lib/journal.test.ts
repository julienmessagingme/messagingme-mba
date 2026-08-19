import { describe, it, expect } from 'vitest';
import { lignesJournalCsv, resumeDetail, ACTIONS_JOURNAL } from './journal';
import { toCsv } from './csv';
import type { AuditEntry } from './api';

const entree = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 'a-1',
  at: '2026-08-19T20:14:03.000Z',
  actorEmail: 'julien@messagingme.fr',
  action: 'contact.purged',
  targetKind: 'contact',
  targetId: 'c-42',
  detail: {},
  ...over,
});

const LIB = {
  action: (a: string) => (ACTIONS_JOURNAL[a] ? ACTIONS_JOURNAL[a]![0] : a),
  oui: 'oui',
  non: 'non',
  systeme: 'Système',
};

describe('lignesJournalCsv', () => {
  it('rend une ligne par action, dans l’ordre des colonnes', () => {
    expect(lignesJournalCsv([entree()], LIB)).toEqual([
      ['2026-08-19T20:14:03.000Z', 'Contact supprimé', 'julien@messagingme.fr', 'contact', 'c-42', ''],
    ]);
  });

  it('🔴 garde la date en ISO BRUT : un CSV se trie, « 19/08/26 » ne se trie pas', () => {
    const [ligne] = lignesJournalCsv([entree({ at: '2026-01-02T08:00:00.000Z' })], LIB);
    expect(ligne![0]).toBe('2026-01-02T08:00:00.000Z');
  });

  it('un acteur absent est le SYSTÈME, pas une case vide', () => {
    const [ligne] = lignesJournalCsv([entree({ actorEmail: null })], LIB);
    expect(ligne![2]).toBe('Système');
  });

  it('traduit l’action par le libellé fourni, et laisse passer une action inconnue telle quelle', () => {
    const [connue] = lignesJournalCsv([entree({ action: 'contact.optin' })], LIB);
    const [inconnue] = lignesJournalCsv([entree({ action: 'contact.futur' })], LIB);
    expect(connue![1]).toBe('Passage en opt-in');
    expect(inconnue![1]).toBe('contact.futur');
  });

  it('aplatit le détail, booléens compris', () => {
    const [ligne] = lignesJournalCsv([entree({ detail: { created: 2, optIn: true, doublons: false } })], LIB);
    expect(ligne![5]).toBe('created 2 · optIn oui · doublons non');
  });

  it('🔴 ne porte AUCUNE donnée personnelle : seulement l’identifiant interne', () => {
    // Écrire le numéro ici annulerait la purge : on effacerait la personne d'un côté pour la réinscrire dans
    // un fichier exporté. Le test tient l'invariant sur la ligne produite, pas seulement sur la table.
    const ligne = lignesJournalCsv([entree()], LIB)[0]!;
    expect(ligne.join(' ')).not.toMatch(/\+?[0-9]{9,}/);
  });

  it('un détail qui contient une virgule reste dans SA cellule une fois assemblé', () => {
    const csv = toCsv(['at', 'action', 'auteur', 'type', 'cible', 'detail'], lignesJournalCsv([entree({ detail: { note: 'a, b' } })], LIB));
    expect(csv).toContain('"note a, b"');
    expect(csv.split('\r\n')[1]!.split('"')[0]!.split(',')).toHaveLength(6);
  });
});

describe('resumeDetail', () => {
  it('rend une chaîne vide sur un détail vide', () => {
    expect(resumeDetail({}, 'oui', 'non')).toBe('');
  });
});
