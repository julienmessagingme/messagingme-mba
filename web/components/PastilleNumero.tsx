'use client';

import { DOT_HEX } from '@/lib/ui';
import type { AccountDot } from '@/lib/api';

/**
 * L ETAT D UN NUMERO WHATSAPP, tel que `getAccountStatus` le rend : la puce de couleur et son libelle.
 *
 * 🔴 EXTRAIT DE L ACCUEIL, PAS RECOPIE (2026-09-23). Le meme marquage etait ecrit en ligne dans
 * `web/app/accueil/page.tsx` ; l en-tete de l ecran de l agent de Meta en a besoin, et une seconde copie
 * aurait fait deux pastilles a realigner a la main. La table de couleurs, elle, reste dans `lib/ui.ts` parce
 * que l Accueil la lit encore a cinq autres endroits (qualite du numero, HubSpot, badges de statut).
 *
 * ⚠️ LE REPLI SUR `grey` EST DELIBERE et il n est pas mort : le type dit `AccountDot`, mais la valeur vient
 * d une reponse HTTP, donc un `dot` inconnu (un serveur plus recent que ce front) rendrait une pastille SANS
 * couleur, c est-a-dire invisible, a cote d un libelle qui annonce un probleme.
 */
export function PastilleNumero({ status }: { status: { dot: AccountDot; label: string } }) {
  return (
    <span
      data-testid="pastille-numero-statut"
      className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700"
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DOT_HEX[status.dot] ?? DOT_HEX.grey }} />
      {status.label}
    </span>
  );
}
