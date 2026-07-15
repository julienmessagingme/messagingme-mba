/**
 * Gabarits d'email HTML brandés « Messaging Me / Business Agent ».
 *
 * Fonctions PURES (aucune dépendance réseau ou d'état) -> testables et réutilisables.
 * `renderBrandedEmail` rend un shell générique (invitation aujourd'hui, reset de mot de passe
 * demain) : tables + styles INLINE pour la compat Gmail/Outlook, largeur ~600px, en-tête aux
 * 3 couleurs de la marque, bouton CTA construit en table (pas de <button>), pied discret.
 *
 * ⚠️ Gmail STRIPPE les <img> hors PNG/JPG et bloque souvent le chargement des images par défaut :
 * l'identité tient sans image (wordmark + barre d'accent colorée en CSS/table). Le logo PNG hébergé
 * n'est qu'un bonus pour les clients qui l'affichent, posé sur une cellule à fond blanc explicite
 * pour rester visible même en mode sombre.
 */

// Couleurs de marque (icon.svg) : navy, bleu, vert.
const NAVY = '#181C40';
const BLUE = '#009AFE';
const GREEN = '#17C74E';
const INK = '#2b2f36'; // texte courant
const MUTED = '#6b7280'; // texte secondaire / pied
const PAGE_BG = '#f4f6fb'; // fond de page
const CARD_BG = '#ffffff';
const BORDER = '#e6e9f0';
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** URL publique du logo rasterisé (PNG, servi par le front). Gmail rend le PNG ; l'alt couvre le blocage d'images. */
const LOGO_URL = 'https://mba.messagingme.app/logo.png';

/**
 * Échappe le HTML pour toute donnée non fiable injectée dans le gabarit (nom d'invitant, nom de
 * workspace, libellés). Empêche qu'un « & » ou un « < » casse le markup, ou qu'une valeur
 * contrôlée par l'utilisateur injecte des balises.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BrandedEmailInput {
  /** Titre affiché en gros dans le corps (déjà lisible en clair, sera échappé). */
  title: string;
  /** Corps HTML DÉJÀ échappé/construit par l'appelant (peut contenir des <p>, <strong>...). */
  bodyHtml: string;
  /** Libellé du bouton d'action (sera échappé). */
  ctaLabel: string;
  /** URL cible du bouton (sera échappée en attribut). */
  ctaUrl: string;
  /** Texte de prévisualisation (aperçu dans la boîte de réception). Facultatif. */
  preheader?: string;
  /** Ligne de pied additionnelle (ex. durée de validité du lien). Facultatif, sera échappée. */
  footnote?: string;
}

/**
 * Shell HTML brandé et réutilisable. `bodyHtml` est inséré tel quel : l'appelant est responsable
 * d'échapper les données non fiables qu'il y met (utiliser `escapeHtml`).
 */
export function renderBrandedEmail(input: BrandedEmailInput): string {
  const { title, bodyHtml, ctaLabel, ctaUrl, preheader, footnote } = input;
  const safeTitle = escapeHtml(title);
  const safeCtaLabel = escapeHtml(ctaLabel);
  const safeCtaUrl = escapeHtml(ctaUrl);
  const pre = preheader ? escapeHtml(preheader) : '';
  const foot = footnoteBlock(footnote);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG};">
${pre ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${pre}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
        <!-- Barre d'accent 3 couleurs -->
        <tr>
          <td style="padding:0;font-size:0;line-height:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="33.33%" height="6" style="height:6px;background-color:${NAVY};font-size:0;line-height:0;">&nbsp;</td>
                <td width="33.33%" height="6" style="height:6px;background-color:${BLUE};font-size:0;line-height:0;">&nbsp;</td>
                <td width="33.34%" height="6" style="height:6px;background-color:${GREEN};font-size:0;line-height:0;">&nbsp;</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- En-tête : logo + wordmark -->
        <tr>
          <td style="padding:28px 32px 8px 32px;background-color:${CARD_BG};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:12px;">
                  <img src="${LOGO_URL}" width="40" height="40" alt="Messaging Me" style="display:block;border:0;outline:none;text-decoration:none;width:40px;height:40px;" />
                </td>
                <td valign="middle">
                  <div style="font-family:${FONT};font-size:18px;line-height:20px;font-weight:700;color:${NAVY};letter-spacing:-0.2px;">Messaging Me</div>
                  <div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;color:${BLUE};letter-spacing:0.3px;text-transform:uppercase;">Business Agent</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Corps -->
        <tr>
          <td style="padding:16px 32px 8px 32px;">
            <h1 style="margin:0 0 16px 0;font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:${NAVY};">${safeTitle}</h1>
            <div style="font-family:${FONT};font-size:15px;line-height:23px;color:${INK};">${bodyHtml}</div>
          </td>
        </tr>
        <!-- Bouton CTA (table-based) -->
        <tr>
          <td style="padding:20px 32px 8px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="border-radius:10px;background-color:${BLUE};">
                  <a href="${safeCtaUrl}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;line-height:18px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${safeCtaLabel}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Repli lien en clair -->
        <tr>
          <td style="padding:12px 32px 24px 32px;">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">Si le bouton ne fonctionne pas, copie ce lien dans ton navigateur :<br /><a href="${safeCtaUrl}" target="_blank" style="color:${BLUE};text-decoration:underline;word-break:break-all;">${safeCtaUrl}</a></p>
          </td>
        </tr>
        <!-- Pied -->
        <tr>
          <td style="padding:20px 32px 28px 32px;border-top:1px solid ${BORDER};background-color:${CARD_BG};">
            ${foot}
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">Messaging Me, Business Agent WhatsApp. Si tu n'attendais pas ce message, tu peux l'ignorer.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Bloc de note de pied (durée de validité...) : rendu seulement si fourni. */
function footnoteBlock(note?: string): string {
  if (!note || note.trim() === '') return '';
  return `<p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(note)}</p>`;
}

/** 'admin' | 'agent' -> libellé français lisible pour le corps de l'email. */
function roleLabel(role: string): string {
  if (role === 'admin') return 'administrateur';
  if (role === 'agent') return 'agent';
  return role;
}

export interface InvitationEmailInput {
  /** Nom (ou email) de la personne qui invite. Vide/null -> phrase générique sans nom. */
  inviterName?: string | null;
  /** Nom de l'espace de travail (tenant). Vide/null -> phrase générique sans nom d'espace. */
  workspaceName?: string | null;
  /** Lien d'acceptation (choix du mot de passe), ex. https://mba.messagingme.app/invite/<token>. */
  acceptUrl: string;
  /** Rôle attribué à l'invité ('admin' | 'agent'). */
  role: string;
}

/**
 * Email d'invitation d'équipe personnalisé : « <invitant> t'invite à rejoindre l'espace
 * <workspace> sur Messaging Me ». Retombe proprement sur des formulations génériques si le nom
 * de l'invitant ou de l'espace manque. Utilise le shell brandé.
 */
export function renderInvitationEmail(input: InvitationEmailInput): string {
  const inviter = (input.inviterName ?? '').trim();
  const workspace = (input.workspaceName ?? '').trim();
  const safeInviter = inviter ? escapeHtml(inviter) : '';
  const safeWorkspace = workspace ? escapeHtml(workspace) : '';

  // Phrase d'accroche selon les données disponibles (invitant et/ou espace connus).
  let lede: string;
  if (safeInviter && safeWorkspace) {
    lede = `<strong>${safeInviter}</strong> t'invite à rejoindre l'espace <strong>${safeWorkspace}</strong> sur Messaging Me.`;
  } else if (safeWorkspace) {
    lede = `Tu es invité à rejoindre l'espace <strong>${safeWorkspace}</strong> sur Messaging Me.`;
  } else if (safeInviter) {
    lede = `<strong>${safeInviter}</strong> t'invite à rejoindre son espace de travail sur Messaging Me.`;
  } else {
    lede = `Tu es invité à rejoindre un espace de travail sur Messaging Me.`;
  }

  const bodyHtml = [
    `<p style="margin:0 0 14px 0;">${lede}</p>`,
    `<p style="margin:0 0 14px 0;">Tu y rejoindras l'équipe avec le rôle <strong>${escapeHtml(roleLabel(input.role))}</strong>. Clique sur le bouton ci-dessous pour choisir ton mot de passe et activer ton compte.</p>`,
  ].join('\n');

  // Titre en clair : renderBrandedEmail l'échappe (une seule fois). Ne PAS pré-échapper ici (sinon double-échappement).
  const title = workspace ? `Rejoins ${workspace} sur Messaging Me` : 'Rejoins ton équipe sur Messaging Me';

  return renderBrandedEmail({
    title,
    bodyHtml,
    ctaLabel: 'Activer mon compte',
    ctaUrl: input.acceptUrl,
    preheader: inviter
      ? `${inviter} t'invite à rejoindre Messaging Me`
      : `Tu es invité à rejoindre un espace sur Messaging Me`,
    footnote: 'Ce lien d\'invitation est valable 7 jours.',
  });
}
