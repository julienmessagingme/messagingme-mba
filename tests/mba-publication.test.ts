import { describe, it, expect } from 'vitest';
import {
  planifierPublication, descriptionPourMeta, nomPubliableChezMeta, authConfigRelais, NOM_CONNECTEUR_RELAIS,
  type OutilAPublier, type EtatMeta, type RelaisAPublier,
} from '../src/mba/publication';
import { corpsOutilMeta, corpsConnecteurRelais } from '../src/http/mba-publication';

/**
 * Ce qui va changer chez Meta si l'on publie.
 *
 * 🔴 CE FICHIER PROTÈGE UN ENGAGEMENT PRIS DEVANT LE CLIENT : « Engage Me fait foi, la publication écrase ».
 * Écraser n'est acceptable que si l'on montre QUOI avant de le faire. Le plan est donc calculé sans aucune
 * IO, et c'est la moitié qui porte tous les arbitrages ; celle qui appelle Meta est mécanique.
 *
 * 🔴 RÉÉCRIT LE 2026-09-21 POUR LE RELAIS (spec 2026-09-21-relais-mba-design.md). Ce qui partait chez Meta
 * était un connecteur PAR SOURCE, avec le secret du client ; c'est désormais UN connecteur `EngageMe` par
 * espace, dont les outils appellent notre relais. Les cas d'avant sont conservés quand leur question existe
 * encore (création, doublon, idempotence, adresse, suppression, renommage, clause, définition absente) ; le
 * secret changé est devenu la clé révoquée, le passage de « aucune » à « jeton » est devenu un `auth_type`
 * qui n'est pas `API_KEY`. Ont disparu avec leur objet : les sources sans authentification, en en-tête nommé
 * ou retombant en `NONE`, et les « pertes » d'un outil creux, puisque plus aucun outil n'arrive creux.
 */

const RELAIS: RelaisAPublier = { baseUrl: 'https://api.messagingme.app/mba/relais', cleAJour: true };

/** L'outil réel du 2026-09-21, avec une variable du modèle, une liste de valeurs et une variable du mini-CRM. */
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Le client demande à rajouter une étiquette.', nePasUtiliser: '',
  variables: [
    { nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true, description: 'Identifiant UChat' },
    { nom: 'couleur', type: 'string', origine: { type: 'modele' }, enum: ['rouge', 'vert'] },
    { nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true },
  ],
};

const VIDE: EtatMeta = { connecteurs: [], outilsParConnecteur: {} };

/** L'état chez Meta qui correspond EXACTEMENT à `RELAIS` + `ADD_TAG` : c'est lui qui doit produire zéro geste. */
const ALIGNE: EtatMeta = {
  connecteurs: [{ id: 'c1', name: NOM_CONNECTEUR_RELAIS, base_url: RELAIS.baseUrl, auth_type: 'API_KEY' }],
  outilsParConnecteur: { c1: [{ id: 't1', ...corpsOutilMeta(ADD_TAG) }] },
};

describe('le corps d’un outil chez Meta', () => {
  it('🔴 appelle le RELAIS, jamais le système du client, avec l’en-tête du numéro lié à la macro', () => {
    const rd = corpsOutilMeta(ADD_TAG).request_definition;
    expect(rd.method).toBe('POST');
    expect(rd.path).toBe('/outils/o1');
    expect(rd.headers).toEqual({
      'X-Contact-WhatsApp': {
        type: 'string', description: expect.any(String), binding: { kind: 'macro', macro: 'WHATSAPP_PHONE_NUMBER' },
      },
    });
  });

  it('🔴 ne déclare QUE les variables du modèle ; les valeurs permises vont dans la description', () => {
    const body = corpsOutilMeta(ADD_TAG).request_definition.body as {
      content_type: string; params: Record<string, { type: string; description: string }>; required?: string[];
    };
    expect(body.content_type).toBe('application/json');
    expect(Object.keys(body.params).sort()).toEqual(['couleur', 'user']);
    expect(body.params.user).toEqual({ type: 'string', description: 'Identifiant UChat' });
    expect(body.params.couleur!.description).toBe('couleur Valeurs possibles : rouge, vert.');
    expect(body.required).toEqual(['user']);
  });

  it('sans variable du modèle, aucun corps', () => {
    expect(corpsOutilMeta({ ...ADD_TAG, variables: [ADD_TAG.variables[2]!] }).request_definition).not.toHaveProperty('body');
  });

  it('🔴 `user_auth_required` est TOUJOURS présent, à false', () => {
    // Il est dans le `required` du schéma de Meta : l'omettre ferait échouer la création.
    expect(corpsOutilMeta(ADD_TAG).user_auth_required).toBe(false);
  });
});

describe('planifierPublication', () => {
  it('un espace sans connecteur : le relais est CRÉÉ, puis ses outils', () => {
    expect(planifierPublication(RELAIS, [ADD_TAG], VIDE)).toEqual([
      { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS },
      { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' },
    ]);
  });

  it('🔴 PUBLIER DEUX FOIS DE SUITE NE PRODUIT AUCUN GESTE', () => {
    // C'est le SEUL test qui prouve que la réconciliation marche.
    expect(planifierPublication(RELAIS, [ADD_TAG], ALIGNE)).toEqual([]);
  });

  it('aucun outil exposé et rien chez Meta : aucun geste', () => {
    expect(planifierPublication(RELAIS, [], VIDE)).toEqual([]);
  });

  it('🔴 l’ancien connecteur d’une source (qui porte le SECRET du client) s’en va, ses outils D’ABORD', () => {
    const avecAncien: EtatMeta = {
      connecteurs: [...ALIGNE.connecteurs, { id: 'c0', name: 'testUCHAT', base_url: 'https://ai.messagingme.app/api', auth_type: 'API_KEY' }],
      outilsParConnecteur: { ...ALIGNE.outilsParConnecteur, c0: [{ id: 't0', name: 'add_tag' }] },
    };
    expect(planifierPublication(RELAIS, [ADD_TAG], avecAncien)).toEqual([
      { type: 'outil_supprimer', connecteurId: 'c0', outilMetaId: 't0', nom: 'add_tag' },
      { type: 'connecteur_supprimer', connecteurId: 'c0', nom: 'testUCHAT', oublierCle: false },
    ]);
  });

  it('🔴 un DOUBLON du relais chez Meta s’en va, le retenu reste', () => {
    const enDouble: EtatMeta = {
      connecteurs: [...ALIGNE.connecteurs, { id: 'c2', name: NOM_CONNECTEUR_RELAIS, base_url: RELAIS.baseUrl, auth_type: 'API_KEY' }],
      outilsParConnecteur: { ...ALIGNE.outilsParConnecteur, c2: [] },
    };
    expect(planifierPublication(RELAIS, [ADD_TAG], enDouble)).toEqual([
      { type: 'connecteur_supprimer', connecteurId: 'c2', nom: NOM_CONNECTEUR_RELAIS, oublierCle: false },
    ]);
  });

  it('🔴 une clé qui n’est plus active fait MODIFIER le connecteur (la modification porte une clé neuve)', () => {
    // Ce qui était « un secret changé chez nous est reposé » : Meta ne rend jamais la clé, on se souvient
    // de celle qu'on a posée, et une clé révoquée par le client doit être remplacée.
    expect(planifierPublication({ ...RELAIS, cleAJour: false }, [ADD_TAG], ALIGNE))
      .toEqual([{ type: 'connecteur_modifier', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS }]);
  });

  it('une adresse de relais qui a bougé produit une MODIFICATION, pas une recréation', () => {
    expect(planifierPublication({ ...RELAIS, baseUrl: 'https://autre.example/mba/relais' }, [ADD_TAG], ALIGNE))
      .toEqual([{ type: 'connecteur_modifier', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS }]);
  });

  it('un relais chez Meta qui n’est pas en `API_KEY` est modifié', () => {
    const enNone: EtatMeta = { ...ALIGNE, connecteurs: [{ ...ALIGNE.connecteurs[0]!, auth_type: 'NONE' }] };
    expect(planifierPublication(RELAIS, [ADD_TAG], enNone).map((g) => g.type)).toEqual(['connecteur_modifier']);
  });

  it('🔴 plus aucun outil exposé : le relais part, ses outils d’abord, et sa clé est OUBLIÉE', () => {
    expect(planifierPublication(RELAIS, [], ALIGNE)).toEqual([
      { type: 'outil_supprimer', connecteurId: 'c1', outilMetaId: 't1', nom: 'add_tag' },
      { type: 'connecteur_supprimer', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS, oublierCle: true },
    ]);
  });

  it('🔴 un outil EN DOUBLE chez Meta : on en garde un, on supprime la copie', () => {
    const t = ALIGNE.outilsParConnecteur.c1![0]!;
    const enDouble: EtatMeta = { ...ALIGNE, outilsParConnecteur: { c1: [t, { ...t, id: 't2' }] } };
    const g = planifierPublication(RELAIS, [ADD_TAG], enDouble);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ type: 'outil_supprimer', connecteurId: 'c1', nom: 'add_tag' });
  });

  it('🔴 un outil que Meta a en trop est SUPPRIMÉ : c’est ça, « Engage Me fait foi »', () => {
    const enTrop: EtatMeta = {
      ...ALIGNE,
      outilsParConnecteur: { c1: [...ALIGNE.outilsParConnecteur.c1!, { id: 't9', name: 'ajoute_a_la_main' }] },
    };
    expect(planifierPublication(RELAIS, [ADD_TAG], enTrop))
      .toEqual([{ type: 'outil_supprimer', connecteurId: 'c1', outilMetaId: 't9', nom: 'ajoute_a_la_main' }]);
  });

  it('🔴 renommer un outil se lit comme une suppression PLUS une création', () => {
    const g = planifierPublication(RELAIS, [{ ...ADD_TAG, name: 'nouveau_nom' }], ALIGNE);
    expect(g.map((x) => x.type).sort()).toEqual(['outil_creer', 'outil_supprimer']);
  });

  it('une description modifiée chez nous produit une modification chez Meta', () => {
    expect(planifierPublication(RELAIS, [{ ...ADD_TAG, description: 'Autre chose.' }], ALIGNE))
      .toEqual([{ type: 'outil_modifier', outilMetaId: 't1', outilId: 'o1', nom: 'add_tag' }]);
  });

  it('🔴 changer SEULEMENT « ne pas utiliser » produit quand même une modification', () => {
    // C'est le SEUL levier qui décide quand un outil se déclenche, et il voyage dans la description.
    expect(planifierPublication(RELAIS, [{ ...ADD_TAG, nePasUtiliser: 'Jamais le dimanche.' }], ALIGNE).map((x) => x.type))
      .toEqual(['outil_modifier']);
  });

  it('🔴 changer les VARIABLES du modèle produit une modification', () => {
    // Ce qui était « changer la méthode ou le chemin » : ce qui part chez Meta, c'est désormais le corps que
    // son modèle remplit. Une variable ajoutée chez nous et invisible chez Meta serait un outil muet.
    expect(planifierPublication(RELAIS, [{ ...ADD_TAG, variables: [] }], ALIGNE).map((x) => x.type)).toEqual(['outil_modifier']);
    const autreEnum = ADD_TAG.variables.map((v) => (v.nom === 'couleur' ? { ...v, enum: ['bleu'] } : v));
    expect(planifierPublication(RELAIS, [{ ...ADD_TAG, variables: autreEnum }], ALIGNE).map((x) => x.type)).toEqual(['outil_modifier']);
  });

  it('une variable du mini-CRM changée ne produit AUCUN geste : elle ne part pas chez Meta', () => {
    const autreChamp = ADD_TAG.variables.map((v) => (v.nom === 'tag' ? { ...v, origine: { type: 'champ' as const, cle: 'autre' } } : v));
    expect(planifierPublication(RELAIS, [{ ...ADD_TAG, variables: autreChamp }], ALIGNE)).toEqual([]);
  });

  it('🔴 un `request_definition` ABSENT de la réponse de Meta ne vaut PAS « identique »', () => {
    const sansRd: EtatMeta = {
      ...ALIGNE,
      outilsParConnecteur: { c1: [{ id: 't1', name: 'add_tag', description: descriptionPourMeta(ADD_TAG) }] },
    };
    expect(planifierPublication(RELAIS, [ADD_TAG], sansRd).map((x) => x.type)).toEqual(['outil_modifier']);
  });

  it('⚠️ un champ `null` ou un ordre de clés différent rendus par Meta ne produisent pas de geste', () => {
    const rd = corpsOutilMeta(ADD_TAG).request_definition;
    const renverse = Object.fromEntries(Object.entries({ ...rd, query_parameters: null }).reverse());
    const meta: EtatMeta = { ...ALIGNE, outilsParConnecteur: { c1: [{ ...ALIGNE.outilsParConnecteur.c1![0]!, request_definition: renverse }] } };
    expect(planifierPublication(RELAIS, [ADD_TAG], meta)).toEqual([]);
  });
});

describe('la traduction vers le modèle de Meta', () => {
  it('« ne pas utiliser » est concaténé à la description', () => {
    const d = descriptionPourMeta({ description: 'Donne l’état d’une commande.', nePasUtiliser: 'Jamais pour annuler.' });
    expect(d.startsWith('Donne l’état d’une commande.')).toBe(true);
    expect(d).toContain('Ne pas l');
    expect(d.endsWith('Jamais pour annuler.')).toBe(true);
  });

  it('une clause vide ne laisse aucun résidu dans la description', () => {
    expect(descriptionPourMeta({ description: 'X.', nePasUtiliser: '   ' })).toBe('X.');
  });
});

describe('le connecteur du relais', () => {
  it('🔴 porte l’adresse du relais, et la clé dans son CORPS, sous `auth_config.api_key`', () => {
    // Meta exige `auth_config` à chaque écriture en `API_KEY` (mesuré le 2026-09-18), et refuse l'enveloppe
    // `api_key_config`, qui n'existe pas.
    const c = corpsConnecteurRelais(RELAIS.baseUrl, 'mba_CLE');
    expect(c).toMatchObject({ name: NOM_CONNECTEUR_RELAIS, base_url: RELAIS.baseUrl, auth_type: 'API_KEY' });
    expect(c.auth_config).toEqual({ api_key: { headers: [{ field_name: 'Authorization', value: 'mba_CLE', prefix: 'Bearer ' }] } });
    expect(c).not.toHaveProperty('api_key_config');
  });

  it('🔴 le préfixe « Bearer » vit dans `prefix`, JAMAIS collé à la clé', () => {
    expect(authConfigRelais('K').api_key.headers[0]!.value).toBe('K');
  });
});

describe('le nom qu’un connecteur peut porter chez Meta', () => {
  it('🔴 lettres, chiffres et tiret bas passent, et le nom du relais en fait partie', () => {
    for (const n of ['testUCHAT', 'sonde_auth', 'Sonde42', NOM_CONNECTEUR_RELAIS]) expect(nomPubliableChezMeta(n)).toBe(true);
  });

  it('🔴 le TIRET et l’ESPACE sont refusés, y compris l’exemple de la spec', () => {
    for (const n of ['sonde-auth', 'sonde auth', 'Shopify Order Management']) expect(nomPubliableChezMeta(n)).toBe(false);
  });
});
