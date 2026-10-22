// La session d'un compte de l'application WhatsApp Business, reliée comme appareil lié. Construite sur le transport
// de wagroups (commit 526d3cc, `src/transport/baileys/transport.ts` : options du socket, sauvegarde des identifiants,
// lecture de la fermeture par la forme de l'erreur), réduite à ce que la filière application fait : le QR code, les
// conversations individuelles, l'envoi d'un texte. Les types de Baileys ne sortent pas de ce dossier.
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, type proto, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import type { Pool } from 'pg';
import { estIndividuel, type TypeMessageApplication } from '../message';
import { codeDeconnexion } from './connexion';
import { correspondancesPostgres, effacerEtatAuth, etatAuthPostgres, type Correspondances } from './etat-auth';

export type CauseFermeture = 'reprise' | 'banni' | 'deconnecte';

/** 403 : WhatsApp a coupé le numéro. 401 : l'appareil a été retiré depuis le téléphone. Le reste : une reprise. */
export function causeDeFermeture(code: number | undefined): CauseFermeture {
  if (code === DisconnectReason.forbidden) return 'banni';
  if (code === DisconnectReason.loggedOut) return 'deconnecte';
  return 'reprise';
}

/**
 * Le compte est-il relié ? Par code d'appairage, Baileys pose `registered` ; par QR code, il ne pose que l'identité du
 * compte (`me`), mesuré sur l'essai du 2026-10-21. Les deux comptent.
 */
export function estRelie(creds: { me?: { id?: string } | null; registered?: boolean }): boolean {
  return Boolean(creds.registered) || Boolean(creds.me?.id);
}

/** Un message de l'application, sans rien de Baileys. */
export interface MessageApplication {
  id: string;
  /** La conversation : `<chiffres>@s.whatsapp.net`, `<identifiant masqué>@lid`, ou un groupe (`@g.us`). */
  jid: string;
  /** Tapé sur le téléphone du compte (ou envoyé par nous) plutôt que reçu. */
  deMoi: boolean;
  nom: string | null;
  horodatage: Date;
  type: TypeMessageApplication;
  texte: string | null;
  /** Les chiffres du numéro du contact quand WhatsApp les donne, même pour un identifiant masqué. */
  numero: string | null;
}

export interface RappelsSession {
  qr(texte: string): void | Promise<void>;
  ouverte(jid: string): void | Promise<void>;
  message(m: MessageApplication): void | Promise<void>;
  fermee(cause: CauseFermeture, code: number | undefined): void | Promise<void>;
}

export interface Session {
  /** Envoie un texte ; rend l'identifiant du message. */
  envoyer(destinataire: string, texte: string): Promise<string>;
  /** Ferme la socket sans toucher à la session côté WhatsApp (sommeil, arrêt du service). */
  fermer(): void;
  /** Retire l'appareil lié côté WhatsApp, puis efface l'état : un nouvel appairage sera nécessaire. */
  retirer(): Promise<void>;
}

/** Le journal attendu par Baileys : les avertissements et les erreurs vont à la console, le reste se tait. */
type JournalBaileys = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>;
function journalBaileys(compteId: string): JournalBaileys {
  const j = {
    level: 'warn',
    child: () => j,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (o: unknown, m?: string) => console.warn(`application ${compteId} :`, m ?? '', o),
    error: (o: unknown, m?: string) => console.error(`application ${compteId} :`, m ?? '', o),
  };
  return j as unknown as JournalBaileys;
}

const chiffres = (jid: string | null | undefined): string | null => {
  const avant = jid?.split('@')[0]?.split(':')[0] ?? '';
  return /^[0-9]{8,15}$/.test(avant) ? avant : null;
};

/** Le texte et le type d'un message de Baileys, ou `null` pour ce qui n'est pas un message (réaction, suppression...). */
function contenu(brut: WAMessage): { type: TypeMessageApplication; texte: string | null } | null {
  const c = normalizeMessageContent(brut.message);
  if (!c) return null;
  if (c.conversation) return { type: 'text', texte: c.conversation };
  if (c.extendedTextMessage?.text) return { type: 'text', texte: c.extendedTextMessage.text };
  if (c.imageMessage) return { type: 'image', texte: c.imageMessage.caption ?? null };
  if (c.videoMessage) return { type: 'video', texte: c.videoMessage.caption ?? null };
  if (c.audioMessage) return { type: 'audio', texte: null };
  if (c.documentMessage) return { type: 'document', texte: c.documentMessage.fileName ?? null };
  if (c.stickerMessage) return { type: 'sticker', texte: null };
  return null;
}

/**
 * Un message de Baileys en message de l'application, ou `null`.
 *
 * 🔴 Le numéro joint à un message (`senderPn`) est celui de l'EXPÉDITEUR : pour un message tapé sur le téléphone du
 * compte, c'est le nôtre (`decodeMessageNode`, Baileys 6.7.23). Il ne sert donc qu'à un message reçu ; celui d'un
 * message tapé vers un contact masqué se retrouve par `completerNumero`.
 */
export function versMessageApplication(brut: WAMessage): MessageApplication | null {
  const jid = brut.key?.remoteJid;
  const id = brut.key?.id;
  if (!jid || !id || !estIndividuel(jid)) return null;
  const c = contenu(brut);
  if (!c) return null;
  const deMoi = Boolean(brut.key.fromMe);
  const cle: Record<string, unknown> = { ...brut.key };
  const pn = typeof cle.senderPn === 'string' ? cle.senderPn : null;
  return {
    id, jid, deMoi, nom: brut.pushName ?? null,
    horodatage: new Date(Number(brut.messageTimestamp ?? 0) * 1000), type: c.type, texte: c.texte,
    numero: jid.endsWith('@s.whatsapp.net') ? chiffres(jid) : deMoi ? null : chiffres(pn),
  };
}

/**
 * Le numéro d'un contact masqué : appris de ses messages reçus, retrouvé pour ceux qu'on lui tape depuis le téléphone.
 * Sans lui, la réponse du téléphone tomberait dans une autre conversation que le message auquel elle répond, et la
 * prise de main viserait la mauvaise.
 */
export async function completerNumero(m: MessageApplication, c: Pick<Correspondances, 'retenir' | 'numeroDe'>): Promise<MessageApplication> {
  if (!m.jid.endsWith('@lid')) return m;
  if (!m.deMoi && m.numero) {
    await c.retenir(m.jid, m.numero);
    return m;
  }
  if (m.deMoi && !m.numero) return { ...m, numero: await c.numeroDe(m.jid) };
  return m;
}

/**
 * Les options du socket. 🔴 `emitOwnEvents: false` : sinon Baileys renvoie chacun de nos envois comme un message « de
 * moi », et chaque réponse de l'agent passerait pour une réponse tapée sur le téléphone, donc pour une prise de main.
 * Les messages tapés sur le téléphone arrivent, eux, par la réception ordinaire.
 */
export const OPTIONS_SOCKET = {
  browser: ['Messaging Me', 'Chrome', '1.0.0'] as [string, string, string],
  markOnlineOnConnect: false,
  syncFullHistory: false,
  emitOwnEvents: false,
} as const;

/**
 * LES DERNIERS MESSAGES ENVOYÉS D'UNE SESSION, gardés pour les renvoyer (essai réel du 2026-10-22). Chaque appareil du
 * client déchiffre sa propre copie ; celui qui échoue en demande un renvoi, et Baileys ne renvoie que ce que
 * `getMessage` lui rend (`sendMessagesAgain`, `Socket/messages-recv.js`, 6.7.23 ; par défaut, rien). Sans elle, une
 * réponse restait « En attente de ce message » sur le mobile et s'affichait sur l'ordinateur. En mémoire et bornée : un
 * renvoi se demande dans les secondes qui suivent, et une copie perdue au redémarrage du service n'est plus renvoyable.
 */
export interface MemoireDesEnvois {
  retenir(id: string, message: proto.IMessage): void;
  retrouver(id: string | null | undefined): proto.IMessage | undefined;
}

export function memoireDesEnvois(borne = 500): MemoireDesEnvois {
  const messages = new Map<string, proto.IMessage>();
  return {
    retenir(id, message) {
      messages.delete(id);
      messages.set(id, message);
      // Une Map garde l'ordre d'insertion : la première clé est la plus ancienne.
      if (messages.size > borne) messages.delete(messages.keys().next().value as string);
    },
    retrouver: (id) => (id ? messages.get(id) : undefined),
  };
}

/**
 * Une mémoire des envois PAR COMPTE, et non par session : le gestionnaire rouvre la session à chaque reprise (515, 428,
 * coupure réseau), et un renvoi demandé juste après doit retrouver les envois d'avant (relecture du 2026-10-22).
 */
export function memoiresDesComptes(): (compteId: string) => MemoireDesEnvois {
  const memoires = new Map<string, MemoireDesEnvois>();
  return (compteId) => {
    let m = memoires.get(compteId);
    if (!m) {
      m = memoireDesEnvois();
      memoires.set(compteId, m);
    }
    return m;
  };
}

/** Les options du socket d'une session, avec `getMessage` sur la mémoire des envois de son compte. */
export function optionsDuSocket(memoire: Pick<MemoireDesEnvois, 'retrouver'>) {
  return { ...OPTIONS_SOCKET, getMessage: async (cle: { id?: string | null }) => memoire.retrouver(cle.id) };
}

/**
 * L'ADRESSE D'UNE RÉPONSE (essai réel du 2026-10-22) : l'identifiant masqué du contact quand il nous a écrit depuis lui,
 * sinon son numéro. WhatsApp adresse la plupart des conversations par identifiant masqué : une réponse envoyée au numéro
 * arrivait sur l'ordinateur du contact et restait « En attente de ce message » sur son mobile ; la même, adressée à son
 * identifiant masqué, est arrivée sur les deux (mesuré sur newCompany). La conversation garde le numéro pour clé.
 */
export async function adresseDeReponse(destinataire: string, c: Pick<Correspondances, 'lidDe'>): Promise<string> {
  if (!destinataire.endsWith('@s.whatsapp.net')) return destinataire;
  const numero = chiffres(destinataire);
  return (numero ? await c.lidDe(numero) : null) ?? destinataire;
}

/**
 * Envoie un texte à l'adresse que `adresser` choisit, garde le message accepté par WhatsApp sous l'identifiant qu'il
 * rend, et rend cet identifiant.
 */
export function envoyeur(
  sock: { sendMessage(jid: string, contenu: { text: string }): Promise<{ key?: { id?: string | null }; message?: proto.IMessage | null } | undefined> },
  memoire: Pick<MemoireDesEnvois, 'retenir'>,
  adresser: (destinataire: string) => Promise<string>,
): (destinataire: string, texte: string) => Promise<string> {
  return async (destinataire, texte) => {
    const r = await sock.sendMessage(await adresser(destinataire), { text: texte });
    const id = r?.key?.id;
    if (!id) throw new Error('WhatsApp n’a rendu aucun identifiant de message');
    if (r.message) memoire.retenir(id, r.message);
    return id;
  };
}

/** Ouvre la session d'un compte sur son état enregistré (un compte neuf reçoit un QR code par `rappels.qr`). */
export async function ouvrirSession(
  compte: { id: string }, auth: { pool: Pool; cle: Buffer }, rappels: RappelsSession, envois: MemoireDesEnvois,
): Promise<Session> {
  const { state, saveCreds } = await etatAuthPostgres(auth.pool, compte.id, auth.cle);
  const correspondances = correspondancesPostgres(auth.pool, compte.id, auth.cle);
  const { version } = await fetchLatestBaileysVersion();
  const sock: WASocket = makeWASocket({ version, auth: state, logger: journalBaileys(compte.id), ...optionsDuSocket(envois) });

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (err) {
      // Des clés de Signal non sauvegardées peuvent faire perdre la session au prochain redémarrage.
      console.error(`application ${compte.id} : identifiants NON sauvegardés`, err);
    }
  });
  sock.ev.on('connection.update', async (u) => {
    // Un rejet ici sortirait du gestionnaire d'événements et ferait tomber tout le service (relecture du lot) : il se
    // journalise, la session suivante reprendra.
    try {
      if (u.qr) await rappels.qr(u.qr);
      if (u.connection === 'open') await rappels.ouverte(sock.user?.id ?? '');
      if (u.connection === 'close') {
        const code = codeDeconnexion(u.lastDisconnect?.error);
        await rappels.fermee(causeDeFermeture(code), code);
      }
    } catch (err) {
      console.error(`application ${compte.id} : changement de connexion non traité`, err);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const brut of messages) {
      const lu = versMessageApplication(brut);
      if (!lu) continue;
      try {
        const m = await completerNumero(lu, correspondances);
        await rappels.message(m);
      } catch (err) {
        console.error(`application ${compte.id} : message ${lu.id} non traité`, err);
      }
    }
  });

  return {
    envoyer: envoyeur(sock, envois, (destinataire) => adresseDeReponse(destinataire, correspondances)),
    fermer() {
      // end() ferme la socket sans détruire la session côté WhatsApp, contrairement à logout().
      sock.end(undefined);
    },
    async retirer() {
      try {
        await sock.logout();
      } finally {
        await effacerEtatAuth(auth.pool, compte.id);
      }
    },
  };
}
