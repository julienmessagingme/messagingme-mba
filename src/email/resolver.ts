import type { Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';

export interface EmailAccountResolverDeps {
  getDecrypted(tenantId: string, accountId: string): Promise<DecryptedEmailAccount | null>;
  buildTransport(account: DecryptedEmailAccount): Transporter;
  /** TTL du cache transport en ms (défaut 5 min, calqué sur MetaCredentialsResolver). */
  cacheTtlMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

/** Cache le transport par boîte (une connexion SMTP réutilisable, pas reconstruite à chaque envoi).
 *  TTL court (5 min par défaut, calqué sur MetaCredentialsResolver, src/meta/credentials.ts) en PLUS de
 *  l'invalidation explicite (routes email, Task 6) : le WORKER construit sa PROPRE instance (voir worker.ts)
 *  et ne reçoit jamais l'invalidation posée par le process API, purement en mémoire. Sans TTL, un mot de passe
 *  SMTP changé ou un compte supprimé restait servi par le worker jusqu'au prochain redéploiement. invalidate()
 *  reste la voie rapide (immédiate, dans le process qui la reçoit) ; le TTL borne la staleness ailleurs.
 *  Clé de cache COMPOSITE `${tenantId}:${accountId}` : une clé accountId seul permettait à
 *  un hit de cache de renvoyer directement le compte (mot de passe en clair) d'un AUTRE tenant, sans jamais
 *  rappeler `getDecrypted`, qui est le seul point qui applique le scoping tenant réel. Avec la clé composite, un
 *  mauvais couple tenant/accountId est toujours un miss : `getDecrypted(tenantId, accountId)` est rappelé et
 *  rend `null` si le compte n'appartient pas à ce tenant. */
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

  /** Ferme un transport en best-effort (jamais throw) puis retire l'entrée du cache. Geste partagé par
   *  l'expiration TTL (getTransport) et invalidate() : même nettoyage, deux déclencheurs différents. */
  private closeAndDelete(key: string, transport: Transporter): void {
    try {
      // Optionnel côté runtime (best-effort) : certains transports de test n'implémentent pas close().
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

    const account = await this.deps.getDecrypted(tenantId, accountId);
    if (!account) return null;
    const entry = { transport: this.deps.buildTransport(account), account, at: this.now() };
    this.cache.set(key, entry);
    return { transport: entry.transport, account: entry.account };
  }

  /** accountId est un uuid global (`gen_random_uuid()`), donc en pratique une seule entrée porte cet accountId
   *  dans le cache (un seul tenant a pu le lire avec succès). On supprime malgré tout PAR SUFFIXE `:${accountId}`
   *  plutôt que par une unique clé exacte, pour rester robuste même si plusieurs tenants ont chacun tenté ce
   *  couple (signature inchangée : l'appelant continue de n'invalider que par accountId). */
  invalidate(accountId: string): void {
    const suffix = `:${accountId}`;
    for (const [key, hit] of this.cache) {
      if (key.endsWith(suffix)) this.closeAndDelete(key, hit.transport);
    }
  }
}
