'use client';

/**
 * Analytics : agregats du tableau de bord, reglages de l'espace, analyse de conversation.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';
import type { Intention } from '../intentions';

// --- Dashboard (stats + réglages) ---

export interface DailyPoint {
  date: string;
  count: number;
}
export interface DashboardStats {
  contacts: DailyPoint[];
  /**
   * Les contacts ENCORE dans le mini-CRM ce jour-la (bascule cumules/actifs, demandee le 2026-09-23).
   *
   * ⚠️ OPTIONNEL A LA LECTURE : un backend plus ancien que ce champ ne l'envoie pas, et l'ecran masque alors
   * la bascule au lieu de tracer une courbe vide qu'on prendrait pour « plus aucun contact ».
   */
  contactsActifs?: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
  /** Sortants qui ne sont PAS des templates (inbox, scenario dans la fenetre de 24 h). Sous-ensemble d'`exchanged`. */
  service: DailyPoint[];
  /**
   * Les memes messages de service, ventiles par ce qui les a ECRITS (migration 0099). Leur somme egale
   * celle de `service` sur la periode. `indeterminee` vaut zero tant qu'aucun chemin d'ecriture n'a
   * oublie de poser son origine : le montrer est ce qui empeche un tel message d'etre range en silence
   * dans un theme qui l'accueille.
   *
   * Optionnel a la lecture : un backend plus ancien que ce champ ne l'envoie pas, et l'ecran doit alors
   * masquer le tableau plutot que d'afficher trois zeros qui passeraient pour une mesure.
   */
  serviceParOrigine?: { ia: number; scenario: number; humain: number; indeterminee: number };
  /**
   * Le detail sous le theme « IA » : notre agent, celui de Meta, un agent tiers branche par MCP.
   *
   * ⚠️ OPTIONNEL comme son voisin, et pour la meme raison : pendant un deploiement, l'API d'avant ne le
   * connait pas. Absent, la carte n'affiche pas de detail, ce qui est une mesure MANQUANTE ; inventer des
   * zeros serait une mesure FAUSSE, qui ferait croire qu'aucune IA n'a ecrit.
   */
  serviceIaDetail?: { agent: number; mba: number; mcp: number };
}
/** Plage de dates des stats (YYYY-MM-DD, Europe/Paris). Absente -> le backend retombe sur 30 jours. */
export interface StatsRange {
  from: string;
  to: string;
}
function rangeQuery(range?: StatsRange): string {
  return range ? `?from=${range.from}&to=${range.to}` : '';
}
export function getStats(tenantId: string, range?: StatsRange): Promise<DashboardStats> {
  return request<DashboardStats>(`/tenants/${tenantId}/stats${rangeQuery(range)}`);
}
/**
 * Envoyés et reçus par canal sur 30 jours, pour les cartes « Numéro WhatsApp » et « Canal RCS » de l'Accueil.
 *
 * ⚠️ `unknown`, DÉLIBÉRÉMENT : la réponse ne se lit QUE par `lireVolumesCanaux` (`@/lib/chiffres-canaux`), qui
 * rend `null` pour tout ce qui n'a pas la bonne forme (API plus ancienne, corps vide). Un type posé ici
 * laisserait lire `r.whatsapp.envoyes` sans garde, donc `undefined` puis un zéro inventé à l'écran.
 */
export function getVolumesCanaux(tenantId: string): Promise<unknown> {
  return request<unknown>(`/tenants/${tenantId}/accueil/volumes`);
}
/** Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus + échecs. */
export interface CampaignFunnel {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  /** Envois partis dont Meta n'a rendu AUCUN accusé : « on ne sait pas », pas « non délivré ». Systématique
   *  pour une campagne à scénario (identifiant de message synthétique, que l'accusé de Meta ne peut pas
   *  apparier). Optionnel : une instance antérieure au 2026-09-11 ne le rend pas. */
  sansAccuse?: number;
  /** Taps sur un bouton de reponse rapide. Sous-ensemble de `replied`. */
  buttonReplies: number;
  /**
   * Clics sur les liens traces du template, depuis le premier envoi de la campagne.
   * `null` = ce template ne porte aucun lien trace : l etape ne doit pas etre affichee.
   */
  urlClicks: number | null;
  /**
   * Combien d'HUMAINS la campagne a visés, quel que soit le nombre de tentatives faites pour les joindre.
   * Optionnel : une instance antérieure au 2026-09-12 ne le rend pas.
   *
   * ⚠️ Ne se déduit PAS de la somme de `parCanal`, qui compte des TENTATIVES : une personne jointe au
   * second étage après un échec au premier y compte deux fois, et ici une seule.
   */
  contactsVises?: number;
  /**
   * La ventilation par canal (journal des tentatives, migration 0134).
   *
   * ⚠️ VIDE N'EST PAS ZÉRO : le journal ne contient que les tentatives postérieures à sa mise en service,
   * donc une campagne plus ancienne n'a aucune ligne alors que ses compteurs du haut sont complets. La
   * ventilation se TAIT dans ce cas ; elle n'affiche pas des canaux à zéro.
   */
  parCanal?: FunnelCanal[];
}
/** Les compteurs d'UN canal, au grain TENTATIVE. */
export interface FunnelCanal {
  canal: 'whatsapp' | 'rcs' | 'email';
  envois: number;
  reussis: number;
  delivres: number;
  lus: number;
  repondus: number;
  /** Tentatives parties sans aucun accusé de Meta, POUR CE CANAL : « on ne sait pas », pas « non ». */
  sansAccuse: number;
}
export function getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel> {
  return request<CampaignFunnel>(`/tenants/${tenantId}/stats/campaign-funnel?campaignId=${encodeURIComponent(campaignId)}`);
}

/** Une ligne du breakdown d'erreurs Meta : code numérique + template + campagne + occurrences. */
export interface ErrorBreakdownRow {
  code: number;
  count: number;
  /** Template de la campagne à l'origine des erreurs (null si non renseigné). */
  templateName: string | null;
  /**
   * La campagne d'où viennent ces erreurs, jamais nulle : seules les campagnes peuvent en porter.
   *
   * ⚠️ La ligne est plus fine que ce que l'écran affiche : une par (code, template, campagne). La carte
   * agrège par code, donc l'affichage sans filtre est le même qu'avant ; ce que ces champs apportent, c'est
   * de pouvoir filtrer par campagne SANS redemander au serveur.
   */
  campaignId: string;
  campaignName: string;
}
export function getErrorBreakdown(tenantId: string, range?: StatsRange): Promise<{ errors: ErrorBreakdownRow[] }> {
  return request<{ errors: ErrorBreakdownRow[] }>(`/tenants/${tenantId}/stats/errors${rangeQuery(range)}`);
}

/**
 * Un contact touché par un code d'erreur : qui, dans quelle campagne, quand, et ce que Meta a répondu.
 *
 * 🔴 C'EST LA LIGNE DU JOURNAL DES ERREURS DE LIVRAISON, celle que sert déjà l'écran de Paramètres. Le
 * serveur ne construit pas une seconde forme pour Analytics : deux écrans qui portent le même titre et
 * comptent deux populations voisines finissent par se contredire chez un client.
 */
export interface ErrorContactRow {
  recipientId: string;
  campaignId: string | null;
  campaignName: string | null;
  /** Le numéro tel qu'il a été appelé (E.164, avec le « + »). Toujours présent. */
  telephone: string;
  contactId: string | null;
  contactNom: string | null;
  code: number | null;
  /** Ce que Meta a répondu. Affiché tel quel, borné côté serveur. */
  message: string | null;
  /** `envoi` = jamais parti, `livraison` = parti puis refusé, `scenario` = panne d'avance de parcours. */
  origine: 'envoi' | 'livraison' | 'scenario';
  at: string | null;
}
/**
 * Les contacts touchés par UN code d'erreur, avec les mêmes filtres que le breakdown.
 *
 * 🔴 NE COUVRE QUE LES CAMPAGNES, et l'écran doit le dire : `error_code` n'existe que sur
 * `campaign_recipients`, un envoi de scénario ou d'inbox ne journalise que son succès. Mesuré le
 * 2026-09-07 avant d'écrire l'écran, plutôt que promis puis découvert vide.
 */
export function getErrorContacts(
  tenantId: string, code: number, range?: StatsRange, filter?: FiltreCampagneOuTemplate,
): Promise<{ contacts: ErrorContactRow[]; tronque: boolean; plafond: number }> {
  return request<{ contacts: ErrorContactRow[]; tronque: boolean; plafond: number }>(
    `/tenants/${tenantId}/stats/errors/${code}/contacts${filtreQuery(range, filter)}`,
  );
}

/** Série de coût estimé/jour, par catégorie. `hasRates=false` si Meta n'a fourni aucun tarif. */
export interface CostSeries {
  marketing: DailyPoint[];
  utility: DailyPoint[];
  total: number;
  hasRates: boolean;
  /**
   * Envois comptés dans les VOLUMES mais absents de ce coût, faute de catégorie connue ou de tarif.
   *
   * 🔴 L'écran doit le DIRE. Sans ce champ, ces envois disparaissaient du calcul en silence et le client
   * lisait un coût nul là où il avait bien envoyé (22 envois de scénario du tenant Demo, dont la catégorie
   * n'était pas écrite avant le 2026-09-07). Un volume non chiffrable est une information ; l'escamoter en
   * fait un mensonge par omission.
   */
  nonChiffrables: number;
  /**
   * ...sans categorie enregistree : HERITAGE ferme (cf. `web/lib/cout-non-chiffrable.ts`).
   *
   * ⚠️ OPTIONNEL, et le type dit ici la VERITE du reseau : la console part sur Vercel a chaque push, l'API
   * se deploie a la main sur le VPS. Entre les deux, la reponse ne porte pas ces deux champs.
   */
  sansCategorie?: number;
  /** ...dont Meta ne rend pas le tarif : panne VIVANTE, reparable. Meme reserve d'absence. */
  sansTarif?: number;
  /** Devise du compte (ISO 4217) rendue par Meta ; null = inconnue, on affiche le nombre nu. */
  currency: string | null;
}
/**
 * Les deux axes de filtre des écrans d'Analytics : DES campagnes OU DES templates, jamais les deux (les
 * croiser décrirait leur intersection). Une liste vide vaut « tout ».
 */
export interface FiltreCampagneOuTemplate {
  campaignIds?: string[];
  templateNames?: string[];
}

/**
 * La chaîne de requête « plage + filtres », écrite UNE fois.
 *
 * Elle l'était deux fois dans ce fichier, à vingt-cinq lignes d'écart, avec le même piège recopié : le
 * séparateur dépend de la présence de la plage (`?` sinon `&`).
 */
function filtreQuery(range?: StatsRange, filter?: FiltreCampagneOuTemplate): string {
  const parts: string[] = [];
  if (filter?.campaignIds?.length) parts.push(`campaignIds=${encodeURIComponent(filter.campaignIds.join(','))}`);
  if (filter?.templateNames?.length) parts.push(`templateNames=${encodeURIComponent(filter.templateNames.join(','))}`);
  const base = rangeQuery(range);
  return parts.length ? `${base}${base ? '&' : '?'}${parts.join('&')}` : base;
}

/** Filtre du graphe de coût. Plusieurs valeurs -> série COMPILÉE. Les deux axes sont mutuellement exclusifs. */
export function getCostSeries(tenantId: string, range?: StatsRange, filter?: FiltreCampagneOuTemplate): Promise<CostSeries> {
  return request<CostSeries>(`/tenants/${tenantId}/stats/cost${filtreQuery(range, filter)}`);
}

/** Un tableau ENREGISTRE : une selection (scenario + mesures), jamais des chiffres. */
export interface TableauEnregistre {
  id: string;
  workflowId: string;
  name: string;
  mesures: Array<{ cle: string; label: string; kind: string; handle: string | null }>;
  updatedAt: string;
}

export function listWorkflowReports(tenantId: string): Promise<{ reports: TableauEnregistre[] }> {
  return request<{ reports: TableauEnregistre[] }>(`/tenants/${tenantId}/workflow-reports`);
}

/** Cree, ou met a jour si `id` est fourni. Meme bouton a l'ecran, donc meme route. */
export function saveWorkflowReport(
  tenantId: string,
  input: { id?: string; workflowId: string; name: string; mesures: TableauEnregistre['mesures'] },
): Promise<{ report: TableauEnregistre }> {
  return request(`/tenants/${tenantId}/workflow-reports`, { method: 'POST', body: JSON.stringify(input) });
}

export function deleteWorkflowReport(tenantId: string, id: string): Promise<{ ok: boolean }> {
  return request(`/tenants/${tenantId}/workflow-reports/${id}`, { method: 'DELETE' });
}

/** Une mesure brute d'un bloc de scenario (« Mes tableaux »). */
export interface NodeEventCount {
  nodeId: string;
  kind: string;
  handle: string | null;
  count: number;
  /** Personnes distinctes. null quand la mesure ne sait pas les distinguer (un clic sur un lien de template). */
  contacts: number | null;
}

/** Mesures d'un scenario, bloc par bloc, sur la periode. Brutes : c'est l'ecran qui compose le tableau. */
export function getWorkflowNodeCounts(tenantId: string, workflowId: string, range?: StatsRange): Promise<{ counts: NodeEventCount[] }> {
  return request<{ counts: NodeEventCount[] }>(`/tenants/${tenantId}/stats/workflow/${workflowId}${rangeQuery(range)}`);
}

export interface TemplateBreakdownRow {
  name: string;
  category: string | null;
  count: number;
}
export interface CategoryPricing {
  category: string;
  cost: number;
  volume: number;
  ratePerMessage: number;
}
export interface PricingSummary {
  byCategory: Record<string, CategoryPricing>;
  totalCost: number;
  /** Devise du WABA (ISO 4217) rendue par Meta ; null = non communiquee. */
  currency: string | null;
}
export interface TemplateStats {
  breakdown: TemplateBreakdownRow[];
  /** null si Meta indisponible : afficher le volume seul, jamais un faux prix. */
  pricing: PricingSummary | null;
  /**
   * La marge de l espace, en pourcent. Sert a NOMMER la cause de l ecart entre le cout estime (prix de
   * vente) et le total facture par Meta, sur la page qui pose les deux cote a cote.
   *
   * ⚠️ OPTIONNELLE : une instance anterieure au 2026-09-18 ne la rend pas, et l ecran retombe alors sur sa
   * phrase d avant, qui reste juste tant qu aucune marge n est posee.
   */
  margeTemplate?: number;
}
export function getTemplateStats(tenantId: string, range?: StatsRange): Promise<TemplateStats> {
  return request<TemplateStats>(`/tenants/${tenantId}/stats/templates${rangeQuery(range)}`);
}

// --- Analyse de conversation (Pièce 1) : agrégats quanti + liste quali. Champs LLM = INDICATIFS. ---
export interface ConversationAnalysisSummary {
  /** Feature d'analyse active côté serveur (empty-state différencié : inactif vs aucune donnée). */
  enabled: boolean;
  /**
   * Combien de jours une conversation reste consultable (purge du worker). Optionnel a la lecture : une API
   * plus ancienne que ce champ ne l'envoie pas, et l'ecran tait alors la phrase plutot que d'annoncer une
   * duree inventee.
   */
  retentionDays?: number;
  total: number;
  sentiment: { positif: number; neutre: number; negatif: number };
  /**
   * ⚠️ PARTIEL A LA LECTURE, comme `topicsParIntention` plus bas et pour la meme raison de RESEAU : une API
   * plus ancienne que la console ne connait pas les intentions ajoutees depuis, et une cle absente n est pas
   * un zero que l API aurait envoye. Le type oblige chaque lecteur a passer par `comptesParIntention`
   * (`web/lib/intentions.ts`), qui la ramene a zero.
   */
  intent: Partial<Record<Intention, number>>;
  resolution: { resolved: number; unresolved: number; rate: number | null };
  handledBy: { humain: number; automatise: number; mba: number };
  exchanges: { avg: number | null; median: number | null };
  actions: { creer_devis: number; rappeler: number; relancer: number; escalader: number; aucune: number };
  topTopics: Array<{ topic: string; count: number }>;
  /**
   * Les sujets les plus frequents DE CHAQUE INTENTION, cinq au plus (2026-09-17).
   *
   * ⚠️ CE N EST PAS UNE DECOUPE DE `topTopics` : celui-la classe les dix premiers TOUTES intentions
   * confondues, celui-ci en garde cinq PAR intention, donc il en montre que l autre n aurait jamais. Un
   * sujet frequent dans une intention rare n entre pas dans les dix premiers, et c est justement celui
   * qu on veut voir en depliant cette intention.
   *
   * ⚠️ OPTIONNEL A LA LECTURE, comme `retentionDays` juste au-dessus, et pour la meme raison de RESEAU : la
   * console part sur Vercel a chaque push quand l API se deploie a la main sur le VPS. Entre les deux, le
   * champ est absent, et l ecran doit alors ne rien deplier plutot que de boucler sur `undefined`.
   */
  topicsParIntention?: Record<string, Array<{ topic: string; count: number }>>;
  confidence: { lt50: number; from50to70: number; from70to90: number; gte90: number };
}
export interface AnalyzedConversation {
  /**
   * LES ORIGINES DES MESSAGES SORTANTS, dedoublonnees (migration 0099). C est de la que se derivent les
   * badges « qui a repondu », et SURTOUT PAS de handledBy, dont la valeur mba est declaree dans
   * l enumeration mais n est JAMAIS produite (mesure en production : zero ligne sur 14).
   *
   * ⚠️ OPTIONNELLE A LA LECTURE : entre le deploiement de Vercel et celui du VPS, le champ est absent, et
   * l ecran n affiche alors aucun badge plutot que d en inventer.
   */
  origines?: string[];
  conversationId: string;
  waId: string;
  profileName: string | null;
  sentiment: string;
  intent: string;
  topic: string;
  resolved: boolean;
  actionSuggestion: string;
  confidence: number;
  justification: string;
  handledBy: string;
  exchangesCount: number;
  analyzedAt: string;
  /** Lien vers le fil dans l'inbox (/inbox?c=<conversationId>). */
  inboxHref: string;
  /**
   * Ce qui s'est DIT, ecrit par l'analyse (migration 0100). `null` pour les analyses d'avant : la fiche
   * l'annonce, et ne le remplace JAMAIS par `justification`, qui explique le classement et pas le contenu.
   */
  summary?: string | null;
  /** Infos extraites par l'analyse (produit, budget, quantite...). `{}` si rien. */
  entities?: Record<string, unknown>;
}
/**
 * Une ligne du tableau « ce que coute un engagement » (lot E du 2026-09-08).
 *
 * 🔴 TROIS CHAMPS PEUVENT ETRE `null`, ET AUCUN NE VAUT ZERO. `cout` null = aucun envoi chiffrable (Meta
 * n'a pas rendu de tarif, ou la categorie manque) ; `clics` null = rien de mesurable ici (campagne a
 * scenario, donc sans template, ou template sans lien trace) ; `coutParClic` null des qu'un des deux
 * termes manque ou que les clics valent zero. L'ecran laisse ces cases VIDES et dit pourquoi : un zero
 * affirmerait « ca n'a rien coute » ou « personne n'a clique ».
 */
export interface LigneCoutCampagne {
  campaignId: string;
  nom: string;
  /** `null` pour une campagne a scenario : c'est ce qui explique l'absence de clics. */
  template: string | null;
  envoyes: number;
  cout: number | null;
  /** Envois comptes dans `envoyes` mais absents du cout. Somme des deux causes qui suivent. */
  nonChiffrables: number;
  /**
   * ...sans categorie enregistree : HERITAGE ferme (cf. `web/lib/cout-non-chiffrable.ts`).
   *
   * ⚠️ OPTIONNEL, et le type dit ici la VERITE du reseau : la console part sur Vercel a chaque push, l'API
   * se deploie a la main sur le VPS. Entre les deux, la reponse ne porte pas ces deux champs.
   */
  sansCategorie?: number;
  /** ...dont Meta ne rend pas le tarif : panne VIVANTE, reparable. Meme reserve d'absence. */
  sansTarif?: number;
  /**
   * Personnes TOUCHÉES sur la période, facturable ou non : ce que la colonne « Envoyés » affiche (lot 4).
   * ⚠️ OPTIONNEL, même réserve de RÉSEAU que `sansCategorie` : absent, l'écran retombe sur `envoyes`.
   */
  envois?: number;
  clics: number | null;
  coutParClic: number | null;
  /**
   * LES PERSONNES QUI SE SONT ENGAGEES : celles qui ont clique, ET celles qui ont REPONDU (2026-09-13).
   *
   * 🔴 UNE REPONSE EST UN ENGAGEMENT DE PREMIER NIVEAU, decision de Julien sur un cas reel : le
   * destinataire n avait pas clique mais avait repondu, et le tableau annoncait « aucun engagement ».
   * 🔴 DES PERSONNES, PAS DES GESTES : quelqu un qui clique PUIS repond compte une fois. Diviser un cout
   * par des personnes donne ce que coute une personne engagee, ce qui se compare d une campagne a l autre.
   * ⚠️ OPTIONNEL, meme reserve de RESEAU que `sansCategorie` : la console part sur Vercel a chaque push,
   * l API se deploie a la main. Entre les deux, la reponse ne porte pas ce champ et l ecran retombe sur
   * les clics.
   */
  engagements?: number | null;
  /** Cout par personne engagee. `null` aux memes conditions que `coutParClic`. */
  coutParEngagement?: number | null;
}
export interface CoutParCampagne {
  lignes: LigneCoutCampagne[];
  /**
   * La periode comptait PLUS de campagnes que le tableau n'en montre (il garde celles qui ont le plus
   * envoye). L'ecran le DIT : une troncature muette se lit comme un inventaire complet.
   */
  tronque: boolean;
  /** Devise rendue par Meta ; `null` = inconnue, l'ecran affiche alors le nombre nu. */
  currency: string | null;
  /** Meta n'a rendu AUCUN tarif : toute la colonne cout est vide, et l'ecran doit dire pourquoi. */
  hasRates: boolean;
}
/**
 * La FICHE d'une campagne, ouverte en cliquant sa ligne dans le tableau du cout.
 *
 * 🔴 ELLE COUVRE TOUTE LA VIE DE LA CAMPAGNE, pas la periode du haut de l'ecran, et c'est une decision de
 * Julien du 2026-09-09 : un scenario recoit des reponses pendant des jours. Bornee a sept jours, la fiche
 * montrerait le cout d'un lancement ampute des interactions qu'il a produites ensuite, donc un cout par
 * interaction faux DANS LE SENS QUI FLATTE. Le tableau reste sur la periode : deux questions differentes,
 * et l'ecran le dit plutot que de laisser croire a une incoherence.
 */
export interface VolumeChiffre {
  envoyes: number;
  /** `null` quand aucun de ces envois n'a pu etre chiffre. Jamais zero : zero se lirait « gratuit ». */
  cout: number | null;
  /** Total non chiffre, plus ses deux causes : la forme qu'attend `web/lib/cout-non-chiffrable.ts`. */
  nonChiffrables: number;
  sansCategorie: number;
  sansTarif: number;
}
/** Ce que les gens ont fait a UN bloc du scenario. Les deux unites, parce qu'elles repondent a deux questions. */
export interface EtapeCoutCampagne {
  nodeId: string;
  envoyes: { gestes: number; personnes: number };
  /** Clics sur les liens traces du template de ce bloc, ATTRIBUES a cette campagne. Pas de compte de personnes. */
  liens: { gestes: number };
  boutons: { gestes: number; personnes: number };
  reponses: { gestes: number; personnes: number };
  /** `boutons.gestes + reponses.gestes` : le denominateur du ratio, pas un total a afficher. */
  interactions: number;
  /** Cout du LANCEMENT / interactions de cette etape. `null` si un terme manque ou si le total est nul. */
  coutParInteraction: number | null;
}
export interface DetailCoutCampagne {
  campaignId: string;
  nom: string;
  template: string | null;
  /** Le scenario, s'il y en a un : c'est lui qui nomme les etapes. `null` = campagne a template direct. */
  workflowId: string | null;
  devise: string | null;
  lancement: VolumeChiffre & {
    echecs: number;
    clics: number | null;
    coutParClic: number | null;
    reponses: number;
    boutons: number;
  };
  relances: VolumeChiffre;
  etapes: EtapeCoutCampagne[];
  /** Clics survenus depuis le lancement mais SANS identifiant : ils ne sont attribuables a personne. */
  clicsAnonymes: number;
}
export function getDetailCoutCampagne(tenantId: string, campaignId: string): Promise<DetailCoutCampagne> {
  return request<DetailCoutCampagne>(`/tenants/${tenantId}/stats/cost/campaigns/${campaignId}`);
}

export function getCoutParCampagne(tenantId: string, range?: StatsRange, inclureArchivees = false): Promise<CoutParCampagne> {
  const q = rangeQuery(range);
  const archivees = inclureArchivees ? `${q === '' ? '?' : '&'}archivees=1` : '';
  return request<CoutParCampagne>(`/tenants/${tenantId}/stats/cost/campaigns${q}${archivees}`);
}

/**
 * LE COUT TOTAL DES MESSAGES ENVOYES sur la periode (ligne 2 de la carte « Couts »).
 *
 * ⚠️ `parMois` PORTE UNE LIGNE PAR MOIS TRAVERSE, et pas un seul compteur de franchise : la franchise est
 * MENSUELLE et se remet a zero le 1er. Une periode a cheval sur deux mois en a DEUX, et l'ecran montre
 * celle du mois qui l'interesse.
 */
export interface FranchiseMois {
  mois: string;
  /** Total du mois a la fin de la periode : c'est ce qui se lit « 340 / 1000 ». */
  consommes: number;
  plafond: number;
  /** Ceux de ce mois, DANS la periode, qui sont payants. */
  factures: number;
}
export interface CoutMessages {
  templates: { marketing: number; utility: number };
  service: { envoyes: number; factures: number; cout: number; parMois: FranchiseMois[] };
  rcs: { simple: number; conversationnel: number; cout: number };
  total: number;
  /**
   * 🔴 LA DEVISE VOYAGE AVEC CE TOTAL, ET PAS AVEC L APPEL VOISIN. Trouve en revue le 2026-09-17 : la carte
   * prenait la devise de la route des campagnes, ce qui couplait l AFFICHAGE de deux lignes chargees
   * separement justement pour qu une panne de l une n abime pas l autre. Le test « les deux autres vivent »
   * passait quand meme, parce que le nombre s affichait, simplement sans son symbole.
   *
   * ⚠️ OPTIONNELLE A LA LECTURE : entre le deploiement de Vercel et celui du VPS, le champ est absent.
   * L ecran rend alors le nombre nu, ce qui est exactement ce qu il faisait avant.
   */
  currency?: string | null;
  nonChiffrables: number;
  sansCategorie: number;
  sansTarif: number;
}
export function getCoutMessages(tenantId: string, range?: StatsRange): Promise<CoutMessages> {
  return request<CoutMessages>(`/tenants/${tenantId}/stats/cost/messages${rangeQuery(range)}`);
}

/**
 * CE QUE LE CLIENT A DEPENSE EN IA sur SON credit (ligne 3 de la carte « Couts »).
 *
 * ⚠️ TOUT EST EN MICRO-EUROS, comme en base : aucun arrondi cote serveur, sinon le total divergerait de la
 * somme de ses lignes. La conversion est un geste d'AFFICHAGE (`eurosDepuisMicro`).
 *
 * ⚠️ ZERO EST UN ETAT NORMAL, PAS UNE PANNE : aucun tour d'agent n'a jamais tourne en production. L'ecran
 * doit dire « aucune consommation », jamais afficher un tiret qui se lirait comme une mesure manquante.
 */
export interface TourIa {
  id: string;
  agentId: string;
  tours: number;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  at: string;
}
export interface CoutIa {
  coutMicroEur: number;
  tokensEntree: number;
  tokensSortie: number;
  sessions: number;
  tours: TourIa[];
  tronque: boolean;
}
export function getCoutIa(tenantId: string, range?: StatsRange): Promise<CoutIa> {
  return request<CoutIa>(`/tenants/${tenantId}/stats/cost/ia${rangeQuery(range)}`);
}

/**
 * Le damier « satisfaction x urgence » (lot F du 2026-09-08, migration 0121).
 *
 * Un point par CASE occupee du damier (les deux notes sont des entiers de 0 a 10 : 121 positions au plus),
 * pas un point par conversation. `n` porte le nombre de conversations de la case.
 */
export interface NuageQualitatif {
  points: Array<{ satisfaction: number; urgence: number; n: number }>;
  /** Moyenne des conversations MESUREES. `null` si la periode n'en compte aucune. */
  moyenne: { satisfaction: number; urgence: number } | null;
  mesurees: number;
  /**
   * Analyses de la periode SANS les deux mesures : celles d'avant la migration, et celles ou le modele a
   * omis les notes. L'ecran l'affiche : sans ce compte, un nuage clairseme se lirait comme une periode
   * calme, et les analyses anciennes passeraient pour inexistantes.
   */
  sansMesure: number;
}
export function getNuageQualitatif(tenantId: string, range?: StatsRange): Promise<NuageQualitatif> {
  return request<NuageQualitatif>(`/tenants/${tenantId}/stats/conversations/nuage${rangeQuery(range)}`);
}
/**
 * LES JOURNEES de l ecran « Analyse des conversations » : une ligne par jour, pas par conversation.
 *
 * 🔴 ROUTE A PART, et c est ce qui rend l ecran tenable quand le client aura mille conversations : la
 * reponse est bornee par le nombre de JOURS de la periode, jamais par son trafic.
 */
export interface JourAnalyse {
  jour: string;
  conversations: number;
  /** ⚠️ null = aucune analyse de la journee ne porte la note. Ce n est PAS zero, qui est la PIRE note. */
  satisfaction: number | null;
  urgence: number | null;
  mesurees: number;
}
export function getJoursAnalyse(tenantId: string, range?: StatsRange): Promise<{ jours: JourAnalyse[] }> {
  return request<{ jours: JourAnalyse[] }>(`/tenants/${tenantId}/stats/conversations/jours${rangeQuery(range)}`);
}
export function getConversationAnalysisSummary(tenantId: string, range?: StatsRange): Promise<ConversationAnalysisSummary> {
  return request<ConversationAnalysisSummary>(`/tenants/${tenantId}/stats/conversations${rangeQuery(range)}`);
}
export function listAnalyzedConversations(
  tenantId: string,
  range?: StatsRange,
  filters?: { sentiment?: string; intent?: string; action?: string; topic?: string; limit?: number },
): Promise<{ conversations: AnalyzedConversation[] }> {
  const parts: string[] = [];
  if (filters?.sentiment) parts.push(`sentiment=${encodeURIComponent(filters.sentiment)}`);
  if (filters?.intent) parts.push(`intent=${encodeURIComponent(filters.intent)}`);
  if (filters?.action) parts.push(`action=${encodeURIComponent(filters.action)}`);
  if (filters?.topic) parts.push(`topic=${encodeURIComponent(filters.topic)}`);
  if (filters?.limit != null) parts.push(`limit=${filters.limit}`);
  const base = rangeQuery(range);
  const extra = parts.length ? (base ? `&${parts.join('&')}` : `?${parts.join('&')}`) : '';
  return request<{ conversations: AnalyzedConversation[] }>(`/tenants/${tenantId}/stats/conversations/list${base}${extra}`);
}

/** Horaires d'un jour. `closed` = fermé (aucune plage). `open`/`close` = 'HH:MM' (heure locale du tenant). */
export interface DayHours { closed: boolean; open: string; close: string }
/** Heures d'ouverture par jour, clés '0'..'6' (0 = dimanche). Miroir de `BusinessHours` serveur. */
export type BusinessHours = Record<string, DayHours>;

/**
 * Quand l'agent de Meta passe la main à un humain (écran « Activation »). Miroir de `MbaHandoffMode` serveur.
 * `business_hours` est le seul qui varie dans la journée : c'est un balayage serveur qui le fait suivre l'heure.
 */
export type MbaHandoffMode = 'always' | 'business_hours' | 'never';
/** Défaut usine tant que rien n'a été choisi : l'agent passe la main. */
export const DEFAULT_MBA_HANDOFF_MODE: MbaHandoffMode = 'always';

export interface TenantSettings {
  /** Durée du gel après prise de main par un opérateur, en secondes. null = défaut du serveur. */
  controlHandbackSeconds: number | null;
  /** Quand l'agent de Meta passe la main à un humain. null = jamais réglé (l'écran montre le défaut usine). */
  mbaHandoffMode: MbaHandoffMode | null;
  mbaEnabled: boolean;
  /** Canal RCS exploitable : vrai dès qu'un agent RCS est rattaché au tenant. DÉRIVÉ de l'état réel du dépôt,
   *  pas un réglage à basculer. Absent (backend plus ancien que le front) = éteint. */
  rcsEnabled?: boolean;
  hubspotListsEnabled: boolean;
  /** Pause des campagnes via listes HubSpot (F3-b). true = source HubSpot suspendue (pilotée par l'action Pause). */
  campaignsPaused: boolean;
  /** Auto-relance des échecs de livraison (F6). */
  autoRetryEnabled: boolean;
  /** Fuseau IANA du tenant (ex. 'Europe/Paris'). Base des conditions NOW / jour de semaine / heures d'ouverture. */
  timezone: string;
  /** Heures d'ouverture par jour ('0'..'6', 0 = dimanche). */
  businessHours: BusinessHours;
  /**
   * UN PORTAIL HUBSPOT EST-IL LIE A CET ESPACE ? (lot 9, 2026-09-23)
   *
   * 🔴 OPTIONNEL A LA LECTURE, ET LE DEFAUT EST « ON MONTRE ». Une API anterieure a ce lot ne rend pas le
   * champ : `undefined` doit alors se lire « on ne sait pas », donc on garde le comportement d'hier. Le
   * traiter comme « pas connecte » ferait DISPARAITRE la source HubSpot d'un client qui l'a, pendant toute
   * la fenetre entre le deploiement de la console et celui de l'API. Entre les deux erreurs possibles, une
   * seule se rattrape d'un clic.
   */
  hubspotPortalConnecte?: boolean;
  /**
   * L'INTERRUPTEUR HUBSPOT DE L'ESPACE (migration 0179, Paramètres > Intégrations). Allumé, le bloc HubSpot
   * s'affiche sur l'Accueil, numéro ou pas.
   *
   * ⚠️ OPTIONNEL À LA LECTURE, pour la même raison que son voisin : une API antérieure ne le rend pas, et
   * `undefined` veut alors dire « comportement d'avant » (le bloc de l'Accueil suit la présence d'un numéro).
   * Lu par `lireHubspotActif` (`lib/hubspot-actif.ts`), jamais directement.
   */
  hubspotActif?: boolean;
  /*
   * `prix` A QUITTE LES REGLAGES LE 2026-09-23 (lot 8, migration 0168). Il n'y a plus qu'une grille, pour
   * tous les espaces, et elle se lit dans /ops : la laisser ici aurait permis a n'importe quel ecran du
   * client de la reafficher un jour sans que personne n'y pense. Le type est la garde.
   */
}

/** Miroir de `GrillePrix` (src/stats/prix.ts). Les bornes de saisie vivent cote SERVEUR, qui les refuse. */
export interface GrillePrix {
  /** En POURCENT du tarif Meta. 100 = on facture le tarif Meta. */
  margeTemplate: number;
  serviceCentimes: number;
  serviceFranchise: number;
  /** Date d'effet de la facturation du service, 'YYYY-MM-DD'. */
  serviceDepuis: string;
  rcsSimpleCentimes: number;
  rcsConversationnelCentimes: number;
}

/*
 * `setGrillePrix` A ETE RETIREE LE 2026-09-23 (lot 8, migration 0168) : la grille ne se regle plus depuis
 * l espace d un client. Ses remplacantes vivent dans le module des appels d EXPLOITATION, parce qu elles
 * portent une autre autorite (`x-ops-token`, jamais le jeton de session du client) : `lireGrillePrixOps` et
 * `ecrireGrillePrixOps`.
 */
export function getSettings(tenantId: string): Promise<TenantSettings> {
  return request<TenantSettings>(`/tenants/${tenantId}/settings`);
}
export function putSettings(tenantId: string, mbaEnabled: boolean): Promise<TenantSettings> {
  return request<TenantSettings>(`/tenants/${tenantId}/settings`, { method: 'PUT', body: JSON.stringify({ mbaEnabled }) });
}
/** Active/désactive le toggle « Campagnes via données HubSpot ». */
export function setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<{ hubspotListsEnabled: boolean }> {
  return request(`/tenants/${tenantId}/settings/hubspot-lists`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
}
/**
 * Allume ou éteint l'interrupteur HubSpot de l'espace (admin). Le serveur REFUSE de l'éteindre (409, avec un
 * message à afficher tel quel) tant qu'un portail est relié : il faut d'abord la « Déconnexion complète ».
 */
export function setHubspotActif(tenantId: string, actif: boolean): Promise<{ hubspotActif: boolean }> {
  return request(`/tenants/${tenantId}/settings/hubspot-actif`, { method: 'PATCH', body: JSON.stringify({ actif }) });
}

/**
 * Demande au backend un lien d'install/re-consentement HubSpot SIGNÉ (le tenant est dans la signature, plus dans
 * un `?tenant=` en clair forgeable). Route admin-only ; le tenant vient du JWT. `grant='lists'` pour le re-consentement.
 */
export function getHubspotInstallLink(tenantId: string, grant?: 'lists'): Promise<{ installUrl: string }> {
  return request(`/tenants/${tenantId}/hubspot/install-link`, {
    method: 'POST',
    body: JSON.stringify(grant ? { grant } : {}),
  });
}

/** Durée du gel après qu'un opérateur a pris la main, en secondes. null = défaut du serveur, 0 = jamais
 *  de reprise automatique (l'opérateur garde la main jusqu'à ce qu'il la rende). */
export function setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<{ controlHandbackSeconds: number | null }> {
  return request(`/tenants/${tenantId}/settings/control-handback`, { method: 'PATCH', body: JSON.stringify({ seconds }) });
}

/**
 * Quand l'agent de Meta passe la main à un humain. Le choix est enregistré côté serveur ET appliqué chez Meta
 * dans la foulée ; `appliqueChezMeta: false` veut dire que Meta n'a pas répondu et que le balayage rattrapera.
 */
export function setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<{ mbaHandoffMode: MbaHandoffMode; appliqueChezMeta: boolean }> {
  return request(`/tenants/${tenantId}/settings/mba-handoff`, { method: 'PATCH', body: JSON.stringify({ mode }) });
}

/** Fuseau IANA du tenant (base des conditions temporelles : NOW, jour de semaine, heures d'ouverture). */
export function setTimezone(tenantId: string, timezone: string): Promise<{ timezone: string }> {
  return request(`/tenants/${tenantId}/settings/timezone`, { method: 'PATCH', body: JSON.stringify({ timezone }) });
}
/** Heures d'ouverture par jour (corps `{ '0'..'6': { closed, open 'HH:MM', close 'HH:MM' } }`, 7 jours requis). */
export function setBusinessHours(tenantId: string, businessHours: BusinessHours): Promise<{ businessHours: BusinessHours }> {
  return request(`/tenants/${tenantId}/settings/business-hours`, { method: 'PATCH', body: JSON.stringify({ businessHours }) });
}
