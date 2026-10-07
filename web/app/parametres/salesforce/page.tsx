'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { ApiError } from '@/lib/http';
import { routeInconnue } from '@/lib/canaux-services';
import { connecter, deconnecter, lireIntegration } from '@/lib/api-salesforce';
import { lienEtape, lireRefusConnexion, phraseEtatOrg, type IntegrationSalesforceVue, type ManqueSalesforce } from '@/lib/salesforce';

/**
 * PARAMÈTRES > INTÉGRATIONS > SALESFORCE : installer le package, relier l'org, la délier (plan 2026-09-26, lot L1).
 *
 * 🔴 RÉSERVÉ AUX ADMINS, ET C'EST LA PAGE QUI LE TIENT : `AppShell` laisse entrer les managers sous la clé
 * `parametres` (ils y ont la prise des conversations). Les routes sont de toute façon sous `g.admin`.
 *
 * 🔴 LES LIENS D'INSTALLATION VIENNENT DU SERVEUR (la version publiée du package), jamais recomposés ici.
 *
 * 🔴 CHAQUE MANQUE RENVOIE À SON ÉTAPE DU GUIDE (`/tuto-salesforce#<etape>`) : l'admin lit ce qui manque et où le
 * régler, au lieu d'une erreur. Une panne de Salesforce se dit « réessayez », jamais comme un manque.
 */
export default function SalesforcePage() {
  return (
    // La connexion Salesforce est un connecteur CRM (lot 6) : la coquille montre l'offre à sa place quand elle ne l'ouvre pas.
    <AppShell active="parametres" fonction="crm">
      {(session) => (session.role === 'admin'
        ? <ConnexionSalesforce tenantId={session.tenantId} />
        : <PageReservee />)}
    </AppShell>
  );
}

function PageReservee() {
  const t = useT();
  return (
    <div className="mx-auto max-w-formulaire">
      <p className="text-sm text-ink-500" data-testid="salesforce-reserve">
        {t('La connexion à Salesforce est réservée aux administrateurs de l’espace.', 'The Salesforce connection is reserved for workspace administrators.')}
      </p>
    </div>
  );
}

function ConnexionSalesforce({ tenantId }: { tenantId: string }) {
  const t = useT();
  const confirmer = useConfirmation();
  const [vue, setVue] = useState<IntegrationSalesforceVue | null>(null);
  const [lecture, setLecture] = useState<'en_cours' | 'ok' | 'illisible' | 'absente' | 'echec'>('en_cours');
  const [adresse, setAdresse] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [manques, setManques] = useState<ManqueSalesforce[]>([]);
  const [message, setMessage] = useState<{ genre: 'ok' | 'erreur'; texte: string } | null>(null);

  const recharger = useCallback(() => {
    return lireIntegration(tenantId)
      .then((v) => { setVue(v); setLecture(v ? 'ok' : 'illisible'); })
      .catch((e: unknown) => setLecture(routeInconnue(e) ? 'absente' : 'echec'));
  }, [tenantId]);

  useEffect(() => { void recharger(); }, [recharger]);

  const relier = async (): Promise<void> => {
    setEnCours(true);
    setManques([]);
    setMessage(null);
    try {
      await connecter(tenantId, adresse);
      setMessage({ genre: 'ok', texte: t('Org Salesforce reliée.', 'Salesforce org connected.') });
      setAdresse('');
      await recharger();
    } catch (e: unknown) {
      const refus = e instanceof ApiError ? lireRefusConnexion(e.corps) : null;
      if (refus && 'manques' in refus) setManques(refus.manques);
      else if (refus && 'passager' in refus) setMessage({ genre: 'erreur', texte: refus.passager });
      else setMessage({ genre: 'erreur', texte: e instanceof Error ? e.message : t('Connexion impossible', 'Unable to connect') });
    } finally {
      setEnCours(false);
    }
  };

  const delier = async (): Promise<void> => {
    if (!(await confirmer({
      titre: t('Déconnecter Salesforce', 'Disconnect Salesforce'),
      message: t(
        'Déconnecter cette org ? Messaging Me cessera d’écrire dans Salesforce, et Salesforce de prévenir Messaging Me. Les données déjà écrites dans Salesforce y restent.',
        'Disconnect this org? Messaging Me will stop writing to Salesforce, and Salesforce will stop notifying Messaging Me. Data already written to Salesforce stays there.',
      ),
      confirmer: t('Déconnecter', 'Disconnect'),
    }))) return;
    setEnCours(true);
    setMessage(null);
    try {
      const r = await deconnecter(tenantId);
      setMessage({
        genre: 'ok',
        texte: r.effaceDansOrg
          ? t('Org déconnectée.', 'Org disconnected.')
          : t('Org déconnectée chez Messaging Me. Salesforce ne répondait pas : le secret n’a pas pu y être effacé, désinstallez le package pour finir.', 'Org disconnected in Messaging Me. Salesforce did not respond: the secret could not be erased there, uninstall the package to finish.'),
      });
      await recharger();
    } catch (e: unknown) {
      setMessage({ genre: 'erreur', texte: e instanceof Error ? e.message : t('Déconnexion impossible', 'Unable to disconnect') });
    } finally {
      setEnCours(false);
    }
  };

  const kicker = 'text-xs font-medium text-ink-500';

  return (
    <div className="mx-auto max-w-formulaire space-y-6">
      <header className="space-y-1">
        <Link href="/parametres#integration-salesforce" className={kicker}>{t('Paramètres', 'Settings')}</Link>
        <TitrePage>Salesforce</TitrePage>
        <IntroPage>
          {t('Reliez votre org Salesforce : l’analyse de chaque conversation remonte sur vos Leads et Contacts.', 'Connect your Salesforce org: each conversation’s analysis flows to your Leads and Contacts.')}{' '}
          <a href="/tuto-salesforce" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{t('Le guide pour votre admin Salesforce', 'The guide for your Salesforce admin')}</a>
        </IntroPage>
      </header>

      {lecture === 'en_cours' && <p className="text-sm text-ink-500">{t('Lecture…', 'Loading…')}</p>}
      {(lecture === 'absente' || lecture === 'illisible') && (
        <p className="text-sm text-ink-500" data-testid="salesforce-indisponible">{t('La connexion à Salesforce n’est pas encore disponible.', 'The Salesforce connection is not available yet.')}</p>
      )}
      {lecture === 'echec' && <p className="text-sm text-danger">{t('La lecture a échoué : rechargez la page.', 'The read failed: reload the page.')}</p>}

      {vue && !vue.cleAppPosee && (
        <p className="text-sm text-ink-500" data-testid="salesforce-sans-cle">{t('L’app Salesforce n’est pas encore disponible sur votre instance Messaging Me.', 'The Salesforce app is not available on your Messaging Me instance yet.')}</p>
      )}

      {vue && vue.cleAppPosee && (
        <>
          <section className={cardCls} data-testid="salesforce-installation">
            <h3 className="text-sm font-semibold text-ink-900">{t('1. Installer le package Messaging Me', '1. Install the Messaging Me package')}</h3>
            {vue.liensInstallation ? (
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                <a href={vue.liensInstallation.production} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{t('Installer en production', 'Install in production')}</a>
                <a href={vue.liensInstallation.sandbox} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{t('Installer dans une sandbox', 'Install in a sandbox')}</a>
              </div>
            ) : (
              <p className="mt-2 text-sm text-ink-500">{t('Le package n’est pas encore publié : les liens d’installation apparaîtront ici.', 'The package is not published yet: the installation links will appear here.')}</p>
            )}
          </section>

          <section className={cardCls} data-testid="salesforce-connexion">
            <h3 className="text-sm font-semibold text-ink-900">{t('2. Relier votre org', '2. Connect your org')}</h3>
            <p className="mt-1 text-sm text-ink-500" data-testid="salesforce-etat">{phraseEtatOrg(vue.org, t)}</p>
            {vue.org?.quota && (
              <p className="mt-1 text-xs text-ink-500">
                {t(`Appels à l’API de votre org aujourd’hui : ${vue.org.quota.utilise} sur ${vue.org.quota.max}.`, `API calls to your org today: ${vue.org.quota.utilise} of ${vue.org.quota.max}.`)}
              </p>
            )}
            {(!vue.org || vue.org.etat !== 'connectee') && (
              <div className="mt-3 space-y-2">
                <label className="block text-sm text-ink-900">
                  {t('Adresse de votre org', 'Your org’s address')}
                  <input
                    type="url"
                    value={adresse}
                    onChange={(e) => setAdresse(e.target.value)}
                    placeholder="https://votre-societe.my.salesforce.com"
                    className={`${inputCls} mt-1`}
                    data-testid="salesforce-adresse"
                  />
                </label>
                <Bouton type="button" onClick={() => void relier()} disabled={enCours || adresse.trim() === ''} enCours={enCours} data-testid="salesforce-connecter">
                  {t('Connecter', 'Connect')}
                </Bouton>
              </div>
            )}
            {manques.length > 0 && (
              <ul className="mt-3 space-y-1.5" data-testid="salesforce-manques">
                {manques.map((m) => (
                  <li key={m.etape + m.message} className="text-sm text-danger">
                    {m.message}{' '}
                    <a href={lienEtape(m.etape)} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{t('Voir l’étape du guide', 'See the guide step')}</a>
                  </li>
                ))}
              </ul>
            )}
            {vue.org && (
              <div className="mt-4">
                <Bouton type="button" variante="secondaire" onClick={() => void delier()} disabled={enCours} data-testid="salesforce-deconnecter">
                  {t('Déconnecter', 'Disconnect')}
                </Bouton>
              </div>
            )}
          </section>
        </>
      )}

      {message && (
        <p className={`text-sm ${message.genre === 'ok' ? 'text-ink-900' : 'text-danger'}`} data-testid="salesforce-message">{message.texte}</p>
      )}
    </div>
  );
}
