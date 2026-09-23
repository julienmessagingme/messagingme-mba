'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { ApiError, estAnnulation } from '@/lib/http';
import { loadFbSdk } from '@/lib/fb-sdk';
import {
  choisirActifsPub, deconnecterPubs, echangerCodePub, getEtatPubs,
  type ActifsAccordes, type EtatPubs,
} from '@/lib/api-pubs';

/**
 * PUBLICITÉS CLICK-TO-WHATSAPP : la connexion de l'espace à son compte publicitaire (lot 2 « Connecter »).
 *
 * 🔴 CET ÉCRAN TOLÈRE L'ABSENCE DE SES ROUTES, ET CE N'EST PAS DE LA PRUDENCE DÉCORATIVE. Vercel publie la
 * console à CHAQUE `git push`, quand l'API attend son déploiement : entre les deux, l'écran appelle une
 * route que la production n'a pas. L'onglet « Outils » de l'agent de Meta est resté en 404 plus d'une heure
 * pour cette raison, le 2026-09-21. Un 404 est donc traité ici comme « pas encore configuré », exactement
 * comme une instance sans `META_ADS_CONFIG_ID`.
 *
 * ⚠️ ÉCRAN ADMIN PAR CONSTRUCTION : `accesAutorise` (`lib/nav.ts`) ne laisse ouvrir cette page qu'à un
 * administrateur, les autres rôles sont redirigés par `AppShell`. Un second contrôle de rôle DANS la page
 * serait du code mort, et le vrai contrôle reste de toute façon le `preHandler` du serveur.
 *
 * 🔴 LA LISTE DES PUBS, LE BOUTON CRÉER ET L'ENTONNOIR N'EXISTENT PAS ENCORE, pas même désactivés : ils sont
 * le lot 3. Un bouton qui ne fait rien est le motif « offert-et-inerte » que le produit s'interdit.
 */
export default function PublicitesPage() {
  return <AppShell active="publicites">{(session) => <PublicitesInner session={session} />}</AppShell>;
}

function PublicitesInner({ session }: { session: Session }) {
  const t = useT();
  const [etat, setEtat] = useState<EtatPubs | null>(null);
  const [absent, setAbsent] = useState(false);
  const [actifs, setActifs] = useState<ActifsAccordes | null>(null);
  const [compteChoisi, setCompteChoisi] = useState('');
  const [pageChoisie, setPageChoisie] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [retraitNonConfirme, setRetraitNonConfirme] = useState(false);
  const [busy, setBusy] = useState(false);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      setEtat(await getEtatPubs(session.tenantId));
    } catch (err) {
      if (estAnnulation(err)) return;
      // Route absente : l'API qui la porte n'est pas encore déployée. On le dit comme une fonctionnalité
      // éteinte, jamais comme une panne, parce que pour le client c'est exactement la même chose.
      if (err instanceof ApiError && err.status === 404) { setAbsent(true); return; }
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    }
  }, [session.tenantId, t]);

  useEffect(() => { void charger(); }, [charger]);

  async function connecter(): Promise<void> {
    if (etat === null || !etat.configure) return;
    setErreur(null);
    setBusy(true);
    try {
      await loadFbSdk(etat.appId, etat.graphVersion, t);
      window.FB!.login(
        (resp) => {
          void (async () => {
            try {
              const code = resp?.authResponse?.code;
              if (typeof code !== 'string' || code === '') {
                setErreur(t('Connexion Meta annulée ou refusée.', 'Meta connection cancelled or denied.'));
                return;
              }
              const accordes = await echangerCodePub(session.tenantId, code);
              setActifs(accordes);
              setCompteChoisi(accordes.comptesPub[0] ?? '');
              setPageChoisie(accordes.pages[0] ?? '');
              await charger();
            } catch (err) {
              setErreur(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
            } finally {
              setBusy(false);
            }
          })();
        },
        { config_id: etat.configId, response_type: 'code', override_default_response_type: true },
      );
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
      setBusy(false);
    }
  }

  async function valider(): Promise<void> {
    setErreur(null);
    setBusy(true);
    try {
      await choisirActifsPub(session.tenantId, { comptePubId: compteChoisi, pageId: pageChoisie });
      setActifs(null);
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 🔴 RECONNECTER PASSE PAR LA DÉCONNEXION, ET CE N'EST PAS UN DÉTOUR. Un second jeton écrasait le
   * premier dans la base, or il est SANS EXPIRATION : l'ancien restait vivant chez Meta et nous venions
   * d'en perdre le seul exemplaire. Les deux chemins qui perdent un jeton passent donc par le même, celui
   * qui révoque d'abord. Relevé en relecture à froid le 2026-09-23.
   *
   * ⚠️ LA RÉVOCATION A LIEU AVANT LA FENÊTRE META, et l'ordre est le tout : la retirer APRÈS la nouvelle
   * autorisation révoquerait ce que le client vient d'accorder.
   *
   * ⚠️ Conséquence assumée : une fenêtre Meta abandonnée laisse l'espace DÉCONNECTÉ. C'est réparable d'un
   * clic, quand un jeton orphelin ne l'est jamais.
   */
  async function reconnecter(): Promise<void> {
    await deconnecter();
    await connecter();
  }

  async function deconnecter(): Promise<void> {
    setErreur(null);
    setBusy(true);
    try {
      const { revoqueChezMeta } = await deconnecterPubs(session.tenantId);
      // Meta n'a pas confirmé le retrait : l'accès vit encore chez eux et nous venons d'en perdre le seul
      // exemplaire. Le taire laisserait le client croire que tout est détaché.
      setRetraitNonConfirme(!revoqueChezMeta);
      setActifs(null);
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Déconnexion impossible', 'Could not disconnect'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('Publicités', 'Ads')}</h1>
      <p className="mt-1 text-sm text-ink-500">
        {t('Les publicités Meta dont le bouton ouvre une conversation WhatsApp.',
           'Meta ads whose button opens a WhatsApp conversation.')}
      </p>

      {erreur !== null && (
        <p role="alert" data-testid="pubs-erreur" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{erreur}</p>
      )}

      {retraitNonConfirme && (
        <p role="alert" data-testid="pubs-retrait-non-confirme" className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('Votre compte est détaché d’Engage Me, mais Meta n’a pas confirmé le retrait de notre accès. Retirez l’application depuis les paramètres de votre entreprise Meta pour le fermer complètement.',
             'Your account is detached from Engage Me, but Meta did not confirm that our access was removed. Remove the app from your Meta Business settings to close it fully.')}
        </p>
      )}

      <section className="mt-5 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        {absent || (etat !== null && !etat.configure) ? (
          <Eteint t={t} />
        ) : etat === null ? (
          <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : actifs !== null ? (
          <Choix
            t={t} actifs={actifs} busy={busy}
            compte={compteChoisi} page={pageChoisie}
            setCompte={setCompteChoisi} setPage={setPageChoisie}
            valider={valider}
          />
        ) : etat.connexion === null ? (
          <NonConnecte t={t} busy={busy} connecter={connecter} />
        ) : (
          <Connecte t={t} etat={etat} busy={busy} deconnecter={deconnecter} reconnecter={reconnecter} />
        )}
      </section>
    </div>
  );
}

type T = (fr: string, en?: string) => string;

function Eteint({ t }: { t: T }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Publicités non configurées', 'Ads not configured')}</h2>
      <p className="mt-2 text-sm text-ink-500">
        {t('Cette fonctionnalité n’est pas encore activée sur cette instance. Rien à faire de votre côté.',
           'This feature is not enabled on this instance yet. Nothing to do on your side.')}
      </p>
    </div>
  );
}

function NonConnecte({ t, busy, connecter }: { t: T; busy: boolean; connecter: () => Promise<void> }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Compte publicitaire', 'Ad account')}</h2>
      <p className="mt-2 text-sm text-ink-500">
        {t('Connectez votre compte publicitaire Meta et la Page qui portera vos publicités.',
           'Connect your Meta ad account and the Page that will carry your ads.')}
      </p>
      <button
        type="button" disabled={busy} onClick={() => void connecter()}
        className="mt-4 rounded-xl bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {t('Connecter mes publicités', 'Connect my ads')}
      </button>
    </div>
  );
}

function Choix({ t, actifs, busy, compte, page, setCompte, setPage, valider }: {
  t: T; actifs: ActifsAccordes; busy: boolean; compte: string; page: string;
  setCompte: (v: string) => void; setPage: (v: string) => void; valider: () => Promise<void>;
}) {
  const rien = actifs.comptesPub.length === 0 || actifs.pages.length === 0;
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Choisissez le compte et la Page', 'Choose the account and Page')}</h2>
      {rien ? (
        <p className="mt-2 text-sm text-ink-500">
          {/* Une liste vide n'est pas une panne : le client n'a simplement rien accordé dans la fenêtre. */}
          {t('La connexion n’a donné accès à aucun compte publicitaire ou à aucune Page. Reprenez la connexion et cochez les deux.',
             'The connection granted no ad account or no Page. Start over and select both.')}
        </p>
      ) : (
        <>
          <label className="mt-3 block text-xs font-medium text-ink-500" htmlFor="compte-pub">{t('Compte publicitaire', 'Ad account')}</label>
          <select id="compte-pub" value={compte} onChange={(e) => setCompte(e.target.value)} className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm">
            {actifs.comptesPub.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="mt-3 block text-xs font-medium text-ink-500" htmlFor="page-pub">{t('Page Facebook', 'Facebook Page')}</label>
          <select id="page-pub" value={page} onChange={(e) => setPage(e.target.value)} className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm">
            {actifs.pages.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button
            type="button" disabled={busy || compte === '' || page === ''} onClick={() => void valider()}
            className="mt-4 rounded-xl bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {t('Enregistrer', 'Save')}
          </button>
        </>
      )}
    </div>
  );
}

function Connecte({ t, etat, busy, deconnecter, reconnecter }: {
  t: T; etat: EtatPubs; busy: boolean; deconnecter: () => Promise<void>; reconnecter: () => Promise<void>;
}) {
  const c = etat.connexion!;
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Compte publicitaire connecté', 'Ad account connected')}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <Ligne id="compte" cle={t('Compte', 'Account')} valeur={c.comptePubId ?? t('à choisir', 'to be chosen')} />
        <Ligne id="page" cle={t('Page', 'Page')} valeur={c.pageId ?? t('à choisir', 'to be chosen')} />
        <Ligne id="devise" cle={t('Devise', 'Currency')} valeur={c.devise ?? '—'} />
        <Ligne id="fuseau" cle={t('Fuseau', 'Time zone')} valeur={c.fuseau ?? '—'} />
      </dl>

      {/*
        Trois valeurs, trois phrases, et la troisième dit une IGNORANCE. Meta documente comment FAIRE la
        liaison entre une Page et un numéro WhatsApp, pas comment la VÉRIFIER : afficher « non liée » sur une
        ignorance enverrait le client refaire une liaison qui existe déjà.
      */}
      <p className="mt-4 text-sm text-ink-600">
        {c.pageLiee === 'oui' && t('La Page est bien liée à votre numéro WhatsApp.', 'The Page is linked to your WhatsApp number.')}
        {c.pageLiee === 'non' && t('Cette Page est liée à un AUTRE compte WhatsApp. Une publicité créée ici n’arriverait pas dans votre Inbox.',
                                   'This Page is linked to ANOTHER WhatsApp account. An ad created here would not reach your Inbox.')}
        {c.pageLiee === 'inconnu' && t('Meta ne nous dit pas si cette Page est liée à votre numéro. La liaison se fait dans les paramètres de la Page, et le code de vérification arrive dans votre Inbox.',
                                       'Meta does not tell us whether this Page is linked to your number. The link is set in the Page settings, and the verification code arrives in your Inbox.')}
      </p>

      {c.jetonRejeteLe !== null && (
        <p role="alert" data-testid="pubs-jeton-rejete" className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('Meta a refusé notre accès à ce compte. Reconnectez-vous pour continuer.',
             'Meta refused our access to this account. Reconnect to continue.')}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button" disabled={busy} onClick={() => void reconnecter()}
          className="rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 disabled:opacity-40"
        >
          {t('Reconnecter', 'Reconnect')}
        </button>
        <button
          type="button" disabled={busy} onClick={() => void deconnecter()}
          className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-40"
        >
          {t('Déconnecter', 'Disconnect')}
        </button>
      </div>
    </div>
  );
}

function Ligne({ id, cle, valeur }: { id: string; cle: string; valeur: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink-400">{cle}</dt>
      <dd data-testid={`pubs-${id}`} className="text-ink-900">{valeur}</dd>
    </div>
  );
}
