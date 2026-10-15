import { describe, it, expect } from 'vitest';
import { typesAcceptes, plafondPour, extensionDouteuse, genreDeLAdresse, estMov } from './champ-fichier';

describe('le champ de dépôt de la médiathèque, selon ce qu’il accepte (spec médias, § 3.6)', () => {
  it('par défaut, les trois images de l’opérateur RCS, comme avant', () => {
    expect(typesAcceptes('image')).toBe('image/jpeg,image/png,image/gif');
    expect(plafondPour('image/png', 'image')).toBe(2 * 1024 * 1024);
  });

  it('🔴 le bloc « message rapide » : JPEG, PNG, MP4 et PDF, jamais de GIF (WhatsApp ne le prend pas)', () => {
    expect(typesAcceptes('image-video-pdf')).toBe('image/jpeg,image/png,video/mp4,application/pdf');
  });

  it('16 Mo pour une vidéo ou un PDF, 2 Mo pour une image, un type inconnu refusé (0)', () => {
    expect(plafondPour('video/mp4', 'image-video-pdf')).toBe(16 * 1024 * 1024);
    expect(plafondPour('application/pdf', 'image-video-pdf')).toBe(16 * 1024 * 1024);
    expect(plafondPour('image/jpeg', 'image-video-pdf')).toBe(2 * 1024 * 1024);
    expect(plafondPour('image/gif', 'image-video-pdf')).toBe(0);
    expect(plafondPour('video/mp4', 'image')).toBe(0);
  });

  it('n’avertit d’une extension douteuse que pour ce que le champ n’accepte pas', () => {
    expect(extensionDouteuse('https://x/m/a.mp4', 'image')).toBe(true);
    expect(extensionDouteuse('https://x/m/a.mp4', 'image-video-pdf')).toBe(false);
    expect(extensionDouteuse('https://x/m/a.pdf?v=1', 'image-video-pdf')).toBe(false);
    expect(extensionDouteuse('https://x/m/a.gif', 'image-video-pdf')).toBe(true);
    expect(extensionDouteuse('', 'image')).toBe(false);
  });

  it('lit le genre d’une adresse à son extension : la vignette n’existe que pour une image', () => {
    expect(genreDeLAdresse('https://x/m/a.png')).toBe('image');
    expect(genreDeLAdresse('https://x/m/a.mp4')).toBe('video');
    expect(genreDeLAdresse('https://x/m/a.PDF')).toBe('document');
    expect(genreDeLAdresse('https://x/visuel')).toBe('image');
  });
});

describe('🔴 une vidéo d’iPhone (.MOV) se reconnaît avant l’envoi, pour être refusée avec la marche à suivre', () => {
  it('le type QuickTime, et lui seul', () => {
    expect(estMov('video/quicktime')).toBe(true);
    expect(estMov('video/mp4')).toBe(false);
    expect(estMov('')).toBe(false);
  });
});
