import { describe, it, expect } from 'vitest';
import { langueDeLAdresse } from './locale';

// La langue portée par l'adresse (lot 18) : la page anglaise de la vitrine envoie vers la console avec `?lang=en`,
// et la console doit s'ouvrir en anglais au lieu du français par défaut.
describe('langueDeLAdresse', () => {
  it('lit les deux langues de la console', () => {
    expect(langueDeLAdresse('?lang=en')).toBe('en');
    expect(langueDeLAdresse('?lang=fr')).toBe('fr');
  });

  it('la trouve parmi d’autres paramètres, et sans tenir compte de la casse', () => {
    expect(langueDeLAdresse('?suite=demarrer&lang=en')).toBe('en');
    expect(langueDeLAdresse('?lang=EN')).toBe('en');
  });

  it('ne dit rien quand l’adresse ne porte pas de langue connue', () => {
    expect(langueDeLAdresse('')).toBeNull();
    expect(langueDeLAdresse('?suite=demarrer')).toBeNull();
    expect(langueDeLAdresse('?lang=de')).toBeNull();
    expect(langueDeLAdresse('?lang=')).toBeNull();
  });
});
