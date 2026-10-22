import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DES SIGNAUX, lu dans le CODE et pas dans la prose (spec 2026-09-24, § 8).
 *
 * Le typage impose déjà une partie des branchements (le puits des accusés et celui des réponses sont requis
 * par `handleWebhookJob`, le signal du clic par `LinksRouteDeps`). Ce test garde ce que le typage ne voit pas :
 * les points de passage RCS et la sortie de l'analyse. L'annonce d'opt-out du dépôt des
 * contacts, dépendance optionnelle, est construite une fois pour les deux processus par le socle, et
 * `tests/socle.test.ts` l'exécute : un STOP écrit par ce dépôt doit partir vers le connecteur et les signaux.
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const api = sansCommentaires(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));
const messageRcs = sansCommentaires(readFileSync(new URL('../src/rcs/message-entrant.ts', import.meta.url), 'utf8'));

describe('le câblage des signaux dans l’API', () => {
  it('🔴 le rapport de livraison RCS remonte ses accusés', () => {
    expect(api).toMatch(/signalDeLAccuse\(\{ messageId: dlr\.messageId/);
  });

  it('🔴 la réponse RCS et son STOP remontent', () => {
    expect(api).toMatch(/onMo: \(tenant, mo\) => traiterMessageEntrantRcs\(\{/);
    expect(api).toMatch(/signaux: emetteur/);
    expect(messageRcs).toMatch(/signalDeLaReponse\(\{\s*messageId: mo\.messageId/);
    // Avec l'identifiant du message STOP : c'est lui qui rend le signal stable si le fournisseur le redélivre.
    expect(messageRcs).toMatch(/signalDesabonnement\(mo\.from, 'rcs', mo\.messageId\)/);
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
  it('🔴 le wamid du STOP suit jusqu’au dépôt : une flèche qui l’oublierait compilerait quand même', () => {
    // `InboundOptOut` déclare trois paramètres, et une flèche à deux lui reste assignable : le typage ne voit pas
    // l'oubli, et l'`em_event_id` du désabonnement redeviendrait un aléa.
    expect(worker).toMatch(/inboundOptOut: \(tenant, waId, messageId\) => contactStore\.setOptInByWaId\(tenant, waId, 'opted_out', 'personne', SOURCE_STOP_WHATSAPP, messageId\)/);
  });

  it('🔴 les DEUX files qui voient des accusés passent le puits, et la réponse arrive par les deux files d’entrants, jamais par celle des accusés', () => {
    expect(worker.match(/signauxAccuse: puitsSignaux\.accuse/g)).toHaveLength(2);
    // Les entrants de Meta (`webhook`) et ceux de la filière application (`application-entrant`, 2026-10-22).
    expect(worker.match(/signalReponse: puitsSignaux\.reponse/g)).toHaveLength(2);
    const accuses = worker.slice(worker.indexOf("queue.work('webhook-status'"), worker.indexOf("queue.work('campaign-run'"));
    expect(accuses).not.toContain('signalReponse');
  });

  it('🔴 la conversation analysée est un consommateur du point de sortie, AVANT l’automation qui peut sortir tôt', () => {
    const signal = worker.indexOf('emetteur.emettreSignal(stored.tenantId, signalAnalyse(stored.conversationId))');
    const automation = worker.indexOf("kind: 'analysis', waId: ctx.waId");
    expect(signal).toBeGreaterThan(-1);
    expect(automation).toBeGreaterThan(signal);
  });

  it('🔴 l’événement d’analyse porte la copie de la fiche et toutes les valeurs (lot 3 de « Tout sur la fiche »)', () => {
    // Sans la copie, « un champ d'analyse devient » ne partirait jamais ; sans les valeurs, aucun filtre de
    // « conversation analysée » ne passerait. Les deux échecs sont silencieux : aucune erreur, juste rien.
    const bloc = worker.slice(worker.indexOf("kind: 'analysis', waId: ctx.waId"), worker.indexOf('automationRunnerDeps,', worker.indexOf("kind: 'analysis', waId: ctx.waId")));
    expect(bloc).toContain('valeurs: analyseDeLaConversation(stored, stored.conversationId, new Date())');
    expect(bloc).toContain('copie: copie ? { avant: copie.avant, apres: copie.apres } : null');
    expect(worker).toContain('const copie = stored.copieFiche;');
  });

  it('la file des signaux est consommée', () => {
    expect(worker).toMatch(/queue\.work\(FILE_SIGNAUX_BATCH, creerTravailSignauxBatch\(/);
  });
});
