'use client';

import { DOT_HEX } from '@/lib/ui';
import { useT } from '@/lib/i18n';

/**
 * L'ÉTAT DE L'AGENT DE META : répond-il, ou non.
 *
 * 🔴 ELLE REMPLACE LA PASTILLE DU NUMÉRO EN HAUT DE L'EN-TÊTE (arbitrage de Julien du 2026-09-24). L'en-tête
 * de cet écran affichait l'état du NUMÉRO WhatsApp : sur un numéro sain dont l'agent est éteint, on lisait un
 * point vert juste à côté d'une liste d'étapes disant que personne ne répond. Les textes avaient été corrigés
 * la veille pour dire « l'état du numéro WhatsApp », donc plus rien ne mentait, mais la lecture rapide
 * continuait de surprendre. La pastille du numéro est descendue à côté du numéro, où elle est chez elle.
 *
 * 🔴 EN LECTURE SEULE, ET C'EST DÉLIBÉRÉ. Sur la fiche d'un agent IA, la même place porte un interrupteur ;
 * ici, allumer l'agent est un PUT chez Meta avec sa mécanique anti-course (`src/mba/activation.ts`) et son
 * propre onglet. Un second interrupteur dans l'en-tête ferait deux chemins vers le même geste irréversible du
 * point de vue du client, et deux endroits où corriger le jour où Meta change sa règle.
 *
 * ⚠️ `DOT_HEX` PLUTÔT QU'UNE COULEUR EN DUR : c'est la table que l'Accueil, la qualité du numéro et les
 * badges de statut lisent déjà. Un vert écrit ici divergerait du leur au premier ajustement de palette.
 */
export function PastilleAgentMba({ actif }: { actif: boolean }) {
  const t = useT();
  return (
    <span
      data-testid="pastille-agent-mba"
      className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700"
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: actif ? DOT_HEX.green : DOT_HEX.grey }} />
      {/* ⚠️ « ÉTEINT » ET NON « INACTIF » : inactif se lit comme « rien ne se passe en ce moment », éteint dit
          que c'est un réglage, donc que ça se rallume. La nuance est celle que l'onglet Activation porte. */}
      {actif ? t('Répond', 'Answering') : t('Éteint', 'Off')}
    </span>
  );
}
