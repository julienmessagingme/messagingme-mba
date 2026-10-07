import { describe, it, expect } from 'vitest';
import {
  LONGUEUR_MAX_ETIQUETTE, creerPoseEtiquette, nettoyerEtiquettes, normaliserEtiquette, type DepsPoseEtiquette,
} from '../src/crm/poser-etiquette';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import { AUTOMATION_EVENT_QUEUE } from '../src/automation/event-job';
import { offresToutOuvert } from './gardes';

/**
 * POSER UNE ÉTIQUETTE SUR UN CONTACT, le geste commun des cinq portes unitaires (plan
 * `docs/superpowers/plans/2026-10-04-poser-une-etiquette.md`). Remplace `tests/agent-poser-tag.test.ts` : le module
 * a quitté `src/agent/`, et ses cas sont repris ici un par un.
 *
 * 🔴 CE TEST EXISTE PARCE QUE CETTE RÈGLE A DÉJÀ MENTI. L'outil `mba_poser_tag` posait le tag sur le contact et
 * s'arrêtait là, alors que sa description, montrée au client dans la console, promet « pour le retrouver dans le
 * mini-CRM ou DÉCLENCHER UNE AUTOMATION ». Un client qui réglait une automation sur tag et demandait à son agent de le
 * poser ne voyait jamais rien se déclencher. Puis la règle a été recopiée dans quatre autres portes, chacune avec ses
 * écarts (l'outil MCP sans borne ni déclaration, la fiche sans déclaration).
 *
 * Les portes elles-mêmes, sur ce module : `tests/mcp-serveur.test.ts` (outil MCP), `tests/contacts.test.ts` (fiche),
 * `tests/widget-devenir.test.ts` (widget), `tests/workflow-lancements.test.ts` (scénario, type de lancement par type),
 * et le câblage du socle plus bas (agent, bloc de scénario).
 */

/** Un contact qui porte déjà `deja`, et chaque effet noté. */
function make(deja: string[] = [], surcharge: Partial<DepsPoseEtiquette> = {}) {
  const cap = { poses: [] as string[][], declares: [] as string[], emis: [] as string[], fiches: [] as string[] };
  const deps: DepsPoseEtiquette = {
    ajouterAuContact: async (_t, _w, tags) => { cap.poses.push(tags); return { added: tags.filter((t) => !deja.includes(t)) }; },
    waIdDeLaFiche: async (_t, id) => { cap.fiches.push(id); return id === 'c1' ? '33600' : null; },
    declarer: async (_t, tag) => { cap.declares.push(tag); },
    emettre: async (_t, w, tag) => { cap.emis.push(`${w}:${tag}`); },
    ...surcharge,
  };
  return { cap, pose: creerPoseEtiquette(deps) };
}

describe('le nettoyage d’une étiquette, le même pour toutes les poses', () => {
  it('`normaliserEtiquette` : espaces autour retirés, 64 caractères au plus, vide si rien ne reste', () => {
    expect(normaliserEtiquette('  vip  ')).toBe('vip');
    expect(normaliserEtiquette('x'.repeat(65))).toHaveLength(LONGUEUR_MAX_ETIQUETTE);
    expect(normaliserEtiquette('x'.repeat(100))).toHaveLength(64);
    expect(normaliserEtiquette('   ')).toBe('');
    expect(normaliserEtiquette('vip client')).toBe('vip client');
  });

  it('`nettoyerEtiquettes` : vides et doublons écartés APRÈS normalisation, dans l’ordre, puis la borne de la porte', () => {
    const long = 'x'.repeat(64);
    expect(nettoyerEtiquettes(['  vip', 'vip ', '', '   ', `${long}a`, `${long}b`, 'chaud'], 50)).toEqual(['vip', long, 'chaud']);
    // La borne tombe après le dédoublonnage : dix fois la même ne remplissent pas la liste.
    expect(nettoyerEtiquettes([...Array(10).fill('vip'), 'a', 'b'], 3)).toEqual(['vip', 'a', 'b']);
    expect(nettoyerEtiquettes(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(nettoyerEtiquettes([], 10)).toEqual([]);
  });
});

describe('`poser` : nettoyer, poser, déclarer, publier si DEMANDÉ', () => {
  it('🔴 avec `publier: true`, les QUATRE effets : nettoyage, contact, référentiel, file d’automations', async () => {
    const { cap, pose } = make();
    expect(await pose.poser('t1', '33600', ['  vip '], { publier: true })).toEqual({ nouvelles: ['vip'] });
    expect(cap.poses).toEqual([['vip']]);
    expect(cap.declares).toEqual(['vip']);
    expect(cap.emis).toEqual(['33600:vip']);
  });

  it('🔴 n’émet PAS quand l’étiquette était déjà là', async () => {
    // Un agent qui repose la même étiquette à chaque tour relancerait l'automation pour un non-événement, donc
    // enverrait un message au contact chaque fois qu'il se répète.
    const { cap, pose } = make(['vip']);
    expect(await pose.poser('t1', '33600', ['vip'], { publier: true })).toEqual({ nouvelles: [] });
    expect(cap.poses).toEqual([['vip']]);
    expect(cap.declares).toEqual(['vip']); // la déclaration, elle, reste : le référentiel est une union
    expect(cap.emis).toEqual([]);
  });

  it('🔴 avec `publier: false`, RIEN n’est publié, même pour une étiquette nouvelle', async () => {
    // Le widget, l'outil MCP et le bloc de scénario (dont l'exécuteur publie à part, selon le lancement).
    const { cap, pose } = make();
    expect(await pose.poser('t1', '33600', ['vip', 'chaud'], { publier: false })).toEqual({ nouvelles: ['vip', 'chaud'] });
    expect(cap.declares).toEqual(['vip', 'chaud']);
    expect(cap.emis).toEqual([]);
  });

  it('plusieurs étiquettes : une seule pose, chacune déclarée, seules les nouvelles publiées', async () => {
    const { cap, pose } = make(['vip']);
    expect(await pose.poser('t1', '33600', ['vip', 'chaud', ' chaud'], { publier: true })).toEqual({ nouvelles: ['chaud'] });
    expect(cap.poses).toEqual([['vip', 'chaud']]);
    expect(cap.declares).toEqual(['vip', 'chaud']);
    expect(cap.emis).toEqual(['33600:chaud']);
  });

  it('une déclaration en échec n’empêche NI la pose NI l’émission, ni les déclarations suivantes', async () => {
    // Un référentiel incomplet est un désagrément, un outil qui lève est un tour d'agent mort.
    const emis: string[] = [];
    const declares: string[] = [];
    const pose = creerPoseEtiquette({
      ajouterAuContact: async (_t, _w, tags) => ({ added: tags }),
      waIdDeLaFiche: async () => null,
      declarer: async (_t, tag) => {
        if (tag === 'vip') throw new Error('référentiel injoignable');
        declares.push(tag);
      },
      emettre: async (_t, _w, tag) => { emis.push(tag); },
    });
    await expect(pose.poser('t1', '33600', ['vip', 'chaud'], { publier: true })).resolves.toEqual({ nouvelles: ['vip', 'chaud'] });
    expect(declares).toEqual(['chaud']);
    expect(emis).toEqual(['vip', 'chaud']);
  });

  it('une file en panne REMONTE à l’appelant, après la pose et la déclaration : c’est lui qui décide', async () => {
    // L'agent laisse remonter (comme avant le module), la fiche journalise, l'exécuteur avale.
    const { cap, pose } = make([], { emettre: async () => { throw new Error('file indisponible'); } });
    await expect(pose.poser('t1', '33600', ['vip'], { publier: true })).rejects.toThrow('file indisponible');
    expect(cap.poses).toEqual([['vip']]);
    expect(cap.declares).toEqual(['vip']);
  });

  it('normalise avant tout, et de la MÊME façon pour les trois effets', async () => {
    // Sans ça « vip » et « vip  » seraient deux étiquettes, et celle posée sur le contact ne correspondrait ni à
    // celle déclarée ni à celle annoncée à l'automation.
    const { cap, pose } = make();
    await pose.poser('t1', '33600', [`  vip${'x'.repeat(100)}  `], { publier: true });
    const propre = cap.poses[0]?.[0];
    expect(propre).toHaveLength(64);
    expect(cap.declares).toEqual([propre]);
    expect(cap.emis).toEqual([`33600:${propre}`]);
  });

  it('une étiquette vide ne fait RIEN, et surtout n’émet pas', async () => {
    const { cap, pose } = make();
    for (const vide of ['', '   ', '\t\n ']) {
      expect(await pose.poser('t1', '33600', [vide], { publier: true })).toEqual({ nouvelles: [] });
    }
    expect(await pose.poser('t1', '33600', [], { publier: true })).toEqual({ nouvelles: [] });
    expect(cap.poses).toEqual([]);
    expect(cap.declares).toEqual([]);
    expect(cap.emis).toEqual([]);
  });
});

describe('`apresPose` : la suite d’une pose faite ailleurs (la fiche, dans la transaction d’`applyEdits`)', () => {
  it('🔴 déclare TOUTES les posées, publie les SEULES nouvelles, sans jamais reposer', async () => {
    const { cap, pose } = make();
    await pose.apresPose('t1', 'c1', { posees: ['vip', 'chaud'], nouvelles: ['chaud'] }, { publier: true });
    expect(cap.poses, 'la pose a déjà eu lieu dans la transaction').toEqual([]);
    expect(cap.declares).toEqual(['vip', 'chaud']);
    expect(cap.emis).toEqual(['33600:chaud']);
  });

  it('sans rien de nouveau, ou sans publication demandée, le wa_id n’est même pas lu', async () => {
    const { cap, pose } = make();
    await pose.apresPose('t1', 'c1', { posees: ['vip'], nouvelles: [] }, { publier: true });
    await pose.apresPose('t1', 'c1', { posees: ['chaud'], nouvelles: ['chaud'] }, { publier: false });
    expect(cap.declares).toEqual(['vip', 'chaud']);
    expect(cap.fiches).toEqual([]);
    expect(cap.emis).toEqual([]);
  });

  it('une fiche sans identité joignable n’a rien à déclencher, mais ses étiquettes sont déclarées', async () => {
    const { cap, pose } = make();
    await pose.apresPose('t1', 'c-anonyme', { posees: ['vip'], nouvelles: ['vip'] }, { publier: true });
    expect(cap.declares).toEqual(['vip']);
    expect(cap.fiches).toEqual(['c-anonyme']);
    expect(cap.emis).toEqual([]);
  });
});

describe('`publierEnDiffere` : la publication que l’exécuteur demande après les effets d’un parcours', () => {
  it('nettoie, puis publie chaque étiquette ; une étiquette vide ne publie rien', async () => {
    const { cap, pose } = make();
    await pose.publierEnDiffere('t1', '33600', [' vip ']);
    await pose.publierEnDiffere('t1', '33600', ['   ']);
    expect(cap.emis).toEqual(['33600:vip']);
    expect(cap.poses).toEqual([]);
    expect(cap.declares).toEqual([]);
  });
});

/**
 * LE CÂBLAGE DU SOCLE, MONTÉ ET EXÉCUTÉ : `buildWorkflowRuntime` construit la pose une fois, sur ses dépôts et sa file,
 * et en tire la porte de l'agent et les deux dépendances du bloc de scénario. Monté sans base (ses dépôts ne font que
 * retenir le pool, et le faux pool répond vide), comme dans `tests/controle-du-fil-cablage.test.ts`.
 */
function socle(deja: string[] = []) {
  const file: Array<{ name: string; data: unknown }> = [];
  const requetes: string[] = [];
  const poses: string[][] = [];
  const inerte = {} as never;
  const runtime = buildWorkflowRuntime({
    pool: { query: async (sql: string) => { requetes.push(sql); return { rows: [], rowCount: 1 }; } } as never,
    queue: { enqueue: async (name, data) => { file.push({ name, data }); } },
    dryRun: true, repo: inerte,
    contactStore: {
      addTagsByPhoneReturningNew: async (_t: string, _w: string, tags: string[]) => {
        poses.push(tags);
        return { touched: 1, added: tags.filter((t) => !deja.includes(t)) };
      },
    } as never,
    inboxStore: inerte, settingsStore: inerte, workflowStore: inerte, metaCredentials: inerte, metaFactory: inerte,
    rcsProvider: 'fake', emailTemplates: inerte, emailResolver: inerte, numeroDeLEspace: async () => null, runStore: inerte,
    fil: inerte,
    offres: offresToutOuvert,
  });
  const publiees = () => file.map((j) => {
    expect(j.name).toBe(AUTOMATION_EVENT_QUEUE);
    const job = j.data as { tenantId: string; event: { kind: string; waId: string; tag: string } };
    return `${job.tenantId}:${job.event.kind}:${job.event.waId}:${job.event.tag}`;
  });
  const declarations = () => requetes.filter((q) => /insert into tags/.test(q)).length;
  return { runtime, poses, publiees, declarations };
}

describe('le câblage du socle : l’agent publie, le bloc de scénario laisse l’exécuteur décider', () => {
  it('🔴 l’agent (IA et de Meta) : pose, déclare, et PUBLIE l’étiquette nouvelle (inchangé)', async () => {
    const s = socle();
    await s.runtime.poserTagDepuisAgent('t1', '33600', ' vip ');
    expect(s.poses).toEqual([['vip']]);
    expect(s.declarations()).toBe(1);
    expect(s.publiees()).toEqual(['t1:tag_added:33600:vip']);
  });

  it('l’agent qui repose une étiquette présente ne publie rien', async () => {
    const s = socle(['vip']);
    await s.runtime.poserTagDepuisAgent('t1', '33600', 'vip');
    expect(s.declarations()).toBe(1);
    expect(s.publiees()).toEqual([]);
  });

  it('🔴 le bloc de scénario : `applyTag` pose et déclare SANS publier, et dit si l’étiquette était nouvelle', async () => {
    const s = socle(['vip']);
    const { applyTag, emitTagAdded } = Reflect.get(s.runtime.executor, 'deps') as WorkflowExecutorDeps;
    expect(await applyTag('t1', '33600', ' chaud ')).toBe(true);
    expect(await applyTag('t1', '33600', 'vip')).toBe(false);
    expect(await applyTag('t1', '33600', '   ')).toBe(false);
    expect(s.poses).toEqual([['chaud'], ['vip']]);
    expect(s.declarations()).toBe(2);
    expect(s.publiees(), 'la publication est celle de l’exécuteur, selon le lancement').toEqual([]);
    // La publication différée, que l'exécuteur demande sur un lancement unitaire : l'étiquette nettoyée.
    await emitTagAdded('t1', '33600', ` ${'x'.repeat(70)}`);
    await emitTagAdded('t1', '33600', '  ');
    expect(s.publiees()).toEqual([`t1:tag_added:33600:${'x'.repeat(64)}`]);
  });

  it('le socle rend la pose qu’il a construite : l’API (outil MCP, fiche) et le worker (widget) reçoivent la même', async () => {
    const s = socle();
    await s.runtime.etiquettes.poser('t1', '33600', ['vip'], { publier: false });
    expect(s.poses).toEqual([['vip']]);
    expect(s.declarations()).toBe(1);
    expect(s.publiees()).toEqual([]);
  });
});
