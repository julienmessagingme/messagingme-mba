import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeQueue } from '../src/queue/fake';
import { AUTOMATION_EVENT_QUEUE, enfilerEvenementAutomation } from '../src/automation/event-job';
import { schema } from '../src/config';

/**
 * LA CONCURRENCE ET L'ÉQUITÉ DES FILES (lot 6 du plan post-audit, 2026-09-02).
 *
 * 🔴 LE CONSTAT. Sur les huit consommateurs du worker, DEUX seulement passaient des options de concurrence.
 * Les six autres tournaient sur le défaut de pg-boss, vérifié dans sa source (`localConcurrency = 1`) : un
 * seul job à la fois, TOUS CLIENTS CONFONDUS. Sur `agent-turn`, avec un plafond de 120 s par appel au modèle,
 * cela faisait 30 tours par heure pour la flotte entière.
 *
 * ⚠️ Le piège de cette file : `groupConcurrency` est un NO-OP tant que `concurrency` vaut 1. Poser la clé de
 * groupe seule aurait donné une équité qu'on croirait active et qui ne le serait pas. C'est pour ça que ce
 * fichier teste les DEUX moitiés, l'enfilement (qui pose le groupe) et la consommation (qui l'applique).
 */

const lireWorker = (): string => readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const sansCommentaires = (s: string): string => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('l’enfilement pose le CLIENT comme clé de groupe', () => {
  it('🔴 un événement d’automation part avec son espace comme groupe', async () => {
    const q = new FakeQueue();
    await enfilerEvenementAutomation(q, { tenantId: 't-42', event: { kind: 'tag_added', waId: '33600', tag: 'vip' } });
    expect(q.enqueued).toEqual([
      { name: AUTOMATION_EVENT_QUEUE, data: { tenantId: 't-42', event: { kind: 'tag_added', waId: '33600', tag: 'vip' } }, opts: { groupId: 't-42' } },
    ]);
  });

  it('🔴 AUCUN enfilement direct de cette file ne subsiste dans le code', () => {
    // La raison d'être du helper. Six sites recopiaient `queue.enqueue(AUTOMATION_EVENT_QUEUE, ...)` : six
    // occasions d'oublier le groupe, et un oubli produit un job SANS groupe, donc un job qui échappe au
    // plafond par espace, sans que rien ne le signale. Le dépôt a déjà payé ce prix le 2026-09-02 (131008).
    for (const f of ['../src/index.ts', '../src/worker.ts', '../src/workflow/wiring.ts']) {
      const src = sansCommentaires(readFileSync(new URL(f, import.meta.url), 'utf8'));
      expect(src, `${f} enfile encore cette file en direct : le groupe peut y être oublié`)
        .not.toMatch(/enqueue\(\s*AUTOMATION_EVENT_QUEUE/);
    }
  });

  it('🔴 un tour d’agent part avec son espace comme groupe', () => {
    const src = sansCommentaires(readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8'));
    expect(src, 'sans groupe, un client bavard occupe les douze places et les autres attendent derrière')
      .toMatch(/enqueue\(AGENT_TURN_QUEUE,\s*job,\s*\{\s*groupId:\s*job\.tenantId\s*\}\)/);
  });

  it('🔴 une analyse de conversation part avec son espace comme groupe', () => {
    const src = sansCommentaires(lireWorker());
    expect(src, 'sans groupe, dix mille analyses d’un client passent avant la première de tous les autres')
      .toMatch(/enqueue\('analyze-conversation',\s*\{ conversationId, tenantId \},\s*\{ groupId: tenantId \}\)/);
  });

  it('la file réduite passée au câblage DÉCLARE les options', () => {
    // Sans ça, un appelant qui passe une clé de groupe la voit disparaître en silence : le type étroit
    // d'origine ne nommait pas le troisième paramètre. Même famille que le passe-plat du 131008.
    const src = sansCommentaires(readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8'));
    expect(src).toMatch(/enqueue\(name: string, data: unknown, opts\?: \{[^}]*groupId\?: string/);
  });
});

describe('la consommation applique la concurrence ET le plafond par groupe', () => {
  it('🔴 les trois files du lot passent les DEUX options', () => {
    const src = sansCommentaires(lireWorker());
    for (const [file, attendu] of [
      ['AGENT_TURN_QUEUE', /\{ concurrency: config\.AGENT_TURN_CONCURRENCY, groupConcurrency: config\.AGENT_TURN_GROUP_CONCURRENCY \}/],
      ['AUTOMATION_EVENT_QUEUE', /\{ concurrency: config\.AUTOMATION_EVENT_CONCURRENCY, groupConcurrency: 1 \}/],
      ['analyze-conversation', /\{ concurrency: config\.ANALYZE_CONVERSATION_CONCURRENCY, groupConcurrency: 1 \}/],
    ] as const) {
      expect(src, `la file ${file} ne passe plus ses deux options : elle retombe sur UN job à la fois pour toute la flotte`)
        .toMatch(attendu);
    }
  });

  it('🔴 RÉCIPROQUE du garde-fou existant : jamais de groupConcurrency sans concurrency', () => {
    // `tests/queue-names.test.ts` garde le sens « concurrency sans groupe ». Celui-ci garde l'autre, qui est
    // le piège propre à pg-boss : un plafond par groupe posé seul ne fait RIEN, et se relit comme une garantie.
    const src = sansCommentaires(lireWorker());
    const options = [...src.matchAll(/\{[^{}]*groupConcurrency:[^{}]*\}/g)].map((m) => m[0]);
    expect(options.length, 'aucun plafond par groupe trouvé : le test ne prouve rien').toBeGreaterThan(0);
    for (const o of options) {
      expect(o, `groupConcurrency sans concurrency (no-op silencieux) : ${o}`).toContain('concurrency:');
    }
  });

  it('les files de FOND restent volontairement à un job : le nombre n’y sert à rien', () => {
    // `webhook-status` est lente EXPRÈS (les accusés ne doivent pas affamer les entrants), `push-analysis` et
    // `hubspot-catchup` ont un volume faible et ne sont pas du temps réel. Monter leur concurrence coûterait
    // du polling à vide pour rien : chaque unité lance un poller indépendant.
    const src = sansCommentaires(lireWorker());
    for (const file of ['webhook-status', 'push-analysis', 'hubspot-catchup']) {
      const i = src.indexOf(`queue.work('${file}'`);
      expect(i, `la file ${file} n'est plus travaillée : ce test ne garde plus rien`).toBeGreaterThan(-1);
      // La fin de l'appel : on cherche la présence d'options de concurrence dans les 800 caractères suivants.
      expect(src.slice(i, i + 800), `${file} a gagné une concurrence : c'était un choix, il faut le revoir en conscience`)
        .not.toContain('concurrency:');
    }
  });
});

describe('les valeurs par défaut sont celles qu’on a arrêtées', () => {
  it('agent-turn : 12 en vol, 4 par espace', () => {
    const c = schema.parse({});
    expect(c.AGENT_TURN_CONCURRENCY).toBe(12);
    expect(c.AGENT_TURN_GROUP_CONCURRENCY).toBe(4);
    // Le plafond par espace doit rester STRICTEMENT sous le total, sinon un seul client peut tout prendre et
    // le groupe ne sert plus à rien.
    expect(c.AGENT_TURN_GROUP_CONCURRENCY).toBeLessThan(c.AGENT_TURN_CONCURRENCY);
  });

  it('les deux files de fond montent un peu, et surtout groupent', () => {
    const c = schema.parse({});
    expect(c.ANALYZE_CONVERSATION_CONCURRENCY).toBe(3);
    expect(c.AUTOMATION_EVENT_CONCURRENCY).toBe(3);
    // Au-dessus de 1 : c'est la condition pour que le plafond par groupe existe vraiment.
    expect(c.ANALYZE_CONVERSATION_CONCURRENCY).toBeGreaterThan(1);
    expect(c.AUTOMATION_EVENT_CONCURRENCY).toBeGreaterThan(1);
  });

  it('tout est ajustable par l’environnement, sans redéployer de code', () => {
    const c = schema.parse({ AGENT_TURN_CONCURRENCY: '20', AGENT_TURN_GROUP_CONCURRENCY: '6' });
    expect(c.AGENT_TURN_CONCURRENCY).toBe(20);
    expect(c.AGENT_TURN_GROUP_CONCURRENCY).toBe(6);
  });
});

/**
 * 🔴 LA VALIDATION DES RÉGLAGES (constat de l'audit externe du 2026-09-02).
 *
 * Les valeurs de concurrence acceptaient zéro, un négatif et un décimal. Aucune ne se voit à l'exécution :
 * une concurrence à zéro ARRÊTE la file en silence, un décimal est tronqué par pg-boss sans le dire, et un
 * plafond de campagne à zéro refuserait toutes les campagnes avec un message parfaitement formé.
 */
describe('les réglages numériques refusent l’absurde', () => {
  const refuse = (env: Record<string, string>) => expect(() => schema.parse(env)).toThrow();

  it('🔴 une concurrence à ZÉRO est refusée : elle arrêterait la file en silence', () => {
    refuse({ AGENT_TURN_CONCURRENCY: '0' });
    refuse({ WEBHOOK_CONCURRENCY: '0' });
    refuse({ CAMPAIGN_RUN_CONCURRENCY: '0' });
  });

  it('un négatif et un décimal sont refusés aussi', () => {
    refuse({ AGENT_TURN_CONCURRENCY: '-1' });
    refuse({ AGENT_TURN_CONCURRENCY: '2.5' });
  });

  it('le plafond de campagne refuse zéro et le négatif', () => {
    refuse({ CAMPAIGN_MAX_RECIPIENTS: '0' });
    refuse({ CAMPAIGN_MAX_RECIPIENTS: '-5' });
  });

  it('🔴 un plafond PAR ESPACE >= au total est refusé : il ne plafonnerait rien', () => {
    // À égalité, un seul client peut déjà occuper toutes les places : le groupe ne sert alors à rien, et la
    // ligne de configuration se relit pourtant comme une garantie d'équité.
    refuse({ AGENT_TURN_CONCURRENCY: '12', AGENT_TURN_GROUP_CONCURRENCY: '12' });
    refuse({ AGENT_TURN_CONCURRENCY: '12', AGENT_TURN_GROUP_CONCURRENCY: '20' });
  });

  it('et la combinaison légitime passe', () => {
    const c = schema.parse({ AGENT_TURN_CONCURRENCY: '20', AGENT_TURN_GROUP_CONCURRENCY: '6' });
    expect(c.AGENT_TURN_CONCURRENCY).toBe(20);
    expect(c.AGENT_TURN_GROUP_CONCURRENCY).toBe(6);
  });

  it('le seuil du reranker est un SCORE, borné dans [0, 1]', () => {
    // Ce n'est pas un compte : zéro est légitime (il vaudrait « ne filtre rien »), 1,5 ne l'est pas.
    expect(schema.parse({ AGENT_RERANK_SEUIL: '0' }).AGENT_RERANK_SEUIL).toBe(0);
    refuse({ AGENT_RERANK_SEUIL: '1.5' });
    refuse({ AGENT_RERANK_SEUIL: '-0.1' });
  });
});
