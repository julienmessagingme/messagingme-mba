import type { AnnotationsMcp, DepsMcp, OutilMcp } from './outils';
import { RefusOutil, entierBorne } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import type { RapportEnvoi, ReponseEnvoi } from '../http/v1-sends';
import { CLE_IDEMPOTENCE_MAX } from '../api/idempotence';
import { messageDeForme } from '../api/forme';
import { BORNES_MODELE, schemaModeleMeta } from '../api/modele-meta';
import { creerModeleDepuisMeta, statutsDuModele, type DepsCreationModele } from '../api/creer-modele';
import type { TemplateSummary } from '../meta/templates';

/**
 * LES MODÈLES DEPUIS CLAUDE (lot 13, domaine 3, spec § 5) : créer un modèle au format de Meta, suivre sa validation,
 * lister ceux de l'espace, et en envoyer un à UN contact (livraison B, par le cœur de `POST /v1/sends`). Les MÊMES fonctions que `POST /v1/templates` et `GET /v1/templates/{name}`
 * (`src/api/creer-modele.ts`), elles-mêmes passées par la création de l'écran Modèles : aucun contrôle propre ici.
 * Ouverts à toutes les offres, comme l'écran Modèles.
 */
export interface DepsModelesMcp extends DepsCreationModele {
  /** Les modèles du compte WhatsApp de l'espace, la MÊME lecture (en cache une minute) que le catalogue `/v1/templates`. */
  lister(tenantId: string): Promise<TemplateSummary[]>;
}

/** Une erreur de l'envoi (`{ error, code }`), lue pour la rendre à Claude telle que l'API la rend. */
function phraseDeRefus(r: ReponseEnvoi): string {
  const c = r.corps as { error?: unknown; code?: unknown } | null;
  const phrase = typeof c?.error === 'string' ? c.error : `refus ${r.statut}`;
  return typeof c?.code === 'string' ? `${phrase} (${c.code})` : phrase;
}

const NOM = { type: 'string' as const, minLength: 1, maxLength: BORNES_MODELE.nom, pattern: '^[a-z0-9_]+$', description: 'Le nom du modèle (minuscules, chiffres et _).' };
const lecture = (title: string): AnnotationsMcp => ({ title, readOnlyHint: true, openWorldHint: false });

export const OUTILS_MODELES: OutilMcp[] = [
  {
    nom: 'list_templates',
    fonction: null,
    description:
      'Les modèles WhatsApp de l’espace, chacun avec sa langue, sa catégorie (utility, marketing…) et son statut chez Meta '
      + '(approved, pending, rejected, paused…). Seul un modèle approved peut partir. Pour le motif d’un refus : '
      + 'get_template_status.',
    scope: 'mcp:read',
    annotations: lecture('Lister les modèles'),
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Nombre de modèles (1 à 500, défaut 100).' },
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
    nom: 'get_template_status',
    fonction: null,
    description:
      'Le statut d’un modèle chez Meta, langue par langue (approved, pending, rejected…), avec le motif d’un refus '
      + '(rejectedReason, null sans motif). À lire après create_template : la validation prend de quelques minutes à '
      + 'quelques heures.',
    scope: 'mcp:read',
    annotations: lecture('Lire le statut d’un modèle'),
    entree: {
      type: 'object',
      properties: {
        name: NOM,
        language: { type: 'string', minLength: 2, maxLength: 20, description: 'Une seule langue (fr, en_US…). Absent : toutes.' },
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
    nom: 'create_template',
    fonction: null,
    description:
      'Crée un modèle WhatsApp et le soumet à la validation de Meta, au FORMAT DE META : { name (minuscules, chiffres et _, '
      + '512 au plus), language (fr, en_US…), category (UTILITY ou MARKETING), components }. Chaque composant au plus une '
      + 'fois. HEADER : format TEXT avec text (60 caractères, sans variable), ou IMAGE, VIDEO, DOCUMENT avec '
      + 'example.header_url : [« https://… »] (2 000 caractères, sans redirection ; image JPEG ou PNG de 5 Mo, vidéo MP4 ou '
      + 'document PDF de 16 Mo ; le fichier est téléchargé et déposé chez Meta). BODY obligatoire (1 024 caractères ; '
      + 'variables {{1}}, {{2}}… contiguës, avec example.body_text : [[une valeur par variable, 200 caractères]]). FOOTER '
      + '(60 caractères, sans variable). BUTTONS (10 au plus, texte de 25 caractères) : QUICK_REPLY, ou URL (2 au plus, '
      + 'adresse https sans {{1}}, tracée par nous). Rend le statut initial (souvent pending) : suivre avec '
      + 'get_template_status. Compte dans les opérations lourdes de l’espace.',
    scope: 'mcp:write',
    /**
     * 🔴 Une PERSONNE (jeton OAuth), jamais une clé d'API (décision de Julien du 2026-10-09) : un Claude branché sur des
     * conversations de clients pourrait, sur l'injection d'un message, créer des modèles en boucle jusqu'au plafond du
     * compte WhatsApp, et bloquer ensuite la création depuis la console. L'API (`POST /v1/templates`) reste aux clés
     * `templates:write`, un droit qu'on donne en connaissance de cause.
     */
    exigePersonne: true,
    // Monde ouvert : le modèle part chez Meta et y reste (le supprimer est un autre geste, depuis la console).
    annotations: { title: 'Créer un modèle', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        template: {
          type: 'object',
          description: 'Le corps de Meta, par exemple { "name": "commande_prete", "language": "fr", "category": "UTILITY", '
            + '"components": [{ "type": "BODY", "text": "Bonjour {{1}}, votre commande est prête.", "example": '
            + '{ "body_text": [["Marie"]] } }] }. Un champ inconnu est refusé.',
        },
      },
      required: ['template'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args) {
      const lu = schemaModeleMeta.safeParse(args.template);
      if (!lu.success) throw new RefusOutil(`modèle invalide : ${messageDeForme(lu.error)}`);
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      const r = await creerModeleDepuisMeta(deps.modeles, tenantId, lu.data);
      if ('refus' in r) throw new RefusOutil(r.refus.message);
      return r.modele;
    },
  },
  {
    nom: 'send_template_to_contact',
    fonction: null,
    description:
      'Envoie un modèle WhatsApp APPROUVÉ à UNE personne, même hors de la fenêtre de 24 h, par le même chemin que '
      + 'POST /v1/sends : consentement (un modèle marketing ne part que vers qui a consenti), STOP, numéro délié ou '
      + 'suspendu, modèles du mois de l’offre. La personne se désigne par phone (avec l’indicatif : +33612345678) ou '
      + 'contact_id ; un numéro inconnu crée sa fiche. values : une valeur par variable {{1}}, {{2}}… du corps, dans '
      + 'l’ordre. idempotency_key : une clé choisie pour CET envoi (un appel rejoué avec la même clé ne renvoie rien, '
      + 'pendant 24 h). L’envoi part dans la minute : rend send_id. Compte dans les opérations lourdes de l’espace.',
    scope: 'mcp:write',
    /**
     * 🔴 Une PERSONNE, comme `create_template` (décision de Julien du 2026-10-09) : un Claude branché sur des
     * conversations de clients pourrait, sur l'injection d'un message, envoyer des modèles facturés à des contacts.
     */
    exigePersonne: true,
    // Monde ouvert : un message part chez une personne. Idempotent : la même clé ne renvoie rien. Pas destructeur : un
    // modèle ne prend pas le fil.
    annotations: { title: 'Envoyer un modèle à un contact', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        name: NOM,
        language: { type: 'string', minLength: 2, maxLength: 20, description: 'La langue du modèle (fr, en_US…).' },
        phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$', description: 'Le numéro avec l’indicatif du pays. Ou contact_id.' },
        contact_id: { type: 'string', format: 'uuid', minLength: 36, maxLength: 36, description: 'L’identifiant d’une fiche. Ou phone.' },
        values: {
          type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1024 },
          description: 'Une valeur par variable du corps, dans l’ordre ({{1}} puis {{2}}…). Vide si le corps n’en a pas.',
        },
        idempotency_key: { type: 'string', minLength: 1, maxLength: CLE_IDEMPOTENCE_MAX, description: 'Une clé propre à cet envoi (un UUID par exemple).' },
      },
      required: ['name', 'language', 'idempotency_key'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args) {
      const phone = typeof args.phone === 'string' ? args.phone : undefined;
      const contactId = typeof args.contact_id === 'string' ? args.contact_id : undefined;
      if ((phone === undefined) === (contactId === undefined)) throw new RefusOutil('désignez la personne par phone OU par contact_id, pas les deux');
      const values = Array.isArray(args.values) ? args.values : [];
      if (values.some((v) => typeof v !== 'string' || v === '')) throw new RefusOutil('values : une chaîne non vide par variable');
      // Le corps de `POST /v1/sends`, pour une seule personne : les valeurs en sources littérales, positions 1..N.
      const corps = {
        idempotencyKey: args.idempotency_key,
        target: { template: { name: args.name, language: args.language } },
        ...(values.length > 0 ? { params: values.map((v, i) => ({ position: i + 1, source: { type: 'literal', value: v } })) } : {}),
        recipients: [phone !== undefined ? { phone } : { contactId }],
      };
      const r = await deps.envoyerModele(tenantId, corps, async () => {
        const c = await deps.couteux.consommer(tenantId);
        if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
        return true;
      });
      if (r === null) throw new RefusOutil('envoi refusé');
      if (r.statut >= 400) throw new RefusOutil(phraseDeRefus(r));
      // 201 : le rapport de l'envoi, ou celui d'un envoi déjà fait avec cette clé (rejeu), qui a la même forme.
      const rapport = r.corps as RapportEnvoi;
      if (rapport.recipientCount === 0) {
        throw new RefusOutil(`rien n’est parti : la personne est écartée (${rapport.skipped[0]?.reason ?? 'motif inconnu'})`);
      }
      return { send_id: rapport.sendId, contact_created: rapport.created > 0 };
    },
  },
];
