/**
 * Ce qui va changer chez Meta si l'on publie, calculé AVANT de rien écrire.
 *
 * 🔴 ENGAGE ME FAIT FOI, ET LA PUBLICATION ÉCRASE (décision de Julien du 2026-09-10). Ce module existe pour
 * que « écraser » ne soit jamais une surprise : il compare ce que nous avons à ce que Meta a, et rend la
 * liste des gestes en toutes lettres. L'écran la montre, le client décide, et alors seulement on écrit.
 *
 * 🔴 DEPUIS LE 2026-09-21, META APPELLE LE RELAIS, PLUS LE SYSTÈME DU CLIENT (spec
 * docs/superpowers/specs/2026-09-21-relais-mba-design.md). Un espace a UN connecteur chez Meta, `EngageMe`,
 * dont l'adresse est notre relais et la clé une clé d'API de l'espace. Chaque outil exposé y devient un
 * appel au relais, qui retrouve le contact et fait l'appel déclaré dans Tools > Connecteurs API avec les
 * valeurs du mini-CRM. Avant, un connecteur par source partait chez Meta avec le SECRET du client, et Meta
 * ne recevait que la méthode et le chemin : un outil qui envoyait un champ du contact arrivait vide.
 *
 * 🔴 PUR : aucune IO. C'est ce qui rend la décision testable sans réseau, et c'est la moitié qui compte. La
 * moitié qui appelle Meta est mécanique ; celle-ci porte tous les arbitrages.
 *
 * ⚠️ LA RÉCONCILIATION SE FAIT SUR LE NOM, jamais sur un identifiant Meta qu'on stockerait : une table de
 * correspondance dériverait dès qu'un client supprime un connecteur dans WhatsApp Manager, et le nom est
 * précisément ce que le modèle voit. Corollaire : renommer un outil chez nous se lit « supprimer l'ancien,
 * créer le nouveau », et l'aperçu le dit.
 *
 * ⚠️ IDEMPOTENTE : publier deux fois de suite ne doit produire AUCUN geste au second passage, et c'est le
 * seul test qui prouve que la réconciliation marche.
 */

import type { VariableDeclaree } from '../agent/requetes';
import { ENTETE_CONTACT_META, cheminOutilRelais } from './relais';

/** Le nom du connecteur unique d'un espace chez Meta. Il passe `NOM_CONNECTEUR_META_RE`. */
export const NOM_CONNECTEUR_RELAIS = 'EngageMe';

/** Le relais, tel que la publication le présente à Meta. */
export interface RelaisAPublier {
  /** `PUBLIC_API_URL` suivi de `/mba/relais`. */
  baseUrl: string;
  /**
   * La clé retenue (`tenant_settings.mba_relais_cle_id`) est-elle toujours active ?
   *
   * 🔴 UN SECRET NE SE COMPARE PAS, IL SE SOUVIENT : Meta ne rend jamais la clé. Une clé révoquée par le
   * client fait modifier le connecteur, et toute modification en pose une NEUVE (`src/mba/cle-relais.ts`).
   */
  cleAJour: boolean;
}

/** Un OUTIL de chez nous, exposé au MBA, tel qu'il devient un outil du connecteur `EngageMe`. */
export interface OutilAPublier {
  id: string;
  name: string;
  description: string;
  /** La clause « quand NE PAS l'appeler », concaténée à la description envoyée à Meta. */
  nePasUtiliser: string;
  /** Les variables de la requête : seules celles d'origine `modele` partent chez Meta. */
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
   * 🔴 COMPARÉ EN ENTIER, et il ne l'était pas : la description seule d'abord, puis méthode et chemin. Une
   * variable ajoutée chez nous aurait sinon été invisible chez Meta pour toujours, avec un aperçu qui annonce
   * « rien à changer ».
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
 * La description envoyée à Meta : la nôtre, suivie de la clause « quand ne pas l'appeler ».
 *
 * 🔴 `ne_pas_utiliser` N'A PAS DE CHAMP CHEZ META, et c'est le SEUL levier qui décide quand un outil se
 * déclenche. Le laisser de côté ferait travailler le client sur un texte qui ne produirait rien, ce qui est
 * exactement ce qui s'est passé chez nous jusqu'au correctif du 2026-08-29.
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
 * Le corps d'un outil chez Meta : un appel au RELAIS, jamais au système du client.
 *
 * 🔴 L'EN-TÊTE DU NUMÉRO EST LIÉ À LA MACRO `WHATSAPP_PHONE_NUMBER` : c'est Meta qui le remplit, son modèle ne
 * peut ni le choisir ni l'inventer. C'est ce qui permet au relais de retrouver le contact sans faire
 * confiance au modèle.
 *
 * ⚠️ SEULES LES VARIABLES `modele` SONT DÉCLARÉES : les autres viennent du mini-CRM, chez nous. Meta n'a pas
 * de champ pour une liste de valeurs permises (`BodyNode` n'a ni `enum` ni équivalent) : elle s'écrit à la
 * fin de la description, et le relais la vérifie. Les types de nos variables (`string`, `number`,
 * `integer`, `boolean`) sont tous acceptés tels quels par un `BodyNode`.
 *
 * ⚠️ `user_auth_required: false` est exigé par le schéma de Meta : nous ne collectons aucun jeton par
 * utilisateur final. L'omettre ferait échouer la création.
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
 * Le plan de publication : ce qui sera créé, modifié, supprimé.
 *
 * ⚠️ L'ORDRE DES GESTES EST CELUI DE L'EXÉCUTION, et il n'est pas indifférent : un outil ne peut pas être
 * créé avant son connecteur, un connecteur ne peut pas être supprimé avant ses outils. La liste se lit de
 * haut en bas comme une recette, et l'écran l'affiche telle quelle.
 */
export function planifierPublication(relais: RelaisAPublier, outils: OutilAPublier[], meta: EtatMeta): Geste[] {
  const gestes: Geste[] = [];
  const doitExister = outils.length > 0;
  const retenu = doitExister ? meta.connecteurs.find((c) => c.name === NOM_CONNECTEUR_RELAIS) : undefined;

  // 1. Tout connecteur qui n'est pas LE relais retenu s'en va, ses outils d'abord : les anciens (un par
  //    source, qui portaient le SECRET du client chez Meta), les doublons du relais, et le relais lui-même
  //    quand plus aucun outil n'est exposé, auquel cas sa clé est oubliée avec lui.
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

  // 2. Le relais : créé, ou modifié. Toute modification porte une clé NEUVE (Meta exige `auth_config` à
  //    chaque écriture du connecteur, et nous ne gardons que l'empreinte de l'ancienne).
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
   * 🔴 UN DOUBLON CHEZ META S'EN VA (2026-09-18). Plusieurs clics sur « Envoyer » avaient créé deux fois le
   * même outil. `parNom` est une Map : un nom en double n'y garde qu'une entrée, donc on compare par
   * IDENTIFIANT, et tout exemplaire qui n'est pas celui qu'on a retenu s'en va.
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
 * Cet outil a-t-il bougé depuis la dernière publication ?
 *
 * 🔴 ON COMPARE TOUTE LA DÉFINITION QUE NOUS ENVOYONS, normalisée (clés triées, `null` = absent).
 *
 * ⚠️ LA FORME QUE META RENVOIE N'EST PAS GARANTIE (sa spec dit « roundtripped » sans le promettre) : une clé
 * non nulle qu'il ajouterait produirait un geste à CHAQUE publication. L'idempotence se vérifie donc aussi
 * sur le vrai compte, à l'essai réel. ⚠️ Une définition ABSENTE de la réponse ne vaut pas « identique » : on
 * demande la mise à jour, parce que le prix de l'inverse est un outil cassé pour toujours, en silence.
 */
function aChange(chezMeta: OutilChezMeta, attendu: CorpsOutilMeta): boolean {
  if (chezMeta.description !== attendu.description) return true;
  if (!chezMeta.request_definition) return true;
  return JSON.stringify(normaliser(chezMeta.request_definition)) !== JSON.stringify(normaliser(attendu.request_definition));
}

/**
 * L'AUTHENTIFICATION DU CONNECTEUR, TELLE QUE META LA VEUT : dans le CORPS du connecteur, sous
 * `auth_config.api_key` (mesuré le 2026-09-18 : sans elle, la création rend 400 « Invalid connector
 * request », et un changement d'`auth_type` rend « auth_config is required when changing auth_type »).
 *
 * ⚠️ Le préfixe `Bearer ` va dans le champ `prefix`, pas collé à la clé : Meta concatène lui-même.
 */
export function authConfigRelais(cle: string): {
  api_key: { headers: Array<{ field_name: string; value: string; prefix: string }> };
} {
  return { api_key: { headers: [{ field_name: 'Authorization', value: cle, prefix: 'Bearer ' }] } };
}

/**
 * Le connecteur unique de l'espace chez Meta : l'adresse du RELAIS, et la clé « Agent de Meta » dans son
 * corps.
 *
 * 🔴 `auth_config` VOYAGE AVEC LE CONNECTEUR, ET C'EST NON NÉGOCIABLE CÔTÉ META (mesuré le 2026-09-18) : une
 * création ou une modification en `API_KEY` sans lui rend 400. La clé arrive donc ici en paramètre, à chaque
 * écriture, et c'est pourquoi toute modification du connecteur pose une clé neuve (`src/mba/cle-relais.ts`).
 */
export function corpsConnecteurRelais(baseUrl: string, cle: string): {
  name: string; description: string; base_url: string; auth_type: 'API_KEY'; auth_config: ReturnType<typeof authConfigRelais>;
} {
  return {
    name: NOM_CONNECTEUR_RELAIS,
    description: 'Engage Me : les outils de cet espace, appelés avec les valeurs de son carnet de contacts.',
    base_url: baseUrl,
    auth_type: 'API_KEY',
    auth_config: authConfigRelais(cle),
  };
}

/**
 * LE NOM D'UN CONNECTEUR, TEL QUE META L'ACCEPTE VRAIMENT.
 *
 * 🔴 SA PROPRE SPEC DONNE UN EXEMPLE QUE SON SERVEUR REFUSE : un nom contenant une ESPACE ou un TIRET rend 400.
 * Mesuré un par un le 2026-09-18. Lettres, chiffres et tiret bas passent, le reste non. Depuis le relais, un
 * seul nom part chez Meta (`NOM_CONNECTEUR_RELAIS`), et un test vérifie qu'il passe.
 */
export const NOM_CONNECTEUR_META_RE = /^[A-Za-z0-9_]{1,64}$/;

export function nomPubliableChezMeta(nom: string): boolean {
  return NOM_CONNECTEUR_META_RE.test(nom);
}
