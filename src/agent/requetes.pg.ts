import type { Pool } from 'pg';
import type { MethodeConnecteur } from './http-cible';
import type { GabaritCorps, EnTete, ParametreUrl } from './requete-http';
import {
  LabelRequeteDejaPris, SourceIntrouvable,
  type CreationRequete, type PatchRequete, type RequeteConnecteur, type RequeteStore, type VariableDeclaree,
} from './requetes';

/**
 * Les requêtes de connecteur en base (migration 0105).
 *
 * ⚠️ `tenant_id` sur CHAQUE requête : le pooler est superuser, la RLS est bypassée, et le filtrage en code est
 * le SEUL contrôle. Ce qui est protégé ici n'est pas anodin : une requête désigne un système client, ses
 * chemins et ce qu'on y envoie.
 *
 * 🔴 LE JSONB EST OPAQUE, DONC RELU DÉFENSIVEMENT. Ces colonnes ont été écrites par une route, mais elles
 * survivent aux versions : un champ retiré du code laisse des lignes anciennes en base, et une lecture qui
 * suppose la forme actuelle casserait à l'exécution, sur le chemin chaud, pour une donnée écrite six mois
 * plus tôt. Les fonctions `lire*` ci-dessous ne supposent rien.
 */

const COLS = `r.id, r.tenant_id, r.source_id, r.label, r.method, r.path, r.query, r.headers,
  r.body_mode, r.body_json, r.body_champs, r.variables, r.output_paths, r.valeurs_test, r.updated_at,
  (select count(*)::int from agent_tools t where t.request_id = r.id) as outils`;

interface Ligne {
  id: string; tenant_id: string; source_id: string; label: string; method: string; path: string;
  query: unknown; headers: unknown; body_mode: string; body_json: string | null; body_champs: unknown;
  variables: unknown; output_paths: string[]; valeurs_test: unknown; updated_at: Date; outils: number;
}

/** Un tableau de `{cle, valeur}` : tout ce qui n'a pas cette forme est écarté plutôt que propagé. */
function lireParametres(v: unknown): ParametreUrl[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = (x ?? {}) as { cle?: unknown; valeur?: unknown };
    return typeof o.cle === 'string' && typeof o.valeur === 'string' ? [{ cle: o.cle, valeur: o.valeur }] : [];
  });
}

function lireEnTetes(v: unknown): EnTete[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = (x ?? {}) as { nom?: unknown; valeur?: unknown };
    return typeof o.nom === 'string' && typeof o.valeur === 'string' ? [{ nom: o.nom, valeur: o.valeur }] : [];
  });
}

/**
 * Le gabarit de corps, reconstruit depuis les trois colonnes qui le portent.
 *
 * Un `body_mode` inconnu retombe sur « aucun corps » : c'est le repli SÛR. Envoyer un corps qu'on ne sait pas
 * interpréter serait pire que ne pas en envoyer, et la contrainte `check` de la table empêche de toute façon
 * qu'une valeur inconnue y entre par la route.
 */
function lireCorps(mode: string, brut: string | null, champs: unknown): GabaritCorps {
  if (mode === 'json') return { mode: 'json', gabarit: brut ?? '' };
  if (mode === 'champs') return { mode: 'champs', champs: lireParametres(champs) };
  return { mode: 'aucun' };
}

/**
 * Les variables déclarées. Une entrée dont l'ORIGINE est illisible est écartée : mieux vaut une variable
 * manquante, qui refuse l'appel en le disant, qu'une variable dont on aurait deviné l'origine et qui
 * enverrait au système du client une valeur venue d'ailleurs que ce que le client avait réglé.
 */
function lireVariables(v: unknown): VariableDeclaree[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = (x ?? {}) as Partial<VariableDeclaree> & { origine?: { type?: unknown } };
    if (typeof o.nom !== 'string' || o.nom === '') return [];
    if (typeof o.type !== 'string') return [];
    const t = o.origine?.type;
    if (t !== 'modele' && t !== 'contact' && t !== 'champ' && t !== 'systeme' && t !== 'fixe') return [];
    return [o as VariableDeclaree];
  });
}

function lireValeursTest(v: unknown): Record<string, string | number | boolean> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val;
  }
  return out;
}

function versVue(r: Ligne): RequeteConnecteur {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    sourceId: r.source_id,
    label: r.label,
    methode: r.method as MethodeConnecteur,
    chemin: r.path,
    parametres: lireParametres(r.query),
    entetes: lireEnTetes(r.headers),
    corps: lireCorps(r.body_mode, r.body_json, r.body_champs),
    variables: lireVariables(r.variables),
    outputPaths: r.output_paths,
    valeursTest: lireValeursTest(r.valeurs_test),
    outils: r.outils,
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Traduit les violations de contrainte en erreurs TYPÉES : la route rend 409 ou 400, jamais 500. Un 500
 *  afficherait la page d'erreur de Cloudflare à la place du message, cf. CLAUDE.md. */
function traduire(label: string) {
  return (err: unknown): never => {
    const code = (err as { code?: string })?.code;
    if (code === '23505') throw new LabelRequeteDejaPris(label);
    // 23503 = clé étrangère : la seule qui puisse échouer ici est `source_id`.
    if (code === '23503') throw new SourceIntrouvable();
    throw err;
  };
}

/** Les trois colonnes du corps, dérivées du gabarit. UN seul endroit : l'écriture et la relecture doivent
 *  parler de la même chose, et deux conversions tenues séparément finiraient par diverger. */
function corpsEnColonnes(c: GabaritCorps): { mode: string; json: string | null; champs: unknown } {
  if (c.mode === 'json') return { mode: 'json', json: c.gabarit, champs: [] };
  if (c.mode === 'champs') return { mode: 'champs', json: null, champs: c.champs };
  return { mode: 'aucun', json: null, champs: [] };
}

export class PgRequeteStore implements RequeteStore {
  constructor(private readonly pool: Pool) {}

  async lister(tenantId: string): Promise<RequeteConnecteur[]> {
    const res = await this.pool.query<Ligne>(
      `select ${COLS} from connector_requests r where r.tenant_id = $1 order by lower(r.label)`,
      [tenantId],
    );
    return res.rows.map(versVue);
  }

  async parId(tenantId: string, id: string): Promise<RequeteConnecteur | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLS} from connector_requests r where r.tenant_id = $1 and r.id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ? versVue(res.rows[0]) : null;
  }

  async creer(tenantId: string, input: CreationRequete): Promise<RequeteConnecteur> {
    const c = corpsEnColonnes(input.corps);
    // ⚠️ La SOURCE est vérifiée dans la même requête (`select ... where tenant_id`), pas par un aller-retour
    // préalable : entre une vérification et une insertion, la source peut être supprimée. Ici la sous-requête
    // et l'insertion sont un seul énoncé, donc la fenêtre n'existe pas.
    const res = await this.pool.query<{ id: string }>(
      `insert into connector_requests
         (tenant_id, source_id, label, method, path, query, headers, body_mode, body_json, body_champs,
          variables, output_paths, valeurs_test)
       select $1,
              (select s.id from agent_tool_sources s where s.id = $2 and s.tenant_id = $1),
              $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12::text[], $13::jsonb
       returning id`,
      [
        tenantId, input.sourceId, input.label, input.methode, input.chemin,
        JSON.stringify(input.parametres), JSON.stringify(input.entetes),
        c.mode, c.json, JSON.stringify(c.champs),
        JSON.stringify(input.variables), input.outputPaths, JSON.stringify(input.valeursTest),
      ],
    ).catch(traduire(input.label));
    // La sous-requête rend `null` si la source n'est pas de cet espace : la contrainte `not null` lève alors
    // un 23502, que `traduire` ne connaît pas. On le devance par un message clair.
    const id = res.rows[0]?.id;
    if (!id) throw new SourceIntrouvable();
    return (await this.parId(tenantId, id))!;
  }

  async patch(tenantId: string, id: string, patch: PatchRequete): Promise<RequeteConnecteur | null> {
    const courant = await this.parId(tenantId, id);
    if (!courant) return null;
    // Fusion AVANT écriture : `patch ?? courant`. Une garde calculée sur le corps de la requête ne verrait
    // que ce qui change, jamais l'état effectif après écriture (règle du CLAUDE.md, garde anti-boucle).
    const fusion: CreationRequete = {
      sourceId: patch.sourceId ?? courant.sourceId,
      label: patch.label ?? courant.label,
      methode: patch.methode ?? courant.methode,
      chemin: patch.chemin ?? courant.chemin,
      parametres: patch.parametres ?? courant.parametres,
      entetes: patch.entetes ?? courant.entetes,
      corps: patch.corps ?? courant.corps,
      variables: patch.variables ?? courant.variables,
      outputPaths: patch.outputPaths ?? courant.outputPaths,
      valeursTest: patch.valeursTest ?? courant.valeursTest,
    };
    const c = corpsEnColonnes(fusion.corps);
    const res = await this.pool.query(
      `update connector_requests set
         source_id = (select s.id from agent_tool_sources s where s.id = $3 and s.tenant_id = $1),
         label = $4, method = $5, path = $6, query = $7::jsonb, headers = $8::jsonb,
         body_mode = $9, body_json = $10, body_champs = $11::jsonb, variables = $12::jsonb,
         output_paths = $13::text[], valeurs_test = $14::jsonb, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [
        tenantId, id, fusion.sourceId, fusion.label, fusion.methode, fusion.chemin,
        JSON.stringify(fusion.parametres), JSON.stringify(fusion.entetes),
        c.mode, c.json, JSON.stringify(c.champs),
        JSON.stringify(fusion.variables), fusion.outputPaths, JSON.stringify(fusion.valeursTest),
      ],
    ).catch(traduire(fusion.label));
    if (res.rowCount === 0) return null;
    return this.parId(tenantId, id);
  }

  async supprimer(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query('delete from connector_requests where tenant_id = $1 and id = $2', [tenantId, id]);
    return (res.rowCount ?? 0) > 0;
  }
}
