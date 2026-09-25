'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getSettings, getAccountStatus, setHubspotActif } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { Toggle } from '@/components/Toggle';
import { lireHubspotActif, etatCarteHubspot } from '@/lib/hubspot-actif';
import { useInstallationHubspot } from '@/lib/hubspot-installation';

/**
 * PARAMÈTRES > INTÉGRATIONS > HUBSPOT : l'interrupteur HubSpot de l'espace (migration 0179, design validé par
 * Julien le 2026-09-25).
 *
 * Allumé, le bloc HubSpot s'affiche sur l'Accueil, numéro WhatsApp ou pas. C'est ce qui manquait : un espace
 * neuf, sans numéro, n'avait aucun bouton pour connecter HubSpot.
 *
 * 🔴 L'EXTINCTION EST BLOQUÉE TANT QU'UN PORTAIL EST RELIÉ, et l'écran le dit avant le clic (le serveur rend
 * 409 de toute façon, et son message s'affiche tel quel si l'état a changé entre-temps). Les analyses
 * partiraient encore vers un portail relié : éteindre par-dessus mentirait.
 *
 * ⚠️ ADMIN SEULEMENT : cette carte ne vit que dans la page des administrateurs (un manager ne voit de
 * Paramètres que la prise des conversations), et ses routes sont gardées par `g.admin`.
 *
 * ⚠️ DEUX LECTURES, UNE SEULE DÉCISION. « Relié ou non » vient des RÉGLAGES (`hubspotPortalConnecte`, la
 * lecture du masquage du lot 9) ; le statut du compte ne sert qu'à NOMMER le portail, en décoration. Une
 * lecture du statut qui échoue n'enlève donc rien : la carte dit « relié à un portail » sans son nom.
 */
export function ReglageHubspot({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [actif, setActif] = useState<boolean | undefined>(undefined);
  const [relie, setRelie] = useState<boolean | undefined>(undefined);
  const [nomPortail, setNomPortail] = useState<string | null>(null);
  const [lecture, setLecture] = useState<'en_cours' | 'ok' | 'echec'>('en_cours');
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [erreur, setErreur] = useState<string | null>(null);
  const { ouvrir, enCours } = useInstallationHubspot(tenantId, true);

  useEffect(() => {
    let vivant = true;
    getSettings(tenantId)
      .then((s) => {
        if (!vivant) return;
        setActif(lireHubspotActif(s));
        setRelie(typeof s.hubspotPortalConnecte === 'boolean' ? s.hubspotPortalConnecte : undefined);
        setLecture('ok');
      })
      .catch(() => { if (vivant) setLecture('echec'); });
    getAccountStatus(tenantId)
      .then((a) => {
        const p = a?.hubspotPortal;
        if (vivant && p?.connected) setNomPortail(p.hubDomain ?? p.hubId ?? null);
      })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId]);

  // L'Accueil renvoie ici par `#integration-hubspot` ; la page ne rend ses cartes qu'après sa propre lecture,
  // donc l'ancre n'existe pas encore quand le navigateur la cherche. On y va une fois la carte lue.
  useEffect(() => {
    if (lecture !== 'en_cours' && window.location.hash === '#integration-hubspot') document.getElementById('integration-hubspot')?.scrollIntoView();
  }, [lecture]);

  const etat = actif === undefined ? null : etatCarteHubspot({ actif, portailRelie: relie });

  const basculer = useCallback(() => {
    if (actif === undefined) return;
    const suivant = !actif;
    setActif(suivant);
    setStatut('saving');
    setErreur(null);
    setHubspotActif(tenantId, suivant)
      .then(() => setStatut('saved'))
      .catch((e: unknown) => {
        setActif(!suivant);
        setStatut('error');
        setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Unable to save'));
      });
  }, [actif, tenantId, t]);

  const raison = t(
    'Un portail HubSpot est relié : pour éteindre HubSpot, faites d’abord la « Déconnexion complète » depuis l’Accueil.',
    'A HubSpot portal is linked: to turn HubSpot off, first run “Full disconnect” from the Home page.',
  );
  const libelle = statut === 'saving' ? t('enregistrement…', 'saving…') : statut === 'saved' ? t('enregistré', 'saved') : '';

  return (
    <section id="integration-hubspot" className={cardCls} data-testid="integration-hubspot">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-900">HubSpot</h3>
          <p className="mt-1 text-sm text-ink-600" data-testid="integration-hubspot-etat">
            {actif === undefined
              ? lecture === 'en_cours'
                ? t('Lecture…', 'Loading…')
                : lecture === 'echec'
                  ? t('État inconnu : la lecture a échoué.', 'Unknown state: the read failed.')
                  // Lu, mais le serveur ne connaît pas encore ce réglage (API plus ancienne que l'écran).
                  : t('Réglage indisponible pour le moment.', 'Setting not available yet.')
              : actif
                ? t('Allumé : le bloc HubSpot s’affiche sur l’Accueil, avec la connexion à votre portail.', 'On: the HubSpot block shows on the Home page, with the connection to your portal.')
                : t('Éteint : HubSpot n’apparaît pas sur l’Accueil.', 'Off: HubSpot does not show on the Home page.')}
          </p>
          {relie !== undefined && (
            <p className="mt-1 text-sm text-ink-600" data-testid="integration-hubspot-portail">
              {relie
                ? nomPortail
                  ? t(`Relié au portail ${nomPortail}.`, `Linked to portal ${nomPortail}.`)
                  : t('Relié à un portail HubSpot.', 'Linked to a HubSpot portal.')
                : t('Aucun portail HubSpot relié.', 'No HubSpot portal linked.')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-ink-400">{libelle}</span>
          {etat !== null && actif !== undefined && (
            <Toggle
              testid="integration-hubspot-toggle"
              checked={actif}
              onChange={basculer}
              disabled={statut === 'saving' || etat.extinctionBloquee}
              title={etat.extinctionBloquee ? raison : t('Allumer ou éteindre HubSpot pour cet espace', 'Turn HubSpot on or off for this workspace')}
            />
          )}
        </div>
      </div>

      {etat?.extinctionBloquee && (
        <p className="mt-3 text-sm text-ink-600" data-testid="integration-hubspot-raison">
          {raison}{' '}
          <Link href="/accueil" className="text-brand-600 hover:underline">{t('Aller à l’Accueil', 'Go to Home')}</Link>
        </p>
      )}

      {erreur && <p className="mt-3 text-sm text-coral" data-testid="integration-hubspot-erreur">{erreur}</p>}

      {actif && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {etat?.proposerConnexion && (
            <button
              type="button"
              data-testid="integration-hubspot-connecter"
              onClick={() => void ouvrir()}
              disabled={enCours}
              className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
            >
              {t('Connecter HubSpot', 'Connect HubSpot')}
            </button>
          )}
          <a href="/tuto-hubspot" target="_blank" rel="noopener noreferrer" data-testid="integration-hubspot-tuto" className="text-sm text-brand-600 hover:underline">
            {t('Quoi faire dans HubSpot après la connexion ? (tuto)', 'What to do in HubSpot after connecting? (guide)')}
          </a>
        </div>
      )}
    </section>
  );
}
