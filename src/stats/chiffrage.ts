import { cacheCourt } from '../lib/cache-court';
import { messageDe } from '../lib/erreur';
import type { PricingSummary } from '../meta/pricing';
import type { LienTrace } from '../links/tracked-links.pg';
import {
  noeudsTemplate, compteursDeClics, liensRcsDesNoeuds, compteursDeClicsRcs, type CompteurClic, type NoeudTemplate,
} from '../links/mesures';
import type { NodeEventCount } from '../workflow/node-events.pg';
import {
  estimateCostSeries, estimateCoutParCampagne, estimerCoutContact, entonnoirEngagement,
  type CategoryRates, type CostSeries, type CoutParCampagne, type CoutContact, type NiveauEngagement,
  type VolumeCampagneRow, type VolumeContactRow,
} from './cost';
import { assemblerDetailCampagne, type DetailCoutCampagne, type EnvoisCampagneRow } from './cout-campagne';
import { coutMessages, type CoutMessages, type MoisService } from './cout-messages';
import { PLAFOND_TOURS_IA, type CoutIa } from './cout-ia';
import { grilleDepuisLigne, tarifsFactures, pricingFacture, type GrillePrix } from './prix';
import { basculesRcs, FENETRE_BASCULE_MS } from './rcs-conversationnel';
import { rangeToUnix, addDays, todayParis, type DateRange } from './range';
import type { CampaignFunnel, CostVolumeRow, FiltreCampagneOuTemplate } from './store.pg';

/**
 * LE CHIFFRAGE : tout ce qui rend un coût à un écran (statistiques, fiche contact, `/ops`), construit une fois
 * par process à partir de ce qu'il lit.
 *
 * 🔴 CE MODULE EXISTE PARCE QUE LE DÉFAUT VIVAIT DANS L'APPEL, PAS DANS LE CALCUL. Les fonctions pures
 * (`cost.ts`, `cout-campagne.ts`, `cout-messages.ts`, `prix.ts`, `rcs-conversationnel.ts`) étaient testées ; leur
 * APPEL vivait dans la racine de composition, où deux tests le vérifiaient par expression régulière sur le
 * texte. La marge oubliée trois fois, le RCS jamais attribué, la bascule calculée sur la mauvaise population :
 * tout se jouait là. Ici, l'appel s'EXÉCUTE contre un faux dépôt (`tests/chiffrage.test.ts`), et la
 * classification RCS comme le montage des clics s'écrivent une seule fois.
 */

/** Ce que le chiffrage lit du dépôt des statistiques d'envoi. */
export interface StatsDuChiffrage {
  /** La grille de prix, une pour tous les espaces (migration 0168). */
  grillePrixGlobale(): Promise<Record<string, unknown> | null>;
  getCostVolume(tenantId: string, range: DateRange, filter: FiltreCampagneOuTemplate): Promise<CostVolumeRow[]>;
  getVolumeParCampagne(
    tenantId: string,
    range: DateRange,
    opts: { inclureArchivees?: boolean; retentionJours?: number },
  ): Promise<VolumeCampagneRow[]>;
  serviceParMois(tenantId: string, range: DateRange): Promise<MoisService[]>;
  /** `attribuer` : seul l'appelant qui lit `campaignId` paie la sous-requête qui le renseigne. */
  envoisEtReactionsRcs(
    tenantId: string,
    range: DateRange,
    fenetreMs: number,
    opts?: { attribuer?: boolean },
  ): Promise<LotRcs>;
  clicsParCampagne(tenantId: string, campaignIds: string[]): Promise<Map<string, number>>;
  engagementsParCampagne(tenantId: string, campaignIds: string[]): Promise<Map<string, number>>;
  servicesParCampagne(tenantId: string, campaignIds: string[], range: DateRange): Promise<Map<string, number>>;
  ficheCampagne(tenantId: string, campaignId: string): Promise<{ id: string; nom: string; template: string | null; workflowId: string | null } | null>;
  envoisDeLaCampagne(tenantId: string, campaignId: string): Promise<EnvoisCampagneRow[]>;
  getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel>;
  mesuresScenarioParCampagne(tenantId: string, campaignId: string): Promise<NodeEventCount[]>;
  consommationIa(tenantId: string, range: DateRange, plafond: number): Promise<CoutIa>;
}

/** Les envois RCS de la période, regroupés par échange, et les réactions des contacts. */
export interface LotRcs {
  conversations: { conversationId: string; campaignId: string | null; waId: string; envois: number; instants: string[] }[];
  reactions: { waId: string; at: string }[];
}

/** Le tarif de Meta d'un espace : ce que rend `MetaClientFactory.pricingClientForTenant`. */
export interface ClientTarif {
  getPricingAnalytics(wabaId: string, startTs: number, endTs: number): Promise<PricingSummary | null>;
}

export interface DepsChiffrage {
  stats: StatsDuChiffrage;
  /**
   * Le WABA de l'espace, relu à chaque demande. ⚠️ Le dépôt des campagnes, pas `creerNumeroDeLEspace` : c'est la
   * lecture que ces écrans faisaient, et un cache de plus changerait le moment où un WABA relié se voit.
   */
  waba: { getTenantWabaId(tenantId: string): Promise<string | null> };
  /** Le client de tarif de l'espace : jeton par espace, repli sur le jeton global. */
  meta: { pricingClientForTenant(tenantId: string): Promise<ClientTarif> };
  /** Le bilan d'un contact : ses envois par catégorie et ses profondeurs d'engagement. */
  historique: {
    bilanContact(tenantId: string, contactId: string): Promise<{ envois: VolumeContactRow[]; profondeurs: number[] } | null>;
  };
  /** Le graphe d'un scénario : c'est lui qui dit à quel bloc appartient un clic. */
  scenarios: { getById(id: string, tenantId: string): Promise<{ graph: unknown } | null> };
  liens: {
    listByTemplates(tenantId: string, noms: readonly string[]): Promise<LienTrace[]>;
    clicsAttribuesCampagne(tenantId: string, campaignId: string, codes: readonly string[]): Promise<{ attribues: Record<string, number>; anonymes: number }>;
    codesRcsParDestination(tenantId: string, destinations: readonly string[]): Promise<Map<string, string>>;
    countClicks(tenantId: string, codes: readonly string[], range: DateRange): Promise<Record<string, number>>;
  };
  evenements: { countByNode(tenantId: string, workflowId: string, range: DateRange): Promise<NodeEventCount[]> };
  /**
   * La rétention d'instance, en jours (`CONVERSATION_RETENTION_DAYS`) : une campagne dont les envois ont été
   * purgés garde une case vide plutôt qu'un 0,00 € qui se lirait « gratuit ».
   */
  retentionJours: number;
}

/** Ce que le chiffrage rend. Les noms sont ceux des contrats de route qui les consomment. */
export interface LecturesDeCout {
  /** La grille de prix, telle que `/ops` la montre et que tous les prix l'appliquent. */
  grille(): Promise<GrillePrix>;
  /** La marge, pour que l'écran nomme la cause de l'écart entre coût estimé et facture Meta. */
  margeTemplate(): Promise<number>;
  getPricing(tenantId: string, range: DateRange): Promise<PricingSummary | null>;
  getCostSeries(tenantId: string, range: DateRange, filter: FiltreCampagneOuTemplate): Promise<CostSeries>;
  getCoutParCampagne(tenantId: string, range: DateRange, opts: { inclureArchivees: boolean }): Promise<CoutParCampagne>;
  getCoutMessages(tenantId: string, range: DateRange): Promise<CoutMessages>;
  getCoutIa(tenantId: string, range: DateRange): Promise<CoutIa>;
  getDetailCoutCampagne(tenantId: string, campaignId: string): Promise<DetailCoutCampagne | null>;
  getWorkflowNodeCounts(tenantId: string, workflowId: string, range: DateRange): Promise<Array<NodeEventCount | CompteurClic>>;
  getBilanContact(tenantId: string, contactId: string): Promise<{ cout: CoutContact; entonnoir: NiveauEngagement[] } | null>;
}

/** Les RCS d'un lot, simples d'un côté, conversationnels de l'autre, au total et par campagne. */
export interface RepartitionRcs {
  simple: number;
  conversationnel: number;
  parCampagne: Map<string, { simple: number; conversationnel: number }>;
}

/**
 * LA classification RCS, écrite une fois pour le coût des messages et pour le coût par campagne.
 *
 * 🔴 La bascule se calcule sur TOUS les envois du lot, jamais sur ceux d'une campagne : la règle fait passer
 * l'échange entier à 8 cts dès qu'une réaction suit l'un de ses envois dans les sept jours, donc un RCS hors
 * campagne peut faire basculer les RCS de campagne du même échange. Les lignes sans campagne sont écartées de
 * l'imputation, pas de la bascule.
 * Le compte se fait sur les envois de chaque ligne, pas sur le nombre de conversations : un échange basculé
 * facture tous ses RCS au tarif haut. Les instants sont redéployés en un envoi par instant, la forme que
 * `basculesRcs` attend.
 */
export function repartirRcs(lot: LotRcs): RepartitionRcs {
  const envois = lot.conversations.flatMap((c) =>
    c.instants.map((at) => ({ id: '', conversationId: c.conversationId, waId: c.waId, at })));
  const bascules = basculesRcs(envois, lot.reactions);
  let simple = 0;
  let conversationnel = 0;
  const parCampagne = new Map<string, { simple: number; conversationnel: number }>();
  for (const c of lot.conversations) {
    const bascule = bascules.has(c.conversationId);
    if (bascule) conversationnel += c.envois; else simple += c.envois;
    if (c.campaignId === null) continue;
    const acc = parCampagne.get(c.campaignId) ?? { simple: 0, conversationnel: 0 };
    if (bascule) acc.conversationnel += c.envois; else acc.simple += c.envois;
    parCampagne.set(c.campaignId, acc);
  }
  return { simple, conversationnel, parCampagne };
}

/**
 * Les trente derniers jours, la fenêtre par défaut du tableau des campagnes. La fiche d'une campagne et le bilan
 * d'un contact lisent leurs tarifs sur elle, écrite une fois : trois écrans qui disent un coût doivent lire le
 * même tarif. Approximation assumée (Meta rend un tarif par période, qui bouge de quelques centimes par an),
 * sous un coût annoncé comme estimé.
 */
const trenteDerniersJours = (): DateRange => ({ from: addDays(todayParis(), -29), to: todayParis() });

export function creerChiffrage(d: DepsChiffrage): LecturesDeCout {
  /**
   * Le tarif de Meta, par espace et par fenêtre, soixante secondes. Construit ici, donc un cache par
   * construction : la racine de l'API construit ce module une fois, et le worker, qui n'affiche aucun tarif,
   * ne le construit pas.
   */
  const cacheTarifsMeta = cacheCourt<PricingSummary | null>(60_000);

  /**
   * Le point de passage unique vers le tarif de Meta.
   * Un échec n'est pas mémorisé : `getPricingAnalytics` avale ses pannes et rend `null`, une valeur résolue
   * que `cacheCourt` garderait, et un 429 éteindrait la colonne « coût » de tous les écrans pendant une
   * minute. On oublie la clé aussitôt. Les appels en vol restent mutualisés (vingt-cinq onglets, un seul
   * aller-retour, panne comprise).
   */
  const tarifMeta = async (
    tenant: string,
    startTs: number,
    endTs: number,
    appel: () => Promise<PricingSummary | null>,
  ): Promise<PricingSummary | null> => {
    const cle = `${tenant}:${startTs}:${endTs}`;
    const v = await cacheTarifsMeta.lire(cle, appel);
    if (v === null) cacheTarifsMeta.invalider(cle);
    return v;
  };

  /**
   * Le prix facturé d'un template : le seul endroit où la marge s'applique aux tarifs.
   * 🔴 Un seul point de passage, pour que tous les écrans qui affichent un prix (graphe de coût, synthèse,
   * bilan d'un contact) donnent le même chiffre ; ce qui sort est un prix de vente, pas un tarif Meta.
   * Un tarif absent (`null`) le reste : marger une absence en ferait un prix, et `chiffrer` ne pourrait plus
   * la compter comme « sans tarif ». La transformation vit dans `tarifsFactures`, pure et testée.
   */
  const prixFactures = async (tenant: string, range: DateRange): Promise<CategoryRates> => {
    const [wabaId, ligne] = await Promise.all([d.waba.getTenantWabaId(tenant), d.stats.grillePrixGlobale()]);
    const { startTs, endTs } = rangeToUnix(range);
    const pricingClientT = wabaId ? await d.meta.pricingClientForTenant(tenant) : null;
    /**
     * L'aller-retour chez Meta passe sous micro-cache : quatre écrans le déclenchent (dont l'onglet
     * Campagnes, ouvert en permanence), pour un tarif qui ne bouge pas dans la minute, sur une API tierce à
     * quota. La clé porte l'espace (isolation) et la fenêtre (deux périodes, deux tarifs). Soixante
     * secondes : acceptable pour un affichage, jamais pour une décision.
     */
    const pricing = pricingClientT && wabaId
      ? await tarifMeta(tenant, startTs, endTs, () => pricingClientT.getPricingAnalytics(wabaId, startTs, endTs))
      : null;
    return tarifsFactures({
      marketing: pricing?.byCategory['marketing']?.ratePerMessage,
      utility: pricing?.byCategory['utility']?.ratePerMessage,
      currency: pricing?.currency,
    }, grilleDepuisLigne(ligne));
  };

  /**
   * Les liens tracés des templates d'un scénario. Le bloc d'un clic ne se déduit que du graphe : c'est le
   * montage commun à la fiche d'une campagne et aux mesures d'un scénario, écrit une fois.
   */
  const liensDesTemplates = async (tenant: string, noeuds: readonly NoeudTemplate[]): Promise<LienTrace[]> =>
    (noeuds.length > 0 ? d.liens.listByTemplates(tenant, noeuds.map((n) => n.templateName)) : []);

  const grille = async (): Promise<GrillePrix> => grilleDepuisLigne(await d.stats.grillePrixGlobale());

  return {
    grille,
    // La même grille que les prix : deux lectures donneraient deux marges.
    margeTemplate: async () => (await grille()).margeTemplate,

    /**
     * 🔴 Ce chemin porte aussi la marge : il alimente « Détail par template » du Quantitatif et le coût de
     * l'écran Campagnes. Sans elle, la même campagne aurait deux prix sur deux écrans.
     * `cost` et `totalCost` ne sont pas margés : ce sont les charges réelles facturées par Meta. Seul
     * `ratePerMessage` devient un prix, parce que c'est lui que les écrans multiplient par un volume.
     */
    getPricing: async (tenant, range) => {
      const [wabaId, ligne] = await Promise.all([d.waba.getTenantWabaId(tenant), d.stats.grillePrixGlobale()]);
      if (!wabaId) return null;
      const { startTs, endTs } = rangeToUnix(range);
      const pricing = await d.meta.pricingClientForTenant(tenant); // token par tenant, repli global
      // Le même cache que `prixFactures` (même clé, même fenêtre) : l'onglet Campagnes appelle aussi cette
      // route à chaque montage, et contournerait sinon le cache par la porte d'à côté.
      const brut = await tarifMeta(tenant, startTs, endTs, () => pricing.getPricingAnalytics(wabaId, startTs, endTs));
      if (!brut) return brut;
      return pricingFacture(brut, grilleDepuisLigne(ligne));
    },

    getCostSeries: async (tenant, range, filter) => {
      const [rows, rates] = await Promise.all([
        d.stats.getCostVolume(tenant, range, filter),
        prixFactures(tenant, range),
      ]);
      return estimateCostSeries(range.from, range.to, rows, rates);
    },

    /**
     * Le tableau « ce que coûte un engagement » de la page de synthèse. Les tarifs Meta viennent du même
     * appel que le graphe de coût (`prixFactures`), pour ne pas afficher deux coûts dans le même onglet. Le
     * calcul est pur (`estimateCoutParCampagne`).
     */
    getCoutParCampagne: async (tenant, range, opts) => {
      const [volumes, rates, serviceMois, ligne, rcs] = await Promise.all([
        // La rétention voyage jusqu'ici : une campagne dont les envois ont été purgés garde une case vide
        // plutôt qu'un 0,00 € qui se lirait « gratuit ».
        d.stats.getVolumeParCampagne(tenant, range, { ...opts, retentionJours: d.retentionJours }),
        prixFactures(tenant, range),
        // Le même calcul de franchise que la ligne « Messages », par les mêmes deux lectures : sinon deux
        // coûts de service sur la même carte. Voir `estimateCoutParCampagne` pour le prorata.
        d.stats.serviceParMois(tenant, range),
        d.stats.grillePrixGlobale(),
        // Et le même lot de RCS que cette ligne-là, par la même lecture et la même règle de bascule.
        // 🔴 `attribuer` : seul cet appelant lit `campaignId`, et l'attribution coûte une sous-requête corrélée
        // par message RCS, non servie par un index. Sans lui, le magasin rend `campaignId: null` partout et
        // TOUTES les campagnes RCS retombent à une case vide.
        d.stats.envoisEtReactionsRcs(tenant, range, FENETRE_BASCULE_MS, { attribuer: true }),
      ]);
      const ids = [...new Set(volumes.map((v) => v.campaignId))];
      // Les trois en parallèle : lectures indépendantes sur la même liste, et cette route sert la page
      // d'accueil de Performance lab.
      const [clics, engagements, services] = await Promise.all([
        d.stats.clicsParCampagne(tenant, ids),
        d.stats.engagementsParCampagne(tenant, ids),
        d.stats.servicesParCampagne(tenant, ids, range),
      ]);
      /**
       * Le prix effectif d'un message de service sur la période, franchise déduite. Il se calcule : le tarif
       * est celui d'un message facturé, la franchise mensuelle en rend une partie gratuite (une période sous
       * le millième vaut zéro). Prendre le tarif nu surfacturerait chaque campagne du début de mois.
       * `envoyes === 0` -> ni division ni imputation.
       */
      const cm = coutMessages(
        { templates: [], rates, service: serviceMois, rcsSimple: 0, rcsConversationnel: 0 },
        grilleDepuisLigne(ligne),
      );
      const prixUnitaire = cm.service.envoyes > 0 ? cm.service.cout / cm.service.envoyes : 0;
      // La marge est déjà dans `rates` (cf. `prixFactures`) : la réappliquer la compterait deux fois. Elle
      // ne touche pas le RCS, dont le prix saisi est déjà un prix de vente.
      return estimateCoutParCampagne(volumes, rates, clics, engagements,
        { parCampagne: services, prixUnitaire },
        { parCampagne: repartirRcs(rcs).parCampagne, grille: grilleDepuisLigne(ligne) });
    },

    /**
     * Le coût total des messages de la période : templates margés, service franchise déduite, RCS. Les
     * mêmes tarifs Meta que le graphe et le tableau, par le même `prixFactures`.
     * La bascule RCS se calcule ici par la fonction pure `basculesRcs` (testée), pas en SQL : deux
     * implémentations de la règle divergeraient sans se voir. Le store garde tous les instants, rien n'est
     * approximé. La fenêtre passe au SQL depuis `FENETRE_BASCULE_MS`, jamais un `interval` recopié à côté.
     */
    getCoutMessages: async (tenant, range) => {
      const [volumes, rates, service, rcs, ligne] = await Promise.all([
        d.stats.getCostVolume(tenant, range, {}),
        prixFactures(tenant, range),
        d.stats.serviceParMois(tenant, range),
        // 🔴 SANS attribution : ce chemin ne lit pas `campaignId`, et la page de synthèse appelle les deux
        // routes, donc la sous-requête tournerait deux fois par affichage pour une colonne jetée.
        d.stats.envoisEtReactionsRcs(tenant, range, FENETRE_BASCULE_MS),
        d.stats.grillePrixGlobale(),
      ]);
      const { simple, conversationnel } = repartirRcs(rcs);
      return coutMessages(
        {
          templates: volumes.map((v) => ({ category: v.category, count: v.count })),
          rates,
          service,
          rcsSimple: simple,
          rcsConversationnel: conversationnel,
        },
        grilleDepuisLigne(ligne),
      );
    },

    /**
     * Ce que le client a dépensé en IA sur son crédit, et le détail de ses tours. Rien de ce qui est sur
     * notre clé n'y entre (transcription, bot d'aide, assistants), ni le Meta Business Agent, facturé au
     * message de service (`getCoutMessages`).
     */
    getCoutIa: async (tenant, range) => d.stats.consommationIa(tenant, range, PLAFOND_TOURS_IA),

    /**
     * La fiche d'une campagne, ouverte depuis sa ligne du tableau. Les mêmes tarifs que le tableau, par le
     * même `prixFactures`, sur les trente derniers jours alors que la fiche couvre toute la vie de la
     * campagne (cf. `trenteDerniersJours`).
     * `null` -> 404 : la campagne n'est pas dans cet espace, lue avant le reste pour ne rien payer de plus.
     */
    getDetailCoutCampagne: async (tenant, campaignId) => {
      const campagne = await d.stats.ficheCampagne(tenant, campaignId);
      if (campagne === null) return null;
      const [envois, rates, funnel, evenements] = await Promise.all([
        d.stats.envoisDeLaCampagne(tenant, campaignId),
        prixFactures(tenant, trenteDerniersJours()),
        d.stats.getCampaignFunnel(tenant, campaignId),
        campagne.workflowId ? d.stats.mesuresScenarioParCampagne(tenant, campaignId) : Promise.resolve([]),
      ]);
      /**
       * Les clics de liens tracés attribués à cette campagne, fusionnés aux événements de blocs, par le même
       * montage que `getWorkflowNodeCounts` (`liensDesTemplates`). Best-effort : une panne retire la colonne
       * des liens, pas le coût ni les réponses.
       */
      let clics: CompteurClic[] = [];
      let clicsAnonymes = 0;
      if (campagne.workflowId) {
        try {
          const wf = await d.scenarios.getById(campagne.workflowId, tenant);
          const noeuds = noeudsTemplate(wf?.graph);
          const liens = await liensDesTemplates(tenant, noeuds);
          if (liens.length > 0) {
            const compte = await d.liens.clicsAttribuesCampagne(tenant, campaignId, liens.map((l) => l.code));
            clics = compteursDeClics(noeuds, liens, compte.attribues);
            clicsAnonymes = compte.anonymes;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('clics attribues a la campagne ignores:', messageDe(err));
        }
      }
      return assemblerDetailCampagne({
        campagne, envois, rates, funnel, mesures: [...evenements, ...clics], clicsAnonymes,
      });
    },

    /**
     * Mesures d'un scénario : les événements de blocs, plus les clics sur les liens tracés des templates
     * qu'il envoie. Les clics ne peuvent pas vivre dans `workflow_node_events` (elle exige un `wa_id`, un
     * clic sur un lien statique n'identifie personne) : ils sont fusionnés à la lecture. Best-effort sur les
     * liens : une panne retire la mesure de clic, pas les compteurs d'envoi et de lecture.
     */
    getWorkflowNodeCounts: async (tenant, workflowId, range) => {
      const evenements = await d.evenements.countByNode(tenant, workflowId, range);
      try {
        const wf = await d.scenarios.getById(workflowId, tenant);
        const noeuds = noeudsTemplate(wf?.graph);
        // Les blocs RCS ont leurs propres liens, sur une autre clé (l'adresse) et un autre espace de noms de
        // handle (`lien:i`) : les deux familles se lisent séparément puis se concatènent.
        const liensRcs = liensRcsDesNoeuds(wf?.graph);
        if (noeuds.length === 0 && liensRcs.length === 0) return evenements;

        const codesRcs = liensRcs.length > 0
          ? await d.liens.codesRcsParDestination(tenant, liensRcs.map((l) => l.destination))
          : new Map<string, string>();
        const liens = await liensDesTemplates(tenant, noeuds);
        const tousLesCodes = [...liens.map((l) => l.code), ...codesRcs.values()];
        if (tousLesCodes.length === 0 && liensRcs.length === 0) return evenements;
        const clics = await d.liens.countClicks(tenant, tousLesCodes, range);
        return [
          ...evenements,
          ...compteursDeClics(noeuds, liens, clics),
          ...compteursDeClicsRcs(liensRcs, codesRcs, clics),
        ];
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('mesures de clics ignorées:', messageDe(err));
        return evenements;
      }
    },

    /**
     * Le bilan d'un contact : son coût estimé et son entonnoir d'engagement. Les mêmes tarifs que la fiche
     * de campagne, par le même `prixFactures` et la même fenêtre (`trenteDerniersJours`) : un client qui
     * compare le coût d'un contact à celui de sa campagne doit retrouver la même arithmétique.
     */
    getBilanContact: async (tenant, id) => {
      const matiere = await d.historique.bilanContact(tenant, id);
      if (!matiere) return null;
      const rates = await prixFactures(tenant, trenteDerniersJours());
      return {
        cout: estimerCoutContact(matiere.envois, rates),
        entonnoir: entonnoirEngagement(matiere.profondeurs),
      };
    },
  };
}
