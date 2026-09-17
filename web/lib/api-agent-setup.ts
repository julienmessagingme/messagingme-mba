import { request } from './http';
import { patchAgent, type PatchAgent, type SortieAgent } from './api-agent';
import { setPolitiqueMentionIa } from './api';
import { ajouterOutil, getBibliothequeOutils, listOutils, patchOutil, rattacherOutil } from './api-agent-tools';

/**
 * La conversation de construction : elle propose, le client corrige.
 *
 * 🔴 ELLE N'ÉCRIT RIEN. La route rend une proposition et le diff qu'elle produirait ; c'est l'écran qui
 * applique, par les mêmes routes que le formulaire, avec leur verrou de version. Le jour où l'onglet
 * « Create » a disparu de l'interface d'OpenAI, des GPTs sont devenus non modifiables du jour au lendemain :
 * ici la conversation n'est jamais le seul chemin d'édition, et elle n'a aucun pouvoir que le formulaire
 * n'ait déjà.
 */

export interface TourConstruction {
  role: 'user' | 'assistant';
  content: string;
}

/** Ce que l'assistant propose d'écrire. Les clés de sécurité en sont ABSENTES, par construction. */
export interface PropositionConstruction {
  /** QUAND l'agent annonce qu'il est une IA. Absent = l'assistant n'en propose pas de changement. */
  mentionIaFrequence?: 'jamais' | 'session' | 'chaque_message';
  /** Combien de minutes l'agent attend une réponse avant de lâcher. Même nature que le champ ci-dessus :
   *  un réglage hors fiche que l'entretien demande depuis le 2026-09-11. */
  inactiviteMinutes?: number;
  fiche: {
    nom?: string;
    objectif?: string;
    ton?: string;
    personnalite?: string;
    reglesTransfert?: string;
    sorties?: SortieAgent[];
  };
  outils: Array<{ handler: string; description: string; nePasUtiliser: string }>;
  /** Les MOTS de connecteurs DÉJÀ déclarés. L'assistant n'en crée jamais : voir l'application ci-dessous. */
  connecteurs?: Array<{ nom: string; description: string; nePasUtiliser: string }>;
  /**
   * Les outils de la BIBLIOTHÈQUE de l'espace à brancher ou débrancher sur cet agent, par leur NOM.
   *
   * 🔴 BRANCHER N'ACTIVE PAS. Rattacher rend l'outil disponible ; l'exposer au modèle reste un second geste,
   * fait par le client dans l'onglet Outils. Les fondre exposerait au modèle un outil dont personne n'a relu
   * les mots.
   */
  outilsBranches?: string[];
  outilsDebranches?: string[];
}

/**
 * L'avancement de l'entretien, tel que le SERVEUR le calcule.
 *
 * `total` est celui de l'ordre du jour EFFECTIF, pas de la liste complète : un agent qui n'appellera jamais
 * d'outil n'a pas de point « quel outil », et l'écran ne doit pas annoncer une étape qui n'existera jamais.
 */
export interface Couverture {
  manquants: string[];
  total: number;
  /** Le point sur lequel porte la question en cours. `null` = l'entretien est fini. */
  pointOuvert?: string | null;
}

/** Une ligne du diff, telle que l'écran la montre. */
export interface Changement {
  champ: string;
  label: string;
  avant: string;
  apres: string;
}

export interface ReponseConstruction {
  message: string;
  proposition: PropositionConstruction;
  changements: Changement[];
  /** Les points de l'ordre du jour encore à couvrir. Non vide = l'assistant est ENCORE EN ENTRETIEN, et le
   *  serveur a volontairement retenu le diff : on discute avant d'afficher ce qu'il a compris. */
  couverture?: Couverture;
  usage: { tokensIn: number; tokensOut: number };
}

/**
 * Ce que le client GARDE, ligne par ligne : la clé technique du changement, et le texte retenu.
 *
 * 🔴 POURQUOI CE N'EST PAS UN SIMPLE FILTRE. Julien, 2026-08-28 : « il n'y a qu'un seul bouton Garder ou
 * Jeter à la fin, alors que potentiellement le mec ne veut en changer qu'une et le reste lui convient ».
 * Jeter une ligne ne veut PAS dire ne rien envoyer pour ce champ : les deux textes d'un outil partent dans le
 * même `PATCH`, et omettre celui qu'on a jeté le laisserait prendre la valeur proposée. Une ligne jetée
 * réécrit donc la valeur ACTUELLE (`avant`), ce qui la rend sans effet.
 */
export type LignesGardees = ReadonlyMap<string, string>;

/**
 * Réduit une proposition aux seules lignes gardées, avec le texte éventuellement corrigé par le client.
 *
 * ⚠️ `fiche.sorties` se garde ou se jette, mais ne se modifie pas ici : cette ligne est un TEXTE composé de
 * plusieurs règles d'arrêt (`code : libellé`), et le relire pour reconstruire la liste ferait dépendre un
 * enregistrement d'un format que le client peut casser en tapant. Les régler une par une est le travail de
 * l'onglet Objectif, qui a les bons champs.
 */
export function restreindreProposition(
  proposition: PropositionConstruction,
  changements: Changement[],
  gardees: LignesGardees,
): PropositionConstruction {
  const avantDe = new Map(changements.map((c) => [c.champ, c.avant]));
  // Le texte à envoyer pour une ligne : celui que le client a gardé (corrigé ou non), sinon la valeur
  // ACTUELLE quand il l'a jetée, sinon la proposition (le champ n'était pas une ligne de diff, donc il est
  // déjà identique à l'existant et l'écrire ne change rien).
  const retenu = (champ: string, propose: string): string => {
    if (gardees.has(champ)) return gardees.get(champ) as string;
    return avantDe.get(champ) ?? propose;
  };

  const fiche: PropositionConstruction['fiche'] = {};
  for (const [cle, valeur] of Object.entries(proposition.fiche)) {
    if (valeur === undefined) continue;
    const champ = `fiche.${cle}`;
    if (avantDe.has(champ) && !gardees.has(champ)) continue;
    if (cle === 'sorties') { fiche.sorties = valeur as SortieAgent[]; continue; }
    (fiche as Record<string, unknown>)[cle] = gardees.get(champ) ?? valeur;
  }

  // Un outil dont TOUTES les lignes ont été jetées n'est pas écrit du tout : le réécrire avec ses valeurs
  // actuelles CRÉERAIT quand même l'outil (aux mots vides) alors que le client vient de refuser l'ajout.
  const garde = <T>(liste: T[], cles: (x: T) => string[]): T[] => liste.filter((x) => {
    const lignes = cles(x).filter((c) => avantDe.has(c));
    return lignes.length === 0 || lignes.some((c) => gardees.has(c));
  });

  return {
    fiche,
    /**
     * 🔴 LE REGLAGE D ANNONCE D IA SUIT LA MEME REGLE QUE LE RESTE, et l oublier ici l aurait fait
     * DISPARAITRE en silence : l entretien aurait pose la question, le diff l aurait affichee, et appliquer
     * n aurait rien change. C est le defaut typique d une capacite cablee sur deux consommateurs sur trois.
     *
     * ⚠️ Contrairement aux champs texte, une ligne JETEE s omet au lieu de reecrire la valeur actuelle : le
     * diff ne porte que des LIBELLES en francais (« une fois par conversation »), pas le code, donc il n y a
     * rien a reecrire. Omettre laisse la colonne inchangee, ce qui est exactement le sens de « jeter ».
     */
    ...(proposition.mentionIaFrequence !== undefined
      && (!avantDe.has('mentionIaFrequence') || gardees.has('mentionIaFrequence'))
      ? { mentionIaFrequence: proposition.mentionIaFrequence }
      : {}),
    // ⚠️ MEME REGLE, ET LE MEME PIEGE : un reglage hors fiche oublie ICI serait pose par l entretien,
    // affiche par le diff, et jete a l application, sans que rien ne le signale. C est le defaut typique
    // d une capacite cablee sur deux consommateurs sur trois, deja paye une fois dans ce depot.
    ...(proposition.inactiviteMinutes !== undefined
      && (!avantDe.has('inactiviteMinutes') || gardees.has('inactiviteMinutes'))
      ? { inactiviteMinutes: proposition.inactiviteMinutes }
      : {}),
    outils: garde(proposition.outils, (o) => [`outil.${o.handler}.description`, `outil.${o.handler}.nePasUtiliser`])
      .map((o) => ({
        handler: o.handler,
        description: retenu(`outil.${o.handler}.description`, o.description),
        nePasUtiliser: retenu(`outil.${o.handler}.nePasUtiliser`, o.nePasUtiliser),
      })),
    connecteurs: garde(proposition.connecteurs ?? [], (c) => [`connecteur.${c.nom}.description`, `connecteur.${c.nom}.nePasUtiliser`])
      .map((c) => ({
        nom: c.nom,
        description: retenu(`connecteur.${c.nom}.description`, c.description),
        nePasUtiliser: retenu(`connecteur.${c.nom}.nePasUtiliser`, c.nePasUtiliser),
      })),
    /**
     * 🔴 LE BRANCHEMENT SUIT LA MEME REGLE QUE LE RESTE : une ligne JETEE ne part pas. L oublier ici serait le
     * defaut deja paye deux fois dans ce fichier, celui d une capacite proposee, affichee, puis silencieuse.
     *
     * ⚠️ Un branchement n a qu UNE ligne de diff (`outil.<nom>.rattachement`), donc pas de `garde` a plusieurs
     * cles : il est retenu s il n a pas ete jete.
     */
    outilsBranches: (proposition.outilsBranches ?? []).filter(
      (n) => !avantDe.has(`outil.${n}.rattachement`) || gardees.has(`outil.${n}.rattachement`),
    ),
    outilsDebranches: (proposition.outilsDebranches ?? []).filter(
      (n) => !avantDe.has(`outil.${n}.rattachement`) || gardees.has(`outil.${n}.rattachement`),
    ),
  };
}

export async function parlerAuConstructeur(
  tenantId: string, agentId: string, message: string,
): Promise<ReponseConstruction> {
  // On envoie UN message, pas l'historique : depuis le 2026-08-31 c'est le serveur qui tient l'entretien.
  // Le renvoyer d'ici laissait la séquence des questions à la discrétion du modèle, et perdait la
  // conversation au premier changement d'onglet.
  return request<ReponseConstruction>(`/tenants/${tenantId}/agents/${agentId}/setup`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

/**
 * L'entretien déjà tenu, pour rouvrir l'onglet là où on l'avait laissé.
 *
 * `auteurs` est PARALLÈLE à `messages` (migration 0147), et porte des ADRESSES résolues par le serveur, ou
 * `null` : les réponses de l'assistant, les tours d'avant la migration, et les comptes supprimés. L'écran
 * affiche alors « auteur inconnu » plutôt qu'un nom inventé.
 */
export async function lireEntretien(
  tenantId: string, agentId: string,
): Promise<{ messages: TourConstruction[]; auteurs?: Array<string | null>; couverture: Couverture }> {
  return request(`/tenants/${tenantId}/agents/${agentId}/setup`);
}

/**
 * Plafonds de poids d'une pièce jointe, en octets.
 *
 * ⚠️ Ils DOUBLENT ceux de `src/agent/setup/piece-jointe.ts`, et `tests/web-piece-jointe-parity.test.ts` casse
 * s'ils divergent. L'écran doit annoncer le même chiffre que celui sur lequel le serveur refuse : sinon on
 * promet 20 Mo et on rend un 413 que personne ne comprend.
 */
export const TAILLE_DOCUMENT_MAX = 8 * 1024 * 1024;
export const TAILLE_IMAGE_MAX = 5 * 1024 * 1024;

/** Ce que le serveur a fait d'une pièce jointe. */
export interface PieceJointeImportee {
  fiches: number;
  titres: string[];
  nature: 'texte' | 'pdf' | 'docx' | 'image';
}

/**
 * Joint un document ou une image : le serveur en tire du texte et l'écrit en fiches de connaissance.
 *
 * Le fichier part en data URL base64, comme l'upload média : le dépôt n'a pas de gestionnaire multipart, et en
 * ajouter un pour une route ne se justifierait pas.
 */
export function joindrePiece(tenantId: string, agentId: string, nom: string, dataUrl: string): Promise<PieceJointeImportee> {
  return request(`/tenants/${tenantId}/agents/${agentId}/setup/piece-jointe`, {
    method: 'POST',
    body: JSON.stringify({ nom, dataUrl }),
  });
}

/** Repart de zéro. Un entretien qui a mal tourné doit pouvoir se jeter sans supprimer l'agent. */
export async function effacerEntretien(tenantId: string, agentId: string): Promise<{ efface: boolean; couverture: Couverture }> {
  return request(`/tenants/${tenantId}/agents/${agentId}/setup`, { method: 'DELETE' });
}

/**
 * Applique une proposition, par les MÊMES routes que le formulaire.
 *
 * 🔴 La fiche d'abord, et avec son verrou de version. Si elle a bougé sous les pieds du client (l'autre
 * surface d'édition, un autre onglet), le `PATCH` refuse en 409 et RIEN d'autre n'est tenté : appliquer les
 * outils d'une proposition dont la fiche a été refusée laisserait l'agent à moitié réglé, sans que personne
 * sache lequel des deux gestes a compté.
 */
export async function appliquerProposition(
  tenantId: string, agentId: string, proposition: PropositionConstruction, ficheVersion: number,
): Promise<void> {
  /**
   * 🔴 LES REGLAGES HORS FICHE PARTENT ICI AUSSI, ET ILS NE PARTAIENT PAS. Trouve en revue le 2026-09-11 :
   * cette fonction n envoyait que `contenu`, donc `mentionIaFrequence` (depuis le 2026-09-09) et
   * `inactiviteMinutes` (le jour meme) etaient MUETS de bout en bout. L entretien posait la question, le diff
   * affichait le changement, l ecran disait « C est enregistre », et rien n atteignait la base.
   *
   * 🔴 ET LE TEST PROUVAIT LA MAUVAISE MOITIE. `restreindreProposition`, juste au-dessus, les calcule
   * correctement et porte meme un commentaire qui NOMME le risque (« une capacite cablee sur deux
   * consommateurs sur trois ») ; ses trois tests passaient. Mais elle ne fait que CALCULER : c est cette
   * fonction-ci qui ENVOIE, et personne ne la testait. Tester la fonction qui calcule au lieu de celle qui
   * ecrit donne un vert qui ne prouve rien.
   *
   * ⚠️ LE VERROU DE VERSION N ACCOMPAGNE QUE `contenu`, exactement comme dans l ecran des agents : il
   * protege la fiche jsonb, que deux surfaces peuvent reecrire ; une colonne scalaire n en a pas besoin, et
   * l envoyer ferait echouer en 409 un reglage qui n a aucune raison de se heurter.
   */
  const patch: PatchAgent = {
    ...(Object.keys(proposition.fiche).length > 0
      ? { contenu: proposition.fiche, ficheVersionAttendue: ficheVersion }
      : {}),
    ...(proposition.inactiviteMinutes !== undefined ? { inactiviteMinutes: proposition.inactiviteMinutes } : {}),
  };
  // 🔴 ON N ENVOIE QUE S IL Y A QUELQUE CHOSE A ENVOYER, mais on envoie des qu IL Y A QUELQUE CHOSE : la
  // condition portait sur la seule fiche, donc une proposition qui ne changeait QU UN reglage hors fiche
  // (le cas le plus probable, puisque l entretien a un point dedie a chacun) ne declenchait AUCUN appel.
  const ficheEcrite = Object.keys(patch).length > 0;
  if (ficheEcrite) {
    await patchAgent(tenantId, agentId, patch);
  }
  /**
   * 🔴 LE REGIME D ANNONCE NE PART PLUS AVEC L AGENT (migration 0140) : c est une politique de l ESPACE,
   * parce que l AI Act fait peser l obligation sur la marque deployante. Il a donc sa PROPRE ecriture.
   *
   * ⚠️ APRES le patch de fiche, et jamais avant. Le patch peut echouer en 409 si la fiche a bouge sous nos
   * pieds, et le docblock ci-dessus dit que RIEN d autre n est alors tente : regler la politique d abord
   * laisserait l espace change alors que le client verrait un refus.
   */
  if (proposition.mentionIaFrequence !== undefined) {
    await setPolitiqueMentionIa(tenantId, proposition.mentionIaFrequence);
  }
  /**
   * LE BRANCHEMENT, AVANT les mots : un outil qu on vient de brancher doit exister sur l agent pour que le
   * patch de ses mots le trouve. L ordre inverse ecrirait les mots d un outil encore non rattache, donc
   * rien du tout.
   *
   * 🔴 LES NOMS SE RESOLVENT SUR LA BIBLIOTHEQUE, PAS SUR LES OUTILS DE L AGENT : un outil a BRANCHER n y
   * figure justement pas encore. Le chercher au mauvais endroit rendrait le branchement silencieusement
   * inoperant, ce qui est le mode de panne de ce fichier.
   */
  const aBrancher = proposition.outilsBranches ?? [];
  const aDebrancher = proposition.outilsDebranches ?? [];
  if (aBrancher.length > 0 || aDebrancher.length > 0) {
    const { outils: bibliotheque } = await getBibliothequeOutils(tenantId);
    const idDe = (nom: string): string | undefined => bibliotheque.find((o) => o.name === nom)?.id;
    for (const nom of aBrancher) {
      const id = idDe(nom);
      // Un nom inconnu est IGNORE, jamais cree : le serveur a deja filtre, cette seconde ceinture tient si
      // la proposition vieillit entre son calcul et le clic (un administrateur a pu retirer la definition).
      if (id) await rattacherOutil(tenantId, agentId, id, true);
    }
    for (const nom of aDebrancher) {
      const id = idDe(nom);
      if (id) await rattacherOutil(tenantId, agentId, id, false);
    }
  }
  const connecteurs = proposition.connecteurs ?? [];
  if (proposition.outils.length === 0 && connecteurs.length === 0) return;
  try {
    // Les outils posés sont relus MAINTENANT : la proposition a pu être calculée il y a plusieurs minutes, et
    // ajouter un outil qui existe déjà rendrait 409 sur un nom pris.
    const { outils: poses } = await listOutils(tenantId, agentId);
    for (const propose of proposition.outils) {
      const deja = poses.find((o) => String(o.binding.handler ?? '') === propose.handler);
      // Ajouté INACTIF, comme toujours : l'activation reste un geste humain, et l'assistant ne l'a pas.
      const cible = deja ?? await ajouterOutil(tenantId, agentId, propose.handler);
      await patchOutil(tenantId, agentId, cible.id, {
        description: propose.description,
        nePasUtiliser: propose.nePasUtiliser,
      });
    }
    // 🔴 LES CONNECTEURS SE PATCHENT, ILS NE SE CRÉENT PAS. Un nom inconnu est IGNORÉ, jamais créé : déclarer
    // un connecteur, c'est écrire une adresse réseau et un secret, et cela reste un geste d'administrateur.
    // Le serveur a déjà filtré les noms inconnus ; cette seconde ceinture tient si la proposition vieillit
    // entre son calcul et le clic « Garder » (l'administrateur peut avoir retiré le connecteur entre-temps).
    for (const propose of connecteurs) {
      const cible = poses.find((o) => o.name === propose.nom && o.origin !== 'mba');
      if (!cible) continue;
      await patchOutil(tenantId, agentId, cible.id, {
        description: propose.description,
        nePasUtiliser: propose.nePasUtiliser,
      });
    }
  } catch (err) {
    // 🔴 Ces écritures ne sont PAS dans une transaction : la fiche part par une route, les outils par une
    // autre. Un échec ici laisse donc la fiche déjà écrite, et le dire est la seule honnêteté possible.
    // Sans ce message, le client réessaierait « Garder » et se ferait refuser en 409 sur un numéro de
    // version périmé, c'est-à-dire une erreur qui ne parle pas du tout de ce qui s'est passé.
    const cause = err instanceof Error ? err.message : 'erreur inconnue';
    // Apostrophes typographiques, comme partout ailleurs dans l'interface : ce message est lu par le client.
    // ⚠️ `ficheEcrite` couvre depuis le 2026-09-11 la fiche ET les réglages hors fiche, qui partent dans le
    // MÊME patch : le message reste juste, c'est bien « ce qui touche à l'agent » qui est enregistré.
    throw new Error(ficheEcrite
      ? `La fiche est enregistrée, mais un outil n’a pas pu l’être : ${cause}. Vérifiez l’onglet Outils.`
      : `Un outil n’a pas pu être enregistré : ${cause}`);
  }
}

/** Un manque qui empêche l'activation, tel que la route `PATCH` le rend en 422. */
export interface ManqueFiche {
  onglet: 'identite' | 'objectif' | 'connaissance' | 'outils';
  message: string;
}

/**
 * LES DEUX BANDEAUX D'UNE FICHE D'AGENT, EN UN SEUL ALLER-RETOUR.
 *
 * 🔴 POURQUOI CET APPEL EXISTE. Les manques étaient déjà calculés côté serveur, mais ils ne sortaient que
 * dans le corps d'un 422, c'est-à-dire APRÈS avoir cliqué « activer ». Un agent en brouillon qu'on essaie
 * dans le bac à sable ne les voyait donc jamais : Julien, le 2026-09-08, a cherché pourquoi son agent ne
 * trouvait rien alors que la réponse (« l'outil de recherche est inactif ») était déjà écrite, derrière un
 * geste qu'il n'avait pas fait.
 *
 * 🔴 SÉPARÉS EN DEUX LISTES, ET LA SÉPARATION EST MÉCANIQUE. Côté serveur, `manquesAvantActivation`
 * n'alimente pas que l'affichage : c'est AUSSI la garde dure de `status = 'active'`. Y verser les
 * avertissements donnerait à un serveur TIERS un droit de veto sur l'activation de l'agent d'un client.
 *
 * ⚠️ UN SEUL APPEL, ET C'EST UNE CORRECTION. Deux fonctions ont d'abord fait chacune leur GET sur la MÊME
 * route, qui rend déjà les deux listes : la fiche d'un agent tapait donc deux fois la même adresse à
 * chaque ouverture, sur une route sous plafond de débit.
 *
 * BEST-EFFORT chez l'appelant : c'est une aide, pas une condition.
 */
export async function lireBandeaux(
  tenantId: string,
  agentId: string,
): Promise<{ manques: ManqueFiche[]; avertissements: ManqueFiche[] }> {
  const r = await request<{ manques?: unknown; avertissements?: unknown }>(
    `/tenants/${tenantId}/agents/${agentId}/manques`,
  );
  return {
    manques: manquesDe(r),
    avertissements: listeDeManques((r as { avertissements?: unknown } | null)?.avertissements),
  };
}

/** Lit la liste des manques d'une erreur 422 d'activation. Défensif : le corps vient du réseau. */
export function manquesDe(corps: unknown): ManqueFiche[] {
  return listeDeManques((corps as { manques?: unknown } | null)?.manques);
}

/** La lecture DÉFENSIVE partagée par les deux listes : le corps vient du réseau. */
function listeDeManques(liste: unknown): ManqueFiche[] {
  if (!Array.isArray(liste)) return [];
  return liste.flatMap((brut) => {
    const m = brut as { onglet?: unknown; message?: unknown };
    return typeof m?.message === 'string' && typeof m.onglet === 'string'
      ? [{ onglet: m.onglet as ManqueFiche['onglet'], message: m.message }]
      : [];
  });
}
