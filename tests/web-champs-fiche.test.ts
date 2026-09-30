import { describe, it, expect } from 'vitest';
import { champsFiltrablesDe, estFiltreAnalyse, filtreAnalyseParDefaut } from '../web/lib/champs-fiche';
import { lireFiltreFiche, estCleFiltrable, operateursDuChamp } from '../src/crm/filtre-fiche';
import { CHAMPS_FICHE_FIXES } from '../src/crm/champs-fiche';

/**
 * La lecture, côté console, de `GET /champs-fiche` (lot 2b « Tout sur la fiche »). 🔴 Elle ne propose jamais un
 * filtre à moitié compris, et une réponse d'API plus ancienne ou tronquée ne fait rien tomber : pas de filtre
 * d'analyse, c'est tout.
 */
const reponseDuServeur = () => ({
  champs: CHAMPS_FICHE_FIXES.map((c) => ({ cle: c.cle, libelle: c.libelle, provenance: c.provenance, type: c.type, operateurs: operateursDuChamp(c) })),
});

describe('champsFiltrablesDe', () => {
  it('garde les champs filtrables de la vraie réponse du serveur, et eux seuls', () => {
    const champs = champsFiltrablesDe(reponseDuServeur());
    expect(champs.map((c) => c.cle)).toEqual(CHAMPS_FICHE_FIXES.filter((c) => estCleFiltrable(c.cle)).map((c) => c.cle));
  });

  it('🔴 une réponse vide, d’une autre forme ou absente rend une liste vide, sans lever', () => {
    for (const r of [{}, null, undefined, { champs: 'oui' }, { champs: [null, 42, 'x'] }, []]) {
      expect(champsFiltrablesDe(r)).toEqual([]);
    }
  });

  it('🔴 un champ dont un opérateur est inconnu est écarté en entier', () => {
    const r = { champs: [{ cle: 'analyse_urgence', libelle: ['u', 'u'], type: { nature: 'note' }, operateurs: ['gte', 'environ'] }] };
    expect(champsFiltrablesDe(r)).toEqual([]);
  });

  it('un champ à choix sans valeurs est écarté : l’écran ne saurait rien proposer', () => {
    const r = { champs: [{ cle: 'analyse_sentiment', libelle: ['s', 's'], type: { nature: 'choix' }, operateurs: ['in'] }] };
    expect(champsFiltrablesDe(r)).toEqual([]);
  });
});

describe('filtreAnalyseParDefaut', () => {
  it('🔴 le filtre par défaut de chaque champ et de chaque opérateur est ACCEPTÉ par le serveur', () => {
    // L'écran part toujours d'un filtre valide : un défaut refusé afficherait une erreur dès l'ajout d'une ligne.
    for (const champ of champsFiltrablesDe(reponseDuServeur())) {
      for (const op of champ.operateurs) {
        const f = filtreAnalyseParDefaut(champ, op);
        if (!estCleFiltrable(f.key)) throw new Error(f.key);
        expect(lireFiltreFiche(f.key, f.op, f.value).ok, `${f.key} ${op}`).toBe(true);
      }
    }
  });
});

describe('estFiltreAnalyse', () => {
  it('reconnaît une ligne par la liste reçue, ou par un opérateur de colonne quand la liste est vide', () => {
    const champs = champsFiltrablesDe(reponseDuServeur());
    expect(estFiltreAnalyse({ key: 'analyse_sentiment', op: 'empty' }, champs)).toBe(true);
    expect(estFiltreAnalyse({ key: 'analyse_urgence', op: 'gte' }, [])).toBe(true);
    expect(estFiltreAnalyse({ key: 'ville', op: 'contains' }, champs)).toBe(false);
  });
});
