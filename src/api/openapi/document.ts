import { z } from 'zod';
import { STATUT_PAR_CODE, type CodeApi } from '../erreurs';

/**
 * LE CONTRAT OPENAPI 3.1 DE L'API PUBLIQUE (lot 16, spec `docs/superpowers/specs/2026-10-09-openapi-sdk-design.md`).
 * Il se DÉRIVE du registre (`./registre.ts`) et des événements (`./evenements.ts`), jamais écrit à part : un contrat
 * écrit à côté du code serait un second inventaire, donc une divergence programmée. Zod 4 rend lui-même le JSON Schema
 * (`z.toJSONSchema`) : côté ENTRÉE pour ce que l'intégrateur envoie (avant les `transform` du serveur), côté SORTIE pour
 * ce qu'il reçoit.
 */

export type MethodeV1 = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type DroitV1 =
  | 'contacts:write' | 'contacts:read' | 'contacts:admin' | 'sends:create' | 'conversations:read' | 'templates:write'
  | 'webhooks:write';

/** Une route `/v1`, telle que le contrat la décrit. Les schémas sont CEUX que la route utilise, exportés par elle. */
export interface RouteOpenapi {
  readonly methode: MethodeV1;
  /** Au format OpenAPI, `{param}` (celui de l'index de la doc). */
  readonly chemin: string;
  readonly droit: DroitV1;
  /** Le regroupement de la doc (`contacts`, `messages`…), qui devient l'étiquette de l'opération. */
  readonly groupe: string;
  /** La phrase anglaise de l'index de la doc (`web/lib/api-doc-endpoints.ts`), tenue égale par un test. */
  readonly resume: string;
  readonly operationId: string;
  /** Le schéma des paramètres de chemin ; absent : chaque paramètre est une chaîne. */
  readonly parametres?: z.ZodObject;
  /** Le schéma des paramètres de requête (`?limit=…`). */
  readonly requete?: z.ZodObject;
  readonly corps?: z.ZodType;
  /** L'en-tête `Idempotency-Key` est accepté (et requis si le corps n'a pas `idempotencyKey`). */
  readonly idempotence?: boolean;
  readonly succes: {
    readonly statut: 200 | 201 | 202 | 204;
    /** `null` : aucun corps ; `'binaire'` : un fichier (le média d'un message). */
    readonly schema: z.ZodType | null | 'binaire';
  };
  /** Les codes d'erreur PROPRES à la route ; ceux des gardes communes s'ajoutent à toutes (`ERREURS_COMMUNES`). */
  readonly erreurs: readonly CodeApi[];
}

/** Un type d'événement envoyé par nos webhooks sortants. */
export interface EvenementOpenapi {
  readonly type: string;
  readonly resume: string;
  readonly donnees: z.ZodType;
  /** À qui il part, quand ce n'est pas « chaque adresse abonnée à ce type » (l'essai, la demande de réponse). */
  readonly destinataires?: string;
}

/** Les en-têtes de signature (Standard Webhooks) que porte chaque événement. */
const ENTETES_SIGNATURE: readonly Schema[] = [
  { name: 'webhook-id', in: 'header', required: true, schema: { type: 'string' }, description: 'The event id (evt_…), stable across retries.' },
  { name: 'webhook-timestamp', in: 'header', required: true, schema: { type: 'string' }, description: 'Unix time in seconds; reject a timestamp more than 5 minutes away.' },
  {
    name: 'webhook-signature', in: 'header', required: true, schema: { type: 'string' },
    description: 'v1,<base64 HMAC-SHA256 of id.timestamp.body>, keyed with the base64-decoded part of the secret after whsec_; during a rotation, two signatures separated by a space.',
  },
];

/** Les refus de la garde de clé et du plafond, possibles sur toutes les routes. */
export const ERREURS_COMMUNES: readonly CodeApi[] = ['unauthorized', 'missing_scope', 'tenant_locked', 'rate_limited', 'quota_exceeded'];

type Schema = Record<string, unknown>;

/**
 * Ce que l'intégrateur REÇOIT ne ferme jamais un objet : Zod rend `additionalProperties: false` en sortie (il retire les
 * clés inconnues), or ajouter un champ à une réponse ou à un événement n'est pas un changement cassant, et un client
 * généré qui valide strictement casserait le jour de cet ajout. Ce qu'il ENVOIE garde sa fermeture (`strictObject`).
 */
function ouvrir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ouvrir);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v)
    .filter(([cle, val]) => !(cle === 'additionalProperties' && val === false))
    .map(([cle, val]) => [cle, ouvrir(val)]));
}

/**
 * Ce que la route EXIGE se dit `required`. Zod écrit chaque `z.preprocess` comme un `pipe(transform, …)`, et une
 * transformation y passe pour facultative : en entrée, une clé `category: z.preprocess(…, z.enum(…))` sortirait non
 * requise, alors que la route refuse son absence. On la rend requise quand le schéma d'arrivée ne l'est pas lui-même.
 */
function requisMalgreLePreprocess(ctx: { zodSchema: unknown; jsonSchema: Schema }): void {
  type Interne = { _zod: { def: { type: string; shape?: Record<string, Interne>; in?: Interne; out?: Interne }; optin?: string } };
  const def = (ctx.zodSchema as Interne)._zod.def;
  if (def.type !== 'object' || def.shape === undefined) return;
  for (const [cle, s] of Object.entries(def.shape)) {
    const d = s._zod.def;
    if (d.type === 'pipe' && d.in?._zod.def.type === 'transform' && d.out?._zod.optin !== 'optional') {
      ctx.jsonSchema.required = [...new Set([...((ctx.jsonSchema.required as string[] | undefined) ?? []), cle])];
    }
  }
}

/** Le JSON Schema d'un schéma Zod, sans sa déclaration de version (le document entier est en 2020-12). */
function versJson(s: z.ZodType, io: 'input' | 'output'): Schema {
  const { $schema: _version, ...reste } = z.toJSONSchema(s, {
    io, target: 'draft-2020-12', unrepresentable: 'any', ...(io === 'input' ? { override: requisMalgreLePreprocess } : {}),
  }) as Schema;
  return io === 'output' ? ouvrir(reste) as Schema : reste;
}

/**
 * `code` n'est PAS requis : le gestionnaire d'erreurs commun de l'API (`src/server.ts`) rend `{ error }` seul sur ce
 * qu'aucune route ne refuse elle-même (un JSON illisible, un corps trop gros, un refus de Meta relancé, une erreur
 * interne). Un client généré qui l'exigerait casserait sur ces réponses-là.
 */
const SCHEMA_ERREUR: Schema = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'A human-readable message (French).' },
    code: {
      type: 'string', enum: Object.keys(STATUT_PAR_CODE),
      description: 'The stable machine-readable code. Absent only on generic failures: malformed JSON, payload too large, an upstream error from Meta, an internal error.',
    },
    upgradeUrl: { type: 'string', description: 'On 402 (plan_feature_unavailable, plan_limit_reached): the page where the plan is upgraded.' },
  },
  required: ['error'],
};

/** Les réponses d'erreur d'une opération, regroupées par statut HTTP (un statut, plusieurs codes possibles). */
function reponsesErreur(codes: readonly CodeApi[]): Record<string, Schema> {
  const parStatut = new Map<number, CodeApi[]>();
  for (const code of [...new Set([...ERREURS_COMMUNES, ...codes])]) {
    const statut = STATUT_PAR_CODE[code];
    // `null` : un motif d'écart d'un destinataire (`/v1/sends`), jamais une erreur de route.
    if (statut === null) continue;
    parStatut.set(statut, [...(parStatut.get(statut) ?? []), code]);
  }
  return Object.fromEntries([...parStatut].sort(([a], [b]) => a - b).map(([statut, cs]) => [String(statut), {
    description: `Error: ${cs.join(', ')}.${statut === 429 ? ' Wait for Retry-After (seconds) before retrying.' : ''}`,
    ...(statut === 429 ? { headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait.' } } } : {}),
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  }]));
}

/** Les paramètres de chemin et de requête d'une route. */
function parametres(r: RouteOpenapi): Schema[] {
  const out: Schema[] = [];
  const formes = r.parametres ? (versJson(r.parametres, 'input').properties as Record<string, Schema> | undefined) ?? {} : {};
  for (const [, nom] of r.chemin.matchAll(/\{(\w+)\}/g)) {
    out.push({ name: nom, in: 'path', required: true, schema: formes[nom!] ?? { type: 'string' } });
  }
  if (r.requete) {
    const q = versJson(r.requete, 'input');
    const requis = new Set((q.required as string[] | undefined) ?? []);
    for (const [nom, schema] of Object.entries((q.properties as Record<string, Schema> | undefined) ?? {})) {
      out.push({ name: nom, in: 'query', required: requis.has(nom), schema });
    }
  }
  if (r.idempotence) {
    out.push({
      name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' },
      description: 'Makes the call safe to replay: the same key returns the first result. Required unless the body has idempotencyKey.',
    });
  }
  return out;
}

function operation(r: RouteOpenapi): Schema {
  const succes = r.succes.schema === null
    ? { description: 'Success, no content.' }
    : r.succes.schema === 'binaire'
      ? { description: 'The file, served with its own content type (image, audio, video, document).', content: { '*/*': {} } }
      : { description: 'Success.', content: { 'application/json': { schema: versJson(r.succes.schema, 'output') } } };
  const params = parametres(r);
  return {
    operationId: r.operationId,
    summary: r.resume,
    tags: [r.groupe],
    // Une clé d'API (`mba_…`) dans `Authorization: Bearer`. Un jeton OAuth (`mbo_…`) ne porte que les droits du MCP, donc
    // `/v1` lui répond 403 : il n'est pas annoncé. Le droit exigé n'est pas un `scope` OpenAPI (un schéma `http` n'en porte
    // pas) : il est dit en extension et dans la description.
    security: [{ bearer: [] }],
    'x-required-scope': r.droit,
    description: `Requires the ${r.droit} scope.`,
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(r.corps ? { requestBody: { required: true, content: { 'application/json': { schema: versJson(r.corps, 'input') } } } } : {}),
    responses: { [String(r.succes.statut)]: succes, ...reponsesErreur(r.erreurs) },
  };
}

/** L'enveloppe que reçoit l'application du client : l'identifiant, le type, l'heure, l'espace, et les données. */
function enveloppe(e: EvenementOpenapi, enveloppeSchema: z.ZodType): Schema {
  const base = versJson(enveloppeSchema, 'output');
  const proprietes = { ...(base.properties as Record<string, Schema>), type: { type: 'string', const: e.type }, data: versJson(e.donnees, 'output') };
  return { ...base, properties: proprietes };
}

/** Le document entier. `base` : l'adresse publique de l'API (`PUBLIC_API_URL`), sans barre finale. */
export function construireDocument(o: {
  base: string;
  routes: readonly RouteOpenapi[];
  evenements: readonly EvenementOpenapi[];
  enveloppe: z.ZodType;
}): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const r of o.routes) (paths[r.chemin] ??= {})[r.methode.toLowerCase()] = operation(r);
  const webhooks: Record<string, Schema> = {};
  for (const e of o.evenements) {
    webhooks[e.type] = {
      post: {
        summary: e.resume,
        description: `${e.destinataires ?? 'Sent to every webhook endpoint subscribed to this type.'} Signed per Standard Webhooks.`,
        // Signé par le secret de l'adresse, jamais par une clé d'API : la sécurité de la racine ne s'applique pas.
        security: [],
        parameters: ENTETES_SIGNATURE,
        requestBody: { required: true, content: { 'application/json': { schema: enveloppe(e, o.enveloppe) } } },
        responses: { '2XX': { description: 'Acknowledged. Anything else is retried for 24 hours.' } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Messaging Me API',
      version: '1',
      description: 'The public API of Messaging Me: contacts, sends, conversations, templates and outgoing webhooks. Errors are { error, code }; code is absent only on generic failures.',
    },
    servers: [{ url: o.base }],
    security: [{ bearer: [] }],
    tags: [...new Set(o.routes.map((r) => r.groupe))].map((name) => ({ name })),
    paths,
    webhooks,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'An API key (mba_…), created in the console (Developers > API keys), in Authorization: Bearer.' },
      },
      schemas: { Error: SCHEMA_ERREUR },
    },
  };
}
