import { MetaClient } from './client';
import { MetaTemplateClient } from './templates';
import { MetaFlowClient } from './flows';
import { MetaPricingClient } from './pricing';
import { MetaPhoneNumberClient } from './phone-number';
import { MetaPhoneRegisterClient } from './phone-register';
import { MbaClient } from '../mba/client';
import type { HttpTransport } from './http';
import type { MessageSender } from '../campaign/engine';
import type { MetaCredentialsResolver } from './credentials';
import type { ArbitreDeDebit } from './arbitre-debit';
import { NumeroDelieError } from './numero-delie';

/**
 * Fabrique de clients Meta par tenant. Elle résout le token du tenant (repli sur le token global quand le WABA
 * n'a pas de credentials propres), construit le client et l'enveloppe d'un intercepteur d'auth : toute méthode
 * qui échoue sur une erreur d'auth Meta (190, 401, OAuthException) invalide le token du WABA puis relance.
 *
 * L'intercepteur vit ici parce que seule la fabrique connaît le wabaId ; il s'applique à toutes les méthodes
 * (envois et lectures) par un Proxy. Sans WABA propre (wabaId null), il ne fait rien.
 */
export interface MetaClientFactoryOpts {
  resolver: MetaCredentialsResolver;
  transport: HttpTransport;
  version: string;
  marketingViaLite: boolean;
  /**
   * Arbitre de débit par numéro, posé ici parce que tous les chemins d'envoi construisent leur client par
   * `clientForTenant` : un chemin futur en hérite. Absent : aucun frein par numéro (fixtures de test).
   */
  arbitreDebit?: ArbitreDeDebit;
  /**
   * Ce numéro est-il délié de son espace ? Oui : aucun client d'envoi n'est construit et `clientForTenant` lève
   * `NumeroDelieError`. 🔴 Requise : une garde optionnelle oubliée par un câblage compilerait et enverrait depuis
   * un numéro que l'administrateur croit éteint. Les fixtures disent leur hypothèse (`jamaisDelie`).
   */
  numeroDelie: (phoneNumberId: string) => Promise<boolean>;
}

export class MetaClientFactory {
  constructor(private readonly o: MetaClientFactoryOpts) {}

  /** Sender d'envoi pour un tenant (MessageSender = MetaClient enveloppé de l'intercepteur d'auth). */
  async senderForTenant(tenantId: string, phoneNumberId: string): Promise<MessageSender> {
    return this.clientForTenant(tenantId, phoneNumberId);
  }

  /**
   * Lève `NumeroDelieError` si ce numéro est délié, sans rien construire : la garde de `clientForTenant`, exposée
   * pour qu'un appelant la pose avant un effet qui précède l'envoi (`verifierNumeroWhatsApp`). Même lecture, même cache.
   */
  async verifierNumero(phoneNumberId: string): Promise<void> {
    if (await this.o.numeroDelie(phoneNumberId)) throw new NumeroDelieError(phoneNumberId);
  }

  /** MetaClient complet pour un tenant (envois workflow : template/interactif/flow), enveloppé de l'intercepteur. */
  async clientForTenant(tenantId: string, phoneNumberId: string): Promise<MetaClient> {
    // Avant le jeton : un numéro délié ne coûte ni la résolution du jeton ni un appel à Meta.
    await this.verifierNumero(phoneNumberId);
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    const client = new MetaClient({
      transport: this.o.transport,
      token,
      phoneNumberId,
      version: this.o.version,
      marketingViaLite: this.o.marketingViaLite,
      // La porte du numéro, partagée par tout ce qui envoie depuis lui. `MetaClient.call` l'acquiert avant chaque
      // appel `messages`, et seulement celui-là : lire un template ou téléverser un média ne consomme pas le budget.
      ...(this.o.arbitreDebit ? { rateLimiter: this.o.arbitreDebit.pour(phoneNumberId) } : {}),
    });
    return this.guard(client, wabaId);
  }

  templateClientForTenant(tenantId: string): Promise<MetaTemplateClient> {
    return this.pour(tenantId, (token) => new MetaTemplateClient(token, this.o.version));
  }

  flowClientForTenant(tenantId: string): Promise<MetaFlowClient> {
    return this.pour(tenantId, (token) => new MetaFlowClient(token, this.o.version));
  }

  pricingClientForTenant(tenantId: string): Promise<MetaPricingClient> {
    return this.pour(tenantId, (token) => new MetaPricingClient(token, this.o.version));
  }

  phoneClientForTenant(tenantId: string): Promise<MetaPhoneNumberClient> {
    return this.pour(tenantId, (token) => new MetaPhoneNumberClient(token, this.o.version));
  }

  /**
   * Client d'ajout et de vérification d'un numéro, avec le jeton de l'espace et non le jeton maison : le numéro
   * d'un client embarqué vit dans son compte WhatsApp, que notre jeton global ne voit pas.
   */
  phoneRegisterClientForTenant(tenantId: string): Promise<MetaPhoneRegisterClient> {
    return this.pour(tenantId, (token) => new MetaPhoneRegisterClient(token, this.o.version));
  }

  /** Client de configuration de l'agent MBA. Pas de `version` : cette surface la passe par en-tête, pas par chemin. */
  mbaClientForTenant(tenantId: string): Promise<MbaClient> {
    return this.pour(tenantId, (token) => new MbaClient(token));
  }

  /** Un client construit avec le jeton de l'espace, et enveloppé de l'intercepteur (`guard`). */
  private async pour<T extends object>(tenantId: string, fabrique: (token: string) => T): Promise<T> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(fabrique(token), wabaId);
  }

  /**
   * Enveloppe un client Meta : chaque méthode async qui rejette est interceptée. Sur une erreur d'auth, le WABA du
   * tenant est invalidé (`resolver.onError`) ; l'erreur est toujours relancée. Le reste passe inchangé.
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
