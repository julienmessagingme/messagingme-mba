import { describe, expect, it } from 'vitest';
import { parseAgentTurnJob } from '../src/agent/turn-job';

const valide = {
  tenantId: 't', runId: 'r', sessionId: 's', workflowId: 'w',
  nodeId: 'n1', waId: '33600000000', raison: 'message', tours: 3,
};

describe('parseAgentTurnJob', () => {
  it('accepte un payload complet', () => {
    expect(parseAgentTurnJob(valide)).toEqual(valide);
  });

  it('rend null plutot que de lever sur un payload inexploitable', () => {
    expect(parseAgentTurnJob(null)).toBeNull();
    expect(parseAgentTurnJob({})).toBeNull();
    expect(parseAgentTurnJob({ ...valide, raison: 'autre' })).toBeNull();
    expect(parseAgentTurnJob({ ...valide, tours: 1.5 })).toBeNull();
    expect(parseAgentTurnJob({ ...valide, tenantId: '' })).toBeNull();
  });

  it('accepte le tour zero, qui est le demarrage', () => {
    expect(parseAgentTurnJob({ ...valide, raison: 'demarrage', tours: 0 })).not.toBeNull();
  });
});
