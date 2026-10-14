import type { Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';
import { sendSmtpEmail, type SmtpMessage } from './smtp';

/** Un envoi préparé pour une boîte : ni son mot de passe ni son transport ne sortent du module. */
export type PreparedEmailSender = (message: SmtpMessage) => Promise<void>;

export interface EmailAccountResolverDeps {
  comptes: { getDecrypted(tenantId: string, accountId: string): Promise<DecryptedEmailAccount | null> };
  buildTransport(account: DecryptedEmailAccount): Transporter;
  /** TTL du cache transport en ms (défaut 5 min, comme MetaCredentialsResolver). */
  cacheTtlMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

/**
 * Cache le transport par boîte (sa configuration, pas une connexion : chaque envoi ouvre sa socket vérifiée).
 *
 * TTL court en plus de l'invalidation explicite : le worker a sa propre instance et ne reçoit jamais l'invalidation
 * posée par l'API, en mémoire. Sans TTL, un mot de passe SMTP changé ou un compte supprimé resterait servi.
 * 🔴 Clé composite `${tenantId}:${accountId}` : avec l'accountId seul, un hit enverrait depuis la boîte d'un autre
 * espace sans rappeler `comptes.getDecrypted`, seul point qui filtre sur l'espace.
 */
export class EmailAccountResolver {
  private readonly cache = new Map<string, { transport: Transporter; send: PreparedEmailSender; at: number }>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly deps: EmailAccountResolverDeps) {
    this.ttl = deps.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = deps.now ?? ((): number => Date.now());
  }

  private cacheKey(tenantId: string, accountId: string): string {
    return `${tenantId}:${accountId}`;
  }

  /** Ferme un transport en best-effort puis retire l'entrée du cache (expiration TTL ou invalidate()). */
  private closeAndDelete(key: string, transport: Transporter): void {
    try {
      // Best-effort : certains transports de test n'implémentent pas close().
      transport.close?.();
    } catch {
      /* best-effort : ne doit jamais faire échouer l'appelant */
    }
    this.cache.delete(key);
  }

  /** Résout la boîte avant l'envoi, pour distinguer « introuvable » d'un échec SMTP sans exposer ses secrets. */
  async prepareSend(
    tenantId: string,
    accountId: string,
  ): Promise<PreparedEmailSender | null> {
    const key = this.cacheKey(tenantId, accountId);
    const hit = this.cache.get(key);
    if (hit) {
      if (this.now() - hit.at < this.ttl) return hit.send;
      this.closeAndDelete(key, hit.transport); // expiré : traité comme un miss, reconstruction ci-dessous
    }

    const account = await this.deps.comptes.getDecrypted(tenantId, accountId);
    if (!account) return null;
    const transport = this.deps.buildTransport(account);
    const send: PreparedEmailSender = (message) => sendSmtpEmail(transport, account, message);
    const entry = { transport, send, at: this.now() };
    this.cache.set(key, entry);
    return send;
  }

  /** Supprime par suffixe `:${accountId}` plutôt que par clé exacte : plusieurs espaces ont pu tenter ce couple, et
   *  l'appelant n'invalide que par accountId. */
  invalidate(accountId: string): void {
    const suffix = `:${accountId}`;
    for (const [key, hit] of this.cache) {
      if (key.endsWith(suffix)) this.closeAndDelete(key, hit.transport);
    }
  }
}
