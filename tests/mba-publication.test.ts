import { describe, it, expect } from 'vitest';
import {
  planifierPublication, descriptionPourMeta, authTypeMeta, corpsApiKey,
  type SourceAPublier, type OutilAPublier, type EtatMeta,
} from '../src/mba/publication';
import { corpsConnecteurMeta, corpsOutilMeta } from '../src/http/mba-publication';

/**
 * Ce qui va changer chez Meta si l'on publie.
 *
 * 🔴 CE FICHIER PROTÈGE UN ENGAGEMENT PRIS DEVANT LE CLIENT : « Engage Me fait foi, la publication écrase ».
 * Écraser n'est acceptable que si l'on montre QUOI avant de le faire. Le plan est donc calculé sans aucune
 * IO, et c'est la moitié qui porte tous les arbitrages ; celle qui appelle Meta est mécanique.
 */

const SRC: SourceAPublier = {
  id: 's1', label: 'Shopify', baseUrl: 'https://api.shopify.com/v1',
  authKind: 'bearer', authHeaderName: null, aAuthentification: true,
  // Le secret courant est DEJA chez Meta : c'est l'etat de croisiere, celui qui doit produire zero geste.
  secretPublie: true,
};
const OUT: OutilAPublier = {
  id: 'o1', sourceId: 's1', name: 'check_order_status',
  description: 'Donne l’état d’une commande.', nePasUtiliser: 'Jamais pour annuler.',
  methode: 'GET', chemin: '/orders/{id}',
};
const VIDE: EtatMeta = { connecteurs: [], outilsParConnecteur: {} };

/** L'état chez Meta qui correspond EXACTEMENT à `SRC` + `OUT` : c'est lui qui doit produire zéro geste. */
const ALIGNE: EtatMeta = {
  connecteurs: [{ id: 'c1', name: 'Shopify', base_url: 'https://api.shopify.com/v1', auth_type: 'API_KEY' }],
  outilsParConnecteur: {
    c1: [{
      id: 't1', name: 'check_order_status', description: descriptionPourMeta(OUT),
      request_definition: { method: 'GET', path: '/orders/{id}' },
    }],
  },
};

describe('planifierPublication', () => {
  it('un connecteur absent chez Meta est CRÉÉ, avec son secret et ses outils', () => {
    const g = planifierPublication([SRC], [OUT], VIDE);
    expect(g.map((x) => x.type)).toEqual(['connecteur_creer', 'secret_poser', 'outil_creer']);
  });

  it('🔴 PUBLIER DEUX FOIS DE SUITE NE PRODUIT AUCUN GESTE', () => {
    // C'est le SEUL test qui prouve que la réconciliation marche. Sans lui, une publication idempotente en
    // apparence pourrait recréer ses objets à chaque passage, et personne ne le verrait avant que Meta ne
    // se retrouve avec quinze connecteurs du même nom.
    expect(planifierPublication([SRC], [OUT], ALIGNE)).toEqual([]);
  });

  it('un secret DÉJÀ POSÉ chez Meta n’est pas reposé', () => {
    // Meta ne rend jamais le secret : on ne peut pas comparer, seulement se souvenir de ce qu'on a posé. Le
    // reposer à chaque publication marcherait, mais on perdrait le test d'idempotence juste au-dessus.
    expect(planifierPublication([SRC], [], ALIGNE).some((x) => x.type === 'secret_poser')).toBe(false);
  });

  it('🔴 un secret CHANGÉ chez nous est REPOSÉ à la publication suivante', () => {
    // Trouvé en relisant le chemin le 2026-09-10 : le plan ne posait le secret qu'à la CRÉATION du
    // connecteur, et un commentaire affirmait qu'un bouton dédié permettait de le faire tourner. Ce bouton
    // n'existait pas. Un client qui changeait son jeton le voyait pris en compte par ses agents et PAS par
    // l'agent de Meta, qui présentait l'ancien jusqu'à ce qu'un contact découvre l'outil muet.
    const g = planifierPublication([{ ...SRC, secretPublie: false }], [OUT], ALIGNE);
    expect(g).toEqual([{ type: 'secret_poser', sourceId: 's1', nom: 'Shopify' }]);
  });

  it('⚠️ une source SANS authentification ne produit jamais de geste de secret', () => {
    // `secretPublie` reste `false` pour toujours sur une source sans secret : sans la garde
    // `aAuthentification`, elle réclamerait un `secret_poser` à CHAQUE publication, et le geste échouerait
    // faute de secret à poser, ce qui arrêterait toute la publication sur un cas parfaitement normal.
    const nue: SourceAPublier = {
      ...SRC, authKind: 'none', aAuthentification: false, secretPublie: false,
    };
    const meta: EtatMeta = {
      connecteurs: [{ id: 'c1', name: 'Shopify', base_url: SRC.baseUrl, auth_type: 'NONE' }],
      outilsParConnecteur: {},
    };
    expect(planifierPublication([nue], [], meta)).toEqual([]);
  });

  it('une adresse de base qui a bougé produit une MODIFICATION, pas une recréation', () => {
    const meta: EtatMeta = {
      ...ALIGNE,
      connecteurs: [{ id: 'c1', name: 'Shopify', base_url: 'https://ancienne.example', auth_type: 'API_KEY' }],
    };
    const g = planifierPublication([SRC], [OUT], meta);
    expect(g).toContainEqual({ type: 'connecteur_modifier', connecteurId: 'c1', sourceId: 's1', nom: 'Shopify' });
    expect(g.some((x) => x.type === 'connecteur_creer')).toBe(false);
  });

  it('🔴 un connecteur que nous n’avons plus est SUPPRIMÉ, ses outils D’ABORD', () => {
    // L'ordre des gestes est celui de l'exécution : un connecteur ne peut pas être supprimé avant ses
    // outils. La liste se lit de haut en bas comme une recette, et l'écran l'affiche telle quelle.
    const meta: EtatMeta = {
      connecteurs: [{ id: 'cX', name: 'AncienCRM', base_url: 'https://x', auth_type: 'NONE' }],
      outilsParConnecteur: { cX: [{ id: 'tX', name: 'vieux_outil' }] },
    };
    const g = planifierPublication([], [], meta);
    expect(g.map((x) => x.type)).toEqual(['outil_supprimer', 'connecteur_supprimer']);
  });

  it('🔴 un outil que Meta a en trop est SUPPRIMÉ : c’est ça, « Engage Me fait foi »', () => {
    // Un outil créé à la main dans WhatsApp Manager disparaît à la publication suivante. C'est la décision
    // de Julien, et l'aperçu doit la rendre visible AVANT le clic.
    const meta: EtatMeta = {
      ...ALIGNE,
      outilsParConnecteur: {
        c1: [
          {
            id: 't1', name: 'check_order_status', description: descriptionPourMeta(OUT),
            request_definition: { method: 'GET', path: '/orders/{id}' },
          },
          { id: 't2', name: 'ajoute_a_la_main' },
        ],
      },
    };
    const g = planifierPublication([SRC], [OUT], meta);
    expect(g).toEqual([{ type: 'outil_supprimer', sourceId: 's1', outilMetaId: 't2', nom: 'ajoute_a_la_main' }]);
  });

  it('🔴 renommer un outil se lit comme une suppression PLUS une création', () => {
    // Conséquence assumée de la réconciliation par le NOM. Elle est écrite ici pour que personne ne la
    // découvre en production, et l'aperçu la montre en toutes lettres.
    const g = planifierPublication([SRC], [{ ...OUT, name: 'nouveau_nom' }], ALIGNE);
    expect(g.map((x) => x.type).sort()).toEqual(['outil_creer', 'outil_supprimer']);
  });

  it('une description modifiée chez nous produit une modification chez Meta', () => {
    const g = planifierPublication([SRC], [{ ...OUT, description: 'Autre chose.' }], ALIGNE);
    expect(g).toEqual([{ type: 'outil_modifier', sourceId: 's1', outilMetaId: 't1', outilId: 'o1', nom: 'check_order_status' }]);
  });

  it('🔴 changer la MÉTHODE ou le CHEMIN produit une modification', () => {
    // Trouvé en revue : le plan ne comparait QUE la description. Changer l'adresse d'une requête chez nous
    // ne produisait AUCUN geste, l'aperçu annonçait « rien à changer », et l'agent de Meta continuait
    // d'appeler l'ancienne adresse pour toujours. Symptôme : un outil qui « ne marche plus » sans qu'aucun
    // écran ne montre le moindre écart.
    expect(planifierPublication([SRC], [{ ...OUT, chemin: '/v2/orders/{id}' }], ALIGNE).map((x) => x.type))
      .toEqual(['outil_modifier']);
    expect(planifierPublication([SRC], [{ ...OUT, methode: 'POST' }], ALIGNE).map((x) => x.type))
      .toEqual(['outil_modifier']);
  });

  it('🔴 un `request_definition` ABSENT de la réponse de Meta ne vaut PAS « identique »', () => {
    // On ne peut pas comparer ce qu'on n'a pas reçu. Le prix de ce choix est un geste de trop si Meta
    // cessait de rendre ce champ ; le prix de l'inverse est un outil cassé pour toujours, en silence.
    const sansRd: EtatMeta = {
      ...ALIGNE,
      outilsParConnecteur: { c1: [{ id: 't1', name: 'check_order_status', description: descriptionPourMeta(OUT) }] },
    };
    expect(planifierPublication([SRC], [OUT], sansRd).map((x) => x.type)).toEqual(['outil_modifier']);
  });

  it('🔴 changer SEULEMENT « ne pas utiliser » produit quand même une modification', () => {
    // C'est le SEUL levier qui décide quand un outil se déclenche, et Meta n'a pas de champ pour lui : il
    // voyage dans la description. Ne pas le comparer laisserait le client corriger un texte sans effet,
    // exactement ce qui s'est passé chez nous jusqu'au 2026-08-29.
    const g = planifierPublication([SRC], [{ ...OUT, nePasUtiliser: 'Jamais le dimanche.' }], ALIGNE);
    expect(g.map((x) => x.type)).toEqual(['outil_modifier']);
  });
});

describe('la traduction vers le modèle de Meta', () => {
  it('« ne pas utiliser » est concaténé à la description', () => {
    expect(descriptionPourMeta(OUT)).toContain('Ne pas l’utiliser'.replace('’', "'"));
    expect(descriptionPourMeta(OUT)).toContain('Jamais pour annuler.');
  });

  it('une clause vide ne laisse aucun résidu dans la description', () => {
    expect(descriptionPourMeta({ description: 'Seule.', nePasUtiliser: '   ' })).toBe('Seule.');
  });

  it('🔴 bearer ET header deviennent tous deux API_KEY', () => {
    // Meta n'a pas de type « bearer » : il a un mécanisme d'en-têtes dont `Authorization: Bearer <secret>`
    // est un cas particulier. La différence se joue dans `upsertApiKey`, pas dans `auth_type`.
    expect(authTypeMeta('bearer')).toBe('API_KEY');
    expect(authTypeMeta('header')).toBe('API_KEY');
    expect(authTypeMeta('none')).toBe('NONE');
  });

  it('🔴 le préfixe « Bearer » vit dans `prefix`, JAMAIS collé au secret', () => {
    // Meta concatène lui-même. Coller le préfixe au secret produirait « Bearer Bearer <secret> » le jour où
    // quelqu'un règle aussi le préfixe, et un 401 que personne ne saurait expliquer.
    const c = corpsApiKey({ authKind: 'bearer', authHeaderName: null }, 'SECRET');
    expect(c.api_key_config.headers[0]).toEqual({ field_name: 'Authorization', value: 'SECRET', prefix: 'Bearer ' });
  });

  it('un en-tête nommé garde son nom, sans préfixe', () => {
    const c = corpsApiKey({ authKind: 'header', authHeaderName: 'X-Cle' }, 'SECRET');
    expect(c.api_key_config.headers[0]).toEqual({ field_name: 'X-Cle', value: 'SECRET', prefix: null });
  });
});

describe('les deux regles de validation que Meta ecrit noir sur blanc', () => {
  it('🔴 `auth_config` est ABSENT du corps d’un connecteur', () => {
    // Meta impose de l'OMETTRE quand `auth_type` vaut `NONE` (400 sinon), et pour les autres cas nous
    // passons par `upsertApiKey`. Le poser « au cas où » ferait échouer la création d'un connecteur sans
    // authentification, cas parfaitement banal.
    for (const kind of ['none', 'bearer', 'header'] as const) {
      const c = corpsConnecteurMeta({ ...SRC, authKind: kind });
      expect(Object.keys(c)).toEqual(['name', 'description', 'base_url', 'auth_type']);
    }
  });

  it('🔴 `api_key_config` a TOUJOURS une entrée peuplée', () => {
    // « At least one of headers, query_params, or body_params must contain a populated entry. The request
    // fails with HTTP 400 if this field is null or missing. »
    for (const kind of ['bearer', 'header'] as const) {
      const c = corpsApiKey({ authKind: kind, authHeaderName: 'X-Cle' }, 'S');
      expect(c.api_key_config.headers.length).toBeGreaterThan(0);
      expect(c.api_key_config.headers[0]!.value).toBe('S');
    }
  });

  it('🔴 `user_auth_required` est TOUJOURS present dans un outil', () => {
    // Il est dans le `required` du schema : l omettre ferait echouer la creation. `false` est le seul choix
    // honnete, nous ne collectons aucun jeton par utilisateur final.
    expect(corpsOutilMeta(OUT).user_auth_required).toBe(false);
  });
});
