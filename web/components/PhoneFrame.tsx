'use client';

import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n';

/**
 * Chrome « fenêtre WhatsApp » des aperçus : le libellé, la barre verte, l'avatar et le fond de conversation.
 * Partagé par l'aperçu d'un message simple (WhatsAppPreview) et celui d'un carousel (CarouselPreview), qui en
 * portaient chacun une copie.
 *
 * Le nom affiché est un LIBELLÉ GÉNÉRIQUE, pas le nom vérifié du compte : celui-ci n'est pas connu ici, et
 * l'en-tête affichait auparavant « Messaging Me Tech » en dur, donc un nom faux chez tous les autres clients.
 * Le jour où le nom vérifié descend jusqu'aux écrans d'aperçu, il se passe en prop.
 */
export function PhoneFrame({ senderName, contentClassName, children }: { senderName?: string; contentClassName: string; children: ReactNode }) {
  const t = useT();
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">{t('Aperçu WhatsApp', 'WhatsApp preview')}</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center gap-2 bg-[#075E54] px-3 py-2 text-white">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-sm">🏢</div>
          <div className="leading-tight">
            <div className="text-sm font-medium">{senderName ?? t('Votre entreprise', 'Your business')}</div>
            <div className="text-[10px] text-white/70">{t('en ligne', 'online')}</div>
          </div>
        </div>
        <div className={contentClassName} style={{ backgroundColor: '#efeae2' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
