import { describe, it, expect } from 'vitest';
import { MBA_FILE_MAX_BYTES, mbaFileExtensionOk, mbaFileFormatConditionnel, mbaFileSizeOk } from './mba-files';

describe('mbaFileExtensionOk', () => {
  it('accepte les formats du schéma Meta quand le nom correspond au contenu', () => {
    expect(mbaFileExtensionOk('guide.pdf', 'application/pdf')).toBe(true);
    expect(mbaFileExtensionOk('GUIDE.PDF', 'application/pdf')).toBe(true);
    expect(mbaFileExtensionOk('tarifs.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    expect(mbaFileExtensionOk('photo.jpeg', 'image/jpeg')).toBe(true);
  });

  it('🔴 refuse un nom qui ment sur le contenu', () => {
    // `file_name` est un champ SÉPARÉ du binaire côté Meta, et rien ne garantit qu'il déduise le type du
    // contenu. Une extension incohérente peut passer en 201 et n'être jamais indexée : échec silencieux.
    expect(mbaFileExtensionOk('guide.docx', 'application/pdf')).toBe(false);
    expect(mbaFileExtensionOk('guide', 'application/pdf')).toBe(false);
  });

  it('refuse les formats absents du schéma, même annoncés dans la prose de Meta', () => {
    expect(mbaFileExtensionOk('notes.txt', 'text/plain')).toBe(false);
    expect(mbaFileExtensionOk('notes.md', 'text/markdown')).toBe(false);
    expect(mbaFileExtensionOk('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(false);
  });
});

describe('mbaFileSizeOk', () => {
  it('borne à 20 Mo et refuse le fichier vide', () => {
    expect(mbaFileSizeOk(1)).toBe(true);
    expect(mbaFileSizeOk(MBA_FILE_MAX_BYTES)).toBe(true);
    expect(mbaFileSizeOk(MBA_FILE_MAX_BYTES + 1)).toBe(false);
    expect(mbaFileSizeOk(0)).toBe(false);
  });
});

describe('mbaFileFormatConditionnel', () => {
  it('repère les deux formats dont l’acceptation dépend du compte WhatsApp', () => {
    expect(mbaFileFormatConditionnel('tarifs.csv')).toBe(true);
    expect(mbaFileFormatConditionnel('tarifs.xlsx')).toBe(true);
    expect(mbaFileFormatConditionnel('guide.pdf')).toBe(false);
  });
});
