/**
 * Ce qui va changer chez Meta si l'on publie, calculé AVANT de rien écrire.
 *
 * 🔴 ENGAGE ME FAIT FOI, ET LA PUBLICATION ÉCRASE (décision de Julien du 2026-09-10). Ce module existe pour
 * que « écraser » ne soit jamais une surprise : il compare ce que nous avons à ce que Meta a, et rend la
 * liste des gestes en toutes lettres. L'écran la montre, le client décide, et alors seulement on écrit.
 *
 * 🔴 PUR : aucune IO. C'est ce qui rend la décision testable sans réseau, et c'est la moitié qui compte. La
 * moitié qui appelle Meta est mécanique ; celle-ci porte tous les arbitrages.
 *
 * ⚠️ LA RÉCONCILIATION SE FAIT SUR LE NOM, jamais sur un identifiant Meta qu'on stockerait. Deux raisons :
 * on ne veut pas d'une table de correspondance à tenir à jour (elle dériverait dès qu'un client supprime un
 * connecteur dans WhatsApp Manager), et le nom est précisément ce que le modèle voit. Corollaire : renommer
 * un outil chez nous se lit comme « supprimer l'ancien, créer le nouveau », et l'aperçu le dit.
 *
 * ⚠️ IDEMPOTENTE : publier deux fois de suite ne doit produire AUCUN geste au second passage, et c'est le
 * seul test qui prouve que la réconciliation marche.
 */

/** Une SOURCE de chez nous, telle qu'elle devient un connecteur chez Meta. */
export interface SourceAPublier {
  id: string;
  label: string;
  baseUrl: string;
  /** `none` devient `NONE`, `bearer` et `header` deviennent `API_KEY`. */
  authKind: 'none' | 'bearer' | 'header';
  /** Nom d'en-tête pour `header`. `bearer` utilise `Authorization` avec le préfixe `Bearer `. */
  authHeaderName: string | null;
  /** Le secret EXISTE-t-il ? Sa valeur ne transite pas par ce module. */
  aAuthentification: boolean;
  /**
   * Le secret ACTUEL a-t-il déjà été posé chez Meta ?
   *
   * 🔴 C'EST LE SEUL MOYEN DE FAIRE TOURNER UN SECRET, et il manquait. Meta ne rend jamais le sien : on ne
   * peut pas comparer, seulement se souvenir de ce qu'on a posé. Le drapeau retombe à `false` dès qu'on
   * touche à l'authentification de la source, et la publication suivante repose le secret.
   */
  secretPublie: boolean;
}

/** Un OUTIL de chez nous, exposé au MBA, tel qu'il devient un tool de connecteur. */
export interface OutilAPublier {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  /** La clause « quand NE PAS l'appeler », concaténée à la description envoyée à Meta. */
  nePasUtiliser: string;
  methode: string;
  chemin: string;
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
   * 🔴 COMPARÉ, ET IL NE L'ÉTAIT PAS. Le plan ne regardait que la `description` : changer la MÉTHODE ou le
   * CHEMIN d'une requête chez nous ne produisait AUCUN geste, et l'agent de Meta continuait d'appeler
   * l'ancienne adresse indéfiniment. Le symptôme aurait été un outil qui « ne marche plus » sans qu'aucun
   * écran ne montre d'écart, puisque l'aperçu aurait dit « rien à changer ».
   */
  request_definition?: { method?: string; path?: string };
}

export type Geste =
  | { type: 'connecteur_creer'; sourceId: string; nom: string }
  | { type: 'connecteur_modifier'; connecteurId: string; sourceId: string; nom: string }
  | { type: 'connecteur_supprimer'; connecteurId: string; nom: string }
  | { type: 'secret_poser'; sourceId: string; nom: string }
  | { type: 'outil_creer'; sourceId: string; outilId: string; nom: string }
  | { type: 'outil_modifier'; sourceId: string; outilMetaId: string; outilId: string; nom: string }
  | { type: 'outil_supprimer'; sourceId: string; outilMetaId: string; nom: string };

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

/**
 * Le plan de publication : ce qui sera créé, modifié, supprimé.
 *
 * ⚠️ L'ORDRE DES GESTES EST CELUI DE L'EXÉCUTION, et il n'est pas indifférent : un outil ne peut pas être
 * créé avant son connecteur, un connecteur ne peut pas être supprimé avant ses outils, et un secret ne se
 * pose pas avant que son connecteur porte le bon `auth_type`. La liste est donc lisible de haut en bas comme
 * une recette, et l'écran l'affiche telle quelle.
 */
export function planifierPublication(
  sources: SourceAPublier[],
  outils: OutilAPublier[],
  meta: EtatMeta,
): Geste[] {
  const gestes: Geste[] = [];
  const parNom = new Map(meta.connecteurs.map((c) => [c.name, c]));
  const nosNoms = new Set(sources.map((s) => s.label));

  // 1. Les connecteurs : créer ce qui manque, modifier ce qui a bougé, et poser le secret quand il n'est
  //    pas encore chez Meta (à la création, ou parce qu'on l'a changé chez nous depuis).
  for (const s of sources) {
    const chezMeta = parNom.get(s.label);
    if (!chezMeta) {
      // 🔴 LA CRÉATION PORTE SON AUTHENTIFICATION, donc plus de `secret_poser` derrière elle (2026-09-18).
      // Meta EXIGE `auth_config` dans le corps dès que `auth_type` n'est pas `NONE` : le poser après coup
      // était impossible, et c'est ce qui faisait échouer toute création de connecteur authentifié.
      gestes.push({ type: 'connecteur_creer', sourceId: s.id, nom: s.label });
      continue;
    }
    // ⚠️ ON NE COMPARE QUE CE QUE META REND, et le connecteur se met à jour AVANT son secret : le passage de
    // « aucune authentification » à `bearer` change les DEUX, et poser une clé sur un connecteur encore
    // déclaré `NONE` chez Meta est une écriture qu'il n'a aucune raison d'accepter. C'est le même ordre qu'à
    // la création (créer, puis poser le secret), et il se lit de haut en bas comme une recette.
    if (chezMeta.base_url !== s.baseUrl || chezMeta.auth_type !== authTypeMeta(s.authKind)) {
      gestes.push({ type: 'connecteur_modifier', connecteurId: chezMeta.id, sourceId: s.id, nom: s.label });
    }
    // 🔴 LE SECRET SE REPOSE QUAND IL A CHANGÉ CHEZ NOUS, jamais « au cas où ». Meta ne rend pas le sien,
    // donc on ne compare pas : on se souvient de ce qu'on a posé (`secretPublie`), et toute écriture sur
    // l'authentification de la source remet ce drapeau à zéro. Le reposer à CHAQUE publication marcherait
    // aussi, mais on perdrait le seul test qui prouve que la réconciliation fonctionne (« publier deux fois
    // ne produit aucun geste ») ; ne jamais le reposer laissait un secret périmé pour toujours, et c'était
    // le comportement d'avant le 2026-09-10.
    if (s.aAuthentification && !s.secretPublie) {
      gestes.push({ type: 'secret_poser', sourceId: s.id, nom: s.label });
    }
  }

  // 2. Les connecteurs de Meta que nous n'avons plus : ils partent, avec leurs outils.
  for (const c of meta.connecteurs) {
    if (!nosNoms.has(c.name)) {
      for (const o of meta.outilsParConnecteur[c.id] ?? []) {
        gestes.push({ type: 'outil_supprimer', sourceId: '', outilMetaId: o.id, nom: o.name });
      }
      gestes.push({ type: 'connecteur_supprimer', connecteurId: c.id, nom: c.name });
    }
  }

  // 3. Les outils, connecteur par connecteur.
  for (const s of sources) {
    const chezMeta = parNom.get(s.label);
    const dejaLa = chezMeta ? (meta.outilsParConnecteur[chezMeta.id] ?? []) : [];
    const parNomOutil = new Map(dejaLa.map((o) => [o.name, o]));
    const nosOutils = outils.filter((o) => o.sourceId === s.id);

    for (const o of nosOutils) {
      const existant = parNomOutil.get(o.name);
      if (!existant) {
        gestes.push({ type: 'outil_creer', sourceId: s.id, outilId: o.id, nom: o.name });
      } else if (aChange(existant, o)) {
        gestes.push({ type: 'outil_modifier', sourceId: s.id, outilMetaId: existant.id, outilId: o.id, nom: o.name });
      }
    }
    /**
     * 🔴 UN DOUBLON CHEZ META NE PARTAIT JAMAIS, ET C EST CE QUI L A RENDU PERMANENT (2026-09-18).
     *
     * Julien a cliqué « Envoyer » plusieurs fois, faute de retour visible pendant l'aller-retour vers Meta.
     * Chaque clic a recalculé un plan sur une photo d'AVANT et a recréé le même outil : Meta s'est retrouvé
     * avec deux `rajouter_une_etiquette` quand nous n'en avions qu'un.
     *
     * ⚠️ ET LA RÉCONCILIATION NE POUVAIT PAS L'EFFACER : `parNomOutil` est une Map, donc un nom en double
     * n'y garde qu'une entrée, et la boucle de suppression ne regardait que les noms ABSENTS de chez nous.
     * Les deux exemplaires portant un nom que nous avons, aucun n'était candidat, et l'agent de Meta voyait
     * le même outil deux fois, pour toujours. « Engage Me fait foi » veut dire que la publication CONVERGE :
     * on compare donc par IDENTIFIANT, et tout exemplaire qui n'est pas celui qu'on a retenu s'en va.
     */
    const nosNomsOutils = new Set(nosOutils.map((o) => o.name));
    for (const o of dejaLa) {
      const retenu = parNomOutil.get(o.name);
      if (!nosNomsOutils.has(o.name) || retenu?.id !== o.id) {
        gestes.push({ type: 'outil_supprimer', sourceId: s.id, outilMetaId: o.id, nom: o.name });
      }
    }
  }

  return gestes;
}

/**
 * Cet outil a-t-il bougé depuis la dernière publication ?
 *
 * 🔴 LES TROIS CHAMPS COMPTENT, et n'en comparer qu'un est la faute qui rend une publication silencieusement
 * incomplète : la DESCRIPTION (qui porte aussi la clause « ne pas utiliser », seul levier qui décide quand
 * l'outil se déclenche), la MÉTHODE et le CHEMIN (sans quoi Meta appellerait l'ancienne adresse pour
 * toujours, avec un aperçu qui annonce « rien à changer »).
 *
 * ⚠️ Un `request_definition` ABSENT de la réponse de Meta ne vaut PAS « identique » : on ne peut pas
 * comparer ce qu'on n'a pas reçu, donc on demande la mise à jour. Le prix est un geste de trop à chaque
 * publication si Meta cessait un jour de rendre ce champ ; le prix de l'inverse est un outil cassé pour
 * toujours, en silence.
 */
function aChange(chezMeta: OutilChezMeta, chezNous: OutilAPublier): boolean {
  if (chezMeta.description !== descriptionPourMeta(chezNous)) return true;
  const rd = chezMeta.request_definition;
  if (!rd) return true;
  return rd.method !== chezNous.methode || rd.path !== chezNous.chemin;
}

/**
 * Notre `authKind` traduit dans l'énumération de Meta.
 *
 * ⚠️ `bearer` ET `header` DEVIENNENT TOUS DEUX `API_KEY`, et ce n'est pas un raccourci : Meta n'a pas de
 * type « bearer », il a un mécanisme d'en-têtes où `Authorization: Bearer <secret>` est un cas particulier.
 * La différence se joue dans `upsertApiKey`, pas dans `auth_type`.
 *
 * ⚠️ La spec dit que seuls `NONE`, `API_KEY` et `OAUTH2_CLIENT_CREDENTIALS` sont réellement supportés
 * aujourd'hui : on n'émet donc jamais `BASIC` ni `CUSTOM`, même si l'énumération les accepte.
 */
export function authTypeMeta(authKind: SourceAPublier['authKind']): 'NONE' | 'API_KEY' {
  return authKind === 'none' ? 'NONE' : 'API_KEY';
}

/**
 * L'AUTHENTIFICATION D'UN CONNECTEUR, TELLE QUE META LA VEUT : dans le CORPS du connecteur, sous
 * `auth_config.api_key`.
 *
 * 🔴 ELLE NE PASSE PAS PAR `upsertApiKey`, ET C'EST LE DÉFAUT QUI BLOQUAIT TOUT (mesuré le 2026-09-18).
 * On créait le connecteur en `auth_type: API_KEY` SANS `auth_config`, puis on posait la clé après, sous une
 * enveloppe `api_key_config` inventée. Meta refusait la création en 400 « Invalid connector request », sans
 * nommer le champ. Conséquence : AUCUN connecteur authentifié n'a jamais pu être publié, seuls ceux en
 * `NONE` passaient, et le symptôme était le même pour tout le monde.
 *
 * 🔴 C'EST META QUI A FINI PAR LE DIRE, quand on a tenté de changer l'`auth_type` après coup :
 * « auth_config is required when changing auth_type ». La spec OpenAPI officielle
 * (`meta-business-agent_reference_configure_connectors_v2.0.0`) confirme la forme : `auth_config` porte
 * `api_key`, qui porte `headers` / `query_params` / `body_params`, chaque entrée étant
 * `{ field_name, value, prefix }`. Vérifié par un 201 sur le vrai compte, sonde effacée ensuite.
 *
 * ⚠️ `bearer` porte le préfixe `Bearer ` DANS le champ `prefix`, pas collé au secret : Meta concatène
 * lui-même, et coller le préfixe au secret produirait `Bearer Bearer <secret>` le jour où quelqu'un règle
 * aussi le préfixe.
 */
export function authConfigMeta(
  source: Pick<SourceAPublier, 'authKind' | 'authHeaderName'>,
  secret: string,
): { api_key: { headers: Array<{ field_name: string; value: string; prefix: string | null }> } } {
  const champ = source.authKind === 'bearer' ? 'Authorization' : (source.authHeaderName ?? 'X-API-Key');
  const prefixe = source.authKind === 'bearer' ? 'Bearer ' : null;
  return { api_key: { headers: [{ field_name: champ, value: secret, prefix: prefixe }] } };
}

/**
 * LE NOM D'UN CONNECTEUR, TEL QUE META L'ACCEPTE VRAIMENT.
 *
 * 🔴 SA PROPRE SPEC DONNE UN EXEMPLE QUE SON SERVEUR REFUSE. Le champ y est décrit comme un « display
 * name » avec `Shopify Order Management` en exemple ; un nom contenant une ESPACE rend 400, et un TIRET
 * aussi. Mesuré un par un le 2026-09-18 : `testUCHAT` 201, `sondeauth` 201, `sonde_auth` 201, `Sonde42`
 * 201, `sonde-auth` 400, `sonde auth` 400. Lettres, chiffres et tiret bas passent, le reste non.
 *
 * ⚠️ ELLE EXISTE POUR QUE L'ÉCRAN REFUSE AVANT META, pas pour réécrire le nom du client : renommer sa
 * source dans son dos ferait diverger ce qu'il lit chez nous de ce qu'il voit chez Meta, et c'est par le
 * NOM que la réconciliation retrouve un connecteur.
 */
export const NOM_CONNECTEUR_META_RE = /^[A-Za-z0-9_]{1,64}$/;

export function nomPubliableChezMeta(nom: string): boolean {
  return NOM_CONNECTEUR_META_RE.test(nom);
}
