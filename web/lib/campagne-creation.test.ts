import { describe, expect, it } from 'vitest';
import {
  entreeDeCreation, modeleDeLEtage, momentDuLancement, problemeAvantLancement, variablesParRang,
  type ContexteDeCreation, type EtatPourCreation,
} from './campagne-creation';
import type { EtageAssistant } from './campagne-chaine';
import { selectionTout, selectionVide } from './audience';

/**
 * CE QUE LE BOUTON « LANCER » ENVOIE VRAIMENT.
 *
 * 🔴 C'EST LA DERNIÈRE TRADUCTION AVANT DES MESSAGES RÉELS. Le récapitulatif se relit à l'œil ; ce qui
 * décide de ce qui PART est cet objet, et une clé posée au mauvais endroit y est invisible à l'écran.
 */
const CTX: ContexteDeCreation = {
  phoneNumberId: 'pn-1', rcsAgentId: 'ag-1', filtres: { tags: ['vip'] }, champEmail: 'email',
  // ⚠️ « TOUT CE QUI CORRESPOND », c'est-à-dire le défaut de l'assistant : l'audience part alors en
  // FILTRES. Le cas « liste de contacts cochés » a son propre test plus bas, et les deux sont exclusifs.
  selection: selectionTout(),
  // ⚠️ `null` = campagne sur LISTE, le cas de base. Le fil de l'eau a ses propres cas plus bas, et la
  // distinction entre `null` et la chaîne vide y est vérifiée dans les deux sens.
  webhookId: null,
  // Le modèle du rang 1 ne porte aucune variable : c'est le cas de base des tests d'avant ce lot.
  variablesDuModele: {},
};

const ETAT: EtatPourCreation = {
  nom: '  Promo rentrée  ',
  category: 'marketing',
  debitParMinute: 60,
  heuresOuvrees: false,
  reessayer: true,
  assignation: 'aucune',
  assignationUserId: null,
  // Le cas de base : on lance tout de suite. La programmation a ses propres cas plus bas.
  quand: 'maintenant',
  dateLocale: '',
  contenus: {
    1: { formule: 'seul', templateName: 'promo', templateLanguage: 'fr', suggestions: [] },
    2: { formule: 'seul', texteRcs: 'coucou', suggestions: [] },
    3: { formule: 'seul', emailTemplateId: 'em-1', suggestions: [] },
  },
};

const CHAINE: EtageAssistant[] = [
  { rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }, { rang: 3, canal: 'email' },
];

describe('entreeDeCreation', () => {
  it('le premier etage devient la campagne, les suivants deviennent la chaine', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.channel).toBe('whatsapp');
    expect(e.templateName).toBe('promo');
    expect(e.name).toBe('Promo rentrée');
    expect(e.chaine?.map((x) => ({ rang: x.rang, canal: x.canal }))).toEqual([
      { rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }, { rang: 3, canal: 'email' },
    ]);
  });

  /**
   * 🔴 LE RANG 1 NE PORTE AUCUN CONTENU DANS LA CHAÎNE, ET CE N'EST PAS UN OUBLI. Le serveur l'IGNORE et
   * réécrit cet étage depuis les colonnes de la campagne (invariant de la migration 0134, « une seule
   * source pour le contenu d'un étage »). L'envoyer quand même donnerait l'illusion qu'il compte, et le
   * jour où les deux divergeraient, c'est la valeur invisible qui aurait l'air d'être la bonne.
   */
  it('le rang 1 de la chaine ne transporte pas de contenu', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.chaine?.[0]).toEqual({ rang: 1, canal: 'whatsapp' });
  });

  // 🔴 L'AUTRE SENS : les étages SUIVANTS, eux, portent leur contenu. Sans ce cas, une implémentation qui
  // viderait TOUS les étages passerait le test du dessus et créerait trois étages muets.
  it('les etages suivants transportent leur contenu', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.chaine?.[1]?.rcsMessage).toEqual({ kind: 'text', text: 'coucou' });
    expect(e.chaine?.[2]?.emailTemplateId).toBe('em-1');
  });

  /**
   * ⚠️ UN SEUL ÉTAGE N'EST PAS UNE CHAÎNE. Le serveur écrit de toute façon le rang 1 depuis les colonnes
   * de la campagne : un tableau à un élément n'ajouterait rien à ce que `channel` dit déjà, et ferait
   * passer par la validation de chaîne une campagne qui n'en a pas.
   */
  it('un canal seul n envoie aucune chaine', () => {
    const e = entreeDeCreation(ETAT, [{ rang: 1, canal: 'whatsapp' }], CTX);
    expect(e.chaine).toBeUndefined();
  });

  /**
   * 🔴 UNE CAMPAGNE RCS N'A PAS DE NUMÉRO META, et le serveur l'exige dans l'autre sens : `phoneNumberId`
   * requis hors RCS, vide sur RCS. Recopier le numéro ici ferait créer une campagne RCS attachée à un
   * numéro WhatsApp, ce que rien à l'écran ne montrerait.
   */
  it('un premier etage RCS part sans numero Meta et sans template', () => {
    const rcsDAbord: EtageAssistant[] = [{ rang: 1, canal: 'rcs' }, { rang: 2, canal: 'whatsapp' }];
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: {
        1: { formule: 'seul', texteRcs: 'coucou', suggestions: [] },
        2: { formule: 'seul', templateName: 'promo', templateLanguage: 'fr', suggestions: [] },
      },
    };
    const e = entreeDeCreation(etat, rcsDAbord, CTX);
    expect(e.channel).toBe('rcs');
    expect(e.phoneNumberId).toBe('');
    expect(e.templateName).toBeUndefined();
    expect(e.rcsMessage).toEqual({ kind: 'text', text: 'coucou' });
  });

  // ⚠️ L'agent RCS voyage avec la campagne DÈS QU'UN étage part en RCS, même si la campagne est WhatsApp :
  // sans lui, `senderForCampaign` rendrait null le jour où le repli partira.
  it('un repli RCS emporte l agent RCS meme sur une campagne WhatsApp', () => {
    expect(entreeDeCreation(ETAT, CHAINE, CTX).rcsAgentId).toBe('ag-1');
  });

  it('sans etage RCS, aucun agent RCS n est envoye', () => {
    const e = entreeDeCreation(ETAT, [{ rang: 1, canal: 'whatsapp' }], CTX);
    expect(e.rcsAgentId).toBeUndefined();
  });

  // ⚠️ `assignationUserId` NE VOYAGE QU'AVEC `personne` : sur un tour de rôle, le serveur l'ignore, et
  // l'envoyer laisserait croire à l'écran qu'il a été enregistré.
  it('le tour de role n emporte aucune personne designee', () => {
    const e = entreeDeCreation({ ...ETAT, assignation: 'tour_de_role', assignationUserId: 'u-1' }, CHAINE, CTX);
    expect(e.assignation).toBe('tour_de_role');
    expect(e.assignationUserId).toBeUndefined();
  });

  it('sans assignation, aucune assignation n est envoyee', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.assignation).toBeUndefined();
  });

  // 🔴 DEUX COLONNES INDÉPENDANTES, ET C'EST TOUT LE SUJET DU RETOUR EN ARRIÈRE DU 2026-09-12. L'écran a
  // porté une journée trois « intentions » qui mélangeaient débit et horaires ; la jauge et la question
  // horaire sont deux réglages distincts, et une campagne « heures ouvrées » garde SON débit.
  it('la jauge part telle quelle, et la question horaire ne la touche pas', () => {
    expect(entreeDeCreation(ETAT, CHAINE, CTX).ratePerMinute).toBe(60);
    const e = entreeDeCreation({ ...ETAT, heuresOuvrees: true, debitParMinute: 12 }, CHAINE, CTX);
    expect(e.businessHoursOnly).toBe(true);
    expect(e.ratePerMinute).toBe(12);
  });

  // ⚠️ L'AUTRE SENS : un écran qui enverrait toujours `businessHoursOnly: true` passerait le cas du dessus.
  it('sans la case, aucune contrainte d horaire ne part', () => {
    expect(entreeDeCreation(ETAT, CHAINE, CTX).businessHoursOnly).toBe(false);
  });

  // 🔴 UN DÉBIT HORS BORNES FERAIT REFUSER LA CAMPAGNE ENTIÈRE par le serveur, sur un nombre qu'aucun
  // écran n'a montré (un état repris d'une adresse ou d'un brouillon peut sortir de la jauge).
  it('un debit hors bornes est ramene avant de partir', () => {
    expect(entreeDeCreation({ ...ETAT, debitParMinute: 500 }, CHAINE, CTX).ratePerMinute).toBe(80);
  });

  // 🔴 L'AUDIENCE VOYAGE EN FILTRES, PAS EN IDENTIFIANTS. C'est ce qui retire le piège des grosses
  // sélections : « tout sélectionner » rapatriait jusqu'à 100 000 identifiants et la création échouait
  // vers 25 000 sur le plafond de 1 Mo du corps de requête, bien avant la limite annoncée à l'écran.
  it('l audience part en filtres, jamais en liste d identifiants', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.contactTarget).toEqual({ filters: { tags: ['vip'] }, excludeIds: [] });
    expect(e.contactIds).toBeUndefined();
  });

  // 🔴 L'AUTRE SENS, ET C'EST LE DÉFAUT QUE CE LOT FERME. L'assistant posait `contactTarget: { filters }`
  // et RIEN D'AUTRE : une sélection ligne à ligne était affichée, comptée, et jamais envoyée, donc la
  // campagne partait à tout ce que les filtres décrivent. Les deux formes sont exclusives, le serveur
  // refuse de recevoir les deux.
  // 🔴 UNE LISTE EXPLICITEMENT VIDE NE PART PAS. Le serveur refuse en 422, donc rien ne part à tout
  // l'espace ; ce qu'on évite est un aller-retour et un message rouge pour un cas que l'écran a sous les
  // yeux. ⚠️ Et SEULEMENT en mode liste : en mode « tout ce qui correspond », le nombre dépend d'un
  // compte serveur que cette fonction pure n'a pas, y deviner zéro bloquerait une campagne valide.
  it('une liste vide est refusee AVANT l appel, un mode « tout » ne l est jamais', () => {
    expect(problemeAvantLancement(ETAT, CHAINE, { ...CTX, selection: selectionVide() }))
      .toMatch(/Aucun contact n’est sélectionné/);
    expect(problemeAvantLancement(ETAT, CHAINE, { ...CTX, selection: selectionTout() })).toBeNull();
  });

  it('une selection ligne a ligne part en identifiants, et PAS en filtres', () => {
    const selection = { ...selectionVide(), selected: new Set(['c1', 'c2']) };
    const e = entreeDeCreation(ETAT, CHAINE, { ...CTX, selection });
    expect(e.contactIds).toEqual(['c1', 'c2']);
    expect(e.contactTarget).toBeUndefined();
  });

  // ⚠️ LES EXCLUSIONS VOYAGENT AVEC LES FILTRES : les perdre ferait viser quelqu'un que l'opérateur avait
  // explicitement retiré, c'est-à-dire envoyer à PLUS de monde que ce qu'il a validé.
  it('les exclusions accompagnent les filtres', () => {
    const selection = { ...selectionTout(), exclus: new Set(['c9']) };
    const e = entreeDeCreation(ETAT, CHAINE, { ...CTX, selection });
    expect(e.contactTarget).toEqual({ filters: { tags: ['vip'] }, excludeIds: ['c9'] });
  });

  // ⚠️ Une suggestion RCS ajoutée puis laissée vierge ferait refuser TOUT le message par le schéma
  // serveur (`text` non vide) : on l'écarte, on ne fait pas échouer l'envoi pour un bouton oublié.
  it('une suggestion RCS sans libelle est ecartee, pas envoyee', () => {
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: {
        ...ETAT.contenus,
        2: {
          formule: 'seul', texteRcs: 'coucou',
          suggestions: [
            { kind: 'reply', text: '  ', postbackData: 'p1' },
            { kind: 'reply', text: 'Oui', postbackData: 'p2' },
          ],
        },
      },
    };
    const e = entreeDeCreation(etat, CHAINE, CTX);
    const msg = e.chaine?.[1]?.rcsMessage;
    expect(msg && 'suggestions' in msg ? msg.suggestions : undefined).toHaveLength(1);
  });
});

describe('problemeAvantLancement', () => {
  it('ne retient rien quand tout est rempli', () => {
    expect(problemeAvantLancement(ETAT, CHAINE, CTX)).toBeNull();
  });

  it('refuse une campagne sans nom', () => {
    expect(problemeAvantLancement({ ...ETAT, nom: '   ' }, CHAINE, CTX)).toMatch(/nom/i);
  });

  it('refuse un etage RCS sans agent RCS', () => {
    expect(problemeAvantLancement(ETAT, CHAINE, { ...CTX, rcsAgentId: null })).toMatch(/agent RCS/);
  });

  // 🔴 Chaque étage est contrôlé, pas seulement le premier : un repli sans contenu partirait vide.
  it('refuse un etage e-mail sans modele', () => {
    const etat: EtatPourCreation = { ...ETAT, contenus: { ...ETAT.contenus, 3: { formule: 'seul', suggestions: [] } } };
    expect(problemeAvantLancement(etat, CHAINE, CTX)).toMatch(/étage 3/);
  });

  it('refuse un etage RCS sans message', () => {
    const etat: EtatPourCreation = { ...ETAT, contenus: { ...ETAT.contenus, 2: { formule: 'seul', texteRcs: '  ', suggestions: [] } } };
    expect(problemeAvantLancement(etat, CHAINE, CTX)).toMatch(/étage 2/);
  });

  // ⚠️ Un étage WhatsApp « avec scénario » n'a PAS besoin qu'on lui CHOISISSE un template : exiger les
  // deux refuserait une campagne parfaitement valide, et c'est le sens du repli le plus utilisé.
  // ⚠️ `modeleDuScenario` n'est PAS ce template-là : c'est celui que l'écran DÉDUIT du premier bloc du
  // graphe. La fixture le porte depuis le 2026-09-13, parce que la garde neuve le réclame ; le cas
  // exercé ici ne change pas, il prouve toujours qu'aucun `templateName` n'est exigé.
  it('un etage a scenario n exige pas de modele WhatsApp CHOISI a la main', () => {
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: {
        ...ETAT.contenus,
        1: { formule: 'avec_scenario', workflowId: 'wf-1', modeleDuScenario: { name: 'promo', language: 'fr' }, suggestions: [] },
      },
    };
    expect(etat.contenus[1]?.templateName).toBeUndefined();
    expect(problemeAvantLancement(etat, CHAINE, CTX)).toBeNull();
  });

  it('mais un etage a scenario SANS scenario est refuse', () => {
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: { ...ETAT.contenus, 1: { formule: 'avec_scenario', suggestions: [] } },
    };
    expect(problemeAvantLancement(etat, CHAINE, CTX)).toMatch(/scénario/);
  });

  it('refuse un premier etage WhatsApp quand l espace n a aucun numero', () => {
    expect(problemeAvantLancement(ETAT, CHAINE, { ...CTX, phoneNumberId: '' })).toMatch(/numéro/i);
  });
});

describe('l etage e-mail et son champ d adresse', () => {
  /**
   * 🔴 `contacts` N'A PAS DE COLONNE `email` : l'adresse vit dans le jsonb `fields`, sous un nom que le
   * client choisit (un espace dit « mail », un autre « email »). La clé voyage donc AVEC l'étage, sans
   * quoi il serait enregistré puis SAUTÉ à chaque bascule, en silence.
   */
  it('la cle du champ d adresse voyage avec l etage e-mail', () => {
    expect(entreeDeCreation(ETAT, CHAINE, CTX).chaine?.[2]?.emailChamp).toBe('email');
  });

  // ⚠️ ET SEULEMENT SUR L'ÉTAGE E-MAIL : la poser sur un étage WhatsApp ou RCS écrirait en base un
  // réglage que rien ne lit, donc une seconde vérité sur ce que fait cet étage.
  it('elle ne voyage pas sur les autres etages', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.chaine?.[0]?.emailChamp).toBeUndefined();
    expect(e.chaine?.[1]?.emailChamp).toBeUndefined();
  });

  it('sans champ d adresse, le lancement est refuse avant l appel', () => {
    expect(problemeAvantLancement(ETAT, CHAINE, { ...CTX, champEmail: null })).toMatch(/adresse/i);
  });

  // ⚠️ L'AUTRE SENS : une chaîne SANS étage e-mail n'a que faire du champ d'adresse, et l'exiger
  // bloquerait le repli le plus courant du produit (WhatsApp puis RCS).
  it('une chaine sans etage e-mail se lance sans champ d adresse', () => {
    const sansEmail: EtageAssistant[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }];
    expect(problemeAvantLancement(ETAT, sansEmail, { ...CTX, champEmail: null })).toBeNull();
  });
});

/**
 * LES VARIABLES DU MODÈLE, C'EST-À-DIRE `paramMapping`.
 *
 * 🔴 C'EST LE SEUL REFUS DE CET ÉCRAN DONT LE COÛT EST GLOBAL. Un modèle qui porte `{{1}}` envoyé
 * avec zéro paramètre fait refuser la CAMPAGNE ENTIÈRE par Meta, pas un destinataire : c'est ce qui a
 * tenu l'assistant hors service tant qu'il n'envoyait aucun mapping.
 */
describe('les variables du modèle', () => {
  const AVEC_VARIABLES: ContexteDeCreation = { ...CTX, variablesDuModele: { 1: 2 } };
  const DEUX_LIGNES = [
    { sel: 'sys:prenom', value: '' },
    { sel: 'literal', value: 'Paris' },
  ];
  const etatAvecVariables = (lignes: Array<{ sel: string; value: string }>): EtatPourCreation => ({
    ...ETAT,
    contenus: { ...ETAT.contenus, 1: { ...ETAT.contenus[1]!, variables: lignes } },
  });

  it('un modele a variables produit un paramMapping complet', () => {
    const e = entreeDeCreation(etatAvecVariables(DEUX_LIGNES), CHAINE, AVEC_VARIABLES);
    expect(e.paramMapping).toHaveLength(2);
    expect(e.paramMapping).toEqual([
      { position: 1, source: { type: 'field', key: 'prenom' } },
      { position: 2, source: { type: 'literal', value: 'Paris' } },
    ]);
  });

  // 🔴 LE CAS QUI PROTEGE LE CLIENT : une variable non associee ne part PAS en silence.
  it('une variable laissee sans association empeche le lancement, avec sa raison', () => {
    const v = problemeAvantLancement(etatAvecVariables([DEUX_LIGNES[0]!]), CHAINE, AVEC_VARIABLES);
    expect(v).toMatch(/variable/i);
    expect(v).toMatch(/étage 1/);
  });

  // ⚠️ L'AUTRE FORME DU MÊME REFUS : un « texte fixe » choisi puis laissé à blanc est un paramètre VIDE,
  // que Meta refuse aussi. Sans ce cas, une implémentation qui ne compterait que les lignes passerait.
  it('un texte fixe laisse vide empeche le lancement', () => {
    const vide = [DEUX_LIGNES[0]!, { sel: 'literal', value: '   ' }];
    expect(problemeAvantLancement(etatAvecVariables(vide), CHAINE, AVEC_VARIABLES)).toMatch(/vide/i);
  });

  it('les deux lignes associees ne retiennent rien', () => {
    expect(problemeAvantLancement(etatAvecVariables(DEUX_LIGNES), CHAINE, AVEC_VARIABLES)).toBeNull();
  });

  it('un modele SANS variable ne produit aucun mapping, et reste creable', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.paramMapping).toEqual([]);
    expect(problemeAvantLancement(ETAT, CHAINE, CTX)).toBeNull();
  });

  /**
   * ⚠️ UN MODÈLE INCONNU NE VAUT PAS « ZÉRO VARIABLE ». La liste des modèles peut n'être pas chargée, ou
   * le graphe d'un scénario illisible : se taire laisse le serveur trancher, compter zéro enverrait le
   * mapping vide qu'on cherche justement à empêcher.
   */
  it('un modele dont on ignore le nombre de variables ne bloque pas le lancement', () => {
    expect(problemeAvantLancement(etatAvecVariables([]), CHAINE, CTX)).toBeNull();
  });

  /**
   * 🔴 UN ÉTAGE DE REPLI À VARIABLES EST REFUSÉ, ET CE N'EST PAS UNE PRUDENCE : rien ne peut porter son
   * mapping. `campaigns.param_mapping` décrit le rang 1, `campaign_etages` n'a pas de colonne pour un
   * second, et `resolved_params` est calculé une seule fois depuis ce mapping unique.
   */
  it('un etage de repli sur un modele a variables est refuse, avec sa raison', () => {
    const rcsDAbord = [{ rang: 1, canal: 'rcs' as const }, { rang: 2, canal: 'whatsapp' as const }];
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: {
        1: { formule: 'seul', texteRcs: 'coucou', suggestions: [] },
        2: { formule: 'seul', templateName: 'promo', templateLanguage: 'fr', suggestions: [], variables: DEUX_LIGNES },
      },
    };
    const v = problemeAvantLancement(etat, rcsDAbord, { ...CTX, variablesDuModele: { 2: 2 } });
    expect(v).toMatch(/étage 2/);
    expect(v).toMatch(/repli/i);
  });

  // ⚠️ L'AUTRE SENS : un repli sur un modèle SANS variable reste parfaitement lançable. Sans ce cas, un
  // refus posé sur tout étage WhatsApp de rang 2 passerait le test du dessus.
  it('un repli sur un modele sans variable reste lancable', () => {
    const rcsDAbord = [{ rang: 1, canal: 'rcs' as const }, { rang: 2, canal: 'whatsapp' as const }];
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: {
        1: { formule: 'seul', texteRcs: 'coucou', suggestions: [] },
        2: { formule: 'seul', templateName: 'simple', templateLanguage: 'fr', suggestions: [] },
      },
    };
    expect(problemeAvantLancement(etat, rcsDAbord, { ...CTX, variablesDuModele: { 2: 0 } })).toBeNull();
  });

  /**
   * ⚠️ UNE CAMPAGNE RCS N'A PAS DE VARIABLES DE MODÈLE. Recopier ici les associations d'un étage WhatsApp
   * de repli ferait écarter, dès la création, les contacts à qui il manque une valeur dont le premier
   * étage n'a que faire (`buildRecipients` saute un contact sans valeur).
   */
  it('un premier etage RCS part avec un paramMapping vide', () => {
    const rcsDAbord = [{ rang: 1, canal: 'rcs' as const }, { rang: 2, canal: 'whatsapp' as const }];
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: {
        1: { formule: 'seul', texteRcs: 'coucou', suggestions: [] },
        2: { formule: 'seul', templateName: 'promo', templateLanguage: 'fr', suggestions: [], variables: DEUX_LIGNES },
      },
    };
    expect(entreeDeCreation(etat, rcsDAbord, CTX).paramMapping).toEqual([]);
  });

  /**
   * ⚠️ UNE CAMPAGNE DE SCÉNARIO EMPORTE AUSSI SON MAPPING : le premier envoi du parcours reçoit ces
   * variables déjà résolues et les utilise telles quelles, sans relire les indices du modèle
   * (`explicitParams`, `src/workflow/wiring.ts`). Un mapping vide y produit le même refus global.
   */
  it('une campagne de scenario emporte le mapping du modele par lequel il ouvre', () => {
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: {
        ...ETAT.contenus,
        1: {
          formule: 'avec_scenario', workflowId: 'wf-1', suggestions: [],
          modeleDuScenario: { name: 'ouverture', language: 'fr' },
          variables: DEUX_LIGNES,
        },
      },
    };
    const e = entreeDeCreation(etat, CHAINE, AVEC_VARIABLES);
    expect(e.workflowId).toBe('wf-1');
    expect(e.templateName).toBeUndefined();
    expect(e.paramMapping).toHaveLength(2);
  });
});

/**
 * QUEL MODÈLE UN ÉTAGE ENVOIE, ET COMBIEN DE VARIABLES IL PORTE.
 *
 * 🔴 DEUX ÉCRANS LISENT CETTE RÈGLE (l'étape Contenu pour AFFICHER les lignes, le récapitulatif pour
 * les COMPTER) : si elles divergeaient, l'écran proposerait d'associer un modèle et la garde en
 * compterait un autre.
 */
describe('modeleDeLEtage et variablesParRang', () => {
  const MODELES = [{ name: 'promo', body: 'Bonjour {{1}}, voici {{2}}' }, { name: 'simple', body: 'Bonjour' }];

  it('en formule « seul », c est le modele de l etage', () => {
    expect(modeleDeLEtage({ formule: 'seul', templateName: 'promo', suggestions: [] })).toEqual({ name: 'promo' });
  });

  // 🔴 EN FORMULE « SCÉNARIO », CE N'EST PAS LE MODÈLE DU SÉLECTEUR : la campagne ne l'envoie pas, elle
  // démarre un parcours dont le premier bloc envoie SON modèle, et ce sont SES variables qu'il faut fournir.
  it('en formule « scenario », c est le modele par lequel le scenario ouvre', () => {
    expect(modeleDeLEtage({
      formule: 'avec_scenario', templateName: 'promo', suggestions: [],
      modeleDuScenario: { name: 'ouverture', language: 'fr' },
    })).toEqual({ name: 'ouverture', language: 'fr' });
  });

  it('un scenario dont le modele n a pas ete lu ne designe aucun modele', () => {
    expect(modeleDeLEtage({ formule: 'avec_scenario', workflowId: 'wf-1', suggestions: [] })).toBeNull();
  });

  it('compte les variables du modele de chaque etage WhatsApp', () => {
    const table = variablesParRang(CHAINE, { 1: { formule: 'seul', templateName: 'promo', suggestions: [] } }, MODELES);
    expect(table).toEqual({ 1: 2 });
  });

  // ⚠️ UN MODÈLE INTROUVABLE N'ENTRE PAS DANS LA TABLE, il n'y entre pas à zéro : « on ne sait pas » et
  // « il n'en a pas » appellent des décisions opposées côté garde.
  it('un modele introuvable est ABSENT de la table, pas a zero', () => {
    const table = variablesParRang(CHAINE, { 1: { formule: 'seul', templateName: 'inconnu', suggestions: [] } }, MODELES);
    expect(table).toEqual({});
    expect(1 in table).toBe(false);
  });

  it('un modele sans variable y entre bien a zero', () => {
    const table = variablesParRang(CHAINE, { 1: { formule: 'seul', templateName: 'simple', suggestions: [] } }, MODELES);
    expect(table).toEqual({ 1: 0 });
  });
});

/**
 * LE MOMENT DU LANCEMENT.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : `runCampaign` SANS date LANCE IMMÉDIATEMENT. Une implémentation qui
 * validerait la date d'un côté et rendrait `undefined` de l'autre enverrait donc une campagne programmée
 * pour la semaine prochaine sur-le-champ, à des gens réels. Chaque cas ci-dessous sépare une
 * implémentation juste d'une fausse qui lui ressemble.
 */
describe('momentDuLancement', () => {
  // L'horloge est INJECTÉE : ces cas ne dépendent pas de l'heure de la machine qui les exécute.
  const MAINTENANT = new Date('2026-09-13T10:00:00Z').getTime();

  it('« maintenant » ne porte aucune date', () => {
    expect(momentDuLancement({ quand: 'maintenant', dateLocale: '' }, MAINTENANT)).toEqual({ maintenant: true });
  });

  /**
   * 🔴 LE CAS QUI SÉPARE : une date SAISIE mais le mode resté sur « maintenant » ne programme RIEN. Une
   * implémentation qui lirait `dateLocale` sans regarder `quand` programmerait une campagne que
   * l'opérateur a décidé d'envoyer tout de suite, après avoir changé d'avis.
   */
  it('une date saisie puis abandonnee ne programme rien', () => {
    expect(momentDuLancement({ quand: 'maintenant', dateLocale: '2026-12-25T10:00' }, MAINTENANT))
      .toEqual({ maintenant: true });
  });

  it('« plus tard » sans date est un refus, pas un depart immediat', () => {
    const m = momentDuLancement({ quand: 'plus_tard', dateLocale: '' }, MAINTENANT);
    expect(m).toEqual({ probleme: expect.stringMatching(/date/i) });
  });

  it('une date illisible est un refus', () => {
    const m = momentDuLancement({ quand: 'plus_tard', dateLocale: 'jeudi prochain' }, MAINTENANT);
    expect('probleme' in m).toBe(true);
  });

  /**
   * 🔴 UNE DATE PASSÉE EST REFUSÉE, PAS RAMENÉE À MAINTENANT. « Je me suis trompé d'un jour » doit se
   * corriger, pas s'envoyer : les deux gestes n'ont pas le même coût, et l'un des deux est irréversible.
   */
  it('une date passee est refusee, jamais ramenee a maintenant', () => {
    const m = momentDuLancement({ quand: 'plus_tard', dateLocale: '2020-01-01T10:00' }, MAINTENANT);
    expect(m).toEqual({ probleme: expect.stringMatching(/futur/i) });
  });

  it('une date future rend l instant ABSOLU', () => {
    const m = momentDuLancement({ quand: 'plus_tard', dateLocale: '2026-12-25T10:30' }, MAINTENANT);
    // ⚠️ Comparé à ce que le navigateur ferait de la même saisie : `datetime-local` est lu en heure
    // LOCALE, et l'attendu ne doit donc pas figer un fuseau.
    expect(m).toEqual({ iso: new Date('2026-12-25T10:30').toISOString() });
  });

  // ⚠️ L'INSTANT EXACT N'EST PAS « DANS LE FUTUR » : une égalité stricte ferait passer une date déjà
  // consommée le temps de l'aller-retour réseau.
  it('l instant exact n est pas dans le futur', () => {
    const localeMaintenant = new Date(MAINTENANT);
    const saisie = `${localeMaintenant.getFullYear()}-${String(localeMaintenant.getMonth() + 1).padStart(2, '0')}-${String(localeMaintenant.getDate()).padStart(2, '0')}T${String(localeMaintenant.getHours()).padStart(2, '0')}:${String(localeMaintenant.getMinutes()).padStart(2, '0')}`;
    const m = momentDuLancement({ quand: 'plus_tard', dateLocale: saisie }, new Date(saisie).getTime());
    expect('probleme' in m).toBe(true);
  });

  // Le bouton de lancement ne doit pas être actif sur une date que le lancement refuserait : la garde
  // relaie donc ce refus, elle n'en a pas une seconde de son côté.
  it('la garde de lancement relaie le refus de programmation', () => {
    const etat: EtatPourCreation = { ...ETAT, quand: 'plus_tard', dateLocale: '' };
    expect(problemeAvantLancement(etat, CHAINE, CTX, MAINTENANT)).toMatch(/date/i);
  });
});

/**
 * LA CAMPAGNE AU FIL DE L'EAU.
 *
 * 🔴 CE QUI SE VÉRIFIE ICI EST LE CORPS DE LA REQUÊTE, pas ce que l'écran montre. Le serveur refuse de
 * recevoir à la fois une adresse et une liste, et une implémentation qui enverrait les deux ferait croire
 * que la liste part alors que seule l'adresse compte.
 */
describe('au fil de l eau', () => {
  const FIL: ContexteDeCreation = { ...CTX, webhookId: 'wh-1' };

  it('le corps emporte l adresse et AUCUNE cible de contacts', () => {
    const e = entreeDeCreation(ETAT, CHAINE, FIL);
    expect(e.webhookId).toBe('wh-1');
    expect(e.contactIds).toBeUndefined();
    expect(e.contactTarget).toBeUndefined();
  });

  // 🔴 L'AUTRE SENS, sans quoi une implémentation qui poserait TOUJOURS `webhookId` passerait le cas
  // du dessus : une campagne sur liste n'emporte aucune adresse.
  it('une campagne sur liste n emporte aucune adresse', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.webhookId).toBeUndefined();
    expect(e.contactTarget).toBeDefined();
  });

  // Même sens, en mode LISTE explicite : la cible reste `contactIds`, l'adresse reste absente.
  it('une selection ligne a ligne n emporte aucune adresse non plus', () => {
    const liste: ContexteDeCreation = { ...CTX, selection: { toutFiltre: false, selected: new Set(['c1']), exclus: new Set() } };
    const e = entreeDeCreation(ETAT, CHAINE, liste);
    expect(e.contactIds).toEqual(['c1']);
    expect(e.webhookId).toBeUndefined();
  });

  it('une adresse non choisie est refusee, avec sa raison', () => {
    expect(problemeAvantLancement(ETAT, CHAINE, { ...CTX, webhookId: '' })).toMatch(/adresse/i);
  });

  /**
   * 🔴 LE CAS QUI SÉPARE L'IMPLÉMENTATION JUSTE DE LA FAUSSE. Naître SANS destinataire est l'état NORMAL
   * d'une campagne au fil de l'eau : une implémentation qui garderait la garde « aucun contact
   * sélectionné » refuserait ici la seule création valide que ce mode connaisse.
   */
  it('aucun contact coche n empeche PAS un lancement au fil de l eau', () => {
    const rien: ContexteDeCreation = { ...FIL, selection: selectionVide() };
    expect(problemeAvantLancement(ETAT, CHAINE, rien)).toBeNull();
  });

  // ⚠️ ET LA GARDE RESTE ENTIÈRE SUR UNE LISTE : sans ce cas, la retirer pour tout le monde passerait
  // le cas du dessus.
  it('aucun contact coche reste un refus sur une campagne a liste', () => {
    const rien: ContexteDeCreation = { ...CTX, selection: selectionVide() };
    expect(problemeAvantLancement(ETAT, CHAINE, rien)).toMatch(/sélectionné/i);
  });
});

/**
 * LE VISUEL D'UN ÉTAGE RCS.
 *
 * 🔴 CE QUI SE VÉRIFIE ICI EST LE CORPS DE LA REQUÊTE, pas l'écran. Un écran peut afficher un visuel, le
 * téléverser, l'afficher en aperçu, et n'en rien envoyer : c'est exactement ce que faisait cet assistant,
 * dont le constructeur de message était un littéral `kind: 'text'`. Le visuel ne changeait donc RIEN, en
 * silence, et seul un test qui lit `rcsMessage` pouvait le dire.
 */
describe('le visuel d un etage RCS', () => {
  const CHAINE_RCS: EtageAssistant[] = [{ rang: 1, canal: 'rcs' }, { rang: 2, canal: 'whatsapp' }];
  const avecRcs = (rcs: Record<string, unknown>): EtatPourCreation => ({
    ...ETAT,
    contenus: {
      1: { formule: 'seul', texteRcs: 'coucou', suggestions: [], ...rcs },
      2: { formule: 'seul', templateName: 'promo', templateLanguage: 'fr', suggestions: [] },
    },
  });

  it('un visuel fait partir le message en CARTE, avec l image', () => {
    const e = entreeDeCreation(avecRcs({ imageRcs: 'https://exemple.fr/v.jpg' }), CHAINE_RCS, CTX);
    expect(e.rcsMessage).toMatchObject({
      kind: 'card',
      card: { description: 'coucou', mediaUrl: 'https://exemple.fr/v.jpg', mediaHeight: 'TALL' },
    });
  });

  // 🔴 L'AUTRE SENS, sans quoi une implémentation qui produirait TOUJOURS une carte passerait le cas du
  // dessus : sans visuel, le message reste un TEXTE, qui est la forme historique de ce produit.
  it('sans visuel, le message reste un TEXTE', () => {
    const e = entreeDeCreation(avecRcs({}), CHAINE_RCS, CTX);
    expect(e.rcsMessage).toEqual({ kind: 'text', text: 'coucou' });
  });

  /**
   * 🔴 OÙ SONT ACCROCHÉS LES BOUTONS DÉCIDE DE LEUR APPARENCE, et ce n'est pas nous qui la dessinons.
   * Dans la carte, ce sont des boutons pleine largeur qui RESTENT ; sous la bulle, des pastilles qui
   * disparaissent dès que la conversation avance. Un littéral `kind: 'text'` les mettait toujours en
   * pastilles, y compris sur une campagne à visuel.
   */
  it('avec un visuel, les boutons partent DANS la carte', () => {
    const e = entreeDeCreation(
      avecRcs({ imageRcs: 'https://exemple.fr/v.jpg', suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'p1' }] }),
      CHAINE_RCS, CTX,
    );
    expect(e.rcsMessage).toMatchObject({ card: { suggestions: [{ text: 'Oui' }] } });
    expect((e.rcsMessage as { suggestions?: unknown }).suggestions).toBeUndefined();
  });

  it('sans visuel, les memes boutons partent en pastilles sous la bulle', () => {
    const e = entreeDeCreation(
      avecRcs({ suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'p1' }] }),
      CHAINE_RCS, CTX,
    );
    expect(e.rcsMessage).toMatchObject({ kind: 'text', suggestions: [{ text: 'Oui' }] });
  });

  /**
   * 🔴 LE PLAFOND DE TEXTE BAISSE QUAND ON AJOUTE UN VISUEL (3 072 -> 2 000, la borne du champ
   * `description` chez l'opérateur). Un texte déjà saisi ne se raccourcit pas tout seul : sans cette
   * garde, ajouter l'image à la fin ferait échouer la création avec un « content invalide » que personne
   * ne saurait relier à ce geste.
   */
  it('un texte de 2500 caracteres passe SANS visuel et est refuse AVEC', () => {
    const long = 'a'.repeat(2500);
    expect(problemeAvantLancement(avecRcs({ texteRcs: long }), CHAINE_RCS, CTX)).toBeNull();
    const v = problemeAvantLancement(avecRcs({ texteRcs: long, imageRcs: 'https://exemple.fr/v.jpg' }), CHAINE_RCS, CTX);
    expect(v).toMatch(/2000/);
    expect(v).toMatch(/étage 1/);
  });

  // ⚠️ UN BOUTON INCOMPLET FAIT REFUSER TOUT LE MESSAGE côté serveur, pas seulement le bouton : le lien
  // sans adresse est le cas courant, et il se voit à l'écran bien avant l'envoi.
  it('un bouton de lien sans adresse est refuse, avec sa raison', () => {
    const v = problemeAvantLancement(
      avecRcs({ suggestions: [{ kind: 'openUrl', text: 'Voir', url: '  ', postbackData: 'p1' }] }),
      CHAINE_RCS, CTX,
    );
    expect(v).toMatch(/bouton/i);
  });

  // ⚠️ L'AUTRE SENS : le même bouton, complet, ne bloque rien.
  it('le meme bouton complet ne bloque rien', () => {
    expect(problemeAvantLancement(
      avecRcs({ suggestions: [{ kind: 'openUrl', text: 'Voir', url: 'https://exemple.fr', postbackData: 'p1' }] }),
      CHAINE_RCS, CTX,
    )).toBeNull();
  });
});

/**
 * LES DEUX RÈGLES QUE L'ÉCRAN NE PEUT PAS TENIR SEUL (2026-09-13, essai réel de Julien).
 *
 * 🔴 ELLES SE TESTENT ICI, AU POINT D'ENVOI, ET C'EST TOUT L'INTÉRÊT. L'écran masquait déjà le bloc du
 * réessai sur une formule « avec repli », mais masquer n'efface pas : la case cochée en WhatsApp
 * survivait à la bascule et partait vers le serveur. C'est le motif déjà payé DEUX fois sur ce chantier,
 * « l'écran affiche ce que la requête n'envoie pas », et la parade est celle qui est écrite dans
 * `wip.md` : au moins un test lit le CORPS de la requête.
 */
describe('ce qui part vraiment, quand l ecran a cache la question', () => {
  const SEUL: EtageAssistant[] = [{ rang: 1, canal: 'whatsapp' }];

  it('🔴 une chaine de repli n emporte AUCUN reessai, meme case cochee', () => {
    // ETAT.reessayer vaut true, et CHAINE porte trois etages.
    expect(ETAT.reessayer).toBe(true);
    expect(entreeDeCreation(ETAT, CHAINE, CTX).reessayer).toBe(false);
  });

  it('sur un canal seul, le choix de l operateur est respecte', () => {
    expect(entreeDeCreation(ETAT, SEUL, CTX).reessayer).toBe(true);
    expect(entreeDeCreation({ ...ETAT, reessayer: false }, SEUL, CTX).reessayer).toBe(false);
  });

  /**
   * 🔴 LE SENS EST INVERSE, ET C'EST EXACTEMENT LA OU L'ON SE TROMPE. `rattrapage_hors_horaires` a vrai
   * veut dire « le rattrapage S'AFFRANCHIT des horaires ». Cocher « heures ouvrees » doit donc l'ETEINDRE.
   * Un test qui ne verifierait qu'un seul des deux sens passerait sur l'implementation inversee.
   */
  it('🔴 « heures ouvrees » coche eteint l affranchissement du rattrapage', () => {
    expect(entreeDeCreation({ ...ETAT, heuresOuvrees: true }, CHAINE, CTX).rattrapageHorsHoraires).toBe(false);
  });

  it('🔴 et decoche, le rattrapage part a toute heure comme l envoi initial', () => {
    expect(entreeDeCreation({ ...ETAT, heuresOuvrees: false }, CHAINE, CTX).rattrapageHorsHoraires).toBe(true);
  });
});

/**
 * 🔴 LE BUG DU 2026-09-13 : « Modele et scenario » demandait DEUX choix au lieu d un.
 *
 * L ecran laissait le selecteur de Modele affiche a cote de celui du scenario. Ce n etait pas une
 * question de trop : `choisirModele` ECRASE `variables` avec les lignes du modele choisi a la main,
 * alors que le modele qui PART est celui du premier bloc du scenario. Le paramMapping ne decrivait
 * donc plus le modele envoye, et Meta refuse la campagne ENTIERE sur un compte de parametres qui ne
 * correspond pas.
 */
describe('formule « modele et scenario » : le scenario decide, pas un modele choisi a cote', () => {
  const SEUL: EtageAssistant[] = [{ rang: 1, canal: 'whatsapp' }];
  const avecScenario = (contenu: Record<string, unknown>): EtatPourCreation => ({
    ...ETAT,
    contenus: { 1: { formule: 'avec_scenario', suggestions: [], ...contenu } },
  });

  it('🔴 un scenario SANS modele d ouverture est refuse, avec sa raison', () => {
    // Il ouvre par un bloc RCS, par un message de session, ou son graphe n a pas pu etre lu : dans
    // tous les cas il ne peut pas ouvrir une campagne WhatsApp, et ce cas n etait refuse NULLE PART.
    const v = problemeAvantLancement(avecScenario({ workflowId: 'wf1' }), SEUL, CTX);
    expect(v).toMatch(/ne commence pas par un modèle WhatsApp/);
  });

  it('l AUTRE SENS : avec son modele d ouverture, rien ne bloque', () => {
    expect(problemeAvantLancement(
      avecScenario({ workflowId: 'wf1', modeleDuScenario: { name: 'promo', language: 'fr' } }),
      SEUL, CTX,
    )).toBeNull();
  });

  it('sans scenario du tout, c est l autre message qui sort (le cas n est pas avale)', () => {
    expect(problemeAvantLancement(avecScenario({}), SEUL, CTX)).toMatch(/n’a pas de scénario/);
  });

  /**
   * ⚠️ LA GARDE NE MORD QUE SUR WHATSAPP. Un etage RCS en formule scenario n a pas de modele
   * d ouverture par construction : le lui reclamer bloquerait une campagne parfaitement valide.
   */
  it('un etage RCS en formule scenario n est PAS soumis a cette garde', () => {
    const etatRcs: EtatPourCreation = {
      ...ETAT,
      contenus: { 1: { formule: 'avec_scenario', workflowId: 'wf1', texteRcs: 'coucou', suggestions: [] } },
    };
    // `null` = rien ne bloque, ce qui est déjà la preuve que la garde WhatsApp n'a pas mordu.
    expect(problemeAvantLancement(etatRcs, [{ rang: 1, canal: 'rcs' }], CTX)).toBeNull();
  });
});
