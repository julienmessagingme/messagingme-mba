import { describe, it, expect } from 'vitest';
import { mbaFileFormatConditionnel } from './mba-files';
import { MAX_FICHIER, extensionCoherente, tailleFichierOk } from './partage/agent-meta';

describe('extensionCoherente', () => {
  it('accepte les formats du schéma Meta quand le nom correspond au contenu', () => {
    expect(extensionCoherente('guide.pdf', 'application/pdf')).toBe(true);
    expect(extensionCoherente('GUIDE.PDF', 'application/pdf')).toBe(true);
    expect(extensionCoherente('tarifs.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    expect(extensionCoherente('photo.jpeg', 'image/jpeg')).toBe(true);
  });

  it('🔴 refuse un nom qui ment sur le contenu', () => {
    // `file_name` est un champ SÉPARÉ du binaire côté Meta, et rien ne garantit qu'il déduise le type du
    // contenu. Une extension incohérente peut passer en 201 et n'être jamais indexée : échec silencieux.
    expect(extensionCoherente('guide.docx', 'application/pdf')).toBe(false);
    expect(extensionCoherente('guide', 'application/pdf')).toBe(false);
  });

  it('refuse les formats absents du schéma, même annoncés dans la prose de Meta', () => {
    expect(extensionCoherente('notes.txt', 'text/plain')).toBe(false);
    expect(extensionCoherente('notes.md', 'text/markdown')).toBe(false);
    expect(extensionCoherente('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(false);
  });
});

describe('tailleFichierOk', () => {
  it('borne à 20 Mo et refuse le fichier vide', () => {
    expect(tailleFichierOk(1)).toBe(true);
    expect(tailleFichierOk(MAX_FICHIER)).toBe(true);
    expect(tailleFichierOk(MAX_FICHIER + 1)).toBe(false);
    expect(tailleFichierOk(0)).toBe(false);
  });
});

describe('mbaFileFormatConditionnel', () => {
  it('repère les deux formats dont l’acceptation dépend du compte WhatsApp', () => {
    expect(mbaFileFormatConditionnel('tarifs.csv')).toBe(true);
    expect(mbaFileFormatConditionnel('tarifs.xlsx')).toBe(true);
    expect(mbaFileFormatConditionnel('guide.pdf')).toBe(false);
  });
});
