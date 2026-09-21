import nodemailer, { type Transporter } from 'nodemailer';
import type { DecryptedEmailAccount } from './types';
import { adressePubliqueDe } from '../lib/connexion-publique';

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
 * 🔴 L'HÔTE EST SAISI PAR UN ADMINISTRATEUR D'ESPACE, DONC IL SE VÉRIFIE COMME UNE URL DE CONNECTEUR (2026-09-21).
 * Il partait tel quel vers nodemailer : `localhost`, `172.18.0.1` (le réseau Docker du VPS) ou un nom public
 * qui y résout ouvraient une connexion depuis notre réseau, et le bouton « Tester » en rapportait le succès ou
 * l'échec. Ici l'hôte est résolu UNE fois, refusé si une seule de ses adresses est interne, et nodemailer se
 * connecte à l'ADRESSE vérifiée : il ne refait donc aucune résolution, et le « DNS rebinding » n'a pas d'écart
 * où se glisser. Le NOM d'origine part à part (`tls.servername`) : c'est sur lui que portent le SNI et la
 * vérification du certificat, en TLS direct comme après STARTTLS.
 *
 * ⚠️ Le transport est mis en cache (`EmailAccountResolver`, 5 minutes) : il reste lié à l'adresse vérifiée
 * pendant ce temps, puis la résolution est refaite.
 */
export async function buildTransport(
  account: DecryptedEmailAccount,
  resoudre: (hote: string) => Promise<string> = (hote) => adressePubliqueDe(hote),
): Promise<Transporter> {
  const adresse = await resoudre(account.host);
  return nodemailer.createTransport({
    host: adresse,
    port: account.port,
    secure: account.secure,
    tls: { servername: account.host.trim() },
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
