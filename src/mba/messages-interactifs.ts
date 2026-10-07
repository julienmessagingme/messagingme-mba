import { z } from 'zod';

/**
 * LES MESSAGES INTERACTIFS DE L'AGENT DE META (ses « UI Skills », renommées « interactive messages » par Meta le
 * 2026-09-10) : un composant WhatsApp (boutons, liste, lien, formulaire, carrousel...) que l'agent compose lui-même
 * dans sa réponse, et dont la consigne dit QUAND il part et QUOI y mettre. Spec :
 * `docs/superpowers/specs/2026-10-07-messages-interactifs-design.md`.
 *
 * Module pur : la validation qu'appliquent la route et l'assistant AVANT d'appeler Meta, et la lecture de ce que Meta
 * rend. Les règles viennent de la mesure du 2026-10-07 sur le numéro de test (`docs/MBA-API-REFERENCE.md`, relevé du
 * 2026-10-07), pas seulement de la doc.
 */

/** Les neuf types, dans l'ordre de la grille de la console. Une seule liste, que la console recopie (`web/lib`). */
export const TYPES_MESSAGE_INTERACTIF = [
  'interactive_reply_buttons',
  'interactive_list',
  'cta_url',
  'flow',
  'image',
  'location',
  'location_request',
  'carousel_url',
  'carousel_quick_reply',
] as const;
export type TypeMessageInteractif = (typeof TYPES_MESSAGE_INTERACTIF)[number];

/**
 * 🔴 LES BORNES SE COMPTENT EN OCTETS UTF-8, COMME META LES COMPTE. Mesuré le 2026-10-07 : une consigne de 20 000
 * caractères dont 10 accentués est refusée comme « 20010 ». Compter en `.length` laisserait passer, en français, une
 * consigne que Meta refuse.
 */
export const TITRE_MAX = 64;
export const CONSIGNE_MAX = 20_000;
export const octets = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * 🔴 LE TITRE EST UN SLUG, comme celui d'une consigne (`TITRE_SKILL_RE`, `src/http/mba.ts`, que
 * `tests/mba-messages-interactifs.test.ts` garde identique) : minuscules, chiffres et tirets, sans tiret au début ni
 * à la fin. Mesuré le 2026-10-07 : Meta refuse en 400 tout autre titre (« title must contain only lowercase letters,
 * numbers, and hyphens »), et le compte en octets (40 « é » comptent 71).
 */
export const TITRE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Un identifiant Meta (`pfbid…`) tel qu'on le remet dans un chemin : rien qui puisse le faire sortir du sien. */
export const ID_MESSAGE_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** Un message interactif tel que la console et l'assistant le manipulent. */
export interface MessageInteractif {
  id: string;
  titre: string;
  type: TypeMessageInteractif;
  actif: boolean;
  consigne: string;
  /** L'identifiant Meta du formulaire, pour le seul type `flow`. Toujours une chaîne (voir `messageMeta`). */
  formulaireId: string | null;
  /** Secondes Unix, telles que Meta les rend. */
  creeLe: number;
  modifieLe: number;
}

export function estTypeMessageInteractif(v: unknown): v is TypeMessageInteractif {
  return typeof v === 'string' && (TYPES_MESSAGE_INTERACTIF as readonly string[]).includes(v);
}

type Verdict<T> = { ok: true; valeur: T } | { ok: false; erreur: string };

function texteBorne(v: unknown, nom: string, max: number): Verdict<string> {
  if (typeof v !== 'string' || v.trim() === '') return { ok: false, erreur: `${nom} requis` };
  const t = v.trim();
  if (octets(t) > max) return { ok: false, erreur: `${nom} trop long (${max} octets au plus, un caractère accentué en compte deux)` };
  return { ok: true, valeur: t };
}

export interface CreationMessageInteractif {
  titre: string;
  type: TypeMessageInteractif;
  consigne: string;
  formulaireId: string | null;
}

/**
 * Ce qu'une création doit porter. `formulaireId` est requis pour `flow` et refusé pour tout autre type : Meta refuse
 * les deux cas en 400 (mesuré), autant le dire avant l'appel. L'appartenance du formulaire à l'espace et sa
 * publication se vérifient en base, à côté (la route et l'assistant), pas ici.
 */
/** Le titre ramené en minuscules (comme une consigne), puis borné et contrôlé en slug. */
function titreValide(v: unknown): Verdict<string> {
  const t = texteBorne(typeof v === 'string' ? v.toLowerCase() : v, 'titre', TITRE_MAX);
  if (!t.ok) return t;
  if (!TITRE_RE.test(t.valeur)) return { ok: false, erreur: 'titre invalide : minuscules, chiffres et tirets seulement, ex. « boutons-rdv »' };
  return t;
}

export function validerCreation(e: { titre?: unknown; type?: unknown; consigne?: unknown; formulaireId?: unknown }): Verdict<CreationMessageInteractif> {
  if (!estTypeMessageInteractif(e.type)) return { ok: false, erreur: `type inconnu (attendu : ${TYPES_MESSAGE_INTERACTIF.join(', ')})` };
  const titre = titreValide(e.titre);
  if (!titre.ok) return titre;
  const consigne = texteBorne(e.consigne, 'consigne', CONSIGNE_MAX);
  if (!consigne.ok) return consigne;
  const formulaire = e.formulaireId === undefined || e.formulaireId === null ? null : e.formulaireId;
  if (e.type === 'flow') {
    if (typeof formulaire !== 'string' || !/^\d{1,20}$/.test(formulaire)) return { ok: false, erreur: 'un formulaire est requis pour un message de type formulaire' };
    return { ok: true, valeur: { titre: titre.valeur, type: e.type, consigne: consigne.valeur, formulaireId: formulaire } };
  }
  if (formulaire !== null) return { ok: false, erreur: 'un formulaire ne se joint qu’à un message de type formulaire' };
  return { ok: true, valeur: { titre: titre.valeur, type: e.type, consigne: consigne.valeur, formulaireId: null } };
}

export interface ModificationMessageInteractif {
  titre?: string;
  consigne?: string;
  actif?: boolean;
}

/**
 * Ce qu'une modification peut porter : le titre, la consigne, l'état. 🔴 Jamais le type ni le formulaire : Meta rend
 * 200 à un `PUT` qui change le type et l'IGNORE en silence (mesuré le 2026-10-07). Les accepter ici ferait croire à
 * l'écran que le changement a pris. Un champ inconnu est refusé pour la même raison.
 */
export function validerModification(e: Record<string, unknown>): Verdict<ModificationMessageInteractif> {
  for (const cle of Object.keys(e)) {
    if (cle === 'type' || cle === 'formulaireId') return { ok: false, erreur: 'le type et le formulaire ne se changent pas : supprimez ce message et recréez-le' };
    if (cle !== 'titre' && cle !== 'consigne' && cle !== 'actif') return { ok: false, erreur: `champ inconnu : ${cle}` };
  }
  const v: ModificationMessageInteractif = {};
  if (e.titre !== undefined) {
    const t = titreValide(e.titre);
    if (!t.ok) return t;
    v.titre = t.valeur;
  }
  if (e.consigne !== undefined) {
    const c = texteBorne(e.consigne, 'consigne', CONSIGNE_MAX);
    if (!c.ok) return c;
    v.consigne = c.valeur;
  }
  if (e.actif !== undefined) {
    if (typeof e.actif !== 'boolean') return { ok: false, erreur: 'actif attendu en booléen' };
    v.actif = e.actif;
  }
  if (Object.keys(v).length === 0) return { ok: false, erreur: 'rien à modifier' };
  return { ok: true, valeur: v };
}

/**
 * Un message interactif tel que Meta le rend. `flow_id` part en chaîne (accepté, mesuré) et revient en NOMBRE : on le
 * relit en chaîne, et un nombre au-delà de 2^53 serait déjà faux à la lecture du JSON, d'où le refus explicite plutôt
 * qu'un identifiant arrondi en silence.
 */
const messageMeta = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  component_type: z.enum(TYPES_MESSAGE_INTERACTIF),
  status: z.enum(['enabled', 'disabled']),
  instruction: z.string(),
  // `nullish` et pas `optional` : aucune réponse d'ÉCRITURE n'a été relevée, et un `null` ne doit pas faire croire à
  // un échec quand Meta a déjà écrit (relecture de la livraison A).
  flow_id: z.union([z.string(), z.number().refine(Number.isSafeInteger, 'flow_id hors des entiers sûrs')]).transform(String).nullish(),
  created_at: z.number().nullish(),
  updated_at: z.number().nullish(),
});

/** Lit un message interactif rendu par Meta, ou `null` s'il n'a pas la forme attendue. */
export function depuisMeta(brut: unknown): MessageInteractif | null {
  const lu = messageMeta.safeParse(brut);
  if (!lu.success) return null;
  const m = lu.data;
  return {
    id: m.id,
    titre: m.title,
    type: m.component_type,
    actif: m.status === 'enabled',
    consigne: m.instruction,
    formulaireId: m.flow_id ?? null,
    creeLe: m.created_at ?? 0,
    modifieLe: m.updated_at ?? 0,
  };
}

/** Le corps de création attendu par Meta. Créé actif : un formulaire n'arrive ici que publié (vérifié avant). */
export function versMetaCreation(c: CreationMessageInteractif): Record<string, unknown> {
  return {
    title: c.titre,
    component_type: c.type,
    status: 'enabled',
    instruction: c.consigne,
    ...(c.formulaireId !== null ? { flow_id: c.formulaireId } : {}),
  };
}

/** Le corps de modification : seulement ce qui change, et jamais `component_type` ni `flow_id`. */
export function versMetaModification(m: ModificationMessageInteractif): Record<string, unknown> {
  return {
    ...(m.titre !== undefined ? { title: m.titre } : {}),
    ...(m.consigne !== undefined ? { instruction: m.consigne } : {}),
    ...(m.actif !== undefined ? { status: m.actif ? 'enabled' : 'disabled' } : {}),
  };
}

/** Une page de la liste : les éléments et le curseur suivant, ou `null` à la dernière page. */
const pageMeta = z.object({
  data: z.array(z.unknown()),
  paging: z.object({ cursors: z.object({ after: z.string().optional() }).partial().optional() }).partial().optional(),
});

/**
 * 🔴 LA PAGINATION SUIT `paging.cursors.after` TANT QU'IL EST PRÉSENT : Meta ne rend jamais `next` (mesuré le
 * 2026-10-07), contrairement à ce que sa référence suggère, et la dernière page ne porte que `before`.
 */
export function lirePage(brut: unknown): { elements: unknown[]; apres: string | null } | null {
  const lu = pageMeta.safeParse(brut);
  if (!lu.success) return null;
  const apres = lu.data.paging?.cursors?.after;
  return { elements: lu.data.data, apres: typeof apres === 'string' && apres !== '' ? apres : null };
}

/** Au-delà, la liste est tronquée : cent messages interactifs sur un numéro n'ont plus rien de raisonnable. */
export const PAGES_MAX = 10;

/**
 * Les titres des messages interactifs de l'agent de Meta de l'espace qui ouvrent ce formulaire : la suppression d'un
 * formulaire les refuse (`DELETE /tenants/:tenantId/flows/:flowId`), sans quoi l'agent enverrait un formulaire retiré.
 *
 * ⚠️ Un espace SANS agent de Meta ne doit jamais être bloqué : pas de numéro, des réglages absents chez Meta, ou un
 * refus 4xx de Meta sur les réglages (numéro jamais embarqué, droit manquant) valent « aucun message ». Une vraie
 * panne (5xx, réseau) lève : la route refuse alors de supprimer à l'aveugle.
 */
export async function messagesInteractifsDuFormulaire(
  deps: {
    numero(tenantId: string): Promise<string | null>;
    client(tenantId: string): Promise<{
      getSettings(phoneNumberId: string): Promise<unknown>;
      listMessagesInteractifs(phoneNumberId: string): Promise<MessageInteractif[]>;
    }>;
  },
  tenantId: string,
  flowId: string,
): Promise<string[]> {
  const pn = await deps.numero(tenantId);
  if (pn === null) return [];
  const client = await deps.client(tenantId);
  try {
    const reglages = await client.getSettings(pn);
    if (reglages === null || reglages === undefined) return [];
    return (await client.listMessagesInteractifs(pn)).filter((m) => m.formulaireId === flowId).map((m) => m.titre);
  } catch (err) {
    if (estAbsenceDAgent(err)) return [];
    throw err;
  }
}

/**
 * Ce qui veut dire « ce numéro n'a pas d'agent de Meta », et rien d'autre : 400, 403 et 404. Un 408 ou un 429 est
 * passager, il LÈVE : le traiter comme une absence ouvrirait la suppression sans avoir vérifié (relecture de la
 * livraison A).
 */
function estAbsenceDAgent(err: unknown): boolean {
  const statut = (err as { httpStatus?: unknown } | null)?.httpStatus;
  return statut === 400 || statut === 403 || statut === 404;
}
