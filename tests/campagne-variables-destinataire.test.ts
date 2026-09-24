import { describe, it, expect } from 'vitest';
import { buildRecipients, type BuildContact } from '../src/campaign/build';
import { makeCampaignSender } from '../src/campaign/sender';
import { RcsSender } from '../src/rcs/sender';
import { Reachability, type ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';
import { fusionnerVariables } from '../src/rcs/variables';
import { validateParamMapping } from '../src/crm/template';

const fiche = (id: string, over: Partial<BuildContact> = {}): BuildContact => ({
  id, phone_e164: `+3361234567${id.slice(-1)}`, bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in', ...over,
});

describe('buildRecipients : les variables du destinataire', () => {
  const mapping = validateParamMapping([{ position: 1, source: { type: 'variable', key: 'commande' } }], { accepterVariables: true })!;

  it('résout le template sur SES variables, et les garde pour l’envoi', () => {
    const r = buildRecipients('utility', mapping, [fiche('c1', { variables: { commande: '8412' } })], { now: new Date() });
    expect(r.skipped).toEqual([]);
    expect(r.recipients).toEqual([{ contactId: 'c1', toE164: '+33612345671', resolvedParams: ['8412'], variables: { commande: '8412' } }]);
  });

  it('variable absente : écarté en missing_variable, comme un champ vide', () => {
    const r = buildRecipients('utility', mapping, [fiche('c2')], { now: new Date() });
    expect(r.recipients).toEqual([]);
    expect(r.skipped).toEqual([{ contactId: 'c2', toE164: '+33612345672', reason: 'missing_variable', missing: [1] }]);
  });

  it('🔴 un destinataire sans variables ne porte AUCUNE clé `variables` : la console écrit ce qu’elle écrivait', () => {
    const r = buildRecipients('utility', [], [fiche('c3')], { now: new Date() });
    expect(Object.keys(r.recipients[0]!)).toEqual(['contactId', 'toE164', 'resolvedParams']);
  });
});

describe('fusionnerVariables', () => {
  it('🔴 la variable du destinataire PRIME sur le champ de fiche du même nom', () => {
    expect({ ...fusionnerVariables({ commande: 'fiche', prenom: 'Camille' }, { commande: '8412' }) }).toEqual({ commande: '8412', prenom: 'Camille' });
  });
  it('sans variables de destinataire, la table de la fiche telle quelle', () => {
    expect({ ...fusionnerVariables({ prenom: 'Camille' }, null) }).toEqual({ prenom: 'Camille' });
  });
  it('une table SANS prototype, comme contactVars', () => {
    expect(Object.getPrototypeOf(fusionnerVariables({}, {}))).toBeNull();
  });
});

class SansCache implements ReachabilityStore {
  async get() { return null; }
  async put() { /* rien */ }
}

function envoyeur() {
  const provider = new FakeRcsProvider();
  const rcs = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), { isOptedOut: async () => false });
  return { provider, rcs };
}

describe('makeCampaignSender : un message RCS et les variables du destinataire', () => {
  it('🔴 {{commande}} prend la variable du destinataire, {{prenom}} le champ de fiche', async () => {
    const { provider, rcs } = envoyeur();
    const s = makeCampaignSender({
      channel: 'rcs', tenantId: 't1', agentId: 'a1', rcs,
      message: { kind: 'text', text: 'Bonjour {{prenom}}, commande {{commande}}' },
      varsFor: async () => ({ prenom: 'Camille', commande: 'depuis la fiche' }),
    });
    await s.sendTo({ id: 'r1', toE164: '+33612345671', variables: { commande: '8412' } });
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Bonjour Camille, commande 8412' });
  });

  it('sans résolution de fiche câblée, les variables du destinataire s’appliquent quand même', async () => {
    const { provider, rcs } = envoyeur();
    const s = makeCampaignSender({ channel: 'rcs', tenantId: 't1', agentId: 'a1', rcs, message: { kind: 'text', text: 'Commande {{commande}}' } });
    await s.sendTo({ id: 'r2', toE164: '+33612345672', variables: { commande: '8412' } });
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Commande 8412' });
  });

  it('sans variables, le message part exactement comme avant', async () => {
    const { provider, rcs } = envoyeur();
    const s = makeCampaignSender({ channel: 'rcs', tenantId: 't1', agentId: 'a1', rcs, message: { kind: 'text', text: 'Commande {{commande}}' } });
    await s.sendTo({ id: 'r3', toE164: '+33612345673' });
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Commande {{commande}}' });
  });
});
