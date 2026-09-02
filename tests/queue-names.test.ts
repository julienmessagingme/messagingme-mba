import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BASE_QUEUES, ALL_QUEUES, dlqName, notifieePour, pollingSecondsFor, FILES_NOTIFIEES, QUEUE_POLLING_SECONDS } from '../src/queue/names';

/**
 * Garde-fou anti-drift : /ops, pg-boss et le worker doivent voir la MÊME liste de files. Si on ajoute une file
 * au worker sans l'ajouter à BASE_QUEUES, ou si la convention -dlq diverge de PgBossQueue.ensure(), ce test casse.
 *
 * ⚠️ L'assertion est DÉRIVÉE du worker, pas recopiée. Une liste écrite en dur ici serait purement décorative :
 * c'est exactement ce qui a laissé passer l'ajout de `automation-event` (file réellement travaillée, invisible
 * de /ops, DLQ non surveillée) sans qu'aucun test ne bronche.
 */
/**
 * 🔴 Lire le CODE, pas la prose. Ces tests-ci assertent sur le texte source, et ce fichier est très commenté :
 * une assertion `toMatch` qui tombe sur un commentaire citant le réglage passe au vert alors que le réglage a
 * disparu du code. C'est arrivé le 2026-09-02 sur `ecouteNotifications: true`, dont le commentaire d'en-tête
 * suffisait à satisfaire le test, et seule la vérification en sens inverse (casser, voir échouer) l'a montré.
 * Le symétrique existe aussi : un `not.toMatch` que la prose fait échouer à tort.
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('queue names (source unique)', () => {
  it('toute file travaillée par le worker figure dans BASE_QUEUES', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    // `queue.work('nom', ...)` en littéral, ou via une constante de nom de file (ex. AUTOMATION_EVENT_QUEUE).
    const literals = [...worker.matchAll(/queue\.work\(\s*'([^']+)'/g)].map((m) => m[1]!);
    const viaConst = [...worker.matchAll(/queue\.work\(\s*([A-Z_][A-Z0-9_]*)\s*,/g)].map((m) => m[1]!);
    // Une constante de nom de file doit être définie quelque part avec sa valeur : on la résout par son export.
    const resolved = viaConst.map((name) => {
      if (name === 'AUTOMATION_EVENT_QUEUE') return 'automation-event';
      if (name === 'AGENT_TURN_QUEUE') return 'agent-turn';
      throw new Error(`constante de file inconnue du test : ${name} (ajoute sa résolution ici)`);
    });
    const worked = [...new Set([...literals, ...resolved])];
    expect(worked.length).toBeGreaterThan(0); // le test doit VRAIMENT trouver des files, sinon il ne prouve rien
    for (const q of worked) expect(BASE_QUEUES as readonly string[], `file ${q} absente de BASE_QUEUES`).toContain(q);
  });

  it('🔴 et RÉCIPROQUEMENT : toute file de BASE_QUEUES a un consommateur dans le worker', () => {
    // Ce sens-là manquait, et le trou n'était pas théorique : `agent-turn` a vécu plusieurs jours DANS
    // `BASE_QUEUES` (donc visible d'/ops, DLQ surveillée) sans que personne ne la travaille. Le jour où un
    // producteur est câblé sans son consommateur, les jobs s'empilent, les conversations restent muettes, et
    // c'est SILENCIEUX : /ops montre une file qui grossit, ce que personne ne regarde en continu.
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const literals = [...worker.matchAll(/queue\.work\(\s*'([^']+)'/g)].map((m) => m[1]!);
    const viaConst = [...worker.matchAll(/queue\.work\(\s*([A-Z_][A-Z0-9_]*)\s*,/g)].map((m) => m[1]!);
    const resolus = new Set([...literals, ...viaConst.map((n) => (n === 'AUTOMATION_EVENT_QUEUE' ? 'automation-event' : n === 'AGENT_TURN_QUEUE' ? 'agent-turn' : n))]);
    for (const q of BASE_QUEUES) {
      expect([...resolus], `file ${q} déclarée mais SANS consommateur dans src/worker.ts`).toContain(q);
    }
  });

  it('🔴 le message de démarrage est DÉRIVÉ des files consommées, jamais recopié', () => {
    // Cette liste était écrite à la main, avec ses propres conditions : une seconde vérité à tenir alignée
    // avec les `queue.work`. Elle a menti le jour même de l'ajout de `webhook-status`, en annonçant sept
    // files pour huit consommées. Personne ne l'aurait vu : un message de démarrage, ça se lit une fois.
    const worker = sansCommentaires(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));
    expect(worker, 'la liste du log doit venir de la file elle-même').toMatch(/const files = queue\.filesTravaillees\(\)/);
    expect(worker, 'aucune liste de files écrite à la main dans le log de démarrage').not.toMatch(/const files = \[/);
  });

  it('ALL_QUEUES = chaque file de base + sa DLQ, sans doublon', () => {
    expect(ALL_QUEUES).toHaveLength(BASE_QUEUES.length * 2);
    expect(new Set(ALL_QUEUES).size).toBe(ALL_QUEUES.length);
    for (const q of BASE_QUEUES) {
      expect(ALL_QUEUES).toContain(q);
      expect(ALL_QUEUES).toContain(dlqName(q));
    }
  });

  it('dlqName applique la convention <name>-dlq (identique à PgBossQueue.ensure)', () => {
    expect(dlqName('webhook')).toBe('webhook-dlq');
    expect(dlqName('campaign-run')).toBe('campaign-run-dlq');
  });
});

/**
 * La cadence de polling n'est pas un détail de confort : le défaut pg-boss (2 s par file) a coûté un dépassement
 * du quota d'egress Supabase (663 000 requêtes/jour à vide, 249 Mo/jour, cf. `names.ts`). Ces tests gardent les
 * deux invariants qui empêchent la fuite de revenir : toute file déclarée a une cadence PENSÉE, et une file
 * oubliée retombe sur un défaut lent plutôt que sur les 2 s de pg-boss.
 */
describe('cadence de polling par file', () => {
  it('toute file de BASE_QUEUES a une cadence déclarée', () => {
    for (const q of BASE_QUEUES) {
      expect(QUEUE_POLLING_SECONDS[q], `cadence manquante pour ${q}`).toBeTypeOf('number');
      expect(QUEUE_POLLING_SECONDS[q]).toBeGreaterThanOrEqual(2); // plancher pg-boss : >= 0,5 s, mais 2 s est notre seuil de bruit
    }
  });

  it('le chemin conversationnel reste vif, le traitement de fond est lent', () => {
    // Si quelqu'un ralentit `webhook` pour gagner de l'egress, il dégrade la latence des réponses WhatsApp :
    // c'est l'arbitrage à NE PAS faire, et ce test le dit.
    expect(pollingSecondsFor('webhook')).toBe(2);
    expect(pollingSecondsFor('campaign-run')).toBe(5);
    expect(pollingSecondsFor('analyze-conversation')).toBe(30);
  });

  it('une file inconnue retombe sur un défaut lent, pas sur les 2 s de pg-boss', () => {
    expect(pollingSecondsFor('file-jamais-declaree')).toBe(5);
  });

  it('toute file de BASE_QUEUES est CLASSEE : reveillee par notification, ou non', () => {
    // Meme invariant que la cadence, et meme raison : une file ajoutee sans qu'on se pose la question herite
    // d'un comportement par accident.
    for (const q of BASE_QUEUES) {
      expect(FILES_NOTIFIEES[q], `classement manquant pour ${q}`).toBeTypeOf('boolean');
    }
  });

  it('🔴 les accuses de livraison ne sont PAS reveilles : les espacer protege les entrants', () => {
    // L'arbitrage a NE PAS refaire. Une campagne de 5 000 messages produit trois accuses par destinataire ;
    // les reveiller a l'instant les ferait vider a pleine vitesse et affamerait la reponse a un vrai client,
    // ce que la cadence de 30 s du lot 6 avait justement ferme. « Peut-on aller plus vite » n'est pas la
    // question ; « la latence se ressent-elle » l'est.
    expect(notifieePour('webhook-status')).toBe(false);
    expect(notifieePour('analyze-conversation')).toBe(false);
    expect(notifieePour('push-analysis')).toBe(false);
    expect(notifieePour('hubspot-catchup')).toBe(false);
    // Et reciproquement, le chemin conversationnel l'est.
    expect(notifieePour('webhook')).toBe(true);
    expect(notifieePour('agent-turn')).toBe(true);
  });

  it('une DLQ et une file inconnue ne sont jamais reveillees (defaut sur : le sondage seul)', () => {
    for (const q of BASE_QUEUES) expect(notifieePour(dlqName(q))).toBe(false);
    expect(notifieePour('file-jamais-declaree')).toBe(false);
  });

  it('une DLQ poll lentement (dépôt inspecté par /ops, personne ne la travaille)', () => {
    for (const q of BASE_QUEUES) expect(pollingSecondsFor(dlqName(q))).toBe(60);
  });

  /**
   * Tester les fonctions pures ne prouve PAS qu'elles sont branchées : `maintenanceOptions` pourrait rendre le bon
   * objet sans que personne ne l'appelle, et `pollingSecondsFor` pourrait ne jamais atteindre pg-boss. Ces trois
   * assertions lisent le câblage réel, faute de pouvoir instancier pg-boss sans base dans un test unitaire.
   */
  it('le câblage réel est en place : API sans supervision, worker avec, cadence passée à pg-boss', () => {
    const api = sansCommentaires(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));
    const worker = sansCommentaires(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));
    const wrapper = sansCommentaires(readFileSync(new URL('../src/queue/pgboss.ts', import.meta.url), 'utf8'));
    expect(api, 'l’API doit démarrer pg-boss sans supervision (elle empile, elle ne dépile pas)').toMatch(/supervise:\s*false/);
    expect(worker, 'le worker doit rester le SEUL à superviser : pas de supervise: false ici').not.toMatch(/supervise:\s*false/);
    expect(worker, 'le worker doit espacer la maintenance flow').toMatch(/flowIntervalSeconds:\s*60/);
    expect(wrapper, 'la cadence par file doit réellement atteindre boss.work').toMatch(/pollingIntervalSeconds:\s*pollingSecondsFor\(name\)/);
  });

  it('🔴 le REVEIL par notification est branche, et pose la ou il fait quelque chose', () => {
    // Ce test-ci vaut plus que les purs : le piege du reveil n'est pas de mal le calculer, c'est de le poser
    // sur `createQueue`, qui est un `ON CONFLICT DO NOTHING`. Sur les files de la production, qui existent
    // toutes deja, la ligne serait ecrite, relue en revue, et n'aurait JAMAIS reveille personne. Seule
    // `updateQueue` ecrit sur une file existante.
    const wrapper = sansCommentaires(readFileSync(new URL('../src/queue/pgboss.ts', import.meta.url), 'utf8'));
    expect(wrapper, 'le drapeau notify doit passer par updateQueue').toMatch(/updateQueue\(\s*name,\s*\{\s*notify:\s*true\s*\}\s*\)/);
    expect(wrapper, 'notify pose sur createQueue serait un no-op silencieux sur toute file existante').not.toMatch(/createQueue\([^)]*notify:/s);
    expect(wrapper, 'la classification par file doit reellement etre consultee').toMatch(/notifieePour\(name\)/);
  });

  it('🔴 le filet de sondage vaut la cadence de BASE quand la notification est active', () => {
    // C'est ce qui rend le changement sans risque : si l'ecouteur tombe, on retombe exactement sur le
    // comportement d'hier. Le defaut pg-boss serait 30 s, soit une latence QUINZE fois pire qu'avant sur les
    // entrants, et seulement les jours ou l'ecouteur est casse, donc invisible en test.
    const wrapper = sansCommentaires(readFileSync(new URL('../src/queue/pgboss.ts', import.meta.url), 'utf8'));
    expect(wrapper, 'le filet doit valoir la cadence de base, jamais le defaut de 30 s').toMatch(
      /notifyPollingIntervalSeconds:\s*pollingSecondsFor\(name\)/,
    );
  });

  it('🔴 seul le worker ECOUTE : l’API empile, un ecouteur y prendrait une connexion pour rien', () => {
    const api = sansCommentaires(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));
    const worker = sansCommentaires(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));
    expect(worker, 'le worker depile, donc il doit etre reveille').toMatch(/ecouteNotifications:\s*true/);
    expect(api, 'l’API ne depile aucune file : pas d’ecouteur').not.toMatch(/ecouteNotifications:\s*true/);
    // Un repli MUET serait pire que le repli : on croirait les entrants reveilles alors qu'ils attendraient
    // leur tour d'horloge. pg-boss le signale par un avertissement, encore faut-il l'ecouter.
    expect(worker, 'l’avertissement de repli doit etre observe').toMatch(/onWarning\(/);
  });

  it('🔴 une file en CONCURRENCE declare toujours sa concurrence par GROUPE', () => {
    // Les deux options vont ensemble, et l'oubli est silencieux dans les deux sens : `concurrency` seul
    // remet le desordre entre deux jobs qui doivent rester ordonnes (deux messages d'un meme contact, deux
    // runs d'une meme campagne) ; `groupConcurrency` seul est un NO-OP, pg-boss n'ayant rien a repartir tant
    // qu'un seul job est en vol. Ce test lit le worker REEL, pas une liste tenue a la main.
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const options = [...worker.matchAll(/\{\s*concurrency:[^}]*\}/g)].map((m) => m[0]);
    expect(options.length, 'aucune file en concurrence trouvee : le test ne prouve rien').toBeGreaterThan(0);
    for (const o of options) {
      expect(o, `concurrency sans groupConcurrency : ${o}`).toContain('groupConcurrency');
    }
  });
});
