'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useT, useLocale } from '@/lib/i18n';
import { getSettings, setTimezone as apiSetTimezone, setBusinessHours as apiSetBusinessHours, agentsPeuventPrendre as apiAgentsPeuventPrendre, setAgentsPeuventPrendre as apiSetAgentsPeuventPrendre, type BusinessHours } from '@/lib/api';
import { TIMEZONES, timezoneLabel, DEFAULT_TIMEZONE } from '@/lib/timezones';
import { inputClsAuto } from '@/lib/ui';
import { BlockedContacts } from '@/components/BlockedContacts';
import { ReglageIntegrationBatch } from '@/components/ReglageIntegrationBatch';
import { ReglageHubspot } from '@/components/ReglageHubspot';
import { Toggle } from '@/components/Toggle';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';

/**
 * 🔴 DEUX PAGES SOUS LA MÊME ADRESSE, SELON LE RÔLE (2026-09-19). Paramètres était réservé aux admins ; il
 * s'ouvre aux MANAGERS pour UN réglage, « les agents peuvent prendre une conversation du pot commun », que
 * Julien a voulu à leur main. Un manager ne voit QUE cette section : lui montrer le fuseau ou les prix pour
 * les lui refuser ensuite serait promettre une porte fermée. Le serveur tient la même frontière de son côté.
 */
export default function ParametresPage() {
  return (
    <AppShell active="parametres">
      {(session) => (session.role === 'admin'
        ? <Parametres tenantId={session.tenantId} />
        : <ParametresEncadrement tenantId={session.tenantId} />)}
    </AppShell>
  );
}

/** Ce qu'un MANAGER voit de Paramètres : la seule section qu'il peut régler. */
function ParametresEncadrement({ tenantId }: { tenantId: string }) {
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <span className="text-xs font-medium text-ink-500">{t('Paramètres', 'Settings')}</span>
        <TitrePage>{t('Votre équipe', 'Your team')}</TitrePage>
      </header>
      <SectionPriseAgents tenantId={tenantId} />
    </div>
  );
}

/**
 * LES AGENTS PEUVENT-ILS PRENDRE UNE CONVERSATION DU POT COMMUN ? (migration 0160)
 *
 * 🔴 PRENDRE, JAMAIS RÉAFFECTER (arbitrage de Julien du 2026-09-19) : activé, un agent voit « Je m'en occupe »
 * sur une conversation que personne n'a, et peut se l'affecter. Il ne peut ni la passer à un collègue ni la
 * rendre ensuite ; la distribution reste le geste de l'encadrement. Le texte le DIT, parce que « prendre »
 * se confond facilement avec « réaffecter ».
 *
 * ⚠️ OPTIMISTE, comme la relance automatique : on bascule tout de suite, et on revient en arrière si le
 * serveur refuse. `null` tant que la valeur n'est pas lue : un interrupteur affiché « coupé » avant la
 * lecture ferait croire à un réglage qui n'existe pas encore.
 */
function SectionPriseAgents({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [actif, setActif] = useState<boolean | null>(null);
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let vivant = true;
    apiAgentsPeuventPrendre(tenantId)
      .then((r) => { if (vivant) setActif(r.actif === true); })
      .catch(() => { if (vivant) setStatut('error'); });
    return () => { vivant = false; };
  }, [tenantId]);

  const basculer = useCallback(() => {
    if (actif === null) return;
    const suivant = !actif;
    setActif(suivant);
    setStatut('saving');
    apiSetAgentsPeuventPrendre(tenantId, suivant)
      .then(() => setStatut('saved'))
      .catch(() => { setActif(!suivant); setStatut('error'); });
  }, [actif, tenantId]);

  const libelle = statut === 'saving' ? t('enregistrement…', 'saving…') : statut === 'saved' ? t('enregistré', 'saved') : statut === 'error' ? t('erreur', 'error') : '';

  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5" data-testid="param-prise-agents">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-900">{t('Les agents peuvent prendre une conversation non affectée', 'Agents can take an unassigned conversation')}</h3>
          <p className="mt-1 text-sm text-ink-500">
            {t(
              'Activé, un agent voit « Je m’en occupe » sur une conversation que personne n’a, et se l’affecte. Il ne peut jamais la passer à un collègue ni la rendre : seuls les managers et les admins distribuent les conversations.',
              'When on, an agent sees “I’ll take it” on a conversation nobody has, and assigns it to themselves. They can never hand it to a colleague or give it back: only managers and admins distribute conversations.',
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-xs ${statut === 'error' ? 'text-danger' : 'text-ink-400'}`}>{libelle}</span>
          {actif !== null && (
            <Toggle
              testid="param-prise-agents-toggle"
              checked={actif}
              onChange={basculer}
              disabled={statut === 'saving'}
              title={t('Autoriser les agents à prendre une conversation non affectée', 'Allow agents to take an unassigned conversation')}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// Ordre d'AFFICHAGE Lun -> Dim ; les clés restent '0'..'6' (0 = dimanche), alignées sur le serveur.
const DAY_ORDER = ['1', '2', '3', '4', '5', '6', '0'] as const;
const DAY_LABELS: Record<string, [string, string]> = {
  '1': ['Lundi', 'Monday'], '2': ['Mardi', 'Tuesday'], '3': ['Mercredi', 'Wednesday'],
  '4': ['Jeudi', 'Thursday'], '5': ['Vendredi', 'Friday'], '6': ['Samedi', 'Saturday'], '0': ['Dimanche', 'Sunday'],
};

/** Complète une semaine partielle : 7 jours garantis, un jour manquant -> fermé. */
function normalize(hours: BusinessHours | undefined): BusinessHours {
  const out: BusinessHours = {};
  for (const d of ['0', '1', '2', '3', '4', '5', '6']) {
    const day = hours?.[d];
    out[d] = day ? { closed: !!day.closed, open: day.open ?? '', close: day.close ?? '' } : { closed: true, open: '', close: '' };
  }
  return out;
}

/** Un jour est valide s'il est fermé, ou ouvert avec open < close (les inputs type=time garantissent HH:MM). */
function dayValid(d: { closed: boolean; open: string; close: string }): boolean {
  return d.closed || (d.open !== '' && d.close !== '' && d.close > d.open);
}

function Parametres({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [timezone, setTz] = useState(DEFAULT_TIMEZONE);
  const [hours, setHours] = useState<BusinessHours>(() => normalize(undefined));
  const [loading, setLoading] = useState(true);
  const [tzStatus, setTzStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [bhStatus, setBhStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let alive = true;
    getSettings(tenantId)
      .then((s) => {
        if (!alive) return;
        setTz(s.timezone ?? DEFAULT_TIMEZONE);
        setHours(normalize(s.businessHours));
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId]);

  const onTimezone = useCallback((iana: string) => {
    setTz(iana);
    setTzStatus('saving');
    apiSetTimezone(tenantId, iana).then(() => setTzStatus('saved')).catch(() => setTzStatus('error'));
  }, [tenantId]);

  const patchDay = (d: string, patch: Partial<{ closed: boolean; open: string; close: string }>) => {
    setBhStatus('idle');
    setHours((h) => ({ ...h, [d]: { ...h[d]!, ...patch } }));
  };

  const allValid = DAY_ORDER.every((d) => dayValid(hours[d]!));
  const saveHours = () => {
    if (!allValid) return;
    setBhStatus('saving');
    apiSetBusinessHours(tenantId, hours).then(() => setBhStatus('saved')).catch(() => setBhStatus('error'));
  };

  const cardCls = 'rounded-2xl border border-ink-200 bg-white p-5';
  const kicker = 'text-xs font-medium text-ink-500';

  const statusText = (s: typeof tzStatus) =>
    s === 'saving' ? t('enregistrement…', 'saving…') : s === 'saved' ? t('enregistré', 'saved') : s === 'error' ? t('erreur', 'error') : '';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <span className={kicker}>{t('Paramètres', 'Settings')}</span>
        <TitrePage>{t('Fuseau & heures d’ouverture', 'Time zone & business hours')}</TitrePage>
        <IntroPage>{t('Base des conditions temporelles de vos scénarios (maintenant, jour de semaine, heures d’ouverture).', 'The basis for the time conditions in your scenarios (now, weekday, business hours).')}</IntroPage>
      </header>

      {loading ? (
        <p className="text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>
      ) : (
        <>
          {/* Fuseau horaire */}
          <section className={cardCls}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">{t('Fuseau horaire', 'Time zone')}</h3>
                <p className="text-xs text-ink-500">{t('Toutes les conditions de temps sont évaluées dans ce fuseau.', 'All time conditions are evaluated in this zone.')}</p>
              </div>
              <span className={`text-xs ${tzStatus === 'error' ? 'text-danger' : 'text-ink-400'}`}>{statusText(tzStatus)}</span>
            </div>
            <select data-testid="param-timezone" value={timezone} onChange={(e) => onTimezone(e.target.value)} className={`${inputClsAuto} w-full bg-white sm:w-96`}>
              {TIMEZONES.map((o) => <option key={o.iana} value={o.iana}>{timezoneLabel(o, locale)}</option>)}
            </select>
          </section>

          {/* Heures d'ouverture */}
          <section className={cardCls}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">{t('Heures d’ouverture', 'Business hours')}</h3>
                <p className="text-xs text-ink-500">{t('Par jour : heure de début et de fin, ou fermé.', 'Per day: opening and closing time, or closed.')}</p>
              </div>
              <span className={`text-xs ${bhStatus === 'error' ? 'text-danger' : 'text-ink-400'}`}>{statusText(bhStatus)}</span>
            </div>
            <div className="space-y-2">
              {DAY_ORDER.map((d) => {
                const day = hours[d]!;
                const invalid = !dayValid(day);
                return (
                  <div key={d} className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-100 px-3 py-2">
                    <span className="w-24 shrink-0 text-sm font-medium text-ink-900">{t(...DAY_LABELS[d]!)}</span>
                    <label className="flex items-center gap-1.5 text-sm text-ink-500">
                      <input type="checkbox" checked={day.closed} onChange={(e) => patchDay(d, { closed: e.target.checked })} className="h-4 w-4 rounded border-ink-300" />
                      {t('Fermé', 'Closed')}
                    </label>
                    {!day.closed && (
                      <div className="flex items-center gap-2">
                        <input type="time" value={day.open} onChange={(e) => patchDay(d, { open: e.target.value })} className={`${inputClsAuto} bg-white`} />
                        <span className="text-sm text-ink-400">{t('à', 'to')}</span>
                        <input type="time" value={day.close} onChange={(e) => patchDay(d, { close: e.target.value })} className={`${inputClsAuto} bg-white`} />
                        {invalid && <span className="text-xs text-danger">{t('l’heure de fin doit suivre le début', 'end time must be after start')}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Bouton
                data-testid="param-save-hours"
                onClick={saveHours}
                disabled={!allValid || bhStatus === 'saving'}
              >
                {t('Enregistrer les horaires', 'Save hours')}
              </Bouton>
              {!allValid && <span className="text-xs text-danger">{t('Corrigez les jours en rouge avant d’enregistrer.', 'Fix the days in red before saving.')}</span>}
            </div>
          </section>

          {/* ⚠️ « Relancer automatiquement les échecs » N'EST PLUS ICI (lot 3 de la liste du 2026-09-23, migration
              0165) : la relance obéit à la case « Réessayer les envois qui échouent » de chaque campagne. */}

          {/* La prise d'une conversation par un agent : la même section que celle du manager. */}
          <SectionPriseAgents tenantId={tenantId} />

          {/* « VOS PRIX » A QUITTE CET ECRAN LE 2026-09-23 (lot 8, migration 0168). Il y a desormais UNE
              grille pour tous les espaces, reglee dans /ops : le client ne fixe plus, et ne voit plus, ce
              qu on lui facture, alors que cette section vivait derriere un JWT qu il possede. Les six
              champs n ont pas ete reecrits, ils vivent dans `web/components/GrillePrixChamps.tsx`. */}

          {/* INTÉGRATIONS (lot 6 de l'API publique) : l'outil qui reçoit les signaux. Admin seulement, comme
              tout ce bloc : un manager ne voit que la section de la prise par les agents. */}
          <ReglageIntegrationBatch tenantId={tenantId} />
          {/* ...et l'interrupteur HubSpot (migration 0179) : c'est lui qui fait apparaître le bloc HubSpot de
              l'Accueil, numéro ou pas. L'Accueil renvoie ici (`#integration-hubspot`) quand il est éteint. */}
          <ReglageHubspot tenantId={tenantId} />

          {/* Contacts bloqués : SEULE porte de sortie d'un blocage. Un contact bloqué n'apparaît nulle part
              ailleurs, donc sans cet écran il serait introuvable. La section se masque quand la liste est vide. */}
          <BlockedContacts tenantId={tenantId} />

          {/*
            ⚠️ LES DEUX JOURNAUX SONT PARTIS DANS « SÉCURITÉ » LE 2026-09-13, ensemble parce qu'ils étaient
            déjà ensemble, et parce qu'on ne les consulte pas pour la même raison qu'on vient ici : ils
            servent à RENDRE DES COMPTES, pas à régler l'espace. Aucune adresse n'a changé, `/parametres`
            existe à l'identique.
          */}
        </>
      )}
    </div>
  );
}

