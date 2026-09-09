import { describe, it, expect } from 'vitest';
import { assemblerDetailCampagne } from '../src/stats/cout-campagne';
import type { NodeEventCount } from '../src/workflow/node-events.pg';

const TARIFS = { marketing: 0.1431, utility: 0.03, currency: 'EUR' };
const CAMPAGNE = { id: 'c1', nom: 'Promo', template: 'promo', workflowId: null };
const FUNNEL = { sent: 10, failed: 0, replied: 0, buttonReplies: 0, urlClicks: null };

const fiche = (p: Partial<Parameters<typeof assemblerDetailCampagne>[0]> = {}) =>
  assemblerDetailCampagne({
    campagne: CAMPAGNE, envois: [], rates: TARIFS, funnel: FUNNEL, mesures: [], ...p,
  });

/**
 * La fiche d'une campagne, ouverte depuis le tableau du coût (demande de Julien du 2026-09-09).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : le DÉNOMINATEUR. Toute la fiche rapporte des interactions au coût du
 * LANCEMENT, et le lancement n'est pas « ce que la campagne a envoyé » : c'est le PREMIER envoi par
 * personne. La différence n'existe que pour une campagne à scénario, elle est invisible sur les autres, et
 * c'est exactement le genre d'écart qu'aucun compilateur ne voit.
 */
describe('assemblerDetailCampagne — le lancement', () => {
  it('campagne à template direct : tout est lancement, aucune relance', () => {
    const d = fiche({ envois: [{ category: 'marketing', total: 10, lancement: 10 }] });
    expect(d.lancement.envoyes).toBe(10);
    expect(d.lancement.cout).toBeCloseTo(1.43, 2);
    expect(d.relances.envoyes).toBe(0);
    expect(d.relances.cout).toBeNull();
  });

  it('🔴 les RELANCES d’un scénario sont hors du lancement, et chiffrées à part', () => {
    // 10 personnes touchées, 4 relancées : le coût de référence reste celui des 10 premiers envois. Compter
    // les 14 ferait grossir le dénominateur à chaque relance, donc baisser le « coût par interaction » sans
    // qu'une seule interaction de plus ait eu lieu. C'est l'inverse de ce que le chiffre doit dire.
    const d = fiche({ envois: [{ category: 'marketing', total: 14, lancement: 10 }] });
    expect(d.lancement.envoyes).toBe(10);
    expect(d.lancement.cout).toBeCloseTo(1.43, 2);
    expect(d.relances.envoyes).toBe(4);
    expect(d.relances.cout).toBeCloseTo(0.57, 2);
  });

  it('🔴 les ÉCHECS sont comptés à part et n’entrent jamais dans le coût', () => {
    // La question de Julien, entre parenthèses : « tu enlèves bien les failed j'espère ! ». Ils le sont par
    // la population elle-même ; ce champ existe pour que l'écran le MONTRE au lieu de le laisser croire.
    const d = fiche({
      envois: [{ category: 'marketing', total: 10, lancement: 10 }],
      funnel: { ...FUNNEL, sent: 10, failed: 3 },
    });
    expect(d.lancement.echecs).toBe(3);
    expect(d.lancement.envoyes).toBe(10);
    expect(d.lancement.cout).toBeCloseTo(1.43, 2);
  });

  it('🔴 aucun envoi chiffrable -> coût VIDE, jamais zéro, et les deux causes séparées', () => {
    const d = fiche({
      envois: [
        { category: null, total: 7, lancement: 7 },
        { category: 'utility', total: 3, lancement: 3 },
      ],
      rates: { marketing: 0.1431, utility: null, currency: 'EUR' },
    });
    expect(d.lancement.cout).toBeNull();
    expect(d.lancement.sansCategorie).toBe(7);
    expect(d.lancement.sansTarif).toBe(3);
    expect(d.lancement.envoyes).toBe(10);
  });

  it('coût par clic du template de lancement, et les deux cas où il n’existe pas', () => {
    const base = { envois: [{ category: 'marketing', total: 10, lancement: 10 }] };
    expect(fiche({ ...base, funnel: { ...FUNNEL, urlClicks: 4 } }).lancement.coutParClic).toBeCloseTo(0.3575, 4);
    // Aucun lien tracé à mesurer : ce n'est pas « personne n'a cliqué ».
    expect(fiche({ ...base, funnel: { ...FUNNEL, urlClicks: null } }).lancement.coutParClic).toBeNull();
    // Zéro clic mesuré : un ratio serait une division par zéro déguisée en réponse.
    expect(fiche({ ...base, funnel: { ...FUNNEL, urlClicks: 0 } }).lancement.coutParClic).toBeNull();
  });
});

describe('assemblerDetailCampagne — les étapes du scénario', () => {
  const envois = [{ category: 'marketing', total: 20, lancement: 10 }]; // lancement = 1,43 €
  const mes = (nodeId: string, kind: NodeEventCount['kind'], count: number, contacts: number | null, handle: string | null = null): NodeEventCount =>
    ({ nodeId, kind, handle, count, contacts });

  it('🔴 « lu » et « délivré » ne sont PAS des interactions', () => {
    // Ce sont des choses qui ARRIVENT au contact, pas des choses qu'il FAIT. Les compter ferait tomber le
    // coût par interaction à celui d'un envoi, donc ferait passer une campagne que personne n'a lue pour
    // une campagne parfaitement efficace.
    const d = fiche({
      envois,
      mesures: [mes('a', 'sent', 10, 10), mes('a', 'delivered', 9, 9), mes('a', 'read', 8, 8)],
    });
    expect(d.etapes).toHaveLength(1);
    expect(d.etapes[0]!.interactions).toBe(0);
    expect(d.etapes[0]!.coutParInteraction).toBeNull();
    expect(d.etapes[0]!.envoyes).toEqual({ gestes: 10, personnes: 10 });
    expect(d.etapes[0]!.liens).toEqual({ gestes: 0 });
  });

  it('boutons et réponses comptent, dans les DEUX unités, et le ratio se calcule sur les gestes', () => {
    // ⚠️ UNE SEULE LIGNE PAR (BLOC, NATURE), et c'est le CONTRAT du store depuis la revue du 2026-09-09 :
    // il ne regroupe plus par handle, précisément pour que ce module n'ait pas à additionner des comptes
    // de personnes qui se chevauchent. Le contrat lui-même se vérifie contre un vrai Postgres, dans
    // `tests/integration/stats-cout.integration.test.ts` : ici, un faux compteur rendrait ce qu'on lui dicte.
    const d = fiche({
      envois,
      mesures: [
        mes('a', 'sent', 10, 10),
        mes('a', 'reply_button', 8, 6),
        mes('a', 'reply_text', 3, 3),
      ],
    });
    const e = d.etapes[0]!;
    expect(e.boutons).toEqual({ gestes: 8, personnes: 6 });
    expect(e.reponses).toEqual({ gestes: 3, personnes: 3 });
    expect(e.interactions).toBe(11);
    // 1,43 / 11. Sur les GESTES : c'est la seule des trois natures qui les porte toutes.
    expect(e.coutParInteraction).toBeCloseTo(0.13, 4);
  });

  /**
   * 🔴 LES CLICS DE LIEN COMPTENT, ET CE BLOC EXISTE PARCE QUE J AVAIS AFFIRME LE CONTRAIRE.
   *
   * La première version de la fiche refusait cette colonne au motif qu'« un clic n'identifie personne ».
   * La migration 0106 écrit `tracked_link_clicks.contact_id` : c'est vrai d'un lien SANS jeton, faux de
   * tous les autres. Une justification fausse est pire qu'aucune, puisqu'elle se recopie, et celle-là
   * avait servi à écarter une colonne que Julien avait demandée en toutes lettres.
   */
  it('🔴 un clic de lien ATTRIBUÉ est une interaction comme les autres', () => {
    const d = fiche({
      envois,
      mesures: [mes('a', 'sent', 10, 10), mes('a', 'url_click' as never, 5, null)],
    });
    const e = d.etapes[0]!;
    expect(e.liens).toEqual({ gestes: 5 });
    expect(e.interactions).toBe(5);
    // 1,43 / 5.
    expect(e.coutParInteraction).toBeCloseTo(0.286, 3);
  });

  it('les trois natures partagent le MÊME dénominateur', () => {
    const d = fiche({
      envois,
      mesures: [
        mes('a', 'url_click' as never, 4, null),
        mes('a', 'reply_button', 5, 5),
        mes('a', 'reply_text', 2, 2),
      ],
    });
    expect(d.etapes[0]!.interactions).toBe(11);
    expect(d.etapes[0]!.coutParInteraction).toBeCloseTo(0.13, 4);
  });

  it('🔴 les clics ANONYMES sont portés à part, jamais fondus dans une colonne', () => {
    // Ils ont eu lieu, on ne peut les rattacher a personne (template approuvé avant le 2026-09-02, URL
    // figée chez Meta sans jeton). Les taire laisserait croire la colonne des liens complète ; les
    // additionner affirmerait qu'ils sont d'ici.
    const d = fiche({ envois, mesures: [mes('a', 'url_click' as never, 3, null)], clicsAnonymes: 9 });
    expect(d.clicsAnonymes).toBe(9);
    expect(d.etapes[0]!.liens.gestes).toBe(3);
    expect(d.etapes[0]!.interactions).toBe(3);
  });

  it('🔴 le ratio est bien celui du LANCEMENT, pas de tous les envois', () => {
    // 20 envois au total, 10 de lancement. Sur les 20 le ratio vaudrait 2,86/11 = 0,26 : le double.
    const d = fiche({ envois, mesures: [mes('a', 'reply_text', 11, 11)] });
    expect(d.etapes[0]!.coutParInteraction).toBeCloseTo(0.13, 4);
  });

  it('coût du lancement inconnu -> pas de ratio, même avec des interactions', () => {
    const d = fiche({
      envois: [{ category: null, total: 10, lancement: 10 }],
      mesures: [mes('a', 'reply_text', 5, 5)],
    });
    expect(d.etapes[0]!.interactions).toBe(5);
    expect(d.etapes[0]!.coutParInteraction).toBeNull();
  });

  it('plusieurs blocs -> une ligne chacun', () => {
    const d = fiche({
      envois,
      mesures: [mes('a', 'reply_button', 4, 4), mes('b', 'reply_text', 2, 2), mes('b', 'sent', 9, 9)],
    });
    expect(d.etapes.map((e) => e.nodeId)).toEqual(['a', 'b']);
    expect(d.etapes[1]!.reponses.gestes).toBe(2);
  });

  it('une campagne SANS scénario n’a aucune étape', () => {
    expect(fiche({ envois }).etapes).toEqual([]);
  });

  it('un compte de personnes absent ne casse pas la ligne', () => {
    // `contacts` peut être null (une mesure qui ne sait pas distinguer les personnes). Le geste, lui, est
    // toujours là : on garde le geste et on n'invente pas de personne.
    const d = fiche({ envois, mesures: [mes('a', 'reply_button', 5, null)] });
    expect(d.etapes[0]!.boutons).toEqual({ gestes: 5, personnes: 0 });
    expect(d.etapes[0]!.interactions).toBe(5);
  });
});
