import { MetaClient } from './client';
import { MetaTemplateClient } from './templates';
import { MetaFlowClient } from './flows';
import { MetaPricingClient } from './pricing';
import { MetaPhoneNumberClient } from './phone-number';
import type { HttpTransport } from './http';
import type { MessageSender } from '../campaign/engine';
import type { MetaCredentialsResolver } from './credentials';

/**
 * Fabrique de clients Meta PAR TENANT (B1). Elle résout le token du tenant (résolveur, avec repli sur le token
 * global tant qu'aucun WABA n'a de credentials propres = SOMMEIL), construit le client, et l'enveloppe d'un
 * INTERCEPTEUR d'auth : toute méthode qui échoue sur une erreur d'auth Meta (190/401/OAuthException) invalide le
 * token du WABA (best-effort) puis rethrow. On arrête ainsi d'envoyer/lire sur un token mort au lieu de brûler
 * des appels Graph.
 *
 * L'intercepteur vit ICI (pas dans MetaClient) car MetaClient ne connaît que phoneNumberId + token, jamais le
 * wabaId : c'est la fabrique qui a le wabaId résolu sous la main. Il est appliqué UNIFORMÉMENT à toutes les
 * méthodes (envois ET lectures) via un Proxy -> les envois workflow (clientForTenant) s'auto-soignent aussi.
 * En SOMMEIL, wabaId est null -> l'intercepteur est un no-op (aucun WABA propre à invalider).
 */
export interface MetaClientFactoryOpts {
  resolver: MetaCredentialsResolver;
  transport: HttpTransport;
  version: string;
  marketingViaLite: boolean;
}

export class MetaClientFactory {
  constructor(private readonly o: MetaClientFactoryOpts) {}

  /** Sender d'envoi pour un tenant (MessageSender = MetaClient enveloppé de l'intercepteur d'auth). */
  async senderForTenant(tenantId: string, phoneNumberId: string): Promise<MessageSender> {
    return this.clientForTenant(tenantId, phoneNumberId);
  }

  /** MetaClient complet pour un tenant (envois workflow : template/interactif/flow), enveloppé de l'intercepteur. */
  async clientForTenant(tenantId: string, phoneNumberId: string): Promise<MetaClient> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    const client = new MetaClient({
      transport: this.o.transport,
      token,
      phoneNumberId,
      version: this.o.version,
      marketingViaLite: this.o.marketingViaLite,
    });
    return this.guard(client, wabaId);
  }

  async templateClientForTenant(tenantId: string): Promise<MetaTemplateClient> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(new MetaTemplateClient(token, this.o.version), wabaId);
  }

  async flowClientForTenant(tenantId: string): Promise<MetaFlowClient> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(new MetaFlowClient(token, this.o.version), wabaId);
  }

  async pricingClientForTenant(tenantId: string): Promise<MetaPricingClient> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(new MetaPricingClient(token, this.o.version), wabaId);
  }

  async phoneClientForTenant(tenantId: string): Promise<MetaPhoneNumberClient> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(new MetaPhoneNumberClient(token, this.o.version), wabaId);
  }

  /**
   * Enveloppe un client Meta : chaque méthode async qui rejette est interceptée. Sur une erreur d'AUTH, le WABA du
   * tenant est invalidé (resolver.onError filtre isMetaAuthError + wabaId non-null) ; l'erreur est TOUJOURS
   * rethrow (l'appelant garde son comportement). Non-fonctions et retours non-promesse passent inchangés.
   */
  private guard<T extends object>(target: T, wabaId: string | null): T {
    const resolver = this.o.resolver;
    return new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          const out = (value as (...a: unknown[]) => unknown).apply(obj, args);
          if (out && typeof (out as { then?: unknown }).then === 'function') {
            return (out as Promise<unknown>).then(
              (v) => v,
              async (err: unknown) => { await resolver.onError(err, wabaId); throw err; },
            );
          }
          return out;
        };
      },
    });
  }
}
