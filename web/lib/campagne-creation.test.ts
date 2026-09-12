import { describe, expect, it } from 'vitest';
import { entreeDeCreation, problemeAvantLancement, type ContexteDeCreation, type EtatPourCreation } from './campagne-creation';
import type { EtageAssistant } from './campagne-chaine';

/**
 * CE QUE LE BOUTON « LANCER » ENVOIE VRAIMENT.
 *
 * 🔴 C'EST LA DERNIÈRE TRADUCTION AVANT DES MESSAGES RÉELS. Le récapitulatif se relit à l'œil ; ce qui
 * décide de ce qui PART est cet objet, et une clé posée au mauvais endroit y est invisible à l'écran.
 */
const CTX: ContexteDeCreation = { phoneNumberId: 'pn-1', rcsAgentId: 'ag-1', filtres: { tags: ['vip'] } };

const ETAT: EtatPourCreation = {
  nom: '  Promo rentrée  ',
  category: 'marketing',
  cadence: 'vite',
  reessayer: true,
  rattrapageHorsHoraires: false,
  assignation: 'aucune',
  assignationUserId: null,
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

  // ⚠️ La cadence se traduit en DEUX colonnes (débit et drapeau d'horaires), pas une : c'est
  // `reglagesDeCadence` qui tranche, et l'entrée doit porter les deux.
  it('la cadence « heures ouvrees » pose le drapeau, pas un debit', () => {
    const e = entreeDeCreation({ ...ETAT, cadence: 'ouvrees' }, CHAINE, CTX);
    expect(e.businessHoursOnly).toBe(true);
    expect(e.ratePerMinute).toBeNull();
  });

  // 🔴 L'AUDIENCE VOYAGE EN FILTRES, PAS EN IDENTIFIANTS. C'est ce qui retire le piège des grosses
  // sélections : « tout sélectionner » rapatriait jusqu'à 100 000 identifiants et la création échouait
  // vers 25 000 sur le plafond de 1 Mo du corps de requête, bien avant la limite annoncée à l'écran.
  it('l audience part en filtres, jamais en liste d identifiants', () => {
    const e = entreeDeCreation(ETAT, CHAINE, CTX);
    expect(e.contactTarget).toEqual({ filters: { tags: ['vip'] } });
    expect(e.contactIds).toBeUndefined();
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

  // ⚠️ Un étage WhatsApp « avec scénario » n'a PAS besoin de template : exiger les deux refuserait une
  // campagne parfaitement valide, et c'est le sens du repli le plus utilisé du produit.
  it('un etage a scenario n exige pas de modele WhatsApp', () => {
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: { ...ETAT.contenus, 1: { formule: 'avec_scenario', workflowId: 'wf-1', suggestions: [] } },
    };
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
