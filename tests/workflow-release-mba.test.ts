import { jamaisDesabonne } from './consentement';
import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import { runControlSweep } from '../src/inbox/control-sweep';
import type { ControlSweepDeps } from '../src/inbox/control-sweep';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * Le RELÂCHEMENT du fil vers l'agent de Meta : quand il part, et surtout quand il ne part PAS.
 *
 * La règle tient en une phrase : on relâche exactement quand le parcours se termine sans attendre de choix du
 * client. Une étape qui offre des boutons garde la main (la réponse doit nous revenir pour être appariée), un
 * bloc « Assigner à un agent » la donne à un humain, et la minuterie s'en occupe ensuite.
 */

const n = (id: string, type: string, data: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];
const g = (nodes: WorkflowGraph['nodes'], edges: Array<[string, string, string?]> = []): WorkflowGraph => ({
  nodes,
  edges: edges.map(([source, target, handle], i) => ({ id: `e${i}`, source, target, ...(handle ? { sourceHandle: handle } : {}) })),
});

/** Exécuteur à dépendances minimales : aucune base, aucun réseau. `releases` enregistre les fils relâchés. */
function executeur(graph: WorkflowGraph, opts: { mbaActif?: boolean; run?: Record<string, unknown> } = {}) {
  const releases: string[] = [];
  // L'ORDRE des deux gestes vers l'agent de Meta : le fil d'abord, le message ensuite.
  const ordre: string[] = [];
  const etats: Array<Record<string, unknown>> = [];
  const run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600000001', currentNode: 'n1', lastMessageId: null, ...opts.run };
  const ex = new WorkflowExecutor({
    estDesabonne: jamaisDesabonne,
    runs: {
      findWaitingByWaId: async (): Promise<typeof run> => run,
      setState: async (_id: string, state: Record<string, unknown>): Promise<void> => { etats.push(state); },
    },
    getGraph: async () => graph,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    escalateToHuman: async () => {},
    mbaActifPour: async (): Promise<boolean> => opts.mbaActif === true,
    releaseToMba: async (_t: string, waId: string): Promise<void> => { releases.push(waId); ordre.push(`release ${waId}`); },
    transmettreHorsParcours: async (_t: string, waId: string, messageId: string): Promise<void> => { ordre.push(`transmis ${waId} ${messageId}`); },
  } as never);
  return { ex, releases, etats, run, ordre };
}

describe('release : quand le parcours se termine', () => {
  it('🔴 réponse HORS des boutons attendus -> le fil repart à l’agent', async () => {
    // Aucune arête ne correspond au payload reçu : plus personne n'attend une réponse précise. Le message reste
    // visible dans l'Inbox sans rien faire de plus, « non lu » étant DÉRIVÉ d'un entrant plus récent que la
    // dernière ouverture du fil.
    const graph = g([n('n1', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] }), n('n2', 'tag', { tag: 'ok' })], [['n1', 'n2', 'Oui']]);
    const { ex, releases } = executeur(graph, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'Autre chose');
    expect(releases).toEqual(['33600000001']);
  });

  it('🔴 réponse SUR un bouton attendu -> aucun release, le scénario avance', async () => {
    const graph = g(
      [n('n1', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] }), n('n2', 'quick_message', { body: 'Suite ?', quickReplies: [{ text: 'Encore' }] })],
      [['n1', 'n2', 'Oui']],
    );
    const { ex, releases, etats } = executeur(graph, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(releases).toEqual([]);
    expect(etats[etats.length - 1]).toMatchObject({ status: 'waiting' });
  });

  it('🔴 MBA ÉTEINT : aucun appel, quoi qu’il arrive', async () => {
    // Le garde-fou qui rend ce chantier gratuit en exploitation tant qu'aucun client n'a l'agent.
    const graph = g([n('n1', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] })]);
    const { ex, releases } = executeur(graph, { mbaActif: false });
    await ex.advance('t1', '33600000001', 'msg1', 'Hors script');
    expect(releases).toEqual([]);
  });

  it('un parcours qui atteint le bloc « Assigner à un agent » ne relâche PAS', async () => {
    // Le fil va à un humain : le rendre à l'agent au premier « ok merci » du client défairait l'assignation.
    const graph = g([n('n1', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] }), n('n2', 'inbox')], [['n1', 'n2', 'Oui']]);
    const { ex, releases, etats } = executeur(graph, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(etats[etats.length - 1]).toMatchObject({ status: 'inbox' });
    expect(releases).toEqual([]);
  });
});

describe('release : la minuterie de reprise après un humain', () => {
  const H = 3600_000;
  const T0 = Date.parse('2026-08-18T12:00:00Z');
  const ago = (ms: number) => new Date(T0 - ms);

  function sweep(avecMba: string[], releaseKo = false, dernierMessage: Date = ago(1 * H)) {
    const rendues: Array<{ waId: string; dest: string }> = [];
    const releases: string[] = [];
    const deps: ControlSweepDeps = {
      listHeldControl: async () => [
        { tenantId: 'avec', waId: 'a', owner: 'app_human', changedAt: ago(100 * H), lastMessageAt: dernierMessage, escaladee: false },
        { tenantId: 'sans', waId: 'b', owner: 'app_human', changedAt: ago(100 * H), lastMessageAt: dernierMessage, escaladee: false },
      ],
      setControlOwner: async (_t, waId, owner) => { rendues.push({ waId, dest: owner }); return true; },
      mbaActifParTenant: async () => new Set(avecMba),
      releaseToMba: async (_t, waId) => {
        releases.push(waId);
        if (releaseKo) throw new Error('529 chez Meta');
        return true;
      },
      timeouts: { app_human: 2 * H, mba: 24 * H },
      now: () => T0,
    };
    return { deps, rendues, releases };
  }

  it('🔴 la destination se DÉDUIT de l’état du compte, elle ne se règle plus', async () => {
    const { deps, rendues, releases } = sweep(['avec']);
    expect(await runControlSweep(deps)).toBe(2);
    expect(rendues).toEqual([{ waId: 'a', dest: 'mba' }, { waId: 'b', dest: 'app_workflow' }]);
    // Un seul appel Meta : celui du client qui a l'agent allumé.
    expect(releases).toEqual(['a']);
  });

  it('🔴 un release REFUSÉ n’écrit AUCUN état local, et c’est l’inverse d’avant', async () => {
    /**
     * 🔴 CE TEST REMPLACE SON CONTRAIRE, ET LE DIT. Il affirmait « un release en échec ne regèle PAS la
     * conversation », c'est-à-dire que la bascule locale passait quand même. C'était un choix assumé (ne pas
     * geler un fil sur un hoquet réseau), et c'est ce choix qui a produit l'incident du 2026-09-15 : neuf
     * conversations annonçant `mba` alors que Meta pensait le contraire, donc deux systèmes qui se croyaient
     * chacun déchargés du client.
     *
     * ⚠️ La crainte d'origine ne se réalise pas : refuser d'écrire ne GÈLE rien. La conversation reste dans
     * l'état où elle est, donc VISIBLE dans « À traiter », et ce balayage repasse toutes les cinq minutes.
     */
    const { deps, rendues } = sweep(['avec'], true);
    // Seul `b` bascule : son client n'a pas d'agent de Meta, donc aucun appel Meta sur son chemin.
    expect(await runControlSweep(deps)).toBe(1);
    expect(rendues.find((r) => r.waId === 'a'), 'un refus de Meta ne doit rien écrire').toBeUndefined();
    expect(rendues.find((r) => r.waId === 'b')?.dest).toBe('app_workflow');
  });

  it('🔴 une fenêtre FERMÉE ne déclenche aucune passation, et ne replie pas sur app_workflow', async () => {
    /**
     * 🔴 LE CŒUR DE L'INCIDENT DU 2026-09-15. Ce balayage a rendu dix conversations d'un coup, toutes muettes
     * depuis 166 à 281 heures. L'agent de Meta ne peut prendre un fil que s'il existe une session ouverte :
     * il n'y avait rien à transmettre, et le message suivant de l'une d'elles est arrivé chez NOUS.
     *
     * ⚠️ ON SAUTE, ON NE REPLIE PAS. `app_workflow` est la seule valeur que « À traiter » exclut : y basculer
     * un `app_human` abandonné le rendrait invisible, soit un défaut pire que celui qu'on répare.
     */
    const { deps, rendues, releases } = sweep(['avec'], false, ago(200 * H));
    expect(await runControlSweep(deps)).toBe(1);
    expect(releases, 'aucun appel Meta sur une fenêtre fermée').toEqual([]);
    expect(rendues.find((r) => r.waId === 'a'), 'la conversation reste telle quelle, donc visible').toBeUndefined();
  });
});

/**
 * 🔴 LA RÉPONSE « À CÔTÉ » PART CHEZ L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 5). Sans elle, l'agent
 * reprend le fil mais ne parle qu'au message SUIVANT du client : la question qu'il vient de poser reste sans réponse.
 */
describe('la réponse « à côté » est transmise à l’agent de Meta', () => {
  const question = () => g(
    [n('n1', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] }), n('n2', 'tag', { tag: 'ok' })],
    [['n1', 'n2', 'Oui']],
  );

  it('🔴 réponse libre : le fil est rendu PUIS CE message transmis', async () => {
    const { ex, ordre } = executeur(question(), { mbaActif: true });
    // Un message tapé arrive SANS charge de bouton (`contentOf`, type `text`).
    await ex.advance('t1', '33600000001', 'msg1', null);
    expect(ordre).toEqual(['release 33600000001', 'transmis 33600000001 msg1']);
  });

  it('🔴 une RÉACTION n’est pas un message : le fil est rendu, rien n’est transmis', async () => {
    // Sa charge porte l'identifiant du message visé, qui ne ressemble à aucun bouton (revue finale du 2026-09-22).
    const { ex, ordre } = executeur(question(), { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'wamid.VISE');
    expect(ordre).toEqual(['release 33600000001']);
  });

  it('🔴 un rapport RCS n’est pas un message : le fil est rendu, rien n’est transmis', async () => {
    // Un parcours sur le canal RCS, dont le dernier bloc n'a pas de suite : le rapport `sent` le termine.
    const rcs = g([n('n1', 'rcs_message', { text: 'Bonjour' })]);
    const { ex, ordre } = executeur(rcs, { mbaActif: true, run: { channel: 'rcs' } });
    await ex.advance('t1', '33600000001', 'msg1', null, 'rcs');
    expect(ordre).toEqual(['release 33600000001']);
  });

  it('🔴 un bouton sans suite va à un humain : RIEN n’est transmis', async () => {
    const { ex, ordre } = executeur(g([n('n1', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] })]), { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'btn:0');
    expect(ordre).toEqual([]);
  });

  it('🔴 une fin NORMALE de parcours rend le fil SANS rien transmettre', async () => {
    const { ex, ordre } = executeur(question(), { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(ordre).toEqual(['release 33600000001']);
  });

  it('🔴 une réponse écrite qui suit une flèche LIBRE vers un bloc MUET est transmise (essai du 2026-09-22)', async () => {
    // « Parfait biloute » sous un bloc à boutons dont la flèche libre menait à une action : la chaîne s'est
    // terminée sans rien envoyer, et l'agent a repris le fil sans savoir que le client venait d'écrire.
    const libre = g(
      [n('n1', 'quick_message', { body: 'bonjour ca va', quickReplies: [{ text: 'Oui' }] }), n('n2', 'tag', { tag: 'ok' }), n('n3', 'tag', { tag: 'libre' })],
      [['n1', 'n2', 'btn:0'], ['n1', 'n3']],
    );
    const { ex, ordre } = executeur(libre, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', null);
    expect(ordre).toEqual(['release 33600000001', 'transmis 33600000001 msg1']);
  });

  it('🔴 une réponse que la chaîne a RECUEILLIE n’est pas transmise non plus (arbitrage de Julien du 2026-09-23)', async () => {
    // « Votre e-mail ? », flèche libre, action « écrire le champ = dernière saisie », fin sans envoi : le message
    // avait bien un destinataire, la chaîne. Le transmettre en plus faisait commenter une adresse e-mail hors
    // contexte par l'agent de Meta.
    const recueille = g(
      [
        n('n1', 'quick_message', { body: 'Votre e-mail ?', quickReplies: [] }),
        n('n2', 'field', { key: 'email', valueKind: 'derniere_saisie' }),
      ],
      [['n1', 'n2']],
    );
    const { ex, ordre } = executeur(recueille, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', null);
    expect(ordre).toEqual(['release 33600000001']);
  });

  it('⚠️ mais un bloc qui lit la saisie AILLEURS dans le graphe ne rend pas le reste muet', async () => {
    // On regarde les blocs réellement TRAVERSÉS, pas le graphe entier : sinon un scénario qui recueille une
    // donnée sur une de ses branches cesserait de transmettre sur toutes les autres.
    const ailleurs = g(
      [
        n('n1', 'quick_message', { body: 'bonjour', quickReplies: [{ text: 'Oui' }] }),
        n('n2', 'field', { key: 'email', valueKind: 'derniere_saisie' }),
        n('n3', 'tag', { tag: 'libre' }),
      ],
      [['n1', 'n2', 'btn:0'], ['n1', 'n3']],
    );
    const { ex, ordre } = executeur(ailleurs, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', null);
    expect(ordre).toEqual(['release 33600000001', 'transmis 33600000001 msg1']);
  });

  it('🔴 une réponse écrite à laquelle la chaîne a RÉPONDU n’est pas transmise : l’agent parlerait par-dessus', async () => {
    const repond = g(
      [n('n1', 'quick_message', { body: 'Votre e-mail ?', quickReplies: [] }), n('n2', 'quick_message', { body: 'Merci, noté.', quickReplies: [] })],
      [['n1', 'n2']],
    );
    const { ex, ordre } = executeur(repond, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', null);
    expect(ordre).toEqual(['release 33600000001']);
  });

  it('MBA éteint : ni release ni transmission', async () => {
    const { ex, ordre } = executeur(question(), { mbaActif: false });
    await ex.advance('t1', '33600000001', 'msg1', 'Hors script');
    expect(ordre).toEqual([]);
  });
});
