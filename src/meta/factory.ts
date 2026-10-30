import { MetaClient } from './client';
import { MetaTemplateClient, type ClientModeles } from './templates';
import { Template360dialogClient } from './templates-360dialog';
import { MetaFlowClient } from './flows';
import { MetaPricingClient } from './pricing';
import { MetaPhoneNumberClient } from './phone-number';
import { MetaPhoneRegisterClient } from './phone-register';
import { MbaClient } from '../mba/client';
import type { HttpTransport } from './http';
import type { MessageSender } from '../campaign/engine';
import type { MetaCredentialsResolver, ResolvedToken } from './credentials';
import type { ArbitreDeDebit } from './arbitre-debit';
import { NumeroBloqueError, NumeroDelieError, NumeroSuspenduError } from './numero-delie';
import { MetaApiError } from './errors';
import type { MarketingParams, SendResult, TemplateSpec } from './types';
import { RetraitDeLaListeRefuse, type ListeDeLAgent } from '../mba/liste';
import { LimiteOffreError } from '../offres/refus';
import type { VerdictModeles } from '../offres/compteurs';
import type { GardeCreditWhatsapp, NatureEnvoi } from '../credit-whatsapp/garde';

/**
 * Ce qu'un appel `send*` du client Meta dit de son envoi : le destinataire et sa nature (message libre, marketing par la
 * MM API, modèle à catégorie lue chez Meta). Un `sendMessage` au format de Meta peut porter un modèle.
 */
function envoiDeLAppel(methode: string, args: readonly unknown[]): { destinataire: string; nature: NatureEnvoi } {
  if (methode === 'sendMarketing') {
    const p = (args[0] ?? {}) as MarketingParams;
    return { destinataire: p.to ?? p.recipient ?? '', nature: { type: 'marketing' } };
  }
  const destinataire = typeof args[0] === 'string' ? args[0] : '';
  if (methode === 'sendTemplate') {
    const tpl = (args[1] ?? {}) as Partial<TemplateSpec>;
    return { destinataire, nature: { type: 'modele', name: String(tpl.name ?? ''), language: String(tpl.language ?? '') } };
  }
  if (methode === 'sendMessage') {
    const corps = (args[1] ?? {}) as { type?: unknown; template?: { name?: unknown; language?: unknown } };
    if (corps.type === 'template') {
      const langue = corps.template?.language;
      const code = typeof langue === 'object' && langue !== null ? (langue as { code?: unknown }).code : langue;
      return { destinataire, nature: { type: 'modele', name: String(corps.template?.name ?? ''), language: String(code ?? '') } };
    }
  }
  return { destinataire, nature: { type: 'libre' } };
}

/**
 * Un refus NET : rien n'est parti. Une réponse d'erreur de Meta sous 500 (`MetaApiError` 4xx, 429 compris), le retrait
 * de la liste refusé (un 503 levé chez nous, AVANT l'appel), ou une garde levée avant lui (numéro bloqué, modèles du
 * mois). Un 5xx de Meta, un délai, une panne réseau laissent un doute : le message est peut-être parti, la provision
 * reste et la régularisation tranche.
 */
function estUnRefusNet(err: unknown): boolean {
  return (err instanceof MetaApiError && (err.httpStatus < 500 || err instanceof RetraitDeLaListeRefuse))
    || err instanceof NumeroBloqueError || err instanceof LimiteOffreError;
}

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
  /**
   * La garde du Crédit WhatsApp (`src/credit-whatsapp/garde.ts`) : avant chaque `send*` d'un numéro sur la ligne de
   * crédit, la provision du message, et rien ne part si le solde ne la couvre pas (`CreditWhatsappRefus`). 🔴 Requise,
   * pour la même raison que `numerosDelies` : oubliée par un câblage, elle laisserait partir sur notre ligne des messages
   * que personne n'a payés. Les fixtures disent leur hypothèse (`sansLigneDeCredit`, `tests/credit-whatsapp-fixtures.ts`).
   */
  creditWhatsapp: GardeCreditWhatsapp;
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
    // La seule résolution qui rend une clé 360dialog : l'envoi sait lui parler (`MetaClient`, `fournisseur`).
    const resolu = await this.o.resolver.resolvePourEnvoi(tenantId);
    const { token, fournisseur } = resolu;
    const client = new MetaClient({
      transport: this.o.transport,
      token,
      fournisseur,
      phoneNumberId,
      version: this.o.version,
      marketingViaLite: this.o.marketingViaLite,
      // La porte du numéro, partagée par tout ce qui envoie depuis lui. `MetaClient.call` l'acquiert avant chaque
      // appel `messages`, et seulement celui-là : lire un template ou téléverser un média ne consomme pas le budget.
      ...(this.o.arbitreDebit ? { rateLimiter: this.o.arbitreDebit.pour(phoneNumberId) } : {}),
    });
    const garde = this.avantUnModele(this.guard(client, resolu), tenantId);
    // Un compte 360dialog n'est jamais sur la ligne de crédit : sa facturation est ailleurs (décidé sur le fournisseur déjà
    // rendu par `resolvePourEnvoi`, sans autre lecture).
    return fournisseur === '360dialog' ? garde : this.avecCreditWhatsapp(garde, tenantId, phoneNumberId);
  }

  /**
   * Les modèles de l'espace (lot 2, livraison B) : par la résolution d'ENVOI, qui rend la clé d'un compte 360dialog, et
   * le client qui sait lui parler. Pour un compte Meta, rien ne change : même jeton, même repli.
   */
  async templateClientForTenant(tenantId: string): Promise<ClientModeles> {
    const resolu = await this.o.resolver.resolvePourEnvoi(tenantId);
    // 🔴 Chez 360dialog, pas d'intercepteur : un 401 sur une liste de modèles (le chemin de TOUT envoi de modèle) ou un
    // refus de fonctionnalité qui en prendrait la forme ne doit pas invalider la clé et couper tous les envois. Seul un
    // envoi juge la clé (`clientForTenant`). Le principe est celui de `MetaFlowClient.ecranDEntree`.
    if (resolu.fournisseur === '360dialog') return new Template360dialogClient(resolu.token);
    return this.guard(new MetaTemplateClient(resolu.token, this.o.version), resolu);
  }

  /** Les Flows de l'espace (livraison C) : même règle, `MetaFlowClient` reçoit le fournisseur. */
  async flowClientForTenant(tenantId: string): Promise<MetaFlowClient> {
    const resolu = await this.o.resolver.resolvePourEnvoi(tenantId);
    const client = new MetaFlowClient(resolu.token, this.o.version, undefined, undefined, resolu.fournisseur);
    // Comme les modèles : chez 360dialog, une opération sur les Flows n'invalide jamais la clé.
    return resolu.fournisseur === '360dialog' ? client : this.guard(client, resolu);
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

  /**
   * Un client construit avec le jeton de l'espace, et enveloppé de l'intercepteur (`guard`). 🔴 Un client GRAPH : pour
   * un compte 360dialog, `resolveForTenant` lève `CompteChez360dialog` et rien n'est construit, donc rien ne part chez
   * Meta avec sa clé (le statut du numéro, l'agent de Meta, le tarif échouent fermés). Modèles et Flows n'y passent plus :
   * ils savent parler à 360dialog.
   */
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
   * La garde du Crédit WhatsApp, la plus EXTÉRIEURE : elle passe avant la limite des modèles du mois et le retrait de la
   * liste de l'agent (`avantUnModele`), pour qu'un crédit nul ne coûte ni une unité du mois ni un appel à Meta. Elle
   * enveloppe TOUTES les méthodes `send*` du client, telles qu'il les définit : une méthode d'envoi ajoutée au client est
   * gardée sans rien écrire ici (inventaire `tests/credit-whatsapp-inventaire.test.ts`). Une provision par appel : les
   * rejeux internes du client (`withRetry`, le repli de `sendMarketing` sur 134101) se font sous elle, sans la reprendre.
   */
  private avecCreditWhatsapp(client: MetaClient, tenantId: string, phoneNumberId: string): MetaClient {
    const garde = this.o.creditWhatsapp;
    return new Proxy(client, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof prop !== 'string' || !prop.startsWith('send') || typeof value !== 'function') return value;
        return async (...args: unknown[]): Promise<SendResult> => {
          const { provisionId } = await garde.avant({ tenantId, phoneNumberId, ...envoiDeLAppel(prop, args) });
          try {
            const res = await (value as (...a: unknown[]) => Promise<SendResult>).apply(obj, args);
            if (provisionId !== null) await garde.apres(provisionId, res.messageId);
            return res;
          } catch (err) {
            if (provisionId !== null) await garde.surEchec(provisionId, estUnRefusNet(err));
            throw err;
          }
        };
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
