import nodemailer, { type Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';
import type { Socket } from 'node:net';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { ouvrirSocketPublique } from '../lib/connexion-publique';

export interface SmtpMessage {
  to: string;
  /** Destinataires en copie cachée, qui ne voient ni les autres adresses ni celle du « À ». Absent ou vide : aucun
   *  en-tête `bcc`. */
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Construit un transport nodemailer à partir d'une boîte SMTP déchiffrée. Le mot de passe ne transite que dans cet
 * appel, jamais journalisé ni renvoyé.
 *
 * 🔴 L'hôte est saisi par un administrateur d'espace : la socket est ouverte par nous (`getSocket`), par
 * `ouvrirSocketPublique`, qui refuse un hôte interne (localhost, réseau Docker, nom qui y résout) à chaque envoi,
 * avant qu'un octet ne parte (reconnaissable à `estRefusAdresseInterne`). Nodemailer garde le nom d'hôte pour TLS.
 */
export function buildTransport(
  account: DecryptedEmailAccount,
  ouvrir: (hote: string, port: number) => Promise<Socket> = (hote, port) => ouvrirSocketPublique(hote, port),
): Transporter {
  // Le même nom pour la socket et pour TLS, nettoyé des espaces et des crochets d'une IPv6 : sinon la socket vérifiée
  // et le SNI porteraient sur deux textes différents.
  const hote = account.host.trim().replace(/^\[|\]$/g, '');
  return nodemailer.createTransport({
    host: hote,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: account.password },
    getSocket: (_options: SMTPTransport.Options, rappel: (err: Error | null, socketOptions: unknown) => void) => {
      ouvrir(hote, account.port).then((connection) => rappel(null, { connection }), (err: Error) => rappel(err, null));
    },
  });
}

/** Envoie un email par le transport fourni. `from` porte le nom de la boîte s'il existe ; `replyTo` n'est posé que
 *  si la boîte en a un. */
export async function sendSmtpEmail(
  transport: Transporter,
  account: DecryptedEmailAccount,
  msg: SmtpMessage,
): Promise<void> {
  await transport.sendMail({
    from: account.fromName ? { name: account.fromName, address: account.fromAddress } : account.fromAddress,
    to: msg.to,
    // Posé seulement s'il y a des destinataires cachés : les tests comparent l'objet remis à nodemailer au caractère près.
    ...(msg.bcc && msg.bcc.length > 0 ? { bcc: msg.bcc } : {}),
    replyTo: account.replyTo ?? undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
