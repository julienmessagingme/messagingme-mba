'use client';

import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';
import { TitrePage } from '@/components/TitrePage';
import type { EtapeGuideSalesforce } from '@/lib/salesforce';

/**
 * LE GUIDE DE CONNEXION SALESFORCE (plan 2026-09-26, lot L1). Page PUBLIQUE, sans session, sur le modèle de
 * `tuto-hubspot` : ce que l'admin Salesforce du client fait dans SON org avant de cliquer « Connecter ».
 *
 * 🔴 CHAQUE ÉTAPE PORTE UNE ANCRE STABLE (`id`), et ce sont exactement les étapes que la connexion rend avec
 * chaque manque (`ETAPES_GUIDE`, `src/salesforce/connexion.ts`) : « Connecter » renvoie l'admin droit à l'étape
 * qui règle son problème. La parité est tenue par un test, sinon les liens mourraient en silence.
 *
 * ⚠️ PAGE PUBLIQUE, DONC SANS LIEN D'INSTALLATION : il dépend de la version publiée du package, que seul le serveur
 * connaît. Le guide renvoie à l'écran authentifié qui les donne.
 */
export default function TutoSalesforcePage() {
  const t = useT();

  const steps: Array<{ id: EtapeGuideSalesforce; title: string; body: string; sub?: string[] }> = [
    {
      id: 'package',
      title: t('Installer le package Engage Me', 'Install the Engage Me package'),
      body: t(
        'Dans Engage Me, Paramètres > Intégrations > Salesforce, ouvrez le lien d’installation (production ou sandbox) et connectez-vous en administrateur de votre org.',
        'In Engage Me, Settings > Integrations > Salesforce, open the installation link (production or sandbox) and log in as an administrator of your org.',
      ),
      sub: [
        t('Choisissez « Installer pour les administrateurs uniquement », puis validez.', 'Choose "Install for admins only", then confirm.'),
        t('Le package ajoute les champs Engage Me aux Leads et aux Contacts, et un ensemble d’autorisations « Engage Me Integration ».', 'The package adds the Engage Me fields to Leads and Contacts, and an "Engage Me Integration" permission set.'),
      ],
    },
    {
      id: 'utilisateur',
      title: t('Créer l’utilisateur d’intégration', 'Create the integration user'),
      body: t(
        'Engage Me travaille dans votre org sous un utilisateur à lui, limité à l’API : il ne se connecte jamais à l’écran, et chaque écriture porte son nom. Les éditions Enterprise, Unlimited et Performance en offrent cinq.',
        'Engage Me works in your org under its own API-only user: it never logs in to the screen, and every write carries its name. Enterprise, Unlimited and Performance editions include five.',
      ),
      sub: [
        t('Configuration > Utilisateurs > Nouvel utilisateur.', 'Setup > Users > New User.'),
        t('Licence « Salesforce Integration », profil « Minimum Access - API Only Integrations ».', 'License "Salesforce Integration", profile "Minimum Access - API Only Integrations".'),
      ],
    },
    {
      id: 'droits',
      title: t('Lui donner ses droits', 'Give it its permissions'),
      body: t(
        'Sur la fiche de cet utilisateur, ajoutez la licence d’autorisation « Salesforce API Integration » et l’ensemble d’autorisations « Engage Me Integration ».',
        'On this user’s record, add the "Salesforce API Integration" permission set license and the "Engage Me Integration" permission set.',
      ),
      sub: [
        t('Si vous désignez un champ de consentement WhatsApp, donnez-lui aussi la lecture et la modification de ce champ.', 'If you designate a WhatsApp consent field, also give it read and edit access to that field.'),
      ],
    },
    {
      id: 'run-as',
      title: t('Le désigner pour l’app Engage Me', 'Designate it for the Engage Me app'),
      body: t(
        'Configuration > Gestionnaire d’applications clientes externes > Engage Me > Modifier les politiques.',
        'Setup > External Client App Manager > Engage Me > Edit Policies.',
      ),
      sub: [
        t('Activez le flux des identifiants client (Client Credentials Flow).', 'Enable the Client Credentials Flow.'),
        t('Choisissez l’utilisateur d’intégration comme utilisateur « Exécuter en tant que » (Run As), puis enregistrez.', 'Choose the integration user as the "Run As" user, then save.'),
      ],
    },
    {
      id: 'adresse',
      title: t('Connecter votre org', 'Connect your org'),
      body: t(
        'Dans Engage Me, collez l’adresse de votre org (dans Salesforce, le menu de votre avatar l’affiche sous votre nom) et cliquez « Connecter ». Engage Me vérifie chaque étape et vous dit ce qui manque.',
        'In Engage Me, paste your org’s address (in Salesforce, your avatar menu shows it under your name) and click "Connect". Engage Me checks each step and tells you what is missing.',
      ),
    },
    {
      id: 'org',
      title: t('Une org par espace', 'One org per workspace'),
      body: t(
        'Une org Salesforce ne se relie qu’à un seul espace Engage Me, et un espace qu’à une seule org. Pour en changer, déconnectez d’abord l’org reliée. Une sandbox est une org à part : un espace de test peut s’y relier.',
        'A Salesforce org connects to a single Engage Me workspace, and a workspace to a single org. To switch, disconnect the connected org first. A sandbox is a separate org: a test workspace can connect to it.',
      ),
    },
  ];

  return (
    <main className="relative flex min-h-screen justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className="w-full max-w-formulaire">
        <div className="mb-8 text-center">
          <Logo className="mx-auto mb-3 h-12 w-12" />
          <TitrePage>
            {t('Configurer Salesforce avec Engage Me', 'Set up Salesforce with Engage Me')}
          </TitrePage>
          <p className="mt-1 text-sm text-ink-500">
            {t('Ce que l’administrateur de votre org fait une fois, avant de cliquer « Connecter » dans Engage Me.', 'What your org’s administrator does once, before clicking "Connect" in Engage Me.')}
          </p>
        </div>

        <ol className="space-y-4">
          {steps.map((s, i) => (
            <li key={s.id} id={s.id} className="scroll-mt-6 rounded-carte border border-ink-200 bg-white p-5">
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">{i + 1}</span>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-ink-900">{s.title}</h2>
                  <p className="mt-1 text-sm text-ink-500">{s.body}</p>
                  {s.sub && (
                    <ul className="mt-2 space-y-1.5">
                      {s.sub.map((line, j) => (
                        <li key={j} className="flex gap-2 text-sm text-ink-500">
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
          <Link href="/parametres#integration-salesforce" className="text-sm font-medium text-brand-600 hover:underline">
            {t('Retour aux paramètres', 'Back to settings')}
          </Link>
        </div>
      </div>
    </main>
  );
}
