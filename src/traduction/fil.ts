import {
  LOT_CARACTERES_MAX,
  TRADUCTIONS_MAX_PAR_REQUETE,
  type LangueConsole,
  type Traducteur,
} from './traduire';

/**
 * TRADUIRE LE FIL D'UNE CONVERSATION A SON OUVERTURE (2026-09-12).
 *
 * 🔴 SEULS LES ENTRANTS SE TRADUISENT, et ce n'est pas une economie de bout de chandelle. Un sortant
 * s'affiche avec ce que l'OPERATEUR a ecrit (`redaction_origine`, sinon `body`) : il n'y a rien a
 * traduire et aucun appel a payer. Le traduire reviendrait a retraduire notre propre phrase vers
 * notre propre langue.
 *
 * 🔴 TROIS ETATS, ET LES DEUX DERNIERS NE SE CONFONDENT PAS :
 *   - traduit           -> `affiche` porte la traduction, `traduit` = true ;
 *   - appel echoue      -> `affiche` porte l'original, `traductionEchouee` = true ;
 *   - au-dela du plafond, JAMAIS TENTE -> `affiche` porte l'original, et les deux drapeaux sont faux.
 * Confondre les deux derniers ferait dire a l'ecran qu'une traduction a rate alors qu'elle n'a
 * jamais ete demandee, et personne ne comprendrait pourquoi elle ne revient pas au rechargement.
 *
 * ⚠️ LE PREMIER LECTEUR PAIE, LES SUIVANTS LISENT : une traduction deja rangee DANS LA LANGUE
 * DEMANDEE n'est jamais recalculee. Sans cette garde, chaque ouverture de fil repaierait tout.
 */

/**
 * Le minimum qu'un message doit porter pour passer par ici.
 *
 * ⚠️ Volontairement plus ETROIT que `ConversationMessage` : ce module n'a besoin ni du curseur, ni de
 * l'auteur, ni du canal, et un type large l'aurait attache a la forme de l'inbox.
 */
export interface MessageATraduire {
  id: string;
  direction: 'in' | 'out';
  type?: string | null;
  body: string | null;
  /** La transcription d'un vocal (0125). C'est ELLE qu'on traduit pour un audio, jamais `[audio]`. */
  transcription?: string | null;
  traduction?: string | null;
  traductionLangue?: string | null;
  /** Ce que l'operateur a ECRIT avant traduction, sur un SORTANT (0137). */
  redactionOrigine?: string | null;
}

/** Ce que la route ajoute a chaque message. Les trois etats du haut de fichier. */
export interface EtatTraduction {
  /** Le texte a AFFICHER dans la bulle, quel que soit l'etat. Jamais vide sur un message qui a du texte. */
  affiche: string;
  traduit: boolean;
  /** `true` SEULEMENT si la traduction a ete TENTEE et n'est pas revenue. */
  traductionEchouee: boolean;
}

export interface DepsFil {
  traducteur: Traducteur;
  /** Range les traductions calculees. Un echec ici ne doit pas priver l'operateur de sa lecture. */
  ranger(
    tenantId: string,
    conversationId: string,
    traductions: Array<{ messageId: string; texte: string; langue: LangueConsole }>,
  ): Promise<void>;
  /** La langue du contact, APPRISE du message le plus recent qu'on vient de traduire. */
  apprendreLangueContact(tenantId: string, conversationId: string, langue: string): Promise<void>;
  /**
   * Une ecriture d'appoint a echoue.
   *
   * ⚠️ Optionnel, mais la route la cable sur son journal : sans elle, un rangement qui echoue ferait
   * repayer la meme traduction a chaque ouverture SANS QUE PERSONNE NE L'APPRENNE, ce qui est
   * exactement le genre de fuite qu'on ne voit que sur la facture.
   */
  onErreur?(err: unknown, quoi: string): void;
}

export interface FilTraduit<M> {
  /** `true` = cet espace ne peut pas traduire (pas de cle de modele). Ce n'est PAS une panne, et c'est 200. */
  indisponible: boolean;
  messages: Array<M & EtatTraduction>;
}

/**
 * Le libelle d'un media sans legende, tel que `contentOf` l'ecrit (`[audio]`, `[image]`,
 * `[interactif]`...).
 *
 * 🔴 LE TRADUIRE SERAIT UN APPEL PAYE POUR RIEN, et pire : le modele rendrait « [son] » ou
 * « [audio] » selon son humeur, donc l'aperçu du fil changerait d'un rechargement a l'autre.
 */
const LIBELLE_MEDIA = /^\[[a-z]+\]$/;

/**
 * Le texte d'un ENTRANT qu'on traduit, ou `null` s'il n'y a rien a traduire.
 *
 * 🔴 POUR UN VOCAL, C'EST LA TRANSCRIPTION, JAMAIS LE CORPS : `body` vaut `[audio]` ou la legende, et
 * traduire « [audio] » ne produit rien. Un vocal non encore transcrit n'a donc rien a traduire, et ce
 * n'est pas un echec : il n'y a simplement pas encore de texte.
 */
export function texteATraduire(m: MessageATraduire): string | null {
  const transcription = m.transcription?.trim();
  if (transcription) return transcription;
  const body = m.body?.trim();
  if (!body || LIBELLE_MEDIA.test(body)) return null;
  return body;
}

/** Ce qu'on affiche quand on ne traduit pas : l'original, cote client ; la redaction, cote operateur. */
function texteOriginal(m: MessageATraduire): string {
  if (m.direction === 'out') return (m.redactionOrigine ?? m.body ?? '').toString();
  return m.body ?? '';
}

/** Une traduction DEJA rangee, et dans la langue demandee. */
function dejaTraduit(m: MessageATraduire, cible: LangueConsole): string | null {
  const t = m.traduction?.trim();
  return t && m.traductionLangue === cible ? m.traduction! : null;
}

/**
 * Les messages a tenter, LES PLUS RECENTS D'ABORD, sous les deux plafonds.
 *
 * ⚠️ Rendus dans l'ordre du fil (le plus ancien en premier) une fois choisis : ce qui compte est
 * QUELS messages sont retenus, pas dans quel ordre ils partent au modele.
 */
export function candidats(messages: MessageATraduire[], cible: LangueConsole): MessageATraduire[] {
  const retenus: MessageATraduire[] = [];
  let caracteres = 0;
  // 🔴 A REBOURS : le plafond doit mordre sur le HAUT du fil (l'historique ancien), jamais sur les
  // derniers messages, qui sont ceux que l'operateur est en train de lire.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.direction !== 'in') continue;
    if (dejaTraduit(m, cible) !== null) continue;
    const texte = texteATraduire(m);
    if (texte === null) continue;
    if (retenus.length >= TRADUCTIONS_MAX_PAR_REQUETE) break;
    if (caracteres + texte.length > LOT_CARACTERES_MAX) break;
    caracteres += texte.length;
    retenus.push(m);
  }
  return retenus.reverse();
}

/**
 * Traduit ce qui doit l'etre, range le resultat, apprend la langue du contact, et rend le fil avec
 * ses trois etats.
 *
 * ⚠️ RIEN N'EST JETE : les messages rendus sont EXACTEMENT ceux recus, dans le meme ordre, enrichis.
 * Un filtrage ici escamoterait des bulles a l'ecran pour une raison sans rapport avec leur affichage.
 */
export async function traduireFil<M extends MessageATraduire>(
  deps: DepsFil,
  o: { tenantId: string; conversationId: string; messages: M[]; cible: LangueConsole },
): Promise<FilTraduit<M>> {
  const enVo = (indisponible: boolean): FilTraduit<M> => ({
    indisponible,
    messages: o.messages.map((m) => {
      const deja = m.direction === 'in' ? dejaTraduit(m, o.cible) : null;
      return {
        ...m,
        affiche: deja ?? texteOriginal(m),
        traduit: deja !== null,
        traductionEchouee: false,
      };
    }),
  });

  // 🔴 PAS DE CREDIT, PAS D'APPEL, ET SURTOUT PAS D'ERREUR. Un espace sans cle de modele lit son fil
  // en VO avec un drapeau : ce n'est pas une panne, c'est un espace sans credit, et l'ecran doit
  // pouvoir le dire plutot que de rester muet.
  if (!(await deps.traducteur.disponible(o.tenantId))) return enVo(true);

  const aTenter = candidats(o.messages, o.cible);
  if (aTenter.length === 0) return enVo(false);

  const tentes = new Set(aTenter.map((m) => m.id));
  const obtenues = await deps.traducteur.traduireLot(
    o.tenantId,
    aTenter.map((m) => ({ id: m.id, texte: texteATraduire(m)! })),
    o.cible,
  );

  if (obtenues.size > 0) {
    try {
      await deps.ranger(
        o.tenantId,
        o.conversationId,
        [...obtenues].map(([messageId, t]) => ({ messageId, texte: t.texte, langue: o.cible })),
      );
    } catch (err) {
      // La lecture est deja acquise : on la rend. Ce qui se perd, c'est la reutilisation, donc de
      // l'argent au prochain chargement, d'ou le signalement.
      deps.onErreur?.(err, 'traduction_rangement');
    }

    /**
     * LA LANGUE DU CONTACT VIENT DU MESSAGE LE PLUS RECENT QU'ON VIENT DE TRADUIRE.
     *
     * ⚠️ LE PLUS RECENT, pas le premier du lot : quelqu'un peut changer de langue en cours de
     * conversation, et c'est la derniere qui vaut. Le cadrage previent qu'elle peut etre FAUSSE une
     * fois (un « ok » ou un emoji mal classe) ; c'est pourquoi elle n'est qu'un DEFAUT propose au
     * bouton de traduction sortante, jamais une decision prise sans l'operateur.
     */
    for (let i = aTenter.length - 1; i >= 0; i -= 1) {
      const langue = obtenues.get(aTenter[i]!.id)?.langueSource?.trim();
      if (!langue) continue;
      try {
        await deps.apprendreLangueContact(o.tenantId, o.conversationId, langue);
      } catch (err) {
        deps.onErreur?.(err, 'langue_contact');
      }
      break;
    }
  }

  return {
    indisponible: false,
    messages: o.messages.map((m) => {
      const fraiche = obtenues.get(m.id)?.texte;
      const traduction = fraiche ?? (m.direction === 'in' ? dejaTraduit(m, o.cible) : null);
      if (traduction !== null && traduction !== undefined) {
        return { ...m, affiche: traduction, traduit: true, traductionEchouee: false };
      }
      return {
        ...m,
        affiche: texteOriginal(m),
        traduit: false,
        // 🔴 TENTE ET NON REVENU = echec. Non tente = rien du tout. C'est toute la difference entre
        // « ca a rate » et « on n'a pas demande », et l'ecran ne dit pas la meme chose dans les deux cas.
        traductionEchouee: tentes.has(m.id),
      };
    }),
  };
}
