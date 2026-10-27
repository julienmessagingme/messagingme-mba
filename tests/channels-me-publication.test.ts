import { describe, expect, it } from 'vitest';
import { creerPublicationChannelsMe } from '../src/channels-me/publication';
import type { LienRow } from '../src/channels-me/link-store.pg';
import { lienWaMe } from '../src/lib/wa-me';
import { textePreRempli } from '../src/channels-me/jeton';
import type { AutomationInput } from '../src/automation/store.pg';
import type { Connexion, Message } from '../src/channels-me/types';

const TENANT_ID = 'tenant-1';
const WORKFLOW_ID = '11111111-1111-4111-8111-111111111111';
const AUTOMATION_ID = '22222222-2222-4222-8222-222222222222';

class FauxLiensPublication {
  constructor(readonly ordre: string[] = []) {}
  readonly crees: Array<{
    tenantId: string;
    workflowId: string;
    startNodeId: string | null;
    token: string;
    phrase: string;
    automationId: string | null;
    maxParHeure: number | null;
  }> = [];

  async messagesContenantLaPhrase(tenantId: string, phrase: string): Promise<number> {
    this.ordre.push(`verifie:${tenantId}:${phrase}`);
    return 0;
  }

  async create(tenantId: string, lien: Omit<this['crees'][number], 'tenantId'>): Promise<LienRow> {
    this.ordre.push('cree_lien');
    this.crees.push({ tenantId, ...lien });
    return {
      id: '33333333-3333-4333-8333-333333333333',
      tenantId,
      workflowId: lien.workflowId,
      startNodeId: lien.startNodeId,
      token: lien.token,
      phrase: lien.phrase,
      automationId: lien.automationId,
      maxParHeure: lien.maxParHeure,
      enabled: false,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
  }

  async supprimerAutomationCompagnon(_tenantId: string, _automationId: string): Promise<void> {
    throw new Error('aucun rattrapage attendu');
  }

  async byId(_tenantId: string, _linkId: string): Promise<LienRow | null> {
    throw new Error('publication non exercee');
  }

  async allumerAutomation(_tenantId: string, _linkId: string): Promise<void> {
    throw new Error('publication non exercee');
  }
}

class FaussesConnexionsPublication {
  tenantLu: string | null = null;

  constructor(private readonly connexion: Connexion | null) {}

  async getSecrets(tenantId: string): Promise<Connexion | null> {
    this.tenantLu = tenantId;
    return this.connexion;
  }
}

class FauxClientPublication {
  readonly publications: Array<{ text: string; mediaUrl?: string }> = [];

  constructor(private readonly ordre: string[], private readonly message: Message) {}

  async createMessage(_connexion: Connexion, message: { text: string; mediaUrl?: string }): Promise<Message> {
    this.ordre.push('publie');
    this.publications.push(message);
    return this.message;
  }
}

class FauxPostsPublication {
  readonly traces: Array<{ cmMessageId: string; linkId: string | null }> = [];

  constructor(private readonly ordre: string[]) {}

  async create(_tenantId: string, post: { cmMessageId: string; linkId: string | null }): Promise<void> {
    this.ordre.push('trace');
    this.traces.push(post);
  }
}

class FaussesAutomationsPublication {
  readonly creees: AutomationInput[] = [];

  constructor(private readonly ordre: string[], private readonly id: string) {}

  async create(_tenantId: string, input: AutomationInput): Promise<{ id: string }> {
    this.ordre.push('cree_automation');
    this.creees.push(input);
    return { id: this.id };
  }
}

describe('publication Channels Me', () => {
  it('cree l automation eteinte avant le lien, sans detacher les methodes du store', async () => {
    const liens = new FauxLiensPublication();
    const ordre = liens.ordre;
    const automations = new FaussesAutomationsPublication(ordre, AUTOMATION_ID);
    const publication = creerPublicationChannelsMe({
      connexions: new FaussesConnexionsPublication(null),
      client: new FauxClientPublication(ordre, { id: 'publication-non-exercee' }),
      liens,
      posts: new FauxPostsPublication(ordre),
      automations,
      scenarioEtat: async () => 'ok',
      getDisplayPhoneNumber: async () => '+33 5 25 68 02 50',
      phraseEnConflit: async () => false,
    });

    const resultat = await publication.creerLien({
      tenantId: TENANT_ID,
      workflowId: WORKFLOW_ID,
      startNodeId: null,
      phrase: 'Je veux recevoir la newsletter.',
      maxParHeure: 2_000,
    });

    expect(resultat.kind).toBe('cree');
    if (resultat.kind !== 'cree') throw new Error(`creation refusee : ${resultat.kind}`);
    expect(resultat.numero).toBe('+33 5 25 68 02 50');
    expect(ordre).toEqual([
      `verifie:${TENANT_ID}:Je veux recevoir la newsletter.`,
      'cree_automation',
      'cree_lien',
    ]);
    expect(automations.creees).toEqual([{
      name: 'Chaine : Je veux recevoir la newsletter.',
      triggerKind: 'keyword',
      triggerConfig: { keywords: ['Je veux recevoir la newsletter'], mode: 'contains' },
      conditionGroup: null,
      workflowId: WORKFLOW_ID,
      startNodeId: null,
      cooldownSeconds: 300,
      enabled: false,
      possedePar: 'channelsme_link',
      maxFiresPerHour: 2_000,
    }]);
    expect(liens.crees[0]).toMatchObject({
      tenantId: TENANT_ID,
      workflowId: WORKFLOW_ID,
      automationId: AUTOMATION_ID,
      phrase: 'Je veux recevoir la newsletter.',
      maxParHeure: 2_000,
    });
    expect(liens.crees[0]?.token).toMatch(/^cm-[a-z0-9]+$/);
    expect(resultat.lien).toMatchObject({ automationId: AUTOMATION_ID, enabled: false });
  });

  it('publie avant d allumer le lien puis d ecrire la trace', async () => {
    const ordre: string[] = [];
    const lien: LienRow = {
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: TENANT_ID,
      workflowId: WORKFLOW_ID,
      startNodeId: null,
      token: 'cm-a7k2m9p3',
      phrase: 'Je veux recevoir la newsletter',
      automationId: AUTOMATION_ID,
      maxParHeure: 2_000,
      enabled: false,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    class FauxLiensDuPost extends FauxLiensPublication {
      override async byId(tenantId: string, linkId: string): Promise<LienRow | null> {
        this.ordre.push('lit_lien');
        return tenantId === TENANT_ID && linkId === lien.id ? lien : null;
      }

      override async allumerAutomation(tenantId: string, linkId: string): Promise<void> {
        expect(tenantId).toBe(TENANT_ID);
        expect(linkId).toBe(lien.id);
        this.ordre.push('allume');
      }
    }
    const liens = new FauxLiensDuPost(ordre);
    const connexions = new FaussesConnexionsPublication({
      orgId: 'org-1', channelId: 'canal-1', apiKey: 'cle', secret: 'secret',
    });
    const client = new FauxClientPublication(ordre, { id: 'message-1' });
    const posts = new FauxPostsPublication(ordre);
    const publication = creerPublicationChannelsMe({
      connexions,
      client,
      liens,
      posts,
      automations: new FaussesAutomationsPublication(ordre, AUTOMATION_ID),
      scenarioEtat: async () => 'ok',
      getDisplayPhoneNumber: async () => '+33 5 25 68 02 50',
      phraseEnConflit: async () => false,
    });

    const resultat = await publication.publier({
      tenantId: TENANT_ID,
      text: 'Notre newsletter arrive',
      mediaUrl: undefined,
      linkId: lien.id,
    });

    expect(resultat).toEqual({
      kind: 'publie',
      post: { cmMessageId: 'message-1', linkId: lien.id },
      avertissements: [],
    });
    const urlAttendue = lienWaMe('+33 5 25 68 02 50', textePreRempli(lien.phrase));
    expect(connexions.tenantLu).toBe(TENANT_ID);
    expect(client.publications).toEqual([{ text: `Notre newsletter arrive\n\n${urlAttendue}` }]);
    expect(posts.traces).toEqual([{ cmMessageId: 'message-1', linkId: lien.id }]);
    expect(ordre).toEqual(['lit_lien', 'publie', 'allume', 'trace']);
  });
});
