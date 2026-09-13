'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';

/**
 * LE CENTRE DE SÉCURITÉ & COMPLIANCE : sa porte d'entrée.
 *
 * 🔴 UNE BOÎTE PAR SOUS-MENU, ET AUCUNE DE PLUS. Une boîte qui mène nulle part est le défaut qui arrive
 * vraiment sur ce genre d'écran : on annonce un chantier, puis on livre la page d'accueil avant le
 * contenu. Les boîtes suivantes (Consentement, IA) arriveront avec leurs écrans.
 *
 * ⚠️ CE QUI EST RASSEMBLÉ ICI NE L'EST PAS PAR THÈME, MAIS PAR USAGE : on vient sur ces pages pour RENDRE
 * DES COMPTES (à un client, à un auditeur, à soi-même après un incident), pas pour régler l'espace. C'est
 * ce qui justifie de les sortir de Paramètres.
 */
export default function SecuritePage() {
  return <AppShell active="securite">{() => <Securite />}</AppShell>;
}

function Securite() {
  const t = useT();
  const boites = [
    {
      cle: 'securite-consentement',
      href: '/securite/consentement',
      titre: t('Consentement', 'Consent'),
      texte: t(
        'Qui a demandé à ne plus être contacté, depuis quand, et par quel chemin. Aucun envoi automatique ne leur est adressé.',
        'Who asked not to be contacted again, since when, and how. No automatic message is sent to them.',
      ),
    },
    {
      cle: 'securite-audit',
      href: '/securite/audit',
      titre: t('Audit trails', 'Audit trails'),
      texte: t(
        'Qui a fait quoi, et quand. Lecture seule, sans aucun numéro de téléphone : c’est une preuve, pas un outil d’exploitation.',
        'Who did what, and when. Read-only, with no phone numbers: this is evidence, not an operations tool.',
      ),
    },
    {
      cle: 'securite-erreurs',
      href: '/securite/erreurs',
      titre: t('Journal des erreurs', 'Error log'),
      texte: t(
        'Les messages qui ne sont pas partis ou pas arrivés, avec la réponse exacte de Meta et son explication en clair.',
        'Messages that did not go out or did not arrive, with Meta’s exact answer and a plain-language explanation.',
      ),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6" data-testid="securite-accueil">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-ink-900">
          {t('Bienvenue au centre de sécurité & compliance de Engage Me', 'Welcome to the Engage Me security & compliance centre')}
        </h1>
        <p className="text-sm text-ink-500">
          {t(
            'Tout ce qui sert à rendre des comptes : ce qui a été fait, ce qui a échoué, et ce que les gens ont accepté.',
            'Everything you need to account for what happened: what was done, what failed, and what people agreed to.',
          )}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {boites.map((b) => (
          <Link
            key={b.cle}
            href={b.href}
            data-testid={`securite-boite-${b.cle}`}
            className="block rounded-xl border border-ink-200 bg-white p-4 transition hover:border-brand-300 hover:bg-brand-50"
          >
            <span className="block text-sm font-semibold text-ink-900">{b.titre}</span>
            <span className="mt-1 block text-xs text-ink-500">{b.texte}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
