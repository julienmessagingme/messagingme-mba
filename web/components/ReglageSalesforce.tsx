'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { Toggle } from '@/components/Toggle';
import { routeInconnue } from '@/lib/canaux-services';
import { lireIntegration, setSalesforceActif } from '@/lib/api-salesforce';
import { etatCarteSalesforce, phraseEtatOrg, type IntegrationSalesforceVue } from '@/lib/salesforce';
import { useFermeture } from '@/lib/use-offre';

/**
 * PARAMÈTRES > INTÉGRATIONS > SALESFORCE : l'interrupteur de l'espace et l'état de l'org (plan 2026-09-26, lot L1).
 * La connexion elle-même vit sur sa propre page (`/parametres/salesforce`), qui accueillera aussi les réglages.
 *
 * 🔴 UNE INTÉGRATION NEUVE NE S'AFFICHE PAS AVANT SON API. Vercel publie la console au push, l'API attend son
 * déploiement : tant que la route n'existe pas (404 du routeur), la carte n'est PAS rendue, plutôt que d'offrir un
 * interrupteur qui mènerait à une route absente. C'est l'inverse de HubSpot, qui avait un existant à préserver.
 *
 * 🔴 L'EXTINCTION EST BLOQUÉE TANT QU'UNE ORG EST RELIÉE (le serveur rend 409, et son message s'affiche tel quel
 * si l'état a changé entre-temps) : éteindre par-dessus une org connectée mentirait.
 *
 * ⚠️ ADMIN SEULEMENT : la carte ne vit que dans la page des administrateurs, et ses routes sont sous `g.admin`.
 */
export function ReglageSalesforce({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [vue, setVue] = useState<IntegrationSalesforceVue | null>(null);
  const [lecture, setLecture] = useState<'en_cours' | 'ok' | 'illisible' | 'absente' | 'echec'>('en_cours');
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [erreur, setErreur] = useState<string | null>(null);

  // L'offre d'abord (lot 6) : Salesforce est un connecteur CRM ; fermé, il n'est pas lu (la route est gardée).
  const ferme = useFermeture(tenantId, 'crm');
  useEffect(() => {
    if (ferme !== null) return;
    let vivant = true;
    lireIntegration(tenantId)
      .then((v) => {
        if (!vivant) return;
        setVue(v);
        setLecture(v ? 'ok' : 'illisible');
      })
      .catch((e: unknown) => { if (vivant) setLecture(routeInconnue(e) ? 'absente' : 'echec'); });
    return () => { vivant = false; };
  }, [tenantId, ferme]);

  useEffect(() => {
    if (lecture === 'ok' && window.location.hash === '#integration-salesforce') document.getElementById('integration-salesforce')?.scrollIntoView();
  }, [lecture]);

  const basculer = useCallback(() => {
    if (!vue) return;
    const suivant = !vue.actif;
    setVue({ ...vue, actif: suivant });
    setStatut('saving');
    setErreur(null);
    setSalesforceActif(tenantId, suivant)
      .then(() => setStatut('saved'))
      .catch((e: unknown) => {
        setVue((v) => (v ? { ...v, actif: !suivant } : v));
        setStatut('error');
        setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Unable to save'));
      });
  }, [vue, tenantId, t]);

  // ⚠️ CACHÉE, ET NON « INCLUS DANS L'OFFRE ENTREPRISE », quand l'offre ferme le CRM : cette carte se cache déjà quand
  // l'instance n'a pas Salesforce (route 404), et l'annoncer à une Base promettrait peut-être un connecteur absent.
  if (ferme) return null;

  // Route absente (API pas encore déployée) ou réponse illisible : une intégration neuve ne s'affiche pas.
  if (lecture === 'absente' || lecture === 'en_cours' || lecture === 'illisible') return null;

  const etat = vue ? etatCarteSalesforce(vue) : null;
  const raison = t(
    'Une org Salesforce est reliée : pour éteindre Salesforce, déconnectez-la d’abord depuis sa page.',
    'A Salesforce org is connected: to turn Salesforce off, disconnect it first from its page.',
  );
  const libelle = statut === 'saving' ? t('enregistrement…', 'saving…') : statut === 'saved' ? t('enregistré', 'saved') : '';

  return (
    <section id="integration-salesforce" className={cardCls} data-testid="integration-salesforce">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-900">Salesforce</h3>
          <p className="mt-1 text-sm text-ink-500" data-testid="integration-salesforce-etat">
            {!vue
              ? t('État inconnu : la lecture a échoué.', 'Unknown state: the read failed.')
              : !vue.cleAppPosee
                ? t('L’app Salesforce n’est pas encore disponible sur votre instance Messaging Me.', 'The Salesforce app is not available on your Messaging Me instance yet.')
                : vue.actif
                  ? phraseEtatOrg(vue.org, t)
                  : t('Éteint : Salesforce n’est pas branché à cet espace.', 'Off: Salesforce is not connected to this workspace.')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-ink-500">{libelle}</span>
          {vue && etat && vue.cleAppPosee && (
            <Toggle
              testid="integration-salesforce-toggle"
              checked={vue.actif}
              onChange={basculer}
              disabled={statut === 'saving' || etat.extinctionBloquee}
              title={etat.extinctionBloquee ? raison : t('Allumer ou éteindre Salesforce pour cet espace', 'Turn Salesforce on or off for this workspace')}
            />
          )}
        </div>
      </div>

      {etat?.extinctionBloquee && (
        <p className="mt-3 text-sm text-ink-500" data-testid="integration-salesforce-raison">{raison}</p>
      )}

      {erreur && <p className="mt-3 text-sm text-danger" data-testid="integration-salesforce-erreur">{erreur}</p>}

      {vue?.actif && etat?.proposerConnexion && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link href="/parametres/salesforce" data-testid="integration-salesforce-page" className="text-sm font-medium text-brand-600 hover:underline">
            {vue.org ? t('Gérer la connexion', 'Manage the connection') : t('Connecter une org Salesforce', 'Connect a Salesforce org')}
          </Link>
          <a href="/tuto-salesforce" target="_blank" rel="noopener noreferrer" data-testid="integration-salesforce-tuto" className="text-sm text-brand-600 hover:underline">
            {t('Ce que votre admin Salesforce doit faire (guide)', 'What your Salesforce admin needs to do (guide)')}
          </a>
        </div>
      )}
    </section>
  );
}
