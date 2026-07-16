'use client';

import { Fragment } from 'react';
import type { TemplateButtonInput } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Rendu du formatage WhatsApp (*gras*, _italique_, ~barré~, `mono`) en noeuds React. */
function formatInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const inner = tok.slice(1, -1);
    if (tok.startsWith('*')) nodes.push(<strong key={key++}>{inner}</strong>);
    else if (tok.startsWith('_')) nodes.push(<em key={key++}>{inner}</em>);
    else if (tok.startsWith('~')) nodes.push(<s key={key++}>{inner}</s>);
    else nodes.push(<code key={key++} className="font-mono text-[12px]">{inner}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const UrlIcon = () => (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 5h5v5M19 5l-8 8M12 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-6" />
  </svg>
);
const ReplyIcon = () => (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 17l-5-5 5-5M4 12h11a5 5 0 015 5v1" />
  </svg>
);

/**
 * Rendu du corps : les runs de texte passent par formatInline, chaque `{{n}}` devient soit un CHIP `[Label]`
 * (si `varLabels[n-1]` fourni — mode création de template : on identifie la variable), soit sa valeur
 * d'exemple (sinon `{{n}}`). Les chips ne s'affichent que si des labels sont passés ; ailleurs (campagne,
 * aperçu), on garde la substitution par exemple.
 */
function renderBody(body: string, examples: string[], varLabels?: Array<string | undefined>): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={`t${key++}`}>{formatInline(body.slice(last, m.index))}</Fragment>);
    const n = Number(m[1]);
    const label = varLabels?.[n - 1];
    if (label) {
      nodes.push(<span key={`v${key++}`} className="mx-0.5 inline-flex items-center rounded bg-brand-100 px-1.5 py-0.5 text-[12px] font-medium text-brand-700">{label}</span>);
    } else {
      const v = examples[n - 1];
      nodes.push(<Fragment key={`e${key++}`}>{v && v.trim() ? v : `{{${n}}}`}</Fragment>);
    }
    last = m.index + m[0].length;
  }
  if (last < body.length) nodes.push(<Fragment key={`t${key++}`}>{formatInline(body.slice(last))}</Fragment>);
  return nodes;
}

export interface WhatsAppPreviewProps {
  body: string;
  /** Valeurs des variables {{n}} ; si absent/vide, la variable reste affichée `{{n}}`. */
  examples: string[];
  /** Libellés de champ par position ({{1}} -> varLabels[0]) : affiche un chip `[Label]` au lieu de l'exemple.
   *  Absent -> substitution par exemple (comportement campagne/aperçu). */
  varLabels?: Array<string | undefined>;
  buttons: TemplateButtonInput[];
  /** En-tête : texte (rendu tel quel) ou média (image/vidéo/document). `mediaUrl` = source affichable locale (data
   *  URL / object URL du fichier choisi) ; si fournie pour une IMAGE/VIDEO, on l'affiche, sinon un placeholder. */
  header?: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'; text?: string; mediaUrl?: string } | null;
  /** Pied de page : petit texte gris sous le corps. */
  footer?: string;
  /** Nom affiché dans l'en-tête (défaut = le nom vérifié du WABA). */
  senderName?: string;
  /** Masque la petite note sous l'aperçu (formatage supporté). */
  hideNote?: boolean;
}

const MEDIA_ICON: Record<'IMAGE' | 'VIDEO' | 'DOCUMENT', string> = { IMAGE: '🖼️', VIDEO: '🎬', DOCUMENT: '📄' };

/** Aperçu façon fenêtre WhatsApp (message reçu = bulle blanche à gauche). Partagé Templates + Campagnes. */
export function WhatsAppPreview({ body, examples, varLabels, buttons, header, footer, senderName = 'Messaging Me Tech', hideNote = false }: WhatsAppPreviewProps) {
  const t = useT();
  const mediaHeader = header && header.format !== 'TEXT' ? header.format : null;
  const textHeader = header && header.format === 'TEXT' && header.text?.trim() ? header.text : null;
  // Source média affichable (image/vidéo uploadée localement) : on montre le vrai visuel plutôt que l'icône.
  const mediaUrl = header && header.format !== 'TEXT' ? header.mediaUrl : undefined;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">{t('Aperçu WhatsApp', 'WhatsApp preview')}</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center gap-2 bg-[#075E54] px-3 py-2 text-white">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-sm">🏢</div>
          <div className="leading-tight">
            <div className="text-sm font-medium">{senderName}</div>
            <div className="text-[10px] text-white/70">{t('en ligne', 'online')}</div>
          </div>
        </div>
        <div className="min-h-[220px] px-3 py-4" style={{ backgroundColor: '#efeae2' }}>
          <div className="max-w-[88%]">
            <div className="rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 shadow-sm">
              {mediaHeader && (
                mediaUrl && mediaHeader === 'IMAGE' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaUrl} alt="" className="-mx-2.5 -mt-1.5 mb-1.5 h-28 w-[calc(100%+1.25rem)] max-w-none rounded-t-lg object-cover" />
                ) : mediaUrl && mediaHeader === 'VIDEO' ? (
                  <video src={mediaUrl} muted className="-mx-2.5 -mt-1.5 mb-1.5 h-28 w-[calc(100%+1.25rem)] max-w-none rounded-t-lg bg-black object-cover" />
                ) : (
                  <div className="-mx-2.5 -mt-1.5 mb-1.5 flex h-24 items-center justify-center rounded-t-lg bg-ink-100 text-3xl text-ink-400">
                    {MEDIA_ICON[mediaHeader]}
                  </div>
                )
              )}
              {textHeader && <div className="mb-1 break-words text-[13px] font-semibold text-ink-900">{textHeader}</div>}
              <div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-ink-800">
                {body.trim() ? renderBody(body, examples, varLabels) : <span className="text-ink-400">{t('Le message apparaîtra ici…', 'Your message will appear here…')}</span>}
              </div>
              {footer?.trim() && <div className="mt-1 break-words text-[11px] leading-snug text-ink-400">{footer}</div>}
              <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-400">
                12:30 <span className="text-[#53bdeb]">✓✓</span>
              </div>
              {buttons.length > 0 && (
                <div className="-mx-2.5 -mb-1.5 mt-1.5">
                  {buttons.map((b, i) => (
                    <div key={i} className="flex items-center justify-center gap-1.5 border-t border-ink-100 py-2 text-[13px] font-medium text-[#00a5f4]">
                      {b.type === 'URL' ? <UrlIcon /> : <ReplyIcon />}
                      {b.text?.trim() || (b.type === 'URL' ? t('Lien', 'Link') : t('Réponse', 'Reply'))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {!hideNote && (
        <p className="mt-2 text-[11px] text-ink-400">{t("Le rendu réel peut varier légèrement selon l'appareil. *gras*, _italique_, ~barré~ sont supportés.", 'The actual rendering may vary slightly by device. *bold*, _italic_, ~strikethrough~ are supported.')}</p>
      )}
    </div>
  );
}
