import type { RcsProvider, RcsOutbound, RcsCapabilities } from './types';
import type { SendResult } from '../meta/types';

export interface FakeRcsOptions {
  /** Numéros déclarés NON joignables en RCS. */
  unreachable?: Set<string>;
}

export interface FakeSentRecord {
  agentId: string;
  e164: string;
  msg: RcsOutbound;
  messageId: string;
}

/**
 * Provider factice : livre et démontre le canal RCS sans aucun compte ouvert (lot 1).
 *
 * Il reproduit les DEUX comportements du vrai provider dont le reste du code dépend, et rien d'autre :
 * la non-joignabilité rendue en `null`, et l'idempotence par `messageId` PAR AGENT (deux agents qui
 * utilisent le même identifiant envoient bien deux messages, comme chez RBM).
 */
export class FakeRcsProvider implements RcsProvider {
  readonly sent: FakeSentRecord[] = [];
  private readonly vus = new Set<string>();

  constructor(private readonly opts: FakeRcsOptions = {}) {}

  async capabilities(_agentId: string, e164: string): Promise<RcsCapabilities | null> {
    if (this.opts.unreachable?.has(e164)) return null;
    return { features: ['RICHCARD_STANDALONE', 'ACTION_CREATE_CALENDAR_EVENT'] };
  }

  async send(agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult> {
    const cle = `${agentId}:${messageId}`;
    if (this.vus.has(cle)) return { messageId };
    this.vus.add(cle);
    this.sent.push({ agentId, e164, msg, messageId });
    return { messageId };
  }
}
