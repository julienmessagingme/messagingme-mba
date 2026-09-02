import { describe, it, expect } from 'vitest';
import { formatMaintenant, resoudreVariable, libelleOrigine, CLES_SYSTEME, estCleSysteme, type ContexteVariables } from '../src/agent/variables';

const ctx = (p: Partial<ContexteVariables> = {}): ContexteVariables => ({
  waId: '33612345678',
  contact: { nom: 'Léa' },
  champs: { ville: 'Lyon', points: 12, vide: '' },
  derniereSaisie: 'je voudrais changer ma commande',
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
  it('🔴 le numéro vient du TOUR, pas de la projection : c’est la garde anti-IDOR', () => {
    // Un connecteur sert à répondre « où en est MA commande ». Si le numéro pouvait venir d'ailleurs que du
    // tour authentifié, il suffirait de demander la commande d'un autre pour l'obtenir.
    const c = ctx({ contact: { wa_id: '33699999999', nom: 'Léa' } });
    expect(resoudreVariable({ type: 'contact', cle: 'wa_id' }, c)).toBe('33612345678');
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
    expect(resoudreVariable({ type: 'contact', cle: 'nom' }, ctx({ contact: null }))).toBeNull();
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
});

describe('libellés annoncés au client', () => {
  it('chaque origine a un libellé lisible, et il vit à côté de la définition', () => {
    // La fenêtre de création d'agent annonce « on envoie Ville et Dernière saisie, c'est bien ça ? ». Deux
    // listes tenues séparément finiraient par ne plus dire ce qui part réellement : ce serait une
    // confirmation qui ment, donc pire que pas de confirmation du tout.
    expect(libelleOrigine({ type: 'champ', cle: 'ville' })).toContain('ville');
    expect(libelleOrigine({ type: 'systeme', cle: 'derniere_saisie' })).toContain('dernier message');
    expect(libelleOrigine({ type: 'systeme', cle: 'maintenant' })).toContain('date');
    expect(libelleOrigine({ type: 'contact', cle: 'wa_id' })).toContain('numéro');
    expect(libelleOrigine({ type: 'modele' })).toContain('agent');
    expect(libelleOrigine({ type: 'fixe', valeur: 'FR' })).toContain('FR');
  });
});

describe('catalogue fermé des valeurs système', () => {
  it('la liste est celle qu’on croit, et une clé inventée est refusée', () => {
    expect([...CLES_SYSTEME]).toEqual(['derniere_saisie', 'maintenant']);
    expect(estCleSysteme('derniere_saisie')).toBe(true);
    expect(estCleSysteme('mot_de_passe')).toBe(false);
    expect(estCleSysteme(42)).toBe(false);
  });
});
