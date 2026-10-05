/**
 * Ce que la fenêtre Meta (Embedded Signup) annonce par `postMessage` : le compte WhatsApp, le numéro s'il y en a un, et
 * le nom de l'événement. Sortie de l'écoute de `useConnexionNumero` pour être testée.
 *
 * 🔴 LE COMPTE SEUL SUFFIT (lot 3b) : en v4, le client peut finir SANS numéro (`FINISH_ONLY_WABA`), et c'est le
 * parcours du numéro fourni. L'écoute n'acceptait que le couple compte et numéro, et jetait ce cas.
 */
export interface MessageEs {
  wabaId: string;
  phoneNumberId?: string;
  /** Le nom de l'événement (`FINISH`, `FINISH_ONLY_WABA`...), seulement s'il a la forme attendue. */
  evenement?: string;
}

/**
 * Origine ANCRÉE sur la frontière de point : accepte www./business.facebook.com, REJETTE evilfacebook.com
 * (`endsWith('facebook.com')` l'aurait laissé passer, donc des identifiants forgés par `postMessage`).
 */
const FB_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*facebook\.com$/;

/** Un identifiant envoyé en chaîne OU en nombre (Meta n'est pas constant). */
function enTexte(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** `null` : le message ne vient pas de Meta, ou n'annonce aucun compte. Ne lève jamais (données arbitraires). */
export function lireMessageEs(origine: unknown, donnees: unknown): MessageEs | null {
  if (typeof origine !== 'string' || !FB_ORIGIN.test(origine)) return null;
  // Une CHAÎNE JSON (SDK) ou déjà un objet selon le canal.
  let d: unknown;
  try {
    d = typeof donnees === 'string' ? JSON.parse(donnees) : donnees;
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null || (d as { type?: unknown }).type !== 'WA_EMBEDDED_SIGNUP') return null;
  const brut = d as { event?: unknown; data?: unknown };
  const p = (typeof brut.data === 'object' && brut.data !== null ? brut.data : d) as { waba_id?: unknown; phone_number_id?: unknown };
  const wabaId = enTexte(p.waba_id);
  if (!wabaId) return null;
  const phoneNumberId = enTexte(p.phone_number_id);
  const evenement = typeof brut.event === 'string' && /^[A-Z_]{1,40}$/.test(brut.event) ? brut.event : undefined;
  return { wabaId, ...(phoneNumberId ? { phoneNumberId } : {}), ...(evenement ? { evenement } : {}) };
}

/**
 * Ce que l'écoute garde quand un nouveau message arrive : le dernier, SAUF un compte seul qui écraserait le couple
 * compte et numéro déjà capturé pour le même compte. Le chemin avec numéro reste ainsi exact, quoi que la fenêtre
 * envoie après sa fin.
 */
export function retenirMessageEs(avant: MessageEs | undefined, lu: MessageEs): MessageEs {
  if (avant?.phoneNumberId && !lu.phoneNumberId && avant.wabaId === lu.wabaId) return avant;
  return lu;
}
