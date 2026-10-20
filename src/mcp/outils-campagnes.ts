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
import { LimiteOffreError, corpsRefusLimite } from '../offres/refus';
import { empreinteEtat, type ConfirmationStore, type EtatConfirme, type IssueReclamation } from '../campaign/confirmation';
import { modeleEnvoyable, numeroDEnvoi, type DepsModeleEnvoyable } from '../api/modele-envoi';
import { validateParamMapping } from '../crm/template';
import type { PhoneNumberRow } from '../campaign/store.pg';

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
        /** L'état que montre le récapitulatif, relu en base ; `null` hors de l'espace. */
        etatPourConfirmation(tenantId: string, campaignId: string): Promise<EtatConfirme | null>;
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
      + 'conversations), an APPROVED template and its variables, now or at a date. Same checks as the console: a '
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

      // Le chemin de la console, mot pour mot : la même validation, la même résolution de cible, le même plafond.
      // La catégorie est celle du modèle chez Meta (spec, choix 4) : l'assistant ne la choisit pas.
      const prepare = await preparerCampagne({
        phoneNumberId: numero.phoneNumberId, name: nom, category: modele.categorie, templateName, templateLanguage, paramMapping,
        contactTarget: cible,
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
        ...(modelesDuMois ? { monthly_templates: { limit: modelesDuMois.max, remaining: modelesDuMois.reste, needed: modelesDuMois.demandes } } : {}),
        sample: apercu,
        // Un volume, jamais un montant : un prix affiché à côté du bouton qui envoie serait cru (`EtapeRecap.tsx`).
        billable_messages_up_to: partiront,
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
      + 'for the campaign exactly as summarized: if anything changed, prepare it again. ' + LOURDE,
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
      const reclamation = await c.confirmations.reclamer(tenantId, campaignId, code, empreinteEtat(etat));
      if (reclamation !== 'ok') throw new RefusOutil(REFUS_DU_CODE[reclamation]);

      const quand = etat.prevueLe === null ? null : new Date(etat.prevueLe);
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
          : REFUS_DU_LANCEMENT[issue.raison]);
      }
      return 'programmee' in issue
        ? { campaign_id: campaignId, status: 'scheduled', scheduled_for: { iso: issue.programmee.toISOString(), paris: dateDeParis(issue.programmee) } }
        : { campaign_id: campaignId, status: 'sending', recipients: etat.recipientCount };
    },
  },
];
