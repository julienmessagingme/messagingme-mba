import { describe, it, expect } from 'vitest';
import { extraireCodeOtp } from '../src/zadarma/otp-extract';

/**
 * Le maillon dont dépend toute l'automatisation de l'OTP. On ne sait pas encore comment la reconnaissance
 * vocale de Zadarma rendra l'énoncé de Meta : ces cas couvrent les trois formes plausibles plutôt que de parier
 * sur une seule.
 */
describe('extraireCodeOtp', () => {
  it('chiffres collés', () => {
    expect(extraireCodeOtp('Votre code de verification WhatsApp est 123456')).toBe('123456');
  });

  it('chiffres égrenés', () => {
    expect(extraireCodeOtp('votre code est 1 2 3 4 5 6, je repete')).toBe('123456');
  });

  it('chiffres énoncés en toutes lettres, un par un', () => {
    expect(extraireCodeOtp('le code est un deux trois quatre cinq six merci')).toBe('123456');
  });

  it('regroupés par deux, la forme naturelle d’un moteur français', () => {
    expect(extraireCodeOtp('votre code douze trente-quatre cinquante-six')).toBe('123456');
  });

  it('formes composées piégeuses (71, 80, 97, 21)', () => {
    expect(extraireCodeOtp('code soixante et onze quatre-vingts quatre-vingt-dix-sept')).toBe('718097');
    expect(extraireCodeOtp('code vingt et un quatre-vingt-deux zero trois')).toBe('218203');
  });

  it('formes mélangées (chiffres et lettres dans la même suite)', () => {
    expect(extraireCodeOtp('code 12 trente-quatre 5 6')).toBe('123456');
  });

  it('code répété deux fois : les deux énoncés concordent -> accepté', () => {
    expect(extraireCodeOtp('votre code est 123456. Je repete, votre code est 123456.')).toBe('123456');
    expect(extraireCodeOtp('123456123456')).toBe('123456'); // transcription qui colle les deux énoncés
  });

  it('🔴 deux codes DIFFÉRENTS -> null : on ne devine pas, une tentative fausse est comptée par Meta', () => {
    expect(extraireCodeOtp('code 123456 ou peut-etre 654321')).toBeNull();
  });

  it('un mot non numérique COUPE la suite : pas de recollage avec un autre nombre', () => {
    // Sans coupure, « 123 » + « 456 » aurait fabriqué un faux code à partir de deux nombres sans rapport.
    expect(extraireCodeOtp('appelez le 123 poste 456')).toBeNull();
  });

  it('rien d’exploitable -> null (silence, transcription vide, autre longueur)', () => {
    expect(extraireCodeOtp('')).toBeNull();
    expect(extraireCodeOtp('bonjour, laissez un message apres le bip')).toBeNull();
    expect(extraireCodeOtp('votre code est 12345')).toBeNull(); // 5 chiffres : pas un code Meta
    expect(extraireCodeOtp('numero 0189480136')).toBeNull(); // 10 chiffres : un numéro, pas un code
  });

  it('ponctuation, majuscules et accents ne changent rien', () => {
    expect(extraireCodeOtp('CODE : Un, Deux, Trois, Quatre. Cinq/Six !')).toBe('123456');
  });
});
