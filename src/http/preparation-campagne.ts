import { rcsOutboundSchema } from '../rcs/schema';
import type { CreateCampaignInput } from '../campaign/store.pg';
import type { CampaignCategory } from '../campaign/types';
import { validateParamMapping } from '../crm/template';
import { refusDePlafond } from '../campaign/plafond';
import { scanOpening } from '../workflow/engine';
import type { WorkflowGraph } from '../workflow/graph';
import { nonEmpty, estUuid } from './scope';
import { normaliserChaine, problemeDeChaine, RANG_INITIAL, type DevenirEtage, type EtageEntrant } from '../campaign/etages';
import { parseBulkTarget } from './contacts';
import type { BulkTarget } from '../crm/contact-store.pg';
import { STATUT_REFUS_OFFRE, corpsRefusFonction } from '../offres/refus';
import type { SourceOffres } from '../offres/offre.pg';

/** Lectures requises pour préparer une campagne, toutes scopées à l'espace. Aucune écriture. */
export interface PreparationCampagneDeps {
  repo: { phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean> };
  contacts: { contactIdsForTarget(tenantId: string, target: BulkTarget, limite?: number): Promise<string[]> };
  identifiantsDeTousLesContacts(tenantId: string, limite: number): Promise<string[]>;
  plafondDestinataires: number;
  rcs: { belongsToTenant(agentId: string, tenantId: string): Promise<boolean> };
  emailTemplateBelongsToTenant(templateId: string, tenantId: string): Promise<boolean>;
  webhookUsableByTenant(webhookId: string, tenantId: string): Promise<boolean>;
  getWorkflowGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  offres: Pick<SourceOffres, 'offreDe'>;
}

export type PreparationCampagne =
  | { ok: true; input: CreateCampaignInput }
  | { ok: false; status: number; body: { error: string } | ReturnType<typeof corpsRefusFonction> };

function refuser(status: number, body: { error: string } | ReturnType<typeof corpsRefusFonction>): PreparationCampagne {
  return { ok: false, status, body };
}

const CATEGORIES = new Set<CampaignCategory>(['marketing', 'utility']);
function isCategory(v: unknown): v is CampaignCategory {
  return typeof v === 'string' && CATEGORIES.has(v as CampaignCategory);
}

/**
 * Prépare la création sans écrire : contrôle canal, ouverture, propriétés de l'espace et étages ;
 * résout l'audience une seule fois, bornée au plafond, avant de rendre l'input figé à la création.
 * Une liste explicitement vide ne devient jamais « tous les contacts ».
 */
export async function preparerCampagne(body: unknown, tenantId: string, deps: PreparationCampagneDeps): Promise<PreparationCampagne> {
  const b = (body ?? {}) as Partial<{
    phoneNumberId: string;
    name: string;
    category: CampaignCategory;
    templateName: string;
    templateLanguage: string;
    paramMapping: unknown;
    contactIds: unknown;
    contactTarget: unknown;
    workflowId: string;
    ratePerMinute: unknown;
    channel: string;
    rcsAgentId: string;
    rcsMessage: unknown;
    webhookId: string;
    businessHoursOnly: unknown;
    chaine: unknown;
    reessayer: unknown;
    rattrapageHorsHoraires: unknown;
    assignation: unknown;
    assignationUserId: unknown;
    devenir: unknown;
  }>;

  if (!isCategory(b.category)) return refuser(400, { error: 'category invalide (marketing|utility)' });

  // Canal. Absent = 'whatsapp'. Un canal inconnu est refusé, jamais ramené à WhatsApp en silence (une campagne
  // partie sur le mauvais canal est irrattrapable).
  const channel = b.channel ?? 'whatsapp';
  if (channel !== 'whatsapp' && channel !== 'rcs') {
    return refuser(400, { error: 'channel invalide (whatsapp|rcs)' });
  }
  const isRcs = channel === 'rcs';
  let rcsMessage: unknown;
  if (isRcs) {
    if (!nonEmpty(b.rcsAgentId)) return refuser(400, { error: 'rcsAgentId requis pour une campagne RCS' });
    if (!(await deps.rcs.belongsToTenant(b.rcsAgentId as string, tenantId))) {
      return refuser(400, { error: 'rcsAgentId inconnu pour ce tenant' });
    }
    const parsed = rcsOutboundSchema.safeParse(b.rcsMessage);
    if (!parsed.success) return refuser(400, { error: 'rcsMessage invalide' });
    rcsMessage = parsed.data;
    if (nonEmpty(b.workflowId)) {
      return refuser(400, { error: "Une campagne RCS envoie un message direct. Le declenchement d'un scenario par campagne n'est pas disponible sur ce canal." });
    }
  }
  // Débit optionnel : entier 1..80 messages/min (le client ne peut que baisser sous le plafond métier). Absent ou
  // null = aucun throttle ; 0, 81, décimal ou négatif -> 400. 80 est la borne de saisie, pas le plafond appliqué :
  // il dépend du canal (`plafondDuCanal`), et une campagne RCS qui demande 80 est ramenée au plafond RCS.
  let ratePerMinute: number | null | undefined;
  if (b.ratePerMinute !== undefined && b.ratePerMinute !== null) {
    const r = b.ratePerMinute;
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 80) {
      return refuser(400, { error: 'ratePerMinute invalide (entier 1..80 ou null)' });
    }
    ratePerMinute = r;
  }
  // Numéro Meta : exigé sur WhatsApp uniquement. Une campagne RCS part d'un agent, pas d'un numéro.
  if (!isRcs && !nonEmpty(b.phoneNumberId)) return refuser(400, { error: 'phoneNumberId requis' });
  if (!nonEmpty(b.name)) return refuser(400, { error: 'name requis' });
  // Une campagne envoie soit un template soit un workflow (exactement un des deux). Sur RCS, ni l'un ni
  // l'autre : le message est porté par la campagne elle-même.
  const isWorkflow = nonEmpty(b.workflowId);
  const scenariosOuverts = async () => (await deps.offres.offreDe(tenantId)).droits.fonctions.has('scenarios');
  if (isWorkflow) {
    if (!(await scenariosOuverts())) return refuser(STATUT_REFUS_OFFRE, corpsRefusFonction('scenarios'));
    const graph = await deps.getWorkflowGraph(b.workflowId as string, tenantId);
    if (!graph) {
      return refuser(400, { error: 'workflowId inconnu pour ce tenant' });
    }
    // Une campagne part sur une audience froide : le premier message doit être un template. On juge sur ce qui
    // ouvre réellement (un tag, une action ou une condition avant n'envoient rien), pas sur le type du 1er bloc.
    const scan = scanOpening(graph);
    if (scan.sessionOpen) {
      return refuser(400, { error: "Ce scénario ouvre par un message rapide, une question ou un formulaire, qui exigent que le contact ait écrit dans les 24 h. Une campagne part sur une audience froide : il lui faut un envoi de template en ouverture." });
    }
    if (scan.waitBeforeTemplate) {
      return refuser(400, { error: "Ce scénario attend avant son premier envoi : rien ne partirait au lancement. Pour différer une campagne, utilise « Plus tard » au moment de la lancer." });
    }
    // Un « Aller à » vers un autre scénario avant tout envoi (RC5) : l'ouverture se joue dans un graphe que cette
    // garde ne lit pas, et la campagne ne saurait ni quel template paramétrer, ni si un message de session part.
    if (scan.sautsHorsScenario.length > 0) {
      return refuser(400, { error: "Ce scénario saute vers un autre scénario (« Aller à ») avant son premier envoi : une campagne doit ouvrir sur un envoi de ce scénario. Choisis directement le scénario d'arrivée." });
    }
    // Un bloc RCS configuré ouvre à froid : il ne passe pas par WhatsApp, donc aucune fenêtre de 24 h ne
    // s'y applique. Exiger un template en ouverture fermait la porte à toute campagne RCS par scénario.
    if (!scan.firstTemplate && !scan.rcsOpen) {
      return refuser(400, { error: 'Le scénario doit ouvrir par un envoi : un template WhatsApp, ou un message RCS.' });
    }
    // Les trois contrôles suivants portent sur le template d'ouverture, s'il y en a un (un scénario qui ouvre en
    // RCS n'en a pas). Chaque refus doit être rendu explicitement, sinon la préparation pourrait produire
    // une campagne incomplète.
    if (scan.firstTemplate) {
      if (scan.ambiguousTemplate) {
        return refuser(400, { error: "Ce scénario peut ouvrir sur plusieurs templates différents : impossible de savoir lequel paramétrer pour la campagne." });
      }
      // `unnamedOpeningTemplate` couvre aussi les branches : une condition dont une sortie mène à un template
      // sans nom laisserait ces destinataires sans message, tout en les comptant « envoyés ».
      if (scan.unnamedOpeningTemplate || String(scan.firstTemplate.data.templateName ?? '').trim() === '') {
        return refuser(400, { error: "Un template d'ouverture du scénario n'est pas encore choisi." });
      }
    }
  } else if (!isRcs) {
    if (!nonEmpty(b.templateName)) return refuser(400, { error: 'templateName ou workflowId requis' });
    if (!nonEmpty(b.templateLanguage)) return refuser(400, { error: 'templateLanguage requis' });
  }

  // Campagne au fil de l'eau : les destinataires n'existent pas encore, ils arriveront un par un par ce
  // webhook entrant. Trois refus explicites plutôt qu'une campagne qui a l'air créée et n'attrape rien.
  let webhookId: string | undefined;
  if (nonEmpty(b.webhookId)) {
    if (!(await deps.webhookUsableByTenant(b.webhookId as string, tenantId))) {
      return refuser(400, { error: 'webhookId inconnu (ou désactivé) pour ce tenant' });
    }
    // Une liste figée ET un flux d'arrivants sont deux façons contradictoires de désigner les destinataires.
    // Accepter les deux en n'en honorant qu'une laisserait l'appelant croire que sa liste va partir.
    if (Array.isArray(b.contactIds) && b.contactIds.length > 0) {
      return refuser(400, { error: "Une campagne alimentée par un webhook ne prend pas de liste de contacts : ses destinataires arrivent au fil de l'eau." });
    }
    webhookId = b.webhookId as string;
  }

  // Sélection de contacts optionnelle : tableau de chaînes non vides. Absent -> tous les contacts.
  let contactIds: string[] | undefined;
  // Le plafond est lu ici, avant toute résolution de cible : il sert de borne aux requêtes de sélection, pas
  // seulement de verdict après coup. Une garde qui arrive après le chargement ne protège que la suite.
  const plafond = deps.plafondDestinataires;
  if (b.contactIds !== undefined) {
    if (!Array.isArray(b.contactIds) || !b.contactIds.every((x) => nonEmpty(x))) {
      return refuser(400, { error: 'contactIds invalide (tableau d\'ids)' });
    }
    /**
     * 🔴 Une liste vide n'est pas « tout le monde » : sans ce refus, une sélection explicitement vide retombait sur
     * « tous les contacts de l'espace ». `contactIds` absent veut toujours dire « tous les contacts » ; ce qu'on
     * refuse, c'est de désigner une liste et de n'y mettre personne.
     */
    if (b.contactIds.length === 0) {
      return refuser(422, { error: 'Aucun contact ne correspond à cette sélection.' });
    }
    contactIds = b.contactIds as string[];
  }

  /**
   * Cible par intention (filtres + exclusions) plutôt que par liste d'identifiants. Deux façons de désigner les
   * mêmes destinataires ne coexistent pas dans une requête : on n'en honorerait qu'une.
   */
  if (b.contactTarget !== undefined) {
    if (contactIds !== undefined) {
      return refuser(400, { error: 'contactIds et contactTarget désignent tous les deux les destinataires : n’en envoyer qu’un.' });
    }
    if (webhookId) {
      return refuser(400, { error: "Une campagne alimentée par un webhook ne prend pas de cible de contacts : ses destinataires arrivent au fil de l'eau." });
    }
    const target = parseBulkTarget(b.contactTarget);
    // `null` = aucune cible exploitable. On refuse plutôt que de retomber sur « tous les contacts » : une cible
    // mal formée qui viserait tout l'espace est exactement l'accident qu'on ne veut jamais.
    if (target === null) return refuser(400, { error: 'contactTarget invalide (ids non vides, ou filters)' });
    // Borné à `plafond + 1` : inutile de matérialiser au-delà de ce que le plafond refusera.
    contactIds = await deps.contacts.contactIdsForTarget(tenantId, target, plafond + 1);
    // Une cible qui ne résout personne est une erreur de l'appelant, pas une campagne à tout le monde :
    // sans ce refus, `contactIds` vide retomberait sur « tous les contacts » un peu plus bas.
    if (contactIds.length === 0) {
      return refuser(422, { error: 'Aucun contact ne correspond à cette sélection.' });
    }
  }

  /**
   * 🔴 Le plafond de taille, ici parce que c'est le seul point où se rejoignent les trois façons de désigner des
   * destinataires (liste, cible par filtres, « tous les contacts »). Une campagne au fil de l'eau en est exclue :
   * elle naît vide, ses destinataires arrivent un par un.
   */
  if (!webhookId) {
    /**
     * « Tous les contacts » résout ses identifiants ici, il ne les compte pas : la garde juge exactement ce que la
     * campagne emportera. Un contact créé après la validation n'entre pas dans la campagne : l'opérateur a confirmé
     * un nombre, il obtient ce nombre.
     */
    if (contactIds === undefined) {
      contactIds = await deps.identifiantsDeTousLesContacts(tenantId, plafond + 1);
    }
    const vises = contactIds ? contactIds.length : 0;
    const refus = refusDePlafond(vises, plafond);
    if (refus) return refuser(422, { error: refus });
  }

  // Le numéro doit appartenir à l'espace (sinon envoi depuis le numéro d'un autre client). Sur RCS, c'est
  // l'agent qui a été contrôlé plus haut, il n'y a pas de numéro à vérifier.
  if (!isRcs && !(await deps.repo.phoneNumberBelongsToTenant(b.phoneNumberId as string, tenantId))) {
    return refuser(400, { error: 'phoneNumberId inconnu pour ce tenant' });
  }

  // Valider paramMapping avant toute écriture, pour un workflow aussi : le mapping cible les variables du 1er
  // template du workflow (résolues par contact, contacts sans la valeur sautés). Invalide -> 400 déterministe.
  const paramMapping = validateParamMapping(b.paramMapping ?? []);
  if (paramMapping === null) {
    return refuser(400, { error: 'paramMapping invalide (positions 1..N contiguës, sources valides)' });
  }

  /**
   * La chaîne d'étages, quand l'assistant en envoie une. Refusée en 422, jamais en 5xx : la table porte ses CHECK
   * (rang 1 à 3, canal) et sa clé primaire `(campaign_id, rang)`, et un corps brut ferait trancher Postgres.
   * Absente = une campagne à un seul étage (API publique, clients existants).
   */
  let chaine: EtageEntrant[] | undefined;
  if (b.chaine !== undefined) {
    if (!Array.isArray(b.chaine)) {
      return refuser(400, { error: 'chaine invalide (tableau d\'étages)' });
    }
    const probleme = problemeDeChaine(b.chaine as EtageEntrant[], channel);
    if (probleme) return refuser(422, { error: probleme });
    const normalisee = normaliserChaine(b.chaine as EtageEntrant[]);
    /**
     * Le contenu des étages au-delà du premier, et seulement lui : le rang 1 est la campagne elle-même, déjà
     * contrôlée plus haut, et `insertCampaignRow` le réécrit depuis `campaigns` (une seule source par étage).
     */
    for (const e of normalisee) {
      if (e.rang === RANG_INITIAL) continue;
      if (e.canal === 'rcs') {
        const parsed = rcsOutboundSchema.safeParse(e.rcsMessage);
        if (!parsed.success) {
          return refuser(422, { error: `L'étage ${e.rang} part en RCS : son message n'est pas valide.` });
        }
        e.rcsMessage = parsed.data;
      }
      if (e.canal === 'email') {
        if (!estUuid(e.emailTemplateId ?? '')) {
          return refuser(422, { error: `L'étage ${e.rang} part en e-mail : il lui faut un modèle de mail.` });
        }
        /**
         * Sans la clé du champ, l'étage est mort-né : `contacts` n'a pas de colonne `email`, l'adresse vit dans le
         * jsonb `fields` sous un nom que le client choisit. Sans cette clé, l'étage serait sauté à chaque bascule
         * (`prochainEtageServable`) sans explication.
         */
        if (typeof e.emailChamp !== 'string' || e.emailChamp.trim() === '') {
          return refuser(422, { error: `L'étage ${e.rang} part en e-mail : il faut dire quel champ de la fiche porte l'adresse.` });
        }
        e.emailChamp = e.emailChamp.trim();
        if (!(await deps.emailTemplateBelongsToTenant(e.emailTemplateId as string, tenantId))) {
          return refuser(422, { error: `L'étage ${e.rang} vise un modèle de mail inconnu de cet espace.` });
        }
      }
      // 🔴 Même garde que `workflowId` sur la campagne : sans elle, un identifiant recopié démarrerait le scénario
      // d'un autre espace. `getWorkflowGraph` est scopée, elle rend null hors espace.
      if (e.workflowId !== undefined) {
        if (!(await scenariosOuverts())) return refuser(STATUT_REFUS_OFFRE, corpsRefusFonction('scenarios'));
        if (!estUuid(e.workflowId) || !(await deps.getWorkflowGraph(e.workflowId, tenantId))) {
          return refuser(422, { error: `L'étage ${e.rang} vise un scénario inconnu de cet espace.` });
        }
      }
    }
    /**
     * Un étage RCS exige un agent, même sur une campagne WhatsApp : sans lui, `senderForCampaign` rend `null` et le
     * run se met en pause. Poser `rcs_agent_id` sur une campagne WhatsApp est inerte : c'est `campaign.channel` qui
     * gouverne le sender (`src/campaign/run-job.ts`).
     */
    if (!isRcs && normalisee.some((e) => e.canal === 'rcs')) {
      if (!nonEmpty(b.rcsAgentId)) {
        return refuser(422, { error: "Cette chaîne comporte un étage RCS : il lui faut un agent RCS." });
      }
      if (!(await deps.rcs.belongsToTenant(b.rcsAgentId as string, tenantId))) {
        return refuser(422, { error: 'rcsAgentId inconnu pour ce tenant' });
      }
    }
    chaine = normalisee;
  }

  /**
   * L'assignation des réponses ; `null` ou absente = aucune. `personne` sans personne est refusé : sinon les
   * réponses tomberaient dans « À traiter » alors que l'opérateur croit les avoir routées.
   */
  let assignation: 'personne' | 'tour_de_role' | null | undefined;
  if (b.assignation !== undefined && b.assignation !== null) {
    if (b.assignation !== 'personne' && b.assignation !== 'tour_de_role') {
      return refuser(400, { error: 'assignation invalide (personne|tour_de_role)' });
    }
    assignation = b.assignation;
    if (assignation === 'personne' && !estUuid(typeof b.assignationUserId === 'string' ? b.assignationUserId : '')) {
      return refuser(422, { error: "Cette campagne confie ses réponses à une personne : il faut la choisir." });
    }
  }

  /**
   * Ce qui se passe quand le contact répond au premier étage. Refusé ici plutôt qu'en base (le CHECK lèverait,
   * donc 500). Les étages suivants portent le leur dans `chaine[].devenir`, validé par `problemeDeChaine`.
   */
  let devenir: DevenirEtage | undefined;
  if (b.devenir !== undefined && b.devenir !== null) {
    if (b.devenir !== 'mba' && b.devenir !== 'inbox') {
      return refuser(400, { error: 'devenir invalide (mba|inbox)' });
    }
    devenir = b.devenir;
  }

  const input: CreateCampaignInput = {
    tenantId: tenantId,
    ...(devenir ? { devenir } : {}),
    phoneNumberId: isRcs ? '' : (b.phoneNumberId as string),
    name: b.name,
    category: b.category,
    templateName: isWorkflow || isRcs ? '' : (b.templateName as string),
    templateLanguage: isWorkflow || isRcs ? '' : (b.templateLanguage as string),
    paramMapping,
    channel,
    ...(contactIds ? { contactIds } : {}),
    ...(isWorkflow ? { workflowId: b.workflowId as string } : {}),
    ...(ratePerMinute !== undefined ? { ratePerMinute } : {}),
    ...(isRcs ? { rcsAgentId: b.rcsAgentId as string, rcsMessage } : {}),
    ...(b.businessHoursOnly === true ? { businessHoursOnly: true } : {}),
    ...(webhookId ? { webhookId } : {}),
    ...(chaine ? { chaine } : {}),
    // Un étage RCS de repli sur une campagne WhatsApp : l'agent voyage avec la campagne, contrôlé juste
    // au-dessus. Inerte tant que `channel` n'est pas `rcs`.
    ...(!isRcs && chaine?.some((e) => e.canal === 'rcs') ? { rcsAgentId: b.rcsAgentId as string } : {}),
    ...(b.reessayer !== undefined ? { reessayer: b.reessayer === true } : {}),
    ...(b.rattrapageHorsHoraires !== undefined ? { rattrapageHorsHoraires: b.rattrapageHorsHoraires === true } : {}),
    ...(assignation !== undefined ? { assignation } : {}),
    ...(assignation === 'personne' ? { assignationUserId: b.assignationUserId as string } : {}),
  };

  return { ok: true, input };
}
