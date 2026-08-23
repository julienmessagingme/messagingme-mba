'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { ArbreJson } from '@/components/ArbreJson';
import type { Session } from '@/lib/session';
import {
  listWebhooks, createWebhook, updateWebhook, deleteWebhook,
  rotateWebhookSecret, clearWebhookSecret, forgetWebhookPayload,
  listUserFields, createUserField, listWorkflows,
  type WebhookEntrant, type RegleMappingWebhook, type UserFieldDef, type UserFieldKind, type WorkflowSummary,
} from '@/lib/api';
import { USER_FIELD_KINDS, USER_FIELD_KIND_LABELS } from '@/lib/field-kinds';
import { arbreDuPayload, valeursParChemin } from '@/lib/chemin-json';
import { typeSuggere } from '@/lib/type-suggere';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { inputCls, inputClsAuto, cardCls, kickerCls } from '@/lib/ui';

/**
 * Tools > Webhooks : recevoir un JSON d'un outil tiers, en tirer des champs de contact, et déclencher un
 * scénario.
 *
 * Le parcours est en trois temps, et l'écran l'assume : (1) on donne une URL, (2) l'outil tiers envoie un
 * appel de test, (3) on clique dans le JSON reçu pour dire où va chaque valeur. Sans le deuxième temps il n'y
 * a rien à mapper, d'où l'encart d'attente plutôt qu'un formulaire vide.
 */
export default function WebhooksPage() {
  return <AppShell active="webhooks">{(session) => <WebhooksInner session={session} />}</AppShell>;
}

/** Destination d'une règle : le téléphone, le nom, ou un champ de contact. */
const CIBLE_TELEPHONE = 'sys:phone';
const CIBLE_NOM = 'sys:name';
/** Valeur SENTINELLE du menu : « créer un champ ». Le préfixe `sys:` la met hors d'atteinte d'un vrai champ,
 *  dont la valeur commence toujours par `field:`. */
const CIBLE_NOUVEAU = 'sys:nouveau';

function WebhooksInner({ session }: { session: Session }) {
  const t = useT();
  const [hooks, setHooks] = useState<WebhookEntrant[]>([]);
  const [champs, setChamps] = useState<UserFieldDef[]>([]);
  const [scenarios, setScenarios] = useState<WorkflowSummary[]>([]);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nouveau, setNouveau] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [w, f, s] = await Promise.all([
        listWebhooks(session.tenantId),
        listUserFields(session.tenantId),
        listWorkflows(session.tenantId),
      ]);
      // Normalisation au bord du réseau : une 200 sans le champ attendu poserait `undefined` dans un état
      // typé tableau, et le premier `.map` démonterait l'écran entier.
      setHooks(Array.isArray(w?.webhooks) ? w.webhooks : []);
      setChamps(Array.isArray(f?.fields) ? f.fields : []);
      setScenarios(Array.isArray(s?.workflows) ? s.workflows : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  async function creer() {
    if (!nouveau.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await createWebhook(session.tenantId, { name: nouveau.trim() });
      setNouveau('');
      await load();
      setOuvert(id); // on enchaîne directement sur le détail : c'est là que se trouve l'URL à copier
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Creation failed'));
    } finally {
      setBusy(false);
    }
  }

  async function supprimer(w: WebhookEntrant) {
    const ok = window.confirm(t(
      `Supprimer « ${w.name} » ? L'adresse cessera de répondre immédiatement, et tout outil qui l'utilise encore recevra une erreur.`,
      `Delete “${w.name}”? The address will stop responding immediately, and any tool still using it will get an error.`,
    ));
    if (!ok) return;
    try {
      await deleteWebhook(session.tenantId, w.id);
      if (ouvert === w.id) setOuvert(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Deletion failed'));
    }
  }

  const courant = hooks.find((w) => w.id === ouvert) ?? null;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className={kickerCls}>{t('TOOLS', 'TOOLS')}</p>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Webhooks', 'Webhooks')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'Donnez une adresse à un outil tiers (Zapier, Make, un CRM, le formulaire de votre site). Il y envoie du JSON, vous choisissez où va chaque valeur, et vous pouvez déclencher un scénario.',
            'Give an address to a third-party tool (Zapier, Make, a CRM, your website form). It posts JSON, you choose where each value goes, and you can trigger a scenario.',
          )}
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {courant ? (
        <Detail
          key={courant.id}
          session={session}
          hook={courant}
          champs={champs}
          scenarios={scenarios}
          onFerme={() => setOuvert(null)}
          onChange={load}
          onErreur={setError}
        />
      ) : (
        <>
          <div className={cardCls}>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Nouveau webhook', 'New webhook')}</label>
            <div className="flex gap-2">
              <input
                value={nouveau}
                onChange={(e) => setNouveau(e.target.value)}
                placeholder={t('Nom (ex. « formulaire du site »)', 'Name (e.g. “website form”)')}
                className={inputCls}
                data-testid="webhook-nom"
              />
              <button
                onClick={() => { void creer(); }}
                disabled={busy || !nouveau.trim()}
                className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {busy ? t('Création...', 'Creating...') : t('Créer', 'Create')}
              </button>
            </div>
          </div>

          <Liste hooks={hooks} loading={loading} onOuvrir={setOuvert} onSupprimer={supprimer} />
        </>
      )}
    </div>
  );
}

function Liste({
  hooks, loading, onOuvrir, onSupprimer,
}: {
  hooks: WebhookEntrant[]; loading: boolean;
  onOuvrir: (id: string) => void;
  onSupprimer: (w: WebhookEntrant) => void | Promise<void>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const quand = (iso: string | null) => (iso ? `${formatDate(iso, locale, { day: '2-digit', month: '2-digit' })} ${hourMin(iso, locale)}` : t('jamais', 'never'));

  return (
    <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
      {loading ? (
        <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
      ) : hooks.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun webhook. Créez-en un ci-dessus.', 'No webhooks yet. Create one above.')}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
              <th className="px-5 py-2 font-medium">{t('État', 'Status')}</th>
              <th className="px-5 py-2 font-medium">{t('Dernier appel', 'Last call')}</th>
              <th className="px-5 py-2 font-medium">{t('Contacts créés', 'Contacts created')}</th>
              <th className="px-5 py-2 font-medium" />
            </tr>
          </thead>
          <tbody data-testid="liste-webhooks">
            {hooks.map((w) => (
              <tr key={w.id} className="border-b border-ink-50 last:border-0">
                <td className="px-5 py-2.5">
                  <button onClick={() => onOuvrir(w.id)} className="font-medium text-ink-800 hover:text-brand-600 hover:underline">{w.name}</button>
                </td>
                <td className="px-5 py-2.5">
                  {w.enabled
                    ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">{t('actif', 'active')}</span>
                    : <span className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">{t('désactivé', 'disabled')}</span>}
                </td>
                <td className="px-5 py-2.5 text-ink-600">{quand(w.lastReceivedAt)}</td>
                <td className="px-5 py-2.5 text-ink-600">{w.contactsCreated}</td>
                <td className="px-5 py-2.5 text-right">
                  <button onClick={() => { void onSupprimer(w); }} className="text-xs text-red-600 hover:underline">{t('Supprimer', 'Delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Detail({
  session, hook, champs, scenarios, onFerme, onChange, onErreur,
}: {
  session: Session;
  hook: WebhookEntrant;
  champs: UserFieldDef[];
  scenarios: WorkflowSummary[];
  onFerme: () => void;
  onChange: () => Promise<void>;
  onErreur: (m: string | null) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [mapping, setMapping] = useState<RegleMappingWebhook[]>(hook.mapping);
  const [enabled, setEnabled] = useState(hook.enabled);
  const [createContact, setCreateContact] = useState(hook.createContact);
  const [workflowId, setWorkflowId] = useState<string | null>(hook.workflowId);
  const [busy, setBusy] = useState(false);
  // Le clair du secret n'existe QUE dans la réponse de génération : il est gardé ici pour l'encart de copie.
  const [secretClair, setSecretClair] = useState<string | null>(null);
  // Creation d'un champ a la volee, depuis la ligne de mapping qui l'a demandee.
  const [creation, setCreation] = useState<{ index: number; label: string; type: UserFieldKind } | null>(null);

  const cheminsUtilises = useMemo(() => mapping.map((r) => r.chemin), [mapping]);
  const aTelephone = mapping.some((r) => r.cible === CIBLE_TELEPHONE);

  /**
   * Chemin -> valeur recue. Sert a proposer le bon type quand on cree un champ : un instant ISO propose
   * << Date et heure >>, et c'est ce qui fait qu'une valeur comme << envoye le >> est stockee en date
   * plutot qu'en texte, sans que personne ait a y penser.
   */
  const echantillons = useMemo(() => valeursParChemin(arbreDuPayload(hook.lastPayload)), [hook.lastPayload]);

  /**
   * Destinations proposees. Chaque champ porte sa NATURE : sans elle, on ne peut pas savoir si la valeur
   * qu'on attache sera stockee comme une date ou comme du texte, alors que ca decide de tout ce qu'on
   * pourra en faire ensuite.
   */
  const cibles: Array<{ valeur: string; label: string }> = [
    { valeur: CIBLE_TELEPHONE, label: t('Téléphone (désigne le contact)', 'Phone (identifies the contact)') },
    { valeur: CIBLE_NOM, label: t('Nom', 'Name') },
    ...champs.map((f) => ({ valeur: `field:${f.key}`, label: `${f.label} (${t(...USER_FIELD_KIND_LABELS[f.type])})` })),
  ];

  /** Ouvre le formulaire de creation pour cette ligne, prerempli d'apres la valeur recue. */
  function demanderCreation(index: number) {
    const chemin = mapping[index]?.chemin ?? '';
    // Libelle propose : le dernier segment du chemin, que l'utilisateur corrige. Mieux qu'un champ vide.
    const dernier = chemin.split('.').pop()?.replace(/\[\d+\]/g, '') ?? '';
    setCreation({ index, label: dernier, type: typeSuggere(echantillons.get(chemin)) });
  }

  async function creerLeChamp() {
    if (!creation || creation.label.trim() === '') return;
    setBusy(true);
    onErreur(null);
    try {
      const def = await createUserField(session.tenantId, { label: creation.label.trim(), type: creation.type });
      // La ligne pointe le champ TOUT DE SUITE : sans ca, l'utilisateur cree un champ puis doit le
      // rechercher dans un menu qui vient de s'allonger.
      setMapping((m) => m.map((x, k) => (k === creation.index ? { ...x, cible: `field:${def.key}` } : x)));
      setCreation(null);
      await onChange(); // recharge la liste des champs, pour que le menu porte le nouveau
    } catch (err) {
      onErreur(err instanceof Error ? err.message : t('Création impossible', 'Creation failed'));
    } finally {
      setBusy(false);
    }
  }

  function attacher(chemin: string) {
    // Le téléphone d'abord tant qu'il manque : c'est la seule destination sans laquelle rien ne peut se faire.
    // Ensuite la première destination encore libre, plutôt que toujours la même : proposer « Nom » à chaque
    // clic obligerait à corriger le menu à chaque ligne.
    const prises = new Set(mapping.map((r) => r.cible));
    const cible = aTelephone
      ? (cibles.find((c) => !prises.has(c.valeur))?.valeur ?? CIBLE_NOM)
      : CIBLE_TELEPHONE;
    setMapping((m) => [...m, { chemin, cible }]);
  }

  async function enregistrer() {
    setBusy(true);
    onErreur(null);
    try {
      await updateWebhook(session.tenantId, hook.id, { mapping, enabled, createContact, workflowId });
      await onChange();
    } catch (err) {
      onErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  async function genererSecret() {
    onErreur(null);
    try {
      setSecretClair((await rotateWebhookSecret(session.tenantId, hook.id)).secret);
      await onChange();
    } catch (err) {
      onErreur(err instanceof Error ? err.message : t('Génération impossible', 'Generation failed'));
    }
  }

  async function retirerSecret() {
    onErreur(null);
    try {
      await clearWebhookSecret(session.tenantId, hook.id);
      setSecretClair(null);
      await onChange();
    } catch (err) {
      onErreur(err instanceof Error ? err.message : t('Retrait impossible', 'Removal failed'));
    }
  }

  async function oublierPayload() {
    onErreur(null);
    try {
      await forgetWebhookPayload(session.tenantId, hook.id);
      await onChange();
    } catch (err) {
      onErreur(err instanceof Error ? err.message : t('Effacement impossible', 'Deletion failed'));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onFerme} className="text-sm text-ink-500 hover:text-ink-800">← {t('Tous les webhooks', 'All webhooks')}</button>
        <h3 className="text-sm font-semibold text-ink-900">{hook.name}</h3>
        <label className="ml-auto flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-ink-300" />
          {t('Actif', 'Active')}
        </label>
      </div>

      {/* 1. L'adresse ------------------------------------------------------------------------------ */}
      <div className={cardCls}>
        <h4 className="text-sm font-medium text-ink-800">{t('1. L’adresse à donner à votre outil', '1. The address to give your tool')}</h4>
        <p className="mt-1 text-sm text-ink-500">{t('Méthode POST, corps JSON.', 'POST method, JSON body.')}</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-ink-50 px-3 py-2 font-mono text-xs text-ink-800" data-testid="webhook-url">{hook.url}</code>
          <button
            onClick={() => { void navigator.clipboard?.writeText(hook.url); }}
            className="shrink-0 rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50"
          >
            {t('Copier', 'Copy')}
          </button>
        </div>

        <div className="mt-4 border-t border-ink-100 pt-3">
          <p className="text-sm font-medium text-ink-700">{t('Secret (facultatif)', 'Secret (optional)')}</p>
          <p className="mt-0.5 text-sm text-ink-500">
            {t(
              'Si vous en posez un, votre outil devra l’envoyer dans l’en-tête X-Webhook-Secret. Un formulaire de site ne sait souvent pas le faire : dans ce cas, laissez sans.',
              'If you set one, your tool must send it in the X-Webhook-Secret header. A website form often cannot: in that case, leave it unset.',
            )}
          </p>
          {secretClair && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm text-amber-800">
                {t('Copiez-le maintenant : il ne sera plus jamais affiché.', 'Copy it now: it will never be shown again.')}
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-white px-2 py-1 font-mono text-xs text-ink-800" data-testid="webhook-secret">{secretClair}</pre>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => { void genererSecret(); }} className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50">
              {hook.hasSecret ? t('Régénérer le secret', 'Regenerate secret') : t('Générer un secret', 'Generate a secret')}
            </button>
            {hook.hasSecret && (
              <button onClick={() => { void retirerSecret(); }} className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50">
                {t('Retirer le secret', 'Remove secret')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2. Ce qu'on a reçu ------------------------------------------------------------------------ */}
      <div className={cardCls}>
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-medium text-ink-800">{t('2. Ce que votre outil a envoyé', '2. What your tool sent')}</h4>
          <button onClick={() => { void onChange(); }} className="ml-auto text-xs font-medium text-brand-600 hover:text-brand-700">
            {t('Vérifier maintenant', 'Check now')}
          </button>
        </div>
        {hook.lastPayload === null || hook.lastPayload === undefined ? (
          <p className="mt-2 rounded-lg border border-dashed border-ink-300 px-3 py-4 text-sm text-ink-500" data-testid="attente-premier-appel">
            {t(
              'En attente d’un premier appel. Collez l’adresse ci-dessus dans votre outil et déclenchez un envoi de test : le contenu reçu s’affichera ici, et vous pourrez cliquer dedans.',
              'Waiting for a first call. Paste the address above into your tool and trigger a test send: the received content will show here, and you will be able to click into it.',
            )}
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-ink-500">
              {t('Reçu le', 'Received on')} {hook.lastReceivedAt ? `${formatDate(hook.lastReceivedAt, locale, { day: '2-digit', month: '2-digit' })} ${hourMin(hook.lastReceivedAt, locale)}` : '—'}
              {' · '}
              <button onClick={() => { void oublierPayload(); }} className="text-ink-500 underline hover:text-ink-800">
                {t('oublier ce contenu', 'forget this content')}
              </button>
            </p>
            <ArbreJson payload={hook.lastPayload} cheminsUtilises={cheminsUtilises} onAttacher={attacher} />
          </div>
        )}
      </div>

      {/* 3. Le mapping ----------------------------------------------------------------------------- */}
      <div className={cardCls}>
        <h4 className="text-sm font-medium text-ink-800">{t('3. Où va chaque valeur', '3. Where each value goes')}</h4>
        {!aTelephone && (
          // Signalé AVANT le premier appel, et pas au moment où rien ne se passe : sans téléphone, le webhook
          // enregistre ce qu'il reçoit mais ne peut ni retrouver ni créer de contact.
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="alerte-telephone">
            {t(
              'Il faut au moins une valeur envoyée vers Téléphone : c’est elle qui désigne le contact. Sans elle, ce webhook enregistrera ce qu’il reçoit sans rien pouvoir en faire.',
              'At least one value must go to Phone: it is what identifies the contact. Without it, this webhook will record what it receives without being able to act on it.',
            )}
          </p>
        )}
        {mapping.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">{t('Rien encore. Cliquez sur « Attacher… » dans le contenu reçu ci-dessus.', 'Nothing yet. Click “Attach…” in the received content above.')}</p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="liste-mapping">
            {mapping.map((r, i) => (
              <li key={`${r.chemin}-${i}`} className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-ink-50 px-2 py-1 font-mono text-xs text-ink-700">{r.chemin}</code>
                <span className="text-ink-400">→</span>
                <select
                  value={r.cible}
                  onChange={(e) => {
                    if (e.target.value === CIBLE_NOUVEAU) { demanderCreation(i); return; }
                    setMapping((m) => m.map((x, k) => (k === i ? { ...x, cible: e.target.value } : x)));
                  }}
                  className={`${inputClsAuto} bg-white`}
                  data-testid={`cible-${i}`}
                >
                  {cibles.map((c) => <option key={c.valeur} value={c.valeur}>{c.label}</option>)}
                  <option value={CIBLE_NOUVEAU}>{t('+ Créer un champ…', '+ Create a field…')}</option>
                </select>
                <button
                  onClick={() => setMapping((m) => m.filter((_, k) => k !== i))}
                  className="text-ink-400 hover:text-red-600"
                  aria-label={t('Retirer', 'Remove')}
                >
                  ✕
                </button>
                {creation?.index === i && (
                  <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50/40 p-2" data-testid="creation-champ">
                    <input
                      value={creation.label}
                      onChange={(e) => setCreation({ ...creation, label: e.target.value })}
                      placeholder={t('Nom du champ', 'Field name')}
                      className={`${inputClsAuto} min-w-0 flex-1 py-1`}
                      data-testid="nouveau-champ-label"
                    />
                    <select
                      value={creation.type}
                      onChange={(e) => setCreation({ ...creation, type: e.target.value as UserFieldKind })}
                      className={`${inputClsAuto} bg-white py-1`}
                      data-testid="nouveau-champ-type"
                    >
                      {USER_FIELD_KINDS.map((k) => <option key={k} value={k}>{t(...USER_FIELD_KIND_LABELS[k])}</option>)}
                    </select>
                    <button
                      onClick={() => { void creerLeChamp(); }}
                      disabled={busy || creation.label.trim() === ''}
                      className="rounded-lg bg-brand-500 px-3 py-1 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                      data-testid="creer-le-champ"
                    >
                      {t('Créer', 'Create')}
                    </button>
                    <button onClick={() => setCreation(null)} className="text-sm text-ink-500 hover:text-ink-800">
                      {t('Annuler', 'Cancel')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 4. Le contact ----------------------------------------------------------------------------- */}
      <div className={cardCls}>
        <h4 className="text-sm font-medium text-ink-800">{t('4. Le contact', '4. The contact')}</h4>
        <label className="mt-2 flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={createContact} onChange={(e) => setCreateContact(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-ink-300" />
          <span>
            {t('Créer les contacts inconnus', 'Create unknown contacts')}
            <span className="block text-ink-500">
              {t(
                'Le contact ne peut venir que du contenu reçu. Décoché, un appel concernant quelqu’un qui n’est pas encore dans le mini-CRM sera enregistré sans rien créer.',
                'The contact can only come from the received content. Unchecked, a call about someone not yet in the mini-CRM will be recorded without creating anything.',
              )}
            </span>
            <span className="block text-ink-400">{t('Créés par ce webhook jusqu’ici', 'Created by this webhook so far')} : {hook.contactsCreated}</span>
          </span>
        </label>
      </div>

      {/* 5. Le scénario ---------------------------------------------------------------------------- */}
      <div className={cardCls}>
        <h4 className="text-sm font-medium text-ink-800">{t('5. Déclencher un scénario (facultatif)', '5. Trigger a scenario (optional)')}</h4>
        <select
          value={workflowId ?? ''}
          onChange={(e) => setWorkflowId(e.target.value === '' ? null : e.target.value)}
          className={`${inputCls} mt-2 bg-white`}
          data-testid="select-scenario"
        >
          <option value="">{t('Aucun (n’écrire que des champs)', 'None (only write fields)')}</option>
          {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <p className="mt-2 text-sm text-ink-500">
          {t(
            'Le contact n’a pas forcément écrit récemment : le scénario doit donc commencer par un template approuvé, sinon il sera refusé au démarrage.',
            'The contact may not have written recently: the scenario must therefore start with an approved template, otherwise it will be refused at start.',
          )}
        </p>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => { void enregistrer(); }}
          disabled={busy}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          data-testid="enregistrer-webhook"
        >
          {busy ? t('Enregistrement...', 'Saving...') : t('Enregistrer', 'Save')}
        </button>
      </div>
    </div>
  );
}
