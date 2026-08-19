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

export type EmailTemplateFormat = 'basic' | 'html';

export interface EmailTemplate {
  id: string;
  tenantId: string;
  name: string;
  format: EmailTemplateFormat;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTemplateInput {
  name: string;
  format: EmailTemplateFormat;
  subject: string;
  body: string;
}

/** Mise à jour partielle : seuls les champs fournis sont modifiés. */
export type EmailTemplateUpdate = Partial<EmailTemplateInput>;
