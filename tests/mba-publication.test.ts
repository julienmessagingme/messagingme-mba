import { describe, it, expect } from 'vitest';
import {
  planifierPublication, descriptionPourMeta, authTypeMeta, authConfigMeta, nomPubliableChezMeta,
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
  /**
   * 🔴 IL ATTENDAIT UN `secret_poser` DERRIÈRE LA CRÉATION, ET CE GESTE NE PEUT PLUS EXISTER (2026-09-18).
   *
   * Meta EXIGE `auth_config` dans le CORPS du connecteur dès que `auth_type` n'est pas `NONE` : créer puis
   * poser la clé après coup était impossible, et c'est ce qui faisait échouer en 400 toute création de
   * connecteur authentifié. La création porte donc son secret, et le geste séparé disparaît À LA CRÉATION.
   *
   * ⚠️ CE QUI EST CONSERVÉ DU CAS D'ORIGINE : le secret part bien avec ce plan, et les outils suivent. Le
   * geste `secret_poser` existe TOUJOURS pour une source déjà créée dont le secret a changé, et c'est le
   * test « un secret DÉJÀ POSÉ n'est pas reposé » juste en dessous qui garde cette moitié-là.
   */
  it('un connecteur absent chez Meta est CRÉÉ, sa création PORTANT son secret, puis ses outils', () => {
    const g = planifierPublication([SRC], [OUT], VIDE);
    expect(g.map((x) => x.type)).toEqual(['connecteur_creer', 'outil_creer']);
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

  it('🔴 passer une source de « aucune » à « jeton » MODIFIE le connecteur AVANT de poser le secret', () => {
    // L'ordre n'est pas cosmétique : poser une clé sur un connecteur encore déclaré `NONE` chez Meta est une
    // écriture qu'il n'a aucune raison d'accepter, et la publication s'arrêterait là en laissant le
    // connecteur à moitié converti. Même ordre qu'à la création : le connecteur, puis son secret.
    const meta: EtatMeta = {
      connecteurs: [{ id: 'c1', name: 'Shopify', base_url: SRC.baseUrl, auth_type: 'NONE' }],
      outilsParConnecteur: {},
    };
    const g = planifierPublication([{ ...SRC, secretPublie: false }], [], meta);
    expect(g.map((x) => x.type)).toEqual(['connecteur_modifier', 'secret_poser']);
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
    const c = authConfigMeta({ authKind: 'bearer', authHeaderName: null }, 'SECRET');
    expect(c.api_key.headers[0]).toEqual({ field_name: 'Authorization', value: 'SECRET', prefix: 'Bearer ' });
  });

  it('un en-tête nommé garde son nom, sans préfixe', () => {
    const c = authConfigMeta({ authKind: 'header', authHeaderName: 'X-Cle' }, 'SECRET');
    expect(c.api_key.headers[0]).toEqual({ field_name: 'X-Cle', value: 'SECRET', prefix: null });
  });

  /**
   * 🔴 L'ENVELOPPE S'APPELLE `api_key`, ET LA CONFONDRE A BLOQUÉ TOUTE PUBLICATION AUTHENTIFIÉE.
   * Nous envoyions `api_key_config` à `upsertApiKey`, que Meta refusait en « Invalid api_key_config ». La
   * spec officielle dit `auth_config.api_key`, et un 201 sur le vrai compte l'a confirmé le 2026-09-18.
   */
  it('🔴 l’enveloppe est `api_key`, JAMAIS `api_key_config`', () => {
    const c = authConfigMeta({ authKind: 'bearer', authHeaderName: null }, 'S');
    expect(Object.keys(c)).toEqual(['api_key']);
    expect((c as Record<string, unknown>).api_key_config).toBeUndefined();
  });
});

/**
 * 🔴 LE NOM D'UN CONNECTEUR, ET LA SPEC DE META SE CONTREDIT ELLE-MÊME.
 *
 * Son champ `name` est décrit comme un « display name », avec `Shopify Order Management` en exemple. Ce
 * nom-là est REFUSÉ par son propre serveur. Mesuré un par un le 2026-09-18, sur le vrai compte, sondes
 * effacées ensuite. Sans cette borne, un client qui nomme sa source « Mon CRM » reçoit un 400 « Invalid
 * connector request » qui ne nomme aucun champ.
 */
describe('le nom qu’un connecteur peut porter chez Meta', () => {
  it('🔴 lettres, chiffres et tiret bas passent', () => {
    for (const nom of ['testUCHAT', 'sondeauth', 'sonde_auth', 'Sonde42']) {
      expect(nomPubliableChezMeta(nom)).toBe(true);
    }
  });

  it('🔴 le TIRET et l’ESPACE sont refusés, y compris l’exemple de la spec', () => {
    for (const nom of ['sonde-auth', 'sonde auth', 'Shopify Order Management', '']) {
      expect(nomPubliableChezMeta(nom)).toBe(false);
    }
  });
});

describe('les deux regles de validation que Meta ecrit noir sur blanc', () => {
  /**
   * 🔴 CE TEST AFFIRMAIT L'INVERSE, ET C'ÉTAIT LA CAUSE DU BLOCAGE (corrigé le 2026-09-18).
   *
   * Il disait « `auth_config` est ABSENT du corps d'un connecteur », en expliquant que les cas
   * authentifiés passaient par `upsertApiKey`. C'était faux : Meta EXIGE `auth_config` dans le corps dès
   * que `auth_type` n'est pas `NONE`, et refusait donc toute création de connecteur authentifié en 400.
   *
   * ⚠️ CE QUI EST CONSERVÉ DU CAS D'ORIGINE, et qui reste vrai : un connecteur SANS authentification ne
   * doit pas porter `auth_config`. Le poser « au cas où » ferait échouer la création d'un connecteur en
   * `NONE`, cas parfaitement banal. La moitié juste du test d'avant est donc toujours éprouvée ici.
   */
  it('🔴 `auth_config` est ABSENT sans authentification, PRÉSENT avec', () => {
    const sansAuth = corpsConnecteurMeta({ ...SRC, authKind: 'none', authHeaderName: null }, 'PEU_IMPORTE');
    expect(Object.keys(sansAuth)).toEqual(['name', 'description', 'base_url', 'auth_type']);
    expect(sansAuth.auth_type).toBe('NONE');

    for (const kind of ['bearer', 'header'] as const) {
      const c = corpsConnecteurMeta({ ...SRC, authKind: kind, authHeaderName: 'X-Cle' }, 'SECRET');
      expect(c.auth_type).toBe('API_KEY');
      expect(c.auth_config).toEqual(authConfigMeta({ authKind: kind, authHeaderName: 'X-Cle' }, 'SECRET'));
    }
  });

  /**
   * ⚠️ UNE SOURCE AUTHENTIFIÉE SANS SECRET LISIBLE RETOMBE EN `NONE`, jamais en `API_KEY` nu : ce dernier
   * est refusé par Meta, donc il ferait échouer la publication ENTIÈRE au lieu de publier ce qui est
   * publiable. Le geste `secret_poser` du plan suivant remettra l'authentification.
   */
  it('🔴 authentifiée mais sans secret : on publie en NONE, on n’échoue pas', () => {
    for (const secret of [null, undefined, '']) {
      const c = corpsConnecteurMeta({ ...SRC, authKind: 'bearer', authHeaderName: null }, secret);
      expect(c.auth_type).toBe('NONE');
      expect(c.auth_config).toBeUndefined();
    }
  });

  it('🔴 `auth_config.api_key` a TOUJOURS une entrée peuplée', () => {
    // « At least one of headers, query_params, or body_params must contain a populated entry. The request
    // fails with HTTP 400 if this field is null or missing. »
    for (const kind of ['bearer', 'header'] as const) {
      const c = authConfigMeta({ authKind: kind, authHeaderName: 'X-Cle' }, 'S');
      expect(c.api_key.headers.length).toBeGreaterThan(0);
      expect(c.api_key.headers[0]!.value).toBe('S');
    }
  });

  it('🔴 `user_auth_required` est TOUJOURS present dans un outil', () => {
    // Il est dans le `required` du schema : l omettre ferait echouer la creation. `false` est le seul choix
    // honnete, nous ne collectons aucun jeton par utilisateur final.
    expect(corpsOutilMeta(OUT).user_auth_required).toBe(false);
  });
});
