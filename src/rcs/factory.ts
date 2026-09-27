import type { Pool } from 'pg';
import { FakeRcsProvider } from './fake';
import { SmsmodeRcsProvider } from './smsmode';
import { FetchTransport } from '../meta/http';
import { Reachability } from './reachability';
import { PgReachabilityStore } from './reachability.pg';
import { PgRcsAgentStore, PgRcsOptoutStore } from './store.pg';
import { RcsSender } from './sender';
import type { TraceurLiens } from './sender';
import type { RcsProvider, RcsOutbound } from './types';
import { aDesVariables } from './variables';
import { makeCampaignSender } from '../campaign/sender';
import type { CampaignSender } from '../campaign/sender';
import type { Campaign } from '../campaign/types';

/** Pile RCS assemblée une fois et partagée par le worker (campagnes) et l'exécuteur de scénarios. */
export interface RcsStack {
  sender: RcsSender;
  agents: PgRcsAgentStore;
  /** Opt-out du canal. Exposé parce que le webhook de réponses doit écrire dedans quand un contact dit STOP. */
  optout: PgRcsOptoutStore;
  /**
   * Sender de canal pour une campagne ; null = campagne inexploitable (agent absent, message manquant).
   * `message` est celui de l'étage : un repli RCS sur une campagne WhatsApp a son message sur sa ligne d'étage
   * et `campaign.rcsMessage` y vaut `null`. Absent : celui de la campagne, le contenu du rang 1.
   */
  senderForCampaign(campaign: Campaign, message?: unknown): Promise<CampaignSender | null>;
}

export interface SmsmodeCredentials {
  /** Clé du serveur, utilisée en repli quand le tenant n'a pas la sienne. */
  apiKey: string;
  callbackUrlStatus?: string;
  callbackUrlMo?: string;
  /** Adresse de rappel propre au workspace (livraison + réponses). Prime sur les deux URLs globales. */
  callbackUrlFor?: (tenantId: string) => Promise<string | null>;
  /** Clé propre au tenant (déchiffrée à la demande). C'est le cas normal dès la deuxième marque. */
  apiKeyFor?: (tenantId: string) => Promise<string | null>;
}

/** Choisit le provider. DRY_RUN force le factice quel que soit le provider demandé. */
function providerFor(nom: 'fake' | 'smsmode', dryRun: boolean, smsmode?: SmsmodeCredentials): RcsProvider {
  // DRY_RUN prime sur le provider demandé, comme le `DryRunSender` du worker prime sur le client Meta : sinon
  // un déploiement DRY_RUN=true enverrait du vrai RCS.
  if (dryRun || nom === 'fake') return new FakeRcsProvider();
  // Une clé est exigée (celle du serveur ou une par workspace) : sans elle, chaque message prendrait un 401.
  if (!smsmode?.apiKey && !smsmode?.apiKeyFor) {
    throw new Error("RCS_PROVIDER=smsmode exige la clé du canal RCS (SMSMODE_RCS_API_KEY) ou une clé par workspace");
  }
  return new SmsmodeRcsProvider({
    transport: new FetchTransport(),
    apiKey: smsmode.apiKey,
    ...(smsmode.apiKeyFor ? { apiKeyFor: smsmode.apiKeyFor } : {}),
    ...(smsmode.callbackUrlStatus ? { callbackUrlStatus: smsmode.callbackUrlStatus } : {}),
    ...(smsmode.callbackUrlMo ? { callbackUrlMo: smsmode.callbackUrlMo } : {}),
    ...(smsmode.callbackUrlFor ? { callbackUrlFor: smsmode.callbackUrlFor } : {}),
  });
}

export function buildRcsStack(
  pool: Pool,
  providerName: 'fake' | 'smsmode',
  dryRun: boolean,
  smsmode?: SmsmodeCredentials,
  /** Variables `{{champ}}` d'un contact, par numéro. Absente -> les messages partent avec leurs accolades. */
  varsFor?: (tenantId: string, e164: string) => Promise<Record<string, string | null>>,
  /**
   * Traçage des liens du message. Absent : adresses saisies, aucun clic mesuré. Injecté parce que ce module ne
   * lit pas la config, dont il faudrait l'adresse publique de la console.
   */
  traceur?: TraceurLiens,
): RcsStack {
  const provider = providerFor(providerName, dryRun, smsmode);
  const agents = new PgRcsAgentStore(pool);
  const optout = new PgRcsOptoutStore(pool);
  const sender = new RcsSender(provider, new Reachability(provider, new PgReachabilityStore(pool)), optout, traceur);

  return {
    sender,
    agents,
    optout,
    async senderForCampaign(campaign: Campaign, messageDeLEtage?: unknown): Promise<CampaignSender | null> {
      // L'agent est figé sur la campagne à sa création : une campagne part avec l'agent sous lequel elle a été
      // écrite, même si l'espace en a changé depuis.
      const agentId = campaign.rcsAgentId;
      const message = (messageDeLEtage ?? campaign.rcsMessage) as RcsOutbound | null | undefined;
      if (!agentId || !message) return null;
      return makeCampaignSender({
        channel: 'rcs',
        tenantId: campaign.tenantId,
        agentId,
        message,
        rcs: sender,
        // Résolution par destinataire seulement si le message porte des variables : pas 5 000 lectures de fiche pour
        // un message figé.
        ...(varsFor && aDesVariables(message) ? { varsFor } : {}),
      });
    },
  };
}
