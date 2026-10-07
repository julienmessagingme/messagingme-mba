import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DE L'OFFRE, lu dans le CODE (lot 6). `ServerDeps.offres` est optionnelle (sans elle, chaque espace est en
 * Entreprise : le défaut des tests) ; c'est donc ici, et pas dans le type, que se tient la promesse que la production
 * la câble. L'oublier ouvrirait les fonctions du Pro à la Base, sans erreur ni avertissement.
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const lire = (f: string) => sansCommentaires(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));

describe('le câblage de l’offre', () => {
  it('🔴 le socle construit UNE offre en cache sur la seule définition, et la rend', () => {
    const socle = lire('socle.ts');
    expect(socle).toMatch(/const offres = new OffresEnCache\(new PgOffresStore\(pool\)\);/);
    expect(socle).toMatch(/return \{[\s\S]*\boffres\b[\s\S]*\};\s*\}\s*export type Socle/);
  });

  it('🔴 la fabrique d’envoi reçoit les modèles du mois, comptés sur le compteur PARTAGÉ des copies', () => {
    const socle = lire('socle.ts');
    expect(socle).toMatch(/const quotaModeles = new QuotaModeles\(\{ offres, compteur: compteurDebit \}\);/);
    const fabrique = socle.slice(socle.indexOf('new MetaClientFactory({'));
    expect(fabrique.slice(0, fabrique.indexOf('\n  });'))).toMatch(/^\s+quotaModeles,$/m);
  });

  it('🔴 le lancement d’une campagne et les envois de l’API lisent les modèles du mois du socle', () => {
    const api = lire('index.ts');
    expect(api).toMatch(/modelesDuLancement: creerModelesDuLancement\(quotaModeles, \(campagne, tenant\) => repo\.modelesEnAttente\(campagne, tenant\)\),/);
    expect(api).toMatch(/modelesDuMois: quotaModeles,/);
  });

  it('🔴 les magasins qui créent (contacts, automations, webhooks entrants, membres) reçoivent la limite de l’offre', () => {
    const socle = lire('socle.ts');
    const api = lire('index.ts');
    // Les contacts, les automations et les webhooks entrants : dans le socle, partagé par l'API et le worker.
    expect(socle).toMatch(/async \(tenant\) => \(await offres\.offreDe\(tenant\)\)\.droits\.limites\.contacts,/);
    expect(socle).toMatch(/new PgAutomationStore\(pool, async \(tenant\) => \(await offres\.offreDe\(tenant\)\)\.droits\.limites\.automations\)/);
    expect(socle).toMatch(/new PgWebhookStore\(pool, async \(tenant\) => \(await offres\.offreDe\(tenant\)\)\.droits\.limites\.automations\)/);
    // Les membres et les suppressions du jour : dans l'API, seule à inviter et à purger.
    expect(api).toMatch(/const userStore = new PgUserStore\(pool, async \(tenant\) => \{/);
    expect(api).toMatch(/suppressionsDuJour: new QuotaSuppressions\(\{ offres, compteur: compteurDebit \}\),/);
  });

  it('🔴 la console, Claude, l’exploitation et le badge lisent la MÊME offre en cache', () => {
    const api = lire('index.ts');
    // Une seule vue, calculée sur l'offre en cache, pour la route de la console ET l'outil `get_plan`.
    expect(api).toMatch(/const vueOffre = creerVueOffre\(\{\s+offres, usage: \(tenant\) => offresStore\.usage\(tenant\), modelesDuMois: quotaModeles,/);
    // Le prix du Pro ne s'affiche que s'il se paie : Stripe câblé ET les deux prix posés (jaune 10 de la relecture de B1).
    expect(api).toMatch(/proEnVente: proDeLaConsole\.stripe !== null && proDeLaConsole\.prixProMois !== '' && proDeLaConsole\.prixProAn !== '',/);
    expect(api.match(/^\s+offre: \{ vue: vueOffre \},$/gm)).toHaveLength(2);
    // L'exploitation vide le cache de CE process : sans quoi un espace ramené en Base garderait l'Entreprise 30 s.
    expect(api).toMatch(/opsOffre: \{ store: offresStore, invalider: \(tenant\) => offres\.invalider\(tenant\) \},/);
    expect(api).toMatch(/badgeDeLOffre: async \(tenant\) => \(await offres\.offreDe\(tenant\)\)\.droits\.limites\.badge,/);
  });

  it('🔴 le webhook du Pro vide le cache de l’offre de la copie qui reçoit, et le paiement connaît le Pro vivant (lot 6, B1)', () => {
    const api = lire('index.ts');
    const webhookPro = api.slice(api.indexOf('stripeWebhook: {'));
    const blocPro = webhookPro.slice(webhookPro.indexOf('pro: {'), webhookPro.indexOf('pro: {') + 900);
    expect(blocPro).toMatch(/invalider: \(tenant\) => offres\.invalider\(tenant\),/);
    expect(blocPro).toMatch(/enregistrer: \(a\) => abonnementsOffre\.enregistrer\(a\),/);
    expect(api).toMatch(/proVivant: \(tenant\) => abonnementsOffre\.vivant\(tenant\),/);
    expect(api).toMatch(/ouvrir: \(tenant, periodicite, payeur\) => ouvrirPro\(proDeLaConsole, tenant, periodicite, payeur\),/);
  });

  it('🔴 le gel des membres en trop (lot 6, B2a) : la session de la console ET le jeton de Claude le lisent', () => {
    // Les types exigent `horsOffre` ; seul ce texte dit qu'il vient du gel et pas d'un `null` posé en dur.
    const api = lire('index.ts');
    expect(api).toMatch(/const gelMembres = creerGelMembres\(\{ offres, rang: \(tenant, user\) => userStore\.rangMembre\(tenant, user\) \}\);/);
    // En parallèle de l'état du compte : chaque requête d'un espace limité n'attend pas un aller-retour de plus.
    expect(api).toMatch(/const \[s, horsOffre\] = await Promise\.all\(\[userStore\.getAuthState\(userId\), gelMembres\.horsOffre\(tenant, userId\)\]\);\s*return s && \{ \.\.\.s, horsOffre \};/);
    expect(api).toMatch(/return a && \{ \.\.\.a, horsOffre: a\.valide \? await gelMembres\.horsOffre\(a\.tenantId, a\.userId\) : null \};/);
  });

  it('🔴 l’API passe cette offre au serveur', () => {
    const api = lire('index.ts');
    const appel = api.slice(api.indexOf('buildServer({'));
    expect(appel.slice(0, appel.indexOf('\n  });'))).toMatch(/^\s+offres,$/m);
  });
});
