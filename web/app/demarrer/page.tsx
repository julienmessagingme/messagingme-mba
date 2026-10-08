'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { TitrePage, IntroPage } from '@/components/TitrePage';
import { Bouton, classesBouton } from '@/components/Bouton';
import { Bloc } from '@/components/doc-api/elements';
import type { Session } from '@/lib/session';
import { useLocale, useT } from '@/lib/i18n';
import { API_SCOPES_PAR_DEFAUT, createApiKey, getAccountStatus, type AccountStatusResponse } from '@/lib/api';
import { BASE } from '@/lib/http';
import { API_PUBLIQUE, CLE_SUITE, commandeMcp, promptDeDemarrage, SUITE_DEMARRER, VARIABLE_CLE } from '@/lib/demarrer';

/**
 * LA PAGE FINALE DU TUNNEL DE LA BASE (lot 19, plan `docs/superpowers/plans/2026-10-08-tunnel-de-la-base.md`) : un
 * espace qui vient de naître y trouve tout pour vivre dans Claude Code, dans l'ordre où il s'en sert. Le numéro (connecté,
 * ou à connecter maintenant ou plus tard), la commande qui branche le serveur MCP, la clé de son application, et le
 * prompt à coller. La logique est dans `lib/demarrer.ts`.
 */
export default function DemarrerPage() {
  return <AppShell active="accueil">{(session) => <Demarrer session={session} />}</AppShell>;
}

function Demarrer({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const tenantId = session.tenantId;
  const isAdmin = session.role === 'admin';
  const [compte, setCompte] = useState<AccountStatusResponse | null>(null);
  useEffect(() => {
    getAccountStatus(tenantId).then(setCompte).catch(() => { /* la page reste utilisable sans le statut */ });
  }, [tenantId]);
  const connecte = compte?.hasNumber === true;
  // Le tunnel est fini : la page du numéro, rouverte plus tard dans cet onglet, redevient elle-même.
  useEffect(() => { try { window.sessionStorage.removeItem(CLE_SUITE); } catch { /* mémoire indisponible */ } }, []);

  // La clé n'existe qu'une fois créée, et le serveur ne la rend qu'à ce moment-là : elle vit dans l'état de la page.
  const [cle, setCle] = useState<{ enCours: boolean; valeur: string | null; erreur: string | null }>({ enCours: false, valeur: null, erreur: null });
  const creerCle = async () => {
    setCle({ enCours: true, valeur: null, erreur: null });
    try {
      // Plus la lecture des fils (lot 13) : l'application d'un vibe codeur répond aux messages, et répondre demande le
      // contexte. Hors de cette page, le droit reste une case à cocher (données personnelles, `API_SCOPES_PAR_DEFAUT`).
      const creee = await createApiKey(tenantId, t('Mon application', 'My application'), [...API_SCOPES_PAR_DEFAUT, 'conversations:read']);
      setCle({ enCours: false, valeur: creee.key, erreur: null });
    } catch (err) {
      setCle({ enCours: false, valeur: null, erreur: err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong') });
    }
  };

  // 🔴 L'ADRESSE MCP EST CELLE DE L'API (`BASE`), jamais celle de la console, où `/mcp` rend 404, ni le domaine de la
  // page quand `BASE` est relative (contrairement à `/developers/mcp`) : cf. `API_PUBLIQUE`.
  const origineApi = BASE.startsWith('http') ? BASE : API_PUBLIQUE;
  const commande = commandeMcp(origineApi);
  const prompt = promptDeDemarrage({ langue: locale === 'en' ? 'en' : 'fr', docApi: `${window.location.origin}/developers/api`, numeroConnecte: connecte });

  return (
    <div className="mx-auto max-w-formulaire">
      <TitrePage>{t('Votre espace est prêt', 'Your workspace is ready')}</TitrePage>
      <IntroPage>{t('Tout pour piloter WhatsApp depuis Claude Code, en trois copier-coller.', 'Everything to run WhatsApp from Claude Code, in three copy-pastes.')}</IntroPage>

      <section className="mt-6 rounded-carte border border-ink-200 bg-white p-5" data-testid="demarrer-numero">
        <h2 className="text-base font-semibold text-ink-900">{t('Votre numéro WhatsApp', 'Your WhatsApp number')}</h2>
        {connecte ? (
          <p className="mt-1 text-sm text-ink-500">{t('Connecté', 'Connected')} : {compte?.number ?? ''}</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-500">
              {t('Pas encore connecté. Vous pouvez le faire maintenant, ou plus tard : Claude saura vous y mener.', 'Not connected yet. Do it now, or later: Claude will guide you there.')}
            </p>
            {compte && (
              <Link href={`/connecter-whatsapp?suite=${SUITE_DEMARRER}`} className={classesBouton('secondaire', 'petite', 'mt-3 inline-flex')} data-testid="demarrer-connecter-numero">
                {t('Connecter mon numéro', 'Connect my number')}
              </Link>
            )}
          </>
        )}
      </section>

      <section className="mt-4 space-y-3 rounded-carte border border-ink-200 bg-white p-5">
        <h2 className="text-base font-semibold text-ink-900">{t('1. Brancher Claude Code', '1. Connect Claude Code')}</h2>
        <p className="text-sm text-ink-500">
          {t(
            'À lancer dans un terminal, sans clé à coller. Puis, dans Claude Code, tapez /mcp, choisissez messagingme et validez la connexion dans la page qui s’ouvre.',
            'Run it in a terminal, no key to paste. Then, in Claude Code, type /mcp, pick messagingme and approve the connection on the page that opens.',
          )}
        </p>
        <Bloc legende={t('Commande', 'Command')} testid="demarrer-commande" testidCopier="demarrer-copier-commande">{commande}</Bloc>
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
        <h2 className="text-base font-semibold text-ink-900">{t('3. Le premier message à Claude', '3. Your first message to Claude')}</h2>
        <p className="text-sm text-ink-500">{t('À coller dans Claude Code, dans le dossier de votre application.', 'Paste it in Claude Code, in your application’s folder.')}</p>
        <Bloc legende={t('Prompt', 'Prompt')} testid="demarrer-prompt" testidCopier="demarrer-copier-prompt">{prompt}</Bloc>
      </section>

      <Link href="/accueil" className="mt-6 inline-block text-sm font-semibold text-ink-900 underline" data-testid="demarrer-accueil">
        {t('Aller à l’accueil de la console', 'Go to the console home')}
      </Link>
    </div>
  );
}
