import type { Pool } from 'pg';
import { FakeRcsProvider } from './fake';
import { SmsmodeRcsProvider } from './smsmode';
import { FetchTransport } from '../meta/http';
import { Reachability } from './reachability';
import { PgReachabilityStore } from './reachability.pg';
import { PgRcsAgentStore, PgRcsOptoutStore } from './store.pg';
import { RcsSender } from './sender';
import type { RcsProvider, RcsOutbound } from './types';
import { makeCampaignSender } from '../campaign/sender';
import type { CampaignSender } from '../campaign/sender';
import type { Campaign } from '../campaign/types';

/** Pile RCS assemblée UNE fois et partagée par le worker (campagnes) et l'exécuteur de scénarios. */
export interface RcsStack {
  sender: RcsSender;
  agents: PgRcsAgentStore;
  /** Sender de canal pour une campagne. null = campagne inexploitable (agent absent, message manquant). */
  senderForCampaign(campaign: Campaign): Promise<CampaignSender | null>;
}

export interface SmsmodeCredentials {
  /** Clé du serveur, utilisée en REPLI quand le tenant n'a pas la sienne. */
  apiKey: string;
  callbackUrlStatus?: string;
  callbackUrlMo?: string;
  /** Clé PROPRE au tenant (déchiffrée à la demande). C'est le cas normal dès la deuxième marque. */
  apiKeyFor?: (tenantId: string) => Promise<string | null>;
}

/**
 * Choisit le provider. `google` reste déclaré mais non implémenté : tant qu'il n'existe pas il LÈVE au
 * démarrage. Retomber en silence sur le factice ferait tourner un serveur qui croit envoyer du vrai RCS et
 * envoie dans le vide, ce qui est pire qu'un crash au boot. Seul DRY_RUN autorise ce repli, explicitement.
 */
function providerFor(nom: 'fake' | 'smsmode' | 'google', dryRun: boolean, smsmode?: SmsmodeCredentials): RcsProvider {
  // DRY_RUN prime sur le provider demandé, comme le `DryRunSender` du worker prime sur le client Meta. Sans
  // cette règle, un déploiement DRY_RUN=true enverrait du vrai RCS : le mode de test ne doit pas dépendre de
  // l'ordre dans lequel on pense à le brancher.
  if (dryRun || nom === 'fake') return new FakeRcsProvider();
  if (nom === 'smsmode') {
    // Une clé est exigée : soit celle du serveur, soit une résolution par workspace. Sans aucune des deux, le
    // provider partirait envoyer sans authentification et se prendrait un 401 à chaque message.
    if (!smsmode?.apiKey && !smsmode?.apiKeyFor) {
      throw new Error("RCS_PROVIDER=smsmode exige la clé du canal RCS (SMSMODE_RCS_API_KEY) ou une clé par workspace");
    }
    return new SmsmodeRcsProvider({
      transport: new FetchTransport(),
      apiKey: smsmode.apiKey,
      ...(smsmode.apiKeyFor ? { apiKeyFor: smsmode.apiKeyFor } : {}),
      ...(smsmode.callbackUrlStatus ? { callbackUrlStatus: smsmode.callbackUrlStatus } : {}),
      ...(smsmode.callbackUrlMo ? { callbackUrlMo: smsmode.callbackUrlMo } : {}),
    });
  }
  throw new Error(`RCS_PROVIDER=${nom} n'est pas encore implémenté. Disponibles : 'fake', 'smsmode'.`);
}

export function buildRcsStack(
  pool: Pool,
  providerName: 'fake' | 'smsmode' | 'google',
  dryRun: boolean,
  smsmode?: SmsmodeCredentials,
): RcsStack {
  const provider = providerFor(providerName, dryRun, smsmode);
  const agents = new PgRcsAgentStore(pool);
  const sender = new RcsSender(
    provider,
    new Reachability(provider, new PgReachabilityStore(pool)),
    new PgRcsOptoutStore(pool),
  );

  return {
    sender,
    agents,
    async senderForCampaign(campaign: Campaign): Promise<CampaignSender | null> {
      // L'agent et le message sont figés SUR la campagne à sa création (et validés là-bas). On ne va pas
      // rechercher l'agent du tenant ici : une campagne doit partir avec l'agent sous lequel elle a été
      // écrite, même si le tenant en a changé depuis.
      const agentId = campaign.rcsAgentId;
      const message = campaign.rcsMessage as RcsOutbound | null | undefined;
      if (!agentId || !message) return null;
      return makeCampaignSender({
        channel: 'rcs',
        tenantId: campaign.tenantId,
        agentId,
        message,
        rcs: sender,
      });
    },
  };
}
