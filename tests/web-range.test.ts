import { describe, it, expect } from 'vitest';
import { addDays, presetRange, activePreset, todayParis, PRESETS } from '../web/lib/range';

/**
 * Plages de dates des écrans Analytics.
 *
 * Ce module est testable ici PARCE QU'il est pur : il n'importe rien, donc il ne traîne pas `web/lib/api.ts`
 * -> `session.ts` -> `window` dans un tsconfig racine qui compile sans la lib DOM. C'est la raison pour
 * laquelle `DateRange` y est redéfini au lieu d'être importé de `api.ts`.
 *
 * Ce qui compte et qui n'est pas évident :
 *  - « les 7 derniers jours » INCLUT aujourd'hui, donc la borne basse est à -6 et non à -7. Un décalage d'un
 *    jour ici décale silencieusement toutes les statistiques de la console.
 *  - `addDays` doit tenir le passage à l'heure d'été. Le calcul passe par minuit UTC des deux côtés
 *    précisément pour ça : un calcul en heure locale ferait sauter ou répéter un jour fin mars et fin octobre.
 */
describe('addDays', () => {
  it('avance et recule sur une date ordinaire', () => {
    expect(addDays('2026-07-19', 1)).toBe('2026-07-20');
    expect(addDays('2026-07-19', -1)).toBe('2026-07-18');
    expect(addDays('2026-07-19', 0)).toBe('2026-07-19');
  });

  it('franchit les mois, les années et le 29 février', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // 2028 est bissextile
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 ne l'est pas
  });

  it('franchit les DEUX bascules d’heure d’été sans perdre ni répéter un jour', () => {
    // Europe/Paris 2026 : +1h le 29 mars, -1h le 25 octobre. Un calcul en minuit LOCAL casserait ici.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('reste cohérent sur un aller-retour de 90 jours', () => {
    expect(addDays(addDays('2026-07-19', -90), 90)).toBe('2026-07-19');
  });
});

describe('presetRange', () => {
  it('inclut la journée en cours : 7 jours = aujourd’hui et les 6 précédents', () => {
    const r = presetRange(7);
    expect(r.to).toBe(todayParis());
    expect(addDays(r.from, 6)).toBe(r.to);
  });

  it('un jour = une plage d’un seul jour, from === to', () => {
    const r = presetRange(1);
    expect(r.from).toBe(r.to);
  });
});

describe('activePreset', () => {
  const today = '2026-07-19';

  it('reconnaît chaque raccourci', () => {
    for (const d of PRESETS) {
      expect(activePreset({ from: addDays(today, -(d - 1)), to: today }, today)).toBe(d);
    }
  });

  it('une plage saisie à la main n’allume aucun raccourci', () => {
    expect(activePreset({ from: '2026-07-01', to: today }, today)).toBeNull();
  });

  it('une plage qui ne finit pas aujourd’hui n’allume aucun raccourci, même à la bonne longueur', () => {
    // 7 jours pleins, mais décalés : afficher « 7 j » en surbrillance mentirait sur la période regardée.
    expect(activePreset({ from: '2026-07-06', to: '2026-07-12' }, today)).toBeNull();
  });
});
