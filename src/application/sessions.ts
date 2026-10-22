import { DisconnectReason } from '@whiskeysockets/baileys';
import type { CompteApplication, ComptesApplication, StatutCompte } from './comptes';
import { reprendAuDemarrage } from './comptes';
import { delaiBackoff } from './transport/connexion';
import type { CauseFermeture, MessageApplication, RappelsSession, Session } from './transport/session';

/**
 * LES SESSIONS DU SERVICE DE CONNEXIONS (plan 2026-10-22, tâche 3) : une session par compte relié, tenue en
 * permanence, dans un seul processus. Ce module décide QUAND ouvrir, rouvrir, arrêter ; le transport sait COMMENT.
 *
 * 🔴 Un compte banni ne se rouvre JAMAIS tout seul : un bannissement n'est réversible qu'une fois, un relien
 * automatique le rend définitif (relevé de wagroups). Un déconnecté (appareil retiré depuis le téléphone) non plus :
 * relier de nouveau passe par une nouvelle préparation, donc un nouveau QR code.
 */

/** Un message de l'application tel qu'il voyage dans la file `application-entrant` (JSON : la date en ISO). */
export type MessageApplicationJson = Omit<MessageApplication, 'horodatage'> & { horodatage: string };

export interface JobEntrant {
  tenantId: string;
  compteId: string;
  message: MessageApplicationJson;
}

export type RaisonRefus = 'compte_inconnu' | 'non_relie' | 'statut';

export class ErreurApplication extends Error {
  constructor(readonly raison: RaisonRefus, message: string) {
    super(message);
    this.name = 'ErreurApplication';
  }
}

export interface DepsSessions {
  comptes: ComptesApplication;
  ouvrir(compte: CompteApplication, rappels: RappelsSession): Promise<Session>;
  enfiler(job: JobEntrant): Promise<void>;
  /** Dire au développeur que son numéro est coupé (banni) ou que l'appareil a été retiré (déconnecté). */
  prevenir(compte: CompteApplication, quoi: 'banni' | 'deconnecte'): Promise<void>;
  /** Effacer l'état d'un compte qui n'a pas de session ouverte. */
  effacer(compteId: string): Promise<void>;
  attendre?(ms: number): Promise<void>;
}

export interface GestionnaireSessions {
  reprendre(): Promise<void>;
  relier(compteId: string): Promise<void>;
  qr(compteId: string): Promise<{ qr: string | null; ouverte: boolean; statut: StatutCompte | null }>;
  envoyer(compteId: string, destinataire: string, texte: string): Promise<string>;
  sommeil(compteId: string): Promise<void>;
  retirer(compteId: string): Promise<void>;
  arreter(): void;
}

interface Entree {
  session: Session | null;
  ouverte: boolean;
  qr: string | null;
  tentative: number;
  arret: boolean;
}

/** Un compte se relie s'il attend son QR code, est relié, ou dort. Jamais banni, déconnecté ni retiré. */
const RELIABLES: ReadonlySet<StatutCompte> = new Set(['en_attente', 'relie', 'sommeil']);

const versJson = (m: MessageApplication): MessageApplicationJson => ({ ...m, horodatage: m.horodatage.toISOString() });

export function creerGestionnaireSessions(d: DepsSessions): GestionnaireSessions {
  const entrees = new Map<string, Entree>();
  const attendre = d.attendre ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const lire = async (compteId: string): Promise<CompteApplication> => {
    const c = await d.comptes.parId(compteId);
    if (!c) throw new ErreurApplication('compte_inconnu', `compte ${compteId} inconnu`);
    return c;
  };

  async function ouvrir(compte: CompteApplication, entree: Entree): Promise<void> {
    const actuelle = () => entrees.get(compte.id) === entree && !entree.arret;
    const rappels: RappelsSession = {
      qr(texte) {
        if (actuelle()) entree.qr = texte;
      },
      async ouverte(jid) {
        if (!actuelle()) return;
        entree.ouverte = true;
        entree.qr = null;
        entree.tentative = 0;
        await d.comptes.marquer(compte.id, 'relie', jid ? { jid } : {});
      },
      async message(m) {
        await d.enfiler({ tenantId: compte.tenantId, compteId: compte.id, message: versJson(m) });
        await d.comptes.toucher(compte.id, m.horodatage);
      },
      async fermee(cause: CauseFermeture, code) {
        if (!actuelle()) return;
        entree.ouverte = false;
        entree.session = null;
        const etat = await d.comptes.parId(compte.id);
        if (cause === 'banni' || cause === 'deconnecte') {
          entrees.delete(compte.id);
          await d.comptes.marquer(compte.id, cause);
          await d.prevenir(etat ?? compte, cause);
          return;
        }
        // Un QR code qui n'a pas été scanné expire : on ne relance pas l'appairage en boucle. Le développeur le
        // redemande en rouvrant la page du lien. Seul le 515 qui suit un appairage réussi rouvre la session.
        if (etat?.statut === 'en_attente' && code !== DisconnectReason.restartRequired) {
          entrees.delete(compte.id);
          return;
        }
        entree.tentative += 1;
        const delai = code === DisconnectReason.restartRequired && entree.tentative === 1 ? 0 : delaiBackoff(entree.tentative - 1);
        await attendre(delai);
        if (actuelle()) await ouvrir(etat ?? compte, entree);
      },
    };
    try {
      entree.session = await d.ouvrir(compte, rappels);
    } catch (err) {
      // L'ouverture elle-même a échoué (réseau, version de WhatsApp) : une coupure comme une autre.
      console.error(`application ${compte.id} : ouverture impossible`, err);
      await rappels.fermee('reprise', undefined);
    }
  }

  async function relier(compteId: string): Promise<void> {
    const compte = await lire(compteId);
    if (!RELIABLES.has(compte.statut)) {
      throw new ErreurApplication('statut', `compte ${compteId} ${compte.statut} : une nouvelle préparation est nécessaire`);
    }
    if (entrees.has(compteId)) return;
    const entree: Entree = { session: null, ouverte: false, qr: null, tentative: 0, arret: false };
    entrees.set(compteId, entree);
    await ouvrir(compte, entree);
  }

  return {
    async reprendre() {
      for (const c of await d.comptes.relies()) {
        if (reprendAuDemarrage(c.statut)) await relier(c.id);
      }
    },
    relier,
    async qr(compteId) {
      const e = entrees.get(compteId);
      const c = await d.comptes.parId(compteId);
      return { qr: e?.qr ?? null, ouverte: e?.ouverte ?? false, statut: c?.statut ?? null };
    },
    async envoyer(compteId, destinataire, texte) {
      const e = entrees.get(compteId);
      if (!e?.ouverte || !e.session) throw new ErreurApplication('non_relie', `compte ${compteId} non relié`);
      return e.session.envoyer(destinataire, texte);
    },
    async sommeil(compteId) {
      const e = entrees.get(compteId);
      if (e) {
        e.arret = true;
        e.session?.fermer();
        entrees.delete(compteId);
      }
      await d.comptes.marquer(compteId, 'sommeil');
    },
    async retirer(compteId) {
      const e = entrees.get(compteId);
      if (e) {
        e.arret = true;
        entrees.delete(compteId);
      }
      if (e?.session) {
        try {
          await e.session.retirer();
        } catch (err) {
          console.error(`application ${compteId} : retrait de l'appareil en échec, état effacé quand même`, err);
          await d.effacer(compteId);
        }
      } else {
        await d.effacer(compteId);
      }
      await d.comptes.marquer(compteId, 'retire');
    },
    arreter() {
      for (const e of entrees.values()) {
        e.arret = true;
        e.session?.fermer();
      }
      entrees.clear();
    },
  };
}
