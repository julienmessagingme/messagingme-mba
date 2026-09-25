import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DES SIGNAUX, lu dans le CODE et pas dans la prose (spec 2026-09-24, § 8).
 *
 * Le typage impose déjà une partie des branchements (le puits des accusés et celui des réponses sont requis
 * par `handleWebhookJob`, le signal du clic par `LinksRouteDeps`). Ce test garde ce que le typage ne voit pas :
 * les dépendances optionnelles (l'annonce d'opt-out du dépôt des contacts) et les fermetures écrites en ligne
 * (les rappels RCS, la sortie de l'analyse).
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const api = sansCommentaires(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));

describe('le câblage des signaux dans l’API', () => {
  it('🔴 les désabonnements écrits par l’API (fiche, action en masse, API publique) deviennent des signaux', () => {
    expect(api).toMatch(/new PgContactStore\(\s*pool,\s*annoncerAussiAuxSignaux\(/);
  });

  it('🔴 le rapport de livraison RCS remonte ses accusés', () => {
    expect(api).toMatch(/signalDeLAccuse\(\{ messageId: dlr\.messageId/);
  });

  it('🔴 la réponse RCS et son STOP remontent', () => {
    expect(api).toMatch(/signalDeLaReponse\(\{\s*messageId: mo\.messageId/);
    // Avec l'identifiant du message STOP : c'est lui qui rend le signal stable si le fournisseur le redélivre.
    expect(api).toMatch(/signalDesabonnement\(mo\.from, 'rcs', mo\.messageId\)/);
  });

  it('le clic attribué remonte', () => {
    expect(api).toMatch(/signalerClic: \(tenant, contactId, code\) => emetteur\.emettreSignal\(tenant, signalDuClic\(contactId, code\)\)/);
  });

  it('🔴 le réglage invalide le cache de l’émetteur de l’API (enregistrer ET débrancher)', () => {
    expect(api.match(/espacesBatch\.invalider\('actifs'\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

const worker = sansCommentaires(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));

describe('le câblage des signaux dans le worker', () => {
  it('🔴 les désabonnements écrits par le worker (le STOP WhatsApp) deviennent des signaux', () => {
    expect(worker).toMatch(/new PgContactStore\(\s*pool,\s*annoncerAussiAuxSignaux\(/);
  });

  it('🔴 le wamid du STOP suit jusqu’au dépôt : une flèche qui l’oublierait compilerait quand même', () => {
    // `InboundOptOut` déclare trois paramètres, et une flèche à deux lui reste assignable : le typage ne voit pas
    // l'oubli, et l'`em_event_id` du désabonnement redeviendrait un aléa.
    expect(worker).toMatch(/inboundOptOut: \(tenant, waId, messageId\) => contactStore\.setOptInByWaId\(tenant, waId, 'opted_out', SOURCE_STOP_WHATSAPP, messageId\)/);
  });

  it('🔴 les DEUX files qui voient des accusés passent le puits, et la réponse n’arrive que par une', () => {
    expect(worker.match(/signauxAccuse: puitsSignaux\.accuse/g)).toHaveLength(2);
    expect(worker.match(/signalReponse: puitsSignaux\.reponse/g)).toHaveLength(1);
  });

  it('🔴 la conversation analysée est un consommateur du point de sortie, AVANT l’automation qui peut sortir tôt', () => {
    const signal = worker.indexOf('emetteur.emettreSignal(stored.tenantId, signalAnalyse(stored.conversationId))');
    const automation = worker.indexOf("{ kind: 'analysis', waId: ctx.waId");
    expect(signal).toBeGreaterThan(-1);
    expect(automation).toBeGreaterThan(signal);
  });

  it('la file des signaux est consommée', () => {
    expect(worker).toMatch(/queue\.work\(FILE_SIGNAUX_BATCH, creerTravailSignauxBatch\(/);
  });
});
