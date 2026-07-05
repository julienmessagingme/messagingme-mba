/**
 * Installe un arrêt gracieux sur SIGTERM/SIGINT : ferme les ressources
 * (serveur, file, pool) puis sort. Filet de sécurité si le cleanup traîne.
 */
export function installGracefulShutdown(cleanup: () => Promise<void>, timeoutMs = 10000): void {
  let closing = false;
  const handler = (): void => {
    if (closing) return;
    closing = true;
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
