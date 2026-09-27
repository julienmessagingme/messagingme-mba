/**
 * Lire un corps de réponse sans se faire remplir la mémoire.
 *
 * `await res.text()` suivi d'un test de taille charge tout avant de contrôler, et `.length` compte des unités
 * UTF-16, pas des octets. Ici on lit morceau par morceau, on compte en octets et on s'arrête à l'octet qui
 * dépasse : le flux est annulé, le reste ne traverse jamais le réseau.
 */

export interface CorpsBorne {
  /** Le corps décodé en UTF-8, ou `''` si rien n'a pu être lu. */
  texte: string;
  /** Taille réelle lue, en octets. */
  octets: number;
  /** Le plafond a-t-il été dépassé ? Le texte est alors sans valeur : on refuse, on ne tronque pas. */
  trop_gros: boolean;
  /**
   * Le flux a-t-il cassé en cours de lecture ? Sans ce drapeau, une lecture ratée ressemblerait à un corps vide,
   * et l'appelant annoncerait que le système du client a répondu.
   */
  casse: boolean;
}

/**
 * Lit le corps d'une réponse en s'arrêtant dès que `maxOctets` est dépassé. On ne tronque pas (un JSON coupé
 * est illisible) : le drapeau dit à l'appelant de refuser.
 *
 * Repli sur `res.text()` quand la réponse n'expose pas de flux (certains `fetch`, la plupart des faux de
 * test) : le plafond est alors vérifié après coup, en octets.
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
        // Sans ce `cancel`, le serveur continuerait d'émettre une réponse qu'on vient de refuser.
        await lecteur.cancel().catch(() => {});
        return { texte: '', octets, trop_gros: true, casse: false };
      }
      morceaux.push(value);
    }
  } catch {
    return { texte: '', octets, trop_gros: false, casse: true };
  } finally {
    lecteur.releaseLock?.();
  }

  return { texte: Buffer.concat(morceaux).toString('utf8'), octets, trop_gros: false, casse: false };
}
