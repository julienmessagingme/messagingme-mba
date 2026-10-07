import { MetaClient } from './client';
import { MetaTemplateClient } from './templates';
import { MetaFlowClient } from './flows';
import { MetaPricingClient } from './pricing';
import { MetaPhoneNumberClient } from './phone-number';
import { MetaPhoneRegisterClient } from './phone-register';
import { MbaClient } from '../mba/client';
import type { HttpTransport } from './http';
import type { MessageSender } from '../campaign/engine';
import type { MetaCredentialsResolver, ResolvedToken } from './credentials';
import type { ArbitreDeDebit } from './arbitre-debit';
import { NumeroDelieError, NumeroSuspenduError } from './numero-delie';
import type { MarketingParams, TemplateSpec } from './types';
import type { ListeDeLAgent } from '../mba/liste';
import { LimiteOffreError } from '../offres/refus';
import type { VerdictModeles } from '../offres/compteurs';

/**
 * Fabrique de clients Meta par tenant. Elle résout le token du tenant (repli sur le token global quand le WABA
 * n'a pas de credentials propres), construit le client et l'enveloppe d'un intercepteur d'auth : toute méthode
 * qui échoue sur une erreur d'auth Meta (190, 401, OAuthException) invalide le token du WABA puis relance.
 *
 * L'intercepteur vit ici parce que seule la fabrique connaît le wabaId ; il s'applique à toutes les méthodes
 * (envois et lectures) par un Proxy. Sans WABA propre (wabaId null), il ne fait rien. Tous les envois passent par
 * ici : c'est aussi là que vivent le frein du numéro, la garde du numéro délié et le retrait de la liste de l'agent
 * de Meta avant un modèle.
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
  numerosDelies: { estDelie(phoneNumberId: string): Promise<boolean> };
  /**
   * Ce numéro est-il suspendu (lot 4 : l'abonnement de son numéro fourni est impayé depuis 7 jours, ou fini) ? Oui :
   * `clientForTenant` lève `NumeroSuspenduError`. 🔴 Requise, pour la même raison que `numerosDelies`. Les fixtures
   * disent leur hypothèse (`jamaisSuspendu`).
   */
  numerosSuspendus: { estSuspendu(phoneNumberId: string): Promise<boolean> };
  /**
   * La liste de l'agent de Meta (`src/mba/liste.ts`) : le client d'envoi retire le destinataire de la liste avant
   * tout modèle (`sendTemplate`, `sendMarketing`), et un retrait refusé veut dire aucun envoi. Un modèle rend la
   * conversation à l'agent chez Meta (mesuré le 2026-09-29) : sur la liste, l'agent répondrait à la réponse du
   * contact à la place du scénario. 🔴 Requise, pour la même raison que `numerosDelies` : une garde optionnelle
   * oubliée par un câblage compilerait et laisserait partir le modèle. Les fixtures disent leur hypothèse
   * (`listeToujoursVide`, `tests/meta-factory.test.ts`).
   */
  listeDeLAgent: Pick<ListeDeLAgent, 'retirerAvantUnModele'>;
  /**
   * Les modèles du mois de l'offre (lot 6, `QuotaModeles` dans `src/offres/compteurs.ts`) : le client d'envoi en
   * consomme une unité avant CHAQUE modèle, et seulement avant un modèle (un message dans la fenêtre de 24 h ne compte
   * jamais). Limite atteinte : `LimiteOffreError`, et rien ne part. 🔴 Requise, pour la même raison que
   * `numerosDelies` : une garde optionnelle oubliée par un câblage laisserait la Base envoyer sans limite. Les fixtures
   * disent leur hypothèse (`modelesIllimites`).
   */
  quotaModeles: { consommer(tenantId: string): Promise<VerdictModeles> };
}

export class MetaClientFactory {
  constructor(private readonly o: MetaClientFactoryOpts) {}

  /** Sender d'envoi pour un tenant (MessageSender = MetaClient enveloppé de l'intercepteur d'auth). */
  async senderForTenant(tenantId: string, phoneNumberId: string): Promise<MessageSender> {
    return this.clientForTenant(tenantId, phoneNumberId);
  }

  /**
   * Lève `NumeroDelieError` si ce numéro est délié, `NumeroSuspenduError` s'il est suspendu (le délié prime : c'est
   * le geste d'un administrateur), sans rien construire : la garde de `clientForTenant`, exposée pour qu'un appelant la
   * pose avant un effet qui précède l'envoi (`verifierNumeroWhatsApp`, le tour d'un agent). Mêmes lectures, mêmes caches.
   */
  async verifierNumero(phoneNumberId: string): Promise<void> {
    if (await this.o.numerosDelies.estDelie(phoneNumberId)) throw new NumeroDelieError(phoneNumberId);
    if (await this.o.numerosSuspendus.estSuspendu(phoneNumberId)) throw new NumeroSuspenduError(phoneNumberId);
  }

  /**
   * MetaClient complet pour un tenant (envois workflow : template/interactif/flow), enveloppé de l'intercepteur et
   * de la garde de la liste de l'agent (`avantUnModele`).
   */
  async clientForTenant(tenantId: string, phoneNumberId: string): Promise<MetaClient> {
    // Avant le jeton : un numéro délié ne coûte ni la résolution du jeton ni un appel à Meta.
    await this.verifierNumero(phoneNumberId);
    const resolu = await this.o.resolver.resolveForTenant(tenantId);
    const { token } = resolu;
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
    return this.avantUnModele(this.guard(client, resolu), tenantId);
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
    const resolu = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(fabrique(resolu.token), resolu);
  }

  /**
   * Retire le destinataire de la liste de l'agent de Meta avant chaque modèle, et seulement avant un modèle : un
   * message libre nous donne la conversation chez Meta, un modèle la rend à l'agent. Le retrait passe AVANT l'envoi,
   * et s'il est refusé l'envoi n'a pas lieu (`RetraitDeLaListeRefuse`, rejouable). Une lecture de notre table par
   * modèle, un appel à Meta pour les seuls contacts qui y sont.
   */
  private avantUnModele(client: MetaClient, tenantId: string): MetaClient {
    const liste = this.o.listeDeLAgent;
    const quota = this.o.quotaModeles;
    // La limite du mois passe AVANT le retrait de la liste : une limite atteinte ne doit coûter aucun appel à Meta.
    const consommer = async (): Promise<void> => {
      const v = await quota.consommer(tenantId);
      if (!v.ok) throw new LimiteOffreError(tenantId, 'envoisModelesMois', v.max);
    };
    return new Proxy(client, {
      get(obj, prop, receiver) {
        if (prop === 'sendTemplate') {
          return async (to: string, tpl: TemplateSpec) => {
            await consommer();
            await liste.retirerAvantUnModele(tenantId, to);
            return obj.sendTemplate(to, tpl);
          };
        }
        if (prop === 'sendMarketing') {
          return async (params: MarketingParams) => {
            await consommer();
            // `to` prime sur `recipient`, comme chez Meta : c'est ce destinataire-là qui recevra le modèle.
            await liste.retirerAvantUnModele(tenantId, params.to ?? params.recipient ?? '');
            return obj.sendMarketing(params);
          };
        }
        return Reflect.get(obj, prop, receiver);
      },
    });
  }

  /**
   * Enveloppe un client Meta : chaque méthode async qui rejette est interceptée. Sur une erreur d'auth, le jeton qui a
   * construit CE client est invalidé (`resolver.onError`, avec sa résolution : un jeton plus récent du même WABA n'est
   * pas touché) ; l'erreur est toujours relancée. Le reste passe inchangé.
   */
  private guard<T extends object>(target: T, resolu: ResolvedToken): T {
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
              async (err: unknown) => { await resolver.onError(err, resolu); throw err; },
            );
          }
          return out;
        };
      },
    });
  }
}
