/**
 * Ce qui va changer chez Meta si l'on publie, calculé avant de rien écrire. Messaging Me fait foi et la publication
 * écrase : ce module compare ce que nous avons à ce que Meta a, et rend la liste des gestes, que le client voit
 * avant qu'on écrive.
 *
 * Meta appelle le relais, plus le système du client : un espace a un connecteur chez Meta, `EngageMe`, dont
 * l'adresse est notre relais et la clé une clé d'API de l'espace ; chaque outil exposé y devient un appel au
 * relais, qui fait l'appel déclaré avec les valeurs du mini-CRM.
 *
 * Pur : aucune IO, toute la décision se teste sans réseau. La réconciliation se fait sur le nom, jamais sur un
 * identifiant Meta stocké (qui dériverait) : renommer un outil se lit « supprimer l'ancien, créer le nouveau ».
 * Idempotente : publier deux fois de suite ne produit aucun geste au second passage.
 */

import type { VariableDeclaree } from '../agent/requetes';
import { ENTETE_CONTACT_META, cheminOutilRelais } from './relais';

/** Le nom du connecteur unique d'un espace chez Meta. Lettres, chiffres et tiret bas seulement : Meta refuse une
 *  espace ou un tiret (400), et un test le garde. */
export const NOM_CONNECTEUR_RELAIS = 'EngageMe';

/** Le relais, tel que la publication le présente à Meta. */
export interface RelaisAPublier {
  /** `PUBLIC_API_URL` suivi de `/mba/relais`. */
  baseUrl: string;
  /**
   * La clé retenue (`tenant_settings.mba_relais_cle_id`) est-elle toujours active ? Meta ne rend jamais la clé :
   * une clé révoquée par le client fait modifier le connecteur, et toute modification en pose une neuve.
   */
  cleAJour: boolean;
}

/** Un outil de chez nous, exposé au MBA, tel qu'il devient un outil du connecteur `EngageMe`. */
export interface OutilAPublier {
  id: string;
  name: string;
  description: string;
  /** La clause « quand ne pas l'appeler », concaténée à la description envoyée à Meta. */
  nePasUtiliser: string;
  /**
   * Les variables de l'appel : celles de la requête d'un connecteur, ou celle que la cible d'un geste maison
   * laisse à l'agent (`variablesPourMeta`). Seules celles d'origine `modele` partent chez Meta.
   */
  variables: VariableDeclaree[];
}

/** Ce que Meta a déjà, lu avant de comparer. */
export interface ConnecteurChezMeta {
  id: string;
  name: string;
  base_url?: string;
  auth_type?: string;
}

export interface OutilChezMeta {
  id: string;
  name: string;
  description?: string;
  /**
   * Comparé en entier : une variable ajoutée chez nous serait sinon invisible chez Meta pour toujours, avec un
   * aperçu qui annonce « rien à changer ».
   */
  request_definition?: Record<string, unknown>;
}

export type Geste =
  | { type: 'connecteur_creer'; nom: string }
  | { type: 'connecteur_modifier'; connecteurId: string; nom: string }
  /** `oublierCle` : le relais part parce que plus aucun outil n'est exposé, sa clé est révoquée avec lui. */
  | { type: 'connecteur_supprimer'; connecteurId: string; nom: string; oublierCle: boolean }
  | { type: 'outil_creer'; outilId: string; nom: string }
  | { type: 'outil_modifier'; outilMetaId: string; outilId: string; nom: string }
  | { type: 'outil_supprimer'; connecteurId: string; outilMetaId: string; nom: string };

export interface EtatMeta {
  connecteurs: ConnecteurChezMeta[];
  /** Les outils de Meta, par identifiant de connecteur. */
  outilsParConnecteur: Record<string, OutilChezMeta[]>;
}

/**
 * La description envoyée à Meta : la nôtre, suivie de la clause « quand ne pas l'appeler ». `ne_pas_utiliser`
 * n'a pas de champ chez Meta, et c'est le seul levier qui décide quand un outil se déclenche.
 */
export function descriptionPourMeta(o: { description: string; nePasUtiliser: string }): string {
  const clause = o.nePasUtiliser.trim();
  return clause === '' ? o.description : `${o.description}\n\nNe pas l'utiliser : ${clause}`;
}

/** Le corps d'un outil chez Meta. */
export interface CorpsOutilMeta {
  name: string;
  description: string;
  request_definition: Record<string, unknown>;
  user_auth_required: false;
}

/**
 * Le corps d'un outil chez Meta : un appel au relais, jamais au système du client.
 * 🔴 L'en-tête du numéro est lié à la macro `WHATSAPP_PHONE_NUMBER`, remplie par Meta : son modèle ne peut ni le
 * choisir ni l'inventer, et le relais retrouve le contact sans lui faire confiance.
 * Seules les variables `modele` sont déclarées (les autres viennent du mini-CRM). Meta n'a pas de champ pour une
 * liste de valeurs permises : elle s'écrit à la fin de la description, et le relais la vérifie.
 * `user_auth_required: false` est exigé par le schéma de Meta ; l'omettre fait échouer la création.
 */
export function corpsOutilMeta(o: OutilAPublier): CorpsOutilMeta {
  const modele = o.variables.filter((v) => v.origine.type === 'modele');
  const params: Record<string, { type: string; description: string }> = {};
  for (const v of modele) {
    const base = (v.description ?? '').trim() || v.nom;
    const permises = v.enum && v.enum.length > 0 ? ` Valeurs possibles : ${v.enum.join(', ')}.` : '';
    params[v.nom] = { type: v.type, description: `${base}${permises}` };
  }
  const requises = modele.filter((v) => v.requis === true).map((v) => v.nom);
  return {
    name: o.name,
    description: descriptionPourMeta(o),
    request_definition: {
      method: 'POST',
      path: cheminOutilRelais(o.id),
      headers: {
        [ENTETE_CONTACT_META]: {
          type: 'string',
          description: 'Le numéro WhatsApp du client, rempli par WhatsApp.',
          binding: { kind: 'macro', macro: 'WHATSAPP_PHONE_NUMBER' },
        },
      },
      ...(modele.length > 0
        ? { body: { content_type: 'application/json', params, ...(requises.length > 0 ? { required: requises } : {}) } }
        : {}),
    },
    user_auth_required: false,
  };
}

/**
 * Le plan de publication : ce qui sera créé, modifié, supprimé, dans l'ordre d'exécution (un outil ne se crée
 * pas avant son connecteur, un connecteur ne se supprime pas avant ses outils). L'écran l'affiche tel quel.
 */
export function planifierPublication(relais: RelaisAPublier, outils: OutilAPublier[], meta: EtatMeta): Geste[] {
  const gestes: Geste[] = [];
  const doitExister = outils.length > 0;
  const retenu = doitExister ? meta.connecteurs.find((c) => c.name === NOM_CONNECTEUR_RELAIS) : undefined;

  // 1. Tout connecteur qui n'est pas le relais retenu s'en va, ses outils d'abord : les anciens (qui portaient
  //    le secret du client chez Meta), les doublons, et le relais lui-même quand plus aucun outil n'est exposé,
  //    sa clé étant alors oubliée avec lui.
  for (const c of meta.connecteurs) {
    if (retenu && c.id === retenu.id) continue;
    for (const o of meta.outilsParConnecteur[c.id] ?? []) {
      gestes.push({ type: 'outil_supprimer', connecteurId: c.id, outilMetaId: o.id, nom: o.name });
    }
    gestes.push({
      type: 'connecteur_supprimer', connecteurId: c.id, nom: c.name,
      oublierCle: c.name === NOM_CONNECTEUR_RELAIS && !doitExister,
    });
  }
  if (!doitExister) return gestes;

  // 2. Le relais : créé, ou modifié. Toute modification porte une clé neuve (Meta exige `auth_config` à chaque
  //    écriture, et nous ne gardons que l'empreinte de l'ancienne).
  if (!retenu) {
    gestes.push({ type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS });
  } else if (retenu.base_url !== relais.baseUrl || retenu.auth_type !== 'API_KEY' || !relais.cleAJour) {
    gestes.push({ type: 'connecteur_modifier', connecteurId: retenu.id, nom: NOM_CONNECTEUR_RELAIS });
  }

  // 3. Les outils du relais.
  const dejaLa = retenu ? (meta.outilsParConnecteur[retenu.id] ?? []) : [];
  const parNom = new Map(dejaLa.map((o) => [o.name, o]));
  for (const o of outils) {
    const existant = parNom.get(o.name);
    if (!existant) gestes.push({ type: 'outil_creer', outilId: o.id, nom: o.name });
    else if (aChange(existant, corpsOutilMeta(o))) {
      gestes.push({ type: 'outil_modifier', outilMetaId: existant.id, outilId: o.id, nom: o.name });
    }
  }
  /**
   * Un doublon chez Meta s'en va. `parNom` est une Map, qui ne garde qu'une entrée par nom : on compare donc par
   * identifiant, et tout exemplaire autre que celui retenu est supprimé.
   */
  const nosNoms = new Set(outils.map((o) => o.name));
  for (const o of dejaLa) {
    if (!nosNoms.has(o.name) || parNom.get(o.name)?.id !== o.id) {
      gestes.push({ type: 'outil_supprimer', connecteurId: retenu!.id, outilMetaId: o.id, nom: o.name });
    }
  }
  return gestes;
}

/** Une valeur ramenée à ses seules clés non nulles, triées : deux formes équivalentes deviennent égales. */
function normaliser(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normaliser);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== null && x !== undefined) out[k] = normaliser(x);
    }
    return out;
  }
  return v;
}

/**
 * Cet outil a-t-il bougé depuis la dernière publication ? On compare toute la définition envoyée, normalisée
 * (clés triées, `null` = absent). La forme que Meta renvoie n'est pas garantie : une clé qu'il ajouterait
 * produirait un geste à chaque publication, d'où une vérification sur le vrai compte. Une définition absente
 * de la réponse ne vaut pas « identique » : on met à jour, plutôt que de laisser un outil cassé en silence.
 */
function aChange(chezMeta: OutilChezMeta, attendu: CorpsOutilMeta): boolean {
  if (chezMeta.description !== attendu.description) return true;
  if (!chezMeta.request_definition) return true;
  return JSON.stringify(normaliser(chezMeta.request_definition)) !== JSON.stringify(normaliser(attendu.request_definition));
}

/**
 * L'authentification du connecteur, telle que Meta la veut : dans le corps du connecteur, sous
 * `auth_config.api_key` (sans elle, la création rend 400 « Invalid connector request »). Le préfixe `Bearer ` va
 * dans le champ `prefix`, pas collé à la clé : Meta concatène lui-même.
 */
export function authConfigRelais(cle: string): {
  api_key: { headers: Array<{ field_name: string; value: string; prefix: string }> };
} {
  return { api_key: { headers: [{ field_name: 'Authorization', value: cle, prefix: 'Bearer ' }] } };
}

/**
 * Le connecteur unique de l'espace chez Meta : l'adresse du relais, et la clé « Agent de Meta » dans son corps.
 * `auth_config` voyage avec le connecteur, exigé par Meta en `API_KEY` à chaque création ou modification (400
 * sinon) : c'est pourquoi toute modification pose une clé neuve (`src/mba/cle-relais.ts`).
 */
export function corpsConnecteurRelais(baseUrl: string, cle: string): {
  name: string; description: string; base_url: string; auth_type: 'API_KEY'; auth_config: ReturnType<typeof authConfigRelais>;
} {
  return {
    name: NOM_CONNECTEUR_RELAIS,
    description: 'Messaging Me : les outils de cet espace, appelés avec les valeurs de son carnet de contacts.',
    base_url: baseUrl,
    auth_type: 'API_KEY',
    auth_config: authConfigRelais(cle),
  };
}
