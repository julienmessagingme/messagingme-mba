import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { ecouterErreursDuPool } from '../src/db/erreurs-pool';
import { capturerJournal } from './journal';

/**
 * 🔴 UNE CONNEXION INACTIVE QUI CASSE NE DOIT PAS ARRÊTER LE PROCESSUS. `pg-pool` émet `error` sur le pool quand le
 * pooler redémarre ou que le réseau coupe une connexion au repos ; sans écouteur, Node lève, et l'API comme le worker
 * s'arrêtent. Le lot C fait passer l'empilement des tâches de l'API par ce pool.
 */
describe('le pool applicatif écoute ses erreurs', () => {
  it('🔴 une erreur de connexion inactive est journalisée, et ne lève pas', async () => {
    const pool = new EventEmitter();
    ecouterErreursDuPool(pool);
    const { lignes } = await capturerJournal(async () => {
      expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    });
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ lvl: 'error', msg: 'pool_connexion_inactive_cassee' });
  });

  it('le pool unique du dépôt pose l’écouteur à sa création', () => {
    // Sans ce branchement, la fonction existerait et le pool réel resterait sans écouteur.
    const source = readFileSync(new URL('../src/db/pool.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/ecouterErreursDuPool\(pool\);/);
  });
});
