import type { Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';

export interface EmailAccountResolverDeps {
  getDecrypted(tenantId: string, accountId: string): Promise<DecryptedEmailAccount | null>;
  buildTransport(account: DecryptedEmailAccount): Transporter;
}

/** Cache le transport par boîte (une connexion SMTP réutilisable, pas reconstruite à chaque envoi).
 *  Invalidation explicite requise à chaque écriture/suppression de la boîte (routes email, Task 6) : le cache
 *  ne connaît aucun TTL. Clé de cache COMPOSITE `${tenantId}:${accountId}` : une clé accountId seul permettait à
 *  un hit de cache de renvoyer directement le compte (mot de passe en clair) d'un AUTRE tenant, sans jamais
 *  rappeler `getDecrypted`, qui est le seul point qui applique le scoping tenant réel. Avec la clé composite, un
 *  mauvais couple tenant/accountId est toujours un miss : `getDecrypted(tenantId, accountId)` est rappelé et
 *  rend `null` si le compte n'appartient pas à ce tenant. */
export class EmailAccountResolver {
  private readonly cache = new Map<string, { transport: Transporter; account: DecryptedEmailAccount }>();
  constructor(private readonly deps: EmailAccountResolverDeps) {}

  private cacheKey(tenantId: string, accountId: string): string {
    return `${tenantId}:${accountId}`;
  }

  async getTransport(
    tenantId: string,
    accountId: string,
  ): Promise<{ transport: Transporter; account: DecryptedEmailAccount } | null> {
    const key = this.cacheKey(tenantId, accountId);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const account = await this.deps.getDecrypted(tenantId, accountId);
    if (!account) return null;
    const entry = { transport: this.deps.buildTransport(account), account };
    this.cache.set(key, entry);
    return entry;
  }

  /** accountId est un uuid global (`gen_random_uuid()`), donc en pratique une seule entrée porte cet accountId
   *  dans le cache (un seul tenant a pu le lire avec succès). On supprime malgré tout PAR SUFFIXE `:${accountId}`
   *  plutôt que par une unique clé exacte, pour rester robuste même si plusieurs tenants ont chacun tenté ce
   *  couple (signature inchangée : l'appelant continue de n'invalider que par accountId). */
  invalidate(accountId: string): void {
    const suffix = `:${accountId}`;
    for (const [key, hit] of this.cache) {
      if (!key.endsWith(suffix)) continue;
      try {
        // Optionnel côté runtime (best-effort) : certains transports de test n'implémentent pas close().
        hit.transport.close?.();
      } catch {
        /* best-effort : l'invalidation ne doit jamais faire échouer l'appelant */
      }
      this.cache.delete(key);
    }
  }
}
