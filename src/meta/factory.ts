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
  /**
   * Arbitre de débit PAR NUMÉRO (lot 4). Injecté ici parce que c'est le point où les quatre chemins d'envoi
   * se rejoignent : campagne, scénario, automation et réponse d'inbox construisent tous leur client par
   * `clientForTenant`. Un chemin d'envoi futur en hérite donc sans que personne y pense.
   *
   * OPTIONNEL : absent -> aucun frein par numéro, comportement d'avant (fixtures de test).
   */
  arbitreDebit?: ArbitreDeDebit;
  /**
   * Ce numéro est-il DÉLIÉ de son espace (migration 0180) ? Oui : aucun client d'envoi n'est construit, et
   * `clientForTenant` lève `NumeroDelieError`, dont le message dit quoi faire.
   *
   * 🔴 REQUISE, et c'est la leçon du dépôt : une garde optionnelle absente ne tourne pas, et le câblage qui
   * l'oublie compile, se déploie et envoie depuis un numéro que l'administrateur croit éteint. Les fixtures
   * DISENT leur hypothèse (`jamaisDelie`).
   *
   * Posée ICI pour la même raison que l'arbitre de débit : c'est le point où tous les chemins d'envoi se
   * rejoignent, donc un chemin futur en hérite sans que personne y pense.
   */
  numeroDelie: (phoneNumberId: string) => Promise<boolean>;
}

export class MetaClientFactory {
  constructor(private readonly o: MetaClientFactoryOpts) {}

  /** Sender d'envoi pour un tenant (MessageSender = MetaClient enveloppé de l'intercepteur d'auth). */
  async senderForTenant(tenantId: string, phoneNumberId: string): Promise<MessageSender> {
    return this.clientForTenant(tenantId, phoneNumberId);
  }

  /** MetaClient complet pour un tenant (envois workflow : template/interactif/flow), enveloppé de l'intercepteur. */
  async clientForTenant(tenantId: string, phoneNumberId: string): Promise<MetaClient> {
    // AVANT le jeton : un numéro délié ne coûte ni la résolution du jeton ni, surtout, un appel à Meta.
    if (await this.o.numeroDelie(phoneNumberId)) throw new NumeroDelieError(phoneNumberId);
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    const client = new MetaClient({
      transport: this.o.transport,
      token,
      phoneNumberId,
      version: this.o.version,
      marketingViaLite: this.o.marketingViaLite,
      // La porte du NUMÉRO, partagée par tout ce qui envoie depuis lui. `MetaClient.call` l'acquiert avant
      // chaque appel `messages`, et seulement celui-là : lire un template ou téléverser un média ne consomme
      // pas le budget d'envoi.
      ...(this.o.arbitreDebit ? { rateLimiter: this.o.arbitreDebit.pour(phoneNumberId) } : {}),
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
   * Client d'ajout et de vérification d'un numéro, avec le jeton de l'espace.
   *
   * ⚠️ AVEC LE JETON DE L'ESPACE, ET PAS LE JETON MAISON : le numéro d'un client embarqué vit dans SON compte
   * WhatsApp, que notre jeton global ne voit pas. C'est la même raison qui fait passer `getPhone` par le
   * business token pendant l'inscription.
   */
  async phoneRegisterClientForTenant(tenantId: string): Promise<MetaPhoneRegisterClient> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(new MetaPhoneRegisterClient(token, this.o.version), wabaId);
  }

  /** Client de configuration de l'agent MBA. Pas de `version` : cette surface la passe par en-tête, pas par chemin. */
  async mbaClientForTenant(tenantId: string): Promise<MbaClient> {
    const { token, wabaId } = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(new MbaClient(token), wabaId);
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
