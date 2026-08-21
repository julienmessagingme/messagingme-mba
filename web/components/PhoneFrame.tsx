'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { getSession } from '@/lib/session';
import { listPhoneNumbers } from '@/lib/api';

/**
 * Chrome « fenêtre WhatsApp » des aperçus : le libellé, la barre verte, l'avatar et le fond de conversation.
 * Partagé par l'aperçu d'un message simple (WhatsAppPreview) et celui d'un carousel (CarouselPreview), qui en
 * portaient chacun une copie.
 *
 * Le nom affiché est le NOM VÉRIFIÉ du compte WhatsApp (`phone_numbers.verified_name`), c'est-à-dire
 * exactement ce que le destinataire lit en haut de sa conversation. Il arrive par la prop `senderName` quand
 * l'écran sait de quel numéro il parle (l'écran Campagnes, qui a un sélecteur), et sinon ce composant le
 * résout lui-même : les écrans Templates et Inbox ne chargent pas les numéros, et leur faire tous porter la
 * plomberie pour un bandeau serait disproportionné.
 *
 * Le libellé générique ne subsiste qu'en repli réel : espace sans numéro rattaché, nom pas encore remonté de
 * Meta, ou appel en échec. Mieux vaut un libellé neutre qu'un en-tête vide.
 */

/**
 * Une seule requête par espace pour toute la page, quel que soit le nombre d'aperçus rendus.
 *
 * L'aperçu de `TemplateForm` se redessine à CHAQUE frappe : sans cette mémoire au niveau du module, on
 * partirait en rafale de requêtes. La promesse est mémorisée (pas seulement son résultat), donc deux aperçus
 * montés en même temps partagent le même appel en vol.
 */
const nomsParEspace = new Map<string, Promise<string | null>>();

function nomVerifie(tenantId: string): Promise<string | null> {
  const connu = nomsParEspace.get(tenantId);
  if (connu) return connu;
  const p = listPhoneNumbers(tenantId)
    .then((r) => {
      // Réponse 200 sans le champ attendu : `.find` sur `undefined` ferait tomber l'écran entier, pas juste
      // le bandeau. On normalise avant de lire.
      const nums = Array.isArray(r?.phoneNumbers) ? r.phoneNumbers : [];
      return nums.find((n) => (n.verifiedName ?? '') !== '')?.verifiedName ?? null;
    })
    .catch(() => {
      // Seul le SUCCÈS reste en mémoire. La promesse est posée avant l'appel pour que deux aperçus montés en
      // même temps le partagent, mais un échec la retire : sans ça, une coupure réseau d'une seconde figeait
      // le libellé générique pour toute la vie de l'onglet, sans aucun moyen de reprendre.
      nomsParEspace.delete(tenantId);
      return null; // information d'appoint : jamais d'erreur en travers d'un aperçu
    });
  nomsParEspace.set(tenantId, p);
  return p;
}

export function PhoneFrame({ senderName, contentClassName, children }: { senderName?: string; contentClassName: string; children: ReactNode }) {
  const t = useT();
  const [resolu, setResolu] = useState<string | null>(null);

  useEffect(() => {
    // L'écran a déjà tranché : on ne va rien chercher.
    if (senderName) return;
    const tenantId = getSession()?.tenantId;
    if (!tenantId) return;
    let vivant = true;
    void nomVerifie(tenantId).then((n) => { if (vivant) setResolu(n); });
    return () => { vivant = false; };
  }, [senderName]);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">{t('Aperçu WhatsApp', 'WhatsApp preview')}</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center gap-2 bg-[#075E54] px-3 py-2 text-white">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-sm">🏢</div>
          <div className="leading-tight">
            <div className="text-sm font-medium" data-testid="apercu-emetteur">{senderName || resolu || t('Votre entreprise', 'Your business')}</div>
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
