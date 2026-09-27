import type { RcsProvider, RcsOutbound, RcsCapabilities } from './types';
import type { SendResult } from '../meta/types';

export interface FakeRcsOptions {
  /** Numéros déclarés non joignables en RCS. */
  unreachable?: Set<string>;
}

export interface FakeSentRecord {
  agentId: string;
  e164: string;
  msg: RcsOutbound;
  messageId: string;
}

/**
 * Provider factice : démontre le canal RCS sans compte ouvert. Il reproduit les deux comportements du vrai
 * provider dont le reste du code dépend : la non-joignabilité rendue en `null`, et l'idempotence par
 * `messageId` par agent (deux agents au même identifiant envoient bien deux messages, comme chez RBM).
 */
export class FakeRcsProvider implements RcsProvider {
  readonly sent: FakeSentRecord[] = [];
  private readonly vus = new Set<string>();

  constructor(private readonly opts: FakeRcsOptions = {}) {}

  async capabilities(_tenantId: string, _agentId: string, e164: string): Promise<RcsCapabilities | null> {
    if (this.opts.unreachable?.has(e164)) return null;
    return { features: ['RICHCARD_STANDALONE', 'ACTION_CREATE_CALENDAR_EVENT'] };
  }

  async send(_tenantId: string, agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult> {
    const cle = `${agentId}:${messageId}`;
    if (this.vus.has(cle)) return { messageId };
    this.vus.add(cle);
    this.sent.push({ agentId, e164, msg, messageId });
    return { messageId };
  }
}
