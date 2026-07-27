'use client';

import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';

/**
 * Tuto d'onboarding HubSpot (F4). Page PUBLIQUE (aucune auth) : elle explique quoi faire dans HubSpot après avoir
 * activé la synchro, notamment comment ajouter la carte Messaging Me à la vue contact. Reliée depuis l'accueil par un
 * petit lien contextuel près du toggle / du CTA « Connecter HubSpot ». Style aligné sur login/signup (Tailwind pur).
 */
export default function TutoHubspotPage() {
  const t = useT();

  const steps = [
    {
      n: 1,
      title: t('Connecter votre compte HubSpot', 'Connect your HubSpot account'),
      body: t(
        "Sur l'accueil, cliquez sur « Connecter HubSpot » et autorisez l'accès. Messaging Me se lie à votre portail HubSpot. Vous pouvez ensuite activer la synchronisation par numéro.",
        'On the home page, click "Connect HubSpot" and authorize access. Messaging Me links to your HubSpot portal. You can then enable sync per number.',
      ),
    },
    {
      n: 2,
      title: t('Ajouter la carte Messaging Me à la fiche contact', 'Add the Messaging Me card to the contact record'),
      body: t(
        "C'est l'étape qui affiche l'analyse des conversations directement dans HubSpot, sur chaque contact.",
        'This is the step that shows conversation analysis directly in HubSpot, on each contact.',
      ),
      sub: [
        t('Dans HubSpot, ouvrez Paramètres (la roue crantée en haut à droite).', 'In HubSpot, open Settings (the gear icon, top right).'),
        t('Allez dans Objets, puis Contacts, onglet « Personnalisation de la fiche ».', 'Go to Objects, then Contacts, and the "Record customization" tab.'),
        t('Ouvrez la vue par défaut, puis la colonne du milieu, et choisissez « Ajouter des cartes ».', 'Open the default view, then the middle column, and choose "Add cards".'),
        t('Cherchez « Messaging Me », ajoutez la carte, puis enregistrez.', 'Search for "Messaging Me", add the card, then save.'),
      ],
    },
    {
      n: 3,
      title: t('Ce que la carte affiche', 'What the card shows'),
      body: t(
        "Sur chaque fiche contact, la carte montre le résumé de la dernière conversation WhatsApp analysée (sentiment, intention, action suggérée) et des actions en un clic. La synchronisation doit rester activée pour que les analyses remontent.",
        'On each contact record, the card shows the summary of the latest analyzed WhatsApp conversation (sentiment, intent, suggested action) and one-click actions. Sync must stay enabled for analyses to flow.',
      ),
    },
  ];

  return (
    <main className="relative flex min-h-screen justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <Logo className="mx-auto mb-3 h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">
            {t('Configurer HubSpot avec Messaging Me', 'Set up HubSpot with Messaging Me')}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {t('Trois étapes pour relier votre portail et voir les analyses de conversation dans HubSpot.', 'Three steps to link your portal and see conversation analyses in HubSpot.')}
          </p>
        </div>

        <ol className="space-y-4">
          {steps.map((s) => (
            <li key={s.n} className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-sm font-semibold text-white">{s.n}</span>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold tracking-tight text-ink-900">{s.title}</h2>
                  <p className="mt-1 text-sm text-ink-600">{s.body}</p>
                  {s.sub && (
                    <ul className="mt-2 space-y-1.5">
                      {s.sub.map((line, i) => (
                        <li key={i} className="flex gap-2 text-sm text-ink-600">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-300" />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-6 text-center">
          <Link href="/accueil" className="text-sm font-medium text-brand-600 hover:underline">
            {t("Retour à l'accueil", 'Back to home')}
          </Link>
        </div>
      </div>
    </main>
  );
}
