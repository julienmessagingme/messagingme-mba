import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });

/** a -> b : le contact répond sur `a`, le parcours doit avancer sur `b`. */
const graphe: WorkflowGraph = {
  nodes: [n('a', 'quick_message', { body: 'A' }), n('b', 'quick_message', { body: 'B' })],
  edges: [e('e1', 'a', 'b')],
};

/**
 * Store de runs qui sait écrire CONDITIONNELLEMENT, comme celui de production. `aBouge` simule la course :
 * un autre traitement a fait avancer le run pendant qu'on travaillait.
 */
class RunsConditionnels {
  run: WorkflowRunRow | null = {
    id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'a', status: 'waiting', lastMessageId: null,
  };
  aBouge = false;
  /** Ce que la garde a reçu comme bloc de DÉPART, appel par appel. */
  readonly gardes: Array<string | null> = [];
  readonly inconditionnels: string[] = [];
  /** Le tour est-il DÉJÀ tenu par un autre traitement ? Vrai verrou : une seule réservation à la fois. */
  private tenuPar: string | null = null;
  readonly reservations: Array<string | null> = [];
  readonly liberations: string[] = [];
  /**
   * HORLOGE SIMULÉE et bail, pour jouer la course LONGUE (le porteur lent, pas le porteur mort). Les tests
   * qui ne touchent pas `maintenant` voient un bail qui n'expire jamais, donc le comportement d'avant.
   */
  maintenant = 0;
  private bailJusqua = 0;
  /** Les jetons passés à la garde d'écriture d'état, appel par appel. */
  readonly jetonsEcriture: Array<string | null | undefined> = [];

  async reserverAvance(_t: string, _id: string, nodeId: string | null, bailSecondes = 60): Promise<string | null> {
    const tenu = this.tenuPar !== null && this.bailJusqua > this.maintenant;
    if (tenu) { this.reservations.push(null); return null; }
    if (this.run && this.run.currentNode !== nodeId) { this.reservations.push(null); return null; }
    this.tenuPar = `jeton-${this.reservations.length}`;
    this.bailJusqua = this.maintenant + bailSecondes * 1000;
    this.reservations.push(this.tenuPar);
    return this.tenuPar;
  }
  /** Prolonge, et SEULEMENT si le jeton est encore le nôtre : un porteur déchu ne repousse pas le bail d'un autre. */
  async prolongerAvance(_id: string, token: string, bailSecondes: number): Promise<boolean> {
    if (this.tenuPar !== token) return false;
    this.bailJusqua = this.maintenant + bailSecondes * 1000;
    return true;
  }
  /**
   * Un AUTRE traitement prend le tour pendant qu'on travaille. C'est ce qui arrive en production quand le bail
   * a expiré (porteur trop lent) ou que la base a été rejouée : le porteur en cours n'en sait rien tant qu'il
   * n'a pas battu. Test-only, mais fidèle : le jeton du porteur en place cesse d'être le bon.
   */
  volerLeTour(bailSecondes = 60): string {
    this.tenuPar = 'jeton-voleur';
    this.bailJusqua = this.maintenant + bailSecondes * 1000;
    return this.tenuPar;
  }

  async libererAvance(_id: string, token: string): Promise<void> {
    // Le JETON dans la garde : un porteur périmé ne libère pas le verrou de celui qui l'a repris.
    if (this.tenuPar === token) this.tenuPar = null;
    this.liberations.push(token);
  }

  async start(): Promise<{ id: string }> { return { id: 'r1' }; }
  async findWaitingByWaId(): Promise<WorkflowRunRow | null> {
    return this.run && this.run.status === 'waiting' ? this.run : null;
  }
  async setState(id: string, state: RunState): Promise<void> {
    this.inconditionnels.push(id);
    if (this.run) this.run = { ...this.run, currentNode: state.currentNode, status: state.status };
  }
  /** Requis par le contrat : un demarrage remplace le parcours en cours. Ce faux n exerce que l avance. */
  async closeActiveByWaId(): Promise<string[]> { return []; }

  async setStateSiEncoreSur(_t: string, _id: string, nodeId: string | null, state: RunState, token?: string | null): Promise<boolean> {
    this.gardes.push(nodeId);
    this.jetonsEcriture.push(token);
    if (this.aBouge) return false; // le run n'est plus là où on l'a lu : quelqu'un d'autre l'a avancé
    // Le JETON clôture l'écriture comme en production : un porteur périmé n'écrit pas par-dessus l'autre.
    if (token != null && this.tenuPar !== token) return false;
    if (this.run) this.run = { ...this.run, currentNode: state.currentNode, status: state.status };
    return true;
  }
}

function exec(runs: RunsConditionnels, over: Partial<WorkflowExecutorDeps> = {}) {
  const calls: string[] = [];
  const ex = new WorkflowExecutor({
    // Sans transtypage : c est le compilateur qui doit nommer ce faux quand le contrat bouge, pas
    // l execution. Un `as unknown as` ici avait deja laisse passer une methode manquante.
    runs,
    getGraph: async () => graphe,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    ...over,
  });
  return { ex, calls };
}

/**
 * ÉCRITURE CONDITIONNELLE DE L'AVANCE (lot 1 du programme, 2026-08-31).
 *
 * Deux avances peuvent se chevaucher DÈS AUJOURD'HUI, avec un seul worker : le process API traite certains
 * retours RCS pendant que le worker traite un webhook du même contact. Les deux lisaient le run sur le bloc N
 * et écrivaient tous les deux : le dernier gagnait, en écrasant `current_node`. Un parcours pouvait ainsi
 * REVENIR sur un bloc déjà franchi et rejouer sa branche au message suivant, sans aucune trace.
 *
 * ⚠️ Ces tests prouvent que l'ÉTAT est protégé, et RIEN DE PLUS : les messages du perdant sont déjà partis
 * quand la garde le refuse. Le double ENVOI est fermé ailleurs, par les deux blocs suivants (la réservation
 * du tour pour la course courte, son renouvellement pour la course longue). Ce commentaire a affirmé pendant
 * des semaines que c'était « un lot à part » ; il continuait de le dire une fois le lot fait.
 */
describe('avance concurrente : l’écriture d’état est conditionnée au bloc de départ', () => {
  it('cas nominal : la garde porte sur le bloc où le run a été LU, et l’écriture passe', async () => {
    const runs = new RunsConditionnels();
    const { ex, calls } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(calls).toEqual(['qm:B']); // le parcours a bien avancé
    expect(runs.gardes).toEqual(['a']); // ...gardé sur le bloc de DÉPART, pas sur la destination
    // La chaîne se termine sur `b` (aucune arête sortante) : le run est clos, ce qui prouve que l'écriture
    // conditionnelle est bien PASSÉE (sans elle, le run serait resté sur `a`).
    expect(runs.run).toMatchObject({ currentNode: null, status: 'done' });
  });

  it('🔴 le run a bougé pendant le traitement -> l’état N’EST PAS écrasé', async () => {
    const runs = new RunsConditionnels();
    runs.aBouge = true;
    const { ex } = exec(runs);
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { avertissements.push(String(m)); });
    try {
      await ex.advance('t1', '33600', 'msg1');
    } finally {
      spy.mockRestore();
    }
    // La garde a refusé : le run reste tel que l'autre traitement l'a laissé (ici, inchangé par NOUS).
    expect(runs.run).toMatchObject({ currentNode: 'a' });
    // Et on le DIT : une course qu'on ne voit pas est une course qu'on ne corrigera jamais.
    expect(avertissements.some((a) => a.includes('avance PERDUE'))).toBe(true);
  });

  it('🔴 l’écriture INCONDITIONNELLE n’est plus utilisée quand la garde existe', async () => {
    // C'est ce qui rend la protection réelle : s'il restait un `setState` nu sur un chemin d'avance, ce
    // chemin-là continuerait d'écraser l'état d'un autre traitement.
    const runs = new RunsConditionnels();
    const { ex } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.inconditionnels).toEqual([]);
  });

  it('un store SANS garde (fixtures, câblages de test) garde le comportement d’avant', async () => {
    const runs = new RunsConditionnels();
    // On retire la méthode : l'exécuteur doit retomber sur `setState`, sans rien casser.
    (runs as unknown as { setStateSiEncoreSur?: unknown }).setStateSiEncoreSur = undefined;
    const { ex, calls } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(calls).toEqual(['qm:B']);
    expect(runs.inconditionnels).toEqual(['r1']);
  });
});


/**
 * 🔴 LE TOUR EST RÉSERVÉ AVANT LES ENVOIS (migration 0104).
 *
 * C'est le trou que les tests ci-dessus disaient explicitement NE PAS fermer : l'écriture conditionnelle
 * protège l'état, mais elle arrive APRÈS les envois, donc deux avances concurrentes envoyaient toutes les
 * deux et le contact recevait un message qu'il ne devait jamais voir. La réservation ferme cela.
 */
describe('avance concurrente : le tour est RÉSERVÉ avant tout envoi', () => {
  it('🔴 deux avances SIMULTANÉES ne produisent QU’UN SEUL envoi', async () => {
    // Le test qui compte. Sans réservation, les deux avances envoient `qm:B` et le contact reçoit deux fois
    // le même message. La barrière est le store lui-même : la seconde réservation échoue tant que la
    // première n'a pas libéré.
    const runs = new RunsConditionnels();
    const { ex, calls } = exec(runs);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await Promise.all([ex.advance('t1', '33600', 'msg1'), ex.advance('t1', '33600', 'msg2')]);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual(['qm:B']);
    // Deux tentatives de réservation, une seule accordée.
    expect(runs.reservations.filter((r) => r !== null)).toHaveLength(1);
  });

  it('🔴 le perdant sort SANS RIEN FAIRE, et on le DIT', async () => {
    const runs = new RunsConditionnels();
    // Le tour est déjà pris : la réservation échouera.
    await runs.reserverAvance('t1', 'r1', 'a');
    const { ex, calls } = exec(runs);
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { avertissements.push(String(m)); });
    try {
      await ex.advance('t1', '33600', 'msg1');
    } finally {
      spy.mockRestore();
    }
    // RIEN n'est parti, et l'état n'a pas bougé : c'est exactement ce qu'on veut du perdant.
    expect(calls).toEqual([]);
    expect(runs.gardes).toEqual([]);
    expect(runs.run).toMatchObject({ currentNode: 'a' });
    expect(avertissements.some((a) => a.includes('avance IGNOREE'))).toBe(true);
  });

  it('🔴 le tour est RENDU même quand un envoi jette', async () => {
    // Sinon le message SUIVANT du contact attendrait la fin du bail pour rien, sur un parcours parfaitement
    // sain. C'est la raison du `finally`.
    const runs = new RunsConditionnels();
    const { ex } = exec(runs, { sendQuickMessage: async () => { throw new Error('Meta indisponible'); } });
    await expect(ex.advance('t1', '33600', 'msg1')).rejects.toThrow('Meta indisponible');
    expect(runs.liberations).toHaveLength(1);
    // Et le tour est réellement libre : une avance suivante l'obtient.
    expect(await runs.reserverAvance('t1', 'r1', 'a')).not.toBeNull();
  });

  it('🔴 une avance qui JETTE emporte son contexte : parcours, run et canal (constat B1)', async () => {
    // Le journal des échecs (migration 0108) porte trois colonnes de contexte que personne ne remplissait :
    // le point de journalisation est un handler de webhook, il ne connaît que le numéro et le message. Le
    // parcours n'est connu QU'ICI. Sans ce relais, la jointure qui cherche le nom du scénario ne rendait
    // jamais rien, et l'exploitant lisait « ce contact est bloqué » sans savoir dans quel parcours.
    const runs = new RunsConditionnels();
    const { ex } = exec(runs, { sendQuickMessage: async () => { throw new Error('Meta indisponible'); } });
    const err = await ex.advance('t1', '33600', 'msg1').then(() => null, (e: unknown) => e);
    // La MÊME erreur remonte, avec son message : on annote, on ne remplace pas.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Meta indisponible');
    expect((err as { contexteAvance?: unknown }).contexteAvance)
      .toEqual({ workflowId: 'wf1', runId: 'r1', canal: 'whatsapp' });
  });

  it('🔴 le jeton du tour est PASSÉ à la garde d’écriture', async () => {
    // Le câblage que la garde SQL attend. Sans lui, la clôture par jeton existerait en base et ne servirait
    // à rien, l'appelant ne la renseignant jamais.
    const runs = new RunsConditionnels();
    const { ex } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.jetonsEcriture).toEqual(['jeton-0']);
  });

  it('un store SANS réservation garde le comportement d’avant (fixtures, e2e)', async () => {
    // La dépendance est optionnelle : une instance qui ne la câble pas ne doit pas cesser d'avancer.
    const runs = new RunsConditionnels();
    // Les méthodes vivent sur le PROTOTYPE : on les masque sur l'instance plutôt que de recopier l'objet,
    // ce qui perdrait toutes les autres (`findWaitingByWaId` la première).
    const nu = runs as unknown as Record<string, unknown>;
    nu.reserverAvance = undefined;
    nu.libererAvance = undefined;
    const { ex, calls } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(calls).toEqual(['qm:B']);
  });
});


/**
 * 🔴 LA COURSE LONGUE : LE PORTEUR LENT (lot 1 du plan post-audit, 2026-09-02).
 *
 * La réservation ci-dessus ferme la course COURTE, deux avances qui démarrent ensemble. Elle ne fermait pas
 * celle-ci : `withRetry` autorise cinq tentatives à 30 s de plafond plus le backoff, soit ~154 s au pire pour
 * UN SEUL envoi Meta, et une avance peut en enchaîner plusieurs. Le bail de 60 s expirait donc pendant que le
 * premier porteur travaillait ENCORE, un second prenait le tour, et les deux envoyaient.
 *
 * Aucune valeur de bail ne pouvait fermer ça : le nombre d'envois d'une avance n'est pas borné. Il fallait un
 * signe de vie périodique, qui seul distingue un porteur MORT d'un porteur LENT.
 */
describe('avance concurrente : le bail est RENOUVELÉ tant qu’on travaille', () => {
  afterEach(() => { vi.useRealTimers(); });

  /**
   * Un exécuteur dont le PREMIER envoi reste suspendu, et de quoi le débloquer. Seul le premier : celui qui
   * vole le tour est une avance neuve et rapide, et la suspendre aussi ne ferait que bloquer le test.
   */
  function avanceLente(runs: RunsConditionnels) {
    const calls: string[] = [];
    let debloquer: () => void = () => {};
    const envoiSuspendu = new Promise<void>((r) => { debloquer = r; });
    let premier = true;
    const { ex } = exec(runs, {
      sendQuickMessage: async (_t, _w, body) => {
        calls.push(`qm:${body}`);
        if (premier) { premier = false; await envoiSuspendu; }
      },
    });
    return { ex, calls, debloquer: () => debloquer() };
  }

  it('🔴 une avance PLUS LONGUE que le bail ne se fait pas voler son tour', async () => {
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    const { ex, calls, debloquer } = avanceLente(runs);

    const lente = ex.advance('t1', '33600', 'msg1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['qm:B']); // l'envoi est parti et l'avance est suspendue dedans

    // 80 secondes s'écoulent : bien au-delà du bail de 60 s. Le battement doit l'avoir repoussé.
    for (let i = 0; i < 4; i += 1) {
      runs.maintenant += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
    }

    // Un second traitement du même contact tente sa chance pendant que le premier travaille toujours.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await ex.advance('t1', '33600', 'msg2');
    } finally {
      spy.mockRestore();
    }

    // LE POINT DU LOT : rien de plus n'est parti. Sans renouvellement, le contact recevait `qm:B` deux fois.
    expect(calls).toEqual(['qm:B']);
    expect(runs.reservations.filter((r) => r !== null)).toHaveLength(1);

    debloquer();
    await lente;
  });

  it('🔴 SANS renouvellement, le tour est volé et le contact reçoit DEUX fois le message', async () => {
    // Le même scénario, la garde en moins : c'est la preuve dans l'autre sens. Si ce test cessait d'échouer
    // à produire un double envoi, c'est que la première assertion ne prouverait plus rien.
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    (runs as unknown as { prolongerAvance?: unknown }).prolongerAvance = undefined;
    const { ex, calls, debloquer } = avanceLente(runs);

    const lente = ex.advance('t1', '33600', 'msg1');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i += 1) {
      runs.maintenant += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
    }

    // Le spy tient jusqu'au bout : l'avance lente, en revenant, se fera refuser son écriture d'état par le
    // jeton et le journalisera. C'est attendu, ça n'a pas à salir la sortie des tests.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await ex.advance('t1', '33600', 'msg2');
      expect(calls).toEqual(['qm:B', 'qm:B']); // le double envoi, exactement le défaut que le lot ferme
      debloquer();
      await lente;
    } finally {
      spy.mockRestore();
    }
  });

  it('le battement s’ARRÊTE avec l’avance, même quand un envoi jette', async () => {
    // Un battement qui survit à son avance tiendrait un tour que plus personne ne travaille, donc gèlerait
    // le contact jusqu'à l'expiration du bail. C'est la raison du `finally`.
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    let prolongations = 0;
    const vrai = runs.prolongerAvance.bind(runs);
    runs.prolongerAvance = async (id, token, s) => { prolongations += 1; return vrai(id, token, s); };
    const { ex } = exec(runs, { sendQuickMessage: async () => { throw new Error('Meta indisponible'); } });
    await expect(ex.advance('t1', '33600', 'msg1')).rejects.toThrow('Meta indisponible');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(prolongations).toBe(0);
  });
});

/**
 * 🔴 LES EFFETS S'ARRÊTENT QUAND LE TOUR EST PERDU (lot A2 du plan du 2026-09-02).
 *
 * Ce que le lot 1 avait laissé ouvert, et l'audit externe l'a vu : le battement RENDAIT VISIBLE la perte du
 * tour (un `console.warn`) sans rien arrêter. Le jeton clôture l'écriture d'ÉTAT, il n'a jamais rien pu contre
 * un message déjà remis à Meta. Un porteur déchu finissait donc sa liste d'envois pendant que le nouveau
 * porteur faisait la sienne, et le contact recevait les deux.
 *
 * La garde se pose donc entre CHAQUE effet, pas une fois à l'entrée : une liste d'envois peut durer plusieurs
 * minutes, et ce qui est vrai au premier envoi ne dit rien du dixième.
 */
describe('avance concurrente : les effets CESSENT dès que le tour est perdu', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** b -> c -> d : trois messages rapides d'affilée, donc trois effets dans UNE seule avance. */
  const grapheLong: WorkflowGraph = {
    nodes: [
      n('a', 'quick_message', { body: 'A' }),
      n('b', 'quick_message', { body: 'B' }),
      n('c', 'quick_message', { body: 'C' }),
      n('d', 'quick_message', { body: 'D' }),
    ],
    edges: [e('e1', 'a', 'b'), e('e2', 'b', 'c'), e('e3', 'c', 'd')],
  };

  /** Un exécuteur sur le graphe long, dont le PREMIER envoi reste suspendu jusqu'à `debloquer()`. */
  function avanceLongueEtLente(runs: RunsConditionnels) {
    const calls: string[] = [];
    let debloquer: () => void = () => {};
    const suspendu = new Promise<void>((r) => { debloquer = r; });
    let premier = true;
    const { ex } = exec(runs, {
      getGraph: async () => grapheLong,
      sendQuickMessage: async (_t, _w, body) => {
        calls.push(`qm:${body}`);
        if (premier) { premier = false; await suspendu; }
      },
    });
    return { ex, calls, debloquer: () => debloquer() };
  }

  it('témoin : sans perte de tour, les TROIS messages partent', async () => {
    // Le contrôle positif. Sans lui, un test qui n'observe qu'un seul message ne prouverait rien : il
    // passerait aussi si le graphe n'en produisait qu'un.
    const runs = new RunsConditionnels();
    const { ex, calls, debloquer } = avanceLongueEtLente(runs);
    const p = ex.advance('t1', '33600', 'msg1');
    debloquer();
    await p;
    expect(calls).toEqual(['qm:B', 'qm:C', 'qm:D']);
  });

  it('🔴 tour volé PENDANT le premier envoi : les deux suivants NE PARTENT PAS', async () => {
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    const { ex, calls, debloquer } = avanceLongueEtLente(runs);

    const lente = ex.advance('t1', '33600', 'msg1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['qm:B']); // le premier est parti, l'avance est suspendue dedans

    // Un autre traitement prend le tour, et un battement le CONSTATE.
    runs.volerLeTour();
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { avertissements.push(String(m)); });
    try {
      runs.maintenant += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);

      debloquer();
      await lente;
    } finally {
      spy.mockRestore();
    }

    // LE POINT DU LOT : le premier envoi était déjà en vol, on ne peut pas le rappeler ; les DEUX SUIVANTS
    // n'ont aucune raison de partir, et ne partent pas.
    expect(calls).toEqual(['qm:B']);
    // Et on le DIT, avec la raison : un arrêt silencieux serait indistinguable d'un parcours qui s'est
    // terminé normalement.
    expect(avertissements.some((a) => a.includes('effets INTERROMPUS'))).toBe(true);
    // L'état n'est pas écrit non plus : la clôture par jeton refuse le porteur déchu.
    expect(runs.run).toMatchObject({ currentNode: 'a' });
  });

  it('🔴 le tour perdu se voit AUSSI comme un refus, pas seulement dans les logs', async () => {
    // L'appelant doit pouvoir distinguer « tout est parti » de « on s'est arrêté en route ». Sans ce signal,
    // `advance` ne saurait pas qu'il n'a pas fini son travail.
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    const { ex, calls, debloquer } = avanceLongueEtLente(runs);
    const lente = ex.advance('t1', '33600', 'msg1');
    await vi.advanceTimersByTimeAsync(0);
    runs.volerLeTour();
    const erreurs: string[] = [];
    const spyW = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyE = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { erreurs.push(String(m)); });
    try {
      runs.maintenant += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
      debloquer();
      await lente;
    } finally {
      spyW.mockRestore();
      spyE.mockRestore();
    }
    expect(calls).toEqual(['qm:B']);
    expect(erreurs.some((m) => m.includes('envoi refusé') && m.includes('tour perdu'))).toBe(true);
  });
});

/**
 * 🔴 LE CHEMIN RCS A SON PROPRE ENVOI, DONC SA PROPRE GARDE.
 *
 * `walkResolved` n'est pas qu'un calcul de parcours : il ENVOIE le RCS en ligne, avant que `apply` ne voie
 * quoi que ce soit. Une garde posée uniquement dans `apply` aurait donc laissé passer exactement le message
 * qui part le premier. Le point de suspension du test est la recherche de l'agent RCS, qui est une requête
 * réelle placée juste avant l'envoi.
 */
describe('avance concurrente : le chemin RCS est gardé lui aussi', () => {
  afterEach(() => { vi.useRealTimers(); });

  const grapheRcs: WorkflowGraph = {
    nodes: [n('a', 'quick_message', { body: 'A' }), n('r', 'rcs_message', { text: 'Bonjour en RCS' })],
    edges: [e('e1', 'a', 'r')],
  };

  function avanceRcsLente(runs: RunsConditionnels) {
    const envois: string[] = [];
    let debloquer: () => void = () => {};
    const suspendu = new Promise<void>((r) => { debloquer = r; });
    const { ex } = exec(runs, {
      getGraph: async () => grapheRcs,
      rcs: {
        // La recherche de l'agent est une requête comme une autre : elle peut être lente, et c'est pendant
        // ce temps-là qu'un autre traitement prend le tour.
        agentIdFor: async () => { await suspendu; return 'agent-1'; },
        sender: {
          sendTo: async () => { envois.push('rcs'); return { messageId: 'm-rcs' }; },
        },
      } as unknown as WorkflowExecutorDeps['rcs'],
    });
    return { ex, envois, debloquer: () => debloquer() };
  }

  it('témoin : sans perte de tour, le message RCS part', async () => {
    const runs = new RunsConditionnels();
    const { ex, envois, debloquer } = avanceRcsLente(runs);
    const p = ex.advance('t1', '33600', 'msg1');
    debloquer();
    await p;
    expect(envois).toEqual(['rcs']);
  });

  it('🔴 tour volé avant l’envoi RCS : le message NE PART PAS', async () => {
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    const { ex, envois, debloquer } = avanceRcsLente(runs);
    const lente = ex.advance('t1', '33600', 'msg1');
    await vi.advanceTimersByTimeAsync(0);
    expect(envois).toEqual([]); // suspendu dans la recherche d'agent

    runs.volerLeTour();
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { avertissements.push(String(m)); });
    try {
      runs.maintenant += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
      debloquer();
      await lente;
    } finally {
      spy.mockRestore();
    }
    expect(envois).toEqual([]);
    expect(avertissements.some((a) => a.includes('envoi INTERROMPU'))).toBe(true);
  });

  /**
   * 🔴 LA MÊME PERTE, MAIS APRÈS LA GARDE : le contre-audit du 2026-09-03 avait raison sur ce point.
   *
   * Le contrôle initial était posé avant la résolution des variables et la fabrication du jeton, c'est-à-dire
   * avant DEUX requêtes en base. Un bail de quelques secondes peut expirer pendant ces deux attentes, et le
   * message partait quand même : la garde était juste avant le TRAVAIL, pas juste avant l'EFFET.
   *
   * La règle, une nuance de plus que celle du lot A2 : « entre les effets » veut dire immédiatement avant
   * l'effet. Tout ce qui s'attend entre le contrôle et l'envoi rouvre la fenêtre qu'on croyait fermée.
   */
  it('🔴 tour volé APRÈS la garde, pendant la résolution des variables : le message NE PART PAS non plus', async () => {
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    const envois: string[] = [];
    let debloquer: () => void = () => {};
    const suspendu = new Promise<void>((r) => { debloquer = r; });
    const { ex } = exec(runs, {
      getGraph: async () => ({
        nodes: [n('a', 'quick_message', { body: 'A' }), n('r', 'rcs_message', { text: 'Bonjour {{prenom}}' })],
        edges: [e('e1', 'a', 'r')],
      }),
      rcs: {
        agentIdFor: async () => 'agent-1',
        // La fiche du contact se lit APRÈS le contrôle de garde : c'est cette attente-là qui rouvrait la
        // fenêtre. Elle est aussi ordinaire que la précédente, une requête en base parmi d'autres.
        varsFor: async () => { await suspendu; return { prenom: 'Léa' }; },
        sender: {
          sendTo: async () => { envois.push('rcs'); return { messageId: 'm-rcs' }; },
        },
      } as unknown as WorkflowExecutorDeps['rcs'],
    });
    const lente = ex.advance('t1', '33600', 'msg1');
    await vi.advanceTimersByTimeAsync(0);
    expect(envois, 'suspendu dans la lecture de la fiche, donc APRÈS la garde d’entrée').toEqual([]);

    runs.volerLeTour();
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { avertissements.push(String(m)); });
    try {
      runs.maintenant += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
      debloquer();
      await lente;
    } finally {
      spy.mockRestore();
    }
    expect(envois, 'le porteur déchu ne doit rien remettre à l’opérateur RCS').toEqual([]);
    expect(avertissements.some((a) => a.includes('envoi INTERROMPU'))).toBe(true);
  });
});

/**
 * 🔴 ENFILER UN TOUR D'AGENT EST UN EFFET, ET UN EFFET FACTURÉ.
 *
 * Ce chemin ne passe ni par `apply` ni par `walkResolved` : il sort de `advance` directement. Sans garde
 * propre, un porteur déchu commandait un appel modèle sur le message que le nouveau porteur venait de
 * commander lui aussi : deux tours, deux factures, et deux réponses au même message du contact.
 */
describe('avance concurrente : le tour d’agent n’est pas enfilé par un porteur déchu', () => {
  afterEach(() => { vi.useRealTimers(); });

  const grapheAgent: WorkflowGraph = { nodes: [n('a', 'agent', { agentPrompt: 'aide' })], edges: [] };

  function avanceAgentLente(runs: RunsConditionnels) {
    const enfiles: string[] = [];
    let debloquer: () => void = () => {};
    const suspendu = new Promise<void>((r) => { debloquer = r; });
    const { ex } = exec(runs, {
      getGraph: async () => grapheAgent,
      // La lecture de la session est une requête réelle, placée juste avant l'enfilement.
      agentSessions: {
        byRun: async () => { await suspendu; return { id: 's1', status: 'en_cours', tours: 0 }; },
      } as unknown as WorkflowExecutorDeps['agentSessions'],
      enqueueAgentTurn: async (job) => { enfiles.push(job.sessionId); },
    });
    return { ex, enfiles, debloquer: () => debloquer() };
  }

  it('témoin : sans perte de tour, le tour d’agent est enfilé', async () => {
    const runs = new RunsConditionnels();
    const { ex, enfiles, debloquer } = avanceAgentLente(runs);
    const p = ex.advance('t1', '33600', 'msg1');
    debloquer();
    await p;
    expect(enfiles).toEqual(['s1']);
  });

  it('🔴 tour volé pendant la lecture de session : AUCUN tour d’agent n’est enfilé', async () => {
    vi.useFakeTimers();
    const runs = new RunsConditionnels();
    const { ex, enfiles, debloquer } = avanceAgentLente(runs);
    const lente = ex.advance('t1', '33600', 'msg1');
    await vi.advanceTimersByTimeAsync(0);
    expect(enfiles).toEqual([]);

    runs.volerLeTour();
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { avertissements.push(String(m)); });
    try {
      runs.maintenant += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
      debloquer();
      await lente;
    } finally {
      spy.mockRestore();
    }
    expect(enfiles).toEqual([]);
    expect(avertissements.some((a) => a.includes("tour d'agent NON enfilé"))).toBe(true);
    // Et le message n'est pas marqué consommé : c'est au porteur légitime de le faire.
    expect(runs.run).toMatchObject({ lastMessageId: null });
  });
});
