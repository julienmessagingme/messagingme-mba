import nodemailer, { type Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';

export interface SmtpMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/** Construit un transport nodemailer à partir d'une boîte SMTP déchiffrée. Le mot de passe en clair ne
 *  transite que dans cet appel, jamais journalisé ni renvoyé. */
export function buildTransport(account: DecryptedEmailAccount): Transporter {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: account.password },
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
    replyTo: account.replyTo ?? undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
