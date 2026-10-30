'use client';

import Link from 'next/link';
import { CadreSansCompte } from '@/components/CadreSansCompte';
import { useT } from '@/lib/i18n';

/**
 * Tuto d'onboarding HubSpot (F4). Page PUBLIQUE (aucune auth) : elle explique quoi faire dans HubSpot après avoir
 * activé la synchro, notamment comment ajouter la carte Messaging Me à la vue contact. Reliée depuis l'accueil et la
 * carte HubSpot de Tools > Intégrations ; le reste de l'app (page HubSpot, workflows) est dans le guide public, la fiche
 * `integrer-whatsapp-a-hubspot`. Style aligné sur login/signup (Tailwind pur).
 */
export default function TutoHubspotPage() {
  const t = useT();

  const steps = [
    {
      n: 1,
      title: t('Connecter votre compte HubSpot', 'Connect your HubSpot account'),
      body: t(
        "Dans Tools > Intégrations, cliquez sur « Connecter HubSpot » et autorisez l’accès, puis choisissez ce que vous branchez : la fiche contact et l’analyse, les tâches, la réponse depuis HubSpot, les modèles, vos workflows HubSpot, vos listes.",
        'In Tools > Integrations, click "Connect HubSpot" and authorize access, then choose what you connect: the contact record and analysis, tasks, replying from HubSpot, templates, your HubSpot workflows, your lists.',
      ),
    },
    {
      n: 2,
      title: t('Ajouter la carte Messaging Me à la fiche contact', 'Add the Messaging Me card to the contact record'),
      body: t(
        "C’est l’étape qui met la conversation WhatsApp dans HubSpot, sur chaque contact.",
        'This is the step that puts the WhatsApp conversation in HubSpot, on each contact.',
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
      title: t('Ce que fait la carte', 'What the card does'),
      body: t(
        "Sur chaque fiche contact, la carte montre la conversation WhatsApp : toute personne du portail y répond une fois « Répondre aux clients depuis HubSpot » allumé, et y envoie un modèle quand la fenêtre de 24 heures est fermée. Dessous, l’analyse de la dernière conversation (sentiment, intention, action suggérée) et ses actions en un clic. La synchronisation doit rester activée.",
        'On each contact record, the card shows the WhatsApp conversation: anyone in the portal replies there once "Reply to customers from HubSpot" is on, and sends a template there when the 24-hour window is closed. Below, the analysis of the latest conversation (sentiment, intent, suggested action) and its one-click actions. Sync must stay enabled.',
      ),
    },
  ];

  return (
    <CadreSansCompte titre={t('Configurer HubSpot avec Messaging Me', 'Set up HubSpot with Messaging Me')} sousTitre={t('Trois étapes pour relier votre portail et répondre à vos clients WhatsApp depuis HubSpot.', 'Three steps to link your portal and reply to your WhatsApp customers from HubSpot.')} largeur="formulaire">

      <ol className="space-y-4">
        {steps.map((s) => (
          <li key={s.n} className="rounded-carte border border-ink-200 bg-white p-5">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">{s.n}</span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink-900">{s.title}</h2>
                <p className="mt-1 text-sm text-ink-500">{s.body}</p>
                {s.sub && (
                  <ul className="mt-2 space-y-1.5">
                    {s.sub.map((line, i) => (
                      <li key={i} className="flex gap-2 text-sm text-ink-500">
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

      <p className="mt-4 text-sm text-ink-500">
        {t(
          'La page « Messaging Me » de HubSpot liste les conversations qui attendent un humain, et vos workflows HubSpot envoient des modèles et lancent des scénarios.',
          'The "Messaging Me" page in HubSpot lists the conversations waiting for a person, and your HubSpot workflows send templates and launch scenarios.',
        )}{' '}
        <a
          href={t('https://app.messagingme.fr/aide/integrer-whatsapp-a-hubspot/', 'https://app.messagingme.fr/en/help/integrate-whatsapp-with-hubspot/')}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand-600 hover:underline"
          data-testid="tuto-hubspot-guide"
        >
          {t('Tout ce que fait l’app', 'Everything the app does')}
        </a>
      </p>

      <div className="mt-6 text-center">
        <Link href="/accueil" className="text-sm font-medium text-brand-600 hover:underline">
          {t("Retour à l’accueil", 'Back to home')}
        </Link>
      </div>
    </CadreSansCompte>
  );
}
