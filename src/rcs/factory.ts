import type { Pool } from 'pg';
import { FakeRcsProvider } from './fake';
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

/**
 * Choisit le provider. `fake` seul est implémenté au lot 1 : `google` est déclaré dans la config pour que le
 * jour du lot 2 soit un changement de variable, mais tant qu'il n'existe pas il LÈVE au démarrage. Retomber
 * en silence sur le factice ferait tourner un serveur qui croit envoyer du vrai RCS et envoie dans le vide,
 * ce qui est pire qu'un crash au boot.
 */
function providerFor(nom: 'fake' | 'google'): RcsProvider {
  if (nom === 'fake') return new FakeRcsProvider();
  throw new Error(`RCS_PROVIDER=${nom} n'est pas encore implémenté (lot 2). Seul 'fake' est disponible.`);
}

export function buildRcsStack(pool: Pool, providerName: 'fake' | 'google'): RcsStack {
  const provider = providerFor(providerName);
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
