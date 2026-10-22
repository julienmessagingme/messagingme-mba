/**
 * LES CLÉS DE SIGNAL N'ENTRENT PAS DANS LES JOURNAUX (essai réel du 2026-10-22). `libsignal` (`session_record.js`)
 * passe la session entière, clés privées comprises, à `console.info` quand il en ouvre, en ferme ou en retire une, et à
 * `console.warn` quand elle est déjà fermée : le service de connexions les écrivait dans les journaux du conteneur. Ces
 * quatre messages s'écrivent sans la session ; tout le reste passe intact. Appelé une fois, au démarrage du service,
 * le seul processus qui tienne des sessions.
 */
export const PORTENT_UNE_SESSION: readonly string[] = ['Closing session:', 'Opening session:', 'Removing old closed session:', 'Session already closed'];

type Ecrire = (...a: unknown[]) => void;

export function taireLesClesDeSignal(c: { info: Ecrire; warn: Ecrire } = console): void {
  for (const niveau of ['info', 'warn'] as const) {
    const ecrire = c[niveau].bind(c);
    c[niveau] = (...a: unknown[]) => {
      if (typeof a[0] === 'string' && PORTENT_UNE_SESSION.includes(a[0])) ecrire(a[0]);
      else ecrire(...a);
    };
  }
}
