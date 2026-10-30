import { describe, it, expect } from 'vitest';
import { typesAcceptes, plafondPour, extensionDouteuse, genreDeLAdresse, estMov, refusAvantEnvoi, fichierAccepte } from './champ-fichier';

const t = (fr: string): string => fr;
const MO = 1024 * 1024;

describe('le bouton « Ajouter » de la Médiathèque dépose pour tous les écrans (2026-10-30)', () => {
  it('les cinq types de la route, GIF compris, aux plafonds de la route', () => {
    expect(typesAcceptes('tout')).toBe('image/jpeg,image/png,image/gif,video/mp4,application/pdf');
    expect(plafondPour('image/gif', 'tout')).toBe(2 * MO);
    expect(plafondPour('video/mp4', 'tout')).toBe(16 * MO);
    expect(extensionDouteuse('https://x/m/a.gif', 'tout')).toBe(false);
  });

  it('refuse avant l’envoi ce que la route refuserait, et dit pourquoi', () => {
    expect(refusAvantEnvoi({ type: 'image/png', size: MO }, 'tout', t)).toBeNull();
    expect(refusAvantEnvoi({ type: 'image/png', size: 3 * MO }, 'tout', t)).toBe('Fichier trop lourd : 2 Mo maximum.');
    expect(refusAvantEnvoi({ type: 'image/webp', size: 1 }, 'tout', t)).toMatch(/JPEG, PNG ou GIF, vidéo MP4 ou PDF/);
    expect(refusAvantEnvoi({ type: 'image/gif', size: 1 }, 'image-video-pdf', t)).toMatch(/^Format non accepté : image JPEG ou PNG/);
    expect(refusAvantEnvoi({ type: 'video/mp4', size: 1 }, 'image', t)).toBe('Format non accepté : JPEG, PNG ou GIF.');
  });

  it('🔴 une vidéo d’iPhone est refusée avec la marche à suivre, sauf dans un champ qui ne prend que des images', () => {
    expect(refusAvantEnvoi({ type: 'video/quicktime', size: 1 }, 'tout', t)).toMatch(/format MOV/);
    expect(refusAvantEnvoi({ type: 'video/quicktime', size: 1 }, 'image', t)).toBe('Format non accepté : JPEG, PNG ou GIF.');
  });
});

describe('🔴 la médiathèque ne propose à un champ que ce qu’il peut envoyer', () => {
  it('un GIF ne se propose pas au bloc « message rapide », une vidéo pas à un champ d’image', () => {
    expect(fichierAccepte({ mime: 'image/gif', taille: 1 }, 'image-video-pdf')).toBe(false);
    expect(fichierAccepte({ mime: 'image/gif', taille: 1 }, 'image')).toBe(true);
    expect(fichierAccepte({ mime: 'video/mp4', taille: 1 }, 'image')).toBe(false);
    expect(fichierAccepte({ mime: 'application/pdf', taille: 1 }, 'image-video-pdf')).toBe(true);
  });

  it('un fichier plus lourd que le plafond du champ ne se propose pas', () => {
    expect(fichierAccepte({ mime: 'image/png', taille: 2 * MO }, 'image')).toBe(true);
    expect(fichierAccepte({ mime: 'image/png', taille: 2 * MO + 1 }, 'image')).toBe(false);
  });
});

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
