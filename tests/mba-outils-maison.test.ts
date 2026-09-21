import { describe, it, expect } from 'vitest';
import {
  HANDLERS_MAISON_MBA, cibleMaisonSchema, lireCibleMaison, typeDeLaCible, variablesPourMeta, lireValeurChamp,
  REPONSE_MAISON, RISQUE_MAISON, type CibleChamp,
} from '../src/mba/outils-maison';
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
