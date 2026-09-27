import type { Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';

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
 * 🔴 Clé composite `${tenantId}:${accountId}` : avec l'accountId seul, un hit rendrait le compte (mot de passe en
 * clair) d'un autre espace sans rappeler `comptes.getDecrypted`, seul point qui filtre sur l'espace.
 */
export class EmailAccountResolver {
  private readonly cache = new Map<string, { transport: Transporter; account: DecryptedEmailAccount; at: number }>();
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

  async getTransport(
    tenantId: string,
    accountId: string,
  ): Promise<{ transport: Transporter; account: DecryptedEmailAccount } | null> {
    const key = this.cacheKey(tenantId, accountId);
    const hit = this.cache.get(key);
    if (hit) {
      if (this.now() - hit.at < this.ttl) return { transport: hit.transport, account: hit.account };
      this.closeAndDelete(key, hit.transport); // expiré : traité comme un miss, reconstruction ci-dessous
    }

    const account = await this.deps.comptes.getDecrypted(tenantId, accountId);
    if (!account) return null;
    const entry = { transport: this.deps.buildTransport(account), account, at: this.now() };
    this.cache.set(key, entry);
    return { transport: entry.transport, account: entry.account };
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
