import { journaliser } from '../lib/journal';

/**
 * 🔴 `pg-pool` émet `error` quand une connexion INACTIVE casse (redémarrage du pooler, coupure réseau). Sans écouteur,
 * Node traite l'événement comme une exception non rattrapée et le processus s'arrête, API comme worker. Le pool a
 * déjà retiré la connexion morte et en ouvrira une neuve à la prochaine demande : il ne reste qu'à le dire.
 */
export function ecouterErreursDuPool(pool: { on(evenement: 'error', ecouteur: (err: Error) => void): unknown }): void {
  pool.on('error', (err) => { journaliser('error', 'pool_connexion_inactive_cassee', { err }); });
}
