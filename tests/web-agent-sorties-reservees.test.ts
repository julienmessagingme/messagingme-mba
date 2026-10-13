import { describe, it, expect } from 'vitest';
import { AGENT_SORTIES_RESERVEES } from '../web/lib/nodeMeta';
import { SORTIE_ECHEC, SORTIE_HUMAIN, SORTIE_PLAFOND, SORTIE_SANS_SOURCE, SORTIE_TIMEOUT } from '../web/lib/partage/sorties-agent';

/**
 * Les sorties RÉSERVÉES du bloc agent, telles que le builder les dessine. Les codes sont partagés avec le tour qui
 * les emprunte (`web/lib/partage/sorties-agent.ts`) ; reste à prouver que le builder les dessine TOUTES, sous la forme
 * du handle que le tour emprunte (`timeout` nu, les autres préfixés), chacune avec son explication.
 *
 * 🔴 CE QUI SE PASSE SI UNE MANQUE, et c'est SILENCIEUX des deux côtés. Le tour sort par un handle que le
 * graphe ne porte pas, `advance` ne trouve aucune arête pour ce handle, et retombe sur la première arête
 * libre venue : le contact part dans une branche qui n'a rien à voir. Personne ne voit d'erreur.
 */
describe('sorties réservées du bloc agent : le builder dessine celles que le tour emprunte', () => {
  it('🔴 les handles dessinés sont EXACTEMENT ceux que le tour emprunte', () => {
    // `timeout` est SANS préfixe, volontairement : c'est le handle du bloc Question, réemprunté pour n'avoir
    // qu'un seul vocabulaire dans le builder. Les autres portent `sortie:`, comme les règles d'arrêt.
    expect(AGENT_SORTIES_RESERVEES.map((s) => s.handle)).toEqual([
      SORTIE_TIMEOUT,
      `sortie:${SORTIE_SANS_SOURCE}`,
      `sortie:${SORTIE_HUMAIN}`,
      `sortie:${SORTIE_PLAFOND}`,
      `sortie:${SORTIE_ECHEC}`,
    ]);
  });

  it('chaque sortie réservée porte un libellé et une aide dans les deux langues', () => {
    // Une sortie sans explication est une sortie que personne ne câble : le client ne peut pas deviner ce que
    // « plafond » veut dire pour son parcours.
    for (const s of AGENT_SORTIES_RESERVEES) {
      expect(s.icone.length).toBeGreaterThan(0);
      for (const paire of [s.label, s.aide]) {
        expect(paire).toHaveLength(2);
        expect(paire[0].trim()).not.toBe('');
        expect(paire[1].trim()).not.toBe('');
        expect(paire[0]).not.toBe(paire[1]); // une traduction oubliée est une traduction copiée
      }
    }
  });

  it('aucun doublon de handle : deux sorties de même nom en cacheraient une', () => {
    const handles = AGENT_SORTIES_RESERVEES.map((s) => s.handle);
    expect(new Set(handles).size).toBe(handles.length);
  });
});
