import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { OutilMcp, ProprieteEntree } from './outils';
import { RefusOutil } from './saisie';
import { addDays, inclusiveDays, parseRange, todayParis, STATS_TZ, type DateRange } from '../stats/range';
import type {
  ActionsAgentJour, CampaignFunnel, DailyPoint, DashboardStats, ErrorBreakdownRow, FiltreCampagneOuTemplate, StatutsModelesJour,
} from '../stats/store.pg';
import { round2, type CostSeries, type CoutParCampagne } from '../stats/cost';
import type { CoutMessages } from '../stats/cout-messages';
import type { CoutIa } from '../stats/cout-ia';
import type { ConversationAnalysisSummary, JourAnalyse } from '../stats/conversation-stats.pg';
import { eurosDepuisMicro } from '../agent/devise';
import { estUuid } from '../http/scope';
import { adresseOffre } from '../offres/refus';

/**
 * LES CHIFFRES DE L'ESPACE POUR CLAUDE CODE (plan `docs/superpowers/plans/2026-10-13-donnees-graphiques-mcp.md`).
 *
 * 🔴 DES AGRÉGATS, JAMAIS UNE PERSONNE : aucun outil d'ici ne rend un message, un contact ou une conversation un par un.
 * 🔴 LES MÊMES CHIFFRES QUE L'ÉCRAN STATISTIQUES : chaque outil appelle les fonctions de la route de la console
 * (`src/http/stats.ts`), sur les mêmes périodes (`parseRange`, heure de Paris, 366 jours au plus). Seule la maille
 * (semaine, mois) est calculée ici, depuis les séries par jour.
 *
 * L'OFFRE : un espace sans la fonction `statistiques` (le Free) ne lit que l'essentiel de `get_message_stats`, sur la
 * fenêtre de sa conservation (30 jours) ; le découpage entre Pro et Entreprise se fera en changeant la fonction d'un
 * outil (décision de Julien du 2026-10-13).
 */

export interface DepsChiffresMcp {
  /** Le dépôt des statistiques de la console (`PgStatsStore`). */
  stats: {
    getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats>;
    statutsDesModelesParJour(tenantId: string, range: DateRange): Promise<StatutsModelesJour[]>;
    getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel>;
    getErrorBreakdown(tenantId: string, range: DateRange, templateName?: string): Promise<ErrorBreakdownRow[]>;
    ficheCampagne(tenantId: string, campaignId: string): Promise<{ id: string; nom: string; template: string | null; workflowId: string | null } | null>;
    demandesEquipeParJour(tenantId: string, range: DateRange): Promise<DailyPoint[]>;
    actionsAgentParJour(tenantId: string, range: DateRange): Promise<ActionsAgentJour[]>;
  };
  /** L'analyse des conversations de la console (`PgConversationStatsStore`). */
  conversationStats: {
    getSummary(tenantId: string, range: DateRange): Promise<ConversationAnalysisSummary>;
    joursAnalyse(tenantId: string, range: DateRange): Promise<JourAnalyse[]>;
  };
  /** Les coûts de la route de la console (`src/stats/chiffrage.ts`). */
  getCostSeries(tenantId: string, range: DateRange, filter: FiltreCampagneOuTemplate): Promise<CostSeries>;
  getCoutMessages(tenantId: string, range: DateRange): Promise<CoutMessages>;
  getCoutParCampagne(tenantId: string, range: DateRange, opts: { inclureArchivees: boolean }): Promise<CoutParCampagne>;
  getCoutIa(tenantId: string, range: DateRange): Promise<CoutIa>;
}

export const MAILLES = ['jour', 'semaine', 'mois'] as const;
export type Maille = (typeof MAILLES)[number];

/**
 * Au-delà, une série au jour est trop longue pour être lue par un modèle (366 jours au jour, en Pro : plus de 200 Ko de
 * JSON) : une maille `jour` explicite est refusée, et sans maille donnée, la semaine est prise. Annoncé dans le schéma.
 */
export const MAX_JOURS_MAILLE_JOUR = 92;

/**
 * L'entrée commune des outils de chiffres. Les descriptions disent « the first day » et « the last day » plutôt que
 * les noms `du` et `au` : `du` est un mot français que `tests/mcp-repertoire.test.ts` refuse dans un texte.
 */
export const ENTREE_PERIODE: Record<string, ProprieteEntree> = {
  du: {
    type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'The first day (YYYY-MM-DD, Paris time), given together with the last day. Both absent: the last 30 days.',
  },
  au: {
    type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'The last day, included (YYYY-MM-DD), today at the latest; 366 days at most from the first day.',
  },
  maille: {
    type: 'string', enum: [...MAILLES],
    description: `jour (day), semaine (week, from Monday) or mois (calendar month): each row of the series covers one `
      + `of them. jour for ${MAX_JOURS_MAILLE_JOUR} days at most; absent: jour up to ${MAX_JOURS_MAILLE_JOUR} days, `
      + 'semaine beyond.',
  },
};

/** La période et la maille d'un appel, lues comme la console lit les siennes. Un refus dit quoi corriger. */
export function lirePeriode(args: Record<string, unknown>): { range: DateRange; maille: Maille } {
  const absente = args.maille === undefined || args.maille === null || args.maille === '';
  if (!absente && (typeof args.maille !== 'string' || !(MAILLES as readonly string[]).includes(args.maille))) {
    throw new RefusOutil(`maille : ${MAILLES.join(', ')}`);
  }
  const r = parseRange({ from: args.du, to: args.au });
  if ('error' in r) throw new RefusOutil(r.error.replace(/\bfrom\b/g, 'du').replace(/\bto\b/g, 'au').replace('YYYY-MM-DD', 'AAAA-MM-JJ'));
  const longue = inclusiveDays(r.range.from, r.range.to) > MAX_JOURS_MAILLE_JOUR;
  if (absente) return { range: r.range, maille: longue ? 'semaine' : 'jour' };
  if (args.maille === 'jour' && longue) {
    throw new RefusOutil(`la maille jour couvre ${MAX_JOURS_MAILLE_JOUR} jours au plus : choisir semaine ou mois`);
  }
  return { range: r.range, maille: args.maille as Maille };
}

/** La maille d'un jour : le jour lui-même, le lundi de sa semaine, ou son mois (`AAAA-MM`). */
export function cleDeMaille(jour: string, maille: Maille): string {
  if (maille === 'jour') return jour;
  if (maille === 'mois') return jour.slice(0, 7);
  const [y, m, d] = jour.split('-').map(Number) as [number, number, number];
  const decalage = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(jour, -decalage);
}

/** Les jours de la période, du premier au dernier inclus. */
function joursDe(range: DateRange): string[] {
  const jours: string[] = [];
  for (let j = range.from; j <= range.to; j = addDays(j, 1)) jours.push(j);
  return jours;
}

export type LigneSerie = { periode: string } & Record<string, number>;

/**
 * Un coût par clic ou par engagement est un TARIF : sous l'euro, quatre décimales, comme la console (`fmtCost`,
 * `web/lib/format.ts`). Au centime, 0,0425 € deviendrait 0,04 €.
 */
function prixUnitaire(n: number): number {
  return n !== 0 && Math.abs(n) < 1 ? Math.round(n * 10_000) / 10_000 : round2(n);
}

/**
 * Les séries par jour ramenées à la maille : chaque colonne de `sommes` s'additionne, chaque colonne de `niveaux`
 * (un stock, les contacts) garde la valeur du DERNIER jour de la maille. La série est dense : une maille sans donnée
 * vaut 0, jamais une ligne absente (un graphique la lirait comme un trou).
 */
export function aLaMaille(
  range: DateRange, maille: Maille,
  sommes: Record<string, ReadonlyArray<DailyPoint>>, niveaux: Record<string, ReadonlyArray<DailyPoint>> = {},
): LigneSerie[] {
  const lignes = new Map<string, LigneSerie>();
  // Une date peut revenir (une ligne par jour ET par action) : elle s'additionne, sinon la dernière écraserait les autres.
  const index = (serie: ReadonlyArray<DailyPoint>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of serie) m.set(p.date, (m.get(p.date) ?? 0) + p.count);
    return m;
  };
  const s = Object.entries(sommes).map(([nom, serie]) => [nom, index(serie)] as const);
  const n = Object.entries(niveaux).map(([nom, serie]) => [nom, index(serie)] as const);
  for (const jour of joursDe(range)) {
    const cle = cleDeMaille(jour, maille);
    let ligne = lignes.get(cle);
    if (!ligne) {
      ligne = { periode: cle } as LigneSerie;
      for (const [nom] of s) ligne[nom] = 0;
      for (const [nom] of n) ligne[nom] = 0;
      lignes.set(cle, ligne);
    }
    for (const [nom, valeurs] of s) ligne[nom] = (ligne[nom] ?? 0) + (valeurs.get(jour) ?? 0);
    for (const [nom, valeurs] of n) {
      const v = valeurs.get(jour);
      if (v !== undefined) ligne[nom] = v;
    }
  }
  return [...lignes.values()];
}

/** La somme d'une colonne sur toute la série. */
function total(lignes: readonly LigneSerie[], colonne: string): number {
  return lignes.reduce((acc, l) => acc + (l[colonne] ?? 0), 0);
}

/** Une série par jour tirée d'une colonne des statuts. */
function colonne(statuts: readonly StatutsModelesJour[], nom: keyof Omit<StatutsModelesJour, 'date'>): DailyPoint[] {
  return statuts.map((s) => ({ date: s.date, count: s[nom] }));
}

const A_SAVOIR_MODELES = [
  'envoyes : les modèles partis (marketing et utilitaires), comptés comme le tableau de bord de la console ; livres '
    + 'compte aussi les lus.',
  'sans_accuse : aucun statut de Meta (un modèle hors campagne n’en reçoit que depuis le 2026-10-09).',
  'echecs : pour une campagne, refusés à l’envoi ou annoncés en échec par Meta, et alors hors des envoyés ; pour un '
    + 'modèle hors campagne, annoncés en échec, et alors compris dans les envoyés.',
  'La première et la dernière maille peuvent être partielles : la période va de du à au.',
  'Un message effacé par la durée de conservation de l’offre ne compte plus.',
];

export const OUTILS_CHIFFRES: OutilMcp[] = [
  {
    ...ficheOutilMcp('get_message_stats'),
    // Toutes les offres : l'essentiel pour le Free, le reste pour qui a les statistiques (décision du 2026-10-13).
    fonction: null,
    description:
      'The workspace\'s message figures, as chart-ready series (one row per maille: day, week or month) and their totals: TEMPLATES '
      + 'sent, delivered, read, failed and without receipt. With the plan\'s statistics (Pro, Enterprise), in addition: '
      + 'templates by category, messages exchanged and service messages, service by origin (AI, scenario, human), '
      + 'contacts (cumulative, active) and the ESTIMATED cost (the prices of the Statistics screen: an estimate, the '
      + 'invoice prevails). The same figures as the console\'s Statistics screen. Without statistics (Free): the '
      + 'essentials only, over the last 30 days; an older period is refused with the link to the Pro plan. Comparing '
      + 'two periods takes two calls. No personal data.',
    annotations: { title: 'Read message figures', readOnlyHint: true, openWorldHint: false },
    entree: { type: 'object', properties: { ...ENTREE_PERIODE }, additionalProperties: false },
    async executer(deps, tenantId, args) {
      const { range, maille } = lirePeriode(args);
      const offre = await deps.offres.offreDe(tenantId);
      const complet = offre.droits.fonctions.has('statistiques');
      if (!complet) {
        const jours = offre.droits.limites.conservationJours;
        const aujourdhui = todayParis();
        const premier = addDays(aujourdhui, -(jours - 1));
        if (range.from < premier) {
          throw new RefusOutil(
            `Votre offre lit les ${jours} derniers jours (du ${premier} au ${aujourdhui}). `
            + `Passez en Pro pour remonter plus loin : ${adresseOffre()}`,
          );
        }
      }
      const c = deps.chiffres;
      const statuts = await c.stats.statutsDesModelesParJour(tenantId, range);
      const series = aLaMaille(range, maille, {
        envoyes: colonne(statuts, 'envoyes'), livres: colonne(statuts, 'livres'), lus: colonne(statuts, 'lus'),
        echecs: colonne(statuts, 'echecs'), sans_accuse: colonne(statuts, 'sansAccuse'),
      });
      const periode = { du: range.from, au: range.to, maille, fuseau: STATS_TZ };
      const modeles = {
        series,
        totaux: Object.fromEntries(['envoyes', 'livres', 'lus', 'echecs', 'sans_accuse'].map((k) => [k, total(series, k)])),
      };
      if (!complet) {
        return { periode, detail: 'essentiel', modeles, a_savoir: A_SAVOIR_MODELES };
      }

      const [tableau, cout, coutPeriode] = await Promise.all([
        c.stats.getDashboard(tenantId, range),
        c.getCostSeries(tenantId, range, {}),
        c.getCoutMessages(tenantId, range),
      ]);
      const parCategorie = aLaMaille(range, maille, { marketing: tableau.templates.marketing, utility: tableau.templates.utility });
      const messages = aLaMaille(range, maille, { echanges: tableau.exchanged, service: tableau.service });
      const contacts = aLaMaille(range, maille, {}, { cumules: tableau.contacts, actifs: tableau.contactsActifs });
      const coutSeries = aLaMaille(range, maille, { marketing: cout.marketing, utility: cout.utility })
        .map((l) => ({ ...l, marketing: round2(l.marketing ?? 0), utility: round2(l.utility ?? 0) }));
      return {
        periode,
        detail: 'complet',
        modeles,
        modeles_par_categorie: parCategorie,
        messages,
        service_par_origine: tableau.serviceParOrigine,
        service_ia: tableau.serviceIaDetail,
        contacts,
        cout_estime: {
          estimation: true,
          devise: coutPeriode.currency ?? cout.currency,
          // Faux : la grille des prix n'est pas connue, et les séries valent 0 sans que ce soit un coût nul.
          tarifs_connus: cout.hasRates,
          // Les modèles seulement ; `periode.total` ajoute le service et le RCS.
          series: coutSeries,
          periode: {
            modeles: coutPeriode.templates, service: coutPeriode.service, rcs: coutPeriode.rcs, total: coutPeriode.total,
          },
          non_chiffrables: coutPeriode.nonChiffrables,
        },
        a_savoir: [
          ...A_SAVOIR_MODELES,
          'contacts : un stock, la valeur du dernier jour de chaque maille.',
          'cout_estime : les prix de l’écran Statistiques, une estimation (la facture fait foi). series : les modèles '
            + 'seulement ; periode.total y ajoute le service et le RCS ; non_chiffrables : des envois sans prix connu, '
            + 'absents du coût.',
        ],
      };
    },
  },
  {
    ...ficheOutilMcp('get_campaign_stats'),
    fonction: 'statistiques',
    description:
      'Campaign figures. Without campaign_id: the campaigns of the period (first and last day), each with its sends '
      + '(and among them the billable ones), its clicks, its engagements and its ESTIMATED cost (an estimate, the '
      + 'invoice prevails), and Meta\'s errors by code and by template. With campaign_id: the funnel of the whole '
      + 'campaign (sent, delivered, read, replies, replies by button, clicks, failures, without receipt, targeted '
      + 'contacts), the period then being ignored. The same figures as the console\'s Statistics screen. No personal '
      + 'data.',
    annotations: { title: 'Read campaign figures', readOnlyHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        du: ENTREE_PERIODE.du!, au: ENTREE_PERIODE.au!,
        campaign_id: { type: 'string', format: 'uuid', minLength: 1, maxLength: 100, description: 'A campaign of the workspace: its funnel.' },
      },
      additionalProperties: false,
    },
    async executer(deps, tenantId, args) {
      const c = deps.chiffres;
      if (args.campaign_id !== undefined && args.campaign_id !== null && args.campaign_id !== '') {
        const id = String(args.campaign_id);
        const fiche = estUuid(id) ? await c.stats.ficheCampagne(tenantId, id) : null;
        if (!fiche) throw new RefusOutil('campagne introuvable dans cet espace');
        const f = await c.stats.getCampaignFunnel(tenantId, id);
        return {
          campagne: { id: fiche.id, nom: fiche.nom, modele: fiche.template, scenario: fiche.workflowId !== null },
          entonnoir: {
            envoyes: f.sent, livres: f.delivered, lus: f.read, reponses: f.replied, reponses_boutons: f.buttonReplies,
            clics: f.urlClicks, echecs: f.failed, sans_accuse: f.sansAccuse, contacts_vises: f.contactsVises,
          },
          par_canal: f.parCanal.map((p) => ({
            canal: p.canal, envois: p.envois, reussis: p.reussis, livres: p.delivres, lus: p.lus, reponses: p.repondus,
            sans_accuse: p.sansAccuse,
          })),
          a_savoir: [
            'L’entonnoir couvre toute la campagne, pas une période. livres compte aussi les lus ; clics vaut null quand le '
              + 'modèle n’a pas de lien tracé.',
          ],
        };
      }
      const { range } = lirePeriode({ du: args.du, au: args.au });
      const [cout, erreurs] = await Promise.all([
        c.getCoutParCampagne(tenantId, range, { inclureArchivees: false }),
        c.stats.getErrorBreakdown(tenantId, range),
      ]);
      const parCode = new Map<number, { total: number; par_modele: Map<string, number> }>();
      for (const e of erreurs) {
        const ligne = parCode.get(e.code) ?? { total: 0, par_modele: new Map<string, number>() };
        ligne.total += e.count;
        // Une campagne RCS porte un nom de modèle vide, pas null.
        const modele = e.templateName || '(sans modèle)';
        ligne.par_modele.set(modele, (ligne.par_modele.get(modele) ?? 0) + e.count);
        parCode.set(e.code, ligne);
      }
      return {
        periode: { du: range.from, au: range.to, fuseau: STATS_TZ },
        campagnes: cout.lignes.map((l) => ({
          campaign_id: l.campaignId, nom: l.nom, modele: l.template, envoyes: l.envois, envois_facturables: l.envoyes,
          cout_estime: l.cout === null ? null : round2(l.cout), clics: l.clics,
          cout_par_clic: l.coutParClic === null ? null : prixUnitaire(l.coutParClic),
          engagements: l.engagements ?? null,
          cout_par_engagement: l.coutParEngagement === undefined || l.coutParEngagement === null ? null : prixUnitaire(l.coutParEngagement),
        })),
        devise: cout.currency,
        tarifs_connus: cout.hasRates,
        tronque: cout.tronque,
        erreurs: [...parCode.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([code, v]) => ({ code, total: v.total, par_modele: [...v.par_modele.entries()].map(([modele, n]) => ({ modele, n })) })),
        a_savoir: [
          'cout_estime : les prix de l’écran Statistiques, une estimation (la facture fait foi), sur les envois '
            + 'facturables ; null sans prix connu ou quand la conservation a effacé les envois.',
          'envoyes : les personnes touchées sur la période, facturable ou non (une campagne RCS ou à scénario peut n’avoir '
            + 'aucun envoi facturable).',
          'clics : comptés par modèle ; deux campagnes du même modèle partagent leurs clics, ne pas les additionner.',
          'campagnes : sans les campagnes archivées ; erreurs : toutes les campagnes, archivées comprises, par code puis par modèle.',
        ],
      };
    },
  },
  {
    ...ficheOutilMcp('get_conversation_insights'),
    fonction: 'statistiques',
    description:
      'What the analysis understood of the period\'s conversations: the number of analyzed conversations, sentiment '
      + '(positive, neutral, negative), intents, resolved conversations, who handled them, suggested actions and the '
      + 'most frequent topics; and, as a series per maille, the analyzed conversations and the average '
      + 'satisfaction and urgency (out of 10). The series goes back up to 12 months (aggregates without personal '
      + 'data); the summary covers what retention keeps. The same figures as the Analysis screen.',
    annotations: { title: 'Read the conversation analysis', readOnlyHint: true, openWorldHint: false },
    entree: { type: 'object', properties: { ...ENTREE_PERIODE }, additionalProperties: false },
    async executer(deps, tenantId, args) {
      const { range, maille } = lirePeriode(args);
      const c = deps.chiffres;
      const [synthese, jours] = await Promise.all([
        c.conversationStats.getSummary(tenantId, range), c.conversationStats.joursAnalyse(tenantId, range),
      ]);
      // Une moyenne se re-agrège par sa somme et son nombre de mesures, jamais en moyenne de moyennes (0155).
      const pond = (cle: 'satisfaction' | 'urgence'): DailyPoint[] => jours
        .filter((j) => j[cle] !== null)
        .map((j) => ({ date: j.jour, count: (j[cle] ?? 0) * j.mesurees }));
      const series = aLaMaille(range, maille, {
        conversations: jours.map((j) => ({ date: j.jour, count: j.conversations })),
        mesurees: jours.map((j) => ({ date: j.jour, count: j.mesurees })),
        satisfaction: pond('satisfaction'),
        urgence: pond('urgence'),
      }).map((l) => ({
        periode: l.periode,
        conversations: l.conversations ?? 0,
        mesurees: l.mesurees ?? 0,
        satisfaction: (l.mesurees ?? 0) > 0 ? round2((l.satisfaction ?? 0) / (l.mesurees ?? 1)) : null,
        urgence: (l.mesurees ?? 0) > 0 ? round2((l.urgence ?? 0) / (l.mesurees ?? 1)) : null,
      }));
      return {
        periode: { du: range.from, au: range.to, maille, fuseau: STATS_TZ },
        analyse_active: synthese.enabled,
        synthese: {
          conversations: synthese.total,
          sentiment: synthese.sentiment,
          intentions: synthese.intent,
          resolution: synthese.resolution,
          traitees_par: synthese.handledBy,
          echanges: synthese.exchanges,
          actions_suggerees: synthese.actions,
          sujets: synthese.topTopics,
        },
        series,
        a_savoir: [
          'satisfaction et urgence : sur 10, moyennes des conversations qui portent les notes (mesurees) ; null sans mesure.',
          synthese.retentionDays > 0
            ? `La synthèse couvre les conversations encore gardées (${synthese.retentionDays} jours) ; la série remonte plus loin.`
            : 'La synthèse couvre les conversations analysées de la période (aucune n’est effacée dans cet espace).',
          'La première et la dernière maille peuvent être partielles : la période va de du à au.',
        ],
      };
    },
  },
  {
    ...ficheOutilMcp('get_ai_stats'),
    fonction: 'statistiques',
    description:
      'AI agent figures over the period: the cost of AI agent turns on the credit (in euros, sessions and tokens; '
      + 'translation is not included), the messages written by AI (AI agent, Meta Business Agent, assistant connected '
      + 'through MCP), the requests opened for the team per maille, and the actions triggered (per maille and '
      + 'per action). The cost and the messages are those of the console\'s Statistics screen.',
    annotations: { title: 'Read AI agent figures', readOnlyHint: true, openWorldHint: false },
    entree: { type: 'object', properties: { ...ENTREE_PERIODE }, additionalProperties: false },
    async executer(deps, tenantId, args) {
      const { range, maille } = lirePeriode(args);
      const c = deps.chiffres;
      const [coutIa, tableau, demandes, actions] = await Promise.all([
        c.getCoutIa(tenantId, range), c.stats.getDashboard(tenantId, range),
        c.stats.demandesEquipeParJour(tenantId, range), c.stats.actionsAgentParJour(tenantId, range),
      ]);
      const parAction = new Map<string, { nom: string; total: number }>();
      for (const a of actions) {
        const l = parAction.get(a.actionId) ?? { nom: a.nom, total: 0 };
        l.total += a.n;
        parAction.set(a.actionId, l);
      }
      return {
        periode: { du: range.from, au: range.to, maille, fuseau: STATS_TZ },
        credit_des_tours_d_agent: {
          eur: eurosDepuisMicro(coutIa.coutMicroEur), sessions: coutIa.sessions,
          jetons_entree: coutIa.tokensEntree, jetons_sortie: coutIa.tokensSortie,
        },
        messages_ia: { ...tableau.serviceIaDetail, total: tableau.serviceParOrigine.ia },
        demandes_pour_l_equipe: aLaMaille(range, maille, { demandes }),
        actions: {
          series: aLaMaille(range, maille, { declenchees: actions.map((a) => ({ date: a.date, count: a.n })) }),
          par_action: [...parAction.entries()].map(([id, v]) => ({ action_id: id, nom: v.nom, total: v.total })),
        },
        a_savoir: [
          'messages_ia : sur la période entière (agent IA, agent de Meta, assistant MCP) ; pour une série, appeler mois par mois.',
          'demandes_pour_l_equipe : une conversation confiée à l’équipe (un agent IA, l’agent de Meta ou un scénario '
            + 'qui passe la main), ou rouverte par le contact après « Traité » ou en réponse à une campagne confiée à '
            + 'l’Inbox. Les fils de test n’y sont pas.',
          'credit_des_tours_d_agent : ce que les tours d’agent IA ont coûté sur le crédit prépayé de l’espace, au tarif '
            + 'de son offre. La traduction des conversations et les essais « Tester » sont débités du même crédit sans '
            + 'être comptés ici : l’historique du crédit, dans la console (Crédit IA), les montre.',
          'Une conversation effacée par la conservation emporte ses passages et ses actions.',
        ],
      };
    },
  },
];
