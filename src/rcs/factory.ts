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

/** Pile RCS assemblée UNE fois et partagée par le worker (campagnes) et l'exécuteur de scénarios. */
export interface RcsStack {
  sender: RcsSender;
  agents: PgRcsAgentStore;
  /** Opt-out du canal. Exposé parce que le webhook de réponses doit ÉCRIRE dedans quand un contact dit STOP. */
  optout: PgRcsOptoutStore;
  /**
   * Sender de canal pour une campagne. null = campagne inexploitable (agent absent, message manquant).
   *
   * ⚠️ `message` EST CELUI DE L'ÉTAGE, PAS TOUJOURS CELUI DE LA CAMPAGNE. Un repli RCS sur une campagne
   * WhatsApp a son message sur SA ligne d'étage, et `campaign.rcsMessage` y vaut `null` : construire le
   * sender sur la campagne enverrait un message vide, ou rien. Absent -> celui de la campagne, qui est le
   * contenu du rang 1 (invariant de la migration 0134).
   */
  senderForCampaign(campaign: Campaign, message?: unknown): Promise<CampaignSender | null>;
}

export interface SmsmodeCredentials {
  /** Clé du serveur, utilisée en REPLI quand le tenant n'a pas la sienne. */
  apiKey: string;
  callbackUrlStatus?: string;
  callbackUrlMo?: string;
  /** Adresse de rappel propre au workspace (livraison + réponses). Prime sur les deux URLs globales. */
  callbackUrlFor?: (tenantId: string) => Promise<string | null>;
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
      ...(smsmode.callbackUrlFor ? { callbackUrlFor: smsmode.callbackUrlFor } : {}),
    });
  }
  throw new Error(`RCS_PROVIDER=${nom} n'est pas encore implémenté. Disponibles : 'fake', 'smsmode'.`);
}

export function buildRcsStack(
  pool: Pool,
  providerName: 'fake' | 'smsmode' | 'google',
  dryRun: boolean,
  smsmode?: SmsmodeCredentials,
  /** Variables `{{champ}}` d'un contact, par numéro. Absente -> les messages partent avec leurs accolades. */
  varsFor?: (tenantId: string, e164: string) => Promise<Record<string, string | null>>,
  /**
   * Traçage des liens du message (migration 0107). Absent -> les messages partent avec les adresses saisies
   * et aucun clic n'est mesuré, ce qui est le comportement d'avant. Injecté plutôt que construit ici : ce
   * module ne lit pas la config, et l'adresse publique de la console y est nécessaire.
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
      // L'agent est figé SUR la campagne à sa création (et validé là-bas), y compris quand le RCS n'est
      // qu'un étage de repli d'une campagne WhatsApp (`src/http/campaigns.ts` l'exige alors). On ne va pas
      // rechercher l'agent du tenant ici : une campagne doit partir avec l'agent sous lequel elle a été
      // écrite, même si le tenant en a changé depuis.
      const agentId = campaign.rcsAgentId;
      const message = (messageDeLEtage ?? campaign.rcsMessage) as RcsOutbound | null | undefined;
      if (!agentId || !message) return null;
      return makeCampaignSender({
        channel: 'rcs',
        tenantId: campaign.tenantId,
        agentId,
        message,
        rcs: sender,
        // Résolution par destinataire UNIQUEMENT si le message porte des variables : une campagne de 5 000
        // numéros sur un message figé ne doit pas déclencher 5 000 lectures de fiche pour rien.
        ...(varsFor && aDesVariables(message) ? { varsFor } : {}),
      });
    },
  };
}
