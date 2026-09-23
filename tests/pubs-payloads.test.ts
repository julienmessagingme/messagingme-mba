import { describe, it, expect } from 'vitest';
import {
  budgetEnUnitesMineures, ciblage, messageBienvenue, payloadCampagne, payloadCrea, payloadEnsemble, payloadPub,
  LIEN_WHATSAPP, OBJECTIF_CAMPAGNE, OPTIMISATION_ENSEMBLE, STATUT_PAUSE, type FormulairePub,
} from '../src/meta/pubs-payloads';

/**
 * LE TEXTE EXACT ENVOYÉ À META, comparé à sa documentation (spec § 5).
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT. Ces objets partent sur le compte publicitaire d'un client et y créent des
 * objets qui dépenseront son argent. Une clé mal nommée, un statut oublié, un budget d'un facteur cent : rien
 * de tout cela ne se voit à la relecture, et tout se paie en vrai. Les valeurs ci-dessous sont recopiées
 * depuis la page « Publicités clic vers WhatsApp » de developers.facebook.com, RELUE EN LIGNE le 2026-09-23
 * (page mise à jour le 2026-05-21), et pas depuis un souvenir ni un corpus téléchargé.
 *
 * ⚠️ CES TESTS NE PROUVENT PAS QUE META ACCEPTE. Ils prouvent que nous envoyons ce que sa documentation
 * décrit. Ce que seule la première création réelle du pilote tranchera est nommé dans les commentaires du
 * module : l'emplacement de `page_welcome_message`, et `CONVERSATIONS` pour un annonceur français.
 */

const form = (over: Partial<FormulairePub> = {}): FormulairePub => ({
  nom: 'Rentrée 2026',
  texte: 'Une question sur nos tarifs ? Écrivez-nous.',
  titre: 'Parlez-nous sur WhatsApp',
  messagePreRempli: 'Bonjour, je voudrais des informations',
  accueil: 'Bonjour ! Comment pouvons-nous vous aider ?',
  budgetTotal: 150,
  debut: '2026-10-01 00:00:00+02:00',
  fin: '2026-10-31 23:59:59+01:00',
  pays: ['FR'],
  villes: [],
  ageMin: 25,
  ageMax: 55,
  ...over,
});

describe('le budget, en unités mineures', () => {
  it('🔴 des euros deviennent des centimes : se tromper ici coûte cent fois le budget', () => {
    expect(budgetEnUnitesMineures(150)).toBe(15000);
    expect(budgetEnUnitesMineures(1)).toBe(100);
  });

  it('🔴 ARRONDI, pas troncature : 10,99 € ne doit pas devenir 10,98 €', () => {
    expect(budgetEnUnitesMineures(10.99)).toBe(1099);
    // Le cas qui pince vraiment : la représentation binaire de 10.995 * 100 vaut 1099.4999...
    expect(budgetEnUnitesMineures(0.07)).toBe(7);
    expect(budgetEnUnitesMineures(29.99)).toBe(2999);
  });

  it('rend toujours un ENTIER : Meta refuse un décimal', () => {
    for (const m of [1, 12.34, 99.999, 0.01]) expect(Number.isInteger(budgetEnUnitesMineures(m))).toBe(true);
  });
});

describe('la campagne', () => {
  it('porte l’objectif, le statut en PAUSE, et une liste de catégories spéciales VIDE', () => {
    expect(payloadCampagne('Rentrée 2026')).toEqual({
      name: 'Rentrée 2026',
      objective: 'OUTCOME_ENGAGEMENT',
      special_ad_categories: [],
      status: 'PAUSED',
    });
  });

  it('🔴 JAMAIS ACTIVE À LA CRÉATION : c’est ce qui rend un échec inoffensif', () => {
    // Une campagne en pause ne dépense rien. Si cette valeur devenait `ACTIVE`, une création interrompue à
    // mi-chemin laisserait une campagne qui diffuse sans que personne ne l'ait publiée.
    expect(payloadCampagne('x').status).toBe(STATUT_PAUSE);
  });

  it('l’objectif est celui qui accepte les DEUX optimisations dont on peut avoir besoin', () => {
    // `OUTCOME_LEADS` n'accepte que `CONVERSATIONS` : le choisir condamnerait le repli sur `LINK_CLICKS` si
    // la mesure du pilote montrait que `CONVERSATIONS` ne passe pas pour un annonceur français.
    expect(OBJECTIF_CAMPAGNE).toBe('OUTCOME_ENGAGEMENT');
  });
});

describe('l’ensemble de publicités', () => {
  it('porte tout ce que Meta déclare obligatoire, et rien qu’on ait deviné', () => {
    const p = payloadEnsemble(form(), { campagneId: 'c-1', pageId: 'p-1', numeroWhatsApp: '33612345678' });
    expect(p).toEqual({
      name: 'Rentrée 2026',
      campaign_id: 'c-1',
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: OPTIMISATION_ENSEMBLE,
      destination_type: 'WHATSAPP',
      lifetime_budget: 15000,
      start_time: '2026-10-01 00:00:00+02:00',
      end_time: '2026-10-31 23:59:59+01:00',
      targeting: { geo_locations: { countries: ['FR'] }, age_min: 25, age_max: 55 },
      promoted_object: { page_id: 'p-1', whatsapp_phone_number: '33612345678' },
    });
  });

  it('🔴 NI `bid_amount` NI `bid_strategy` : on ne choisit pas à la place du client ce que vaut un prospect', () => {
    const p = payloadEnsemble(form(), { campagneId: 'c-1', pageId: 'p-1', numeroWhatsApp: null });
    expect(p).not.toHaveProperty('bid_amount');
    expect(p).not.toHaveProperty('bid_strategy');
  });

  it('sans numéro connu, `promoted_object` ne porte que la Page (le numéro est facultatif chez Meta)', () => {
    const p = payloadEnsemble(form(), { campagneId: 'c-1', pageId: 'p-1', numeroWhatsApp: null });
    expect(p.promoted_object).toEqual({ page_id: 'p-1' });
  });

  it('🔴 `end_time` EST TOUJOURS POSÉ : Meta l’exige dès qu’il y a un `lifetime_budget`', () => {
    const p = payloadEnsemble(form(), { campagneId: 'c-1', pageId: 'p-1', numeroWhatsApp: null });
    expect(p.lifetime_budget).toBeGreaterThan(0);
    expect(p.end_time).toBe('2026-10-31 23:59:59+01:00');
  });
});

describe('le ciblage', () => {
  it('par pays', () => {
    expect(ciblage({ pays: ['FR', 'BE'], villes: [], ageMin: 18, ageMax: 65 }))
      .toEqual({ geo_locations: { countries: ['FR', 'BE'] }, age_min: 18, age_max: 65 });
  });

  it('par ville et rayon', () => {
    expect(ciblage({ pays: [], villes: [{ cle: 'Paris:FR', rayon: 25, unite: 'kilometer' }], ageMin: 20, ageMax: 40 }))
      .toEqual({
        geo_locations: { custom_locations: [{ key: 'Paris:FR', radius: 25, distance_unit: 'kilometer' }] },
        age_min: 20, age_max: 40,
      });
  });

  it('🔴 `device_platforms` N’EST PAS POSÉ, et l’absence est le choix', () => {
    // Restreindre à `mobile` paraît naturel pour une pub qui ouvre WhatsApp, et retirerait des prospects
    // RÉELS : un clic depuis un ordinateur marche, il n'ouvre simplement pas les 72 h gratuites.
    expect(ciblage({ pays: ['FR'], villes: [], ageMin: 18, ageMax: 65 })).not.toHaveProperty('device_platforms');
  });
});

describe('le message d’accueil de la Page', () => {
  it('a la forme EXACTE que Meta documente pour un message pré-rempli', () => {
    expect(messageBienvenue('Bonjour !', 'Je veux un devis')).toEqual({
      type: 'VISUAL_EDITOR',
      version: 2,
      landing_screen_type: 'welcome_message',
      media_type: 'text',
      text_format: {
        customer_action_type: 'autofill_message',
        message: {
          autofill_message: { content: 'Je veux un devis' },
          text: 'Bonjour !',
        },
      },
    });
  });

  it('🔴 les deux textes ne se confondent pas : l’un se LIT, l’autre s’ÉCRIT dans la zone de saisie', () => {
    // Les inverser serait invisible à la relecture, et produirait une publicité où le prospect envoie
    // « Bonjour ! Comment pouvons-nous vous aider ? » à l'entreprise, ce qui ne veut rien dire.
    const m = messageBienvenue('CE QUI SE LIT', 'CE QUI S’ÉCRIT') as {
      text_format: { message: { text: string; autofill_message: { content: string } } };
    };
    expect(m.text_format.message.text).toBe('CE QUI SE LIT');
    expect(m.text_format.message.autofill_message.content).toBe('CE QUI S’ÉCRIT');
  });
});

describe('la créa', () => {
  it('porte le lien WhatsApp, l’appel à l’action, l’image et le message d’accueil', () => {
    expect(payloadCrea(form(), { pageId: 'p-1', imageHash: 'h-abc' })).toEqual({
      name: 'Rentrée 2026',
      object_story_spec: {
        page_id: 'p-1',
        link_data: {
          name: 'Parlez-nous sur WhatsApp',
          message: 'Une question sur nos tarifs ? Écrivez-nous.',
          image_hash: 'h-abc',
          link: 'https://api.whatsapp.com/send',
          page_welcome_message: messageBienvenue(
            'Bonjour ! Comment pouvons-nous vous aider ?', 'Bonjour, je voudrais des informations',
          ),
          call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
        },
      },
    });
  });

  it('🔴 le lien n’est pas une adresse qu’on choisit : c’est la valeur que Meta attend', () => {
    expect(LIEN_WHATSAPP).toBe('https://api.whatsapp.com/send');
  });
});

describe('la publicité', () => {
  it('marie la créa et l’ensemble, en pause', () => {
    expect(payloadPub('Rentrée 2026', { ensembleId: 'e-1', creaId: 'cr-1' })).toEqual({
      name: 'Rentrée 2026',
      adset_id: 'e-1',
      creative: { creative_id: 'cr-1' },
      status: 'PAUSED',
    });
  });
});

describe('🔴 TOUT est créé en pause, sans exception', () => {
  it('les trois objets qui portent un statut le portent à PAUSED', () => {
    // Un seul des trois à `ACTIVE` suffirait à faire diffuser une publicité que personne n'a publiée, dès
    // que la campagne s'allume. C'est le genre d'écart qui ne se voit pas dans un diff de trois fichiers.
    const statuts = [
      payloadCampagne('x').status,
      payloadEnsemble(form(), { campagneId: 'c', pageId: 'p', numeroWhatsApp: null }).status,
      payloadPub('x', { ensembleId: 'e', creaId: 'cr' }).status,
    ];
    expect(statuts).toEqual(['PAUSED', 'PAUSED', 'PAUSED']);
  });
});
