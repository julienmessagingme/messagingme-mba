import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  balayerAccompagnement, balayerRecap, semaineARecapituler, type DepsAccompagnement, type DepsRecap, type EspaceAccompagne,
  type RecapSemaine,
} from '../src/emails-produit/accompagnement';
import type { Emission } from '../src/emails-produit/emission';
import { modeleDe } from '../src/emails-produit/catalogue';
import { rendre } from '../src/emails-produit/rendu';

/**
 * Le lot 7, livraison C : la bienvenue, les trois relances et le récapitulatif de la semaine du Free. Le balayage
 * décide ; le journal des envois (unique par occasion) garantit le « une fois », et il est couvert par l'intégration.
 */

const HEURE = 3_600_000;
const JOUR = 24 * HEURE;
const MAINTENANT = new Date('2026-10-14T10:00:00Z');

function emetteur() {
  const emissions: Emission[] = [];
  return { emissions, emettre: async (e: Emission) => { emissions.push(e); return { destinataires: 1, reserves: 1 }; } };
}

function accompagner(espaces: EspaceAccompagne[], o: Partial<DepsAccompagnement> = {}) {
  const e = emetteur();
  const d: DepsAccompagnement = {
    espacesRecents: async () => espaces,
    modeRepondeur: async () => 'agent',
    aDesMessages: async () => true,
    emettre: e.emettre,
    pages: { console: 'https://c/accueil', numero: 'https://c/numero', agents: 'https://c/agents', widgets: 'https://c/widgets', offre: 'https://c/offre' },
    now: () => MAINTENANT,
    ...o,
  };
  return { run: () => balayerAccompagnement(d), e };
}

const ilYa = (ms: number) => new Date(MAINTENANT.getTime() - ms);
const cles = (emissions: Emission[]) => emissions.map((x) => x.cle).sort();

describe('la bienvenue', () => {
  it('part dans les 48 heures qui suivent la création, aux admins, avec son occasion fixe', async () => {
    const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(2 * HEURE), numeroDepuis: null }]);
    await run();
    expect(e.emissions).toEqual([
      { cle: 'bienvenue', tenantId: 't1', occasion: 'bienvenue', a: 'admins', valeurs: { lien_console: 'https://c/accueil' } },
    ]);
  });

  it('🔴 ne part plus après 48 heures : un espace ancien ne la reçoit pas le jour où ce code arrive', async () => {
    const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(49 * HEURE), numeroDepuis: ilYa(48 * HEURE) }]);
    await run();
    expect(cles(e.emissions)).not.toContain('bienvenue');
  });
});

describe('les relances', () => {
  it('le numéro manque depuis 24 heures : la relance du numéro, et rien d’autre', async () => {
    const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(25 * HEURE), numeroDepuis: null }]);
    await run();
    expect(cles(e.emissions)).toEqual(['bienvenue', 'relance_numero']);
    expect(e.emissions.find((x) => x.cle === 'relance_numero')).toMatchObject({ occasion: 'relance_numero', a: 'admins', valeurs: { lien_numero: 'https://c/numero' } });
  });

  it('pas de relance du numéro avant 24 heures', async () => {
    const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(23 * HEURE), numeroDepuis: null }]);
    await run();
    expect(cles(e.emissions)).toEqual(['bienvenue']);
  });

  it('🔴 le numéro est en service depuis 24 heures et personne ne répond : la relance du répondeur', async () => {
    const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(3 * JOUR), numeroDepuis: ilYa(25 * HEURE) }], { modeRepondeur: async () => 'equipe' });
    await run();
    expect(cles(e.emissions)).toEqual(['relance_repondeur']);
    expect(e.emissions[0]).toMatchObject({ occasion: 'relance_repondeur', valeurs: { lien_agents: 'https://c/agents' } });
  });

  it('un répondeur en place (agent, MBA, scénario ou application) : pas de relance du répondeur', async () => {
    for (const mode of ['agent', 'mba', 'scenario', 'application']) {
      const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(3 * JOUR), numeroDepuis: ilYa(25 * HEURE) }], { modeRepondeur: async () => mode });
      await run();
      expect(cles(e.emissions)).toEqual([]);
    }
  });

  it('pas de relance du répondeur dans les 24 premières heures du numéro', async () => {
    const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(3 * JOUR), numeroDepuis: ilYa(23 * HEURE) }], { modeRepondeur: async () => 'equipe' });
    await run();
    expect(cles(e.emissions)).toEqual([]);
  });

  it('🔴 sept jours de service sans un message : la relance du silence ; avec un message, rien', async () => {
    const silencieux = accompagner([{ tenantId: 't1', creeLe: ilYa(9 * JOUR), numeroDepuis: ilYa(8 * JOUR) }], { aDesMessages: async () => false });
    await silencieux.run();
    expect(cles(silencieux.e.emissions)).toEqual(['relance_silence']);
    expect(silencieux.e.emissions[0]).toMatchObject({ occasion: 'relance_silence', valeurs: { lien_widgets: 'https://c/widgets' } });

    const actif = accompagner([{ tenantId: 't1', creeLe: ilYa(9 * JOUR), numeroDepuis: ilYa(8 * JOUR) }], { aDesMessages: async () => true });
    await actif.run();
    expect(cles(actif.e.emissions)).toEqual([]);
  });

  it('pas de relance du silence avant sept jours de service', async () => {
    const { run, e } = accompagner([{ tenantId: 't1', creeLe: ilYa(9 * JOUR), numeroDepuis: ilYa(6 * JOUR) }], { aDesMessages: async () => false });
    await run();
    expect(cles(e.emissions)).toEqual([]);
  });

  it('🔴 une relance ne vaut que sept jours après son déclencheur (mesuré : sinon cinq espaces anciens la recevaient au déploiement)', async () => {
    const sansReponse = { modeRepondeur: async () => 'equipe', aDesMessages: async () => false };
    // Le numéro absent depuis 8 jours et 1 heure : trop tard.
    const numero = accompagner([{ tenantId: 't1', creeLe: ilYa(8 * JOUR + HEURE), numeroDepuis: null }], sansReponse);
    await numero.run();
    expect(cles(numero.e.emissions)).toEqual([]);
    // Le répondeur : due à 7 jours et 23 heures de service, plus à 8 jours et 1 heure.
    const encore = accompagner([{ tenantId: 't1', creeLe: ilYa(9 * JOUR), numeroDepuis: ilYa(8 * JOUR - HEURE) }], sansReponse);
    await encore.run();
    expect(cles(encore.e.emissions)).toEqual(['relance_repondeur', 'relance_silence']);
    const tard = accompagner([{ tenantId: 't1', creeLe: ilYa(9 * JOUR), numeroDepuis: ilYa(8 * JOUR + HEURE) }], sansReponse);
    await tard.run();
    expect(cles(tard.e.emissions)).toEqual(['relance_silence']);
    // Le silence : plus à 14 jours et 1 heure de service.
    const silence = accompagner([{ tenantId: 't1', creeLe: ilYa(20 * JOUR), numeroDepuis: ilYa(14 * JOUR + HEURE) }], sansReponse);
    await silence.run();
    expect(cles(silence.e.emissions)).toEqual([]);
  });

  it('un espace en panne n’arrête pas le balayage des autres', async () => {
    const { run, e } = accompagner(
      [
        { tenantId: 'casse', creeLe: ilYa(3 * JOUR), numeroDepuis: ilYa(25 * HEURE) },
        { tenantId: 'sain', creeLe: ilYa(25 * HEURE), numeroDepuis: null },
      ],
      { modeRepondeur: async () => { throw new Error('base'); } },
    );
    await run();
    expect(e.emissions.map((x) => x.tenantId)).toEqual(['sain', 'sain']);
  });
});

describe('le câblage du worker', () => {
  const sansCommentaires = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const worker = sansCommentaires(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));
  const bloc = worker.slice(worker.indexOf("taches.programmer('emails-produit-accompagnement'"), worker.indexOf("sweeper:emails-produit-accompagnement'"));

  it('🔴 le répondeur se lit SOUS L’OFFRE, comme la console (un Pro repassé en Free n’a plus son scénario)', () => {
    expect(bloc).toContain('modeRepondeur: async (t) => modeEffectif(sousLOffre(await settingsStore.get(t), (await offres.offreDe(t)).droits.fonctions)),');
  });

  it('🔴 le récapitulatif ne va qu’aux espaces ouverts en Free, et lit son occasion avant de compter', () => {
    expect(bloc).toContain('espaces: () => emailsProduit.espacesOuverts(),');
    expect(bloc).toContain("estFree: async (t) => (await offres.offreDe(t)).offre === 'base',");
    expect(bloc).toContain("dejaEnvoye: (t, occasion) => emailsProduit.occasionReservee(t, 'recap_semaine', occasion),");
  });
});

describe('la semaine à récapituler', () => {
  it('🔴 le lundi avant 9 h (Paris), rien ; à 9 h, la semaine du lundi au dimanche qui précède', () => {
    // Le 2026-10-12 est un lundi, à l'heure d'été (Paris = UTC+2).
    expect(semaineARecapituler(new Date('2026-10-12T06:59:00Z'))).toBeNull();
    expect(semaineARecapituler(new Date('2026-10-12T07:00:00Z'))).toEqual({ du: '2026-10-05', au: '2026-10-11' });
  });

  it('🔴 le mardi rattrape un balayage manqué ; dès le mercredi, plus rien (le premier déploiement est un mercredi)', () => {
    expect(semaineARecapituler(new Date('2026-10-13T21:59:00Z'))).toEqual({ du: '2026-10-05', au: '2026-10-11' });
    expect(semaineARecapituler(new Date('2026-10-13T22:00:00Z'))).toBeNull();
    expect(semaineARecapituler(new Date('2026-10-14T10:00:00Z'))).toBeNull();
    expect(semaineARecapituler(new Date('2026-10-18T21:59:00Z'))).toBeNull();
  });

  it('suit le changement d’heure : le lundi qui suit le passage à l’heure d’hiver, 9 h Paris = 8 h UTC', () => {
    expect(semaineARecapituler(new Date('2026-10-26T07:59:00Z'))).toBeNull();
    expect(semaineARecapituler(new Date('2026-10-26T08:00:00Z'))).toEqual({ du: '2026-10-19', au: '2026-10-25' });
  });

  it('minuit passé à Paris compte pour lundi, même quand UTC est encore dimanche', () => {
    // 2026-10-18 22:30 UTC = lundi 19 à 00:30 à Paris, avant 9 h : rien.
    expect(semaineARecapituler(new Date('2026-10-18T22:30:00Z'))).toBeNull();
  });
});

describe('le récapitulatif de la semaine', () => {
  const SEMAINE: RecapSemaine = { messagesRecus: 42, messagesEnvoyes: 57, conversations: 18, demandes: 3, creditMicroEur: 3_420_000 };
  /** Le lundi 2026-10-12 à 10 h, Paris. */
  const LUNDI = new Date('2026-10-12T08:00:00Z');

  function recap(o: Partial<DepsRecap> = {}) {
    const e = emetteur();
    const d: DepsRecap = {
      espaces: async () => ['free', 'pro'],
      estFree: async (t) => t === 'free',
      dejaEnvoye: async () => false,
      recap: async () => SEMAINE,
      emettre: e.emettre,
      pageOffre: 'https://c/offre',
      now: () => LUNDI,
      ...o,
    };
    return { run: () => balayerRecap(d), e };
  }

  it('🔴 ne va qu’aux espaces Free, une fois par semaine (l’occasion porte le lundi)', async () => {
    const { run, e } = recap();
    await run();
    expect(e.emissions).toEqual([{
      cle: 'recap_semaine', tenantId: 'free', occasion: 'semaine:2026-10-05', a: 'admins',
      valeurs: {
        semaine_du: '2026-10-05T12:00:00.000Z', messages_recus: '42', messages_envoyes: '57', conversations: '18',
        demandes: '3', credit: '3420000', lien_offre: 'https://c/offre',
      },
    }]);
  });

  it('une occasion déjà réservée n’est ni recomptée ni réémise (le balayage repasse toutes les trente minutes)', async () => {
    let comptes = 0;
    const vus: string[] = [];
    const { run, e } = recap({
      dejaEnvoye: async (t, occasion) => { vus.push(`${t}:${occasion}`); return true; },
      recap: async () => { comptes += 1; return SEMAINE; },
    });
    await run();
    expect(vus).toEqual(['free:semaine:2026-10-05']);
    expect(comptes).toBe(0);
    expect(e.emissions).toEqual([]);
  });

  it('une semaine sans aucun message n’écrit rien', async () => {
    const { run, e } = recap({ recap: async () => ({ ...SEMAINE, messagesRecus: 0, messagesEnvoyes: 0, conversations: 0, demandes: 0 }) });
    await run();
    expect(e.emissions).toEqual([]);
  });

  it('le lundi avant 9 h, aucun espace n’est même lu', async () => {
    let lus = 0;
    const { run, e } = recap({ now: () => new Date('2026-10-12T06:00:00Z'), espaces: async () => { lus += 1; return ['free']; } });
    await run();
    expect(lus).toBe(0);
    expect(e.emissions).toEqual([]);
  });

  it('un crédit négatif s’affiche à zéro', async () => {
    const { run, e } = recap({ recap: async () => ({ ...SEMAINE, creditMicroEur: -50_000 }) });
    await run();
    expect(e.emissions[0]?.valeurs.credit).toBe('0');
  });

  it('le texte rendu dit la semaine, les chiffres et le crédit en euros, en français et en anglais', () => {
    const m = modeleDe('recap_semaine')!;
    const v = {
      semaine_du: '2026-10-05T12:00:00.000Z', messages_recus: '42', messages_envoyes: '57', conversations: '18', demandes: '3',
      credit: '3420000', lien_offre: 'https://c/offre', espace: 'Boutique', _fuseau: 'Europe/Paris',
    };
    const fr = rendre(m, m.textes.fr, v, 'fr');
    expect(fr.sujet).toBe('Votre semaine sur WhatsApp : 42 messages reçus');
    expect(fr.text).toMatch(/5 octobre 2026/);
    expect(fr.text).toMatch(/3,42\s?€/);
    const en = rendre(m, m.textes.en, v, 'en');
    expect(en.text).toMatch(/October 5, 2026|5 October 2026/);
    expect(en.text).toMatch(/€3\.42/);
  });
});
