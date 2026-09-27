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
  timeoutMs = 25000,
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
