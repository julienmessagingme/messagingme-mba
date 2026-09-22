import { describe, it, expect } from 'vitest';
import {
  HANDLERS_MAISON_MBA, cibleMaisonSchema, lireCibleMaison, typeDeLaCible, variablesPourMeta, lireValeurChamp,
  REPONSE_MAISON, RISQUE_MAISON, blocSeul, blocsProposables, type CibleChamp,
} from '../src/mba/outils-maison';
import type { WorkflowGraph } from '../src/workflow/graph';
import { OUTILS_MAISON } from '../src/agent/outils-maison';

/**
 * Le catalogue des gestes de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : que la cible relue en base soit VALIDÉE (le `binding` est un jsonb opaque), et
 * que ces handlers ne croisent JAMAIS ceux des agents IA : un outil de l'agent de Meta qui atteindrait un agent
 * IA tomberait alors sur un handler inconnu, donc un refus, au lieu d'être joué avec d'autres paramètres.
 */
describe('la cible d’un outil maison', () => {
  it('lit une étiquette fixée et un champ fixé', () => {
    expect(lireCibleMaison({ handler: 'tag_fixe', tag: 'vip' })).toEqual({ handler: 'tag_fixe', tag: 'vip' });
    expect(lireCibleMaison({ handler: 'champ_fixe', champ: 'ville', valeurs: [] }))
      .toEqual({ handler: 'champ_fixe', champ: 'ville', valeurs: [] });
  });

  it('🔴 refuse un handler des agents IA, une clé en trop, une étiquette vide', () => {
    expect(lireCibleMaison({ handler: 'poser_tag', tag: 'vip' })).toBeNull();
    expect(lireCibleMaison({ handler: 'tag_fixe', tag: 'vip', agentId: 'x' })).toBeNull();
    expect(lireCibleMaison({ handler: 'tag_fixe', tag: '  ' })).toBeNull();
    expect(lireCibleMaison(null)).toBeNull();
  });

  it('dit le type d’écran de chaque cible', () => {
    expect(typeDeLaCible({ handler: 'tag_fixe', tag: 'vip' })).toBe('tag');
    expect(typeDeLaCible({ handler: 'champ_fixe', champ: 'ville', valeurs: [] })).toBe('champ');
  });
});

describe('ce que Meta reçoit dans le corps de l’outil', () => {
  it('rien pour une étiquette : l’agent ne fournit rien', () => {
    expect(variablesPourMeta({ handler: 'tag_fixe', tag: 'vip' })).toEqual([]);
  });

  it('🔴 une seule variable pour un champ, requise, avec les valeurs permises quand il y en a', () => {
    const [v] = variablesPourMeta({ handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris', 'Lyon'] });
    expect(v).toMatchObject({ nom: 'valeur', type: 'string', origine: { type: 'modele' }, requis: true, enum: ['Paris', 'Lyon'] });
    const [libre] = variablesPourMeta({ handler: 'champ_fixe', champ: 'ville', valeurs: [] });
    expect(libre).not.toHaveProperty('enum');
  });
});

describe('la valeur que l’agent de Meta envoie pour un champ', () => {
  const ville: CibleChamp = { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris', 'Lyon'] };

  it('accepte une valeur permise, sans ses blancs', () => {
    expect(lireValeurChamp(ville, { valeur: ' Paris ' })).toEqual({ ok: true, valeur: 'Paris' });
  });

  it('🔴 refuse une valeur hors liste, en nommant la liste', () => {
    const r = lireValeurChamp(ville, { valeur: 'Marseille' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erreur).toContain('Paris, Lyon');
  });

  it('refuse une valeur absente ou vide', () => {
    expect(lireValeurChamp(ville, {}).ok).toBe(false);
    expect(lireValeurChamp(ville, { valeur: '' }).ok).toBe(false);
  });
});

describe('le catalogue est complet et fermé', () => {
  it('🔴 chaque handler a son schéma, sa réponse et son risque', () => {
    const duSchema = cibleMaisonSchema.options.map((o) => o.shape.handler.value).sort();
    expect(duSchema).toEqual([...HANDLERS_MAISON_MBA].sort());
    for (const h of HANDLERS_MAISON_MBA) {
      expect(REPONSE_MAISON[h].length).toBeGreaterThan(10);
      expect(RISQUE_MAISON[h]).toBeDefined();
    }
  });

  it('🔴 aucun handler de l’agent de Meta n’existe chez les agents IA', () => {
    const agentsIa = new Set(OUTILS_MAISON.map((o) => o.handler));
    expect(HANDLERS_MAISON_MBA.filter((h) => agentsIa.has(h))).toEqual([]);
  });

  it('🔴 la réponse d’un tag demande de ne citer aucun nom technique au client', () => {
    expect(REPONSE_MAISON.tag_fixe).toContain('sans citer de nom technique');
  });
});

const CODE = (lettre: string) => `nod_abc_${lettre.repeat(26)}`;
const WF = '11111111-1111-4111-8111-111111111111';
const noeud = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];
const g = (nodes: WorkflowGraph['nodes'], edges: Array<[string, string]> = []): WorkflowGraph =>
  ({ nodes, edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })) });

describe('la cible d’un bloc et d’un scénario', () => {
  it('lit un bloc fixé et un scénario fixé, et dit leur type', () => {
    const bloc = { handler: 'bloc_fixe', workflowId: WF, code: CODE('A') } as const;
    expect(lireCibleMaison(bloc)).toEqual(bloc);
    expect(typeDeLaCible(bloc)).toBe('bloc');
    expect(typeDeLaCible({ handler: 'scenario_fixe', workflowId: WF })).toBe('scenario');
  });

  it('🔴 refuse un code qui n’est pas un code de bloc, et un scénario qui n’est pas un identifiant', () => {
    expect(lireCibleMaison({ handler: 'bloc_fixe', workflowId: WF, code: 'n1' })).toBeNull();
    expect(lireCibleMaison({ handler: 'scenario_fixe', workflowId: 'accueil' })).toBeNull();
  });

  it('🔴 un bloc et un scénario sont IRRÉVERSIBLES : un message parti ne se rappelle pas', () => {
    expect(RISQUE_MAISON.bloc_fixe).toBe('irreversible');
    expect(RISQUE_MAISON.scenario_fixe).toBe('irreversible');
  });

  it('🔴 la réponse dit « c’est fait » et « ne rappelle pas cet outil » : sinon l’agent de Meta boucle', () => {
    // Essai réel du 2026-09-22 : « Engage Me déroule maintenant un parcours… N'écris rien » a fait rappeler
    // l'outil sept fois dans le même tour. La réponse du tag, qui dit « c'est fait », avait marché du premier coup.
    for (const r of [REPONSE_MAISON.bloc_fixe, REPONSE_MAISON.scenario_fixe]) {
      expect(r.startsWith('C’est fait')).toBe(true);
      expect(r).toContain('Ne rappelle pas cet outil');
    }
    // Le scénario garde sa consigne de silence : la conversation revient à l'agent de Meta à la fin du parcours.
    expect(REPONSE_MAISON.scenario_fixe).toContain('n’écris rien');
  });

  it('rien à remplir pour l’agent de Meta : le bloc et le scénario sont fixés', () => {
    expect(variablesPourMeta({ handler: 'bloc_fixe', workflowId: WF, code: CODE('A') })).toEqual([]);
    expect(variablesPourMeta({ handler: 'scenario_fixe', workflowId: WF })).toEqual([]);
  });
});

describe('envoyer un bloc SEUL', () => {
  const texte = noeud('n1', 'quick_message', { code: CODE('A'), name: 'Brochure', body: 'Voici la brochure', quickReplies: [] });
  const suite = noeud('n2', 'quick_message', { code: CODE('B'), body: 'Et ceci', quickReplies: [] });
  const question = noeud('n3', 'quick_message', { code: CODE('C'), body: 'Oui ou non ?', quickReplies: ['Oui', 'Non'] });

  it('🔴 le bloc part SANS ce qui le suit dans le scénario', () => {
    const r = blocSeul(g([texte, suite], [['n1', 'n2']]), CODE('A'));
    expect(r).toEqual({ ok: true, noeudId: 'n1', graphe: { nodes: [texte], edges: [] }, modele: false });
  });

  it('🔴 un bloc qui attend une réponse est refusé, en renvoyant vers « Lancer un scénario »', () => {
    expect(blocSeul(g([question]), CODE('C'))).toEqual({ ok: false, raison: expect.stringContaining('Lancer un scénario') });
  });

  it('un code inconnu, mal formé ou vide est refusé', () => {
    expect(blocSeul(g([texte]), CODE('D')).ok).toBe(false);
    expect(blocSeul(g([texte]), 'n1').ok).toBe(false);
    expect(blocSeul(g([texte]), '').ok).toBe(false);
  });

  it('🔴 un bloc qui n’envoie rien (un tag, un message vide) est refusé', () => {
    expect(blocSeul(g([noeud('n4', 'tag', { code: CODE('D'), tag: 'x' })]), CODE('D'))).toEqual({ ok: false, raison: 'ce bloc n’envoie aucun message' });
    expect(blocSeul(g([noeud('n5', 'quick_message', { code: CODE('E'), body: '', quickReplies: [] })]), CODE('E')).ok).toBe(false);
  });

  it('🔴 un modèle sans bouton part aussi hors de la fenêtre de 24 h ; un message rapide, non', () => {
    const modele = noeud('n6', 'template', { code: CODE('F'), templateName: 'brochure', language: 'fr', templateButtons: [] });
    expect(blocSeul(g([modele]), CODE('F'))).toMatchObject({ ok: true, modele: true });
    expect(blocSeul(g([texte]), CODE('A'))).toMatchObject({ ok: true, modele: false });
  });

  it('un modèle À BOUTONS attend une réponse : refusé', () => {
    const aBoutons = noeud('n7', 'template', {
      code: CODE('G'), templateName: 'rdv', language: 'fr', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }],
    });
    expect(blocSeul(g([aBoutons]), CODE('G')).ok).toBe(false);
  });

  it('liste les blocs proposables, les refusés avec leur raison, et nomme le bloc par son nom ou son texte', () => {
    const l = blocsProposables([{ id: WF, name: 'Accueil', graph: g([texte, question, noeud('n8', 'tag', { tag: 'sans code' })]) }]);
    expect(l.map((b) => [b.code, b.nom, b.envoyable])).toEqual([[CODE('A'), 'Brochure', true], [CODE('C'), 'Oui ou non ?', false]]);
    expect(l[1]!.raison).toContain('Lancer un scénario');
    expect(l[0]).toMatchObject({ workflowId: WF, scenario: 'Accueil', type: 'quick_message', raison: null });
  });
});
