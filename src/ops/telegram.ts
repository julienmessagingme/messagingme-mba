import { config } from '../config';

/**
 * Petit client d'alerte Telegram, ENV-FIRST (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). Extrait des crons ops
 * (qui lisaient le config.json de l'hôte, inaccessible au conteneur worker). Contrat de robustesse :
 *  - no-op silencieux si non configuré (aucun appel réseau) ;
 *  - timeout dur (AbortSignal) + catch : ne bloque JAMAIS l'appelant et ne throw JAMAIS ;
 *  - retourne `true` seulement sur un 2xx, sinon `false` (l'appelant n'a rien à gérer).
 * Une panne Telegram ne doit pas pouvoir tuer le worker (le seul process qui envoie les messages).
 */
export async function sendTelegram(
  text: string,
  opts: { token?: string; chatId?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const token = opts.token ?? config.TELEGRAM_BOT_TOKEN;
  const chatId = opts.chatId ?? config.TELEGRAM_CHAT_ID;
  if (token === '' || chatId === '') return false; // alerting facultatif : non configuré = no-op
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Telegram plafonne un message à 4096 caractères : on tronque (une alerte n'a pas besoin du corps entier).
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[telegram] envoi KO:', res.status);
      return false;
    }
    return true;
  } catch (err) {
    // Réseau KO / timeout : on avale (best-effort). Ne throw JAMAIS.
    // eslint-disable-next-line no-console
    console.error('[telegram] envoi erreur:', err instanceof Error ? err.message : err);
    return false;
  }
}
