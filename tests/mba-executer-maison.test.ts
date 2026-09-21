import { describe, it, expect } from 'vitest';
import { CHAMP_DISPARU, executerOutilMaison, type DepsMaison } from '../src/mba/executer-maison';

/**
 * Exécuter un geste de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : la cible FIXÉE par l'administrateur. Le corps envoyé par Meta ne choisit ni
 * l'étiquette ni le champ, quoi qu'il contienne ; il ne fournit que la valeur d'un champ.
 */
function faux(champs: string[] = ['ville']) {
  const gestes: string[] = [];
  const deps: DepsMaison = {
    poserTag: async (t, w, tag) => { gestes.push(`tag ${t} ${w} ${tag}`); },
    ecrireChamp: async (t, w, champ, valeur) => { gestes.push(`champ ${t} ${w} ${champ}=${valeur}`); },
    champExiste: async (_t, champ) => champs.includes(champ),
  };
  return { deps, gestes };
}

describe('exécuter un geste de l’agent de Meta', () => {
  it('🔴 pose l’étiquette FIXÉE, pour le contact de l’en-tête', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: '33612345678', cible: { handler: 'tag_fixe', tag: 'vip' }, corps: { tag: 'autre' },
    });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('fiche du client') });
    // Le corps ne choisit PAS l'étiquette : c'est tout l'arbitrage « fixé d'avance ».
    expect(f.gestes).toEqual(['tag t1 33612345678 vip']);
  });

  it('écrit la valeur fournie dans le champ FIXÉ', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: [] }, corps: { valeur: 'Lyon', champ: 'autre' },
    });
    expect(r.ok).toBe(true);
    expect(f.gestes).toEqual(['champ t1 w ville=Lyon']);
  });

  it('🔴 un champ SUPPRIMÉ du mini-CRM n’est pas écrit : l’agent de Meta lit pourquoi', async () => {
    // L'onglet Outils affiche alors « ce champ n'existe plus » : écrire quand même rangerait la valeur sous une
    // clé qu'aucun écran ne montre, et la ligne rouge mentirait.
    const f = faux([]);
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: [] }, corps: { valeur: 'Lyon' },
    });
    expect(r).toEqual({ ok: false, erreur: CHAMP_DISPARU });
    expect(f.gestes).toEqual([]);
  });

  it('🔴 une valeur refusée n’écrit RIEN', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris'] }, corps: { valeur: 'Lyon' },
    });
    expect(r.ok).toBe(false);
    expect(f.gestes).toEqual([]);
  });
});
