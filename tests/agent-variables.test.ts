import { describe, it, expect } from 'vitest';
import { formatMaintenant, resoudreVariable, libelleOrigine, normaliserOrigine, CLES_SYSTEME, type ContexteVariables } from '../src/agent/variables';

const ctx = (p: Partial<ContexteVariables> = {}): ContexteVariables => ({
  waId: '33612345678',
  champs: { ville: 'Lyon', points: 12, vide: '' },
  derniereSaisie: 'je voudrais changer ma commande',
  fiche: { nom: 'Léa' },
  maintenant: new Date('2026-09-02T09:45:00.000Z'),
  fuseau: 'Europe/Paris',
  ...p,
});

/**
 * La valeur système « maintenant ».
 *
 * Julien, le 2026-09-02 : « il faut que ça soit la valeur au format international qui prenne bien en compte
 * le GMT ». Le bloc de scénario écrivait `toISOString()`, donc de l'UTC : l'instant était juste, mais l'heure
 * LUE était fausse de deux heures en été. Ces tests éprouvent les deux saisons, parce qu'un seul cas ne
 * distingue pas « le fuseau est pris en compte » de « on a codé +02:00 en dur ».
 */
describe('maintenant : ISO 8601 avec le décalage du fuseau de l’espace', () => {
  it('en ÉTÉ à Paris, le décalage est +02:00 et l’heure lue est locale', () => {
    expect(formatMaintenant(new Date('2026-09-02T09:45:00.000Z'), 'Europe/Paris')).toBe('2026-09-02T11:45:00+02:00');
  });

  it('en HIVER à Paris, le décalage est +01:00 : c’est bien le fuseau qui décide, pas une constante', () => {
    expect(formatMaintenant(new Date('2026-01-15T09:45:00.000Z'), 'Europe/Paris')).toBe('2026-01-15T10:45:00+01:00');
  });

  it('un décalage NÉGATIF est rendu correctement', () => {
    expect(formatMaintenant(new Date('2026-09-02T09:45:00.000Z'), 'America/New_York')).toBe('2026-09-02T05:45:00-04:00');
  });

  it('un décalage à la DEMI-HEURE est rendu correctement', () => {
    // Un décalage en heures pleines ne prouve pas que les minutes sont traitées.
    expect(formatMaintenant(new Date('2026-09-02T09:45:00.000Z'), 'Asia/Kolkata')).toBe('2026-09-02T15:15:00+05:30');
  });

  it('UTC rend +00:00, et surtout jamais « 24 » à minuit', () => {
    expect(formatMaintenant(new Date('2026-09-02T00:00:00.000Z'), 'UTC')).toBe('2026-09-02T00:00:00+00:00');
  });

  it('la valeur reste analysable comme une date, et désigne le MÊME instant', () => {
    // C'est le point de tout l'exercice : changer la notation ne doit pas changer l'instant, sans quoi les
    // conditions datetime des scénarios compareraient autre chose qu'avant.
    const instant = new Date('2026-09-02T09:45:00.000Z');
    expect(new Date(formatMaintenant(instant, 'Europe/Paris')).getTime()).toBe(instant.getTime());
    expect(new Date(formatMaintenant(instant, 'America/New_York')).getTime()).toBe(instant.getTime());
  });
});

describe('résolution d’une variable', () => {
  it('🔴 le numéro vient du TOUR, jamais de la fiche : c’est la garde anti-IDOR', () => {
    // Un connecteur sert à répondre « où en est MA commande ». Si le numéro pouvait venir d'ailleurs que du
    // tour authentifié, il suffirait de demander la commande d'un autre pour l'obtenir.
    const c = ctx({ fiche: { nom: 'Léa', wa_id: '33699999999' } });
    expect(resoudreVariable({ type: 'fiche', cle: 'wa_id' }, c)).toBe('33612345678');
  });

  it('un champ FIXE de la fiche est atteignable : nom, identifiant externe, date de création', () => {
    const c = ctx({ fiche: { nom: 'Léa', external_id: 'crm-42', created_at: '2026-01-01T00:00:00.000Z' } });
    expect(resoudreVariable({ type: 'fiche', cle: 'nom' }, c)).toBe('Léa');
    expect(resoudreVariable({ type: 'fiche', cle: 'external_id' }, c)).toBe('crm-42');
    expect(resoudreVariable({ type: 'fiche', cle: 'created_at' }, c)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('un CHAMP PERSONNALISÉ est atteignable, ce qui manquait entièrement', () => {
    expect(resoudreVariable({ type: 'champ', cle: 'ville' }, ctx())).toBe('Lyon');
    expect(resoudreVariable({ type: 'champ', cle: 'points' }, ctx())).toBe(12);
  });

  it('la DERNIÈRE SAISIE du contact est atteignable', () => {
    expect(resoudreVariable({ type: 'systeme', cle: 'derniere_saisie' }, ctx())).toBe('je voudrais changer ma commande');
  });

  it('une valeur ABSENTE rend null, jamais une valeur inventée', () => {
    // Envoyer une ville qu'on ne connaît pas ferait répondre le système du client sur autre chose, et l'agent
    // répéterait cette réponse au contact avec assurance.
    expect(resoudreVariable({ type: 'champ', cle: 'jamais_rempli' }, ctx())).toBeNull();
    expect(resoudreVariable({ type: 'champ', cle: 'vide' }, ctx())).toBeNull();
    expect(resoudreVariable({ type: 'fiche', cle: 'nom' }, ctx({ fiche: null }))).toBeNull();
    expect(resoudreVariable({ type: 'fiche', cle: 'external_id' }, ctx())).toBeNull();
    expect(resoudreVariable({ type: 'systeme', cle: 'derniere_saisie' }, ctx({ derniereSaisie: null }))).toBeNull();
  });

  it('🔴 un objet ou un tableau rend null, jamais « [object Object] »', () => {
    // Un appel silencieusement faux est pire qu'une valeur manquante : celle-ci se voit et se corrige.
    expect(resoudreVariable({ type: 'champ', cle: 'o' }, ctx({ champs: { o: { a: 1 } } }))).toBeNull();
    expect(resoudreVariable({ type: 'champ', cle: 'l' }, ctx({ champs: { l: [1, 2] } }))).toBeNull();
  });

  it('une valeur FIXE est rendue telle quelle', () => {
    expect(resoudreVariable({ type: 'fixe', valeur: 'FR' }, ctx())).toBe('FR');
    expect(resoudreVariable({ type: 'fixe', valeur: 7 }, ctx())).toBe(7);
  });

  it('une variable du MODÈLE n’est pas calculée ici : l’exécuteur l’a déjà validée', () => {
    expect(resoudreVariable({ type: 'modele' }, ctx())).toBeNull();
  });

  it('🔴 une ORIGINE non reconnue (forme ancienne non réécrite) rend null, jamais l’objet lui-même', () => {
    // Vu pendant le lot 2 : une requête construite hors de `lireVariables` avec `contact:wa_id` envoyait
    // `{"phone": {"type":"contact","cle":"wa_id"}}` au système du client.
    const ancienne = { type: 'contact', cle: 'wa_id' } as unknown as Parameters<typeof resoudreVariable>[0];
    expect(resoudreVariable(ancienne, ctx())).toBeNull();
  });

  it('🔴 une clé système INCONNUE rend null, jamais la clé elle-même comme valeur', () => {
    const inconnue = { type: 'systeme', cle: 'cle_future' } as unknown as Parameters<typeof resoudreVariable>[0];
    expect(resoudreVariable(inconnue, ctx({ derniereSaisie: 'bonjour' }))).toBeNull();
  });
});

describe('les valeurs de la dernière analyse, lues sur la fiche', () => {
  const fiche = {
    analyse_intention: 'reclamation', analyse_sentiment: 'negatif', analyse_satisfaction: 0, analyse_urgence: 8,
    analyse_resolue: false, analyse_sujet: 'colis abîmé', analyse_traitee_par: 'humain', analyse_action: 'rappeler',
    analyse_le: '2026-09-30T17:57:31.700Z', risque_depart: 'eleve',
  };

  it('🔴 chaque champ rend SA valeur, avec son type : un 0 reste un 0, un false reste un false', () => {
    // Une satisfaction de 0 est la mesure qui alarme : la perdre en null la ferait disparaître côté CRM.
    const c = ctx({ fiche });
    for (const [cle, attendu] of Object.entries(fiche)) {
      expect(resoudreVariable({ type: 'fiche', cle: cle as keyof typeof fiche }, c), cle).toBe(attendu);
    }
  });

  it('🔴 sans analyse sur la fiche, null : jamais une valeur inventée', () => {
    for (const cle of Object.keys(fiche) as Array<keyof typeof fiche>) {
      expect(resoudreVariable({ type: 'fiche', cle }, ctx({ fiche: {} })), cle).toBeNull();
    }
  });
});

describe('les formes anciennes sont relues, jamais refusées', () => {
  it('🔴 contact:wa_id et contact:nom deviennent des champs de fiche', () => {
    expect(normaliserOrigine({ type: 'contact', cle: 'wa_id' })).toEqual({ type: 'fiche', cle: 'wa_id' });
    expect(normaliserOrigine({ type: 'contact', cle: 'nom' })).toEqual({ type: 'fiche', cle: 'nom' });
  });

  it('🔴 les valeurs d’analyse de la veille (systeme:analyse_*) deviennent des champs de fiche', () => {
    for (const cle of ['analyse_intention', 'analyse_sentiment', 'analyse_satisfaction', 'analyse_urgence', 'analyse_resolue', 'risque_depart']) {
      expect(normaliserOrigine({ type: 'systeme', cle })).toEqual({ type: 'fiche', cle });
    }
  });

  it('les formes actuelles passent telles quelles', () => {
    expect(normaliserOrigine({ type: 'systeme', cle: 'maintenant' })).toEqual({ type: 'systeme', cle: 'maintenant' });
    expect(normaliserOrigine({ type: 'fiche', cle: 'external_id' })).toEqual({ type: 'fiche', cle: 'external_id' });
    expect(normaliserOrigine({ type: 'champ', cle: 'ville' })).toEqual({ type: 'champ', cle: 'ville' });
    expect(normaliserOrigine({ type: 'fixe', valeur: 0 })).toEqual({ type: 'fixe', valeur: 0 });
    expect(normaliserOrigine({ type: 'modele' })).toEqual({ type: 'modele' });
  });

  it('🔴 une forme inconnue est écartée : ni clé libre sur la fiche, ni origine inventée', () => {
    expect(normaliserOrigine({ type: 'fiche', cle: 'jeton_public' })).toBeNull();
    expect(normaliserOrigine({ type: 'contact', cle: 'phone_e164' })).toBeNull();
    expect(normaliserOrigine({ type: 'systeme', cle: 'cle_future' })).toBeNull();
    expect(normaliserOrigine({ type: 'inconnu' })).toBeNull();
    expect(normaliserOrigine(null)).toBeNull();
  });

  it('🔴 une clé système qui nomme une propriété HÉRITÉE d’Object est écartée', () => {
    // Un accès nu à la table des anciennes clés rendrait `Object.prototype.constructor` : une origine `fiche`
    // dont la clé est une fonction.
    for (const cle of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(normaliserOrigine({ type: 'systeme', cle }), cle).toBeNull();
    }
  });
});

describe('libellés annoncés au client', () => {
  it('chaque origine a un libellé lisible, et celui d’un champ de fiche vient de la liste unique', () => {
    // La fenêtre de création d'agent annonce « on envoie Ville et Dernière saisie, c'est bien ça ? ». Deux
    // listes tenues séparément finiraient par ne plus dire ce qui part réellement : ce serait une
    // confirmation qui ment, donc pire que pas de confirmation du tout.
    expect(libelleOrigine({ type: 'champ', cle: 'ville' })).toContain('ville');
    expect(libelleOrigine({ type: 'systeme', cle: 'derniere_saisie' })).toContain('dernier message');
    expect(libelleOrigine({ type: 'systeme', cle: 'maintenant' })).toContain('date');
    expect(libelleOrigine({ type: 'fiche', cle: 'wa_id' })).toContain('numéro');
    expect(libelleOrigine({ type: 'fiche', cle: 'analyse_sentiment' })).toContain('sentiment');
    expect(libelleOrigine({ type: 'fiche', cle: 'risque_depart' })).toContain('risque');
    expect(libelleOrigine({ type: 'modele' })).toContain('agent');
    expect(libelleOrigine({ type: 'fixe', valeur: 'FR' })).toContain('FR');
  });

  it('une origine inconnue à l’exécution rend un TEXTE, jamais l’objet', () => {
    expect(libelleOrigine({ type: 'contact', cle: 'nom' } as never)).toBe('origine inconnue');
  });
});

describe('catalogue fermé des valeurs système', () => {
  it('la liste est celle qu’on croit : l’analyse est devenue un champ de fiche', () => {
    expect([...CLES_SYSTEME]).toEqual(['derniere_saisie', 'maintenant']);
  });
});
