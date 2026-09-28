import {
  LOT_CARACTERES_MAX,
  TRADUCTIONS_MAX_PAR_REQUETE,
  type CauseSansTraduction,
  type LangueConsole,
  type Traducteur,
} from './traduire';

/**
 * Traduire le fil d'une conversation à son ouverture.
 *
 * Seuls les entrants se traduisent : un sortant s'affiche avec ce que l'opérateur a écrit (`redaction_origine`,
 * sinon `body`), il n'y a rien à traduire ni à payer.
 * Trois états, et les deux derniers ne se confondent pas : traduit (`traduit` = true) ; appel échoué (l'original,
 * `traductionEchouee` = true) ; au-delà du plafond, jamais tenté (l'original, deux drapeaux faux). Sinon l'écran
 * dirait qu'une traduction a raté alors qu'elle n'a jamais été demandée.
 * Le premier lecteur paie, les suivants lisent : une traduction rangée dans la langue demandée n'est jamais
 * recalculée.
 */

/**
 * Le minimum qu'un message doit porter pour passer par ici, plus étroit que `ConversationMessage` pour ne pas
 * attacher ce module à la forme de l'inbox.
 */
export interface MessageATraduire {
  id: string;
  direction: 'in' | 'out';
  type?: string | null;
  body: string | null;
  /** La transcription d'un vocal : c'est elle qu'on traduit pour un audio, jamais `[audio]`. */
  transcription?: string | null;
  traduction?: string | null;
  traductionLangue?: string | null;
  /** Ce que l'opérateur a écrit avant traduction, sur un sortant. */
  redactionOrigine?: string | null;
}

/** Ce que la route ajoute à chaque message : les trois états du haut de fichier. */
export interface EtatTraduction {
  /** Le texte à afficher dans la bulle, quel que soit l'état. Jamais vide sur un message qui a du texte. */
  affiche: string;
  traduit: boolean;
  /** `true` seulement si la traduction a été tentée et n'est pas revenue. */
  traductionEchouee: boolean;
}

export interface DepsFil {
  traducteur: Traducteur;
  traductions: {
    /** Range les traductions calculées. Un échec ici ne doit pas priver l'opérateur de sa lecture. */
    ranger(
      tenantId: string,
      conversationId: string,
      traductions: Array<{ messageId: string; texte: string; langue: LangueConsole }>,
    ): Promise<void>;
    /** La langue du contact, apprise du message le plus récent qu'on vient de traduire. */
    apprendreLangueContact(tenantId: string, conversationId: string, langue: string): Promise<void>;
  };
  /**
   * Une écriture d'appoint a échoué. La route la câble sur son journal : sans elle, un rangement qui échoue ferait
   * repayer la même traduction à chaque ouverture sans que personne ne l'apprenne.
   */
  onErreur?(err: unknown, quoi: string): void;
}

export interface FilTraduit<M> {
  /**
   * `null` = la traduction a pu se faire ; sinon, pourquoi cet espace ne traduit pas (crédit épuisé, clé qui n'a pas
   * pu s'ouvrir). Pas une panne, et c'est 200. Une seule valeur et pas un drapeau plus sa cause : les deux ne
   * peuvent pas se contredire.
   */
  indisponible: CauseSansTraduction | null;
  messages: Array<M & EtatTraduction>;
}

/**
 * Le libellé d'un média sans légende, tel que `contentOf` l'écrit (`[audio]`, `[image]`...). Le traduire serait un
 * appel payé pour rien, et l'aperçu changerait d'un rechargement à l'autre selon ce que rend le modèle.
 */
const LIBELLE_MEDIA = /^\[[a-z]+\]$/;

/**
 * Le texte d'un entrant qu'on traduit, ou `null`. Pour un vocal, c'est la transcription, jamais le corps
 * (`[audio]` ou la légende) : un vocal non encore transcrit n'a rien à traduire, et ce n'est pas un échec.
 */
export function texteATraduire(m: MessageATraduire): string | null {
  const transcription = m.transcription?.trim();
  if (transcription) return transcription;
  const body = m.body?.trim();
  if (!body || LIBELLE_MEDIA.test(body)) return null;
  return body;
}

/** Ce qu'on affiche sans traduire : l'original côté client, la rédaction côté opérateur. */
function texteOriginal(m: MessageATraduire): string {
  if (m.direction === 'out') return (m.redactionOrigine ?? m.body ?? '').toString();
  return m.body ?? '';
}

/** Une traduction déjà rangée, et dans la langue demandée. */
function dejaTraduit(m: MessageATraduire, cible: LangueConsole): string | null {
  const t = m.traduction?.trim();
  return t && m.traductionLangue === cible ? m.traduction! : null;
}

/**
 * Les messages à tenter, choisis des plus récents aux plus anciens sous les deux plafonds, puis rendus dans l'ordre
 * du fil.
 */
export function candidats(messages: MessageATraduire[], cible: LangueConsole): MessageATraduire[] {
  const retenus: MessageATraduire[] = [];
  let caracteres = 0;
  // À rebours : le plafond mord sur l'historique ancien, jamais sur les derniers messages, ceux qu'on lit.
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
 * Traduit ce qui doit l'être, range le résultat, apprend la langue du contact, et rend le fil avec ses trois états.
 * Rien n'est jeté : les messages rendus sont exactement ceux reçus, dans le même ordre, enrichis.
 */
export async function traduireFil<M extends MessageATraduire>(
  deps: DepsFil,
  o: { tenantId: string; conversationId: string; messages: M[]; cible: LangueConsole },
): Promise<FilTraduit<M>> {
  const enVo = (indisponible: CauseSansTraduction | null): FilTraduit<M> => ({
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

  // Pas de crédit : pas d'appel et pas d'erreur. Le fil se lit en VO avec sa cause, que l'écran explique.
  const empechement = await deps.traducteur.empechement(o.tenantId);
  if (empechement !== null) return enVo(empechement);

  const aTenter = candidats(o.messages, o.cible);
  if (aTenter.length === 0) return enVo(null);

  const tentes = new Set(aTenter.map((m) => m.id));
  const obtenues = await deps.traducteur.traduireLot(
    o.tenantId,
    aTenter.map((m) => ({ id: m.id, texte: texteATraduire(m)! })),
    o.cible,
  );

  if (obtenues.size > 0) {
    try {
      await deps.traductions.ranger(
        o.tenantId,
        o.conversationId,
        [...obtenues].map(([messageId, t]) => ({ messageId, texte: t.texte, langue: o.cible })),
      );
    } catch (err) {
      // La lecture est acquise ; ce qui se perd est la réutilisation, donc de l'argent au prochain chargement.
      deps.onErreur?.(err, 'traduction_rangement');
    }

    // La langue du contact vient du message le plus récent traduit (on peut changer de langue en cours de route).
    // Elle peut être fausse une fois (un « ok », un emoji) : ce n'est qu'un défaut proposé à la traduction sortante,
    // jamais une décision prise sans l'opérateur.
    for (let i = aTenter.length - 1; i >= 0; i -= 1) {
      const langue = obtenues.get(aTenter[i]!.id)?.langueSource?.trim();
      if (!langue) continue;
      try {
        await deps.traductions.apprendreLangueContact(o.tenantId, o.conversationId, langue);
      } catch (err) {
        deps.onErreur?.(err, 'langue_contact');
      }
      break;
    }
  }

  return {
    indisponible: null,
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
        // Tenté et non revenu = échec ; non tenté = rien. L'écran ne dit pas la même chose dans les deux cas.
        traductionEchouee: tentes.has(m.id),
      };
    }),
  };
}
