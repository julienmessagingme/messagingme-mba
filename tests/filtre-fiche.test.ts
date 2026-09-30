import { describe, it, expect } from 'vitest';
import {
  CLES_FILTRABLES, OPERATEURS_FICHE_SEULS, clauseFiltreFiche, evaluerFiltreFiche, lireFiltreFiche, operateursDuChamp,
  texteDeLaCopie,
} from '../src/crm/filtre-fiche';
import { CHAMPS_FICHE_FIXES, champFiche } from '../src/crm/champs-fiche';
import { OPERATEURS_FICHE_SEULS as OPERATEURS_CONSOLE } from '../web/lib/contact-filters';
import type { AnalyseDeFiche } from '../src/analysis/fiche';

/**
 * Filtrer sur la dernière analyse d'une fiche (lot 2b). Trois lecteurs partagent ce module : la liste des contacts
 * et le ciblage d'une campagne (SQL), le bloc Condition (en mémoire), puis le déclencheur du lot 3. La parité avec
 * une vraie base est tenue par `tests/integration/filtre-fiche.integration.test.ts`.
 */

const MAINTENANT = new Date('2026-10-01T12:00:00Z');
const copie = (o: Partial<AnalyseDeFiche> = {}): AnalyseDeFiche => ({
  intention: 'reclamation', sentiment: 'negatif', satisfaction: 2, urgence: 8, resolue: false, sujet: 'colis abîmé',
  traiteePar: 'humain', action: 'rappeler', analyseLe: new Date('2026-09-28T12:00:00Z'),
  fenetreFin: new Date('2026-09-28T11:59:00Z'), conversationId: null, ...o,
});

/** Un `add` comme celui de `buildContactWhere` : pousse le paramètre, rend son placeholder. */
function sql(cle: Parameters<typeof clauseFiltreFiche>[0], op: string, valeur: string): { clause: string; params: unknown[] } {
  const params: unknown[] = ['t1'];
  const clause = clauseFiltreFiche(cle, op, valeur, (v) => { params.push(v); return `$${params.length}`; });
  return { clause, params };
}

describe('les champs filtrables et leurs opérateurs', () => {
  it('huit champs d’analyse, et ni le sujet, ni le risque, ni les champs de base', () => {
    expect([...CLES_FILTRABLES].sort()).toEqual([
      'analyse_action', 'analyse_intention', 'analyse_le', 'analyse_resolue', 'analyse_satisfaction', 'analyse_sentiment',
      'analyse_traitee_par', 'analyse_urgence',
    ]);
    for (const c of CHAMPS_FICHE_FIXES) {
      if (!(CLES_FILTRABLES as readonly string[]).includes(c.cle)) expect(operateursDuChamp(c), c.cle).toEqual([]);
    }
  });

  it('les opérateurs se déduisent du type (décision 12)', () => {
    expect(operateursDuChamp(champFiche('analyse_sentiment')!)).toEqual(['in', 'empty', 'not_empty']);
    expect(operateursDuChamp(champFiche('analyse_action')!)).toEqual(['in', 'empty', 'not_empty']);
    expect(operateursDuChamp(champFiche('analyse_urgence')!)).toEqual(['gte', 'lte', 'empty', 'not_empty']);
    expect(operateursDuChamp(champFiche('analyse_resolue')!)).toEqual(['is_true', 'is_false', 'empty', 'not_empty']);
    expect(operateursDuChamp(champFiche('analyse_le')!)).toEqual(['newer_than_days', 'empty', 'not_empty']);
  });

  it('la console et le serveur connaissent les mêmes opérateurs de colonne', () => {
    expect([...OPERATEURS_CONSOLE]).toEqual([...OPERATEURS_FICHE_SEULS]);
  });
});

describe('lireFiltreFiche : un filtre d’analyse ne se devine jamais', () => {
  it('ramène la valeur à sa forme canonique', () => {
    expect(lireFiltreFiche('analyse_sentiment', 'in', ' negatif , neutre,negatif ')).toEqual(
      { ok: true, filtre: { cle: 'analyse_sentiment', op: 'in', valeur: 'negatif,neutre' } });
    expect(lireFiltreFiche('analyse_urgence', 'gte', '07')).toEqual({ ok: true, filtre: { cle: 'analyse_urgence', op: 'gte', valeur: '7' } });
    expect(lireFiltreFiche('analyse_le', 'newer_than_days', '30')).toEqual({ ok: true, filtre: { cle: 'analyse_le', op: 'newer_than_days', valeur: '30' } });
    expect(lireFiltreFiche('analyse_resolue', 'is_true', 'n’importe quoi')).toEqual({ ok: true, filtre: { cle: 'analyse_resolue', op: 'is_true', valeur: '' } });
  });

  it('🔴 refuse, avec une raison, tout ce qui élargirait ou déformerait l’audience', () => {
    const refus: Array<[Parameters<typeof lireFiltreFiche>[0], unknown, unknown]> = [
      ['analyse_urgence', 'eq', '7'], // « au moins 7 » ramené à « égal à 7 » serait une autre audience
      ['analyse_urgence', 'in', '7'],
      ['analyse_urgence', 'gte', '11'],
      ['analyse_urgence', 'gte', '-1'],
      ['analyse_urgence', 'gte', '7.5'],
      ['analyse_urgence', 'gte', ''],
      ['analyse_sentiment', 'in', ''],
      ['analyse_sentiment', 'in', ' , '],
      ['analyse_sentiment', 'in', 'negatif,furieux'],
      ['analyse_sentiment', 'gte', '3'],
      ['analyse_le', 'newer_than_days', '0'],
      ['analyse_le', 'newer_than_days', '3651'],
      ['analyse_resolue', 'contains', 'oui'],
      ['analyse_intention', undefined, 'achat'],
      ['analyse_intention', 'in', 42],
    ];
    for (const [cle, op, valeur] of refus) {
      const lu = lireFiltreFiche(cle, op, valeur);
      expect(lu.ok, `${cle} ${String(op)} ${String(valeur)}`).toBe(false);
      if (!lu.ok) expect(lu.raison).toContain(champFiche(cle)!.libelle[0]);
    }
  });
});

describe('clauseFiltreFiche : le SQL exact, sur la colonne de la carte', () => {
  it('chaque opérateur, paramétré', () => {
    expect(sql('analyse_sentiment', 'in', 'negatif,neutre')).toEqual({ clause: 'analyse_sentiment = any($2::text[])', params: ['t1', ['negatif', 'neutre']] });
    expect(sql('analyse_urgence', 'gte', '7')).toEqual({ clause: 'analyse_urgence >= $2::int', params: ['t1', 7] });
    expect(sql('analyse_satisfaction', 'lte', '0')).toEqual({ clause: 'analyse_satisfaction <= $2::int', params: ['t1', 0] });
    expect(sql('analyse_resolue', 'is_true', '')).toEqual({ clause: 'analyse_resolue is true', params: ['t1'] });
    expect(sql('analyse_resolue', 'is_false', '')).toEqual({ clause: 'analyse_resolue is false', params: ['t1'] });
    expect(sql('analyse_le', 'newer_than_days', '30')).toEqual({ clause: `analyse_le > now() - ($2::int * interval '1 day')`, params: ['t1', 30] });
    expect(sql('analyse_action', 'empty', '')).toEqual({ clause: 'analyse_action is null', params: ['t1'] });
    expect(sql('analyse_action', 'not_empty', '')).toEqual({ clause: 'analyse_action is not null', params: ['t1'] });
  });

  it('🔴 un filtre qui ne se relit pas rend « personne », jamais l’absence de clause, et ne pousse aucun paramètre', () => {
    expect(sql('analyse_urgence', 'gte', 'beaucoup')).toEqual({ clause: 'false', params: ['t1'] });
    expect(sql('analyse_sentiment', 'eq', 'negatif')).toEqual({ clause: 'false', params: ['t1'] });
  });
});

describe('evaluerFiltreFiche : le miroir en mémoire de la clause SQL', () => {
  it('🔴 une note de 0 est une mesure : « au plus 0 » et « au moins 0 » la retiennent', () => {
    expect(evaluerFiltreFiche('analyse_satisfaction', 'lte', '0', copie({ satisfaction: 0 }), MAINTENANT)).toBe(true);
    expect(evaluerFiltreFiche('analyse_satisfaction', 'gte', '0', copie({ satisfaction: 0 }), MAINTENANT)).toBe(true);
    expect(evaluerFiltreFiche('analyse_satisfaction', 'empty', '', copie({ satisfaction: 0 }), MAINTENANT)).toBe(false);
  });

  it('🔴 `null` ne satisfait aucune comparaison, et seul « vide » le retient', () => {
    const sansMesure = copie({ satisfaction: null });
    expect(evaluerFiltreFiche('analyse_satisfaction', 'gte', '0', sansMesure, MAINTENANT)).toBe(false);
    expect(evaluerFiltreFiche('analyse_satisfaction', 'lte', '10', sansMesure, MAINTENANT)).toBe(false);
    expect(evaluerFiltreFiche('analyse_satisfaction', 'empty', '', sansMesure, MAINTENANT)).toBe(true);
    // Une fiche jamais analysée : aucune valeur, sur aucun champ.
    for (const [cle, op, v] of [['analyse_sentiment', 'in', 'negatif'], ['analyse_resolue', 'is_false', ''], ['analyse_le', 'newer_than_days', '3650'], ['analyse_urgence', 'lte', '10']] as const) {
      expect(evaluerFiltreFiche(cle, op, v, null, MAINTENANT), cle).toBe(false);
      expect(evaluerFiltreFiche(cle, 'empty', '', null, MAINTENANT), cle).toBe(true);
    }
  });

  it('🔴 « non résolue » ne retient pas une fiche jamais analysée : `false` n’est pas `null`', () => {
    expect(evaluerFiltreFiche('analyse_resolue', 'is_false', '', copie({ resolue: false }), MAINTENANT)).toBe(true);
    expect(evaluerFiltreFiche('analyse_resolue', 'is_true', '', copie({ resolue: false }), MAINTENANT)).toBe(false);
    expect(evaluerFiltreFiche('analyse_resolue', 'is_false', '', null, MAINTENANT)).toBe(false);
  });

  it('un ou plusieurs choix ; les seuils sont inclusifs', () => {
    expect(evaluerFiltreFiche('analyse_sentiment', 'in', 'neutre,negatif', copie(), MAINTENANT)).toBe(true);
    expect(evaluerFiltreFiche('analyse_sentiment', 'in', 'positif', copie(), MAINTENANT)).toBe(false);
    expect(evaluerFiltreFiche('analyse_urgence', 'gte', '8', copie({ urgence: 8 }), MAINTENANT)).toBe(true);
    expect(evaluerFiltreFiche('analyse_urgence', 'gte', '9', copie({ urgence: 8 }), MAINTENANT)).toBe(false);
    expect(evaluerFiltreFiche('analyse_urgence', 'lte', '8', copie({ urgence: 8 }), MAINTENANT)).toBe(true);
  });

  it('« analysée depuis moins de N jours » : strictement plus récente que maintenant moins N jours', () => {
    const il_y_a = (jours: number) => copie({ analyseLe: new Date(MAINTENANT.getTime() - jours * 86_400_000) });
    expect(evaluerFiltreFiche('analyse_le', 'newer_than_days', '3', il_y_a(2.9), MAINTENANT)).toBe(true);
    expect(evaluerFiltreFiche('analyse_le', 'newer_than_days', '3', il_y_a(3), MAINTENANT)).toBe(false);
  });

  it('un filtre invalide rend `false`, comme sa clause SQL', () => {
    expect(evaluerFiltreFiche('analyse_sentiment', 'eq', 'negatif', copie(), MAINTENANT)).toBe(false);
    expect(evaluerFiltreFiche('analyse_urgence', 'gte', '', copie(), MAINTENANT)).toBe(false);
  });
});

describe('texteDeLaCopie', () => {
  it('les valeurs en texte, la date en ISO, rien sans copie', () => {
    expect(texteDeLaCopie('analyse_urgence', copie({ urgence: 0 }))).toBe('0');
    expect(texteDeLaCopie('analyse_resolue', copie({ resolue: false }))).toBe('false');
    expect(texteDeLaCopie('analyse_le', copie())).toBe('2026-09-28T12:00:00.000Z');
    expect(texteDeLaCopie('analyse_sujet', copie())).toBe('colis abîmé');
    expect(texteDeLaCopie('analyse_urgence', copie({ urgence: null }))).toBeNull();
    expect(texteDeLaCopie('analyse_sentiment', null)).toBeNull();
    expect(texteDeLaCopie('ville', copie())).toBeNull();
  });
});
