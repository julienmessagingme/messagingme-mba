import { describe, it, expect } from 'vitest';
import {
  AGENDA, CHOIX_ACTION, agendaEffectif, fusionner, fusionnerBascules,
  manquesDeCouverture, prochainsPoints, type EtatEntretien, type Inventaire,
} from '../src/agent/setup/couverture';
import { inventaireDe, type ContexteConstruction } from '../src/agent/setup/conversation';
import { ficheVide } from '../src/agent/fiche';

/**
 * L'ENTRETIEN CONDUIT PAR LE SERVEUR, ET LES BASCULES PRISES UNE PAR UNE.
 *
 * 🔴 CE QUE ÇA RÉPARE. Julien, 2026-08-31, en plein entretien : « quand le client veut prendre RDV, il faut
 * que l'agent appelle un outil […] quand le client demande où se trouve la concession, il faut lui envoyer un
 * point GPS […] j'imagine qu'on peut le faire en envoyant un scénario ? ». Deux moments, deux traitements
 * différents, dans une seule phrase. L'ancien modèle portait UNE action sur le point `bascules` : le second
 * écrasait le premier en silence, et personne ne l'aurait vu avant que l'agent ne se taise en production.
 *
 * Sa demande : « il faut que tu prennes 1 par 1, je dis bien 1 par 1, et que tu poses les questions sous forme
 * de questionnaire avec des choix ». Ce fichier vérifie que c'est un MÉCANISME et pas une consigne de prompt.
 */
describe('couverture de l’ordre du jour', () => {
  const codes = AGENDA.map((p) => p.code);
  const repondreTout = () => codes.map((point) => ({ point, valeur: 'dit' }));
  /** Un état où tous les points de BASE sont couverts, sans aucune bascule citée. */
  const base = (over: Partial<EtatEntretien> = {}): EtatEntretien =>
    ({ poses: codes, reponses: repondreTout(), bascules: [], ...over });

  /**
   * Le même état, mais où TOUTES les questions engendrées ont aussi été posées.
   *
   * ⚠️ Nécessaire, et c'est la règle qui parle : un point engendré obéit à la même exigence que les autres, il
   * n'est couvert que s'il a été POSÉ. Sans ce passage, un test qui remplit une bascule verrait quand même sa
   * question dans les manques, ce qui est le comportement VOULU (on ne compte pas une question jamais posée).
   */
  const toutPose = (etat: EtatEntretien): EtatEntretien =>
    ({ ...etat, poses: agendaEffectif(etat).map((p) => p.code) });

  it('rien de posé, rien de répondu : tous les points manquent', () => {
    expect(manquesDeCouverture({ poses: [], reponses: [] })).toEqual(codes);
  });

  it('🔴 une réponse SANS que le point ait été POSÉ ne couvre rien', () => {
    // C'est la garantie centrale : on s'assure d'avoir fait le tour, pas que le modèle a bien deviné. Une
    // réponse donnée d'avance est gardée (elle sert à faire confirmer en une phrase), elle ne compte pas.
    expect(manquesDeCouverture({ poses: [], reponses: repondreTout() })).toEqual(codes);
  });

  it('🔴 un point POSÉ mais sans réponse ne couvre rien non plus', () => {
    expect(manquesDeCouverture({ poses: codes, reponses: [] })).toEqual(codes);
  });

  it('posé ET répondu, sans bascule citée : l’entretien est fini', () => {
    expect(manquesDeCouverture(base())).toEqual([]);
  });

  it('🔴 un code INVENTÉ ne couvre rien', () => {
    // Les réponses viennent d'un modèle, donc d'une source non fiable : s'il suffisait d'inventer des codes
    // pour se déclarer complet, l'entretien ne serait qu'une suggestion.
    const etat = { poses: codes, reponses: [{ point: 'tout_le_reste', valeur: 'dit' }, { point: 'mission', valeur: 'dit' }] };
    expect(manquesDeCouverture(etat)).toEqual(codes.filter((c) => c !== 'mission'));
  });

  it('une réponse VIDE ne couvre pas', () => {
    expect(manquesDeCouverture({ poses: codes, reponses: [{ point: 'mission', valeur: '   ' }] })).toContain('mission');
  });

  it('🔴 une question engendrée obéit à la MÊME règle : jamais posée, jamais couverte', () => {
    // Sinon le creusement serait décoratif : le modèle pourrait remplir action et moyen sans que le client
    // ait jamais vu passer la question.
    const remplie = base({ bascules: [{ moment: 'il veut un rendez-vous', action: 'continuer' }] });
    expect(manquesDeCouverture(remplie)).toEqual(['bascule_1_action']);
    expect(manquesDeCouverture(toutPose(remplie))).toEqual([]);
  });

  it('🔴 CHAQUE moment de bascule ouvre SA question, une par une', () => {
    const deux = base({
      bascules: [{ moment: 'le client veut prendre rendez-vous' }, { moment: 'il demande où est la concession' }],
    });
    expect(manquesDeCouverture(deux)).toEqual(['bascule_1_action', 'bascule_2_action']);
    // Et elles s'insèrent JUSTE APRÈS le point qui les fait naître, pas à la fin : on traite un moment tant
    // qu'on l'a en tête, on ne le remet pas en file d'attente derrière le ton et l'identité.
    const ordre = agendaEffectif(deux).map((p) => p.code);
    expect(ordre.indexOf('bascule_1_action')).toBe(ordre.indexOf('bascules') + 1);
    expect(ordre.indexOf('bascule_2_action')).toBe(ordre.indexOf('bascule_1_action') + 1);
  });

  it('🔴 une action qui appelle un MOYEN ouvre une question de plus, et l’entretien ne finit pas sans', () => {
    // « Il appelle un outil » n'est pas une réponse : c'est le début d'une question. LEQUEL ?
    const sansMoyen = toutPose(base({ bascules: [{ moment: 'le client veut prendre rendez-vous', action: 'outil_api' }] }));
    expect(manquesDeCouverture(sansMoyen)).toEqual(['bascule_1_moyen']);
    const avecMoyen = toutPose(base({ bascules: [{ moment: 'le client veut prendre rendez-vous', action: 'outil_api', moyen: 'le connecteur agenda' }] }));
    expect(manquesDeCouverture(avecMoyen)).toEqual([]);
  });

  it('les actions qui n’appellent AUCUN moyen n’ouvrent pas de question (la garde ne déborde pas)', () => {
    for (const action of ['humain', 'continuer'] as const) {
      expect(manquesDeCouverture(toutPose(base({ bascules: [{ moment: 'il insiste', action }] }))), action).toEqual([]);
    }
    for (const action of ['scenario', 'outil_api', 'outil_mcp', 'autre'] as const) {
      expect(manquesDeCouverture(toutPose(base({ bascules: [{ moment: 'il insiste', action }] }))), action).toEqual(['bascule_1_moyen']);
    }
  });

  it('🔴 la question posée est le QUESTIONNAIRE À CHOIX, avec le moment du client dedans', () => {
    // Julien : « pose les questions sous forme de questionnaire avec des choix : 1) … 2) … 3) … 4) autre ».
    const etat = base({ bascules: [{ moment: 'le client veut prendre rendez-vous' }] });
    const point = agendaEffectif(etat).find((p) => p.code === 'bascule_1_action')!;
    expect(point.question).toContain('le client veut prendre rendez-vous');
    for (const c of CHOIX_ACTION) expect(point.question, c.action).toContain(c.libelle);
    expect(point.question).toContain('1)');
    expect(point.question).toContain(`${CHOIX_ACTION.length})`);
  });

  it('🔴 les quatre choix demandés par Julien sont là, et « continuer » aussi', () => {
    // Scénario / API / MCP / autre viennent de sa liste. `humain` et `continuer` sont gardés parce qu'il les
    // avait lui-même exigés le 2026-08-28 : les retirer rouvrirait le défaut de l'action inventée faute de
    // pouvoir dire « rien de spécial ».
    const actions = CHOIX_ACTION.map((c) => c.action);
    expect(actions).toContain('scenario');
    expect(actions).toContain('outil_api');
    expect(actions).toContain('outil_mcp');
    expect(actions).toContain('autre');
    expect(actions).toContain('continuer');
  });

  it('🔴 MCP est proposé SANS promesse fausse, dans un sens comme dans l’autre', () => {
    /**
     * 🔴 CE CAS A CHANGÉ DE VÉRITÉ, PAS DE RAISON D'ÊTRE (2026-09-17). Il exigeait le mot « pas encore »,
     * parce que MCP était proposé sans être câblé : promettre un branchement inexistant était le défaut.
     * Les connecteurs MCP sont livrés, donc c'est l'inverse qui est devenu faux : annoncer « pas encore »
     * enverrait le client renoncer à un dispositif qui marche.
     *
     * Ce que le cas garde, c'est son invariant : le libellé ne dit RIEN de faux sur l'état du câblage.
     */
    const mcp = CHOIX_ACTION.find((c) => c.action === 'outil_mcp')!;
    expect(mcp.libelle).not.toContain('pas encore');
    expect(mcp.libelle).not.toContain('disponible');
    expect(mcp.libelle).toContain('MCP');
  });

  /**
   * 🔴 LA QUESTION DU MOYEN MONTRE CE QUI EST RÉELLEMENT BRANCHÉ.
   *
   * Julien, 2026-08-31 : « si la personne dit MCP ou API, il faut que t'ailles chercher ce qui est branché
   * pour que la personne dise exactement lequel c'est ; donc si c'est pas branché ou s'il y a rien, ben y a
   * rien et la personne devra choisir autre chose ». C'est le dernier verrou contre l'outil inventé : le
   * reste empêche le MODÈLE d'en inventer un, celui-ci empêche la CONVERSATION de conclure sur un moyen
   * qui n'existe pas.
   */
  describe('la question du moyen lit l’inventaire réel', () => {
    const question = (action: 'outil_api' | 'outil_mcp', inv: Inventaire): string => {
      const etat = base({ bascules: [{ moment: 'le client veut prendre rendez-vous', action }] });
      return agendaEffectif(etat, inv).find((p) => p.code === 'bascule_1_moyen')!.question;
    };

    it('API branchée : elle NOMME les connecteurs appelables', () => {
      const q = question('outil_api', { outilsApi: ['Agenda', 'Stock'], systemesApi: [], mcp: [], outilsMcp: [] });
      expect(q).toContain('Agenda');
      expect(q).toContain('Stock');
      expect(q).toContain('Branchés sur cet agent');
    });

    it('🔴 système DÉCLARÉ mais pas branché sur cet agent : on le dit, au lieu de « rien n’existe »', () => {
      // Répondre « rien » à un client qui vient de déclarer son ERP lui ferait croire qu'il a mal fait.
      const q = question('outil_api', { outilsApi: [], systemesApi: ['ERP interne'], mcp: [], outilsMcp: [] });
      expect(q).toContain('AUCUN connecteur n’est branché sur cet agent');
      expect(q).toContain('ERP interne');
      expect(q).toContain('Tools > Connecteurs API'); // et où le brancher
    });

    it('🔴 RIEN du tout : la question le dit et laisse DEUX issues, jamais un cul-de-sac', () => {
      // Ne laisser aucune issue ferait un entretien qui ne peut plus se terminer.
      const q = question('outil_api', { outilsApi: [], systemesApi: [], mcp: [], outilsMcp: [] });
      expect(q).toContain('rien à appeler');
      expect(q).toContain('choisissez autre chose');
      expect(q).toContain('Décrivez ce qu’il faudrait brancher');
    });

    it('🔴 MCP : la question NOMME les serveurs déclarés, et dit qu’il n’y en a pas quand c’est le cas', () => {
      /**
       * 🔴 MÊME CAS QU'AVANT, VÉRITÉ INVERSÉE (2026-09-17). Il exigeait « n'est PAS encore disponible »,
       * ce qui était juste tant que MCP n'était pas câblé. Depuis qu'il l'est, la question doit se
       * comporter comme celle des connecteurs API : énumérer ce qui EXISTE, et ne rien promettre quand il
       * n'y a rien.
       *
       * ⚠️ L'invariant conservé est celui que Julien a formulé le 2026-08-31 : « si c'est pas branché ou
       * s'il y a rien, ben y a rien et la personne devra choisir autre chose ». C'est le dernier verrou
       * contre l'outil inventé, et il vaut dans les deux états du câblage.
       */
      const declare = question('outil_mcp', { outilsApi: [], systemesApi: [], mcp: ['serveur maison'], outilsMcp: [] });
      expect(declare).toContain('serveur maison');
      expect(declare).not.toContain('PAS encore disponible');

      const rien = question('outil_mcp', { outilsApi: [], systemesApi: [], mcp: [], outilsMcp: [] });
      expect(rien).toContain('AUCUN serveur MCP');
      expect(rien).toContain('choisissez autre chose');
    });

    it('🔴 MCP : ce qui est BRANCHÉ sur cet agent passe AVANT ce qui est seulement déclaré', () => {
      /**
       * Le jumeau exact de la question des connecteurs API. N annoncer que les serveurs faisait dire
       * « voici ce qu il peut appeler » en nommant des choses qui n etaient reliees a rien.
       *
       * 🔴 L INVENTAIRE EST PRODUIT PAR `inventaireDe`, JAMAIS ECRIT A LA MAIN, et la premiere version de
       * ce test s y trompait. Construire l inventaire soi-meme n eprouve que `question`, donc il ne
       * pouvait pas voir que `inv.mcp` n excluait PAS les serveurs dont un outil est deja branche : la
       * phrase se contredisait alors dans sa propre moitie, « Branches sur cet agent : Chercher Notion.
       * Serveurs dont rien n est encore relie a cet agent : Notion. » C est le motif « le test n eprouve
       * que la fonction pure alors que le defaut est dans le cablage ».
       */
      const ctx: ContexteConstruction = {
        label: 'A', mentionIaFrequence: 'session' as const, inactiviteMinutes: 30, fiche: ficheVide(),
        outils: [], titresConnaissance: [],
        connecteurs: [{ nom: 'notion_search', titre: 'Chercher Notion', description: '', nePasUtiliser: '', origine: 'mcp' as const }],
        sources: [
          { label: 'Notion', kind: 'mcp', status: 'active' },
          { label: 'Serveur maison', kind: 'mcp', status: 'active' },
        ],
      };
      const q = question('outil_mcp', inventaireDe(ctx));
      expect(q).toContain('Branchés sur cet agent');
      expect(q).toContain('Chercher Notion');
      // Celui dont rien n est branche est bien propose...
      expect(q).toContain('Serveur maison');
      // ...et celui dont un outil EST branche ne l est PAS une seconde fois.
      expect(q).not.toContain('relié à cet agent : Notion');
    });

    it('🔴 un outil MCP branché n’est PAS annoncé comme un connecteur API', () => {
      /**
       * `connecteurs` est construit en excluant les seuls outils maison, donc il porte les DEUX familles.
       * Sans la separation par origine, `inventaireDe` les versait toutes dans `outilsApi` et la branche
       * `outil_api` annoncait un outil MCP comme appelable en HTTP : l assistant promettait un appel de la
       * mauvaise nature, sur un chemin qui n existe pas.
       */
      const ctx: ContexteConstruction = {
        label: 'A', mentionIaFrequence: 'session' as const, inactiviteMinutes: 30, fiche: ficheVide(),
        outils: [], titresConnaissance: [],
        connecteurs: [
          { nom: 'erp_lire', titre: 'Lire l ERP', description: '', nePasUtiliser: '', origine: 'http' as const },
          { nom: 'notion_search', titre: 'Chercher Notion', description: '', nePasUtiliser: '', origine: 'mcp' as const },
        ],
        sources: [],
      };
      const inv = inventaireDe(ctx);
      expect(inv.outilsApi).toEqual(['Lire l ERP']);
      expect(inv.outilsMcp).toEqual(['Chercher Notion']);
      expect(question('outil_api', inv)).not.toContain('Chercher Notion');
      expect(question('outil_mcp', inv)).toContain('Chercher Notion');
    });

    it('un système DÉJÀ branché n’est pas proposé une seconde fois comme « à relier »', () => {
      const ctx: ContexteConstruction = {
        label: 'A', mentionIaFrequence: 'session' as const, inactiviteMinutes: 30, fiche: ficheVide(), outils: [], titresConnaissance: [],
        connecteurs: [{ nom: 'erp', titre: 'ERP interne', description: '', nePasUtiliser: '', origine: 'http' as const }],
        sources: [{ label: 'ERP interne', kind: 'http', status: 'active' }, { label: 'Agenda', kind: 'http', status: 'active' }],
      };
      const inv = inventaireDe(ctx);
      expect(inv.outilsApi).toEqual(['ERP interne']);
      expect(inv.systemesApi).toEqual(['Agenda']);
    });

    it('une source DÉSACTIVÉE ne compte pas : la proposer promettrait un appel qui échouerait', () => {
      const ctx: ContexteConstruction = {
        label: 'A', mentionIaFrequence: 'session' as const, inactiviteMinutes: 30, fiche: ficheVide(), outils: [], titresConnaissance: [], connecteurs: [],
        sources: [{ label: 'Vieux CRM', kind: 'http', status: 'disabled' }, { label: 'MCP off', kind: 'mcp', status: 'disabled' }],
      };
      expect(inventaireDe(ctx)).toEqual({ outilsApi: [], systemesApi: [], mcp: [], outilsMcp: [] });
    });
  });

  it('🔴 fusionnerBascules apparie par MOMENT et ajoute en fin : les codes engendrés restent stables', () => {
    // Si la liste se réordonnait, un point noté POSÉ désignerait soudain une autre bascule, et on reposerait
    // une question déjà tranchée en croyant en poser une neuve.
    const un = fusionnerBascules([], [{ moment: 'A' }, { moment: 'B' }]);
    const deux = fusionnerBascules(un, [{ moment: 'B', action: 'scenario' }]);
    expect(deux.map((b) => b.moment)).toEqual(['A', 'B']);
    expect(deux[1]!.action).toBe('scenario');
    // Un champ ABSENT n'efface pas : le modèle rend souvent la bascule entière alors qu'il n'a appris qu'une
    // partie, et effacer le reste ferait perdre un moyen déjà donné.
    expect(fusionnerBascules(deux, [{ moment: 'B' }])[1]!.action).toBe('scenario');
    // Un moment vide n'entre pas, et la casse ne crée pas de doublon.
    expect(fusionnerBascules(deux, [{ moment: '   ' }])).toHaveLength(2);
    expect(fusionnerBascules(deux, [{ moment: 'b', moyen: 'le scénario Adresse' }])).toHaveLength(2);
  });

  it('le total annoncé au client GRANDIT avec les moments cités, ce qui est honnête', () => {
    // Il ne pouvait pas savoir combien de moments il aurait avant de les avoir dits.
    expect(agendaEffectif(base()).length).toBe(codes.length);
    const avecDeux = base({ bascules: [{ moment: 'A', action: 'outil_api' }, { moment: 'B', action: 'continuer' }] });
    expect(agendaEffectif(avecDeux).length).toBe(codes.length + 3); // A : action + moyen ; B : action seule
  });

  it('fusionner : une nouvelle réponse remplace l’ancienne, et l’état se relit dans l’ordre du questionnaire', () => {
    const etat = fusionner([{ point: 'ton', valeur: 'formel' }], [{ point: 'mission', valeur: 'prendre rdv' }, { point: 'ton', valeur: 'tutoiement' }]);
    expect(etat.map((r) => r.point)).toEqual(['mission', 'ton']); // ordre de l'AGENDA, pas d'arrivée
    expect(etat.find((r) => r.point === 'ton')?.valeur).toBe('tutoiement');
  });

  it('🔴 le point OUVERT et le SUIVANT, jamais plus : l’entretien avance d’un cran par tour', () => {
    // Un seul point ferait reposer une question à laquelle le client vient de répondre (le serveur choisit
    // AVANT de le lire) ; toute la liste laisserait le modèle la survoler.
    const [ouvert, suivant] = prochainsPoints({ poses: [], reponses: [] });
    expect(ouvert?.code).toBe(codes[0]);
    expect(suivant?.code).toBe(codes[1]);
  });

  it('dernier point : il n’y a pas de suivant, et le suivant du néant est null', () => {
    const presqueFini = base({ reponses: repondreTout().slice(0, -1) });
    const [ouvert, suivant] = prochainsPoints(presqueFini);
    expect(ouvert?.code).toBe(codes[codes.length - 1]);
    expect(suivant).toBeNull();
    expect(prochainsPoints(base())).toEqual([null, null]);
  });
});
