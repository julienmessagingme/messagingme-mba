'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { getSession } from '@/lib/session';
import { listRcsAgents } from '@/lib/api';

/**
 * Chrome « téléphone » des aperçus RCS : le libellé, l'en-tête au nom de la marque, le fond de conversation.
 * C'est le pendant de `PhoneFrame`, le cadre des aperçus WhatsApp.
 *
 * 🔴 IL EXISTE PARCE QUE L'ÉCRAN MESSAGES RCS DOIT AVOIR « LA MÊME GUEULE » QUE CELUI DES TEMPLATES WHATSAPP
 * (Julien, 2026-09-21), dont l'aperçu vit dans un cadre de téléphone. Les bulles, elles, restent celles de
 * `RcsPreview` : menthe, la couleur du RCS dans l'Inbox.
 *
 * Le nom affiché est le NOM DE MARQUE de l'agent RCS (`RcsAgent.brandName`), ce que le destinataire lit en haut
 * de sa conversation. Il se résout comme le nom vérifié de `PhoneFrame` : une requête par espace pour toute la
 * page, un échec retiré de la mémoire (sans quoi une coupure d'une seconde figerait le repli pour la vie de
 * l'onglet), et un libellé neutre en repli réel.
 */
const marquesParEspace = new Map<string, Promise<string | null>>();

function nomDeMarque(tenantId: string): Promise<string | null> {
  const connu = marquesParEspace.get(tenantId);
  if (connu) return connu;
  const p = listRcsAgents(tenantId)
    .then((r) => {
      // Réponse 200 sans le champ attendu : `.find` sur `undefined` ferait tomber l'écran, pas le seul bandeau.
      const agents = Array.isArray(r?.agents) ? r.agents : [];
      return agents.find((a) => (a.brandName ?? '') !== '')?.brandName ?? null;
    })
    .catch(() => {
      marquesParEspace.delete(tenantId);
      return null;
    });
  marquesParEspace.set(tenantId, p);
  return p;
}

export function RcsPhoneFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const [marque, setMarque] = useState<string | null>(null);

  useEffect(() => {
    const tenantId = getSession()?.tenantId;
    if (!tenantId) return;
    let vivant = true;
    void nomDeMarque(tenantId).then((n) => { if (vivant) setMarque(n); });
    return () => { vivant = false; };
  }, []);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">{t('Aperçu RCS', 'RCS preview')}</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center gap-2 border-b border-ink-100 bg-white px-3 py-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-mint-100 text-sm">🏢</div>
          <div className="leading-tight">
            <div className="flex items-center gap-1 text-sm font-medium text-ink-900">
              <span data-testid="apercu-rcs-marque">{marque || t('Votre marque', 'Your brand')}</span>
              <span className="text-xs text-brand-600" title={t('Marque vérifiée', 'Verified brand')}>✓</span>
            </div>
            <div className="text-[10px] text-ink-400">{t('agent de marque vérifié', 'verified brand agent')}</div>
          </div>
        </div>
        <div className="space-y-2 bg-ink-50 px-3 py-4">{children}</div>
      </div>
    </div>
  );
}
