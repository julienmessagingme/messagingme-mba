'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bouton } from './Bouton';
import { Bloc } from './doc-api/elements';
import { useT } from '@/lib/i18n';
import { API_SCOPES_PAR_DEFAUT, createApiKey } from '@/lib/api';
import { COMMANDE_DEMARRAGE, COMMANDES_PLUGIN, SERVEUR_PLUGIN_MCP, VARIABLE_CLE } from '@/lib/demarrer';

/**
 * PILOTER L'ESPACE DEPUIS CLAUDE CODE, EN TROIS GESTES (lot 19, puis l'accueil d'une Free, spec offres v2) : installer le
 * plugin, créer la clé de son application, lancer la mise en service. La fin du tunnel (`/demarrer`) et l'accueil d'une
 * Free, qui n'a pas d'autre console, montrent les mêmes trois sections : une seule source.
 */
export function PiloterDepuisClaude({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  // La clé n'existe qu'une fois créée, et le serveur ne la rend qu'à ce moment-là : elle vit dans l'état du composant.
  const [cle, setCle] = useState<{ enCours: boolean; valeur: string | null; erreur: string | null }>({ enCours: false, valeur: null, erreur: null });
  const creerCle = async () => {
    setCle({ enCours: true, valeur: null, erreur: null });
    try {
      // Plus la lecture des fils (lot 13) : l'application d'un vibe codeur répond aux messages, et répondre demande le
      // contexte. Hors de ce geste, le droit reste une case à cocher (données personnelles, `API_SCOPES_PAR_DEFAUT`).
      const creee = await createApiKey(tenantId, t('Mon application', 'My application'), [...API_SCOPES_PAR_DEFAUT, 'conversations:read']);
      setCle({ enCours: false, valeur: creee.key, erreur: null });
    } catch (err) {
      setCle({ enCours: false, valeur: null, erreur: err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong') });
    }
  };

  return (
    <>
      <section className="mt-4 space-y-3 rounded-carte border border-ink-200 bg-white p-5">
        <h2 className="text-base font-semibold text-ink-900">{t('1. Installer le plugin dans Claude Code', '1. Install the Claude Code plugin')}</h2>
        <p className="text-sm text-ink-500">
          {t(
            `Dans Claude Code, ouvert dans le dossier de votre application : ces deux commandes, l’une après l’autre, sans clé à coller. Puis tapez /mcp, choisissez ${SERVEUR_PLUGIN_MCP}, puis Authenticate, et validez la connexion dans la page qui s’ouvre.`,
            `In Claude Code, opened in your application’s folder: these two commands, one after the other, no key to paste. Then type /mcp, pick ${SERVEUR_PLUGIN_MCP}, then Authenticate, and approve the connection on the page that opens.`,
          )}
        </p>
        {/* Une commande par bloc : collées ensemble, Claude Code n'en lancerait qu'une. */}
        {COMMANDES_PLUGIN.map((c, i) => (
          <Bloc key={c} legende={t(`Commande ${i + 1}`, `Command ${i + 1}`)} testid={`demarrer-commande-${i + 1}`} testidCopier={`demarrer-copier-commande-${i + 1}`}>{c}</Bloc>
        ))}
      </section>

      <section className="mt-4 space-y-3 rounded-carte border border-ink-200 bg-white p-5">
        <h2 className="text-base font-semibold text-ink-900">{t('2. La clé de votre application', '2. Your application’s key')}</h2>
        <p className="text-sm text-ink-500">
          {t(
            `Le code que Claude écrira pour vous appelle l’API avec cette clé. Elle se range dans la variable ${VARIABLE_CLE}, dans un fichier .env que git ne suit pas, jamais dans le code.`,
            `The code Claude writes for you calls the API with this key. It goes in the ${VARIABLE_CLE} variable, in a .env file git does not track, never in the code.`,
          )}
        </p>
        {cle.valeur ? (
          <>
            <Bloc legende={t('Ligne du fichier .env, montrée une seule fois', '.env line, shown only once')} testid="demarrer-cle" testidCopier="demarrer-copier-cle">{`${VARIABLE_CLE}=${cle.valeur}`}</Bloc>
            <p className="text-xs text-ink-500">
              {t('Perdue ? Révoquez-la et créez-en une autre dans', 'Lost it? Revoke it and create another in')}{' '}
              <Link href="/developers/keys" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">{t('Clés d’API', 'API keys')}</Link>.
            </p>
          </>
        ) : isAdmin ? (
          <Bouton type="button" enCours={cle.enCours} disabled={cle.enCours} onClick={() => { void creerCle(); }} data-testid="demarrer-creer-cle">
            {t('Créer la clé de mon application', 'Create my application’s key')}
          </Bouton>
        ) : (
          <p className="text-sm text-ink-500">{t('Réservé aux admins de l’espace.', 'Workspace admins only.')}</p>
        )}
        {cle.erreur && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{cle.erreur}</p>}
      </section>

      <section className="mt-4 space-y-3 rounded-carte border border-ink-200 bg-white p-5">
        <h2 className="text-base font-semibold text-ink-900">{t('3. Lancer la mise en service', '3. Start the setup')}</h2>
        <p className="text-sm text-ink-500">
          {t(
            'Dans Claude Code : Claude lit où en est votre espace, puis vous mène du numéro à l’agent IA et à la bulle sur votre site. Une session coupée reprend où elle s’était arrêtée.',
            'In Claude Code: Claude reads where your workspace stands, then takes you from the number to the AI agent and the bubble on your site. An interrupted session resumes where it stopped.',
          )}
        </p>
        <Bloc legende={t('Dans Claude Code', 'In Claude Code')} testid="demarrer-lancement" testidCopier="demarrer-copier-lancement">{COMMANDE_DEMARRAGE}</Bloc>
      </section>
    </>
  );
}
