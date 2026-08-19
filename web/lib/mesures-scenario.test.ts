import { describe, it, expect } from 'vitest';
import { blocsDuScenario, mesuresDisponibles, libelleHandle, valeurDe, handlesMesuresParBloc, estMesurable } from './mesures-scenario';
import type { Graph, CompteurBrut } from './mesures-scenario';

/**
 * Les règles qui décident ce qu'un tableau a le droit de proposer et d'afficher. Pures, donc testées ici
 * plutôt que derrière un navigateur : c'est là que se joue l'honnêteté des chiffres.
 */
const n = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data });

describe('quels blocs sont mesurables', () => {
  it('🔴 seuls les blocs qui ENVOIENT un message le sont', () => {
    // Proposer un tag ou une condition ferait miroiter des compteurs qui resteraient à zéro pour toujours.
    for (const t of ['template', 'quick_message', 'flow', 'rcs_message']) expect(estMesurable(t)).toBe(true);
    for (const t of ['tag', 'field', 'action', 'condition', 'wait', 'inbox', 'email']) expect(estMesurable(t)).toBe(false);
  });
});

describe('ordre des blocs', () => {
  const g: Graph = {
    nodes: [n('c', 'tag', { tag: 'vu' }), n('a', 'template', { templateName: 'promo' }), n('b', 'quick_message', { body: 'Ça te va ?' })],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
  };

  it('🔴 l’ordre est celui du PARCOURS, pas celui du tableau de nodes', () => {
    // Un tableau se lit en entonnoir : le bloc d'entrée, puis ce qu'il atteint. L'ordre de stockage du graphe
    // n'a aucun rapport avec l'ordre dans lequel un contact traverse le scénario.
    expect(blocsDuScenario(g).map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('🔴 un bloc INATTEIGNABLE est mis à la fin, jamais masqué', () => {
    // Une branche débranchée en cours de construction peut très bien avoir déjà tourné : la masquer donnerait
    // l'impression que ses mesures n'existent pas.
    const orphelin: Graph = { nodes: [...g.nodes, n('z', 'template', { templateName: 'ancien' })], edges: g.edges };
    expect(blocsDuScenario(orphelin).map((b) => b.id)).toEqual(['a', 'b', 'c', 'z']);
  });

  it('un cycle ne fait pas boucler', () => {
    const boucle: Graph = { nodes: [n('a', 'quick_message'), n('b', 'quick_message')], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] };
    expect(blocsDuScenario(boucle).map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('les blocs non-messages sont marqués comme tels (l’écran les grise)', () => {
    expect(blocsDuScenario(g).map((b) => b.mesurable)).toEqual([true, true, false]);
  });
});

describe('les choix proposés à la mesure', () => {
  it('🔴 les sorties TECHNIQUES ne sont pas des choix du contact', () => {
    // `true`/`false` d'une condition, `sent`/`unreachable` d'un envoi RCS décrivent une issue technique.
    // Les compter comme des clics ferait apparaître des « boutons » que personne n'a jamais vus.
    const g: Graph = {
      nodes: [n('r', 'rcs_message')],
      edges: [{ source: 'r', target: 'x', sourceHandle: 'sent' }, { source: 'r', target: 'y', sourceHandle: 'unreachable' }],
    };
    expect(blocsDuScenario(g)[0]!.choix).toEqual([]);
  });

  it('un bouton déclaré est nommé par son TEXTE, pas par son index', () => {
    const g: Graph = { nodes: [n('a', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }, { text: 'Non' }] })], edges: [] };
    expect(blocsDuScenario(g)[0]!.choix).toEqual([
      { handle: 'btn:0', label: '« Oui »' },
      { handle: 'btn:1', label: '« Non »' },
    ]);
  });

  it('🔴 un choix de CAROUSEL apparaît dès qu’il est mesuré, même s’il n’est pas dans le graphe', () => {
    // Le graphe ne déclare pas les cartes d'un carousel : elles vivent dans le template chez Meta. Sans cette
    // révélation par les données, les choix d'un carousel seraient invisibles dans les tableaux.
    const g: Graph = { nodes: [n('a', 'template', { templateName: 'promo_carousel' })], edges: [] };
    const b = blocsDuScenario(g, { a: ['card:1:btn:0'] })[0]!;
    expect(b.choix).toEqual([{ handle: 'card:1:btn:0', label: 'Carte 2, bouton 1' }]);
  });

  it('libelleHandle : lisible pour un opérateur, jamais le handle brut quand on peut mieux', () => {
    expect(libelleHandle('btn:0', ['Oui'])).toBe('« Oui »');
    expect(libelleHandle('btn:3', [])).toBe('Bouton 4'); // bouton non déclaré : on ne devine pas de texte
    expect(libelleHandle('card:0:btn:2', [])).toBe('Carte 1, bouton 3');
    expect(libelleHandle('autre_chose', [])).toBe('autre_chose');
  });
});

describe('les mesures proposées sur un bloc', () => {
  const bloc = blocsDuScenario({ nodes: [n('a', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] })], edges: [] })[0]!;

  it('🔴 « a répondu sans cliquer » est proposé MÊME sur un bloc à boutons', () => {
    // Et surtout sur un bloc sans choix, où c'est la seule mesure d'engagement possible.
    expect(mesuresDisponibles(bloc).map((m) => m.kind)).toContain('reply_text');
  });

  it('un choix donne une mesure par bouton', () => {
    const clics = mesuresDisponibles(bloc).filter((m) => m.kind === 'reply_button');
    expect(clics).toEqual([{ cle: 'a|reply_button|btn:0', label: 'A cliqué « Oui »', kind: 'reply_button', handle: 'btn:0' }]);
  });

  it('🔴 « Échecs » et « Délivrés » ne sont proposés QUE sur le premier message', () => {
    // Après le premier template, le message part à quelqu'un qui vient de répondre : l'envoi aboutit et arrive
    // quasiment toujours. Ces deux mesures y afficheraient des barres plates, l'une à zéro et l'autre collée
    // aux « Envoyés », ce qui noierait le signal qu'on est venu chercher.
    const kindsPremier = mesuresDisponibles(bloc, true).map((m) => m.kind);
    expect(kindsPremier).toContain('failed');
    expect(kindsPremier).toContain('delivered');

    const kindsSuivant = mesuresDisponibles(bloc, false).map((m) => m.kind);
    expect(kindsSuivant).not.toContain('failed');
    expect(kindsSuivant).not.toContain('delivered');
    // Ce qui compte vraiment sur un bloc suivant reste proposé.
    expect(kindsSuivant).toEqual(expect.arrayContaining(['sent', 'read', 'reply_button', 'reply_text']));
  });

  it('🔴 un bloc NON mesurable ne propose rien', () => {
    const tag = blocsDuScenario({ nodes: [n('t', 'tag', { tag: 'vu' })], edges: [] })[0]!;
    expect(mesuresDisponibles(tag)).toEqual([]);
  });
});

describe('lecture des compteurs', () => {
  const counts: CompteurBrut[] = [
    { nodeId: 'a', kind: 'sent', handle: null, count: 12, contacts: 12 },
    { nodeId: 'a', kind: 'reply_button', handle: 'btn:0', count: 5, contacts: 4 },
  ];

  it('🔴 une mesure absente vaut ZÉRO, elle ne disparaît pas', () => {
    // Une mesure choisie qui vaut zéro est une information ; la masquer laisserait croire à un oubli de
    // configuration alors que la réponse est « personne ».
    expect(valeurDe(counts, 'a', 'read', null)).toEqual({ count: 0, contacts: 0 });
  });

  it('🔴 clics et personnes sont deux chiffres distincts', () => {
    expect(valeurDe(counts, 'a', 'reply_button', 'btn:0')).toEqual({ count: 5, contacts: 4 });
  });

  it('ne confond pas deux blocs ni deux choix', () => {
    expect(valeurDe(counts, 'b', 'sent', null).count).toBe(0);
    expect(valeurDe(counts, 'a', 'reply_button', 'btn:1').count).toBe(0);
  });

  it('handlesMesuresParBloc : ne remonte que les clics, dédupliqués', () => {
    const avecDoublon = [...counts, { nodeId: 'a', kind: 'reply_button', handle: 'btn:0', count: 1, contacts: 1 }];
    expect(handlesMesuresParBloc(avecDoublon)).toEqual({ a: ['btn:0'] });
  });
});
