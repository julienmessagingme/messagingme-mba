import { describe, it, expect } from 'vitest';
import { diviserOuRien, entonnoir, ISSUES_NON_PRISES_EN_CHARGE, type ComptesPub } from '../src/pubs/entonnoir';

/**
 * L'ENTONNOIR D'UNE PUBLICITÉ, ET SES DIVISIONS PAR ZÉRO (spec § 5).
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT. Un client regarde cet écran pour répondre à une question et une seule :
 * « est-ce que j'arrête cette campagne, ou est-ce que je remets du budget ? ». Un coût affiché `0 €` alors
 * qu'il est INCONNU ressemble au meilleur résultat imaginable, et c'est le chiffre le plus trompeur que cet
 * écran puisse produire. Tous les cas ci-dessous existent en vrai, et le plus fréquent est aussi le pire :
 * une publicité qui vient d'être publiée, dont Meta n'a encore rien rendu.
 */

const comptes = (over: Partial<ComptesPub> = {}): ComptesPub => ({
  depense: 100, clics: 200, leads: 50, qualifies: 10, nonPrisEnCharge: 3, ...over,
});

describe('diviser : trois façons de ne pas avoir de réponse', () => {
  it('le cas nominal', () => {
    expect(diviserOuRien(100, 4)).toBe(25);
  });

  it('🔴 dénominateur NUL : `null`, jamais zéro ni l’infini', () => {
    expect(diviserOuRien(100, 0)).toBeNull();
  });

  it('🔴 numérateur INCONNU : `null`. « Pas encore lu » n’est pas « zéro »', () => {
    // C'est le cas d'une publicité qui vient d'être publiée : Meta n'a pas encore de statistiques. Rendre 0
    // afficherait « 0 € par prospect », c'est-à-dire la meilleure campagne de l'histoire.
    expect(diviserOuRien(null, 50)).toBeNull();
  });

  it('🔴 dénominateur INCONNU : `null` aussi', () => {
    expect(diviserOuRien(100, null)).toBeNull();
  });

  it('🔴 un résultat NON FINI ne sort jamais : c’est le cas qui reste quand on a corrigé les deux autres', () => {
    // Le dénominateur nul est celui qu'on voit. Celui-là survit à une « correction » partielle et va
    // afficher `Infinity €` ou `NaN €` chez un client.
    expect(diviserOuRien(1, Number.MIN_VALUE / 2)).toBeNull();
    expect(diviserOuRien(0, 0)).toBeNull();
  });

  it('zéro au numérateur est une VRAIE mesure : zéro euro dépensé donne zéro, pas `null`', () => {
    expect(diviserOuRien(0, 10)).toBe(0);
  });
});

describe('l’entonnoir complet', () => {
  it('rend chaque étape avec son coût et son taux de passage', () => {
    const e = entonnoir(comptes());
    expect(e.depense).toBe(100);
    expect(e.clics).toEqual({ nombre: 200, cout: 0.5, passage: null });
    expect(e.leads).toEqual({ nombre: 50, cout: 2, passage: 0.25 });
    expect(e.qualifies).toEqual({ nombre: 10, cout: 10, passage: 0.2 });
    expect(e.nonPrisEnCharge).toBe(3);
  });

  it('🔴 LE TAUX DE PASSAGE DES CLICS EST `null` : rien ne précède les clics', () => {
    // Poser 1 ou 0 ici serait inventer une étape qui n'existe pas, et l'écran afficherait « 100 % des ...
    // arrivent aux clics ». De quoi ?
    expect(entonnoir(comptes()).clics.passage).toBeNull();
  });

  it('🔴 une publicité qui vient d’être publiée : aucun coût, aucun taux, et surtout AUCUN zéro', () => {
    const e = entonnoir(comptes({ depense: null, clics: null, leads: 0, qualifies: 0, nonPrisEnCharge: 0 }));
    expect(e.depense).toBeNull();
    expect(e.clics.nombre).toBeNull();
    expect(e.clics.cout).toBeNull();
    expect(e.leads.cout).toBeNull();
    expect(e.leads.passage).toBeNull();
    expect(e.qualifies.cout).toBeNull();
    expect(e.qualifies.passage).toBeNull();
  });

  it('des clics mais aucun prospect : le coût par prospect est indéterminé, pas nul', () => {
    // Cas RÉEL et important : la publicité diffuse, elle coûte, et personne n'écrit. Le taux de passage, lui,
    // vaut bien ZÉRO, et c'est le chiffre qui dit au client que quelque chose ne va pas.
    const e = entonnoir(comptes({ leads: 0, qualifies: 0 }));
    expect(e.leads.cout).toBeNull();
    expect(e.leads.passage).toBe(0);
    expect(e.qualifies.cout).toBeNull();
    expect(e.qualifies.passage).toBeNull();
  });

  it('des prospects mais aucun qualifié : le taux vaut zéro, le coût est indéterminé', () => {
    const e = entonnoir(comptes({ qualifies: 0 }));
    expect(e.qualifies.passage).toBe(0);
    expect(e.qualifies.cout).toBeNull();
  });

  it('une dépense connue et zéro clic : aucun coût par clic', () => {
    expect(entonnoir(comptes({ clics: 0 })).clics.cout).toBeNull();
  });
});

describe('les prospects non pris en charge', () => {
  it('sont rendus à part, et ne sont PAS retirés des prospects', () => {
    // Les soustraire flatterait le taux de passage ; les noyer dans le total les rendrait invisibles. Ce sont
    // des clics PAYÉS qui n'ont produit aucune conversation : ils s'affichent à côté, avec leur nom.
    const e = entonnoir(comptes({ leads: 50, nonPrisEnCharge: 12 }));
    expect(e.leads.nombre).toBe(50);
    expect(e.nonPrisEnCharge).toBe(12);
  });

  it('🔴 `agent_meta` N’EN FAIT PAS PARTIE : un lead confié à l’agent de Meta EST pris en charge', () => {
    // C'est la distinction qui décide de la justesse de l'écran. Le compter comme perdu afficherait
    // « 100 % de prospects perdus » sur une publicité qui fonctionne exactement comme prévu.
    expect([...ISSUES_NON_PRISES_EN_CHARGE]).toEqual(['reprise_refusee', 'desabonne', 'bloque', 'sans_scenario']);
    // 🔴 `sans_scenario` EN FAIT PARTIE : la publicité promet un scénario qui n'existe pas ou n'est pas
    // encore publié. Le clic a été payé, notre routage n'a rien servi, et c'est réparable : le fondre
    // dans les prospects servis empêcherait de voir le défaut de configuration.
    expect([...ISSUES_NON_PRISES_EN_CHARGE]).toContain('sans_scenario');
    expect([...ISSUES_NON_PRISES_EN_CHARGE]).not.toContain('agent_meta');
    expect([...ISSUES_NON_PRISES_EN_CHARGE]).not.toContain('scenario');
    expect([...ISSUES_NON_PRISES_EN_CHARGE]).not.toContain('reprise_reussie');
    // `inchange` non plus : ce sont les leads d'une pub qu'on ne pilote pas.
    expect([...ISSUES_NON_PRISES_EN_CHARGE]).not.toContain('inchange');
  });
});
