import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { AnnotationsMcp, OutilMcp } from './outils';
import { RefusOutil, dateAvecFuseau, entierBorne, texteObligatoire } from './saisie';
import { CHAMPS_CIBLE_FILTRES, CHAMPS_CIBLE_IDENTIFIANTS, lireCibleMcp } from './cible';
import { ecriture, LOURDE, plafondCouteux, signataire } from './outils-agent';
import type { AnalyseEtResume } from '../crm/contact-store.pg';
import { LONGUEUR_MAX_ETIQUETTE, nettoyerEtiquettes } from '../crm/poser-etiquette';
import { MAX_TAGS } from '../crm/contact-filters';
import { estUuid } from '../http/scope';
import { preparerCampagne, type PreparationCampagneDeps } from '../http/preparation-campagne';
import { createCampaignWithRecipients, type CampaignRepoLike } from '../campaign/create';
import { lancerCampagne, type DepsLancement, type IssueLancement } from '../campaign/lancement';
import { eurosDisponibles, eurosManquants, messageManqueCredit } from '../credit-whatsapp/estimation';
import { LimiteOffreError, corpsRefusLimite } from '../offres/refus';
import { empreinteEtat, type ConfirmationStore, type EtatConfirme, type IssueReclamation } from '../campaign/confirmation';
import { modeleEnvoyable, numeroDEnvoi, type DepsModeleEnvoyable } from '../api/modele-envoi';
import { validateParamMapping } from '../crm/template';
import type { PhoneNumberRow } from '../campaign/store.pg';
import { messageDePause, type MotifDePause } from '../campaign/pause';
import { REPONDEURS_ETAGE } from '../campaign/etages';

/**
 * Ce que les outils de campagne lisent et écrivent, en plus des contacts et de l'Inbox du MCP. 🔴 Les MÊMES objets que
 * la console et l'API publique (`src/index.ts`) : `route` est le câblage de la route des campagnes, `modeles` celui de
 * `POST /v1/sends`. Un second câblage dériverait, et l'assistant préparerait avec d'autres garde-fous.
 */
export interface DepsCampagnesMcp {
  campagnes: {
    route: PreparationCampagneDeps & DepsLancement & {
      repo: CampaignRepoLike & {
        /** Supprime un brouillon jamais lancé (la garde métier de la console). */
        deleteDraftCampaign(campaignId: string, tenantId: string): Promise<boolean>;
        /** Déprogramme : la campagne programmée redevient un brouillon (`control_campaign`, le bouton de la console). */
        cancelSchedule(campaignId: string, tenantId: string): Promise<boolean>;
        /** L'état que montre le récapitulatif, relu en base ; `null` hors de l'espace. */
        etatPourConfirmation(tenantId: string, campaignId: string): Promise<EtatConfirme | null>;
        /**
         * Le motif et l'échéance d'une pause (`prepare_resume`), hors de l'empreinte du code : `null` hors de l'espace.
         */
        pauseDe(tenantId: string, campaignId: string): Promise<{ motif: MotifDePause | null; jusqua: Date | null } | null>;
        apercuDestinataires(tenantId: string, campaignId: string, n: number): Promise<string[]>;
        desabonnesParmiLesDestinataires(tenantId: string, campaignId: string): Promise<number>;
        /** Les numéros WhatsApp de l'espace, comme la console les liste. */
        listPhoneNumbers(tenantId: string): Promise<PhoneNumberRow[]>;
      };
    };
    /** La lecture du modèle chez Meta et le numéro de l'espace, ceux de `POST /v1/sends`. */
    modeles: DepsModeleEnvoyable;
    confirmations: ConfirmationStore;
  };
}

/** Les noms des premiers destinataires, montrés pour vérifier la cible (décision de Julien : cinq). */
export const NOMS_DU_RECAPITULATIF = 5;
export const LONGUEUR_MAX_NOM_MODELE = 512;
export const LONGUEUR_MAX_LANGUE = 15;
export const LONGUEUR_MAX_NOM_CAMPAGNE = 120;

/** « dimanche 31 octobre 2027 à 10 h », « à 10 h 30 » : l'heure de Paris, telle qu'on la dit. */
export function dateDeParis(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.year} à ${Number(p.hour)} h${p.minute === '00' ? '' : ` ${p.minute}`}`;
}

/** Un code de confirmation : six caractères, un peu de marge pour une recopie avec des espaces. */
export const LONGUEUR_MAX_CODE = 12;

/** Ce que l'assistant lit quand le code ne lance rien, et ce qu'il peut faire. */
const REFUS_DU_CODE: Record<Exclude<IssueReclamation, 'ok'>, string> = {
  invalide: 'code de confirmation faux pour cette campagne : reprenez celui du récapitulatif de prepare_campaign',
  expire: 'code de confirmation expiré (30 minutes) : préparez à nouveau avec prepare_campaign et replaces',
  utilise: 'code déjà utilisé : cette campagne a déjà été lancée ou programmée',
  modifie: 'la campagne a changé depuis le récapitulatif : préparez-la à nouveau avec prepare_campaign et replaces',
};
/**
 * 🔴 Les mêmes refus pour la REPRISE d'une campagne en pause, et ils ne renvoient jamais vers `prepare_campaign` : préparer
 * à nouveau créerait une campagne neuve, vers TOUS les destinataires, ceux déjà servis compris.
 */
const REFUS_DU_CODE_DE_REPRISE: Record<Exclude<IssueReclamation, 'ok'>, string> = {
  invalide: 'code de confirmation faux pour cette reprise : reprenez celui de control_campaign (prepare_resume)',
  expire: 'code de confirmation expiré (30 minutes) : demandez-en un autre avec control_campaign (prepare_resume)',
  // Le code gardé a déjà servi (à lancer la campagne, ou à une reprise qu'une nouvelle pause a suivie) : elle est en pause.
  utilise: 'code déjà utilisé, et la campagne est en pause : demandez-en un autre avec control_campaign (prepare_resume)',
  modifie: 'la campagne a changé depuis le récapitulatif de reprise : demandez-en un autre avec control_campaign (prepare_resume)',
};
/**
 * 🔴 Le refus se choisit sur le statut RELU, et seul un BROUILLON peut s'entendre dire « préparez à nouveau » : rien n'en
 * est parti. Une campagne qui n'est plus ni brouillon ni en pause (lancée ou programmée depuis la console, reprise par le
 * balayage ou par un collègue pendant que la personne lisait le récapitulatif, terminée) a écrit, écrit ou écrira à ses
 * destinataires : la préparer à nouveau leur écrirait une seconde fois, et `replaces` n'accepte qu'un brouillon.
 */
function refusDuCode(statut: string, issue: Exclude<IssueReclamation, 'ok'>): string {
  if (statut === 'draft') return REFUS_DU_CODE[issue];
  if (statut === 'paused') return REFUS_DU_CODE_DE_REPRISE[issue];
  if (issue === 'utilise') return REFUS_DU_CODE.utilise;
  return `la campagne n’est plus en brouillon ni en pause (statut ${statut}) : rien n’est parti par ce code. Voyez où elle `
    + 'en est avec get_campaign_stats, et ne la préparez pas à nouveau : ce serait écrire une seconde fois à ses destinataires';
}
/**
 * Ce que `prepare_resume` répond d'une campagne qui n'est pas en pause : rien à reprendre. Jamais « mettez-la en pause
 * d'abord », qui ferait suspendre une campagne en plein envoi pour la reprendre.
 */
const REFUS_HORS_PAUSE: Record<string, string> = {
  draft: 'cette campagne est un brouillon, jamais lancée : il n’y a rien à reprendre',
  scheduled: 'cette campagne est programmée : elle partira à sa date, il n’y a rien à reprendre',
  running: 'cette campagne est en cours d’envoi : il n’y a rien à reprendre',
  completed: 'cette campagne est terminée : il n’y a rien à reprendre',
  failed: 'cette campagne a échoué : elle ne se reprend pas, get_campaign_stats dit ce qui est parti',
};
/** Une pause que seul un autre geste lève : reprendre la remettrait aussitôt en pause (`messageDePause` dit lequel). */
const PAUSES_SANS_REPRISE: ReadonlySet<MotifDePause> = new Set(['numero_delie', 'numero_suspendu', 'credit_whatsapp_epuise', 'ligne_credit_inactive']);
const REFUS_DU_LANCEMENT: Record<'inconnue' | 'date_passee' | 'non_programmable', string> = {
  inconnue: 'campagne inconnue dans cet espace',
  date_passee: 'la date prévue est passée : préparez à nouveau avec prepare_campaign et replaces, avec une nouvelle date',
  non_programmable: 'cette campagne est déjà en cours ou terminée',
};

/** Un refus d'une fonction partagée (préparation, modèle, numéro) devient un refus d'outil, avec sa phrase. */
function refusDe(r: { refus: { message: string } } | { ok: false; body: { error: string } }): never {
  throw new RefusOutil('refus' in r ? r.refus.message : r.body.error);
}

/**
 * LES CAMPAGNES DEPUIS L'ASSISTANT (spec docs/superpowers/specs/2026-10-20-campagnes-depuis-claude-design.md) : trouver
 * des contacts, les étiqueter (un segment EST une étiquette), préparer une campagne de modèle en brouillon, la lancer
 * sur confirmation. 🔴 Aucun moteur neuf : chaque outil appelle ce que la console appelle (`parseBulkTarget`, l'action
 * en masse, `preparerCampagne`, `lancerCampagne`). La fonction d'offre est `console`, celle qui garde les campagnes de la
 * console : ce qu'un espace fait dans l'écran, il le fait depuis son assistant, et rien de plus.
 */

const lecture = (title: string): AnnotationsMcp => ({ title, readOnlyHint: true, openWorldHint: false });

/** Contacts rendus par `find_contacts` : de quoi vérifier une cible, pas une fiche entière (`get_contact` la donne). */
export const MAX_CONTACTS_TROUVES = 100;

/**
 * Les étiquettes à POSER (`add_tags`), distinctes du filtre `tags` de la cible. Nettoyées comme toute pose
 * (`nettoyerEtiquettes`, celle de l'action en masse) ; au-delà du plafond, refusées plutôt que tronquées.
 */
function etiquettesAPoser(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) throw new RefusOutil('paramètre « add_tags » : une liste d’étiquettes est attendue');
  if (v.length > MAX_TAGS) throw new RefusOutil(`paramètre « add_tags » : ${MAX_TAGS} étiquettes au plus`);
  const propres = nettoyerEtiquettes(v, MAX_TAGS);
  if (propres.length === 0) throw new RefusOutil('paramètre « add_tags » : au moins une étiquette non vide');
  return propres;
}

/** La dernière analyse d'une fiche, sous les noms de `search_contacts`. */
function analyseVue(ar: AnalyseEtResume | undefined): Record<string, unknown> | null {
  const a = ar?.analyse ?? null;
  if (a === null) return null;
  return {
    intent: a.intention, sentiment: a.sentiment, satisfaction: a.satisfaction, urgency: a.urgence, resolved: a.resolue,
    topic: a.sujet, analyzed_at: a.analyseLe.toISOString(),
  };
}

export const OUTILS_CAMPAGNES: OutilMcp[] = [
  {
    ...ficheOutilMcp('find_contacts'),
    fonction: 'console',
    description:
      'Finds the contacts of a target, the way the console\'s contact list filters them: tags (all or any), marketing '
      + 'consent, and on the Enterprise plan the fields of the latest conversation analysis (intent, sentiment, '
      + `satisfaction, urgency, resolved...). Returns the total and up to ${MAX_CONTACTS_TROUVES} contacts, with their `
      + 'latest analysis on the Enterprise plan. At least one criterion is required: there is no "everyone" target. '
      + 'A topic is not filterable: to target the contacts who talked about something, read their conversations '
      + '(list_conversations, get_messages) and tag them (tag_contacts).',
    annotations: lecture('Find contacts'),
    entree: {
      type: 'object',
      properties: {
        ...CHAMPS_CIBLE_FILTRES,
        limit: { type: 'integer', minimum: 1, maximum: MAX_CONTACTS_TROUVES, description: `Number of contacts returned (1 to ${MAX_CONTACTS_TROUVES}, default 20). The total is always counted.` },
      },
    },
    async executer(deps, tenantId, args) {
      const fonctions = (await deps.offres.offreDe(tenantId)).droits.fonctions;
      const cible = await lireCibleMcp(args, fonctions, deps, tenantId, { identifiants: false });
      // `lireCibleMcp` refuse les identifiants ici : la cible est un jeu de filtres.
      const filtres = 'filters' in cible ? cible.filters : {};
      const [total, contacts] = await Promise.all([
        deps.contacts.count(tenantId, filtres),
        deps.contacts.query(tenantId, filtres, entierBorne(args, 'limit', 20, 1, MAX_CONTACTS_TROUVES), 0),
      ]);
      const analyses = fonctions.has('analyse') ? await deps.contacts.analysesEtResumes(tenantId, contacts.map((c) => c.id)) : null;
      return {
        total,
        contacts: contacts.map((c) => ({
          contact_id: c.id, name: c.profileName, phone: c.phoneE164, opt_in: c.optInStatus, tags: c.tags,
          ...(analyses === null ? {} : { last_analysis: analyseVue(analyses.get(c.id)) }),
        })),
      };
    },
  },
  {
    ...ficheOutilMcp('tag_contacts'),
    fonction: 'console',
    description:
      'Adds tags to every contact of a target (same filters as find_contacts) or to a list of contacts or of '
      + 'conversations. A segment IS a tag: tag the contacts, then target the tag in prepare_campaign. Goes through '
      + 'the console\'s bulk action: it starts no automation and no scenario. Returns how many contacts were tagged. '
      + LOURDE,
    annotations: ecriture('Tag contacts', true, false),
    entree: {
      type: 'object',
      properties: {
        add_tags: {
          type: 'array', minItems: 1, maxItems: MAX_TAGS, items: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_ETIQUETTE },
          description: 'The tags to add (e.g. "late-delivery-oct").',
        },
        ...CHAMPS_CIBLE_FILTRES,
        ...CHAMPS_CIBLE_IDENTIFIANTS,
      },
      required: ['add_tags'],
    },
    async executer(deps, tenantId, args, personne) {
      signataire(personne);
      const addTags = etiquettesAPoser(args.add_tags);
      const fonctions = (await deps.offres.offreDe(tenantId)).droits.fonctions;
      const cible = await lireCibleMcp(args, fonctions, deps, tenantId, { identifiants: true });
      // Le plafond par espace de l'action en masse de la console, compté AVANT l'écriture.
      await plafondCouteux(deps, tenantId);
      const { affected } = await deps.contacts.applyEditsMany(tenantId, cible, { addTags });
      return { tagged: affected };
    },
  },
  {
    ...ficheOutilMcp('prepare_campaign'),
    fonction: 'console',
    description:
      'Prepares a WhatsApp template campaign WITHOUT sending anything: it creates a draft, visible in the console '
      + '(Campaigns), for a target (tags, consent, analysis on the Enterprise plan, or a list of contacts or '
      + 'conversations), an APPROVED template and its variables, now or at a date. The replies go to the workspace\'s '
      + 'automatic responder, unless responder picks the Meta Business Agent or one active AI agent for them. Same checks as the console: a '
      + 'marketing template only reaches contacts who opted in, contacts who replied STOP are left out, and the '
      + 'category is the template\'s own at Meta. Returns a summary (targeted, sent, left out and why, five names, the '
      + 'billable volume) and a confirmation code valid 30 minutes. SHOW THIS SUMMARY TO THE PERSON AND WAIT FOR AN '
      + 'EXPLICIT YES before calling launch_campaign with the code. To change the target, the template or the date, '
      + 'call prepare_campaign again with replaces: the previous draft is deleted. ' + LOURDE,
    annotations: ecriture('Prepare a campaign', false, false),
    entree: {
      type: 'object',
      properties: {
        template_name: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_NOM_MODELE, description: 'An APPROVED template (list_templates).' },
        template_language: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_LANGUE, description: 'Its language code, e.g. "fr".' },
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              position: { type: 'integer', minimum: 1, description: '{{1}} is position 1; positions 1..N, each once.' },
              source: {
                type: 'object',
                description: '{"type":"attribute","key":"name"} or "phone" (the contact), {"type":"field","key":"<custom field>"}, '
                  + '{"type":"literal","value":"<text>"}, or {"type":"now"} (today\'s date).',
              },
              fallback: { type: 'string', description: 'Used when the source is empty for a contact.' },
            },
            required: ['position', 'source'],
          },
          description: 'One entry per variable of the template body, as in the console. Omit for a template without variables.',
        },
        scheduled_for: {
          type: 'string',
          description: 'ISO 8601 date WITH its time zone, in the future (e.g. 2026-10-21T10:00:00+02:00). Omit to launch as soon as it is confirmed.',
        },
        name: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_NOM_CAMPAGNE, description: 'The campaign name in the console. Default: the template name.' },
        phone_number_id: { type: 'string', description: 'Required when the workspace has several WhatsApp numbers (the refusal lists them); otherwise its number.' },
        replaces: { type: 'string', format: 'uuid', description: 'A draft prepared here before and never launched: it is deleted once the new one exists.' },
        // Le couple de la console (plan du 2026-10-30) : ce que l'écran sait dire, Claude doit pouvoir le dire. Les valeurs
        // sont celles que la validation accepte (`REPONDEURS_ETAGE`), jamais recopiées.
        responder: {
          type: ['string', 'null'], enum: [...REPONDEURS_ETAGE, null],
          description: 'Who answers when a contact replies to this campaign. Omitted or null (default): the workspace\'s '
            + 'automatic responder, the one set_default_responder chose. "mba": the Meta Business Agent, refused when the '
            + 'workspace\'s plan does not include it; if it is off when the contact replies, the conversation goes to the team. '
            + '"agent": an ACTIVE AI agent of this workspace, given by responder_agent_id (list_agents). Only the contact\'s '
            + 'FIRST reply after the send is routed this way. An AI agent keeps the conversation until it ends it, then the '
            + 'next messages go to the workspace\'s responder again; the Meta Business Agent keeps answering the contact until '
            + 'it hands the conversation over to the team or the team takes it back. The team keeps a conversation that a '
            + 'team member handled recently, or in which the contact is still waiting for the team\'s answer.',
        },
        responder_agent_id: {
          type: ['string', 'null'], format: 'uuid',
          description: 'With responder "agent" only: the id of an ACTIVE AI agent of this workspace (list_agents).',
        },
        ...CHAMPS_CIBLE_FILTRES,
        ...CHAMPS_CIBLE_IDENTIFIANTS,
      },
      required: ['template_name', 'template_language'],
    },
    async executer(deps, tenantId, args, personne) {
      signataire(personne);
      const c = deps.campagnes;
      const templateName = texteObligatoire(args, 'template_name', LONGUEUR_MAX_NOM_MODELE);
      const templateLanguage = texteObligatoire(args, 'template_language', LONGUEUR_MAX_LANGUE);
      const nom = args.name === undefined || args.name === null
        ? `${templateName} (assistant)`
        : texteObligatoire(args, 'name', LONGUEUR_MAX_NOM_CAMPAGNE);
      const paramMapping = validateParamMapping(args.variables ?? []);
      if (paramMapping === null) throw new RefusOutil('paramètre « variables » : une entrée par variable, positions 1..N, sources valides');
      const prevueLe = dateAvecFuseau(args, 'scheduled_for') ?? null;
      if (prevueLe !== null && prevueLe.getTime() <= Date.now()) throw new RefusOutil('paramètre « scheduled_for » : la date est passée');
      const remplace = args.replaces === undefined || args.replaces === null ? null : args.replaces;
      if (remplace !== null && !estUuid(remplace)) throw new RefusOutil('paramètre « replaces » : identifiant de brouillon mal formé');
      const fonctions = (await deps.offres.offreDe(tenantId)).droits.fonctions;
      const cible = await lireCibleMcp(args, fonctions, deps, tenantId, { identifiants: true });

      // 🔴 Ne se remplace qu'un brouillon de l'assistant (une confirmation existe), de cet espace, jamais lancé.
      if (remplace !== null) {
        const ancien = (await c.confirmations.existe(tenantId, remplace)) ? await c.route.repo.etatPourConfirmation(tenantId, remplace) : null;
        if (ancien === null) throw new RefusOutil('replaces : aucun brouillon préparé depuis l’assistant avec cet identifiant dans cet espace');
        if (ancien.status !== 'draft') throw new RefusOutil('replaces : cette campagne a déjà été lancée ou programmée, elle ne se remplace plus');
      }

      const numeros = await c.route.repo.listPhoneNumbers(tenantId);
      const demande = typeof args.phone_number_id === 'string' ? args.phone_number_id : undefined;
      if (demande === undefined && numeros.length > 1) {
        throw new RefusOutil(`cet espace a plusieurs numéros WhatsApp : précisez phone_number_id (${numeros.map((n) => `${n.id} = ${n.displayPhoneNumber ?? n.verifiedName ?? '?'}`).join(', ')})`);
      }

      await plafondCouteux(deps, tenantId);
      const modele = await modeleEnvoyable(c.modeles, tenantId, templateName, templateLanguage, paramMapping, 'modèle');
      if ('refus' in modele) refusDe(modele);
      const numero = await numeroDEnvoi(c.modeles, tenantId, demande);
      if ('refus' in numero) refusDe(numero);

      /**
       * Qui répond aux réponses (plan du 2026-10-30) : passé tel quel à `preparerCampagne`, qui le juge par la règle de la
       * console (`problemeDeRepondeur`) et lit l'agent scopé. Un répondeur désigné veut dire que le répondeur automatique
       * prend la main : `devenir: 'mba'` voyage avec lui. Sans lui, rien ne change : un devenir absent se lit déjà ainsi
       * (`devenirEffectif`), ce que faisait toute campagne de l'assistant.
       */
      const repondeur = args.responder ?? undefined;
      const repondeurAgentId = args.responder_agent_id ?? undefined;

      // Le chemin de la console, mot pour mot : la même validation, la même résolution de cible, le même plafond.
      // La catégorie est celle du modèle chez Meta (spec, choix 4) : l'assistant ne la choisit pas.
      const prepare = await preparerCampagne({
        phoneNumberId: numero.phoneNumberId, name: nom, category: modele.categorie, templateName, templateLanguage, paramMapping,
        contactTarget: cible,
        ...(repondeur !== undefined ? { devenir: 'mba', repondeur } : {}),
        ...(repondeurAgentId !== undefined ? { repondeurAgentId } : {}),
      }, tenantId, c.route);
      if (!prepare.ok) refusDe(prepare);
      const cree = await createCampaignWithRecipients({ ...prepare.input, prevueLe }, c.route.repo);
      const ecartes = (motif: string): number => cree.skipped.filter((s) => s.reason === motif).length;
      const vises = prepare.input.contactIds?.length ?? 0;
      // Bloqués, supprimés, sans numéro, doublons : écartés à la création sans motif propre (constat 4).
      const autres = Math.max(0, vises - cree.recipientCount - cree.skipped.length);
      // Les destinataires qui ont dit STOP restent inscrits mais sont écartés à l'envoi : ils comptent pour « rien ne part ».
      const desabonnes = cree.recipientCount === 0 ? 0 : await c.route.repo.desabonnesParmiLesDestinataires(tenantId, cree.campaignId);
      if (cree.recipientCount - desabonnes <= 0) {
        await c.route.repo.deleteDraftCampaign(cree.campaignId, tenantId);
        throw new RefusOutil(`aucun destinataire : ${ecartes('not_opted_in')} sans consentement marketing (un modèle MARKETING ne part qu'à qui a consenti), `
          + `${desabonnes} qui ont répondu STOP, ${ecartes('missing_variable')} sans la valeur d'une variable, ${autres} écartés (bloqués, supprimés ou sans numéro). Rien n'a été créé.`);
      }

      // L'ancien brouillon part APRÈS que le nouveau existe : un échec laisse deux brouillons, jamais zéro.
      const remplacement = remplace === null ? undefined : { campaign_id: remplace, deleted: await c.route.repo.deleteDraftCampaign(remplace, tenantId) };

      // Le code est lié à l'état RELU en base, celui que `launch_campaign` relira.
      const etat = await c.route.repo.etatPourConfirmation(tenantId, cree.campaignId);
      const pose = etat === null ? null : await c.confirmations.poser(tenantId, cree.campaignId, empreinteEtat(etat));
      if (pose === null) throw new Error(`prepare_campaign : la campagne ${cree.campaignId} n'a pas pu recevoir son code`);

      const apercu = await c.route.repo.apercuDestinataires(tenantId, cree.campaignId, NOMS_DU_RECAPITULATIF);
      const partiront = Math.max(0, cree.recipientCount - desabonnes);
      // La marge des modèles du mois, quand l'offre en a une (constat 4) : une campagne qui la dépasse serait refusée au lancement.
      const modelesDuMois = prevueLe === null ? await c.route.modelesDuLancement(tenantId, cree.campaignId) : null;
      // Le Crédit WhatsApp d'un espace sur la ligne (tâche 6) : ce que la campagne coûterait, au prix que le crédit débitera.
      const credit = await c.route.creditDuLancement(tenantId, cree.campaignId);
      return {
        campaign_id: cree.campaignId,
        status: 'draft',
        template: `${templateName} (${templateLanguage})`,
        category: modele.categorie,
        scheduled_for: prevueLe === null ? null : { iso: prevueLe.toISOString(), paris: dateDeParis(prevueLe) },
        targeted: prepare.input.contactIds?.length ?? 0,
        will_send: partiront,
        excluded: { not_opted_in: ecartes('not_opted_in'), missing_variable: ecartes('missing_variable'), unsubscribed: desabonnes, other: autres },
        phone_number: numeros.find((n) => n.id === numero.phoneNumberId)?.displayPhoneNumber ?? numero.phoneNumberId,
        // Qui répondra : `null` = le répondeur de l'espace. Ce que la campagne porte, relu dans l'entrée validée.
        responder: prepare.input.repondeur ?? null,
        ...(prepare.input.repondeurAgentId ? { responder_agent_id: prepare.input.repondeurAgentId } : {}),
        ...(modelesDuMois ? { monthly_templates: { limit: modelesDuMois.max, remaining: modelesDuMois.reste, needed: modelesDuMois.demandes } } : {}),
        sample: apercu,
        // Un volume, jamais un montant : un prix affiché à côté du bouton qui envoie serait cru (`EtapeRecap.tsx`). Sauf sur la
        // ligne du Crédit WhatsApp : le prix est alors celui que NOTRE crédit débitera, lu sur notre grille, et il décide
        // du lancement.
        billable_messages_up_to: partiront,
        ...(credit ? {
          whatsapp_credit: {
            estimated_cost_eur_excl_tax: eurosManquants(credit.montantMicroEur),
            balance_eur_excl_tax: eurosDisponibles(credit.soldeMicroEur),
            ...(credit.manqueMicroEur > 0 ? { missing_eur_excl_tax: eurosManquants(credit.manqueMicroEur), warning: messageManqueCredit(credit.manqueMicroEur) } : {}),
          },
        } : {}),
        confirmation_code: pose.code,
        code_expires_at: pose.expireLe.toISOString(),
        ...(remplacement ? { replaced: remplacement } : {}),
        ...(remplacement && !remplacement.deleted
          ? { warning: 'The previous draft could not be deleted (it was launched or scheduled in the meantime): both campaigns now exist. Check Campaigns in the console before launching this one.' }
          : {}),
        next_step: 'Show this summary to the person. Only after an explicit yes, call launch_campaign with campaign_id and '
          + 'confirmation_code. Nothing has been sent.',
      };
    },
  },
  {
    ...ficheOutilMcp('launch_campaign'),
    fonction: 'console',
    description:
      'Launches a campaign prepared with prepare_campaign, ONLY after the person said yes to its summary, with the '
      + 'confirmation code of that summary. A campaign prepared for a date is scheduled for that date; otherwise it '
      + 'starts sending now. Same path as the console\'s Launch button. The code works once, for 30 minutes, and only '
      + 'for the campaign exactly as summarized: if anything changed, prepare it again. It also RESUMES a paused campaign, '
      + 'with the code of control_campaign (prepare_resume): the recipients still waiting are sent at once; never prepare '
      + 'a paused campaign again, which would send to everyone. ' + LOURDE,
    annotations: ecriture('Launch a campaign', false, true),
    entree: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', format: 'uuid', description: 'The campaign_id returned by prepare_campaign.' },
        confirmation_code: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_CODE, description: 'The confirmation_code of its summary.' },
      },
      required: ['campaign_id', 'confirmation_code'],
    },
    async executer(deps, tenantId, args, personne) {
      signataire(personne);
      const c = deps.campagnes;
      const campaignId = args.campaign_id;
      if (!estUuid(campaignId)) throw new RefusOutil('paramètre « campaign_id » : identifiant mal formé');
      const code = texteObligatoire(args, 'confirmation_code', LONGUEUR_MAX_CODE);
      // Le plafond par espace du bouton « Lancer » de la console (`couteux` sur la route `/run`).
      await plafondCouteux(deps, tenantId);
      const etat = await c.route.repo.etatPourConfirmation(tenantId, campaignId);
      if (etat === null) throw new RefusOutil('campagne inconnue dans cet espace');

      // 🔴 Le code est réclamé AVANT le lancement, sur l'état relu en base : usage unique, et rien d'autre que ce qui a
      // été montré.
      // Une campagne en PAUSE se reprend (le code de `control_campaign`, `prepare_resume`) : tout de suite, sa date prévue
      // étant passée depuis qu'elle a démarré. Le refus d'un code se choisit sur le statut relu (`refusDuCode`).
      const reprise = etat.status === 'paused';
      const reclamation = await c.confirmations.reclamer(tenantId, campaignId, code, empreinteEtat(etat));
      if (reclamation !== 'ok') throw new RefusOutil(refusDuCode(etat.status, reclamation));

      const quand = reprise || etat.prevueLe === null ? null : new Date(etat.prevueLe);
      let issue: IssueLancement;
      try {
        issue = await lancerCampagne(c.route, tenantId, campaignId, quand);
      } catch (e) {
        await c.confirmations.rendre(tenantId, campaignId);
        throw e;
      }
      if (!issue.ok) {
        // Refusé après la réclamation : le code redevient utilisable, rien n'est parti.
        await c.confirmations.rendre(tenantId, campaignId);
        throw new RefusOutil(issue.raison === 'limite'
          ? corpsRefusLimite(new LimiteOffreError(tenantId, 'envoisModelesMois', issue.max)).error
          : issue.raison === 'credit_whatsapp' ? messageManqueCredit(issue.manqueMicroEur) : REFUS_DU_LANCEMENT[issue.raison]);
      }
      return 'programmee' in issue
        ? { campaign_id: campaignId, status: 'scheduled', scheduled_for: { iso: issue.programmee.toISOString(), paris: dateDeParis(issue.programmee) } }
        : { campaign_id: campaignId, status: 'sending', recipients: etat.recipientCount };
    },
  },
  /*
   * La marche arrière (plan du 2026-10-22, tâche 5) : les freins d'une campagne, et le chemin du retour. La pause et la
   * déprogrammation sont les gestes de la console (`pauseCampaign`, `cancelSchedule`), sans confirmation : ils arrêtent.
   * La reprise fait repartir des messages : elle ne fait que poser un code sur l'état en pause, et c'est `launch_campaign`,
   * le seul outil qui envoie en masse, qui la lance.
   */
  {
    ...ficheOutilMcp('control_campaign'),
    fonction: 'console',
    description:
      'The brakes of a campaign, and the way back. pause: stops a campaign that is sending, within seconds; what has '
      + 'left stays sent, and the recipients not yet reached wait. unschedule: a scheduled campaign goes back to draft, '
      + 'nothing leaves. prepare_resume: for a PAUSED campaign, returns the summary of what resuming would send (the '
      + 'recipients still waiting), why it paused (pause_message: a quality pause asks to check the number first) and a '
      + 'confirmation code valid 30 minutes; refused for a pause that only another gesture lifts (the number unlinked, '
      + 'its subscription unpaid). SHOW IT TO THE PERSON AND WAIT FOR AN '
      + 'EXPLICIT YES, then call launch_campaign with that code. Pausing needs no confirmation: it is the emergency '
      + 'gesture of the console. Never prepare a paused campaign again with prepare_campaign: it would send to everyone.',
    // Rien ne part chez un tiers ; chaque `prepare_resume` tire un nouveau code : pas idempotente.
    annotations: ecriture('Pause, unschedule or prepare to resume a campaign', false, false),
    entree: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', format: 'uuid', description: 'The campaign id (prepare_campaign, get_campaign_stats).' },
        action: {
          type: 'string', enum: ['pause', 'unschedule', 'prepare_resume'],
          description: 'pause a sending campaign, unschedule a scheduled one, or prepare_resume a paused one.',
        },
      },
      required: ['campaign_id', 'action'],
    },
    async executer(deps, tenantId, args, personne) {
      signataire(personne);
      const c = deps.campagnes;
      const campaignId = args.campaign_id;
      if (!estUuid(campaignId)) throw new RefusOutil('paramètre « campaign_id » : identifiant mal formé');
      const action = args.action;
      if (action !== 'pause' && action !== 'unschedule' && action !== 'prepare_resume') {
        throw new RefusOutil('paramètre « action » : pause, unschedule ou prepare_resume');
      }
      // L'appartenance d'abord, comme la route de la console : une campagne d'ailleurs n'existe pas.
      if (!(await c.route.repo.campaignBelongsTo(campaignId, tenantId))) throw new RefusOutil('campagne inconnue dans cet espace');
      if (action === 'pause') {
        if (!(await c.route.repo.pauseCampaign(campaignId, tenantId))) {
          throw new RefusOutil('campagne non suspendable : elle n’est pas en cours d’envoi');
        }
        return { campaign_id: campaignId, status: 'paused' };
      }
      if (action === 'unschedule') {
        if (!(await c.route.repo.cancelSchedule(campaignId, tenantId))) throw new RefusOutil('campagne non programmée : rien à déprogrammer');
        return { campaign_id: campaignId, status: 'draft' };
      }
      const etat = await c.route.repo.etatPourConfirmation(tenantId, campaignId);
      if (etat === null) throw new RefusOutil('campagne inconnue dans cet espace');
      if (etat.status !== 'paused') {
        throw new RefusOutil(REFUS_HORS_PAUSE[etat.status] ?? `seule une campagne en pause se reprend (statut ${etat.status})`);
      }
      // Le motif, que la console affiche à la pause : une pause pour la qualité du numéro ne doit pas repartir sur un oui
      // donné sans son avertissement.
      const pause = await c.route.repo.pauseDe(tenantId, campaignId);
      const motif = pause?.motif ?? null;
      if (motif !== null && PAUSES_SANS_REPRISE.has(motif)) {
        throw new RefusOutil(`${messageDePause(motif, null, undefined)} Elle ne se reprend pas par ce geste.`);
      }
      // Le code est lié à l'état relu en base, celui que `launch_campaign` relira : une reprise faite entre-temps dans la
      // console l'invalide.
      const pose = await c.confirmations.poser(tenantId, campaignId, empreinteEtat(etat));
      if (pose === null) throw new Error(`control_campaign : la campagne ${campaignId} n'a pas pu recevoir son code`);
      return {
        campaign_id: campaignId,
        status: 'paused',
        template: { name: etat.templateName, language: etat.templateLanguage },
        category: etat.category,
        recipients_waiting: etat.recipientCount,
        // Un volume, jamais un montant, comme le récapitulatif de `prepare_campaign`.
        billable_messages_up_to: etat.recipientCount,
        pause_reason: motif,
        pause_message: motif === null ? null : messageDePause(motif, pause?.jusqua ?? null, undefined),
        confirmation_code: pose.code,
        code_expires_at: pose.expireLe.toISOString(),
        next_step: 'Show this summary to the person, pause_message included (why the campaign stopped, and whether it '
          + 'resumes on its own). Only after an explicit yes, call launch_campaign with campaign_id and confirmation_code. '
          + 'Nothing has been sent.',
      };
    },
  },
];
