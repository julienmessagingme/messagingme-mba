import { describe, it, expect } from 'vitest';
import { verdictWhatsApp as ECRAN, PEREMPTION_WHATSAPP_MS as PEREMPTION_ECRAN } from '../web/lib/joignabilite';
import { verdictWhatsApp as SERVEUR, PEREMPTION_WHATSAPP_MS as PEREMPTION_SERVEUR } from '../src/contacts/joignabilite';

/**
 * Parité front / back de la règle de joignabilité (migration 0133). La règle est recopiée côté écran (les
 * deux builds ne partagent aucun module) : ce test casse si elles divergent.
 *
 * 🔴 CE QU'UNE DIVERGENCE COÛTERAIT, ET POURQUOI ELLE SERAIT MUETTE. La fiche contact et le filtre
 * d'audience répondent à la MÊME question sur le MÊME contact. Si l'un périme à 90 jours et l'autre à 30,
 * la fiche affiche « injoignable » pendant que la campagne l'inclut, ou l'inverse : rien ne casse, rien ne
 * s'affiche en rouge, et la seule façon de s'en apercevoir est de comparer deux écrans à la main.
 *
 * ⚠️ La parité se vérifie sur le COMPORTEMENT, pas seulement sur la constante. Deux fonctions peuvent
 * partager le même seuil et traiter `null` différemment, ce qui est précisément le piège de ce champ.
 *
 * Vit dans la suite racine (comme les autres `web-*-parity`) : elle a les dépendances des deux côtés.
 */
const MAINTENANT = new Date('2026-09-12T10:00:00Z');
const ilYA = (jours: number): Date => new Date(MAINTENANT.getTime() - jours * 86_400_000);

describe('règle de joignabilité WhatsApp', () => {
  it('la péremption du front est celle du serveur', () => {
    expect(PEREMPTION_ECRAN).toBe(PEREMPTION_SERVEUR);
  });

  it('les deux verdicts s\'accordent sur les six cas qui comptent', () => {
    const cas: Array<[boolean | null, Date | null]> = [
      [null, null],        // jamais mesuré
      [false, null],       // une valeur sans instant n'est pas une mesure
      [true, null],
      [false, ilYA(89)],   // mesure valide
      [true, ilYA(89)],
      [false, ilYA(91)],   // mesure périmée
    ];
    for (const [valeur, le] of cas) {
      expect(ECRAN(valeur, le, MAINTENANT), `cas ${String(valeur)} / ${le === null ? 'sans date' : le.toISOString()}`)
        .toBe(SERVEUR(valeur, le, MAINTENANT));
    }
  });
});
