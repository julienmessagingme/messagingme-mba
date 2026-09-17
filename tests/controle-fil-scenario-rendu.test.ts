import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runControlSweep } from '../src/inbox/control-sweep';
import type { ControlSweepDeps } from '../src/inbox/control-sweep';
import type { ControlOwner } from '../src/inbox/store.pg';

/**
 * L'AGENT DE META REPREND LA MAIN, MÊME SUR UN FIL PRIS PAR UN SCÉNARIO.
 *
 * 🔴 CE FICHIER EST LA SOUPAPE DU GESTE `take`, ET IL EST NÉ DE LA QUESTION DE JULIEN (2026-09-14) : « le
 * MBA reprend quoi qu'il arrive la main après un délai (120 min par défaut), il faut que ça continue de
 * marcher ». La réponse était NON pour un fil de scénario, et c'est une régression que le correctif du jour
 * venait d'introduire.
 *
 * Pourquoi elle n'existait pas avant : `reclaimControl` n'écrivait que NOTRE colonne. Meta gardait le fil,
 * donc son agent reprenait la main tout seul, sans que personne ait rien à rendre. C'était précisément le
 * bug (l'agent de Meta répondait à la place du scénario). Depuis qu'on prend le fil POUR DE VRAI, un
 * parcours abandonné le garderait à jamais.
 *
 * ⚠️ LA FIN NORMALE D'UN PARCOURS REND DÉJÀ LE FIL (`releaseToMba`, câblé dans `wiring.ts`). Ce délai ne
 * couvre QUE les parcours qui ne finissent pas : le contact ne répond jamais, le run reste `waiting`.
 */

const HEURE = 60 * 60 * 1000;
const MAINTENANT = new Date('2026-09-14T12:00:00Z').getTime();

/**
 * ⚠️ `lastMessageAt` PAR DÉFAUT À UNE HEURE, donc une fenêtre de Meta OUVERTE (2026-09-15). Sans valeur, ces
 * cas décriraient tous une conversation muette depuis toujours, que le balayage saute désormais : ils
 * passeraient pour la mauvaise raison, en prouvant l'inverse de ce qu'ils annoncent. Le cas de la fenêtre
 * FERMÉE a son propre test, où la valeur est explicite.
 */
function deps(
  held: Array<{ owner: ControlOwner; changedAt: Date | null; lastMessageAt?: Date | null }>,
  over: Partial<ControlSweepDeps> = {},
): ControlSweepDeps & { ecrits: Array<{ owner: ControlOwner }>; rendus: string[]; vu: { age?: number } } {
  const ecrits: Array<{ owner: ControlOwner }> = [];
  const rendus: string[] = [];
  // ⚠️ UN OBJET MUTABLE, PAS UN GETTER : `Object.assign` plus bas INVOQUE un getter au lieu de le copier,
  // donc la valeur serait figée à `undefined` au moment du montage. Vu en écrivant ce test.
  const vu: { age?: number } = {};
  const d = {
    listHeldControl: async (_limit?: number, ageScenarioMs?: number) => {
      vu.age = ageScenarioMs;
      return held.map((h, i) => ({ tenantId: 't1', waId: `3360000000${i}`, owner: h.owner, changedAt: h.changedAt, lastMessageAt: h.lastMessageAt === undefined ? new Date(MAINTENANT - 1 * HEURE) : h.lastMessageAt }));
    },
    setControlOwner: async (_t: string, _w: string, owner: ControlOwner, opts?: { only?: readonly ControlOwner[] }) => {
      // Reproduit la garde du SQL : une écriture qui ne change rien ne prend pas.
      if (opts?.only && !opts.only.includes(owner) && owner === 'app_workflow' && opts.only[0] === 'app_workflow') return false;
      if (opts?.only?.[0] === owner) return false;
      ecrits.push({ owner });
      return true;
    },
    timeouts: { app_human: 2 * HEURE, mba: 24 * HEURE, app_workflow: 24 * HEURE },
    mbaActifParTenant: async () => new Set(['t1']),
    releaseToMba: async (_t: string, waId: string) => { rendus.push(waId); return true; },
    now: () => MAINTENANT,
    ...over,
  };
  return Object.assign(d, { ecrits, rendus, vu }) as never;
}

describe('un fil pris par un SCÉNARIO revient à l’agent de Meta', () => {
  it('🔴 au-delà du délai, il est rendu ET relâché chez Meta', async () => {
    const d = deps([{ owner: 'app_workflow', changedAt: new Date(MAINTENANT - 25 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(1);
    expect(d.ecrits).toEqual([{ owner: 'mba' }]);
    // 🔴 Le relâchement CHEZ META n'est pas un détail : sans lui, notre base dirait « mba » pendant que Meta
    // continuerait de nous croire maîtres du fil, et son agent resterait muet pour toujours.
    expect(d.rendus).toHaveLength(1);
  });

  it('🔴 RIEN À RENDRE ne fait PAS sortir la conversation du dossier « À traiter »', async () => {
    /**
     * 🔴 CE TEST GARDE UN ARBITRAGE QUI A ÉTÉ ROUVERT PUIS REFERMÉ LE MÊME JOUR. Une premiere correction
     * repliait ce cas sur `app_workflow` pour que la conversation cesse d etre candidate a chaque passe.
     * Or `app_workflow` est la SEULE valeur que le dossier « À traiter » exclut (`A_TRAITER_SQL`) : sur un
     * espace `mba_enabled` SANS numero connecte, un client qui vient d ecrire disparaissait du dossier de
     * travail. C est le symptome exact que la migration 0149 a repare, et le commentaire du bloc voisin
     * l interdit nommement depuis le 2026-09-15.
     *
     * ⚠️ LE COUT ASSUME EST UN REEXAMEN, PAS UNE FUITE : la conversation reste candidate a la passe
     * suivante et coute une lecture. Entre les deux erreurs possibles, une seule se rattrape.
     */
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 3 * HEURE) }], {
      releaseToMba: async () => false,
    });
    expect(await runControlSweep(d)).toBe(0);
    expect(d.ecrits, 'rien n est ecrit : la conversation reste visible dans « À traiter »').toEqual([]);
  });

  it('⚠️ un REFUS de Meta ne s ecrit pas non plus : la, il y avait bien quelque chose a rendre', async () => {
    // La distinction compte pour la SUITE : `rendreLeFil` LEVE sur un refus de Meta et ne rend `false` que
    // sur une absence de numero. Ecrire `mba` sur un refus ferait croire que Meta tient un fil qu il a
    // refuse de prendre, ce qui est le defaut de fond que ce balayage existe pour eviter.
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 3 * HEURE) }], {
      releaseToMba: async () => { throw new Error('Meta a refusé'); },
    });
    expect(await runControlSweep(d)).toBe(0);
    expect(d.ecrits, 'rien n est ecrit : on reessaiera').toEqual([]);
  });

  it('avant le délai, on ne touche à rien', async () => {
    const d = deps([{ owner: 'app_workflow', changedAt: new Date(MAINTENANT - 3 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(0);
    expect(d.ecrits).toEqual([]);
  });

  it('🔴 LE DÉLAI HUMAIN N’A PAS BOUGÉ : 2 h, et il passe toujours à l’agent de Meta', async () => {
    // C'est la question exacte de Julien : « il faut que ça continue de marcher ».
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 3 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(1);
    expect(d.ecrits).toEqual([{ owner: 'mba' }]);
    expect(d.rendus).toHaveLength(1);
  });

  it('un humain dans sa fenêtre de 2 h garde la main', async () => {
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 1 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(0);
  });

  it('sans agent de Meta chez ce client, un fil de scénario n’est pas touché', async () => {
    // La destination vaudrait `app_workflow`, c'est-à-dire la valeur déjà portée : l'écriture ne prend pas.
    const d = deps([{ owner: 'app_workflow', changedAt: new Date(MAINTENANT - 25 * HEURE) }],
      { mbaActifParTenant: async () => new Set<string>() });
    expect(await runControlSweep(d)).toBe(0);
    expect(d.ecrits).toEqual([]);
  });

  it('🔴 le délai de scénario voyage jusqu’au SQL, pour ne pas saturer le lot', async () => {
    // ⚠️ `app_workflow` est l'état NORMAL de toute conversation. Les ramener toutes remplirait le lot de 500
    // avec des fils sains, et les `app_human` à rendre, plus anciens, ne seraient jamais atteints : le
    // balayage humain cesserait de fonctionner SANS rien signaler.
    const d = deps([]);
    await runControlSweep(d);
    expect(d.vu.age).toBe(24 * HEURE);
  });
});

describe('la requête qui alimente le balayage ramène bien ces fils', () => {
  const sql = readFileSync(resolve(__dirname, '../src/inbox/store.pg.ts'), 'utf8');
  /** La REQUÊTE seule, sans le commentaire qui la précède : un test qui lirait une phrase ne prouverait rien. */
  const bloc = (() => {
    const i = sql.indexOf('select tenant_id, wa_id, control_owner, control_changed_at');
    return sql.slice(i, i + 800);
  })();

  it('🔴 n’exclut plus inconditionnellement les fils de scénario', () => {
    // La requête disait `where control_owner <> 'app_workflow'` tout court : le balayage ne VOYAIT pas ces
    // conversations, donc corriger le balayage seul n'aurait rien changé.
    expect(bloc).toContain('make_interval');
  });

  it('🔴 ramène AUSSI les conversations qui n’ont jamais basculé, et c’est l’inverse d’avant', () => {
    /**
     * 🔴 CE TEST REMPLACE SON CONTRAIRE, ET LA JUSTIFICATION D'AVANT ÉTAIT FAUSSE. Il affirmait « écarte
     * toujours les conversations qui n'ont JAMAIS basculé », au motif que « `control_changed_at is null` =
     * personne n'a jamais pris ce fil, il n'y a rien à rendre ».
     *
     * L'équivalence ne tient pas : `app_workflow` est la valeur PAR DÉFAUT de la colonne, et envoyer un
     * message PREND le fil chez Meta implicitement. Une conversation née d'un envoi sortant porte donc
     * `app_workflow` + `null` alors que nous tenons le fil pour de vrai. Mesuré sur `33634264992` le
     * 2026-09-15 : ni dans « À traiter » (ce dossier exclut `app_workflow`), ni chez l'agent de Meta.
     */
    /**
     * 🔴 ET LE PREMIER CORRECTIF ÉTAIT MORT, RELEVÉ EN REVUE LE JOUR MÊME. Il écrivait
     * `coalesce(control_changed_at, last_message_at) < now() - âge` À CÔTÉ de la borne de fenêtre : pour une
     * conversation jamais basculée, le `coalesce` retombe sur `last_message_at`, et les deux conditions
     * exigeaient alors ce message à la fois PLUS VIEUX et PLUS RÉCENT que 24 h. Contradictoire, donc jamais
     * vrai. Une conversation qui n'a jamais basculé n'a pas d'âge de contrôle : elle est éligible dès que sa
     * fenêtre est ouverte. C'est pour ça que le test lit `control_changed_at is null or`, et non un
     * `coalesce` qui passerait tout en ayant l'air correct.
     */
    expect(bloc, 'une conversation jamais basculée doit être éligible, pas comparée à un âge').toContain('control_changed_at is null');
    expect(bloc, 'et surtout pas via un coalesce, qui rend la branche morte').not.toContain('coalesce(control_changed_at');
    expect(bloc, 'l’exclusion d’avant ne doit plus être là').not.toContain('control_changed_at is not null');
  });

  it('🔴 et elle BORNE ce qu’elle ramène à la fenêtre de Meta, sinon le lot sature', () => {
    /**
     * ⚠️ LE GARDE-FOU DE VOLUME DU COMMENTAIRE D'ORIGINE RESTE VRAI. Sans cette borne, le `coalesce` ferait
     * entrer TOUTES les vieilles conversations en `app_workflow`, c'est-à-dire l'état normal de tout le
     * monde : le lot de 500 serait saturé de fils sains et les fils humains à rendre, plus anciens, ne
     * seraient jamais atteints. La régression serait totalement invisible.
     */
    expect(bloc).toContain("last_message_at > now() - interval '24 hours'");
  });
});

describe('la fenêtre de Meta, ajoutée le 2026-09-15', () => {
  it('🔴 fenêtre FERMÉE : aucun appel Meta, aucune écriture, la conversation reste visible', async () => {
    /**
     * 🔴 L'INCIDENT DU 2026-09-15, REJOUÉ. Ce balayage a rendu dix conversations d'un coup, toutes muettes
     * depuis 166 à 281 heures. L'agent de Meta ne peut prendre un fil que s'il existe une session ouverte :
     * il n'y avait rien à transmettre, notre colonne disait `mba`, Meta pensait l'inverse, et le message
     * suivant de l'une d'elles est arrivé chez NOUS sans que personne ne réponde au client.
     *
     * ⚠️ ON SAUTE, ON NE REPLIE PAS SUR `app_workflow` : c'est la seule valeur que « À traiter » exclut, donc
     * y basculer un `app_human` abandonné le rendrait invisible. Un défaut pire que celui qu'on répare.
     */
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 3 * HEURE), lastMessageAt: new Date(MAINTENANT - 200 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(0);
    expect(d.rendus, 'aucun appel Meta sur une fenêtre fermée').toEqual([]);
    expect(d.ecrits, 'la conversation reste telle quelle, donc visible').toEqual([]);
  });

  it('⚠️ une conversation SANS aucun message n’est pas passée non plus', async () => {
    // `lastMessageAt` null = rien n'a jamais circulé, donc aucune fenêtre n'a jamais été ouverte.
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 3 * HEURE), lastMessageAt: null }]);
    expect(await runControlSweep(d)).toBe(0);
    expect(d.rendus).toEqual([]);
  });

  it('🔴 sans agent de Meta, la fenêtre ne change RIEN : ce chemin ne parle pas à Meta', async () => {
    /**
     * La garde ne doit mordre que sur les clients qui ont l'agent de Meta. Pour les autres, la destination
     * est le scénario, aucun appel Meta n'a lieu, et une fenêtre fermée n'est pas une raison de ne rien
     * faire. L'appliquer à tout le monde aurait gelé le balayage historique sans que rien ne le signale.
     */
    const d = deps([{ owner: 'app_human', changedAt: new Date(MAINTENANT - 3 * HEURE), lastMessageAt: new Date(MAINTENANT - 200 * HEURE) }],
      { mbaActifParTenant: async () => new Set<string>() });
    expect(await runControlSweep(d)).toBe(1);
    expect(d.ecrits).toEqual([{ owner: 'app_workflow' }]);
  });
});

describe('la garde de fenêtre ne mord QUE là où un appel Meta allait partir', () => {
  it('🔴 un fil déjà détenu par l’agent revient au scénario même hors fenêtre', async () => {
    /**
     * 🔴 TROUVÉ EN REVUE LE 2026-09-15. Une première version de la garde sautait dès que le CLIENT avait
     * l'agent allumé, sans regarder ce qu'on s'apprêtait à faire. Elle bloquait donc aussi cette
     * transition-ci, qui n'émet AUCUN appel Meta : un fil que l'agent détient depuis plus de 24 h revient au
     * scénario, et une fenêtre fermée n'a rien à y voir. Le garde-fou technique des 24 h `mba` aurait cessé
     * de fonctionner en silence.
     */
    const d = deps([{ owner: 'mba', changedAt: new Date(MAINTENANT - 25 * HEURE), lastMessageAt: new Date(MAINTENANT - 200 * HEURE) }]);
    expect(await runControlSweep(d)).toBe(1);
    expect(d.ecrits).toEqual([{ owner: 'app_workflow' }]);
    expect(d.rendus, 'aucun appel Meta sur ce chemin').toEqual([]);
  });
});
