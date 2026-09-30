import { describe, it, expect } from 'vitest';
import { REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS } from '../src/mba/liste';
import { MetaApiError } from '../src/meta/errors';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runControlSweep } from '../src/inbox/control-sweep';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import { bancDuFil, type ReponseMeta } from './banc-du-fil';

/**
 * LE CÂBLAGE DE LA SOUPAPE DE CONTRÔLE DU FIL.
 *
 * 🔴 CE QUE CE FICHIER GARDE N'EST PAS UNE LOGIQUE, C'EST UN PASSAGE D'ARGUMENT, et c'est exactement ce qui
 * a manqué. `src/worker.ts` câblait `listHeldControl: (limit) => inboxStore.listHeldControl(limit)`, une
 * flèche à UN paramètre là où le contrat en déclare DEUX. TypeScript l'accepte, le second était avalé en
 * silence, le magasin retombait sur `ageScenarioMs = 0`, et son SQL teste `$2::bigint > 0` : la branche qui
 * ramasse les fils tenus par un scénario ne s'est JAMAIS déclenchée.
 *
 * 🔴 MESURÉ EN PRODUCTION LE 2026-09-15 : avec la valeur réellement reçue (0), le balayage ramassait ZÉRO
 * conversation ; avec la valeur prévue (24 h), DIX, toutes gelées depuis. Un parcours terminé gardait donc
 * le fil INDÉFINIMENT, pas 24 h.
 *
 * ⚠️ AUCUN TEST UNITAIRE NE POUVAIT LE VOIR : ils montent tous un faux `listHeldControl` dont ils
 * choisissent eux-mêmes la signature. Le faux bouge avec le code, et c'est précisément le motif que le
 * CLAUDE.md du dépôt décrit (« une flèche à deux paramètres est assignable à un contrat qui en déclare
 * trois, et le troisième est avalé en silence »).
 */

describe('le balayage réclame l’âge, et le câblage le transmet', () => {
  it('🔴 le balayage passe bien le délai des scénarios au magasin', async () => {
    const recus: Array<{ limit: unknown; age: unknown }> = [];
    await runControlSweep({
      inbox: {
        listHeldControl: async (limit, age) => { recus.push({ limit, age }); return []; },
      },
      fil: bancDuFil().fil,
      timeouts: { app_human: 7_200_000, mba: 86_400_000, app_workflow: 86_400_000 },
    });
    // 🔴 C'est ce chiffre, et pas `undefined` ni 0, qui décide si la branche SQL se déclenche.
    expect(recus[0]?.age).toBe(86_400_000);
  });

  it('🔴 et le VRAI câblage du worker le transmet aussi', () => {
    /**
     * Le worker passe le dépôt lui-même : aucune flèche intermédiaire ne peut avaler l'âge. La garde lit le
     * worker, parce qu'un faux ne dit rien du vrai.
     */
    const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');
    const debut = worker.indexOf('runControlSweep({');
    const bloc = worker.slice(debut, worker.indexOf('});', debut));
    expect(bloc).toContain('inbox: inboxStore,');
    expect(worker).not.toMatch(/listHeldControl: \(/);
  });

  it('⚠️ un délai de scénario à 0 reste possible, et il DÉSACTIVE la reprise', async () => {
    // `0 désactive` est le levier d'urgence du dépôt, il ne doit pas disparaître en réparant l'oubli.
    const recus: Array<unknown> = [];
    await runControlSweep({
      inbox: {
        listHeldControl: async (_l, age) => { recus.push(age); return []; },
      },
      fil: bancDuFil().fil,
      timeouts: { app_human: 7_200_000, mba: 86_400_000, app_workflow: 0 },
    });
    expect(recus[0]).toBe(0);
  });
});

/**
 * 🔴 LE VRAI CÂBLAGE D'UN SCÉNARIO, MONTÉ ET EXÉCUTÉ (relecture du 2026-09-29). Ces cas lisaient le TEXTE de
 * `src/workflow/wiring.ts` : remettre la condition `assigneA` seule à la place de `escalade || assigneA` devant la
 * lecture du nom laissait tout vert, et la frise aurait affiché « scénario <uuid> ». `buildWorkflowRuntime` se monte
 * sans base (ses dépôts ne font que retenir le pool) : on le monte sur des dépendances inertes, seuls le nom du
 * scénario, le fil et l'affectation parlent, et on appelle la dépendance `escalateToHuman` qu'il a donnée à
 * l'exécuteur. Ce que le geste écrit ensuite : `tests/fil.test.ts` et `tests/inbox-evenements.test.ts`.
 */
function cablageDuScenario(lireNom: () => Promise<{ name: string } | null> = async () => ({ name: 'Bienvenue' })) {
  const appels: unknown[][] = [];
  const inerte = {} as never;
  const { executor } = buildWorkflowRuntime({
    pool: inerte, queue: { enqueue: async () => {} }, dryRun: true, repo: inerte, contactStore: inerte,
    inboxStore: { setAssigneeByWaId: async (...a: unknown[]) => { appels.push(['affecter', ...a]); return true; } } as never,
    settingsStore: inerte,
    workflowStore: { getById: async (id: string, t: string) => { appels.push(['nom', id, t]); return lireNom(); } } as never,
    metaCredentials: inerte, metaFactory: inerte, rcsProvider: 'fake', emailTemplates: inerte, emailResolver: inerte,
    numeroDeLEspace: async () => null, runStore: inerte,
    fil: { passerAUnHumain: async (...a: unknown[]) => { appels.push(['passer', ...a]); return true; } } as never,
  });
  // `deps` est privé à l'exécuteur : on lit la dépendance que le câblage lui a donnée, sans monter un parcours entier.
  const { escalateToHuman } = Reflect.get(executor, 'deps') as WorkflowExecutorDeps;
  return { escalateToHuman, appels };
}

describe('le câblage d’un scénario nomme le scénario à CHAQUE passage à l’équipe (0194, 2026-09-29)', () => {
  it('🔴 sans marque d’escalade ni affectataire, la cause nomme quand même le scénario', async () => {
    // Tout passage d'un robot à l'équipe écrit désormais l'événement `escaladee`, drapeau ou non. Ne lire le nom
    // qu'avec une escalade ou un affectataire afficherait « scénario wf-1 » pour un scénario qui passe la main sans
    // rien avoir envoyé.
    const { escalateToHuman, appels } = cablageDuScenario();
    await escalateToHuman('t1', '33600000001', null, false, 'wf-1');
    expect(appels).toEqual([
      ['nom', 'wf-1', 't1'],
      ['passer', 't1', '33600000001', { escalade: false, cause: 'automatique : scénario Bienvenue' }],
    ]);
  });

  it('🔴 le drapeau est RELAYÉ, jamais décidé, et l’affectation porte la MÊME cause', async () => {
    // ⚠️ `escalade` vient de l'APPELANT : un bloc « passer à un humain » le pose, un échec de réveil (fenêtre
    // fermée, envoi refusé à la reprise) ne le pose pas, parce que personne n'attend à cet instant. Écrire
    // `escalade: true` dans le câblage rendrait tous les fils collants, y compris ceux que personne n'attend.
    const { escalateToHuman, appels } = cablageDuScenario();
    await escalateToHuman('t1', 'w', 'u-marie', true, 'wf-1');
    expect(appels.slice(1)).toEqual([
      ['passer', 't1', 'w', { escalade: true, cause: 'automatique : scénario Bienvenue' }],
      ['affecter', 't1', 'w', 'u-marie', 'automatique : scénario Bienvenue'],
    ]);
  });

  it('un scénario introuvable, ou une lecture en panne, ne bloque rien : il est dit par son identifiant', async () => {
    for (const lireNom of [async () => null, async () => { throw new Error('base indisponible'); }]) {
      const { escalateToHuman, appels } = cablageDuScenario(lireNom);
      await escalateToHuman('t1', 'w', null, true, 'wf-1');
      expect(appels.at(-1)).toEqual(['passer', 't1', 'w', { escalade: true, cause: 'automatique : scénario wf-1' }]);
    }
  });
});

/**
 * 🔴 LES TROIS CHEMINS D'ESCALADE POSENT LE MÊME DRAPEAU (arbitrage de Julien du 2026-09-23, migration 0164).
 *
 * L'agent de Meta, le bloc « passer à un humain » d'un scénario et l'escalade d'un agent IA promettent la même
 * chose au client. Les deux derniers posaient `app_human` SANS le drapeau : leur dernière phrase étant sortante,
 * la conversation n'entrait dans « À traiter » qu'au message suivant du client, et le balayage rendait le fil à
 * l'agent au bout de 2 h sans que personne ait répondu. Le câblage d'un scénario est exécuté plus haut ; ceux du
 * worker lisent encore la SOURCE, parce que `src/worker.ts` démarre un processus quand on l'importe.
 */
describe('l’escalade est posée par les DEUX câblages, pas seulement par l’agent de Meta', () => {
  const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');

  it('🔴 l’escalade d’un agent IA aussi, et elle REND toujours son verdict', () => {
    // Sans accolades : la flèche rend la promesse de la bascule. La cause nomme l'agent (migration 0194).
    expect(worker).toMatch(/escalateToHuman: async \(t, waId, agentId\) => fil\.passerAUnHumain\(t, waId, \{\s*escalade: true,\s*cause: automatique\(`agent IA /);
  });

  it('🔴 et la passation de l’agent de Meta passe, elle, par `marquerEscalade`', () => {
    // Elle doit CRÉER la conversation si la passation arrive avant l'écho de l'agent : c'est un upsert, pas
    // une prise de fil conditionnelle (`ControleDuFil.agentDeMetaPasseLaMain`).
    expect(worker).toContain('marquerEscalade: fil.agentDeMetaPasseLaMain,');
  });
});

/**
 * 🔴 LA FIN D'UN PARCOURS NE RELÂCHE PLUS LE FIL DANS LA FOULÉE DE SON DERNIER ENVOI (migration 0149).
 *
 * Mesuré en production le 2026-09-15 : la documentation de Meta dit qu'envoyer un message PREND le fil
 * implicitement. Le release partait donc avant que Meta ne traite l'envoi, et l'envoi reprenait le fil juste
 * derrière. Trois releases émis deux secondes après un envoi ont échoué, celui émis quatorze minutes après a
 * marché. (Ce texte attribuait à Meta un retard d'accusé de deux minutes : c'était notre file d'accusés.)
 *
 * Ces cas lisaient le TEXTE du câblage ; le geste vit désormais dans `src/inbox/fil.ts`, et ils l'EXÉCUTENT.
 */
describe('le fil est rendu sur ACCUSÉ, pas sur horloge', () => {
  const wiring = readFileSync(resolve(__dirname, '../src/workflow/wiring.ts'), 'utf8');
  const index = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');

  it('🔴 l’exécuteur rend le fil par CE geste, et le relais de l’agent de Meta aussi', () => {
    expect(wiring).toContain('releaseToMba: fil.rendreApresParcours,');
    const gestes = index.slice(index.indexOf('...creerGestesEnvoi({'));
    expect(gestes.slice(0, gestes.indexOf('attendreFinDuTour'))).toMatch(/\n\s+fil,\r?\n/);
  });

  it('🔴 la fin de parcours MARQUE, elle n’appelle pas Meta', async () => {
    // C'est l'assertion qui porte tout le correctif : aucun appel à Meta tant que notre dernier envoi est en vol.
    const b = bancDuFil({ conversations: { w: { owner: 'app_workflow', enVol: 'wamid.DERNIER' } } });
    await b.fil.rendreApresParcours('t1', 'w');
    expect(b.appels).toEqual([]);
    expect(b.etat('w')?.marque).toBe('wamid.DERNIER');
  });

  it('🔴 l’état d’attente est `app_human`, la SEULE valeur qui garde le fil dans « À traiter »', async () => {
    // `app_workflow` l'en sortirait (c'est le défaut réparé la veille), et `mba` afficherait la marque du
    // robot sur un fil que nous tenons encore.
    const b = bancDuFil({ conversations: { w: { owner: 'app_workflow', enVol: 'wamid.DERNIER' } } });
    await b.fil.rendreApresParcours('t1', 'w');
    expect(b.etat('w')?.owner).toBe('app_human');
    const dansATraiter = (owner: string) => owner !== 'app_workflow';
    expect(dansATraiter('app_human')).toBe(true);
    expect(dansATraiter('app_workflow')).toBe(false);
  });

  it('🔴 rien n’a été envoyé -> on relâche TOUT DE SUITE, sinon le fil attend un accusé qui ne viendra pas', async () => {
    const b = bancDuFil({ conversations: { w: { owner: 'app_workflow' } } });
    await b.fil.rendreApresParcours('t1', 'w');
    // Confier : le contact sur la liste de l'agent, puis le release.
    expect(b.appels).toEqual(['ajout:w', 'release:w']);
    expect(b.etat('w')?.owner).toBe('mba');
  });

  it('🔴 la remise écrit `mba` APRÈS l’accord de Meta, jamais avant', async () => {
    // L'ordre inverse est celui qui mentait : la colonne restait à `mba` sur un refus, et la seule trace
    // était une ligne de console. Ici l'état d'attente est déjà honnête, donc il n'y a rien à anticiper.
    const ordre: string[] = [];
    const accepte = bancDuFil({
      appels: ordre,
      conversations: { w: { owner: 'app_human', marque: 'wamid.A' } },
    });
    await accepte.fil.remettreSurAccuse('wamid.A');
    ordre.push(`colonne:${accepte.etat('w')?.owner}`);
    expect(ordre).toEqual(['ajout:w', 'release:w', 'colonne:mba']);

    // Le refus qui compte est celui de l'ajout à la liste : un `release` refusé après elle confie quand même (`confier`).
    const refuse = bancDuFil({ ajout: ['refuse'], conversations: { w: { owner: 'app_human', marque: 'wamid.A' } } });
    await expect(refuse.fil.remettreSurAccuse('wamid.A')).rejects.toThrow();
    expect(refuse.etat('w')?.owner, 'un refus de Meta n’écrit pas `mba`').toBe('app_human');
  });

  it('🔴 les DEUX files qui voient des statuts reçoivent la remise', () => {
    // Une capacité câblée sur un consommateur sur deux est un correctif à moitié : un accusé arrive par
    // `webhook` ou par `webhook-status` selon le lot que Meta nous envoie, et ce découpage ne nous
    // appartient pas.
    const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');
    const lignes = worker.split('\n').filter((l) => l.includes('remiseMba:'));
    expect(lignes).toHaveLength(2);
    expect(lignes.every((l) => l.includes('fil.remettreSurAccuse'))).toBe(true);
  });

  it('⚠️ le BALAYAGE, lui, appelle Meta directement, et c’est correct', async () => {
    // Il tourne loin de tout envoi : il n'y a aucune course à éviter, et passer par le marqueur ferait
    // attendre un accusé qui n'arrivera jamais sur une conversation sans envoi récent.
    const b = bancDuFil({ conversations: { w: { owner: 'app_human', enVol: 'wamid.VIEUX' } } });
    expect(await b.fil.rendreApresInactivite('t1', 'w', 'app_human', 'mba')).toBe(true);
    expect(b.appels).toEqual(['ajout:w', 'release:w']);
    expect(b.etat('w')?.marque).toBeNull();
  });
});

/**
 * LE REJEU DE LA REPRISE DU FIL, ENFIN EXERÇABLE (lot du 2026-09-15, plan `2026-09-15-rejeu-prise-du-fil.md`).
 *
 * 🔴 CES CAS REMPLACENT UN GREP, et c'est tout l'intérêt du lot. Le rejeu vivait dans une fermeture de
 * `buildWorkflowRuntime` : il n'avait aucune interface, donc personne ne pouvait l'appeler, donc ses quatre
 * règles étaient gardées par `tests/scenario-fil-non-repris.test.ts` qui cherchait les chaînes
 * `err.retryable` et `tentative < 2` dans le TEXTE de `wiring.ts`. Ce grep prouvait qu'un motif était écrit ;
 * il ne prouvait ni qu'on rejoue UNE fois, ni qu'on ne rejoue pas un refus définitif, ni combien on attend.
 * Il s'exerce par le geste qui l'emprunte (`reprendrePourLApp`, `src/inbox/fil.ts`). Depuis le mode liste, reprendre
 * c'est retirer le contact de la liste de l'agent de Meta (`src/mba/liste.ts`), qui porte le rejeu.
 */
describe('reprendre le fil (retrait de la liste) : un rejeu, et jamais deux', () => {
  const rejouable = (retryAfterMs?: number) => new MetaApiError(429, null, retryAfterMs);
  const definitif = () => new MetaApiError(400, null);

  /** Un banc qui compte les appels et les attentes, sans jamais dormir. Les deux contacts sont sur la liste. */
  function banc(resultats: Array<'ok' | Error>) {
    const b = bancDuFil({
      conversations: { '33600000001': { owner: 'mba' }, w: { owner: 'mba' } },
      surLaListe: ['33600000001', 'w'],
      retrait: resultats.map((r): ReponseMeta => (r === 'ok' ? 'accepte' : r)),
    });
    return { prendre: (t: string, w: string) => b.fil.reprendrePourLApp(t, w), attentes: b.attentes, appels: () => b.appels.length };
  }

  it('du premier coup : un seul appel, aucune attente', async () => {
    const b = banc(['ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(true);
    expect(b.appels()).toBe(1);
    expect(b.attentes).toEqual([]);
  });

  it('🔴 un refus REJOUABLE est rejoué UNE fois, et le second essai réussit', async () => {
    const b = banc([rejouable(), 'ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(true);
    expect(b.appels()).toBe(2);
    expect(b.attentes).toHaveLength(1);
  });

  it('🔴 deux refus rejouables : on s’arrête à DEUX appels, on ne boucle pas', async () => {
    // Insister ajouterait N appels inutiles au milieu d'une campagne, un par destinataire.
    const b = banc([rejouable(), rejouable(), 'ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(false);
    expect(b.appels()).toBe(2);
  });

  it('🔴 un refus DÉFINITIF n’est jamais rejoué', async () => {
    const b = banc([definitif(), 'ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(false);
    expect(b.appels(), 'un 400 de Meta a été rejoué').toBe(1);
    expect(b.attentes, 'on a attendu avant de renoncer').toEqual([]);
  });

  it('🔴 l’attente vaut le `Retry-After` de Meta, PLAFONNÉ à 2 s', async () => {
    // Le plafond est la vraie règle : on est dans la boucle d'envoi d'une campagne, et une attente longue ne
    // retarde pas ce destinataire-là, elle retarde tous les suivants.
    expect((await (async () => { const b = banc([rejouable(1200), 'ok']); await b.prendre('t', 'w'); return b.attentes; })())).toEqual([1200]);
    expect((await (async () => { const b = banc([rejouable(30_000), 'ok']); await b.prendre('t', 'w'); return b.attentes; })())).toEqual([REJEU_ATTENTE_MAX_MS]);
  });

  it('⚠️ sans `Retry-After`, on attend le défaut du dépôt', async () => {
    const b = banc([rejouable(), 'ok']);
    await b.prendre('t1', '33600000001');
    expect(b.attentes).toEqual([REJEU_ATTENTE_DEFAUT_MS]);
  });

  it('🔴 un contact ABSENT de la liste se reprend sans aucun appel, numéro connecté ou non', async () => {
    // Absent de la liste, l'agent ne lui parle pas : écrire notre état local suffit. `true` signifie « Meta n'a pas
    // protesté », ce qui couvre ce cas.
    const b = bancDuFil({ numero: null, conversations: { '33600000001': { owner: 'mba' } } });
    expect(await b.fil.reprendrePourLApp('t1', '33600000001')).toBe(true);
    expect(b.appels).toEqual([]);
    expect(b.attentes).toEqual([]);
  });

  it('⚠️ il ne LÈVE jamais : l’appelant décide d’écrire ou non son état local', async () => {
    const b = banc([definitif()]);
    await expect(b.prendre('t1', '33600000001')).resolves.toBe(false);
  });
});
