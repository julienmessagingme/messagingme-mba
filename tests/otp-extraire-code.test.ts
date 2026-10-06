import { describe, it, expect } from 'vitest';
import { extraireCodeOtp } from '../src/otp/extraire-code';

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

/**
 * 🔴 L'ANGLAIS DES NUMÉROS FOURNIS (lot 3a). Sur un numéro britannique de DIDWW, Meta dicte en anglais, chiffre par
 * chiffre : la transcription réelle du 2026-10-05 portait « your verification code is 8 6 3 8 0 1 ».
 */
describe('extraireCodeOtp : l’anglais de Meta', () => {
  it('la transcription réelle du 2026-10-05, chiffres espacés et répétés', () => {
    expect(extraireCodeOtp('Your verification code is 8 6 3 8 0 1. Again, your verification code is 8 6 3 8 0 1.')).toBe('863801');
  });

  it('les chiffres en mots, « oh » et « zero » pour zéro, avec ou sans tirets', () => {
    expect(extraireCodeOtp('your code is eight six three eight oh one')).toBe('863801');
    expect(extraireCodeOtp('Your code is: eight-six-three-eight-zero-one.')).toBe('863801');
    expect(extraireCodeOtp('One, two, three, four, five, six.')).toBe('123456');
  });

  it('🔴 un homophone n’est pas un chiffre : la suite se coupe, aucun code plutôt qu’un code faux', () => {
    // « for » lu 4 fabriquerait un code de six chiffres là où Meta n'en a dicté que cinq de lisibles.
    expect(extraireCodeOtp('your code is for eight three eight zero one')).toBeNull();
  });

  it('🔴 deux énoncés qui diffèrent -> null, en anglais aussi', () => {
    expect(extraireCodeOtp('your code is 863801, again your code is 863807')).toBeNull();
  });
});

/**
 * 🔴 LE SMS DE META, LU À VOIX HAUTE PAR LA LIGNE FIXE (essai réel du 2026-10-06). La fenêtre de Meta peut imposer le
 * SMS ; un numéro fixe britannique ne le reçoit pas, et l'opérateur le lit par un appel. Le code y est dit par
 * centaines, le tiret prononcé « to » (« 927-341 » devient « nine hundred twenty seven to three hundred forty one »).
 * La transcription réelle portait des chiffres ; les voici remplacés par un code inventé.
 */
describe('extraireCodeOtp : le SMS lu à voix haute', () => {
  const REEL = 'You have a new message from WhatsApp received at the 6th of October 2026, 2.55pm. Your WhatsApp code 927 to 341. '
    + "Don't share this code with others. To replay the message, press 1. To save the message, press 2. For more options, "
    + 'press 3. To replay the message, press 1. To save the message, press 2. For more options, press 3. Goodbye!';

  it('la transcription réelle du 2026-10-06 : trois chiffres, « to », trois chiffres, après « code »', () => {
    expect(extraireCodeOtp(REEL)).toBe('927341');
  });

  it('les centaines en toutes lettres, avec ou sans « and »', () => {
    expect(extraireCodeOtp('Your WhatsApp code nine hundred twenty seven to three hundred forty one.')).toBe('927341');
    expect(extraireCodeOtp('your whatsapp code is nine hundred and seven to one hundred twelve')).toBe('907112');
    expect(extraireCodeOtp('your code six hundred to eight hundred five')).toBe('600805');
  });

  it('lu deux fois, le même code : accepté ; deux codes différents : null', () => {
    expect(extraireCodeOtp(`${REEL} ${REEL}`)).toBe('927341');
    expect(extraireCodeOtp('your code 927 to 341. your code 927 to 342.')).toBeNull();
  });

  it('🔴 « to » ne recolle QUE trois chiffres et trois chiffres, juste après « code »', () => {
    // Un « two » dicté et mal lu donnerait 3 + 1 + 3 = 7 chiffres : jamais un code de Meta, donc jamais recollé à tort.
    expect(extraireCodeOtp('your code 12 to 3456')).toBeNull();
    expect(extraireCodeOtp('your code 123 to 4567')).toBeNull();
    expect(extraireCodeOtp('from 123 to 456')).toBeNull();
    expect(extraireCodeOtp('your code is 8 6 3 to 8 0 1')).toBe('863801');
    expect(extraireCodeOtp('your code twenty seven to three hundred forty one')).toBeNull();
  });
});
