import { describe, it, expect } from 'vitest';
import { TAILLE_DOCUMENT_MAX, TAILLE_IMAGE_MAX } from '../src/agent/setup/piece-jointe';
import {
  TAILLE_DOCUMENT_MAX as DOC_ECRAN,
  TAILLE_IMAGE_MAX as IMG_ECRAN,
} from '../web/lib/api-agent-setup';

/**
 * Les plafonds de la pièce jointe, des deux côtés.
 *
 * L'écran refuse AVANT de téléverser (attendre huit mégas pour se faire dire non est une mauvaise expérience,
 * et la limite de corps de la route couperait de toute façon), le serveur refuse en dernier ressort. Deux
 * chiffres qui divergent donneraient le pire des deux : un écran qui promet ce que le serveur refuse, avec un
 * 413 que personne ne relie à la promesse. Même patron que les autres tests de parité du dépôt.
 */
describe('parité des plafonds de pièce jointe', () => {
  it('l’écran et le serveur annoncent le MÊME poids maximum', () => {
    expect(DOC_ECRAN).toBe(TAILLE_DOCUMENT_MAX);
    expect(IMG_ECRAN).toBe(TAILLE_IMAGE_MAX);
  });

  it('une image est plus serrée qu’un document : elle part chez un fournisseur qui la facture', () => {
    expect(TAILLE_IMAGE_MAX).toBeLessThan(TAILLE_DOCUMENT_MAX);
  });
});
