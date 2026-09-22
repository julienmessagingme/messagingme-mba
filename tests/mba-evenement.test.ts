import { describe, it, expect } from 'vitest';
import { evenementHorsParcours, destinataireAgentEvent, TYPE_HORS_PARCOURS } from '../src/mba/evenement';

/**
 * L'événement « réponse hors parcours » (spec 2026-09-21-outils-maison-mba, § 5).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : les trois bornes de Meta, écrites en prose dans sa documentation et donc
 * invisibles d'une validation automatique (`docs/MBA-API-REFERENCE.md`), et le format de `to` MESURÉ le 2026-09-21.
 */
describe('l’événement « réponse hors parcours »', () => {
  it('porte le message du client dans un payload JSON en CHAÎNE, sous les bornes de Meta', () => {
    const e = evenementHorsParcours('Vous êtes ouverts le dimanche ?');
    expect(e.type).toBe(TYPE_HORS_PARCOURS);
    expect(typeof e.payload).toBe('string');
    expect(JSON.parse(e.payload)).toEqual({ message: 'Vous êtes ouverts le dimanche ?' });
    expect(e.type.length).toBeLessThanOrEqual(256);
    expect(e.description.length).toBeLessThanOrEqual(1024);
  });

  it('🔴 le payload tient sous 4 096 caractères APRÈS échappement, et reste du JSON', () => {
    const melange = `${'é'.repeat(3000)}"${String.fromCharCode(92)}`.repeat(3);
    for (const long of ['"'.repeat(5000), 'a'.repeat(9000), melange]) {
      const e = evenementHorsParcours(long);
      expect(e.payload.length).toBeLessThanOrEqual(4096);
      const lu = JSON.parse(e.payload) as { message: string };
      expect(long.startsWith(lu.message)).toBe(true);
    }
  });

  it('un message court passe tel quel', () => {
    expect(JSON.parse(evenementHorsParcours('ok').payload)).toEqual({ message: 'ok' });
  });

  it('🔴 le destinataire est au format MESURÉ : E.164 avec « + », jamais doublé', () => {
    expect(destinataireAgentEvent('33612345678')).toBe('+33612345678');
    expect(destinataireAgentEvent('+33612345678')).toBe('+33612345678');
  });
});
