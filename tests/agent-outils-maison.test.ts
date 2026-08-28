import { describe, it, expect } from 'vitest';
import { OUTILS_MAISON, outilExpose, outilMaison, outilsExposes, paramsInitiaux } from '../src/agent/outils-maison';
import { HANDLERS_MAISON } from '../src/agent/resolvers/mba';
import type { OutilDefini } from '../src/agent/catalog';

/**
 * Le catalogue des outils maison, et ce que le modèle voit d'un outil.
 *
 * 🔴 LE TEST QUI COMPTE ICI est celui de l'énumération de `terminer`. C'est le défaut relevé par la revue de
 * la tâche 18 : les règles d'arrêt vivent sur la FICHE (c'est de là que le builder tire les handles du bloc),
 * et les recopier dans `agent_tools.params` créerait une seconde vérité. Elle divergerait au premier ajout de
 * règle, et le modèle terminerait alors par une sortie que le bloc ne dessine pas, donc par une conversation
 * qui remonte en inbox sans que personne comprenne pourquoi.
 */

const outil = (params: unknown, handler = 'terminer'): OutilDefini => ({
  id: 'o1', tenantId: 't1', agentId: 'a1', origin: 'mba', name: 'mba_terminer',
  description: 'Termine.', params, binding: { handler }, sourceId: null, outputPaths: [], risk: 'read',
  timeoutMs: 8000, maxBytes: 16384, autonome: false,
});

describe('catalogue des outils maison', () => {
  it('🔴 le catalogue et les handlers du résolveur se correspondent EXACTEMENT', () => {
    // Un handler sans entrée au catalogue est inatteignable depuis la console ; une entrée sans handler
    // produit un outil actif, exposé au modèle, qui refuse à chaque appel.
    expect([...OUTILS_MAISON.map((o) => o.handler)].sort()).toEqual([...HANDLERS_MAISON].sort());
  });

  it('chaque outil porte des mots, un risque, et un nom exposé valide', () => {
    for (const o of OUTILS_MAISON) {
      // Le charset est celui du `check` de la migration 0086, commun à OpenAI et Gemini.
      expect(o.nomDefaut, o.handler).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(o.titre.fr.length, o.handler).toBeGreaterThan(0);
      expect(o.titre.en.length, o.handler).toBeGreaterThan(0);
      expect(o.description.fr.length, o.handler).toBeGreaterThan(10);
      expect(o.description.en.length, o.handler).toBeGreaterThan(10);
      expect(['read', 'write', 'irreversible']).toContain(o.risk);
    }
  });

  it('🔴 envoyer un bloc est IRRÉVERSIBLE, donc soumis à l’autonomie', () => {
    // Un message parti chez un contact ne se rappelle pas, et il est facturé. Le tronc commun refuse alors
    // l'appel tant que le client n'a pas coché l'autonomie sur cet outil : c'est ce qui rend ce drapeau
    // vivant dès maintenant, au lieu d'un réglage en sommeil jusqu'aux familles HTTP et MCP.
    expect(outilMaison('envoyer_bloc')?.risk).toBe('irreversible');
  });

  it('un handler inventé n’existe pas', () => {
    expect(outilMaison('rm_rf')).toBeUndefined();
    expect(outilMaison('constructor')).toBeUndefined();
    expect(outilMaison('toString')).toBeUndefined();
  });
});

describe('paramsInitiaux', () => {
  it('🔴 n’écrit JAMAIS l’énumération qui se dérive de la fiche', () => {
    const p = paramsInitiaux(outilMaison('terminer')!);
    expect(p).toHaveLength(1);
    expect(p[0]!.name).toBe('sortie');
    expect(p[0]!.enum).toBeUndefined();
  });

  it('ne laisse pas fuir les champs de catalogue dans ce qui est stocké', () => {
    for (const modele of OUTILS_MAISON) {
      for (const p of paramsInitiaux(modele)) {
        expect(p, modele.handler).not.toHaveProperty('edition');
        expect(p, modele.handler).not.toHaveProperty('aideEnum');
        expect(p.source, modele.handler).toBe('modele');
      }
    }
  });
});

describe('outilsExposes', () => {
  it('🔴 l’énumération de « sortie » vient de la FICHE', () => {
    const [expose] = outilsExposes([outil(paramsInitiaux(outilMaison('terminer')!))], [
      { code: 'besoin_cerne', label: 'Besoin cerné' },
      { code: 'rdv_pris', label: 'Rendez-vous pris' },
    ]);
    expect(expose!.parameters.properties.sortie?.enum).toEqual(['besoin_cerne', 'rdv_pris']);
  });

  it('🔴 une énumération écrite en base est IGNORÉE au profit de la fiche', () => {
    // Le cas qui prouve la règle : si quelqu'un (une migration, une IA de construction, une main) écrit des
    // codes dans `params`, ils ne doivent pas atteindre le modèle. La fiche fait autorité, seule.
    const [expose] = outilsExposes(
      [outil([{ name: 'sortie', type: 'string', source: 'modele', required: true, enum: ['perime', 'faux'] }])],
      [{ code: 'besoin_cerne', label: 'Besoin cerné' }],
    );
    expect(expose!.parameters.properties.sortie?.enum).toEqual(['besoin_cerne']);
  });

  it('🔴 une fiche SANS règle d’arrêt RETIRE l’outil, elle ne l’offre pas sans énumération', () => {
    // Offert sans énumération, `terminer` accepterait n'importe quelle chaîne : le modèle en inventerait une,
    // le bloc n'aurait pas ce handle, et la conversation remonterait en inbox sans explication. Ne rien
    // offrir est plus honnête, et c'est déjà ce que l'écran des règles d'arrêt annonce.
    const t = outil(paramsInitiaux(outilMaison('terminer')!));
    expect(outilExpose(t, [])).toBeNull();
    expect(outilsExposes([t], [])).toEqual([]);
    // Et l'outil revient dès qu'une règle existe : le retrait suit la fiche, il ne s'installe pas.
    expect(outilsExposes([t], [{ code: 'fini', label: 'Fini' }])).toHaveLength(1);
  });

  it('une liste vide REMPLIE PAR LE CLIENT ne retire rien : vide y veut dire « aucune restriction »', () => {
    const tag = outil([{ name: 'tag', type: 'string', source: 'modele', required: true }], 'poser_tag');
    const [expose] = outilsExposes([tag], []);
    expect(expose!.name).toBe('mba_terminer');
    expect(expose!.parameters.properties.tag?.enum).toBeUndefined();
  });

  it('les autres outils ne sont pas touchés par la dérivation', () => {
    const tag = outil([{ name: 'tag', type: 'string', source: 'modele', required: true, enum: ['vip'] }], 'poser_tag');
    const [expose] = outilsExposes([tag], [{ code: 'besoin_cerne', label: 'B' }]);
    expect(expose!.parameters.properties.tag?.enum).toEqual(['vip']);
  });

  it('un outil dont le handler n’est plus au catalogue expose ses params tels quels', () => {
    // Cas d'une ligne écrite par une version antérieure : elle ne doit pas faire tomber la construction du
    // schéma, sinon le tour entier échoue à cause d'une seule ligne périmée.
    const orphelin = outil([{ name: 'x', type: 'string', source: 'modele' }], 'disparu');
    const [expose] = outilsExposes([orphelin], []);
    expect(expose!.parameters.properties.x).toEqual({ type: 'string' });
  });

  it('🔴 un paramètre non rempli par le modèle reste invisible, dérivation ou pas', () => {
    // La garde de la tâche 15 tient toujours après passage par la dérivation : `contact` et `fixe` ne sont
    // jamais exposés, sans quoi un connecteur deviendrait un IDOR.
    const avecContact = outil([
      { name: 'sortie', type: 'string', source: 'modele', required: true },
      { name: 'wa_id', type: 'string', source: 'contact', contactPath: 'wa_id' },
    ]);
    const [expose] = outilsExposes([avecContact], [{ code: 'fini', label: 'Fini' }]);
    expect(Object.keys(expose!.parameters.properties)).toEqual(['sortie']);
  });
});
