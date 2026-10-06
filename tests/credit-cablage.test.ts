import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DU CRÉDIT, lu dans le CODE de l'API (relecture du 2026-09-29).
 *
 * 🔴 CE QUE LE TYPAGE NE VOIT PAS. Les règles elles-mêmes vivent dans des fonctions testées pour leur comportement
 * (`creerPayeurAutorise`, `creerOffreDeBienvenue`, `creerAssureurDeCle`) ; ce qu'on leur PASSE ne se voit que dans
 * `src/index.ts`. Un mode inversé (`!estCleLive`) laisserait payer tout le monde avec une carte de test, ou personne
 * en live ; une offre câblée sans la remontée du plafond ferait couper par Vercel un client qui n'a pas encore
 * dépensé ses 5 € ; une ouverture de clé sans les travaux de l'arrêt perdrait la clé à chaque redémarrage. Tous
 * compilent.
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const api = sansCommentaires(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));

describe('le câblage du crédit dans l’API', () => {
  it('🔴 le webhook transmet au magasin la fin de la facture échouée (rouge 2 de la relecture du lot 4)', () => {
    // Une flèche à trois paramètres est assignable à un contrat qui en déclare quatre, et le quatrième est avalé
    // sans erreur : l'échec rejoué après le paiement repasserait alors l'espace en retard, puis le couperait.
    expect(api).toMatch(/majStatut: \(abonnementId, statut, periodeFin, finFactureEchouee\) => abonnementsNumero\.majStatut\(abonnementId, statut, periodeFin, finFactureEchouee\),/);
  });

  it('🔴 le payeur reçoit le MODE de la clé configurée, tel quel', () => {
    expect(api).toMatch(/payeurAutorise: creerPayeurAutorise\(\{\s*livemode: estCleLive\(config\.STRIPE_SECRET_KEY\),/);
  });

  it('🔴 le webhook reçoit le même mode, pour refuser un événement de l’autre', () => {
    expect(api).toMatch(/stripeWebhook: \{\s*secret: config\.STRIPE_WEBHOOK_SECRET,\s*livemode: estCleLive\(config\.STRIPE_SECRET_KEY\),/);
  });

  it('🔴 l’offre de bienvenue remonte le plafond de la clé, en arrière-plan suivi par l’arrêt', () => {
    expect(api).toMatch(/offrirCredit: creerOffreDeBienvenue\(\{[\s\S]*?remonterPlafond: provisionCle \? \(tenant: string\) => remonterPlafondApresRecharge\(provisionCle, tenant\) : null,\s*travaux: travauxEnVol,/);
  });

  it('🔴 la liaison n’offre rien : elle délègue au dépôt, sans crédit ni plafond', () => {
    expect(api).toMatch(/linkTenant: \(input\) => esCredentialsStore\.linkTenant\(input\),/);
  });

  it('🔴 l’ouverture d’une clé pour la traduction est confiée aux travaux que l’arrêt attend', () => {
    expect(api).toMatch(/creerAssureurDeCle\(\{[\s\S]*?travaux: travauxEnVol,\s*\}\)/);
    // Et les travaux sont déclarés AVANT le traducteur qui en a besoin (sinon : référence avant déclaration).
    expect(api.indexOf('const travauxEnVol = creerTravauxEnVol();')).toBeLessThan(api.indexOf('creerAssureurDeCle({'));
    expect(api.match(/const travauxEnVol = creerTravauxEnVol\(\);/g)).toHaveLength(1);
  });

  it('🔴 les trois crédits remontent le plafond par la même fonction, sans montant (la cible se recalcule)', () => {
    expect(api.match(/remonterPlafondApresRecharge\(provisionCle, tenant(Id)?\)/g)).toHaveLength(3);
  });
});
