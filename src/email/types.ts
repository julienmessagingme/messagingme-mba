export interface EmailAccount {
  id: string;
  tenantId: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** En mémoire uniquement, jamais sérialisé vers le client. */
export interface DecryptedEmailAccount extends EmailAccount {
  password: string;
}

export interface EmailAccountInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
}

/** Mise à jour : le mot de passe n'est re-chiffré que s'il est fourni. */
export type EmailAccountUpdate = Partial<EmailAccountInput>;
