import { describe, expect, it } from 'vitest';
import { brouillonDeLEtat, etatDeBrouillon, type EtatBrouillon } from './campagne-brouillon';
import { audienceInitiale, selectionVide } from './audience';

/**
 * CE QUE CES CAS PROTÈGENT : LE TRAVAIL EN COURS DE QUELQU'UN.
 *
 * 🔴 UN BROUILLON ÉCRIT PAR L'ANCIEN FORMULAIRE DOIT RESTER LISIBLE APRÈS SON RETRAIT. Le `state` d'un
 * brouillon est un `jsonb` de forme LIBRE que le serveur ne valide pas : l'écran qui l'a écrit était seul
 * à savoir le relire. Retirer cet écran sans savoir relire ce qu'il a écrit jetterait, sans un mot, la
 * campagne que quelqu'un avait commencée, destinataires cochés compris.
 *
 * ⚠️ LES CHARGES DE L'ANCIEN FORMAT CI-DESSOUS SONT RECOPIÉES DE SON `etatDuFormulaire`, pas inventées :
 * ce sont ses clés, ses noms et ses valeurs. Une fixture écrite d'après le code qui la relit reproduirait
 * les hypothèses de ce code, et ne prouverait rien.
 */

const ETAT: EtatBrouillon = {
  category: 'marketing',
  formule: 'repli',
  premier: 'whatsapp',
  troisieme: 'email',
  reessayer: true,
  heuresOuvrees: true,
  debitParMinute: 42,
  contenus: {
    1: { formule: 'seul', templateName: 'promo', templateLanguage: 'fr', suggestions: [], variables: [{ sel: 'sys:prenom', value: '' }] },
    2: { formule: 'seul', texteRcs: 'coucou', imageRcs: 'https://exemple.fr/v.jpg', suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'p1' }] },
    3: { formule: 'seul', emailTemplateId: 'em-1', emailChamp: 'mail_pro', suggestions: [] },
  },
  devenir: 'agent',
  agentId: 'ag-1',
  assignation: 'personne',
  assignationUserId: 'u-1',
  audience: {
    source: 'crm',
    webhookId: '',
    filtres: { tags: ['vip'] },
    selection: { toutFiltre: false, selected: new Set(['c1', 'c2']), exclus: new Set() },
  },
  quand: 'plus_tard',
  dateLocale: '2026-12-25T10:30',
};

describe('un aller-retour par le format de l assistant', () => {
  it('rend exactement ce qu on avait ecrit', () => {
    expect(etatDeBrouillon(brouillonDeLEtat(ETAT))).toEqual(ETAT);
  });

  /**
   * 🔴 LES `Set` NE SURVIVENT PAS À `JSON.stringify` : `new Set(['a'])` s'y sérialise en `{}`, donc en
   * sélection VIDE, sans la moindre erreur. C'est le travail le plus long du parcours, et il
   * disparaîtrait en silence. Le test passe donc par un VRAI aller-retour JSON, comme la base.
   */
  it('la selection survit a un vrai passage par JSON', () => {
    const relu = etatDeBrouillon(JSON.parse(JSON.stringify(brouillonDeLEtat(ETAT))));
    expect([...(relu.audience?.selection.selected ?? [])]).toEqual(['c1', 'c2']);
    expect(relu.audience?.selection.toutFiltre).toBe(false);
  });

  it('les exclusions survivent aussi, dans l autre mode', () => {
    const avecExclus: EtatBrouillon = {
      ...ETAT,
      audience: { ...ETAT.audience, selection: { toutFiltre: true, selected: new Set(), exclus: new Set(['x1']) } },
    };
    const relu = etatDeBrouillon(JSON.parse(JSON.stringify(brouillonDeLEtat(avecExclus))));
    expect([...(relu.audience?.selection.exclus ?? [])]).toEqual(['x1']);
    expect(relu.audience?.selection.toutFiltre).toBe(true);
  });

  // ⚠️ Le NOM n'entre pas dans le `state` : il vit dans la colonne `campaign_drafts.name`, seule source
  // de ce que la liste des brouillons affiche. Deux noms seraient deux vérités à tenir d'accord.
  it('le nom n est pas dans l etat enregistre', () => {
    expect('nom' in brouillonDeLEtat(ETAT)).toBe(false);
  });
});

/**
 * L'ANCIEN FORMAT, tel que l'ancien formulaire de création l'écrivait (sa fonction `etatDuFormulaire`).
 *
 * Ses clés, verbatim : `category, mode, source, webhookId, phoneNumberId, templateName, templateLanguage,
 * vars, workflowId, rcsAgentId, rcsText, rcsImage, ratePerMinute, timing, scheduledLocal, heuresOuvrees,
 * filters, selected, toutFiltre, exclus`.
 */
describe('un brouillon de l ANCIEN formulaire', () => {
  const ANCIEN_TEMPLATE = {
    category: 'utility',
    mode: 'template',
    source: 'crm',
    webhookId: '',
    phoneNumberId: 'pn-9',
    templateName: 'promo_rentree',
    templateLanguage: 'fr',
    vars: [{ sel: 'field:prenom', value: '' }, { sel: 'literal', value: 'Paris' }],
    workflowId: '',
    rcsAgentId: '',
    rcsText: '',
    rcsImage: '',
    ratePerMinute: 30,
    timing: 'now',
    scheduledLocal: '',
    heuresOuvrees: true,
    filters: { tags: ['vip'], tagMode: 'or' },
    selected: ['c1', 'c2', 'c3'],
    toutFiltre: false,
    exclus: [],
  };

  it('le modele, sa langue et ses variables reviennent sur l etage 1', () => {
    const e = etatDeBrouillon(ANCIEN_TEMPLATE);
    expect(e.formule).toBe('whatsapp');
    expect(e.contenus?.[1]).toMatchObject({
      formule: 'seul', templateName: 'promo_rentree', templateLanguage: 'fr',
      variables: [{ sel: 'field:prenom', value: '' }, { sel: 'literal', value: 'Paris' }],
    });
  });

  /**
   * 🔴 LE TRAVAIL LE PLUS LONG DU PARCOURS. Julien, le 2026-09-08 : « si je ferme le site et que je
   * reviens, il faut à nouveau que je sélectionne les personnes ». Les filtres comptent autant que les
   * coches : sans eux, la reprise recharge « tous les contacts » et la sélection ne désigne plus rien.
   */
  it('les contacts coches ET leurs filtres reviennent', () => {
    const e = etatDeBrouillon(ANCIEN_TEMPLATE);
    expect([...(e.audience?.selection.selected ?? [])]).toEqual(['c1', 'c2', 'c3']);
    expect(e.audience?.selection.toutFiltre).toBe(false);
    expect(e.audience?.filtres).toEqual({ tags: ['vip'], tagMode: 'or' });
  });

  it('la categorie, le debit et l horaire reviennent', () => {
    const e = etatDeBrouillon(ANCIEN_TEMPLATE);
    expect(e.category).toBe('utility');
    expect(e.debitParMinute).toBe(30);
    expect(e.heuresOuvrees).toBe(true);
  });

  /**
   * 🔴 `mode: 'workflow'` PORTE LE PIÈGE DU LOT. L'ancien écran gardait dans `templateName` le modèle par
   * lequel le SCÉNARIO ouvre, avec ses variables dans `vars`. L'assistant compte les `{{n}}` depuis
   * `modeleDuScenario` : le relire dans `templateName` laisserait les variables sans modèle connu, donc
   * une liste que la garde de lancement jugerait orpheline, sans rien à l'écran pour l'expliquer.
   */
  it('un scenario retrouve son modele d ouverture dans modeleDuScenario', () => {
    const e = etatDeBrouillon({
      ...ANCIEN_TEMPLATE, mode: 'workflow', workflowId: 'wf-1', templateName: 'ouverture', templateLanguage: 'en',
    });
    expect(e.contenus?.[1]).toMatchObject({
      formule: 'avec_scenario',
      workflowId: 'wf-1',
      modeleDuScenario: { name: 'ouverture', language: 'en' },
    });
    // ⚠️ ET PAS DANS `templateName` : l'y laisser ferait compter les variables d'un modèle que la
    // campagne n'envoie pas.
    expect(e.contenus?.[1]?.templateName).toBeUndefined();
    expect(e.contenus?.[1]?.variables).toHaveLength(2);
  });

  it('un message RCS revient sur un etage RCS, avec son visuel', () => {
    const e = etatDeBrouillon({
      ...ANCIEN_TEMPLATE, mode: 'rcs', rcsText: 'coucou', rcsImage: 'https://exemple.fr/v.jpg',
    });
    expect(e.formule).toBe('rcs');
    expect(e.contenus?.[1]).toMatchObject({ texteRcs: 'coucou', imageRcs: 'https://exemple.fr/v.jpg' });
    // ⚠️ Les variables d'un modèle n'ont rien à faire sur un étage RCS, qui n'en a pas.
    expect(e.contenus?.[1]?.variables).toBeUndefined();
  });

  /**
   * 🔴 `timing` S'APPELLE AUTREMENT, ET SES VALEURS AUSSI. Relire la clé sans traduire la valeur rendrait
   * `undefined`, donc « maintenant » par défaut : une campagne programmée repartirait TOUT DE SUITE à la
   * reprise, ce qui est exactement le genre de perte qu'un brouillon existe pour éviter.
   */
  it('une programmation revient programmee, jamais en depart immediat', () => {
    const e = etatDeBrouillon({ ...ANCIEN_TEMPLATE, timing: 'later', scheduledLocal: '2026-12-25T10:30' });
    expect(e.quand).toBe('plus_tard');
    expect(e.dateLocale).toBe('2026-12-25T10:30');
  });

  // ⚠️ L'AUTRE SENS : `now` reste bien « maintenant ». Sans ce cas, une implémentation qui répondrait
  // toujours « plus tard » passerait celui du dessus.
  it('et un depart immediat reste immediat', () => {
    expect(etatDeBrouillon(ANCIEN_TEMPLATE).quand).toBe('maintenant');
  });

  /**
   * 🔴 `file` CÔTÉ ANCIEN ÉCRAN S'APPELLE `fichier` ICI. Un nom non traduit retomberait sur `crm`,
   * c'est-à-dire sur une liste de contacts, là où l'opérateur avait commencé un import.
   */
  it('les quatre noms de source sont traduits', () => {
    expect(etatDeBrouillon({ ...ANCIEN_TEMPLATE, source: 'file' }).audience?.source).toBe('fichier');
    expect(etatDeBrouillon({ ...ANCIEN_TEMPLATE, source: 'hubspot' }).audience?.source).toBe('hubspot');
    expect(etatDeBrouillon({ ...ANCIEN_TEMPLATE, source: 'webhook', webhookId: 'wh-1' }).audience)
      .toMatchObject({ source: 'webhook', webhookId: 'wh-1' });
    expect(etatDeBrouillon({ ...ANCIEN_TEMPLATE, source: 'crm' }).audience?.source).toBe('crm');
  });

  // ⚠️ Une source inconnue (écrite par une version qu'on ne connaît pas) retombe sur `crm` plutôt que de
  // poser une valeur qu'aucun écran ne sait afficher.
  it('une source inconnue retombe sur la liste de contacts', () => {
    expect(etatDeBrouillon({ ...ANCIEN_TEMPLATE, source: 'martien' }).audience?.source).toBe('crm');
  });
});

/**
 * CE QUI N'EST PAS DE LA BONNE FORME N'ENTRE PAS.
 *
 * 🔴 CET OBJET REVIENT D'UN `jsonb` QU'AUCUNE VALIDATION NE COUVRE. Un `as` y ferait entrer n'importe
 * quoi dans un état typé, et le rendu suivant jetterait sur un `.trim()` ou un `.length`, emportant tout
 * l'écran pour un brouillon qu'on essayait justement de sauver.
 */
describe('la relecture defensive', () => {
  it('un etat vide rend des defauts, jamais une exception', () => {
    expect(() => etatDeBrouillon({})).not.toThrow();
    expect(etatDeBrouillon({}).audience?.filtres).toEqual({});
  });

  it('un etat qui n est pas un objet rend des defauts', () => {
    expect(etatDeBrouillon(null).audience?.source).toBe('crm');
    expect(etatDeBrouillon('coucou').audience?.source).toBe('crm');
    expect(etatDeBrouillon([1, 2]).audience?.source).toBe('crm');
  });

  /**
   * ⚠️ UNE LIGNE DE VARIABLE SANS `value` EST JETÉE, pas complétée : le type la déclare non optionnelle,
   * et `problemeDAssociation` appelle `.trim()` dessus sans détour.
   */
  it('une ligne de variable mal formee est jetee', () => {
    const e = etatDeBrouillon({ assistant: 1, contenus: { 1: { formule: 'seul', variables: [{ sel: 'sys:name' }] } } });
    expect(e.contenus?.[1]?.variables).toBeUndefined();
  });

  it('un debit hors bornes est ramene dans ses bornes', () => {
    expect(etatDeBrouillon({ assistant: 1, debitParMinute: 5000 }).debitParMinute).toBe(80);
    expect(etatDeBrouillon({ ...{ mode: 'template' }, ratePerMinute: -3 }).debitParMinute).toBe(1);
  });

  // ⚠️ Une valeur d'énumération inconnue n'écrase pas le défaut : elle est simplement absente du patch.
  it('une formule inconnue laisse le defaut en place', () => {
    expect('formule' in etatDeBrouillon({ assistant: 1, formule: 'telepathie' })).toBe(false);
  });

  // Le repère de version : sans lui, on lit l'ancien format, et l'ancien format n'a pas de `contenus`.
  it('sans marqueur de version, c est l ancien format qui est lu', () => {
    const e = etatDeBrouillon({ mode: 'rcs', rcsText: 'salut' });
    expect(e.contenus?.[1]?.texteRcs).toBe('salut');
  });

  it('une audience neuve reste celle d une creation neuve', () => {
    const e = etatDeBrouillon({ assistant: 1 });
    expect(e.audience?.source).toBe(audienceInitiale().source);
    expect(e.audience?.selection.toutFiltre).toBe(audienceInitiale().selection.toutFiltre);
  });

  it('une selection explicitement vide reste vide, elle ne repasse pas a « tous »', () => {
    const vide: EtatBrouillon = { ...ETAT, audience: { ...ETAT.audience, selection: selectionVide() } };
    const relu = etatDeBrouillon(JSON.parse(JSON.stringify(brouillonDeLEtat(vide))));
    expect(relu.audience?.selection.toutFiltre).toBe(false);
    expect(relu.audience?.selection.selected.size).toBe(0);
  });
});
