import type { TravauxEnVol } from './lib/en-vol';

/** Le filet de l'arrêt : au-delà, le process sort en échec. Sous le `stop_grace_period` de 30 s du `docker-compose.yml`. */
export const FILET_ARRET_MS = 25_000;

/**
 * Arrêt gracieux sur SIGTERM/SIGINT : prévient le travail en cours, ferme les ressources (serveur, file, pool),
 * puis sort. Un filet tue le process si le cleanup traîne.
 *
 * `onArret` est appelé en premier et synchronement : il lève le drapeau que le moteur de campagne lit à chaque
 * destinataire, pour que le run s'arrête entre deux envois, rende son verrou et laisse la campagne `running`.
 * C'est un confort (un run throttlé peut dormir une minute avant de relire le drapeau) : la garantie est le
 * balayage de reprise au redémarrage, qui rattrape aussi les arrêts brutaux.
 *
 * `timeoutMs` doit rester sous le `stop_grace_period` du `docker-compose.yml`, sinon Docker tue le process avant.
 */
export function installGracefulShutdown(
  cleanup: () => Promise<void>,
  timeoutMs = FILET_ARRET_MS,
  onArret?: () => void,
): void {
  let closing = false;
  const handler = (): void => {
    if (closing) return;
    closing = true;
    onArret?.();
    const t = setTimeout(() => process.exit(1), timeoutMs);
    t.unref();
    cleanup()
      .then(() => {
        clearTimeout(t);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

/**
 * L'arrêt de l'API, dans cet ordre : le serveur (plus aucune requête, celles en cours finissent), puis les travaux que
 * les réponses ont laissés derrière elles, au plus `borneMs` depuis le DÉBUT de l'arrêt, puis la file et le pool.
 * L'attente vient après le serveur : une requête en cours au signal peut encore lancer un travail. Et avant la file et
 * le pool : un envoi qui continue les utilise jusqu'au bout.
 */
export async function arreterApi(p: {
  fermerServeur(): Promise<void>;
  travaux: Pick<TravauxEnVol, 'attendre'>;
  borneMs: number;
  fermerFile(): Promise<void>;
  fermerPool(): Promise<void>;
  journal(ligne: string): void;
}): Promise<void> {
  const debut = Date.now();
  await p.fermerServeur();
  const restants = await p.travaux.attendre(Math.max(0, p.borneMs - (Date.now() - debut)));
  if (restants > 0) p.journal(`arret: ${restants} geste(s) encore en cours après ${p.borneMs} ms, coupé(s)`);
  await p.fermerFile();
  await p.fermerPool();
}
