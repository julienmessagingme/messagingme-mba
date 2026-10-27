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
    // Les contacts, les automations et les webhooks entrants : dans le socle, partagé par l'API et le worker. Les contacts
    // reçoivent aussi l'offre, qui dit ce que la limite compte (`contactsToutesOrigines`, 2026-10-25).
    expect(socle).toMatch(/async \(tenant\) => limiteContactsDe\(await offres\.offreDe\(tenant\)\),/);
    expect(socle).toMatch(/new PgAutomationStore\(pool, async \(tenant\) => \(await offres\.offreDe\(tenant\)\)\.droits\.limites\.automations\)/);
    expect(socle).toMatch(/new PgWebhookStore\(pool, async \(tenant\) => \(await offres\.offreDe\(tenant\)\)\.droits\.limites\.automations\)/);
    // Les membres et les suppressions du jour : dans l'API, seule à inviter et à purger.
    expect(api).toMatch(/const userStore = new PgUserStore\(pool, async \(tenant\) => \{/);
    // Une seule instance (lot 13, domaine 5) : la purge de la console, `DELETE /v1/contacts/{id}` et Claude
    // (`delete_contacts`, 2026-10-26) comptent ensemble. Le magasin des contacts lui dit si l'espace dépasse sa limite.
    expect(api).toMatch(/const quotaSuppressions = new QuotaSuppressions\(\{ offres, compteur: compteurDebit, contacts: contactStore \}\);/);
    expect(api).toMatch(/suppressionsDuJour: quotaSuppressions,\s*createOneContact:/);
    expect(api).toMatch(/effacement: \{ contacts: contactStore, suppressionsDuJour: quotaSuppressions, listeDeLAgent, enVol: travauxEnVol \},/);
  });

  it('🔴 la porte d’une Free pleine (2026-10-25) : le worker la pose sur les deux files d’entrants, sur le magasin des contacts', () => {
    const worker = lire('worker.ts');
    expect(worker).toMatch(/refuses: \(t, waIds\) => contactStore\.inconnusRefuses\(t, waIds\),/);
    expect(worker).toMatch(/prevenir: creerAlerteEspacePlein\(\{/);
    for (const file of ["await queue.work('webhook',", "await queue.work('application-entrant',"]) {
      const bloc = worker.slice(worker.indexOf(file));
      expect(bloc.slice(0, bloc.indexOf('}, { concurrency')), file).toMatch(/^\s+espacesPleins,$/m);
    }
  });

  it('🔴 la console, Claude, l’exploitation et le badge lisent la MÊME offre en cache', () => {
    const api = lire('index.ts');
    // Une seule vue, calculée sur l'offre en cache, pour la route de la console ET l'outil `get_plan`.
    expect(api).toMatch(/const vueOffre = creerVueOffre\(\{\s+offres, usage: \(tenant\) => offresStore\.usage\(tenant\), modelesDuMois: quotaModeles,/);
    // Le prix du Pro ne s'affiche que s'il se paie : Stripe câblé ET les deux prix posés (jaune 10 de la relecture de B1).
    expect(api).toMatch(/proEnVente: proDeLaConsole\.stripe !== null && proDeLaConsole\.prixProMois !== '' && proDeLaConsole\.prixProAn !== '',/);
    expect(api.match(/^\s+offre: \{ vue: vueOffre \},$/gm)).toHaveLength(1);
    // Claude lit la MÊME vue, et paie le Pro par la MÊME ouverture que la console, en revenant où l'outil le demande (offres v2).
    expect(api).toMatch(/offre: \{\s+vue: vueOffre,\s+pro: \{ ouvrir: \(tenant, periodicite, payeur, retour\) => ouvrirPro\(proDeLaConsole, tenant, periodicite, payeur, retour\) \},\s+\},/);
    // La clé d'API créée par Claude bute sur le MÊME plafond de l'offre que la console.
    expect(api.match(/limiteCles: limiteClesDeLOffre/g)).toHaveLength(2);
    // L'exploitation vide le cache de CE process : sans quoi un espace ramené en Base garderait l'Entreprise 30 s.
    expect(api).toMatch(/opsOffre: \{\s+store: offresStore, invalider: \(tenant\) => offres\.invalider\(tenant\), audit: auditSink,/);
    // Les gestes après la pose ou le retrait du Business (spec du 2026-10-27) : les VRAIES fonctions, sur les mêmes
    // dépendances que le webhook du Pro (`numeroInclus`), et le complément par le magasin qui tient les montants.
    expect(api).toMatch(/passageBusiness: \(tenant\) => surPassageEnPro\(numeroInclus, tenant, \{ arreterLeNumeroSeul: false \}\),/);
    expect(api).toMatch(/const offert = await esCredentialsStore\.completerCreditBusiness\(tenant\);/);
    expect(api).toMatch(/finOffreManuelle: \(tenant, finiLe\) => surFinDeLOffreManuelle\(numeroInclus, \{ tenantId: tenant, finiLe \}\),/);
    expect(api).toMatch(/badgeDeLOffre: async \(tenant\) => \(await offres\.offreDe\(tenant\)\)\.droits\.limites\.badge,/);
  });

  it('🔴 le webhook du Pro vide le cache de l’offre de la copie qui reçoit, et le paiement connaît le Pro vivant (lot 6, B1)', () => {
    const api = lire('index.ts');
    const webhookPro = api.slice(api.indexOf('stripeWebhook: {'));
    const blocPro = webhookPro.slice(webhookPro.indexOf('pro: {'), webhookPro.indexOf('pro: {') + 900);
    expect(blocPro).toMatch(/invalider: \(tenant\) => offres\.invalider\(tenant\),/);
    expect(blocPro).toMatch(/enregistrer: \(a\) => abonnementsOffre\.enregistrer\(a\),/);
    expect(api).toMatch(/proVivant: \(tenant\) => abonnementsOffre\.vivant\(tenant\),/);
    expect(api).toMatch(/ouvrir: \(tenant, periodicite, payeur\) => ouvrirPro\(proDeLaConsole, tenant, periodicite, payeur, 'offre'\),/);
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

  it('🔴 la vue lit l’abonnement Pro sur le résumé du magasin, et le webhook relit la fin chez Stripe (2026-10-26)', () => {
    const api = lire('index.ts');
    expect(api).toMatch(/abonnement: \(tenant\) => abonnementsOffre\.resume\(tenant\),/);
    expect(api).toMatch(/finPrevueChezStripe: \(abonnementId\) => finPrevueChezStripe\(gestionProDeLaConsole, abonnementId\),/);
  });
});
