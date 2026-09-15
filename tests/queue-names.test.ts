import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BASE_QUEUES, ALL_QUEUES, dlqName, filetNotifieSecondes, notifieePour, pollingSecondsFor, FILES_NOTIFIEES, QUEUE_POLLING_SECONDS, SEUIL_RAFALE, SEUILS_RAFALE, seuilRafalePour, SONDAGE_FILET_NOTIFIE } from '../src/queue/names';

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
      if (name === 'FILE_POUSSEE_OPTOUT') return 'optout-poussee';
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
    const RESOLUTION: Record<string, string> = {
      AUTOMATION_EVENT_QUEUE: 'automation-event',
      AGENT_TURN_QUEUE: 'agent-turn',
      FILE_POUSSEE_OPTOUT: 'optout-poussee',
    };
    const resolus = new Set([...literals, ...viaConst.map((n) => RESOLUTION[n] ?? n)]);
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
    // Ancrée sur la ligne entière, comme le seuil de rafale plus bas : un `toMatch` sur le seul nom de
    // l'option passe aussi quand l'option est enfermée dans une condition morte. Vérifié.
    expect(wrapper, 'la cadence par file doit être une propriété DIRECTE des options de boss.work')
      .toMatch(/^\s{8}pollingIntervalSeconds: pollingSecondsFor\(name\),$/m);
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

  it('🔴 le FILET de sondage est relache a 60 s quand la notification est active', () => {
    // 🔴 LA CONCURRENCE EST UN MULTIPLICATEUR DE SONDAGE : chaque unite de concurrence est un worker avec SA
    // PROPRE boucle (lu dans la source de pg-boss). `agent-turn` (concurrence 12, sondage 2 s) tapait donc la
    // base six fois par seconde pour une file qui n'a traite AUCUN job en trente jours. Mesure du 2026-09-10
    // en production : 785 555 requetes/jour, dont 88 % de sondage a vide, contre 786 240 predites par le
    // modele `somme(concurrence / cadence)`.
    //
    // ⚠️ Ce qui rend le relachement sur, ce n'est PAS ce filet mais `pollingIntervalSeconds`, teste juste
    // au-dessus : pg-boss reevalue `isNotifyActive()` a chaque tour et y retombe seul si l'ecouteur meurt.
    // La version precedente de ce test figeait l'inverse (« le filet vaut la cadence de base »), sur une
    // lecture fausse de pg-boss, et c'est cette precaution mal fondee qui a coute les deux tiers du trafic.
    const wrapper = sansCommentaires(readFileSync(new URL('../src/queue/pgboss.ts', import.meta.url), 'utf8'));
    expect(wrapper, 'le filet doit etre une propriete DIRECTE des options de boss.work').toMatch(
      /^\s{8}notifyPollingIntervalSeconds: filetNotifieSecondes\(name\),$/m,
    );
  });

  it('🔴 le filet n’est JAMAIS plus court que la cadence de base', () => {
    // pg-boss REFUSE au demarrage un filet plus court que la cadence de base (`assert notifyPollingInterval
    // >= pollingInterval`). Sans le `max`, ralentir un jour une file de fond a 120 s ferait planter le worker
    // au boot, pas en test : la panne serait au deploiement, sur une file de fond que personne ne regarde.
    for (const q of BASE_QUEUES) {
      expect(filetNotifieSecondes(q), q).toBeGreaterThanOrEqual(pollingSecondsFor(q));
    }
    expect(filetNotifieSecondes('webhook')).toBe(SONDAGE_FILET_NOTIFIE);
    expect(filetNotifieSecondes('analyze-conversation')).toBe(SONDAGE_FILET_NOTIFIE);
    // Une file dont la cadence de base DEPASSERAIT le filet garde sa cadence, elle ne l'accelere pas.
    expect(filetNotifieSecondes('file-hypothetique-lente')).toBe(SONDAGE_FILET_NOTIFIE);
  });

  it('⚠️ le filet ne touche PAS la cadence de base, qui reste le comportement de repli', () => {
    // Les deux valeurs partent ensemble a pg-boss et ne disent pas la meme chose : la base est ce qui
    // s'applique quand l'ecouteur est MORT, le filet ce qui s'applique quand il est VIVANT. Les confondre est
    // exactement l'erreur qu'on repare.
    expect(pollingSecondsFor('webhook')).toBe(2);
    expect(pollingSecondsFor('agent-turn')).toBe(2);
  });

  it('🔴 la RAFALE est branchée : sans elle, le débit d’une file vaut 1 / cadence de sondage', () => {
    // Mesuré en production le 2026-09-03, pas supposé : `webhook-status` sonde toutes les 30 s, prend UN job
    // par sondage et le traite en 0,05 s, soit DEUX jobs par minute (sa concurrence vaut 1 ; le débit d'une
    // file vaut `concurrence / cadence`, cf. `SONDAGE_FILET_NOTIFIE`). Une campagne de 5 000 destinataires
    // produit environ 15 000 accusés : 125 heures pour les absorber, avec des compteurs faux pendant des
    // jours. La cadence lente est juste au repos et absurde sous retard.
    const wrapper = sansCommentaires(readFileSync(new URL('../src/queue/pgboss.ts', import.meta.url), 'utf8'));
    // ⚠️ La ligne ENTIÈRE, ancrée, et pas un simple `toMatch` sur le nom de l'option. Vérifié dans les deux
    // sens : une version neutralisée en `...(false ? { burstWhenReadyExceeds: SEUIL_RAFALE } : {})` passait
    // le `toMatch` sans rien brancher. Un test de câblage qui survit à la neutralisation du câblage ne
    // prouve rien.
    expect(wrapper, 'le seuil de rafale doit être une propriété DIRECTE des options de boss.work')
      .toMatch(/^\s{8}burstWhenReadyExceeds: seuilRafalePour\(name\),$/m);
    // Un seuil qui vaut zéro ferait tourner la file en continu même à vide : c'est l'egress que la cadence
    // par file avait justement supprimé.
    expect(SEUIL_RAFALE).toBeGreaterThan(0);
  });

  it('🔴 le seuil de rafale est PAR FILE, et `webhook-status` déclenche dès TROIS accusés', () => {
    // 🔴 L'OFF-BY-ONE EST LE SUJET DE CE TEST. pg-boss compare `readyCount > burstWhenReadyExceeds` (lu dans
    // sa source, `manager.js`), donc la valeur est celle d'AVANT le déclenchement. Meta rend exactement trois
    // accusés par message : un seuil écrit `3` en croyant dire « dès trois » laisserait le cas le plus
    // fréquent du produit hors rafale, à un accusé toutes les trente secondes, sans aucun symptôme visible.
    expect(seuilRafalePour('webhook-status')).toBe(2);
    const paquetDUnMessage = 3;
    expect(paquetDUnMessage > seuilRafalePour('webhook-status'), 'les 3 accusés d’un message doivent rafaler').toBe(true);
  });

  it('⚠️ les autres files gardent le défaut, y compris celles qu’on n’a pas mesurées', () => {
    // La mécanique devient par file ; le RÉGLAGE des quatre autres files de fond ne bouge pas, parce que
    // personne n'a mesuré leurs paquets. Poser un seuil sans mesure serait refaire l'erreur qu'on corrige.
    for (const file of ['webhook', 'agent-turn', 'campaign-run', 'analyze-conversation', 'push-analysis', 'hubspot-catchup', 'optout-poussee']) {
      expect(seuilRafalePour(file), `${file} doit rester au défaut`).toBe(SEUIL_RAFALE);
    }
    // Une file inconnue retombe sur le défaut plutôt que sur `undefined`, qui désactiverait la rafale en
    // silence : `burstWhenReadyExceeds: undefined` est accepté par pg-boss et ne rafale JAMAIS.
    expect(seuilRafalePour('file-hypothetique')).toBe(SEUIL_RAFALE);
  });

  it('🔴 aucun seuil par file ne vaut zéro : ce serait la boucle à vide que la cadence avait fermée', () => {
    for (const [file, seuil] of Object.entries(SEUILS_RAFALE)) {
      expect(seuil, `${file} : un seuil nul ferait rafaler une file vide`).toBeGreaterThan(0);
    }
  });

  it('🔴 la rafale ne touche PAS la concurrence : c’est elle qui protège les entrants', () => {
    // La distinction qui rend le réglage sûr. La cadence décide de la VITESSE de vidage, la concurrence
    // décide de combien de jobs tournent ENSEMBLE. Accélérer une rafale d'accusés n'autorise pas à en
    // traiter deux en même temps, sinon on rouvre exactement ce que le lot 6 avait fermé.
    const worker = sansCommentaires(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));
    const debut = worker.indexOf("queue.work('webhook-status'");
    const registration = debut === -1 ? '' : worker.slice(debut, debut + 600);
    expect(registration, 'la registration de webhook-status doit être trouvée').not.toBe('');
    expect(registration, 'webhook-status ne doit toujours traiter qu’un accusé à la fois').not.toMatch(/concurrency:/);
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
