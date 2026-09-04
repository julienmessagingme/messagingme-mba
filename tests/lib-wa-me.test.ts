import { describe, it, expect } from 'vitest';
import { lienWaMe } from '../src/lib/wa-me';

/**
 * Constructeur du lien wa.me pré-rempli (module partagé).
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. Sans numéro connecté, AUCUN lien n'est fabriqué. Un lien sans chiffres (`https://wa.me/?text=...`)
 *     ouvre un écran d'erreur WhatsApp : mieux vaut ne rien afficher qu'un bouton mort. Et ce lien-là part
 *     dans un post de chaîne DÉJÀ distribué : il n'y a aucun retour arrière.
 *  2. Le numéro arrive tel que Meta l'AFFICHE (« +33 5 25 68 02 50 ») ; wa.me n'accepte que des chiffres.
 *     Un seul caractère parasite laissé dans l'URL la casse sans que rien ne le signale.
 *  3. Le texte est le message que la personne ENVERRA, pas une étiquette : il porte une phrase lisible ET
 *     le jeton. Sans encodage il est tronqué au premier espace, le jeton est perdu, et le scénario ne
 *     démarre jamais.
 */

// Jeton FICTIF (aucun secret) : valeur figée pour rendre les assertions lisibles.
const JETON = 'test-a7k2m9p3';

describe('lienWaMe', () => {
  it('retire le signe plus et les espaces du numéro affiché', () => {
    expect(lienWaMe('+33 5 25 68 02 50', JETON)).toBe('https://wa.me/33525680250?text=test-a7k2m9p3');
  });

  it('aucun numéro connecté (null) -> pas de lien fabriqué', () => {
    expect(lienWaMe(null, JETON)).toBeNull();
  });

  it('numéro vide, ou sans aucun chiffre -> pas de lien fabriqué', () => {
    expect(lienWaMe('', JETON)).toBeNull();
    expect(lienWaMe('   ', JETON)).toBeNull();
    expect(lienWaMe('+ ()-', JETON)).toBeNull();
  });

  it('encode le texte pré-rempli : espaces et accents', () => {
    // `!` n'est PAS encodé par encodeURIComponent (il fait partie de son jeu non réservé), et wa.me
    // l'accepte tel quel : l'assertion fige ce comportement plutôt que de le supposer.
    expect(lienWaMe('+33 5 25 68 02 50', 'Réserve ma place ! cm-a7k2m9p3'))
      .toBe('https://wa.me/33525680250?text=R%C3%A9serve%20ma%20place%20!%20cm-a7k2m9p3');
  });
});
