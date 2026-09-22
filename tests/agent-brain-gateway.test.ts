import { describe, it, expect } from 'vitest';
import { AgentIntrouvable, MAX_ALLERS_RETOURS, creerCerveauGateway, penserTrace, type ContexteAgentComplet, type ContexteTour, type GatewayBrainDeps } from '../src/agent/brain.gateway';
import type { ChatMessage, ReponseChat } from '../src/agent/llm/chat-client';
import type { JournalAppels, OutilDefini, ToolCatalog } from '../src/agent/catalog';
import type { ResolveurOutil } from '../src/agent/executor';
import { ficheVide } from '../src/agent/fiche';
import { SORTIE_PLAFOND } from '../src/agent/sorties';
import { TourInterrompu } from '../src/agent/brain';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE, GESTE_MUET } from './gestes';

/**
 * Le CERVEAU : la boucle qui transforme un historique en une décision.
 *
 * 🔴 C'EST L'APPELANT QUI MANQUAIT à `executeTool` (dette D3), et les trois responsabilités que sa JSDoc lui
 * assignait se vérifient ici : alerter sur une erreur de PROTOCOLE, calculer les plafonds restants À CHAQUE
 * appel, et encadrer le résultat d'outil en BLOC DÉLIMITÉ avant de le remettre au modèle.
 *
 * 🔴 ET SURTOUT : ce qui ARRÊTE la boucle. Sans plafond d'allers-retours, un modèle qui rappelle le même
 * outil brûlerait le compte prépayé du tenant en quelques secondes, et c'est exactement ce qu'une injection
 * dans le message d'un contact chercherait à obtenir.
 */

const OUTIL: OutilDefini = { ...SANS_MCP, ...AUCUN_GESTE(),
  id: 'o1', tenantId: 't1', origin: 'mba', name: 'mba_poser_tag',
  description: 'Tague.', params: [{ name: 'tag', type: 'string', source: 'modele', required: true }],
  binding: { handler: 'poser_tag' }, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'write',
  timeoutMs: 8000, maxBytes: 16384, autonome: false,
};

const AGENT: ContexteAgentComplet = {
  modele: 'modele-test',
  mentionIaFrequence: 'session' as const,
  mentionIa: 'Vous échangez avec un assistant automatique.',
  sorties: [{ code: 'fini', label: 'Fini' }],
  contenu: { ...ficheVide(), objectif: 'Aider.' },
  outilsActifs: [OUTIL],
  plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 },
  contactInconnu: 'tous',
};

const TOUR: ContexteTour = {
  sessionId: 's1', runId: 'r1', workflowId: 'w1', waId: '33600000000',
  appelsDejaFaits: 0, coutDejaMicroEur: 0,
};

const texte = (t: string): ReponseChat => ({
  texte: t, appelsOutils: [], finish: 'stop',
  usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 }, generationId: null,
});
const appelOutil = (nom: string, args: string, id = 'c1'): ReponseChat => ({
  texte: null, appelsOutils: [{ id, nom, argumentsJson: args }], finish: 'tool_calls',
  usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 }, generationId: null,
});

function deps(reponses: ReponseChat[], resolveur?: ResolveurOutil, agent: ContexteAgentComplet = AGENT) {
  const cap = { messages: [] as ChatMessage[][], alertes: [] as string[], comptes: 0 };
  let i = 0;
  const catalogue: ToolCatalog = {
    byName: async (_t, _a, name) => (name === OUTIL.name ? OUTIL : null),
    listActifs: async () => agent.outilsActifs,
  };
  const journal: JournalAppels = { ouvrir: async () => 'j1', clore: async () => {} };
  const d: GatewayBrainDeps = {
    completer: async ({ messages }) => {
      cap.messages.push(messages);
      const r = reponses[Math.min(i, reponses.length - 1)]!;
      i += 1;
      return r;
    },
    contexte: async () => agent,
    outils: {
      catalogue,
      journal,
      resolveurs: { mba: resolveur ?? (async () => ({ contenu: { pose: 'vip' } })) },
      compterAppel: async () => { cap.comptes += 1; },
      executerGeste: GESTE_MUET,
    },
    alerter: (m) => cap.alertes.push(m),
  };
  return { cap, d };
}

const entree = (transcript: unknown[] = [{ role: 'contact', texte: 'Bonjour' }]) => ({
  agentId: 'a1', tenantId: 't1', transcript, deadline: Date.now() + 30_000,
});

describe('penserTrace', () => {
  it('rend le texte du modèle quand il n’appelle aucun outil', async () => {
    const { cap, d } = deps([texte('Bonjour, comment puis-je aider ?')]);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r).toMatchObject({ texte: 'Bonjour, comment puis-je aider ?', sortie: null });
    expect(r.appels).toEqual([]);
    // Le prompt système est en tête, et l'historique suit, converti aux rôles du fournisseur.
    expect(cap.messages[0]![0]!.role).toBe('system');
    expect(cap.messages[0]![1]).toEqual({ role: 'user', content: 'Bonjour' });
  });

  it('🔴 le résultat d’un outil repart au modèle DANS UN BLOC DÉLIMITÉ', async () => {
    // Dette D3(c). Le contenu vient d'une base de connaissance qu'un site tiers a remplie : c'est de la
    // donnée, jamais un ordre.
    const { cap, d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}'), texte('C’est noté.')]);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r.texte).toBe('C’est noté.');
    const second = cap.messages[1]!;
    const resultat = second.find((m) => m.role === 'tool')!;
    expect(resultat.content!.startsWith('<<<RESULTAT_OUTIL')).toBe(true);
    expect(resultat.content!.endsWith('FIN_RESULTAT_OUTIL>>>')).toBe(true);
    expect(resultat.tool_call_id).toBe('c1');
    // 🔴 Et le message `tool` répond bien à un `assistant` qui PORTE `tool_calls` : l'API refuse en 400 un
    // `tool` orphelin, et un 400 est terminal. Sans cette assertion, la conversation casserait au deuxième
    // aller-retour, c'est-à-dire là où l'agent reformule à partir de ses sources.
    const avant = second[second.indexOf(resultat) - 1]!;
    expect(avant.role).toBe('assistant');
    expect(avant.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'mba_poser_tag', arguments: '{"tag":"vip"}' } }]);
  });

  it('🔴 une SORTIE d’outil arrête la boucle', async () => {
    const sortant: ResolveurOutil = async () => ({ contenu: { sortie: 'fini' }, sortie: 'fini' });
    const { cap, d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}'), texte('jamais atteint')], sortant);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r.sortie).toBe('fini');
    expect(cap.messages).toHaveLength(1); // le modèle n'a PAS été rappelé
  });

  it('🔴 une escalade (`rendu`) arrête la boucle SANS rien dire de plus', async () => {
    // La main n'est plus à nous : un message de plus arriverait chez un contact que quelqu'un vient de
    // reprendre.
    const escalade: ResolveurOutil = async () => ({ contenu: { escalade: true }, rendu: true });
    const { d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}'), texte('jamais atteint')], escalade);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r).toMatchObject({ texte: null, sortie: null });
  });

  /**
   * 🔴 L'ÉQUIPE FERMÉE EST LE SEUL CAS OÙ L'AGENT GARDE LA PAROLE À L'ESCALADE (2026-09-18).
   *
   * Le jet systématique du texte avait une raison, et elle tient QUAND L'ÉQUIPE RÉPOND : c'est la branche
   * `humain` du scénario qui parle ensuite. Elle cesse de tenir quand l'équipe ne répond pas, parce que
   * cette branche est un bloc STATIQUE : elle ne peut dire ni « c'est fermé » ni « nous reprenons lundi
   * 9 h ». Seul l'agent le peut, et il vient de recevoir la date dans sa consigne.
   */
  it('🔴 l’équipe INDISPONIBLE : la dernière phrase de l’agent est GARDÉE', async () => {
    const escalade: ResolveurOutil = async () => ({ contenu: { escalade: true }, rendu: true });
    const avecTexte: ReponseChat = {
      texte: 'Nous sommes fermés, l’équipe vous répond lundi matin.',
      appelsOutils: [{ id: 'c1', nom: 'mba_poser_tag', argumentsJson: '{"tag":"vip"}' }],
      finish: 'tool_calls',
      usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 },
      generationId: null,
    };
    const ferme = { ...AGENT, equipe: { disponible: false, reouverture: 'lundi 21 septembre à 9 h' } };
    const { d } = deps([avecTexte, texte('jamais atteint')], escalade, ferme);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r).toMatchObject({ texte: 'Nous sommes fermés, l’équipe vous répond lundi matin.', sortie: null });
  });

  it('⚠️ l’équipe DISPONIBLE : le texte reste jeté, comme avant', async () => {
    // La preuve inverse. Sans elle, garder le texte dans TOUS les cas passerait le test ci-dessus tout en
    // changeant le comportement de chaque escalade en production.
    const escalade: ResolveurOutil = async () => ({ contenu: { escalade: true }, rendu: true });
    const avecTexte: ReponseChat = {
      texte: 'Je vous passe un conseiller.',
      appelsOutils: [{ id: 'c1', nom: 'mba_poser_tag', argumentsJson: '{"tag":"vip"}' }],
      finish: 'tool_calls',
      usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 },
      generationId: null,
    };
    const ouvert = { ...AGENT, equipe: { disponible: true, reouverture: null } };
    const { d } = deps([avecTexte, texte('jamais atteint')], escalade, ouvert);
    expect(await penserTrace(entree(), TOUR, d)).toMatchObject({ texte: null });
    // Et sans le champ du tout, c'est-à-dire pour tout câblage qui ne l'a pas encore : même comportement.
    const { d: d2 } = deps([avecTexte, texte('jamais atteint')], escalade, AGENT);
    expect(await penserTrace(entree(), TOUR, d2)).toMatchObject({ texte: null });
  });

  it('🔴 une erreur de PROTOCOLE alerte et arrête le tour', async () => {
    // Dette D3(a) : c'est un bug de NOTRE client, pas du modèle. Le lui repasser lui ferait réessayer
    // indéfiniment une chose qu'il ne peut pas corriger.
    const { cap, d } = deps([appelOutil('inconnu_au_bataillon', '{}'), texte('jamais atteint')]);
    const r = await penserTrace(entree(), TOUR, d);
    // Un nom d'outil inconnu est un REFUS, pas une erreur de protocole : le modèle peut se corriger, et on
    // le lui repasse. C'est la leçon du bot hyundai, écrite en tête de `executor.ts`.
    expect(r.appels[0]!.status).toBe('refuse');
    // Des arguments illisibles non plus : le modèle sait se corriger, on le lui repasse.
    const illisible = deps([appelOutil('mba_poser_tag', '{ pas du json'), texte('je me corrige')]);
    expect((await penserTrace(entree(), TOUR, illisible.d)).appels[0]!.status).toBe('refuse');
    expect(illisible.cap.alertes).toHaveLength(0);

    // Le SEUL vrai cas de protocole : un outil dont l'ORIGINE n'a aucun résolveur câblé. Ce n'est pas une
    // erreur du modèle, c'est un trou dans NOTRE câblage, et lui repasser le ferait réessayer indéfiniment.
    const sansResolveur = { ...AGENT, outilsActifs: [{ ...OUTIL, origin: 'http' as const, name: 'appel_http' }] };
    const orphelin = deps([appelOutil('appel_http', '{"tag":"vip"}'), texte('jamais atteint')], undefined, sansResolveur);
    orphelin.d.outils.catalogue = { byName: async () => sansResolveur.outilsActifs[0]!, listActifs: async () => sansResolveur.outilsActifs };
    const r2 = await penserTrace(entree(), TOUR, orphelin.d);
    expect(r2.appels[0]!.status).toBe('erreur_protocole');
    expect(orphelin.cap.alertes).toHaveLength(1);
    expect(orphelin.cap.messages).toHaveLength(1); // le tour s'est ARRÊTÉ, le modèle n'a pas été rappelé
    expect(cap.alertes).toHaveLength(0);
  });

  it('🔴 une SALVE de plusieurs outils dans UNE réponse : un seul `assistant`, un `tool` par appel', async () => {
    // C'est la forme qu'impose le protocole, et c'est aussi le cas où le comptage des plafonds doit tenir :
    // un modèle qui demande six outils d'un coup ne doit pas pouvoir dépasser en une seule salve.
    const salve: ReponseChat = {
      texte: null, finish: 'tool_calls',
      appelsOutils: [
        { id: 'c1', nom: 'mba_poser_tag', argumentsJson: '{"tag":"vip"}' },
        { id: 'c2', nom: 'mba_poser_tag', argumentsJson: '{"tag":"relance"}' },
      ],
      usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 }, generationId: null,
    };
    const { cap, d } = deps([salve, texte('C’est noté.')]);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r.appels).toHaveLength(2);
    const second = cap.messages[1]!;
    expect(second.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(second.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['c1', 'c2']);
    expect(second.find((m) => m.role === 'assistant')!.tool_calls).toHaveLength(2);
  });

  it('🔴 une salve DÉPASSE le plafond d’appels au deuxième outil, pas au premier', async () => {
    const salve: ReponseChat = {
      texte: null, finish: 'tool_calls',
      appelsOutils: [
        { id: 'c1', nom: 'mba_poser_tag', argumentsJson: '{"tag":"vip"}' },
        { id: 'c2', nom: 'mba_poser_tag', argumentsJson: '{"tag":"relance"}' },
      ],
      usage: { tokensIn: 10, tokensOut: 5, tokensCaches: 0, coutDollars: 0.00001 }, generationId: null,
    };
    const unSeul = { ...AGENT, plafonds: { maxAppelsOutils: 1, budgetMicroEur: 30_000 } };
    const { d } = deps([salve, texte('ok')], undefined, unSeul);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r.appels[0]!.status).toBe('ok');
    expect(r.appels[1]!.status).toBe('budget');
  });

  it('🔴 le plafond d’ALLERS-RETOURS arrête la boucle et sort par « plafond »', async () => {
    // Sans lui, un modèle qui rappelle le même outil brûlerait le compte prépayé du tenant en quelques
    // secondes. C'est exactement ce qu'une injection dans le message d'un contact chercherait à obtenir.
    const { cap, d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}')]);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r.sortie).toBe(SORTIE_PLAFOND);
    expect(cap.messages).toHaveLength(MAX_ALLERS_RETOURS);
    expect(r.appels).toHaveLength(MAX_ALLERS_RETOURS);
  });

  /**
   * LE RÉGIME D'ANNONCE D'IA (migration 0126). C'est le TOUR qui décide, plus le modèle : il lit le
   * transcript de la session, où « l'agent a-t-il déjà parlé » se voit sans requête.
   */
  it('🔴 « session » : l’annonce est demandée au premier tour, et à celui-là seulement', async () => {
    const { cap, d } = deps([texte('bonjour')]);
    await penserTrace(entree(), TOUR, d);
    expect(JSON.stringify(cap.messages[0])).toContain('Commence ta réponse par exactement cette phrase');

    // Le MÊME agent, mais l'agent a déjà parlé dans cette session : plus d'annonce.
    const { cap: cap2, d: d2 } = deps([texte('et ensuite')]);
    await penserTrace({ ...entree(), transcript: [{ role: 'agent', texte: 'deja dit' }] }, TOUR, d2);
    expect(JSON.stringify(cap2.messages[0])).not.toContain('Commence ta réponse par exactement cette phrase');
  });

  it('🔴 « jamais » ne l’annonce pas, « chaque_message » l’annonce même après avoir parlé', async () => {
    // Les deux bornes du réglage. Sans elles, un câblage qui lirait le régime de travers passerait le test
    // ci-dessus (« session » est le défaut) sans que personne le voie.
    const jamais = { ...AGENT, mentionIaFrequence: 'jamais' as const };
    const { cap, d } = deps([texte('bonjour')], undefined, jamais);
    await penserTrace(entree(), TOUR, d);
    expect(JSON.stringify(cap.messages[0])).not.toContain('Commence ta réponse par exactement cette phrase');

    const toujours = { ...AGENT, mentionIaFrequence: 'chaque_message' as const };
    const { cap: c2, d: d2 } = deps([texte('et ensuite')], undefined, toujours);
    await penserTrace({ ...entree(), transcript: [{ role: 'agent', texte: 'deja dit' }] }, TOUR, d2);
    expect(JSON.stringify(c2.messages[0])).toContain('Commence ta réponse par exactement cette phrase');
  });

  it('🔴 le BUDGET arrête aussi les allers-retours, pas seulement les outils', async () => {
    // Trouvé à la revue du 2026-09-09. Le budget était contrôlé à chaque appel d'OUTIL et nulle part dans la
    // boucle : une conversation à court de budget refusait ses outils et continuait de payer des appels de
    // modèle jusqu'aux six allers-retours. Le plafond est annoncé comme un garde-fou de conversation ; il
    // débordait d'un tour entier, en silence.
    const sansSou = { ...AGENT, plafonds: { maxAppelsOutils: 12, budgetMicroEur: 1 } };
    const { cap, d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}')], undefined, sansSou);
    const r = await penserTrace(entree(), TOUR, d);

    expect(r.sortie).toBe(SORTIE_PLAFOND);
    // UN SEUL appel de modèle : celui qui a fait franchir le plafond est payé, le suivant ne part pas.
    expect(cap.messages).toHaveLength(1);
  });

  it('🔴 la preuve inverse : un budget LARGE laisse la boucle aller au bout', async () => {
    // Sans ce cas, un arrêt inconditionnel passerait le test ci-dessus tout en coupant l'agent au premier
    // aller-retour, donc en le rendant muet dès qu'il appelle un outil.
    // ⚠️ Ce test assertait d'abord `cap.messages.length === 0` AVANT d'appeler `penserTrace` : il passait
    // trivialement et ne prouvait rien. Deuxième fois de la journée que ce piège se referme.
    const { cap, d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}')]);
    await penserTrace(entree(), TOUR, d);
    expect(cap.messages).toHaveLength(MAX_ALLERS_RETOURS);
  });

  it('🔴 le plafond d’APPELS D’OUTILS de la fiche est appliqué, appel par appel', async () => {
    // Dette D3(b). Recalculé à chaque appel et non une fois par tour : un modèle qui demande six outils
    // d'un coup ne doit pas pouvoir dépasser en une seule salve.
    const serre = { ...AGENT, plafonds: { maxAppelsOutils: 1, budgetMicroEur: 30_000 } };
    const { d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}')], undefined, serre);
    const r = await penserTrace(entree(), { ...TOUR, appelsDejaFaits: 1 }, d);
    // Statut `budget` pour les DEUX plafonds : ce sont tous les deux des plafonds de DÉPENSE. C'est le
    // message qui les distingue, et c'est lui que le modèle lit.
    expect(r.appels[0]!.status).toBe('budget');
    expect(JSON.stringify(r.appels[0]!.contenu)).toContain('plafond d appels');
  });

  it('🔴 le budget déjà consommé est pris en compte', async () => {
    const { d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}')]);
    const r = await penserTrace(entree(), { ...TOUR, coutDejaMicroEur: 30_000 }, d);
    expect(r.appels[0]!.status).toBe('budget');
    expect(JSON.stringify(r.appels[0]!.contenu)).toContain('budget epuise');
  });

  it('accumule l’usage de TOUS les allers-retours', async () => {
    const { d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}'), texte('C’est noté.')]);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r.usage!.tokensIn).toBe(20);
    expect(r.usage!.tokensOut).toBe(10);
  });

  it('🔴 un appel de modèle qui ÉCHOUE APRÈS un autre rend quand même ce qui a été DÉPENSÉ', async () => {
    // Le fournisseur facture CHAQUE aller-retour. Une exception nue au deuxième emportait avec elle le coût
    // du premier : ni le compteur de session ni le solde prépayé ne bougeaient, alors que la facture, elle,
    // était bien partie. L'erreur porte donc la consommation, et l'appelant l'enregistre avant de traiter
    // l'échec.
    const { d } = deps([appelOutil('mba_poser_tag', '{"tag":"vip"}')]);
    let appels = 0;
    d.completer = async () => {
      appels += 1;
      if (appels > 1) throw new Error('502 du fournisseur');
      return appelOutil('mba_poser_tag', '{"tag":"vip"}');
    };
    const err = await penserTrace(entree(), TOUR, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TourInterrompu);
    // 0,00001 $ au taux par défaut de 1 : 10 micro-euros, le coût du SEUL aller-retour qui a abouti.
    expect((err as TourInterrompu).usage.coutMicroEur).toBe(10);
    expect((err as TourInterrompu).message).toContain('502 du fournisseur');
  });

  it('un échec AVANT toute dépense remonte tel quel', async () => {
    // La distinction est le sujet : envelopper une panne qui n'a rien coûté ferait facturer au client des
    // tours gratuits, et masquerait le type de l'erreur d'origine à ceux qui le reconnaissent.
    const { d } = deps([texte('x')]);
    d.completer = async () => { throw new AgentIntrouvable('a1'); };
    await expect(penserTrace(entree(), TOUR, d)).rejects.toBeInstanceOf(AgentIntrouvable);
  });

  it('un agent sans outil actif parle quand même', async () => {
    // Il ne peut rien faire, mais il n'y a aucune raison qu'il soit muet : le lint d'activation, lui,
    // refusera de le rendre proposable dans un scénario.
    const muet = { ...AGENT, outilsActifs: [] };
    const { cap, d } = deps([texte('Bonjour.')], undefined, muet);
    const r = await penserTrace(entree(), TOUR, d);
    expect(r.texte).toBe('Bonjour.');
    expect(cap.messages).toHaveLength(1);
  });

  it('un agent introuvable LÈVE : ce n’est pas un cas métier', async () => {
    const { d } = deps([texte('x')]);
    // Une erreur TYPÉE : c'est elle que la route reconnaît pour rendre 404 plutôt qu'un 500.
    await expect(penserTrace(entree(), TOUR, { ...d, contexte: async () => null })).rejects.toBeInstanceOf(AgentIntrouvable);
  });

  it('`creerCerveauGateway` délègue à la même boucle, et retire la trace', async () => {
    // Le tour de production n'a que faire des appels d'outils, et le contrat `AgentBrain` ne les porte pas.
    // Trois lignes, mais non testées elles laisseraient un doute sur ce que le tour recevra.
    const { d } = deps([texte('Bonjour.')]);
    const decision = await creerCerveauGateway(d).penser({ ...entree(), tour: TOUR });
    expect(decision).toMatchObject({ texte: 'Bonjour.', sortie: null });
    expect(decision).not.toHaveProperty('appels');
  });

  it('un transcript illisible ne fait pas tomber le tour', async () => {
    // `agent_sessions.transcript` est du jsonb : une ligne écrite par une version antérieure ne doit pas
    // rendre la conversation impossible.
    const { cap, d } = deps([texte('Bonjour.')]);
    await penserTrace(entree([null, 42, { role: 'agent' }, { texte: '' }, { role: 'contact', texte: 'ok' }]), TOUR, d);
    expect(cap.messages[0]).toHaveLength(2); // le système, et le seul message lisible
  });
});
