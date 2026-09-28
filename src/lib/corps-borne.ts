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

  const lu = await lireFluxBorne(flux, plafond);
  return {
    texte: lu.morceaux === null ? '' : Buffer.concat(lu.morceaux).toString('utf8'),
    octets: lu.octets, trop_gros: lu.trop_gros, casse: lu.casse,
  };
}

/** Ce que rend la lecture BINAIRE bornée : les octets, ou `null` quand le plafond ou le flux a lâché. */
export interface OctetsBornes {
  octets: Buffer | null;
  taille: number;
  trop_gros: boolean;
  casse: boolean;
}

/**
 * La même lecture, pour un corps BINAIRE (une image) : `lireCorpsBorne` décode en UTF-8, ce qui abîme des octets
 * qui ne sont pas du texte. Mêmes règles : on compte en octets, on s'arrête à celui qui dépasse, on ne tronque pas.
 * Repli sur `arrayBuffer()` quand la réponse n'expose pas de flux.
 */
export async function lireOctetsBornes(res: Response, maxOctets: number): Promise<OctetsBornes> {
  const plafond = Math.max(0, Math.floor(maxOctets));
  const flux = res.body as ReadableStream<Uint8Array> | null | undefined;

  if (!flux || typeof flux.getReader !== 'function') {
    const tampon = await res.arrayBuffer().then((b) => Buffer.from(b)).catch(() => null);
    if (tampon === null) return { octets: null, taille: 0, trop_gros: false, casse: true };
    const trop = tampon.length > plafond;
    return { octets: trop ? null : tampon, taille: tampon.length, trop_gros: trop, casse: false };
  }

  const lu = await lireFluxBorne(flux, plafond);
  return {
    octets: lu.morceaux === null ? null : Buffer.concat(lu.morceaux),
    taille: lu.octets, trop_gros: lu.trop_gros, casse: lu.casse,
  };
}

/** La boucle commune aux deux lectures : `morceaux` vaut `null` dès que la lecture n'est pas utilisable. */
async function lireFluxBorne(
  flux: ReadableStream<Uint8Array>,
  plafond: number,
): Promise<{ morceaux: Uint8Array[] | null; octets: number; trop_gros: boolean; casse: boolean }> {
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
        return { morceaux: null, octets, trop_gros: true, casse: false };
      }
      morceaux.push(value);
    }
  } catch {
    return { morceaux: null, octets, trop_gros: false, casse: true };
  } finally {
    lecteur.releaseLock?.();
  }
  return { morceaux, octets, trop_gros: false, casse: false };
}
