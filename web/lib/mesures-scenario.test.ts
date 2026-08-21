import { describe, it, expect } from 'vitest';
import {
  blocsDuScenario, mesuresDisponibles, libelleHandle, valeurDe, handlesMesuresParBloc, estMesurable,
  couleurDe, groupesDuTableau, handlesClicsLienParBloc,
} from './mesures-scenario';
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
    expect(blocsDuScenario(g, 'fr').map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('🔴 un bloc INATTEIGNABLE est mis à la fin, jamais masqué', () => {
    // Une branche débranchée en cours de construction peut très bien avoir déjà tourné : la masquer donnerait
    // l'impression que ses mesures n'existent pas.
    const orphelin: Graph = { nodes: [...g.nodes, n('z', 'template', { templateName: 'ancien' })], edges: g.edges };
    expect(blocsDuScenario(orphelin, 'fr').map((b) => b.id)).toEqual(['a', 'b', 'c', 'z']);
  });

  it('un cycle ne fait pas boucler', () => {
    const boucle: Graph = { nodes: [n('a', 'quick_message'), n('b', 'quick_message')], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] };
    expect(blocsDuScenario(boucle, 'fr').map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('les blocs non-messages sont marqués comme tels (l’écran les grise)', () => {
    expect(blocsDuScenario(g, 'fr').map((b) => b.mesurable)).toEqual([true, true, false]);
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
    expect(blocsDuScenario(g, 'fr')[0]!.choix).toEqual([]);
  });

  it('un bouton déclaré est nommé par son TEXTE, pas par son index', () => {
    const g: Graph = { nodes: [n('a', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }, { text: 'Non' }] })], edges: [] };
    expect(blocsDuScenario(g, 'fr')[0]!.choix).toEqual([
      { handle: 'btn:0', label: '« Oui »' },
      { handle: 'btn:1', label: '« Non »' },
    ]);
  });

  it('🔴 un choix de CAROUSEL apparaît dès qu’il est mesuré, même s’il n’est pas dans le graphe', () => {
    // Le graphe ne déclare pas les cartes d'un carousel : elles vivent dans le template chez Meta. Sans cette
    // révélation par les données, les choix d'un carousel seraient invisibles dans les tableaux.
    const g: Graph = { nodes: [n('a', 'template', { templateName: 'promo_carousel' })], edges: [] };
    const b = blocsDuScenario(g, 'fr', { a: ['card:1:btn:0'] })[0]!;
    expect(b.choix).toEqual([{ handle: 'card:1:btn:0', label: 'Carte 2, bouton 1' }]);
  });

  it('libelleHandle : lisible pour un opérateur, jamais le handle brut quand on peut mieux', () => {
    expect(libelleHandle('btn:0', ['Oui'], 'fr')).toBe('« Oui »');
    expect(libelleHandle('btn:3', [], 'fr')).toBe('Bouton 4'); // bouton non déclaré : on ne devine pas de texte
    expect(libelleHandle('card:0:btn:2', [], 'fr')).toBe('Carte 1, bouton 3');
    expect(libelleHandle('autre_chose', [], 'fr')).toBe('autre_chose');
  });
});

describe('les mesures proposées sur un bloc', () => {
  const bloc = blocsDuScenario({ nodes: [n('a', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] })], edges: [] }, 'fr')[0]!;

  it('🔴 « a répondu sans cliquer » est proposé MÊME sur un bloc à boutons', () => {
    // Et surtout sur un bloc sans choix, où c'est la seule mesure d'engagement possible.
    expect(mesuresDisponibles(bloc, 'fr').map((m) => m.kind)).toContain('reply_text');
  });

  it('un choix donne une mesure par bouton', () => {
    const clics = mesuresDisponibles(bloc, 'fr').filter((m) => m.kind === 'reply_button');
    expect(clics).toEqual([{ cle: 'a|reply_button|btn:0', label: 'A cliqué « Oui »', kind: 'reply_button', handle: 'btn:0' }]);
  });

  it('🔴 « Échecs » et « Délivrés » ne sont proposés QUE sur le premier message', () => {
    // Après le premier template, le message part à quelqu'un qui vient de répondre : l'envoi aboutit et arrive
    // quasiment toujours. Ces deux mesures y afficheraient des barres plates, l'une à zéro et l'autre collée
    // aux « Envoyés », ce qui noierait le signal qu'on est venu chercher.
    const kindsPremier = mesuresDisponibles(bloc, 'fr', true).map((m) => m.kind);
    expect(kindsPremier).toContain('failed');
    expect(kindsPremier).toContain('delivered');

    const kindsSuivant = mesuresDisponibles(bloc, 'fr', false).map((m) => m.kind);
    expect(kindsSuivant).not.toContain('failed');
    expect(kindsSuivant).not.toContain('delivered');
    // Ce qui compte vraiment sur un bloc suivant reste proposé.
    expect(kindsSuivant).toEqual(expect.arrayContaining(['sent', 'read', 'reply_button', 'reply_text']));
  });

  it('🔴 un bloc NON mesurable ne propose rien', () => {
    const tag = blocsDuScenario({ nodes: [n('t', 'tag', { tag: 'vu' })], edges: [] }, 'fr')[0]!;
    expect(mesuresDisponibles(tag, 'fr')).toEqual([]);
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

describe('les groupes de barres du tableau', () => {
  const g = { nodes: [
    n('a', 'template', { templateName: 'promo' }),
    n('b', 'quick_message', { body: 'Ça te va ?', quickReplies: [{ text: 'Oui' }, { text: 'Non' }] }),
  ], edges: [{ source: 'a', target: 'b' }] };
  const blocs = blocsDuScenario(g, 'fr');
  const counts: CompteurBrut[] = [
    { nodeId: 'a', kind: 'sent', handle: null, count: 40, contacts: 40 },
    { nodeId: 'b', kind: 'reply_button', handle: 'btn:0', count: 12, contacts: 9 },
    { nodeId: 'b', kind: 'reply_button', handle: 'btn:1', count: 5, contacts: 5 },
  ];
  const mes = (id: string, kind: string, handle: string | null = null) => ({
    cle: `${id}|${kind}${handle ? `|${handle}` : ''}`, label: 'x', kind, handle,
  });

  it('🔴 l’ordre est celui du PARCOURS, pas celui des clics de l’opérateur', () => {
    // Un entonnoir se lit de gauche a droite dans le sens du scenario. Suivre l'ordre des clics donnerait un
    // dessin different a chaque fois qu'on recompose la meme selection.
    const groupes = groupesDuTableau([mes('b', 'sent'), mes('a', 'sent')], counts, blocs, 'fr');
    expect(groupes.map((x) => x.nodeId)).toEqual(['a', 'b']);
  });

  it('un bloc sans mesure retenue n’occupe PAS de place', () => {
    // Reserver une colonne vide a chaque bloc du scenario ecraserait les groupes reellement mesures.
    expect(groupesDuTableau([mes('a', 'sent')], counts, blocs, 'fr').map((x) => x.nodeId)).toEqual(['a']);
  });

  it('🔴 une même NATURE garde la même couleur d’un bloc à l’autre', () => {
    // C'est ce qui permet de comparer « envoyes » du bloc 1 a « envoyes » du bloc 2 sans relire la legende.
    const groupes = groupesDuTableau([mes('a', 'sent'), mes('b', 'sent')], counts, blocs, 'fr');
    expect(groupes[0]!.barres[0]!.couleur).toBe(groupes[1]!.barres[0]!.couleur);
    expect(couleurDe('sent')).not.toBe(couleurDe('read'));
    expect(couleurDe('read')).not.toBe(couleurDe('failed'));
  });

  it('🔴 deux CHOIX du même bloc se distinguent, sinon les barres voisines seraient identiques', () => {
    const groupes = groupesDuTableau([mes('b', 'reply_button', 'btn:0'), mes('b', 'reply_button', 'btn:1')], counts, blocs, 'fr');
    const [c0, c1] = groupes[0]!.barres.map((x) => x.couleur);
    expect(c0).not.toBe(c1);
    // La nuance suit la POSITION du choix : le « premier choix » garde sa couleur d'un bloc a l'autre.
    expect(c0).toBe(couleurDe('reply_button', 0));
  });

  it('les valeurs viennent des compteurs, et une mesure absente vaut zéro', () => {
    const groupes = groupesDuTableau([mes('a', 'sent'), mes('a', 'read')], counts, blocs, 'fr');
    expect(groupes[0]!.barres.map((x) => x.count)).toEqual([40, 0]);
    expect(groupes[0]!.barres[0]!.contacts).toBe(40);
  });
});

describe('clics sur un LIEN de template', () => {
  /** Un bloc template portant un bouton de choix puis un bouton URL, comme le WorkflowBuilder les enregistre. */
  const blocAvecLien: Graph = {
    nodes: [{
      id: 'a',
      type: 'template',
      data: {
        templateName: 'promo',
        templateButtons: [
          { type: 'QUICK_REPLY', text: 'Oui' },
          { type: 'URL', text: 'Voir le site', url: 'https://client.fr/promo' },
        ],
      },
    }],
    edges: [],
  };

  it('🔴 un bouton URL ne propose PLUS de mesure de CHOIX', () => {
    // Meta n'émet AUCUN événement quand on clique un bouton URL. La case « A cliqué « Voir le site » » de
    // nature `reply_button` existait, et restait à zéro pour toujours : une mesure qui ment.
    const bloc = blocsDuScenario(blocAvecLien, 'fr')[0]!;
    expect(bloc.choix).toEqual([{ handle: 'btn:0', label: '« Oui »' }]);
    expect(mesuresDisponibles(bloc, 'fr').filter((m) => m.kind === 'reply_button').map((m) => m.handle)).toEqual(['btn:0']);
  });

  it('🔴 un bouton URL TRACÉ propose la mesure de clic, à son index Meta', () => {
    // L'index reste celui de TOUS les boutons (le bouton URL est le second), sinon le clic se rattacherait
    // au mauvais bouton.
    const bloc = blocsDuScenario(blocAvecLien, 'fr', {}, { a: ['btn:1'] })[0]!;
    expect(bloc.liens).toEqual([{ handle: 'btn:1', label: '« Voir le site »' }]);
    const mesure = mesuresDisponibles(bloc, 'fr').find((m) => m.kind === 'url_click');
    expect(mesure).toEqual({ cle: 'a|url_click|btn:1', label: 'A cliqué sur le lien « Voir le site »', kind: 'url_click', handle: 'btn:1' });
  });

  it('🔴 un bouton URL NON tracé ne propose RIEN', () => {
    // Un template approuvé avant la mise en service porte l'adresse du client en dur : rien ne le mesurera
    // jamais, et proposer la case reproduirait exactement le défaut qu'on vient de corriger.
    const bloc = blocsDuScenario(blocAvecLien, 'fr')[0]!;
    expect(bloc.liens).toEqual([]);
    expect(mesuresDisponibles(bloc, 'fr').some((m) => m.kind === 'url_click')).toBe(false);
  });

  it('handlesClicsLienParBloc ne retient que les clics de LIEN', () => {
    const counts: CompteurBrut[] = [
      { nodeId: 'a', kind: 'url_click', handle: 'btn:1', count: 12, contacts: null },
      { nodeId: 'a', kind: 'reply_button', handle: 'btn:0', count: 5, contacts: 5 },
      { nodeId: 'a', kind: 'sent', handle: null, count: 40, contacts: 40 },
    ];
    expect(handlesClicsLienParBloc(counts)).toEqual({ a: ['btn:1'] });
    expect(handlesMesuresParBloc(counts)).toEqual({ a: ['btn:0'] });
  });

  it('🔴 un clic de lien ne prend PAS la couleur d’un bouton de choix', () => {
    // Dans un même bloc, « a cliqué « Oui » » et « a cliqué sur le lien » sont deux gestes différents : les
    // peindre dans la même famille de teintes les confondrait à l'oeil.
    expect(couleurDe('url_click', 0)).not.toBe(couleurDe('reply_button', 0));
    expect(couleurDe('url_click', 0)).not.toBe(couleurDe('reply_button', 1));
  });

  it('la barre d’un clic de lien porte son compteur, et « personnes » reste INCONNU', () => {
    const bloc = blocsDuScenario(blocAvecLien, 'fr', {}, { a: ['btn:1'] })[0]!;
    const mesure = mesuresDisponibles(bloc, 'fr').find((m) => m.kind === 'url_click')!;
    const counts: CompteurBrut[] = [{ nodeId: 'a', kind: 'url_click', handle: 'btn:1', count: 12, contacts: null }];
    const barre = groupesDuTableau([mesure], counts, [bloc], 'fr')[0]!.barres[0]!;
    expect(barre.count).toBe(12);
    expect(barre.contacts).toBeNull();
  });
});

/**
 * Cet écran est resté 100 % français en mode anglais : le chantier i18n avait traduit les COMPOSANTS, mais
 * ce module est un `.ts` pur, où `useT()` est inappelable. Les libellés y étaient donc écrits en dur.
 */
describe('les libellés suivent la langue de la console', () => {
  const blocEn = blocsDuScenario(
    { nodes: [n('a', 'quick_message', { body: 'x', quickReplies: [{ text: 'Yes' }] })], edges: [] },
    'en',
  )[0]!;

  it('🔴 les mesures de base sont en anglais', () => {
    const labels = mesuresDisponibles(blocEn, 'en').map((m) => m.label);
    expect(labels).toContain('Sent');
    expect(labels).toContain('Read');
    expect(labels).toContain('Replied (without tapping)');
    // Et surtout : plus rien de français.
    expect(labels.some((l) => /Envoyés|Lus|répondu|cliqué/.test(l))).toBe(false);
  });

  it('🔴 le libellé d’un bouton porte les guillemets ANGLAIS', () => {
    expect(libelleHandle('btn:0', ['Yes'], 'en')).toBe('“Yes”');
    expect(libelleHandle('btn:3', [], 'en')).toBe('Button 4');
    expect(libelleHandle('card:0:btn:2', [], 'en')).toBe('Card 1, button 3');
  });

  it('🔴 le titre de repli d’un bloc vient de NODE_META, pas d’une chaîne en dur', () => {
    const g = { nodes: [n('a', 'inbox'), n('b', 'wait'), n('c', 'condition')], edges: [] };
    expect(blocsDuScenario(g, 'en').map((b) => b.titre)).toEqual(['Assign to an agent', 'Wait', 'Condition']);
    expect(blocsDuScenario(g, 'fr').map((b) => b.titre)).toEqual(['Assigner à un agent', 'Attente', 'Condition']);
  });

  it('🔴 `titrePropre` distingue un nom SAISI d’un simple nom de type', () => {
    // C'est ce booléen qui remplace la comparaison de libellés de la carte : elle opposait une chaîne
    // traduite à une chaîne qui ne l'était pas, donc en anglais le sous-titre redondant revenait partout.
    const g = { nodes: [n('a', 'template', { templateName: 'promo_ete' }), n('b', 'template')], edges: [] };
    expect(blocsDuScenario(g, 'en').map((b) => [b.titre, b.titrePropre])).toEqual([
      ['promo_ete', true],
      ['Template (not chosen)', false],
    ]);
  });

  it('🔴 un tableau ENREGISTRÉ en français se relit en anglais', () => {
    // Le libellé part en base avec le tableau. Le relire tel quel ressortirait du français dans une console
    // en anglais, même une fois tout le reste traduit : il doit être re-dérivé à l'affichage.
    const bloc = blocsDuScenario({ nodes: [n('a', 'quick_message', { body: 'x' })], edges: [] }, 'fr')[0]!;
    const enregistre = mesuresDisponibles(bloc, 'fr').find((m) => m.kind === 'sent')!;
    expect(enregistre.label).toBe('Envoyés');
    const blocLu = blocsDuScenario({ nodes: [n('a', 'quick_message', { body: 'x' })], edges: [] }, 'en')[0]!;
    const barre = groupesDuTableau([enregistre], [], [blocLu], 'en')[0]!.barres[0]!;
    expect(barre.label).toBe('Sent');
  });
  it('🔴 une mesure de CLIC enregistrée se relit en anglais même sans compteur sur la période', () => {
    // Le cas que le test précédent ne couvre PAS : `bloc.liens` et `bloc.choix` sont bâtis à partir des
    // COMPTEURS reçus. Sur une période sans aucun clic, la clé enregistrée ne s'y retrouve plus, et le
    // libellé figé en base ressortirait tel quel, en français.
    const g = { nodes: [n('a', 'quick_message', { body: 'x' })], edges: [] };
    const avecCompteur = blocsDuScenario(g, 'fr', {}, { a: ['btn:1'] })[0]!;
    const enregistre = mesuresDisponibles(avecCompteur, 'fr').find((m) => m.kind === 'url_click')!;
    expect(enregistre.label).toBe('A cliqué sur le lien Bouton 2');

    // Même tableau, relu en anglais sur une période SANS clic : plus aucun handle dans les compteurs.
    const sansCompteur = blocsDuScenario(g, 'en')[0]!;
    const barre = groupesDuTableau([enregistre], [], [sansCompteur], 'en')[0]!.barres[0]!;
    expect(barre.label).toBe('Clicked the link Button 2');
  });
});
