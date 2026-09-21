import nodemailer, { type Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';
import type { Socket } from 'node:net';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { ouvrirSocketPublique } from '../lib/connexion-publique';

export interface SmtpMessage {
  to: string;
  /** Destinataires en COPIE CACHÉE. Ils ne voient pas les adresses les uns des autres, ni celle du « À ».
   *  Absent ou vide -> aucun en-tête `bcc` n'est posé (voir `sendSmtpEmail`). */
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Construit un transport nodemailer à partir d'une boîte SMTP déchiffrée. Le mot de passe en clair ne transite
 * que dans cet appel, jamais journalisé ni renvoyé.
 *
 * 🔴 L'HÔTE EST SAISI PAR UN ADMINISTRATEUR D'ESPACE, DONC LA CONNEXION SE VÉRIFIE COMME CELLE D'UN CONNECTEUR
 * (2026-09-21). Il partait tel quel vers nodemailer : `localhost`, `172.18.0.1` (le réseau Docker du VPS) ou un
 * nom public qui y résout ouvraient une connexion depuis notre réseau, et le bouton « Tester » en rapportait le
 * succès ou l'échec. La socket est désormais ouverte par nous (`getSocket`), par `ouvrirSocketPublique` : un hôte
 * interne est refusé, à chaque envoi, avant qu'un octet ne parte, et le refus se reconnaît à
 * `estRefusAdresseInterne`. Nodemailer garde le nom d'hôte pour TLS, en TLS direct comme après STARTTLS.
 */
export function buildTransport(
  account: DecryptedEmailAccount,
  ouvrir: (hote: string, port: number) => Promise<Socket> = (hote, port) => ouvrirSocketPublique(hote, port),
): Transporter {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: account.password },
    getSocket: (_options: SMTPTransport.Options, rappel: (err: Error | null, socketOptions: unknown) => void) => {
      ouvrir(account.host, account.port).then((connection) => rappel(null, { connection }), (err: Error) => rappel(err, null));
    },
  });
}

/** Envoie un email via le transport fourni. `from` porte le nom de la boîte s'il est renseigné, sinon
 *  seulement l'adresse ; `replyTo` n'est posé que si la boîte en a un. */
export async function sendSmtpEmail(
  transport: Transporter,
  account: DecryptedEmailAccount,
  msg: SmtpMessage,
): Promise<void> {
  await transport.sendMail({
    from: account.fromName ? { name: account.fromName, address: account.fromAddress } : account.fromAddress,
    to: msg.to,
    // Posé SEULEMENT s'il y a des destinataires cachés : passer `bcc: []` ou `bcc: undefined` change l'objet
    // remis à nodemailer, et les tests de ce module comparent cet objet au caractère près.
    ...(msg.bcc && msg.bcc.length > 0 ? { bcc: msg.bcc } : {}),
    replyTo: account.replyTo ?? undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
