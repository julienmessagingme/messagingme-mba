import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Les deux purges de rétention vivent dans le `main()` du worker, que rien n'atteint : aucun test de
 * comportement ne peut prouver qu'elles TOURNENT. Ce test lit donc le câblage réel.
 *
 * Ce qu'il empêche, et qui serait SILENCIEUX : retirer un balayage. Rien ne casse, rien n'échoue, la table
 * recommence simplement à croître sans fin en gardant des données personnelles, et personne ne s'en aperçoit
 * avant l'audit suivant. C'est exactement comme ça que `webhook_events` a accumulé depuis le premier jour.
 */
describe('câblage des purges de rétention', () => {
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('le worker purge RÉELLEMENT les événements Meta bruts, sur la rétention configurée', () => {
    expect(worker, 'aucun appel à purgeOlderThan : la rétention de webhook_events ne tourne plus')
      .toMatch(/purgeOlderThan\(\s*config\.WEBHOOK_EVENTS_RETENTION_DAYS\s*\)/);
    expect(worker, 'le balayage doit être PROGRAMMÉ, pas seulement appelé une fois au démarrage')
      .toMatch(/taches\.programmer\('retention-evenements-meta'/);
  });

  it('le worker purge RÉELLEMENT les conversations périmées, sur la rétention configurée', () => {
    expect(worker, 'aucun appel à purgeConversationsOlderThan : la rétention des conversations ne tourne plus')
      .toMatch(/purgeConversationsOlderThan\(\s*config\.CONVERSATION_RETENTION_DAYS\s*\)/);
    expect(worker, 'le balayage doit être PROGRAMMÉ, pas seulement appelé une fois au démarrage')
      .toMatch(/taches\.programmer\('retention-conversations'/);
    expect(worker, "un échec de purge doit ALERTER").toMatch(/alert\('sweeper:conversation-retention'/);
  });

  it('et il purge toujours les payloads dormants des webhooks entrants (l’autre rétention)', () => {
    expect(worker).toMatch(/purgeStalePayloads\(\s*config\.WEBHOOK_PAYLOAD_RETENTION_DAYS\s*\)/);
  });

  it('un échec de purge ALERTE au lieu de passer inaperçu', () => {
    // Une purge qui échoue en silence, c'est une rétention qu'on croit active et qui ne l'est pas.
    expect(worker).toMatch(/alert\('sweeper:webhook-events'/);
  });
});
