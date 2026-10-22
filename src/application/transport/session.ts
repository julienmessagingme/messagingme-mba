// La session d'un compte de l'application WhatsApp Business, reliée comme appareil lié. Construite sur le transport
// de wagroups (commit 526d3cc, `src/transport/baileys/transport.ts` : options du socket, sauvegarde des identifiants,
// lecture de la fermeture par la forme de l'erreur), réduite à ce que la filière application fait : le QR code, les
// conversations individuelles, l'envoi d'un texte. Les types de Baileys ne sortent pas de ce dossier.
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import type { Pool } from 'pg';
import { codeDeconnexion } from './connexion';
import { effacerEtatAuth, etatAuthPostgres } from './etat-auth';

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

export type TypeMessageApplication = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker';

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

/** Un message de Baileys en message de l'application, ou `null`. */
export function versMessageApplication(brut: WAMessage): MessageApplication | null {
  const jid = brut.key?.remoteJid;
  const id = brut.key?.id;
  if (!jid || !id) return null;
  const c = contenu(brut);
  if (!c) return null;
  const cle: Record<string, unknown> = { ...brut.key };
  const pn = typeof cle.senderPn === 'string' ? cle.senderPn : null;
  return {
    id, jid, deMoi: Boolean(brut.key.fromMe), nom: brut.pushName ?? null,
    horodatage: new Date(Number(brut.messageTimestamp ?? 0) * 1000), type: c.type, texte: c.texte,
    numero: chiffres(jid.endsWith('@s.whatsapp.net') ? jid : pn),
  };
}

/** Ouvre la session d'un compte sur son état enregistré (un compte neuf reçoit un QR code par `rappels.qr`). */
export async function ouvrirSession(compte: { id: string }, auth: { pool: Pool; cle: Buffer }, rappels: RappelsSession): Promise<Session> {
  const { state, saveCreds } = await etatAuthPostgres(auth.pool, compte.id, auth.cle);
  const { version } = await fetchLatestBaileysVersion();
  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    logger: journalBaileys(compte.id),
    browser: ['Messaging Me', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (err) {
      // Des clés de Signal non sauvegardées peuvent faire perdre la session au prochain redémarrage.
      console.error(`application ${compte.id} : identifiants NON sauvegardés`, err);
    }
  });
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) await rappels.qr(u.qr);
    if (u.connection === 'open') await rappels.ouverte(sock.user?.id ?? '');
    if (u.connection === 'close') {
      const code = codeDeconnexion(u.lastDisconnect?.error);
      await rappels.fermee(causeDeFermeture(code), code);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const brut of messages) {
      const m = versMessageApplication(brut);
      if (!m) continue;
      try {
        await rappels.message(m);
      } catch (err) {
        console.error(`application ${compte.id} : message ${m.id} non traité`, err);
      }
    }
  });

  return {
    async envoyer(destinataire, texte) {
      const r = await sock.sendMessage(destinataire, { text: texte });
      const id = r?.key?.id;
      if (!id) throw new Error('WhatsApp n’a rendu aucun identifiant de message');
      return id;
    },
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
