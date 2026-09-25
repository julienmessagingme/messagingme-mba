'use client';

import { useCallback, useEffect, useState } from 'react';
import { lireIntegrationBatch, enregistrerIntegrationBatch, debrancherIntegrationBatch, type EtatIntegrationBatch } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { cardCls, inputCls } from '@/lib/ui';

/**
 * PARAMÈTRES > INTÉGRATIONS > BATCH (lot 6 de l'API publique, spec 2026-09-24, § 8) : les clés de l'outil qui
 * reçoit les signaux. Réservé aux admins, comme tout l'écran où il vit, et comme ses routes (`g.admin`).
 *
 * ⚠️ C'EST LE SEUL ÉCRAN QUI NOMME L'OUTIL. La documentation, le journal des erreurs et le dictionnaire des
 * signaux parlent de « l'outil branché dans Paramètres > Intégrations » (demande de Julien du 2026-09-24).
 *
 * 🔴 LES CLÉS NE REVIENNENT JAMAIS À L'ÉCRAN : le serveur ne les rend pas, et celles qu'on vient de saisir sont
 * effacées des champs dès l'enregistrement. Un champ vide veut dire « garder celle qui est enregistrée ».
 * ⚠️ `autoComplete="new-password"`, pas `off` : Chrome ignore `off` sur un champ mot de passe, et y remplirait
 * le mot de passe de la console, qui partirait comme clé de l'outil.
 *
 * ⚠️ DÉBRANCHER SE CONFIRME : le geste efface les deux clés ET le compte des signaux non poussés, sans retour.
 *
 * 🔴 LE COMPTE DES SIGNAUX NON POUSSÉS EST LA RAISON D'ÊTRE DE CETTE CARTE, autant que les clés : une fiche sans
 * identifiant externe n'est pas remontée, et un intégrateur qui a oublié de nous passer ses identifiants doit le
 * VOIR ici, pas le découvrir dans son outil vide.
 *
 * ⚠️ UNE RÉPONSE SANS `branche` (un proxy qui rend `{}`, une API plus ancienne que l'écran) se lit « non
 * branché », jamais comme une panne du rendu : c'est la leçon de `ErreursSysteme`, où une réponse inattendue
 * faisait tomber tout le centre de Sécurité. Une lecture qui ÉCHOUE, elle, ne dit pas « non branché » : l'état
 * reste inconnu, et rien ne s'enregistre sur un état qu'on n'a pas lu.
 */
export function ReglageIntegrationBatch({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<EtatIntegrationBatch | null>(null);
  const [cleRest, setCleRest] = useState('');
  const [cleProjet, setCleProjet] = useState('');
  const [resume, setResume] = useState(false);
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [erreur, setErreur] = useState<string | null>(null);

  const appliquer = useCallback((r: EtatIntegrationBatch | null | undefined) => {
    const propre: EtatIntegrationBatch = r?.branche === true ? r : { branche: false };
    setEtat(propre);
    setResume(propre.envoyerResume === true);
  }, []);

  useEffect(() => {
    let vivant = true;
    lireIntegrationBatch(tenantId)
      .then((r) => { if (vivant) appliquer(r); })
      .catch((e: unknown) => {
        if (vivant) setErreur(e instanceof Error ? e.message : t('Lecture impossible', 'Unable to read'));
      });
    return () => { vivant = false; };
  }, [tenantId, appliquer, t]);

  const branche = etat?.branche === true;
  const clesSaisies = cleRest.trim() !== '' && cleProjet.trim() !== '';
  const peutEnregistrer = etat !== null && statut !== 'saving' && (branche || clesSaisies);
  const date = (iso: string): string => `${formatDate(iso, locale)} ${hourMin(iso, locale)}`;

  const enregistrer = () => {
    if (!peutEnregistrer) return;
    setStatut('saving');
    setErreur(null);
    enregistrerIntegrationBatch(tenantId, {
      ...(cleRest.trim() !== '' ? { cleRest: cleRest.trim() } : {}),
      ...(cleProjet.trim() !== '' ? { cleProjet: cleProjet.trim() } : {}),
      envoyerResume: resume,
    })
      .then((r) => { appliquer(r); setCleRest(''); setCleProjet(''); setStatut('saved'); })
      .catch((e: unknown) => { setStatut('error'); setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Unable to save')); });
  };

  const debrancher = () => {
    if (!window.confirm(t(
      'Débrancher Batch ? Les deux clés enregistrées et le compte des signaux non poussés seront effacés, et plus aucun signal ne partira.',
      'Disconnect Batch? Both saved keys and the count of signals not sent will be erased, and no signal will be sent anymore.',
    ))) return;
    setStatut('saving');
    setErreur(null);
    debrancherIntegrationBatch(tenantId)
      .then(() => { appliquer({ branche: false }); setStatut('idle'); })
      .catch((e: unknown) => { setStatut('error'); setErreur(e instanceof Error ? e.message : t('Débranchement impossible', 'Unable to disconnect')); });
  };

  const libelle = statut === 'saving' ? t('enregistrement…', 'saving…') : statut === 'saved' ? t('enregistré', 'saved') : '';
  const perdus = etat?.sansIdentifiant ?? 0;
  const dernier = etat?.sansIdentifiantLe ? date(etat.sansIdentifiantLe) : null;

  return (
    <section className="space-y-3" data-testid="integrations">
      <header className="space-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Intégrations', 'Integrations')}</span>
        <p className="text-sm text-ink-600">
          {t(
            'L’outil qui reçoit les signaux de la console (livraisons, réponses, clics, désabonnements, conversations analysées) sur les profils qu’il connaît.',
            'The tool that receives the console’s signals (deliveries, replies, clicks, unsubscribes, analysed conversations) on the profiles it knows.',
          )}
        </p>
      </header>

      <div className={cardCls} data-testid="integration-batch">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink-900">Batch</h3>
            <p className="mt-1 text-sm text-ink-600" data-testid="integration-batch-etat">
              {etat === null
                ? erreur === null
                  ? t('Lecture…', 'Loading…')
                  : t('État inconnu : la lecture a échoué.', 'Unknown state: the read failed.')
                : branche
                  ? t('Branché : les signaux partent vers vos profils Batch.', 'Connected: signals go to your Batch profiles.')
                  : t('Non branché : aucun signal ne part.', 'Not connected: no signal is sent.')}
            </p>
          </div>
          <span className="text-xs text-ink-400">{libelle}</span>
        </div>

        {branche && etat?.refusClesLe && (
          <p className="mt-3 rounded-lg border border-coral px-3 py-2 text-sm text-coral" data-testid="integration-batch-refus">
            {t(
              `Batch a refusé vos clés le ${date(etat.refusClesLe)} : la remontée est suspendue jusqu’à ce que vous enregistriez des clés valides.`,
              `Batch rejected your keys on ${date(etat.refusClesLe)}: signals are paused until you save valid keys.`,
            )}
          </p>
        )}

        {branche && (
          <p className="mt-3 text-sm text-ink-600" data-testid="integration-batch-sans-identifiant">
            {perdus === 0
              ? t('Toutes les fiches concernées portaient un identifiant externe.', 'Every contact involved had an external id.')
              : perdus === 1
                ? t(
                  `1 signal non poussé : sa fiche n’a pas d’identifiant externe (externalId), qui se transmet par l’API.${dernier ? ` Le ${dernier}.` : ''}`,
                  `1 signal not sent: its contact has no external id (externalId), which is passed through the API.${dernier ? ` On ${dernier}.` : ''}`,
                )
                : t(
                  `${perdus} signaux non poussés : ces fiches n’ont pas d’identifiant externe (externalId), qui se transmet par l’API.${dernier ? ` Dernier le ${dernier}.` : ''}`,
                  `${perdus} signals not sent: those contacts have no external id (externalId), which is passed through the API.${dernier ? ` Last on ${dernier}.` : ''}`,
                )}
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-ink-700">
            {t('Clé d’API REST', 'REST API key')}
            <input
              type="password"
              autoComplete="new-password"
              data-testid="integration-batch-cle-rest"
              value={cleRest}
              onChange={(e) => setCleRest(e.target.value)}
              placeholder={branche ? t('enregistrée : laisser vide pour la garder', 'saved: leave empty to keep it') : ''}
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className="block text-sm text-ink-700">
            {t('Clé de projet', 'Project key')}
            <input
              type="password"
              autoComplete="new-password"
              data-testid="integration-batch-cle-projet"
              value={cleProjet}
              onChange={(e) => setCleProjet(e.target.value)}
              placeholder={branche ? t('enregistrée : laisser vide pour la garder', 'saved: leave empty to keep it') : ''}
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>

        <label className="mt-3 flex items-start gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            data-testid="integration-batch-resume"
            checked={resume}
            onChange={(e) => setResume(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-ink-300"
          />
          <span>
            {t('Envoyer le résumé des conversations', 'Send conversation summaries')}
            <span className="block text-xs text-ink-500">
              {t(
                'Il contient des propos de vos clients : ne le cochez que si votre outil a le droit de les garder.',
                'It contains your customers’ words: tick it only if your tool is allowed to keep them.',
              )}
            </span>
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            data-testid="integration-batch-enregistrer"
            onClick={enregistrer}
            disabled={!peutEnregistrer}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-200"
          >
            {branche ? t('Enregistrer', 'Save') : t('Brancher', 'Connect')}
          </button>
          {branche && (
            <button
              data-testid="integration-batch-debrancher"
              onClick={debrancher}
              disabled={statut === 'saving'}
              className="rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed"
            >
              {t('Débrancher', 'Disconnect')}
            </button>
          )}
          {etat !== null && !branche && !clesSaisies && (
            <span className="text-xs text-ink-500">{t('Les deux clés sont requises pour brancher.', 'Both keys are required to connect.')}</span>
          )}
        </div>

        {erreur !== null && <p className="mt-3 text-sm text-coral" data-testid="integration-batch-erreur">{erreur}</p>}
      </div>
    </section>
  );
}
