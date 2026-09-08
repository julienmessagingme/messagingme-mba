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

  it('🔴 encode le texte pré-rempli, PONCTUATION COMPRISE', () => {
    /**
     * 🔴 CE TEST FIGEAIT LE DEFAUT, ET IL ETAIT VERT. Il affirmait : « `!` n'est PAS encodé par
     * encodeURIComponent, et wa.me l'accepte tel quel : l'assertion fige ce comportement plutôt que de le
     * supposer. » Les deux moitiés étaient vraies, et la conclusion fausse. Le problème n'a jamais été
     * l'acceptation par wa.me, c'est que l'adresse voyage DANS UN POST : l'auto-détection de liens de
     * WhatsApp exclut une ponctuation finale de ce qu'elle ouvre, donc le `!` ne partait pas dans le
     * message, et le mot-clé qui le contenait ne correspondait plus. Un bouton de Julien n'a démarré aucun
     * scénario le 2026-09-08 pour cette raison exacte.
     *
     * Figer un comportement qu'on a observé N'EST PAS le valider : ce test décrivait fidèlement ce que le
     * code faisait, sans jamais se demander si l'environnement REEL en faisait quelque chose de bon.
     */
    expect(lienWaMe('+33 5 25 68 02 50', 'Réserve ma place ! cm-a7k2m9p3'))
      .toBe('https://wa.me/33525680250?text=R%C3%A9serve%20ma%20place%20%21%20cm-a7k2m9p3');
  });
});

describe('encodeTexteWaMe', () => {
  it('🔴 code la ponctuation que `encodeURIComponent` laisse BRUTE, et que le lien perdait', () => {
    // Mesure du 2026-09-08 : `encodeURIComponent` laisse !, ', (, ) et * tels quels (sous-delimiteurs
    // licites). L adresse finissait par « ...promo! », et l auto-detection de liens de WhatsApp traite une
    // ponctuation finale comme celle de la PHRASE, pas du lien : elle l exclut de ce qu elle ouvre. Le
    // caractere ne partait donc jamais dans le message, et aucun scenario ne demarrait.
    expect(lienWaMe('+33 5 25 68 02 50', 'je veux mon de code promo!'))
      .toBe('https://wa.me/33525680250?text=je%20veux%20mon%20de%20code%20promo%21');
  });

  it('les quatre autres caracteres laisses bruts par encodeURIComponent sont codes aussi', () => {
    const url = lienWaMe('33525680250', "a'b(c)d*e")!;
    expect(url.endsWith('a%27b%28c%29d%2Ae')).toBe(true);
    // Preuve inverse : aucun de ces caracteres ne subsiste EN CLAIR dans l adresse.
    expect(/[!'()*]/.test(url.split('?text=')[1]!)).toBe(false);
  });

  it('le reste de l encodage ne bouge pas : espaces et accents partent comme avant', () => {
    expect(lienWaMe('33525680250', 'Réserver ma place'))
      .toBe('https://wa.me/33525680250?text=R%C3%A9server%20ma%20place');
  });
});
