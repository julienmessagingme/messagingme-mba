import type { TemplateButtonInput } from '@/lib/api';

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

export interface WhatsAppPreviewProps {
  body: string;
  /** Valeurs des variables {{n}} ; si absent/vide, la variable reste affichée `{{n}}`. */
  examples: string[];
  buttons: TemplateButtonInput[];
  /** En-tête : texte (rendu tel quel) ou média (bloc placeholder image/vidéo/document). */
  header?: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'; text?: string } | null;
  /** Pied de page : petit texte gris sous le corps. */
  footer?: string;
  /** Nom affiché dans l'en-tête (défaut = le nom vérifié du WABA). */
  senderName?: string;
  /** Masque la petite note sous l'aperçu (formatage supporté). */
  hideNote?: boolean;
}

const MEDIA_ICON: Record<'IMAGE' | 'VIDEO' | 'DOCUMENT', string> = { IMAGE: '🖼️', VIDEO: '🎬', DOCUMENT: '📄' };

/** Aperçu façon fenêtre WhatsApp (message reçu = bulle blanche à gauche). Partagé Templates + Campagnes. */
export function WhatsAppPreview({ body, examples, buttons, header, footer, senderName = 'Messaging Me Tech', hideNote = false }: WhatsAppPreviewProps) {
  const text = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => {
    const v = examples[Number(n) - 1];
    return v && v.trim() ? v : `{{${n}}}`;
  });
  const mediaHeader = header && header.format !== 'TEXT' ? header.format : null;
  const textHeader = header && header.format === 'TEXT' && header.text?.trim() ? header.text : null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">Aperçu WhatsApp</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center gap-2 bg-[#075E54] px-3 py-2 text-white">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-sm">🏢</div>
          <div className="leading-tight">
            <div className="text-sm font-medium">{senderName}</div>
            <div className="text-[10px] text-white/70">en ligne</div>
          </div>
        </div>
        <div className="min-h-[220px] px-3 py-4" style={{ backgroundColor: '#efeae2' }}>
          <div className="max-w-[88%]">
            <div className="rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 shadow-sm">
              {mediaHeader && (
                <div className="-mx-2.5 -mt-1.5 mb-1.5 flex h-24 items-center justify-center rounded-t-lg bg-ink-100 text-3xl text-ink-400">
                  {MEDIA_ICON[mediaHeader]}
                </div>
              )}
              {textHeader && <div className="mb-1 break-words text-[13px] font-semibold text-ink-900">{textHeader}</div>}
              <div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-ink-800">
                {body.trim() ? formatInline(text) : <span className="text-ink-400">Le message apparaîtra ici…</span>}
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
                      {b.text?.trim() || (b.type === 'URL' ? 'Lien' : 'Réponse')}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {!hideNote && (
        <p className="mt-2 text-[11px] text-ink-400">Le rendu réel peut varier légèrement selon l&apos;appareil. *gras*, _italique_, ~barré~ sont supportés.</p>
      )}
    </div>
  );
}
