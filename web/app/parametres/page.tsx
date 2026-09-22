'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useT, useLocale } from '@/lib/i18n';
import { getSettings, setTimezone as apiSetTimezone, setBusinessHours as apiSetBusinessHours, setGrillePrix as apiSetGrillePrix, agentsPeuventPrendre as apiAgentsPeuventPrendre, setAgentsPeuventPrendre as apiSetAgentsPeuventPrendre, type BusinessHours, type GrillePrix } from '@/lib/api';
import { TIMEZONES, timezoneLabel, DEFAULT_TIMEZONE } from '@/lib/timezones';
import { inputClsAuto } from '@/lib/ui';
import { enChamps, depuisChamps } from '@/lib/grille-saisie';
import { BlockedContacts } from '@/components/BlockedContacts';
import { Toggle } from '@/components/Toggle';

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
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Paramètres', 'Settings')}</span>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Votre équipe', 'Your team')}</h2>
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
    <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm" data-testid="param-prise-agents">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-900">{t('Les agents peuvent prendre une conversation non affectée', 'Agents can take an unassigned conversation')}</h3>
          <p className="mt-1 text-sm text-ink-600">
            {t(
              'Activé, un agent voit « Je m’en occupe » sur une conversation que personne n’a, et se l’affecte. Il ne peut jamais la passer à un collègue ni la rendre : seuls les managers et les admins distribuent les conversations.',
              'When on, an agent sees “I’ll take it” on a conversation nobody has, and assigns it to themselves. They can never hand it to a colleague or give it back: only managers and admins distribute conversations.',
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-xs ${statut === 'error' ? 'text-coral' : 'text-ink-400'}`}>{libelle}</span>
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

  /**
   * CE QUE CET ESPACE FACTURE. `null` = l'instance ne rend pas encore la grille (backend anterieur au
   * 2026-09-18) : la section ne s'affiche alors PAS, plutot qu'un formulaire de zeros qui ferait croire
   * que tout est gratuit.
   *
   * 🔴 PAS D'ENREGISTREMENT OPTIMISTE ICI, contrairement au fuseau et au toggle juste au-dessus. Ce sont
   * des PRIX : afficher « enregistre » avant la reponse du serveur, sur un formulaire dont une valeur peut
   * etre refusee par les bornes, laisserait le client repartir en croyant sa marge posee. Le bouton attend.
   */
  const [prix, setPrix] = useState<Record<string, string> | null>(null);
  const [prixStatus, setPrixStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [prixChamp, setPrixChamp] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSettings(tenantId)
      .then((s) => {
        if (!alive) return;
        setTz(s.timezone ?? DEFAULT_TIMEZONE);
        setHours(normalize(s.businessHours));
        setPrix(s.prix ? enChamps(s.prix) : null);
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId]);

  /**
   * 🔴 LA SAISIE RESTE UNE CHAINE, ET LA PREMIERE VERSION FAISAIT L INVERSE DE CE QUE SON COMMENTAIRE
   * ANNONCAIT. Elle appelait `Number(valeur)` a chaque frappe sur un champ CONTROLE : taper « 3 » puis
   * « . » donnait `Number('3.') === 3`, le point etait reecrit hors du champ et disparaissait, donc on ne
   * pouvait JAMAIS creer un separateur decimal ; vider le champ donnait `Number('') === 0` et le champ se
   * remplissait tout seul de « 0 », c est-a-dire exactement le symptome que le commentaire disait avoir
   * evite ; et « 3,15 » a la francaise donnait `NaN`, affiche tel quel. Sur un ecran dont un defaut vaut
   * 2,48, passer de 2,48 a 3,10 rendait 310, refuse par les bornes. Releve en revue finale le 2026-09-18 :
   * la seule piece non testee de ce lot etait aussi la seule qui etait cassee.
   *
   * La conversion se fait donc A L ENREGISTREMENT, une seule fois, et la virgule francaise y est acceptee.
   */
  const onPrix = useCallback((champ: string, valeur: string) => {
    setPrix((p) => (p === null ? p : { ...p, [champ]: valeur }));
    setPrixStatus('idle');
    setPrixChamp(null);
  }, []);

  const enregistrerPrix = useCallback(() => {
    if (prix === null) return;
    setPrixStatus('saving');
    apiSetGrillePrix(tenantId, depuisChamps(prix))
      .then((r) => { setPrix(enChamps(r.prix)); setPrixStatus('saved'); setPrixChamp(null); })
      .catch((err: unknown) => {
        // Le serveur NOMME le champ fautif : le montrer vaut mieux qu'un « erreur » qui oblige a chercher
        // lequel des six ne va pas.
        const champ = err instanceof Error ? /champ invalide : (\w+)/.exec(err.message)?.[1] ?? null : null;
        setPrixChamp(champ);
        setPrixStatus('error');
      });
  }, [prix, tenantId]);

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

  const cardCls = 'rounded-2xl border border-ink-200 bg-white p-5 shadow-sm';
  const kicker = 'text-xs font-semibold uppercase tracking-wide text-brand-600';

  const statusText = (s: typeof tzStatus) =>
    s === 'saving' ? t('enregistrement…', 'saving…') : s === 'saved' ? t('enregistré', 'saved') : s === 'error' ? t('erreur', 'error') : '';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <span className={kicker}>{t('Paramètres', 'Settings')}</span>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Fuseau & heures d’ouverture', 'Time zone & business hours')}</h2>
        <p className="text-sm text-ink-600">{t('Base des conditions temporelles de vos scénarios (maintenant, jour de semaine, heures d’ouverture).', 'The basis for the time conditions in your scenarios (now, weekday, business hours).')}</p>
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
              <span className={`text-xs ${tzStatus === 'error' ? 'text-coral' : 'text-ink-400'}`}>{statusText(tzStatus)}</span>
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
              <span className={`text-xs ${bhStatus === 'error' ? 'text-coral' : 'text-ink-400'}`}>{statusText(bhStatus)}</span>
            </div>
            <div className="space-y-2">
              {DAY_ORDER.map((d) => {
                const day = hours[d]!;
                const invalid = !dayValid(day);
                return (
                  <div key={d} className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-100 px-3 py-2">
                    <span className="w-24 shrink-0 text-sm font-medium text-ink-800">{t(...DAY_LABELS[d]!)}</span>
                    <label className="flex items-center gap-1.5 text-sm text-ink-600">
                      <input type="checkbox" checked={day.closed} onChange={(e) => patchDay(d, { closed: e.target.checked })} className="h-4 w-4 rounded border-ink-300" />
                      {t('Fermé', 'Closed')}
                    </label>
                    {!day.closed && (
                      <div className="flex items-center gap-2">
                        <input type="time" value={day.open} onChange={(e) => patchDay(d, { open: e.target.value })} className={`${inputClsAuto} bg-white`} />
                        <span className="text-sm text-ink-400">{t('à', 'to')}</span>
                        <input type="time" value={day.close} onChange={(e) => patchDay(d, { close: e.target.value })} className={`${inputClsAuto} bg-white`} />
                        {invalid && <span className="text-xs text-coral">{t('l’heure de fin doit suivre le début', 'end time must be after start')}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button
                data-testid="param-save-hours"
                onClick={saveHours}
                disabled={!allValid || bhStatus === 'saving'}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-200"
              >
                {t('Enregistrer les horaires', 'Save hours')}
              </button>
              {!allValid && <span className="text-xs text-coral">{t('Corrigez les jours en rouge avant d’enregistrer.', 'Fix the days in red before saving.')}</span>}
            </div>
          </section>

          {/* ⚠️ « Relancer automatiquement les échecs » N'EST PLUS ICI (lot 3 de la liste du 2026-09-23, migration
              0165) : la relance obéit à la case « Réessayer les envois qui échouent » de chaque campagne. */}

          {/* La prise d'une conversation par un agent : la même section que celle du manager. */}
          <SectionPriseAgents tenantId={tenantId} />

          {/*
            CE QUE CET ESPACE FACTURE (migration 0154).

            🔴 CETTE SECTION EST LE CHEMIN QUI MANQUAIT. Les six colonnes existaient en base et AUCUN ecran
            ne les ecrivait : la marge negociee n'etait atteignable que par un UPDATE SQL a la main sur la
            production. C'est le motif « une capacite livree sans le chemin qui la produit », releve en revue
            finale le 2026-09-17, et que ce depot a deja paye trois fois sur un seul chantier.

            ⚠️ MASQUEE quand l'instance ne rend pas la grille : un formulaire de zeros ferait croire que
            tout est gratuit, ce qui est pire que de ne rien montrer.
          */}
          {prix !== null && (
            <section className="rounded-2xl border border-ink-200 bg-white p-5" data-testid="reglages-prix">
              <h2 className="text-sm font-semibold text-ink-900">{t('Vos prix', 'Your pricing')}</h2>
              <p className="mt-1 text-xs text-ink-500">
                {t(
                  'Ce que vous facturez, et non ce que vous payez. Le tarif des templates vient de Meta : vous posez une marge dessus. Les autres prix se negocient, ils se saisissent.',
                  'What you charge, not what you pay. Template rates come from Meta: you set a margin on top. The other prices are negotiated, so you enter them.',
                )}
              </p>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Champ
                  id="marge" label={t('Marge sur le tarif Meta', 'Margin on the Meta rate')}
                  aide={t('En pourcent. 100 = vous facturez exactement le tarif Meta.', 'In percent. 100 = you charge exactly the Meta rate.')}
                  valeur={prix.margeTemplate ?? ''} onChange={(v) => onPrix('margeTemplate', v)}
                  suffixe="%" fautif={prixChamp === 'margeTemplate'}
                />
                <Champ
                  id="service" label={t('Message de service', 'Service message')}
                  aide={t('Prix d un message hors template, en centimes.', 'Price of one non-template message, in cents.')}
                  valeur={prix.serviceCentimes ?? ''} onChange={(v) => onPrix('serviceCentimes', v)}
                  suffixe={t('cts', 'cts')} fautif={prixChamp === 'serviceCentimes'}
                />
                <Champ
                  id="franchise" label={t('Messages de service offerts', 'Free service messages')}
                  aide={t('Par mois et par espace. Au-dela, chaque message est facture.', 'Per month and per workspace. Beyond that, every message is charged.')}
                  valeur={prix.serviceFranchise ?? ''} onChange={(v) => onPrix('serviceFranchise', v)}
                  suffixe={t('/ mois', '/ month')} fautif={prixChamp === 'serviceFranchise'}
                />
                <Champ
                  id="depuis" label={t('Facture a partir du', 'Charged from')}
                  aide={t('Avant cette date, les messages de service ne comptent pas.', 'Before this date, service messages are not counted.')}
                  valeur={prix.serviceDepuis ?? ''} onChange={(v) => onPrix('serviceDepuis', v)}
                  type="date" fautif={prixChamp === 'serviceDepuis'}
                />
                <Champ
                  id="rcs" label={t('RCS simple', 'Plain RCS')}
                  aide={t('Un envoi RCS sans echange, en centimes.', 'One RCS send with no exchange, in cents.')}
                  valeur={prix.rcsSimpleCentimes ?? ''} onChange={(v) => onPrix('rcsSimpleCentimes', v)}
                  suffixe={t('cts', 'cts')} fautif={prixChamp === 'rcsSimpleCentimes'}
                />
                <Champ
                  id="rcsconv" label={t('RCS conversationnel', 'Conversational RCS')}
                  aide={t('Des qu une personne repond, TOUT l echange passe a ce prix.', 'As soon as someone replies, the WHOLE exchange moves to this price.')}
                  valeur={prix.rcsConversationnelCentimes ?? ''} onChange={(v) => onPrix('rcsConversationnelCentimes', v)}
                  suffixe={t('cts', 'cts')} fautif={prixChamp === 'rcsConversationnelCentimes'}
                />
              </div>

              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button" onClick={enregistrerPrix} disabled={prixStatus === 'saving'}
                  data-testid="prix-enregistrer"
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  {prixStatus === 'saving' ? t('Enregistrement...', 'Saving...') : t('Enregistrer', 'Save')}
                </button>
                {prixStatus === 'saved' && <span className="text-xs text-emerald-700" data-testid="prix-ok">{t('Enregistre', 'Saved')}</span>}
                {/* Le serveur REFUSE une valeur hors bornes au lieu de la corriger, et il nomme le champ :
                    un « erreur » nu obligerait a chercher lequel des six ne va pas. */}
                {prixStatus === 'error' && (
                  <span className="text-xs text-red-700" data-testid="prix-erreur">
                    {prixChamp
                      ? t('Valeur refusee, corrigez le champ en rouge.', 'Value rejected, fix the field in red.')
                      : t('Enregistrement impossible.', 'Could not save.')}
                  </span>
                )}
              </div>

              {/* ⚠️ CE QUE CES PRIX NE FONT PAS, dit plutot que laisse deviner : ils changent ce que la
                  Synthese AFFICHE, ils n emettent aucune facture et ne touchent a rien chez Meta. */}
              <p className="mt-3 text-xs text-ink-400">
                {t(
                  'Ces prix servent a chiffrer ce que vous voyez dans Performance Lab. Ils n emettent aucune facture et ne changent rien chez Meta.',
                  'These prices are used to cost what you see in Performance Lab. They issue no invoice and change nothing at Meta.',
                )}
              </p>
            </section>
          )}

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

/**
 * Un champ de la grille de prix : libelle, aide, valeur, et un lisere rouge quand le serveur a nomme
 * CE champ comme fautif. Le suffixe (%, cts, / mois) porte l unite, qui autrement se devine.
 */
function Champ({ id, label, aide, valeur, onChange, suffixe, type = 'text', fautif }: {
  id: string; label: string; aide: string; valeur: string;
  onChange: (v: string) => void; suffixe?: string; type?: string; fautif?: boolean;
}) {
  return (
    <div>
      <label htmlFor={`prix-${id}`} className="block text-xs font-medium text-ink-700">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={`prix-${id}`} type={type} value={valeur} onChange={(e) => onChange(e.target.value)}
          data-testid={`prix-${id}`}
          className={`w-36 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-100 ${fautif ? 'border-red-400 focus:border-red-500' : 'border-ink-300 focus:border-brand-500'}`}
        />
        {suffixe && <span className="text-xs text-ink-500">{suffixe}</span>}
      </div>
      <p className="mt-1 text-xs text-ink-400">{aide}</p>
    </div>
  );
}
