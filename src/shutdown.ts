/**
 * Arrêt gracieux sur SIGTERM/SIGINT : prévient le travail en cours, ferme les ressources (serveur, file,
 * pool), puis sort. Un filet de sécurité tue le process si le cleanup traîne.
 *
 * 🔴 `onArret` EST APPELÉ EN PREMIER, ET SYNCHRONEMENT. C'est le correctif R4 : sans lui, un run de campagne
 * de deux heures continuait d'envoyer pendant qu'on fermait la file sous lui, jusqu'au SIGKILL de Docker. Il
 * lève un drapeau que le moteur lit à chaque destinataire, de sorte que le run s'arrête à la frontière d'un
 * envoi (jamais au milieu), rende son verrou, et laisse la campagne `running` avec ses destinataires en
 * attente : le balayage de reprise la relance au redémarrage.
 *
 * ⚠️ CE N'EST PAS LA GARANTIE, c'est le confort. Un run throttlé peut dormir jusqu'à une minute dans son
 * limiteur de débit avant de relire le drapeau, et Docker n'attend pas éternellement. La garantie, c'est le
 * balayage de reprise, qui rattrape aussi les arrêts brutaux (SIGKILL, panne, OOM). Le drapeau évite
 * simplement d'y recourir dans le cas courant.
 *
 * ⚠️ `timeoutMs` doit rester SOUS le `stop_grace_period` du `docker-compose.yml`, sinon Docker tue le process
 * avant que ce filet ne serve à quoi que ce soit, et relever l'un sans l'autre ne change rien.
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
