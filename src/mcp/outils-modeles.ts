import type { AnnotationsMcp, DepsMcp, OutilMcp } from './outils';
import { RefusOutil, entierBorne } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import { messageDeForme } from '../api/forme';
import { BORNES_MODELE, schemaModeleMeta } from '../api/modele-meta';
import { creerModeleDepuisMeta, statutsDuModele, type DepsCreationModele } from '../api/creer-modele';
import type { TemplateSummary } from '../meta/templates';

/**
 * LES MODÈLES DEPUIS CLAUDE (lot 13, domaine 3, spec § 5) : créer un modèle au format de Meta, suivre sa validation,
 * lister ceux de l'espace. Les MÊMES fonctions que `POST /v1/templates` et `GET /v1/templates/{name}`
 * (`src/api/creer-modele.ts`), elles-mêmes passées par la création de l'écran Modèles : aucun contrôle propre ici.
 * Ouverts à toutes les offres, comme l'écran Modèles.
 */
export interface DepsModelesMcp extends DepsCreationModele {
  /** Les modèles du compte WhatsApp de l'espace, la MÊME lecture (en cache une minute) que le catalogue `/v1/templates`. */
  lister(tenantId: string): Promise<TemplateSummary[]>;
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
];
