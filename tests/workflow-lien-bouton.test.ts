import { jamaisDesabonne } from './consentement';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { walk, etapeOffreUnChoix, problemeLienBouton } from '../src/workflow/engine';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * LE BOUTON DE LIEN D'UN MESSAGE RAPIDE (WhatsApp `cta_url`).
 *
 * 🔴 CE QUE CES TESTS TIENNENT, ET POURQUOI CE N'EST PAS UN DÉTAIL D'ÉCRAN. Julien a demandé qu'une réponse
 * rapide puisse pointer vers une URL. Chez Meta c'est IMPOSSIBLE : `button` (jusqu'à trois réponses rapides,
 * qui REVIENNENT dans le scénario) et `cta_url` (un bouton, qui OUVRE une page) sont deux TYPES de messages
 * interactifs différents, et un message n'a qu'un type. La contrainte n'est donc pas négociable, elle est
 * seulement déplaçable : soit le client la découvre à l'envoi, soit l'écran la lui dit quand il coche la
 * case. C'est le second qu'on a construit, et ces tests gardent l'exclusivité à chaque étage.
 */
const graphe = (data: Record<string, unknown>): WorkflowGraph => ({
  nodes: [{ id: 'n', type: 'quick_message', data, position: { x: 0, y: 0 } }],
  edges: [],
});

/** L'action produite par le premier bloc du graphe. */
function actionDuBloc(data: Record<string, unknown>) {
  return walk(graphe(data), 'n').actions[0]?.action ?? null;
}

class FakeRuns {
  async closeActiveByWaId(): Promise<string[]> { return []; }
  async start(): Promise<{ id: string }> { return { id: 'r1' }; }
  async setState(): Promise<void> {}
}

function deps(over: Partial<WorkflowExecutorDeps>): WorkflowExecutorDeps {
  return {
    estDesabonne: jamaisDesabonne,
    runs: new FakeRuns() as unknown as WorkflowExecutorDeps['runs'],
    getGraph: async () => graphe({}),
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    sendQuestion: async () => {},
    ...over,
  };
}

describe('bouton de lien : l’action', () => {
  it('le bloc transporte le libellé et l’adresse saisis', () => {
    const a = actionDuBloc({ body: 'La brochure', lienActif: true, lienTexte: 'Télécharger', lienUrl: 'https://exemple.fr/b.pdf' });
    expect(a).toMatchObject({ kind: 'sendQuickMessage', body: 'La brochure', lien: { texte: 'Télécharger', url: 'https://exemple.fr/b.pdf' } });
  });

  it('🔴 un bloc qui porte un lien part SANS ses réponses rapides, même si le graphe en porte', () => {
    // L'écran vide `quickReplies` quand la case se coche, mais un graphe enregistré AVANT cette case, ou
    // posé par l'API, peut porter les deux. Les transmettre laisserait la couche d'envoi choisir le type du
    // message Meta, c'est-à-dire déplacer la décision là où elle ne se voit plus.
    const a = actionDuBloc({ body: 'x', quickReplies: ['Oui', 'Non'], lienActif: true, lienTexte: 'Voir', lienUrl: 'https://exemple.fr' });
    expect(a).toMatchObject({ kind: 'sendQuickMessage', buttons: [] });
  });

  it('sans la case cochée, RIEN ne change : les réponses rapides restent, et aucun lien n’apparaît', () => {
    const a = actionDuBloc({ body: 'x', quickReplies: ['Oui', 'Non'], lienTexte: 'Voir', lienUrl: 'https://exemple.fr' });
    expect(a).toMatchObject({ kind: 'sendQuickMessage', buttons: [{ text: 'Oui' }, { text: 'Non' }] });
    expect(a && 'lien' in a ? a.lien : undefined).toBeUndefined();
  });

  it('🔴 un bloc à bouton de lien N’OFFRE PAS DE CHOIX, donc le parcours continue juste après', () => {
    // C'est exact et ce n'est pas un raccourci : Meta n'envoie AUCUN webhook quand le contact clique un
    // bouton `cta_url`. Traiter ce bloc comme une question gèlerait le parcours sur une réponse qui ne
    // viendra jamais, et le tag posé juste après ne serait jamais posé (le défaut vécu en prod le
    // 2026-08-15 sur un message rapide sans bouton).
    expect(etapeOffreUnChoix(actionDuBloc({ body: 'x', lienActif: true, lienTexte: 'Voir', lienUrl: 'https://exemple.fr' }))).toBe(false);
    // Le miroir, pour que le test prouve la DIFFÉRENCE et pas seulement le `false` : avec des réponses
    // rapides, le même bloc offre bien un choix.
    expect(etapeOffreUnChoix(actionDuBloc({ body: 'x', quickReplies: ['Oui'] }))).toBe(true);
  });
});

describe('bouton de lien : ce qui le rend inutilisable', () => {
  it('un libellé vide est refusé', () => {
    expect(problemeLienBouton({ texte: '  ', url: 'https://exemple.fr' })).toMatch(/libell/);
  });

  it('une adresse vide est refusée', () => {
    expect(problemeLienBouton({ texte: 'Voir', url: '' })).toMatch(/adresse/);
  });

  it('🔴 une VARIABLE dans l’adresse est refusée', () => {
    // Même règle que les liens RCS : une variable vide fabriquerait une adresse invalide, donc un message
    // refusé ENTIER par Meta, là où le contact aurait au pire reçu un lien imparfait.
    expect(problemeLienBouton({ texte: 'Voir', url: 'https://exemple.fr/{{prenom}}' })).toMatch(/variable/);
  });

  it('une adresse qui n’en est pas une est refusée', () => {
    expect(problemeLienBouton({ texte: 'Voir', url: 'exemple.fr' })).toBeTruthy();
  });

  it('🔴 un schéma autre que http(s) est refusé', () => {
    // `javascript:` et `data:` sont les deux qu'on ne veut jamais poser dans un bouton envoyé à un contact,
    // et Meta refuserait de toute façon le message. Une adresse valide au sens de `new URL` ne suffit donc
    // pas, il faut vérifier le schéma.
    expect(problemeLienBouton({ texte: 'Voir', url: 'javascript:alert(1)' })).toMatch(/http/);
    expect(problemeLienBouton({ texte: 'Voir', url: 'ftp://exemple.fr/b.pdf' })).toMatch(/http/);
  });

  it('un lien complet et bien formé ne pose aucun problème', () => {
    expect(problemeLienBouton({ texte: 'Voir', url: 'https://exemple.fr/b.pdf?a=1' })).toBeNull();
    expect(problemeLienBouton({ texte: 'Voir', url: 'http://exemple.fr' })).toBeNull();
  });
});

describe('bouton de lien : ce qui arrive à la couche d’envoi', () => {
  it('🔴 le lien traverse l’exécuteur jusqu’au SIXIÈME argument', async () => {
    // C'est le paramètre qu'une implémentation trop courte avale en silence (le piège documenté du
    // CLAUDE.md). Ici on prouve qu'il PART ; le test de câblage plus bas prouve qu'il ARRIVE.
    const sendQuickMessage = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(deps({ sendQuickMessage }));
    await ex.startInWindow('t1', 'wf1', graphe({ body: 'La brochure', lienActif: true, lienTexte: 'Voir', lienUrl: 'https://exemple.fr' }), { waId: '336', contactId: null });
    expect(sendQuickMessage).toHaveBeenCalledWith('t1', '336', 'La brochure', [], undefined, { texte: 'Voir', url: 'https://exemple.fr' });
  });

  it('⚠️ les variables du corps sont résolues comme sur n’importe quel message rapide', async () => {
    const sendQuickMessage = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(deps({ sendQuickMessage, varsFor: async () => ({ prenom: 'Camille' }) }));
    await ex.startInWindow('t1', 'wf1', graphe({ body: 'Bonjour {{prenom}}', lienActif: true, lienTexte: 'Voir', lienUrl: 'https://exemple.fr' }), { waId: '336', contactId: null });
    expect(sendQuickMessage).toHaveBeenCalledWith('t1', '336', 'Bonjour Camille', [], undefined, expect.anything());
  });
});

/**
 * LE CÂBLAGE RÉEL, lu dans la source.
 *
 * 🔴 POURQUOI PAS UN TEST ORDINAIRE : un test unitaire monte un FAUX `sendQuickMessage`, et le faux bouge
 * avec le code. Surtout, `lien` est le SIXIÈME paramètre d'un contrat qui les déclare tous facultatifs à
 * partir du cinquième : une flèche qui n'en déclare que cinq COMPILE, et le lien disparaît sans un mot.
 * C'est le piège déjà vécu sur le plafond de campagne (`tests/campagne-cablage.test.ts`) et sur la catégorie
 * de template (`tests/workflow-cablage-categorie.test.ts`). Ce qui traverse un câblage ne se vérifie pas au
 * type, il se vérifie en le regardant.
 */
const source = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8');
/** Sans les commentaires : sinon une explication qui CITE le bon code ferait passer un câblage fautif. */
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('câblage du bouton de lien (scénario)', () => {
  it('🔴 le câblage DÉCLARE le sixième paramètre', () => {
    expect(sansCommentaires, 'sendQuickMessage doit recevoir `lien` en sixième paramètre')
      .toMatch(/sendQuickMessage:\s*async\s*\(tenant,\s*waId,\s*body,\s*buttons,\s*mediaUrl,\s*lien\)/);
  });

  it('🔴 un bloc à lien part en `cta_url`, jamais en message à boutons', () => {
    expect(sansCommentaires, 'le câblage doit appeler sendCtaUrl avec le lien')
      .toMatch(/client\.sendCtaUrl\(waId,\s*body,\s*lien,\s*mediaId\)/);
    // Et la branche à boutons reste ATTEIGNABLE : le lien ne doit pas l'avoir remplacée, sinon les blocs
    // à réponses rapides, qui sont le cas courant, partiraient en texte nu.
    expect(sansCommentaires).toMatch(/client\.sendInteractive\(waId,\s*body,\s*buttons,\s*mediaId\)/);
  });

  it('🔴 un lien inutilisable REFUSE l’envoi, il ne laisse pas partir un message nu', () => {
    // Le client a coché la case : lui livrer le texte seul parce que l'adresse manque, c'est exactement le
    // silence que ce bloc ferme déjà pour le visuel non préparable.
    expect(sansCommentaires, 'le câblage doit consulter problemeLienBouton et rendre la raison')
      .toMatch(/problemeLienBouton\(lien\)[\s\S]{0,120}return problemeLien;/);
  });
});
