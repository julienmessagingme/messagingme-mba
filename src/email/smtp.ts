import nodemailer, { type Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';

export interface SmtpMessage {
  to: string;
  /** Destinataires en COPIE CACHÉE. Ils ne voient pas les adresses les uns des autres, ni celle du « À ».
   *  Absent ou vide -> aucun en-tête `bcc` n'est posé (voir `sendSmtpEmail`). */
  bcc?: string[];
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
    // Posé SEULEMENT s'il y a des destinataires cachés : passer `bcc: []` ou `bcc: undefined` change l'objet
    // remis à nodemailer, et les tests de ce module comparent cet objet au caractère près.
    ...(msg.bcc && msg.bcc.length > 0 ? { bcc: msg.bcc } : {}),
    replyTo: account.replyTo ?? undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
