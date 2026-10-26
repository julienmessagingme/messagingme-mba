import { FICHES_DE_L_APERCU, MAX_FICHES_PAR_SUPPRESSION, ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { DepsMcp, OutilMcp, ProprieteEntree } from './outils';
import { RefusOutil, limiteEntiere, texteObligatoire } from './saisie';
import { CHAMPS_CIBLE_FILTRES, CHAMPS_CIBLE_IDENTIFIANTS, MAX_IDENTIFIANTS_CIBLE, lireCibleMcp } from './cible';
import { ecriture, LOURDE, plafondCouteux, signataire } from './outils-agent';
import type { BulkTarget, FicheASupprimer } from '../crm/contact-store.pg';
import { effacerContacts, type DepsEffacement } from '../crm/effacement';
import { codeBienForme, codeDeSuppression, empreinteDesFiches, verifierCodeDeSuppression } from '../crm/code-suppression';
import { makeJournal, type AuditSink } from '../audit/journal';
import { LimiteOffreError, corpsRefusLimite } from '../offres/refus';
import { DROITS, type Fonction } from '../offres/offres';
import { numeroMasque } from '../emails-produit/alertes';

/**
 * LA SUPPRESSION DE CONTACTS EN MASSE DEPUIS CLAUDE (plan `docs/superpowers/plans/2026-10-26-free-au-dela-de-100-contacts.md`,
 * décisions de Julien du 2026-10-26) : un espace revenu en Free au-delà de sa limite ne crée plus rien, et un nouveau
 * client qui écrit n'y entre pas, tant qu'il n'a pas supprimé ce qui dépasse. La Free n'a pas la console : c'est Claude
 * qui supprime, d'un coup, une sélection (les plus anciens, une étiquette, une liste).
 *
 * 🔴 PAS DE CRITÈRE D'INACTIVITÉ (relecture du lot, 2026-10-26). Le seul « dernier message » qu'on ait est celui des fils
 * (`conversations.last_message_at`), or la conservation les purge (30 jours en Free) et la déconnexion du numéro les
 * efface tous : un client qui a écrit il y a trois mois paraîtrait « jamais actif », et l'outil effacerait des clients
 * actifs. `inactive_days` est donc une clé inconnue, refusée comme les autres. L'inactivité reviendra quand la fiche
 * gardera sa propre date de dernier message (`todo.md`).
 *
 * Sur le motif des campagnes (`prepare_campaign` puis `launch_campaign`) : `prepare_contacts_deletion` montre le compte, un
 * échantillon et un code, et n'efface rien ; `delete_contacts` re-résout la même sélection, refuse si elle ne désigne
 * plus les mêmes fiches (`src/crm/code-suppression.ts`), puis efface par `effacerContacts`, l'effacement de la purge de
 * la console et de `DELETE /v1/contacts/{id}` : la même limite du jour (levée tant que l'espace dépasse sa limite de
 * contacts, `QuotaSuppressions`), la même purge, le même retrait chez l'agent de Meta, la même ligne d'audit.
 *
 * 🔴 Une personne nommée (`exigePersonne`, un jeton OAuth d'administrateur, jamais une clé d'API) : une clé branchée sur un
 * agent qui lit des messages de clients ne doit pas pouvoir effacer l'espace sur l'injection d'un message. Ouverts à
 * toutes les offres : c'est la Free qui en a besoin.
 */

// Les fiches au plus par appel (`MAX_FICHES_PAR_SUPPRESSION`) et celles de l'aperçu (`FICHES_DE_L_APERCU`) viennent du
// catalogue partagé : la documentation publique les cite.
/** Un code fait une trentaine de caractères (`src/crm/code-suppression.ts`) : de la marge pour une recopie. */
export const LONGUEUR_MAX_CODE_SUPPRESSION = 64;

/** La limite du jour de la Free, lue dans la grille, que les descriptions citent. */
const SUPPRESSIONS_DU_JOUR = DROITS.base.limites.suppressionsJour ?? 0;

export interface DepsSuppressionMcp {
  /** Les fiches vivantes d'une sélection, DANS l'espace, les plus anciennes d'abord (`PgContactStore.selectionAEffacer`). */
  selection(tenantId: string, cible: BulkTarget, limite: number): Promise<FicheASupprimer[]>;
  /** L'effacement de la purge de la console et de `DELETE /v1/contacts/{id}` : les MÊMES objets (`effacerContacts`). */
  effacement: DepsEffacement;
  /** Le journal d'audit : une ligne `contact.purged` par fiche, signée de la personne, comme la purge de la console. */
  audit: AuditSink;
  /** Le secret qui signe les codes de confirmation (`AUTH_SECRET`, sous une clé dérivée pour ce seul usage). */
  secret: string;
}

/** Les critères d'une sélection : ceux de la cible d'une campagne, sans l'analyse ni les conversations, et `oldest`. */
const CLES_DE_SELECTION = ['tags', 'tag_mode', 'opt_in', 'contact_ids', 'oldest'] as const;

/** Les paramètres de la sélection, annoncés par les deux outils. Toute borne appliquée ici y figure. */
const CHAMPS_DE_SELECTION: Record<(typeof CLES_DE_SELECTION)[number], ProprieteEntree> = {
  tags: { ...CHAMPS_CIBLE_FILTRES.tags!, description: 'Contacts carrying these tags.' },
  tag_mode: CHAMPS_CIBLE_FILTRES.tag_mode!,
  opt_in: { ...CHAMPS_CIBLE_FILTRES.opt_in!, description: 'Marketing consent of the contacts: opted_in, opted_out (they replied STOP) or unknown.' },
  contact_ids: {
    ...CHAMPS_CIBLE_IDENTIFIANTS.contact_ids!,
    description: `Contacts by id (contact_id of list_conversations, id of search_contacts), ${MAX_IDENTIFIANTS_CIBLE} at most. `
      + 'Not combined with tags or opt_in; oldest narrows them.',
  },
  oldest: {
    type: 'integer', minimum: 1, maximum: MAX_FICHES_PAR_SUPPRESSION,
    description: 'Keeps the N oldest contacts of the selection, by creation date.',
  },
};

/** L'analyse n'est pas un critère de ces outils : `lireCibleMcp` ne reçoit aucune fonction à ouvrir. */
const SANS_ANALYSE: ReadonlySet<Fonction> = new Set();

const present = (v: unknown): boolean => v !== undefined && v !== null;

/** Une sélection lue, avant toute lecture en base. */
interface SelectionLue {
  args: Record<string, unknown>;
  parCible: boolean;
  plusAnciennes: number | null;
}

/**
 * Lit une sélection, sans rien lire en base. 🔴 Une clé inconnue est REFUSÉE, jamais ignorée : un critère jeté (une
 * analyse, des conversations, une inactivité) élargirait ce qu'on efface. Sans aucun critère, refusée : ce ne sera jamais
 * « tout l'espace ».
 */
function lireSelection(args: Record<string, unknown>): SelectionLue {
  const permises: readonly string[] = CLES_DE_SELECTION;
  const inconnues = Object.keys(args).filter((k) => !permises.includes(k));
  if (inconnues.length > 0) throw new RefusOutil(`paramètre inconnu : ${inconnues.join(', ')} (la sélection se fait par ${permises.join(', ')})`);
  if (present(args.tag_mode) && !present(args.tags)) throw new RefusOutil('paramètre « tag_mode » : il ne vaut qu’avec tags');
  if (Array.isArray(args.tags) && args.tags.length === 0) throw new RefusOutil('paramètre « tags » : au moins une étiquette, ou pas de paramètre');
  const plusAnciennes = present(args.oldest) ? limiteEntiere(args.oldest, 'oldest', 1, MAX_FICHES_PAR_SUPPRESSION) : null;
  const parCible = ['tags', 'opt_in', 'contact_ids'].some((k) => present(args[k]));
  if (!parCible && plusAnciennes === null) {
    throw new RefusOutil('précisez au moins un critère : tags, opt_in, contact_ids ou oldest');
  }
  return { args, parCible, plusAnciennes };
}

/**
 * Les fiches d'une sélection, DANS l'espace. La cible passe par l'analyseur des campagnes (`lireCibleMcp`, donc
 * `parseBulkTarget`) ; sans aucun de ses critères, c'est tout l'espace, que `oldest` resserre.
 */
async function resoudreSelection(deps: DepsMcp, tenantId: string, s: SelectionLue): Promise<FicheASupprimer[]> {
  const cible: BulkTarget = s.parCible
    ? await lireCibleMcp(s.args, SANS_ANALYSE, deps, tenantId, { identifiants: true })
    : { filters: {}, excludeIds: [] };
  // Une de plus que le plafond, sans `oldest` : c'est elle qui dit que la sélection le dépasse.
  const fiches = await deps.suppression.selection(tenantId, cible, s.plusAnciennes ?? MAX_FICHES_PAR_SUPPRESSION + 1);
  if (fiches.length > MAX_FICHES_PAR_SUPPRESSION) {
    throw new RefusOutil(`cette sélection compte plus de ${MAX_FICHES_PAR_SUPPRESSION} contacts : resserrez-la (oldest, tags), `
      + `${MAX_FICHES_PAR_SUPPRESSION} au plus par appel`);
  }
  return fiches;
}

/** Ce que Claude lit quand le code n'efface rien, et ce qu'il peut faire. Rien n'a jamais été supprimé dans ces cas. */
const REFUS_DU_CODE: Record<'invalide' | 'expire', string> = {
  invalide: 'ce code ne correspond pas à cette sélection : elle ne désigne plus les mêmes contacts qu’à l’aperçu (des fiches '
    + 'ont changé ou ont été supprimées depuis, peut-être par un appel précédent avec ce code), ou le code vient d’un autre '
    + 'aperçu. Rien n’a été supprimé. Préparez à nouveau avec prepare_contacts_deletion pour voir ce qu’elle désigne maintenant.',
  expire: 'code de confirmation expiré (30 minutes) : rien n’a été supprimé. Préparez à nouveau avec prepare_contacts_deletion.',
};

const PLAFOND_DU_JOUR = `In Free, deletions are capped at ${SUPPRESSIONS_DU_JOUR} a day while the workspace is within its contact `
  + 'limit, and not capped while it is above it (get_plan: contactsEnTrop, the contacts above the limit).';

export const OUTILS_SUPPRESSION: OutilMcp[] = [
  {
    ...ficheOutilMcp('prepare_contacts_deletion'),
    fonction: null,
    description:
      'Prepares the deletion of a selection of contacts WITHOUT deleting anything. Returns how many contacts the '
      + `selection holds, ${FICHES_DE_L_APERCU} of them at most (name, masked number, creation date) and a confirmation code `
      + 'valid 30 minutes, which delete_contacts requires with the same selection. The selection: tags (all or any), '
      + 'marketing consent or a list of contact_ids, narrowed or not by oldest (the oldest contacts of the selection, by '
      + `creation date). At least one criterion is required, and a selection of more than ${MAX_FICHES_PAR_SUPPRESSION} `
      + 'contacts is refused: oldest narrows it. A deleted contact is never counted. Deleting is irreversible: the summary '
      + `and its code exist so that the person sees what would be deleted before saying yes. ${PLAFOND_DU_JOUR} ${LOURDE}`,
    // Rien n'est écrit ni ne part chez un tiers ; chaque appel tire un nouveau code : pas idempotente. Destructrice pour la
    // règle du répertoire de Claude (une écriture du scope `mcp:write`, voir `AnnotationsMcp`), comme `prepare_campaign`.
    annotations: ecriture('Prepare a contact deletion', false, false),
    entree: { type: 'object', properties: { ...CHAMPS_DE_SELECTION }, additionalProperties: false },
    async executer(deps, tenantId, args, personne) {
      signataire(personne);
      const selection = lireSelection(args);
      // Le plafond des opérations coûteuses, comme `prepare_campaign` : la sélection lit jusqu'au plafond de fiches, plus une.
      await plafondCouteux(deps, tenantId);
      const fiches = await resoudreSelection(deps, tenantId, selection);
      if (fiches.length === 0) throw new RefusOutil('aucun contact de cet espace ne correspond à cette sélection : rien à supprimer');
      const { code, expireLe } = codeDeSuppression(deps.suppression.secret, tenantId, empreinteDesFiches(fiches.map((f) => f.id)), Date.now());
      return {
        count: fiches.length,
        // Les plus anciennes d'abord, comme la sélection : un numéro masqué, jamais entier (plan).
        sample: fiches.slice(0, FICHES_DE_L_APERCU).map((f) => ({
          name: f.profileName, phone: numeroMasque(f.phoneE164 ?? f.bsuid ?? ''), created_at: f.createdAt,
        })),
        confirmation_code: code,
        code_expires_at: expireLe.toISOString(),
        a_savoir: 'Rien n’a été supprimé. La suppression est définitive : chaque fiche part avec ses conversations, ses messages '
          + 'et son analyse. Après le oui de la personne, delete_contacts avec la MÊME sélection et ce code.',
      };
    },
  },
  {
    ...ficheOutilMcp('delete_contacts'),
    fonction: null,
    description:
      'Deletes for good the contacts of a selection prepared by prepare_contacts_deletion: the same selection, and the '
      + 'confirmation_code of its summary. Each contact is erased with its conversations, messages and analysis, as by '
      + 'the deletion of the console; a contact who replied STOP stays unsubscribed if they come back. Nothing is deleted '
      + 'when the code has expired (30 minutes) or comes from another summary, or when the selection no longer designates '
      + 'the same contacts as the summary (contacts changed or were deleted since, by this code among others). Returns how '
      + `many contacts, conversations and messages were deleted. ${PLAFOND_DU_JOUR} ${LOURDE}`,
    // Irréversible, et un second appel avec le même code est refusé : pas idempotente. Monde ouvert : la purge retire aussi
    // les contacts de la liste de l'agent de Meta, chez Meta (comme `control_conversation`).
    annotations: ecriture('Delete contacts', false, true),
    entree: {
      type: 'object',
      properties: {
        confirmation_code: {
          type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_CODE_SUPPRESSION,
          description: 'The confirmation_code of the summary returned by prepare_contacts_deletion.',
        },
        ...CHAMPS_DE_SELECTION,
      },
      required: ['confirmation_code'],
      additionalProperties: false,
    },
    async executer(deps, tenantId, args, personne) {
      const userId = signataire(personne);
      const code = texteObligatoire(args, 'confirmation_code', LONGUEUR_MAX_CODE_SUPPRESSION);
      if (!codeBienForme(code)) throw new RefusOutil(REFUS_DU_CODE.invalide);
      const selection = lireSelection(Object.fromEntries(Object.entries(args).filter(([cle]) => cle !== 'confirmation_code')));
      // Le plafond des opérations coûteuses de la purge de la console (`couteux` sur sa route), compté AVANT les lectures.
      await plafondCouteux(deps, tenantId);
      const fiches = await resoudreSelection(deps, tenantId, selection);
      if (fiches.length === 0) {
        throw new RefusOutil('cette sélection ne désigne plus aucun contact : rien n’a été supprimé (ils l’ont peut-être déjà été, '
          + 'par un appel précédent avec ce code)');
      }
      const ids = fiches.map((f) => f.id);
      // 🔴 Le code est vérifié sur les fiches RE-RÉSOLUES à l'instant : rien d'autre que ce que l'aperçu a montré ne part.
      const verdict = verifierCodeDeSuppression(deps.suppression.secret, code, tenantId, empreinteDesFiches(ids), Date.now());
      if (verdict !== 'ok') throw new RefusOutil(REFUS_DU_CODE[verdict]);
      // L'effacement partagé : la limite du jour d'abord, tout ou rien (levée au-delà de la limite de contacts), puis la purge.
      const e = await effacerContacts(deps.suppression.effacement, tenantId, ids);
      if (!e.ok) throw new RefusOutil(corpsRefusLimite(new LimiteOffreError(tenantId, 'suppressionsJour', e.max)).error);
      // L'audit de la purge de la console, signé de la personne, au mieux : un journal en panne ne défait pas l'effacement.
      const journal = makeJournal(deps.suppression.audit);
      for (const id of ids) await journal(tenantId, { auth: { userId } }, 'contact.purged', { kind: 'contact', id }, { lot: ids.length, via: 'mcp' });
      // Le retrait chez l'agent de Meta part en fond, suivi (`effacerContacts`) : il ne retient pas la réponse.
      e.retirerChezMeta();
      return { deleted: e.bilan.purges, conversations: e.bilan.conversations, messages: e.bilan.messages };
    },
  },
];
