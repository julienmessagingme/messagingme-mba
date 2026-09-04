/**
 * LIRE UN CORPS DE RÉPONSE SANS SE FAIRE REMPLIR LA MÉMOIRE (constat A3 de l'audit externe du 2026-09-02).
 *
 * 🔴 DEUX DÉFAUTS DANS LA MÊME LIGNE, et le repo l'écrivait à deux endroits. `const brut = await res.text()`
 * suivi d'un test de taille CONTRÔLE APRÈS AVOIR TOUT CHARGÉ : un serveur qui répond deux gigaoctets les fait
 * entrer en mémoire, et le plafond ne sert qu'à jeter ce qu'on a déjà payé. Et `brut.length` compte des
 * unités UTF-16, pas des octets : un corps d'idéogrammes ou d'emoji passe un plafond « en octets » avec le
 * double, voire le quadruple, de sa valeur réelle.
 *
 * Ici, on lit MORCEAU PAR MORCEAU et on s'arrête à l'octet qui dépasse : le flux est annulé, le reste ne
 * traverse jamais le réseau. Le comptage est en OCTETS, sur les morceaux binaires eux-mêmes, donc exact.
 */

export interface CorpsBorne {
  /** Le corps décodé en UTF-8, ou `''` si rien n'a pu être lu. */
  texte: string;
  /** Taille réelle lue, en OCTETS. */
  octets: number;
  /** Le plafond a-t-il été dépassé ? Le texte est alors sans valeur : on refuse, on ne tronque pas. */
  trop_gros: boolean;
  /**
   * Le flux a-t-il CASSÉ en cours de lecture ?
   *
   * 🔴 SANS CE DRAPEAU, UN CORPS ILLISIBLE ÉTAIT INDISTINGUABLE D'UN CORPS VIDE (audit du 2026-09-04), et les
   * deux rendaient `{ texte: '', trop_gros: false }`. Un appelant qui annonce « ça répond » après une lecture
   * ratée envoie donc son utilisateur chercher du mauvais côté : le système du client a l'air d'avoir répondu
   * un corps vide, alors que c'est la connexion qui a lâché. Le cas est réel, c'est ce que fait un serveur qui
   * coupe en plein corps.
   */
  casse: boolean;
}

/**
 * Lit le corps d'une réponse en s'arrêtant dès que `maxOctets` est dépassé.
 *
 * ⚠️ On ne TRONQUE PAS : un JSON coupé est illisible de toute façon, et le rendre au modèle remplirait son
 * contexte pour rien. Le drapeau dit à l'appelant de refuser, ce qui est aussi ce qu'il faisait avant.
 *
 * Repli sur `res.text()` quand la réponse n'expose pas de flux : certaines implémentations de `fetch` et la
 * plupart des faux de test rendent un corps déjà matérialisé. Le plafond est alors vérifié sur les octets
 * après coup, ce qui est exactement le comportement d'avant, en mieux (octets et non unités UTF-16).
 */
export async function lireCorpsBorne(res: Response, maxOctets: number): Promise<CorpsBorne> {
  const plafond = Math.max(0, Math.floor(maxOctets));
  const flux = res.body as ReadableStream<Uint8Array> | null | undefined;

  if (!flux || typeof flux.getReader !== 'function') {
    const texte = await res.text().catch(() => '');
    const octets = Buffer.byteLength(texte, 'utf8');
    return { texte, octets, trop_gros: octets > plafond, casse: false };
  }

  const lecteur = flux.getReader();
  const morceaux: Uint8Array[] = [];
  let octets = 0;
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      if (!value) continue;
      octets += value.byteLength;
      if (octets > plafond) {
        // On coupe la connexion : sans ce `cancel`, le serveur continuerait d'émettre et nous continuerions
        // de payer la bande passante d'une réponse qu'on vient de refuser.
        await lecteur.cancel().catch(() => {});
        return { texte: '', octets, trop_gros: true, casse: false };
      }
      morceaux.push(value);
    }
  } catch {
    // Un flux qui casse en cours de route ne rend rien d'exploitable, et il le DIT désormais : sans le
    // drapeau, l'appelant ne pouvait pas le distinguer d'un corps vide, et annonçait donc un succès.
    return { texte: '', octets, trop_gros: false, casse: true };
  } finally {
    lecteur.releaseLock?.();
  }

  return { texte: Buffer.concat(morceaux).toString('utf8'), octets, trop_gros: false, casse: false };
}
