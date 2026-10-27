import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { AnnotationsMcp, DepsMcp, OutilMcp } from './outils';
import { RefusOutil, entierBorne } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import { compteurEnvoiRefuse, type RapportEnvoi, type ReponseEnvoi } from '../api/envoi-public';
import { CLE_IDEMPOTENCE_MAX } from '../api/idempotence';
import { journaliser } from '../lib/journal';
import { messageDeForme } from '../api/forme';
import { BORNES_MODELE, schemaModeleMeta, versModeleConsole } from '../api/modele-meta';
import { creerModeleDepuisMeta, estNomDeModele, refusDeMeta, statutsDuModele, type DepsCreationModele } from '../api/creer-modele';
import { modifierUnModele, supprimerUnModele, type RefusGestionModele } from '../templates/gestion';
import { codeDuLienTrace } from '../links/rewrite';
import type { TemplateSummary } from '../meta/templates';
import { VALEUR_ACCEPTEE } from '../api/modele-envoi';
import { LOURDE, plafondCouteux, signataire } from './outils-agent';

/**
 * LES MODÈLES DEPUIS CLAUDE (lot 13, domaine 3, spec § 5) : créer un modèle au format de Meta, suivre sa validation,
 * lister ceux de l'espace, et en envoyer un à UN contact (livraison B, par le cœur de `POST /v1/sends`). Les MÊMES fonctions que `POST /v1/templates` et `GET /v1/templates/{name}`
 * (`src/api/creer-modele.ts`), elles-mêmes passées par la création de l'écran Modèles. Un seul contrôle propre ici :
 * la correction refuse ce que son format perdrait (`ceQueCeFormatPerdrait`). Ouverts à toutes les offres, comme l'écran
 * Modèles.
 */
export interface DepsModelesMcp extends DepsCreationModele {
  /** Les modèles du compte WhatsApp de l'espace, la MÊME lecture (en cache une minute) que le catalogue `/v1/templates`. */
  lister(tenantId: string): Promise<TemplateSummary[]>;
  /** Oublie cette liste en cache pour l'espace : après une création, une correction ou une suppression par Claude. */
  oublier(tenantId: string): Promise<void>;
}

/**
 * Après un changement fait par Claude, la liste en cache (une minute) montrerait l'ancien état, et Claude croirait le geste
 * raté (vu à l'essai réel du 2026-10-23 : un modèle supprimé encore listé « approuvé »). Un raté de l'oubli ne fait rien
 * échouer : la liste se rafraîchit au plus une minute plus tard, et le journal le dit. ⚠️ Le cache vit dans UNE copie de
 * l'API (`cacheCourt`) : avec plusieurs copies, une autre peut montrer l'ancien état jusqu'à une minute ; un changement fait
 * dans l'écran Modèles ne l'oublie pas non plus.
 */
async function oublierLaListe(deps: DepsMcp, tenantId: string): Promise<void> {
  try {
    await deps.modeles.oublier(tenantId);
  } catch (err) {
    journaliser('warn', 'mcp_modeles_liste_non_oubliee', { tenantId, erreur: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 🔴 Une correction par `update_template` REMPLACE les composants, et son format ne porte que des boutons « réponse
 * rapide » et « lien » sans variable (`schemaModeleMeta`) : le bouton Flow d'un modèle, que la console sait garder, et le
 * lien dont une variable vient d'un scénario ou de Shopify (son panier) disparaîtraient en silence. Jugé sur le modèle tel
 * que Meta le rend, lu une fois par `modifierUnModele` (jamais le cache d'une minute de `lister`). Nos liens tracés
 * (`/r/<code>/{{1}}`, sous tout hôte, `codeDuLienTrace`) se retracent à la correction : ils passent, mais seulement si
 * leur code est l'un des nôtres pour CET espace (`notreCode`) : une adresse du client de la même forme reste un lien à
 * variable (relectures des lots 4 et 5). Rien n'est lu en base pour un modèle sans lien de cette forme.
 */
async function ceQueCeFormatPerdrait(
  existant: TemplateSummary,
  notreCode: (code: string) => Promise<boolean>,
): Promise<string | null> {
  if (existant.buttons?.some((b) => b.type === 'FLOW')) {
    return 'ce modèle porte un bouton Flow, que ce format ne sait pas renvoyer : la correction le supprimerait. Il ne se '
      + 'corrige pas depuis Claude';
  }
  for (const b of existant.buttons ?? []) {
    if (b.type !== 'URL' || !/\{\{\s*\d+\s*\}\}/.test(b.url ?? '')) continue;
    const code = codeDuLienTrace(b.url ?? '');
    if (code !== null && await notreCode(code)) continue;
    return 'ce modèle porte un bouton de lien qui prend une variable ({{1}}), que ce format ne sait pas renvoyer : la '
      + 'correction le changerait, et les envois qui la remplissent échoueraient. Il ne se corrige pas depuis Claude';
  }
  return null;
}

/** Une erreur de l'envoi (`{ error, code }`), lue pour la rendre à Claude telle que l'API la rend. */
function phraseDeRefus(r: ReponseEnvoi): string {
  const c = r.corps as { error?: unknown; code?: unknown } | null;
  const phrase = typeof c?.error === 'string' ? c.error : `refus ${r.statut}`;
  return typeof c?.code === 'string' ? `${phrase} (${c.code})` : phrase;
}

const NOM = { type: 'string' as const, minLength: 1, maxLength: BORNES_MODELE.nom, pattern: '^[a-z0-9_]+$', description: 'The template name (lowercase letters, digits and _).' };
const lecture = (title: string): AnnotationsMcp => ({ title, readOnlyHint: true, openWorldHint: false });

/** Un refus de l'écran Modèles, avec les campagnes actives nommées : la personne sait quoi arrêter d'abord. */
function phraseDuRefus(r: RefusGestionModele): string {
  const campagnes = r.campaigns?.map((c) => `« ${c.name} »`).join(', ');
  return campagnes ? `${r.error} : ${campagnes}` : r.error;
}

/**
 * Une erreur de Meta connue devient un refus lisible (`refusDeMeta`, le classement de l'API), une panne remonte. La route
 * de la console laisse ces erreurs en 500 ; un modèle ne doit pas faire croire à une panne là où Meta a dit pourquoi.
 */
async function ouRefusDeMeta<T>(appel: () => Promise<T>): Promise<T> {
  try {
    return await appel();
  } catch (err) {
    const r = refusDeMeta(err);
    if (r === null) throw err;
    throw new RefusOutil(r.message);
  }
}

export const OUTILS_MODELES: OutilMcp[] = [
  {
    ...ficheOutilMcp('list_templates'),
    fonction: null,
    description:
      'The workspace\'s WhatsApp templates, each with its language, its category (utility, marketing...) and its '
      + 'status at Meta (approved, pending, rejected, paused...). Only an approved template can be sent. The reason for '
      + 'a rejection: get_template_status.',
    annotations: lecture('List templates'),
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Number of templates (1 to 500, default 100).' },
      },
    },
    async executer(deps: DepsMcp, tenantId, args) {
      const limit = entierBorne(args, 'limit', 100, 1, 500);
      const tous = await deps.modeles.lister(tenantId);
      return {
        templates: tous.slice(0, limit).map((t) => ({
          name: t.name, language: t.language, category: t.category.toLowerCase(), status: t.status.toLowerCase(),
        })),
        tronque: tous.length > limit,
      };
    },
  },
  {
    ...ficheOutilMcp('get_template_status'),
    fonction: null,
    description:
      'A template\'s status at Meta, language by language (approved, pending, rejected...), with the reason for a '
      + 'rejection (rejectedReason, null without a reason). It follows up create_template: Meta\'s review takes from a '
      + 'few minutes to a few hours.',
    annotations: lecture('Read a template status'),
    entree: {
      type: 'object',
      properties: {
        name: NOM,
        language: { type: 'string', minLength: 2, maxLength: 20, description: 'A single language (fr, en_US...). Absent: all.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args) {
      const name = typeof args.name === 'string' ? args.name : '';
      const language = typeof args.language === 'string' ? args.language : undefined;
      const r = await statutsDuModele(deps.modeles, tenantId, name, language);
      if ('refus' in r) throw new RefusOutil(r.refus.message);
      return r;
    },
  },
  {
    ...ficheOutilMcp('create_template'),
    fonction: null,
    description:
      'Creates a WhatsApp template and submits it to Meta\'s review, in META\'S FORMAT: { name (lowercase letters, '
      + 'digits and _, 512 at most), language (fr, en_US...), category (UTILITY or MARKETING), components }. Each '
      + 'component at most once. HEADER: format TEXT with text (60 characters, no variable), or IMAGE, VIDEO, DOCUMENT '
      + 'with example.header_url: ["https://..."] (2,000 characters, no redirect; JPEG or PNG image of 5 MB, MP4 video '
      + 'or PDF document of 16 MB; the file is downloaded and uploaded to Meta). BODY required (1,024 characters; '
      + 'variables {{1}}, {{2}}... contiguous, with example.body_text: [[one value per variable, 200 characters]]). '
      + 'FOOTER (60 characters, no variable). BUTTONS (10 at most, text of 25 characters): QUICK_REPLY, or URL (2 at '
      + 'most, https address without {{1}}, tracked by us). Returns the initial status (often pending), which '
      + 'get_template_status follows up. Counts toward the workspace\'s heavy operations.',
    // Monde ouvert : le modèle part chez Meta et y reste (le supprimer est un autre geste, depuis la console).
    // Destructrice pour la règle du répertoire de Claude (voir `AnnotationsMcp`).
    annotations: { title: 'Create a template', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        template: {
          type: 'object',
          description: 'Meta\'s body, for example { "name": "order_ready", "language": "en", "category": "UTILITY", '
            + '"components": [{ "type": "BODY", "text": "Hello {{1}}, your order is ready.", "example": '
            + '{ "body_text": [["Marie"]] } }] }. An unknown field is refused.',
        },
      },
      required: ['template'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const lu = schemaModeleMeta.safeParse(args.template);
      if (!lu.success) throw new RefusOutil(`modèle invalide : ${messageDeForme(lu.error)}`);
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      const r = await creerModeleDepuisMeta(deps.modeles, tenantId, lu.data);
      if ('refus' in r) throw new RefusOutil(r.refus.message);
      await oublierLaListe(deps, tenantId);
      journaliser('info', 'mcp_modele_cree', { tenantId, userId: personne?.userId ?? null, nom: r.modele.name, langue: r.modele.language });
      return r.modele;
    },
  },
  {
    ...ficheOutilMcp('send_template_to_contact'),
    fonction: null,
    description:
      'Sends an APPROVED WhatsApp template to ONE person, even outside the 24-hour window, through the same path as '
      + 'POST /v1/sends: STOP, number unlinked or suspended, the plan\'s monthly templates. Sending through Claude '
      + 'declares, on the user\'s behalf and under their responsibility, that the person agreed to receive their '
      + 'messages: the record becomes opted in (marketing included), with who declared it; consent is not a '
      + 'parameter, the send records it on the user\'s behalf. A person who sent STOP is never written to. The person is designated by phone (with the country code: '
      + '+33612345678) or contact_id; an unknown number creates its contact record. values: one value per variable '
      + '{{1}}, {{2}}... of the body, in order. idempotency_key: a key chosen for THIS send (a call replayed with the '
      + 'same key sends nothing again, for 24 hours). The send goes out within the minute: returns send_id. It does not '
      + 'take a conversation escalated to the team out of "To handle": once the person has answered, '
      + 'control_conversation (hand_back) does. Counts toward the workspace\'s heavy operations.',
    // Monde ouvert : un message part chez une personne. Idempotent : la même clé ne renvoie rien. Un modèle ne prend
    // pas le fil, mais l'outil est destructeur pour la règle du répertoire de Claude (voir `AnnotationsMcp`).
    annotations: { title: 'Send a template to a contact', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        name: NOM,
        language: { type: 'string', minLength: 2, maxLength: 20, description: 'The template language (fr, en_US...).' },
        phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$', description: 'The number with the country code. Or contact_id.' },
        contact_id: { type: 'string', format: 'uuid', minLength: 36, maxLength: 36, description: 'The id of a contact record. Or phone.' },
        values: {
          type: 'array', maxItems: 50,
          items: { type: 'string', minLength: 1, maxLength: 1024, pattern: VALEUR_ACCEPTEE.source },
          description: 'One value per body variable, in order ({{1}} then {{2}}...), without line breaks, tabs or more '
            + 'than four spaces in a row (Meta refuses them). Empty if the body has none.',
        },
        idempotency_key: { type: 'string', minLength: 1, maxLength: CLE_IDEMPOTENCE_MAX, description: 'A key specific to this send (a UUID for example).' },
      },
      required: ['name', 'language', 'idempotency_key'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const phone = typeof args.phone === 'string' ? args.phone : undefined;
      const contactId = typeof args.contact_id === 'string' ? args.contact_id : undefined;
      if ((phone === undefined) === (contactId === undefined)) throw new RefusOutil('désignez la personne par phone OU par contact_id, pas les deux');
      const values = Array.isArray(args.values) ? args.values : [];
      if (values.some((v) => typeof v !== 'string' || v === '')) throw new RefusOutil('values : une chaîne non vide par variable');
      if (values.some((v) => !VALEUR_ACCEPTEE.test(v as string))) {
        throw new RefusOutil('values : ni retour à la ligne, ni tabulation, ni plus de quatre espaces de suite (Meta refuserait le message)');
      }
      // Le corps de `POST /v1/sends`, pour une seule personne : les valeurs en sources littérales, positions 1..N.
      // 🔴 L'ACCORD DE LA PERSONNE EST DÉCLARÉ PAR LE CLIENT (décision de Julien du 2026-10-25 : « si je demande
      // d'envoyer à tel numéro, c'est le choix du client », sa responsabilité, pas la nôtre). Il s'écrit sur la fiche par
      // le chemin partagé de `POST /v1/sends`, signé de la personne connectée ; ce chemin refuse d'y lever un STOP
      // (`appliquerConsentement`), et la personne désabonnée reste écartée.
      const corps = {
        idempotencyKey: args.idempotency_key,
        target: { template: { name: args.name, language: args.language } },
        ...(values.length > 0 ? { params: values.map((v, i) => ({ position: i + 1, source: { type: 'literal', value: v } })) } : {}),
        recipients: [{
          ...(phone !== undefined ? { phone } : { contactId }),
          consent: 'opted_in', consentSource: `déclaré dans Claude par ${signataire(personne)}`,
        }],
      };
      // Compté où le cycle public compte (juste après la clé d'idempotence, qu'il libère si ce compteur lève) : le
      // plafond coûteux, PUIS le quota d'envois du jour.
      const r = await deps.envoyerModele(tenantId, corps, async (unites) => {
        const c = await deps.couteux.consommer(tenantId);
        if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
        const q = await deps.quotaEnvois(tenantId, unites);
        if (!q.accepte) throw new RefusOutil(q.raison ?? 'quota quotidien d’envois de l’espace atteint');
        return true;
      });
      if (compteurEnvoiRefuse(r)) throw new RefusOutil('envoi refusé par le compteur');
      if (r.statut >= 400) throw new RefusOutil(phraseDeRefus(r));
      // 201 : le rapport de l'envoi, ou celui d'un envoi déjà fait avec cette clé (rejeu), qui a la même forme.
      const rapport = r.corps as RapportEnvoi;
      if (rapport.recipientCount === 0) {
        // La clé est consommée : l'envoi vide est scellé, et le même appel rejouerait ce refus.
        throw new RefusOutil(`rien n’est parti : la personne est écartée (${rapport.skipped[0]?.reason ?? 'motif inconnu'})`
          + `${rapport.created > 0 ? ' ; sa fiche a été créée' : ''} ; une fois la cause levée, réessayer avec une NOUVELLE idempotency_key`);
      }
      // La trace de la personne qui a envoyé : la campagne, elle, porte le préfixe des envois de l'API.
      journaliser('info', 'mcp_modele_envoye', { tenantId, userId: personne?.userId ?? null, sendId: rapport.sendId });
      return { send_id: rapport.sendId, contact_created: rapport.created > 0 };
    },
  },
  /*
   * La marche arrière (plan du 2026-10-22, tâche 3) : corriger un modèle refusé sous le même nom, et supprimer un modèle,
   * par l'édition et la suppression de l'écran Modèles (`modifierUnModele`, `supprimerUnModele`). Une garde de plus pour
   * la correction : ce que son format perdrait (`ceQueCeFormatPerdrait`, lots 3 et 4). La Free n'a plus cet écran. Les règles de Meta citées sont celles de sa page « Template management » (lue le 2026-10-22).
   */
  {
    ...ficheOutilMcp('update_template'),
    fonction: null,
    description:
      'Edits ONE language of a template already submitted, in META\'S FORMAT, the same as create_template: name and '
      + 'language designate it, and the components REPLACE the current ones (send them all). Only a template made of a '
      + 'BODY, with BUTTONS, a FOOTER or a TEXT HEADER, can be edited; an image, video or document header can be neither '
      + 'added nor kept: create a new template instead. A template with a Flow button, or with a link button that takes a '
      + 'variable ({{1}}, filled by a scenario or Shopify), is refused too: this format cannot send that button back, and '
      + 'the edit would remove or change it. Meta\'s rules: an APPROVED template can be edited '
      + 'once in 24 hours and 10 times in 30 days, and its category cannot change; a REJECTED or PAUSED one without limit. The '
      + 'template goes back to review (pending), which get_template_status follows. Refused while an active campaign uses '
      + 'it. ' + LOURDE,
    // Monde ouvert : le modèle repart chez Meta. Pas idempotente : chaque édition d'un modèle approuvé use une des dix du
    // mois. Destructrice pour la règle du répertoire de Claude (voir `AnnotationsMcp`).
    annotations: { title: 'Edit a template', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        template: {
          type: 'object',
          description: 'Meta\'s body, as for create_template, for example { "name": "order_ready", "language": "en", '
            + '"category": "UTILITY", "components": [{ "type": "BODY", "text": "Hello {{1}}, your order is ready.", '
            + '"example": { "body_text": [["Marie"]] } }] }. An unknown field is refused.',
        },
      },
      required: ['template'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const lu = schemaModeleMeta.safeParse(args.template);
      if (!lu.success) throw new RefusOutil(`modèle invalide : ${messageDeForme(lu.error)}`);
      const { input, enteteMedia } = versModeleConsole(lu.data);
      // L'écran ne refait pas un en-tête média (il faudrait le redéposer) : le garder ou l'ajouter le perdrait en silence.
      if (enteteMedia) {
        throw new RefusOutil('un en-tête image, vidéo ou document ne se met pas par une correction : créez un nouveau modèle (create_template)');
      }
      await plafondCouteux(deps, tenantId);
      const { name, language, ...champs } = input;
      // Un code de nos liens tracés, confirmé ou non : une confirmation ou une restauration ratée laisse la ligne non
      // confirmée, et le lien reste le nôtre. Son espace le dit (`getByCode`, la lecture de la redirection publique).
      // Une panne de la base est un refus lisible, jamais un « lien à variable » qui serait faux.
      const notreCode = async (code: string): Promise<boolean> => {
        try {
          return (await deps.modeles.modeles.tracking.liens.getByCode(code))?.tenantId === tenantId;
        } catch (err) {
          journaliser('error', 'mcp_modele_lien_illisible', { tenantId, nom: name, erreur: err instanceof Error ? err.message : String(err) });
          throw new RefusOutil('les liens tracés de ce modèle n’ont pas pu être relus : réessayez dans un instant');
        }
      };
      await ouRefusDeMeta(async () => {
        const issue = await modifierUnModele(deps.modeles.modeles, tenantId, name, language, champs, undefined,
          (existant) => ceQueCeFormatPerdrait(existant, notreCode));
        if ('refus' in issue) throw new RefusOutil(phraseDuRefus(issue.refus));
      });
      await oublierLaListe(deps, tenantId);
      journaliser('info', 'mcp_modele_modifie', { tenantId, userId: personne?.userId ?? null, nom: name, langue: language });
      return { name, language, status: 'pending' };
    },
  },
  {
    ...ficheOutilMcp('delete_template'),
    fonction: null,
    description:
      'Deletes a template, ALL its languages, at Meta and in the workspace. Refused while an active campaign uses it. '
      + 'Before deleting, check that nothing else sends it: a Shopify message (get_shopify_state) or a published scenario '
      + 'that uses it would then fail without warning. If the template was APPROVED, Meta forbids creating a new one '
      + 'with the same name for 30 days. ' + LOURDE,
    // Monde ouvert : la suppression se fait chez Meta. Supprimer deux fois ne supprime rien de plus.
    annotations: { title: 'Delete a template', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: { name: NOM },
      required: ['name'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!estNomDeModele(name)) throw new RefusOutil('name : un nom de modèle, en lettres minuscules, chiffres et _');
      await plafondCouteux(deps, tenantId);
      await ouRefusDeMeta(async () => {
        const issue = await supprimerUnModele(deps.modeles.modeles, tenantId, name);
        if ('refus' in issue) throw new RefusOutil(phraseDuRefus(issue.refus));
        if (!issue.res.success) throw new RefusOutil('Meta n’a pas confirmé la suppression : vérifiez avec get_template_status avant de réessayer');
      });
      await oublierLaListe(deps, tenantId);
      journaliser('info', 'mcp_modele_supprime', { tenantId, userId: personne?.userId ?? null, nom: name });
      return { supprime: true, name };
    },
  },
];
