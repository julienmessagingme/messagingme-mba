'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import {
  listAutomations, createAutomation, updateAutomation, deleteAutomation, listWorkflows, listHubspotDealStages,
  type Automation, type AutomationTriggerKind, type WorkflowSummary, type HubspotDealPipeline,
} from '@/lib/api';

export default function AutomationsPage() {
  return <AppShell active="automations">{(session) => <AutomationsInner session={session} />}</AppShell>;
}

const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function AutomationsInner({ session }: { session: Session }) {
  const t = useT();
  const [items, setItems] = useState<Automation[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulaire de création (replié tant qu'on ne clique pas « Ajouter »).
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [triggerKind, setTriggerKind] = useState<AutomationTriggerKind>('keyword');
  const [keywords, setKeywords] = useState('');
  const [mode, setMode] = useState<'contains' | 'equals'>('contains');
  const [tag, setTag] = useState('');
  const [sentiment, setSentiment] = useState<'' | 'positif' | 'neutre' | 'negatif'>('negatif');
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);
  const [workflowId, setWorkflowId] = useState('');
  // Étapes de deal : chargées SEULEMENT quand on choisit ce déclencheur (elles coûtent un aller-retour
  // jusqu'à HubSpot, inutile de le payer sur chaque ouverture de l'écran). `etatEtapes` distingue « aucun
  // portail lié » d'une vraie panne : dire « connecte HubSpot » alors que le serveur a échoué serait un
  // mensonge qui enverrait chercher le problème au mauvais endroit.
  const [dealPipelines, setDealPipelines] = useState<HubspotDealPipeline[]>([]);
  const [etatEtapes, setEtatEtapes] = useState<'idle' | 'chargement' | 'ok' | 'non_connecte' | 'erreur'>('idle');
  const [dealStageKey, setDealStageKey] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, w] = await Promise.all([listAutomations(session.tenantId), listWorkflows(session.tenantId)]);
      setItems(a.automations);
      setWorkflows(w.workflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Chargement PARESSEUX des étapes, une seule fois : on ne rappelle pas HubSpot chaque fois que l'admin
   * rebascule entre deux déclencheurs.
   *
   * ⚠️ Le garde-fou « déjà demandé » est une RÉFÉRENCE, pas l'état lui-même. Mettre `etatEtapes` dans les
   * dépendances créait un blocage : `setEtatEtapes('chargement')` relançait l'effet, dont le nettoyage
   * annulait la requête en vol, et l'écran restait figé sur « Lecture des étapes… » pour toujours. Trouvé par
   * le test de bout en bout, pas à la lecture.
   */
  const etapesDemandees = useRef(false);
  useEffect(() => {
    if (triggerKind !== 'hubspot_deal_stage' || etapesDemandees.current) return;
    etapesDemandees.current = true;
    setEtatEtapes('chargement');
    void listHubspotDealStages(session.tenantId)
      .then((r) => {
        setDealPipelines(r.pipelines);
        setEtatEtapes(r.connected ? 'ok' : 'non_connecte');
      })
      .catch(() => setEtatEtapes('erreur'));
  }, [triggerKind, session.tenantId]);

  // Étapes aplaties, chacune avec sa clé « pipeline::étape » : le sélecteur ne peut pas porter deux valeurs,
  // et il faut les DEUX (le serveur exige le pipeline, l'identifiant d'étape seul ne suffit pas).
  const etapes = dealPipelines.flatMap((p) => p.stages.map((s) => ({ ...s, cle: `${p.id}::${s.id}`, pipeline: p.label })));
  const etapeChoisie = etapes.find((s) => s.cle === dealStageKey);

  const wfName = (id: string): string => workflows.find((w) => w.id === id)?.name ?? t('scénario supprimé', 'deleted scenario');

  /**
   * Config du déclencheur, selon son type. L'étape de deal emporte son LIBELLÉ en plus des identifiants :
   * purement décoratif (la correspondance se fait sur l'identifiant, insensible à un renommage côté HubSpot),
   * mais il évite de rappeler HubSpot juste pour réafficher « Devis envoyé » dans la liste.
   */
  function configDuDeclencheur(): Record<string, unknown> {
    if (triggerKind === 'keyword') return { keywords: keywords.split(',').map((k) => k.trim()).filter((k) => k !== ''), mode };
    if (triggerKind === 'tag_added') return { tag: tag.trim() };
    if (triggerKind === 'conversation_analyzed') return { ...(sentiment !== '' ? { sentiment } : {}), ...(unresolvedOnly ? { unresolvedOnly: true } : {}) };
    if (triggerKind === 'hubspot_deal_stage') {
      const [pipelineId = '', stageId = ''] = dealStageKey.split('::');
      return { pipelineId, stageId, ...(etapeChoisie ? { stageLabel: etapeChoisie.label } : {}) };
    }
    return {};
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await createAutomation(session.tenantId, {
        name: name.trim(),
        triggerKind,
        triggerConfig: configDuDeclencheur(),
        workflowId,
        enabled: false, // jamais active à la création : on l'allume explicitement après relecture
      });
      // Remise à zéro COMPLÈTE : un filtre resté collé (ressenti, « non résolue », étape) produirait une
      // automation plus restrictive que voulu, sans que rien ne le signale à l'écran.
      setCreating(false); setName(''); setKeywords(''); setTag(''); setWorkflowId(''); setDealStageKey('');
      setMode('contains'); setSentiment('negatif'); setUnresolvedOnly(false); setTriggerKind('keyword');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Unable to create'));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(a: Automation) {
    // Optimiste : la bascule doit être immédiate, l'erreur éventuelle recharge l'état réel.
    setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await updateAutomation(session.tenantId, a.id, { enabled: !a.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Modification impossible', 'Unable to update'));
      await load();
    }
  }

  async function remove(a: Automation) {
    if (!window.confirm(t(`Supprimer l'automation « ${a.name} » ?`, `Delete automation "${a.name}"?`))) return;
    try {
      await deleteAutomation(session.tenantId, a.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  // Libellé affiché = EXACTEMENT celui du sélecteur : l'admin doit relire ce qu'il a choisi, pas la valeur brute.
  const sentimentLabel = (s: string): string =>
    s === 'negatif' ? t('négatif', 'negative') : s === 'neutre' ? t('neutre', 'neutral') : s === 'positif' ? t('positif', 'positive') : s;

  const describeTrigger = (a: Automation): string => {
    if (a.triggerKind === 'keyword') {
      const words = Array.isArray(a.triggerConfig.keywords) ? (a.triggerConfig.keywords as unknown[]).map(String) : [];
      const m = a.triggerConfig.mode === 'equals' ? t('message exactement égal à', 'message exactly equals') : t('message contenant', 'message containing');
      return `${m} ${words.map((w) => `« ${w} »`).join(t(' ou ', ' or '))}`;
    }
    if (a.triggerKind === 'new_contact') return t('1er message d’un nouveau contact', 'first message from a new contact');
    if (a.triggerKind === 'tag_added') return `${t('tag « ', 'tag "')}${String(a.triggerConfig.tag ?? '')}${t(' » ajouté', '" added')}`;
    if (a.triggerKind === 'conversation_analyzed') {
      const s = String(a.triggerConfig.sentiment ?? '');
      const parts = [
        s !== '' ? `${t('ressenti ', 'sentiment ')}${sentimentLabel(s)}` : t('toute conversation analysée', 'any analyzed conversation'),
        a.triggerConfig.unresolvedOnly === true ? t('non résolue', 'unresolved') : '',
      ].filter((x) => x !== '');
      return parts.join(', ');
    }
    if (a.triggerKind === 'hubspot_deal_stage') {
      // Le libellé n'est qu'un souvenir de ce qui a été choisi : s'il manque (automation créée par API), on
      // le dit plutôt que d'afficher un identifiant opaque qui ne parlerait à personne.
      const etape = String(a.triggerConfig.stageLabel ?? '').trim();
      return etape !== ''
        ? `${t('un deal HubSpot atteint « ', 'a HubSpot deal reaches "')}${etape}${t(' »', '"')}`
        : t('un deal HubSpot atteint l’étape configurée', 'a HubSpot deal reaches the configured stage');
    }
    return a.triggerKind;
  };

  const canSubmit = name.trim() !== '' && workflowId !== ''
    && (triggerKind !== 'keyword' || keywords.trim() !== '')
    && (triggerKind !== 'tag_added' || tag.trim() !== '')
    && (triggerKind !== 'hubspot_deal_stage' || dealStageKey !== '');

  return (
    <div className="space-y-5 p-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Automation', 'Automation')}</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">
          {t(
            'Lance un scénario automatiquement quand un événement se produit, sans campagne. Un scénario ne part jamais si un opérateur a pris la main sur la conversation.',
            'Start a scenario automatically when an event happens, without a campaign. A scenario never runs if an operator has taken over the conversation.',
          )}
        </p>
        {/* Deux familles de déclencheurs, et la différence change ce que le scénario a le droit d'envoyer.
            Le dire ici évite la promesse fausse « le client vient toujours d'écrire », qui n'était vraie que
            tant que seuls le mot-clé et le nouveau contact existaient. */}
        <p className="mt-2 max-w-3xl text-xs text-ink-400">
          {t(
            'Mot-clé et nouveau contact partent d’un message reçu : la fenêtre de 24 h est ouverte, le scénario peut donc commencer par un message rapide ou un formulaire. Tag posé, conversation analysée et étape de deal arrivent à froid : le scénario doit commencer par un envoi de template, sinon rien ne part.',
            'Keyword and new contact come from an incoming message: the 24 h window is open, so the scenario may start with a quick message or a form. Tag added, conversation analyzed and deal stage happen cold: the scenario must start with a template send, otherwise nothing goes out.',
          )}
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!creating ? (
        <button onClick={() => setCreating(true)} data-testid="automation-add" className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600">
          + {t('Ajouter une automation', 'Add an automation')}
        </button>
      ) : (
        <div className="max-w-2xl space-y-3 rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Nom (interne)', 'Name (internal)')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="automation-name" className={inputCls} placeholder={t('Demande de RDV', 'Appointment request')} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Quand…', 'When…')}</label>
            <select value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as AutomationTriggerKind)} data-testid="automation-trigger" className={inputCls}>
              <option value="keyword">{t('le client envoie un mot-clé', 'the customer sends a keyword')}</option>
              <option value="new_contact">{t('un nouveau contact écrit pour la 1re fois', 'a new contact writes for the first time')}</option>
              <option value="tag_added">{t('un tag est posé sur un contact', 'a tag is added to a contact')}</option>
              <option value="conversation_analyzed">{t('une conversation vient d’être analysée', 'a conversation has just been analyzed')}</option>
              <option value="hubspot_deal_stage">{t('un deal HubSpot atteint une étape', 'a HubSpot deal reaches a stage')}</option>
            </select>
          </div>
          {triggerKind === 'hubspot_deal_stage' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Étape du deal', 'Deal stage')}</label>
              {etatEtapes === 'chargement' ? (
                <p className="text-xs text-ink-400">{t('Lecture des étapes du portail…', 'Reading portal stages…')}</p>
              ) : etatEtapes === 'non_connecte' ? (
                <p className="text-xs text-amber-700">
                  {t(
                    'Aucun portail HubSpot n’est relié à cet espace. Connecte HubSpot dans Paramètres, puis reviens ici.',
                    'No HubSpot portal is linked to this workspace. Connect HubSpot in Settings, then come back here.',
                  )}
                </p>
              ) : etatEtapes === 'erreur' ? (
                <p className="text-xs text-red-700">
                  {t('Les étapes n’ont pas pu être lues. Réessaie dans un instant.', 'Stages could not be read. Try again shortly.')}
                </p>
              ) : etapes.length === 0 ? (
                <p className="text-xs text-amber-700">{t('Ce portail n’a aucune étape de deal.', 'This portal has no deal stage.')}</p>
              ) : (
                <select value={dealStageKey} onChange={(e) => setDealStageKey(e.target.value)} data-testid="automation-deal-stage" className={inputCls}>
                  <option value="">{t('Choisir une étape…', 'Choose a stage…')}</option>
                  {/* Groupé par pipeline : deux pipelines ont souvent une étape du même nom, et sans le
                      groupe on ne saurait pas laquelle on choisit. */}
                  {dealPipelines.map((p) => (
                    <optgroup key={p.id} label={p.label}>
                      {p.stages.map((s) => (
                        <option key={s.id} value={`${p.id}::${s.id}`}>
                          {s.label}{s.closed ? t(' (étape de fin)', ' (closing stage)') : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )}
              <p className="mt-1 text-xs text-ink-400">
                {t(
                  'Le scénario part quand un deal ARRIVE sur cette étape, pour le contact rattaché au deal, à condition qu’il ait un numéro. L’étape est retenue par son identifiant : la renommer dans HubSpot ne cassera rien. Le client n’écrivant pas à ce moment-là, le scénario doit commencer par un envoi de template.',
                  'The scenario runs when a deal REACHES this stage, for the contact linked to the deal, provided they have a phone number. The stage is kept by its id: renaming it in HubSpot breaks nothing. As the customer is not writing at that moment, the scenario must start with a template send.',
                )}
              </p>
            </div>
          )}
          {triggerKind === 'tag_added' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Tag déclencheur', 'Triggering tag')}</label>
              <input value={tag} onChange={(e) => setTag(e.target.value)} data-testid="automation-tag" className={inputCls} placeholder={t('rappeler', 'callback')} />
              <p className="mt-1 text-xs text-ink-400">
                {t(
                  'Vaut pour un tag posé sur une FICHE contact, ou par un bloc Action d’un scénario lancé pour UN contact (réponse à un message, autre automation, test). Un tag posé en masse, par import, ou par un scénario lancé en CAMPAGNE ne déclenche rien : cela lancerait autant de scénarios que de contacts. Pour toucher une liste, utilise une campagne.',
                  'Applies to a tag added on a contact RECORD, or by an Action block of a scenario started for ONE contact (reply to a message, another automation, a test). A tag added in bulk, by import, or by a scenario started as a CAMPAIGN triggers nothing: it would start as many scenarios as contacts. To reach a list, use a campaign.',
                )}
              </p>
            </div>
          )}
          {triggerKind === 'conversation_analyzed' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700">{t('Ressenti du client', 'Customer sentiment')}</label>
                <select value={sentiment} onChange={(e) => setSentiment(e.target.value as '' | 'positif' | 'neutre' | 'negatif')} data-testid="automation-sentiment" className={inputCls}>
                  <option value="negatif">{t('négatif', 'negative')}</option>
                  <option value="neutre">{t('neutre', 'neutral')}</option>
                  <option value="positif">{t('positif', 'positive')}</option>
                  <option value="">{t('peu importe', 'any')}</option>
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-700">
                  <input type="checkbox" checked={unresolvedOnly} onChange={(e) => setUnresolvedOnly(e.target.checked)} className="h-4 w-4" />
                  {t('seulement si la demande n’a pas été résolue', 'only if the request was not resolved')}
                </label>
              </div>
              <p className="text-xs text-ink-400 sm:col-span-2">
                {t(
                  'L’analyse tourne quand la conversation est retombée inactive : ce déclencheur est donc différé, pas immédiat. Le client n’écrivant plus, le scénario doit commencer par un envoi de template.',
                  'Analysis runs once the conversation has gone idle: this trigger is therefore delayed, not immediate. As the customer is no longer writing, the scenario must start with a template send.',
                )}
              </p>
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800 sm:col-span-2">
                {t(
                  'Ce déclencheur repose sur l’analyse de conversation. Si elle n’est pas activée sur ton compte, l’automation s’affichera « active » mais ne partira jamais : vérifie-le dans Analytics > Qualitatif avant de compter dessus.',
                  'This trigger relies on conversation analysis. If it is not enabled on your account, the automation will show as "enabled" but will never run: check Analytics > Qualitative before relying on it.',
                )}
              </p>
            </div>
          )}
          {triggerKind === 'keyword' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700">{t('Mots-clés (séparés par une virgule)', 'Keywords (comma-separated)')}</label>
                <input value={keywords} onChange={(e) => setKeywords(e.target.value)} data-testid="automation-keywords" className={inputCls} placeholder={t('rdv, rendez-vous', 'appointment, booking')} />
                <p className="mt-1 text-xs text-ink-400">{t('La casse et les accents sont ignorés.', 'Case and accents are ignored.')}</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700">{t('Correspondance', 'Matching')}</label>
                <select value={mode} onChange={(e) => setMode(e.target.value as 'contains' | 'equals')} className={inputCls}>
                  <option value="contains">{t('le message contient le mot-clé', 'the message contains the keyword')}</option>
                  <option value="equals">{t('le message est exactement le mot-clé', 'the message is exactly the keyword')}</option>
                </select>
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Alors lancer le scénario', 'Then start the scenario')}</label>
            {workflows.length === 0 ? (
              <p className="text-xs text-amber-700">{t('Aucun scénario. Crée-en un dans le menu « Scénario ».', 'No scenario yet. Create one from the "Scenario" menu.')}</p>
            ) : (
              <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} data-testid="automation-workflow" className={inputCls}>
                <option value="">{t('Choisir un scénario…', 'Choose a scenario…')}</option>
                {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            )}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => { void submit(); }} disabled={!canSubmit || busy} data-testid="automation-submit" className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40">
              {busy ? t('Création…', 'Creating…') : t('Créer (désactivée)', 'Create (disabled)')}
            </button>
            <button onClick={() => setCreating(false)} className="text-sm text-ink-500 hover:underline">{t('Annuler', 'Cancel')}</button>
            <span className="text-xs text-ink-400">{t('Elle ne partira qu’une fois activée.', 'It will only run once enabled.')}</span>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
          {t('Aucune automation. Ajoutes-en une pour qu’un scénario se lance tout seul.', 'No automation yet. Add one so a scenario starts on its own.')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-4 py-2 font-medium">{t('Quand', 'When')}</th>
                <th className="px-4 py-2 font-medium">{t('Scénario', 'Scenario')}</th>
                <th className="px-4 py-2 font-medium">{t('Active', 'Enabled')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-4 py-2 font-medium text-ink-800">{a.name}</td>
                  <td className="px-4 py-2 text-ink-600">{describeTrigger(a)}</td>
                  <td className="px-4 py-2 text-ink-600">{wfName(a.workflowId)}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => { void toggle(a); }}
                      data-testid={`automation-toggle-${a.id}`}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${a.enabled ? 'bg-mint-50 text-mint-700' : 'bg-ink-100 text-ink-500'}`}
                    >
                      {a.enabled ? t('active', 'enabled') : t('désactivée', 'disabled')}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => { void remove(a); }} className="text-xs text-coral hover:underline">{t('Supprimer', 'Delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
