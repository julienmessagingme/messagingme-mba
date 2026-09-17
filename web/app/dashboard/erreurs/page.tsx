'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n';

/**
 * ADRESSE HISTORIQUE : `Analytics > Quantitatif > Erreurs` a déménagé dans le centre de Sécurité le
 * 2026-09-17 (Julien : « l'onglet erreur dans quantitatif n'a plus rien à faire là, on l'a mis dans
 * Console > securité > journal des erreurs »).
 *
 * 🔴 UNE REDIRECTION, PAS UNE SUPPRESSION, ET C'EST LE MOINS CHER DES DEUX. Cette adresse est citée dans
 * des specs, et rien ne dit qu'elle ne dort pas dans un signet ou dans un lien envoyé à un client. Un 404
 * se lit comme une panne du produit ; une redirection emmène la personne là où la carte vit maintenant,
 * et le jour où plus personne ne l'emprunte, on la retire sans rien casser.
 *
 * ⚠️ `replace` ET SURTOUT PAS `push` : avec `push`, le bouton « précédent » du navigateur ramènerait ici,
 * qui redirigerait aussitôt, et l'utilisateur serait prisonnier de la page dont il essaie de sortir.
 *
 * ⚠️ AUCUN `AppShell` ICI, DÉLIBÉRÉMENT. Monter la coquille pour la défaire à la milliseconde suivante
 * ferait clignoter une barre latérale et un menu, et surtout demanderait une clé d'onglet (`quanti-erreurs`)
 * qui n'existe plus dans la navigation. La page ne montre qu'une ligne, le temps du saut.
 */
export default function ErreursRedirection() {
  const router = useRouter();
  const t = useT();
  useEffect(() => { router.replace('/securite/erreurs'); }, [router]);
  /**
   * ⚠️ BILINGUE COMME LE RESTE, même pour une page qui ne s'affiche qu'une fraction de seconde. Le
   * `LocaleProvider` vit dans la mise en page racine, donc `useT` est disponible ici sans l'`AppShell` :
   * une phrase en français seul serait la seule du produit, et elle se verrait le jour où la redirection
   * traîne (réseau lent, onglet en arrière-plan).
   */
  return (
    <p className="p-6 text-sm text-ink-500" data-testid="erreurs-redirection">
      {t(
        'Le journal des erreurs a déménagé dans Console > Sécurité.',
        'The error log has moved to Console > Security.',
      )}
    </p>
  );
}
