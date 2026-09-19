import { describe, it, expect } from 'vitest';
import {
  DUREE_MEDIA_RECU_JOURS_AFFICHEE, TYPES_IMAGE_AFFICHABLES, imageAffichable, legendeDePieceJointe, natureDePieceJointe,
  nomDeTelechargement,
} from '../web/lib/piece-jointe';
import { DUREE_MEDIA_RECU_JOURS, MIMES_AFFICHABLES } from '../src/inbox/media-entrant';

/**
 * Le module PUR des pièces jointes côté écran (`web/lib/piece-jointe.ts`), testé depuis la suite racine.
 *
 * 🔴 LES DEUX PARITÉS SONT LE CŒUR DE CE FICHIER. L'écran recopie deux valeurs du serveur, parce qu'un
 * module client ne peut pas importer `src/` : le délai de WhatsApp qu'il ANNONCE, et la liste des types
 * qu'il accepte de RENDRE. Chacune dérivera le jour où l'autre bouge, sans aucune erreur, sauf ici.
 */
describe('les pièces jointes, à l’écran', () => {
  it('🔴 l’écran annonce le délai que le serveur applique', () => {
    expect(DUREE_MEDIA_RECU_JOURS_AFFICHEE).toBe(DUREE_MEDIA_RECU_JOURS);
  });

  it('🔴 l’écran ne rend pas un type que le serveur servirait en téléchargement', () => {
    // Si l'écran en acceptait un de plus, un fichier servi « attachment » par le serveur serait quand même
    // rendu dans une <img> ; s'il en acceptait un de moins, une photo deviendrait un téléchargement.
    expect([...TYPES_IMAGE_AFFICHABLES].sort()).toEqual([...MIMES_AFFICHABLES].sort());
  });

  it('🔴 un SVG ou un HTML ne se rend jamais, même annoncé comme image', () => {
    expect(imageAffichable('image/svg+xml')).toBe(false);
    expect(imageAffichable('text/html')).toBe(false);
    expect(imageAffichable('')).toBe(false);
    expect(imageAffichable('image/jpeg')).toBe(true);
    expect(imageAffichable('IMAGE/PNG; x=y')).toBe(true);
  });

  it('le sticker est une image, le vocal n’est pas traité ici', () => {
    expect(natureDePieceJointe('sticker')).toBe('image');
    expect(natureDePieceJointe('image')).toBe('image');
    expect(natureDePieceJointe('document')).toBe('document');
    expect(natureDePieceJointe('video')).toBe('video');
    expect(natureDePieceJointe('audio')).toBeNull();
    expect(natureDePieceJointe('text')).toBeNull();
  });

  it('le libellé de type n’est pas une légende, celle de l’expéditeur si', () => {
    expect(legendeDePieceJointe('[image]', 'image')).toBeNull();
    expect(legendeDePieceJointe('[sticker]', 'sticker')).toBeNull();
    expect(legendeDePieceJointe('  ', 'image')).toBeNull();
    expect(legendeDePieceJointe('La facture de mars', 'document')).toBe('La facture de mars');
  });

  it('le nom annoncé par WhatsApp est gardé, sinon un nom neutre avec la bonne extension', () => {
    expect(nomDeTelechargement('facture-mars.pdf', 'document', 'abcdef123456')).toBe('facture-mars.pdf');
    expect(nomDeTelechargement(null, 'video', 'abcdef123456')).toBe('piece-jointe-abcdef12.mp4');
    expect(nomDeTelechargement('  ', 'document', 'abcdef123456')).toBe('piece-jointe-abcdef12');
  });
});
