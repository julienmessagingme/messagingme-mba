'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { MbaNotice } from '@/components/MbaNotice';
import { MbaTabs } from '@/components/MbaTabs';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls, kickerCls } from '@/lib/ui';
import {
  createAgent, deleteAgent, getAgent, listAgents, patchAgent,
  type AgentComplet, type AgentResume, type PatchAgent, type SortieAgent,
} from '@/lib/api-agent';
import { CodeSortieInput } from '@/components/AgentSorties';
import { AgentConnaissance } from '@/components/AgentConnaissance';

/**
 * Écran de réglage d'un agent IA, calqué sur celui de l'agent Meta : une liste, puis une fiche à onglets.
 *
 * 🔴 CE QUE « ACTIVÉ » VEUT DIRE ICI, et ce n'est pas ce qu'on croit. Un agent actif n'est pas un agent qui
 * « répond à tout » : c'est un agent PROPOSABLE dans un scénario. Il ne parle que là où le client a posé un
 * bloc agent et l'y a désigné. C'est pour ça que l'activation vit sur la fiche, agent par agent, et non sur
 * un interrupteur d'accueil comme l'agent de Meta, qui lui est unique par workspace.
 */

type Onglet = 'identite' | 'objectif' | 'connaissance' | 'perimetre' | 'modele';

const ONGLETS: Onglet[] = ['identite', 'objectif', 'connaissance', 'perimetre', 'modele'];
const lireOnglet = (v: string | null): Onglet => (ONGLETS as string[]).includes(v ?? '') ? (v as Onglet) : 'identite';

export default function AgentsPage() {
  return <AppShell active="agents">{(session) => <Ecran tenantId={session.tenantId} />}</AppShell>;
}

function Ecran({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [agents, setAgents] = useState<AgentResume[] | null>(null);
  const [ouvert, setOuvert] = useState<AgentComplet | null>(null);
  // L'onglet ET l'agent ouvert vivent dans l'adresse, comme l'écran MBA : la fiche est partageable, un
  // rafraîchissement retrouve où on en était, et la surface conversationnelle pourra pointer la même fiche.
  const router = useRouter();
  const params = useSearchParams();
  const onglet = lireOnglet(params.get('tab'));
  const idOuvert = params.get('id');
  const [nouveau, setNouveau] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    // `tous: true` : c'est l'écran qui CRÉE les agents, il doit voir ses propres brouillons. Le builder, lui,
    // n'appelle jamais avec ce drapeau.
    try {
      setAgents(await listAgents(tenantId, { tous: true }));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    }
  }, [tenantId, t]);
  useEffect(() => { void charger(); }, [charger]);

  // L'agent ouvert SUIT l'adresse : un rafraîchissement, un lien partagé ou un retour arrière retrouvent la
  // même fiche. On ne recharge que si l'identifiant a changé, sinon chaque enregistrement rejouerait un GET.
  useEffect(() => {
    if (idOuvert === null) { setOuvert(null); return; }
    if (ouvert?.id === idOuvert) return;
    let vivant = true;
    void getAgent(tenantId, idOuvert)
      .then((a) => { if (vivant) setOuvert(a); })
      .catch((err: unknown) => { if (vivant) setErreur(err instanceof Error ? err.message : t('Ouverture impossible', 'Unable to open')); });
    return () => { vivant = false; };
  }, [idOuvert, ouvert?.id, tenantId, t]);

  async function creer() {
    const label = nouveau.trim();
    if (label === '' || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      const agent = await createAgent(tenantId, label);
      setNouveau('');
      await charger();
      setOuvert(agent);
      aller(agent.id, 'identite');
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Création impossible', 'Unable to create'));
    } finally {
      setBusy(false);
    }
  }

  /** Écrit l'onglet et l'agent ouvert dans l'adresse. `replace` et non `push` : changer d'onglet ne doit pas
   *  remplir l'historique du navigateur, comme sur l'écran MBA. */
  const aller = useCallback((id: string | null, tab: Onglet) => {
    router.replace(id ? `/agents?id=${id}&tab=${tab}` : '/agents', { scroll: false });
  }, [router]);

  async function supprimer() {
    if (!ouvert || busy) return;
    // Confirmation NATIVE : la suppression emporte les conversations, les outils et la base de connaissance
    // de cet agent, et le repo n'a pas de boîte de dialogue maison.
    if (!window.confirm(t(
      `Supprimer « ${ouvert.label} » ? Ses conversations, ses outils et sa base de connaissance partent avec lui, et les blocs de scénario qui l'utilisent cesseront de répondre.`,
      `Delete “${ouvert.label}”? Its conversations, tools and knowledge base go with it, and the scenario blocks using it will stop answering.`,
    ))) return;
    setBusy(true);
    setErreur(null);
    try {
      await deleteAgent(tenantId, ouvert.id);
      setOuvert(null);
      aller(null, 'identite');
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    } finally {
      setBusy(false);
    }
  }

  /** Enregistre un patch et rafraîchit la liste : le libellé et le statut y sont visibles. */
  async function enregistrer(patch: PatchAgent) {
    if (!ouvert || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      // Le verrou de version accompagne TOUT patch de fiche : sans lui, deux surfaces qui écrivent la même
      // clé se recouvrent en silence. Le serveur refuse en 409, et le message dit de recharger.
      const avecVerrou = patch.contenu ? { ...patch, ficheVersionAttendue: ouvert.ficheVersion } : patch;
      setOuvert(await patchAgent(tenantId, ouvert.id, avecVerrou));
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save'));
    } finally {
      setBusy(false);
    }
  }

  if (ouvert) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button onClick={() => { setOuvert(null); aller(null, 'identite'); void charger(); }} className="text-sm text-brand-600 hover:underline">
            ← {t('Retour aux agents', 'Back to agents')}
          </button>
          <div className="flex items-center gap-2">
            <Activation agent={ouvert} busy={busy} onChange={(status) => void enregistrer({ status })} />
            <button
              data-testid="agent-supprimer"
              disabled={busy}
              onClick={() => void supprimer()}
              title={t('Supprimer cet agent', 'Delete this agent')}
              className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-coral hover:bg-red-50 disabled:opacity-40"
            >
              {t('Supprimer', 'Delete')}
            </button>
          </div>
        </div>
        <div>
          <p className={kickerCls}>{t('AGENT IA', 'AI AGENT')}</p>
          <h2 className="text-xl font-semibold tracking-tight text-ink-900">{ouvert.label}</h2>
        </div>
        {erreur && <MbaNotice kind="error" testid="agent-erreur">{erreur}</MbaNotice>}
        <MbaTabs
          active={onglet}
          onSelect={(k) => aller(ouvert.id, lireOnglet(k))}
          tabs={[
            { key: 'identite', label: t('Identité et ton', 'Identity and tone') },
            { key: 'objectif', label: t('Objectif et transferts', 'Objective and handovers') },
            { key: 'connaissance', label: t('Base de connaissance', 'Knowledge base') },
            { key: 'perimetre', label: t('Périmètre et garde-fous', 'Scope and guardrails') },
            { key: 'modele', label: t('Modèle', 'Model') },
          ]}
        />
        {onglet === 'identite' && <OngletIdentite agent={ouvert} busy={busy} onSave={enregistrer} />}
        {onglet === 'objectif' && <OngletObjectif agent={ouvert} busy={busy} onSave={enregistrer} />}
        {/* La connaissance vit dans SA table, pas dans la fiche jsonb : ce panneau a donc ses propres appels
            et son propre verrou d'ecriture, il ne passe pas par `enregistrer`. */}
        {onglet === 'connaissance' && <AgentConnaissance tenantId={tenantId} agentId={ouvert.id} />}
        {onglet === 'perimetre' && <OngletPerimetre agent={ouvert} busy={busy} onSave={enregistrer} />}
        {onglet === 'modele' && <OngletModele agent={ouvert} busy={busy} onSave={enregistrer} />}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <p className={kickerCls}>{t('AGENT IA', 'AI AGENT')}</p>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Vos agents', 'Your agents')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'Un agent tient une conversation sur plusieurs tours, là où vous posez un bloc « Agent IA » dans un scénario. Il ne répond nulle part ailleurs.',
            'An agent holds a conversation over several turns, wherever you place an “AI agent” block in a scenario. It answers nowhere else.',
          )}
        </p>
      </div>
      {erreur && <MbaNotice kind="error" testid="agent-erreur">{erreur}</MbaNotice>}
      <div className={`${cardCls} flex flex-col gap-3`}>
        <label className="text-sm font-medium text-ink-700">{t('Créer un agent', 'Create an agent')}</label>
        <div className="flex flex-wrap gap-2">
          <input
            data-testid="agent-nouveau-label"
            className={`${inputCls} max-w-sm`}
            value={nouveau}
            onChange={(e) => setNouveau(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void creer(); }}
            placeholder={t('Nom interne, par exemple « Conseiller séjours »', 'Internal name, e.g. “Stay advisor”')}
          />
          <button
            data-testid="agent-creer"
            onClick={() => void creer()}
            disabled={busy || nouveau.trim() === ''}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {t('Créer', 'Create')}
          </button>
        </div>
        <p className="text-xs text-ink-500">
          {t(
            'Un agent est créé en brouillon : il n’apparaît dans le builder qu’une fois activé, quand vous avez relu ce qu’il dira.',
            'An agent is created as a draft: it only shows up in the builder once activated, when you have reviewed what it will say.',
          )}
        </p>
      </div>
      <div className={`${cardCls} flex flex-col gap-2`}>
        {agents === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}
        {agents?.length === 0 && <p className="text-sm text-ink-500">{t('Aucun agent pour le moment.', 'No agent yet.')}</p>}
        {(agents ?? []).map((a) => (
          <button
            key={a.id}
            data-testid={`agent-ligne-${a.id}`}
            onClick={() => aller(a.id, 'identite')}
            className="flex items-center justify-between gap-3 rounded-lg border border-ink-200 px-3 py-2 text-left hover:bg-ink-50"
          >
            <span className="truncate text-sm font-medium text-ink-800">{a.label}</span>
            <Pastille status={a.status} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Pastille({ status }: { status: AgentResume['status'] }) {
  const t = useT();
  const libelle = status === 'active' ? t('Actif', 'Active') : status === 'draft' ? t('Brouillon', 'Draft') : t('Désactivé', 'Disabled');
  const cls = status === 'active' ? 'bg-emerald-50 text-emerald-700' : status === 'draft' ? 'bg-ink-100 text-ink-600' : 'bg-amber-50 text-amber-800';
  return <span data-testid={`agent-statut-${status}`} className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{libelle}</span>;
}

/** Activation, agent par agent. Le seul geste qui rend un agent proposable dans un scénario. */
function Activation({ agent, busy, onChange }: { agent: AgentComplet; busy: boolean; onChange: (s: AgentComplet['status']) => void }) {
  const t = useT();
  const actif = agent.status === 'active';
  return (
    <div className="flex items-center gap-2">
      <Pastille status={agent.status} />
      <button
        data-testid="agent-activer"
        disabled={busy}
        onClick={() => onChange(actif ? 'disabled' : 'active')}
        className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
      >
        {actif ? t('Désactiver', 'Deactivate') : t('Activer', 'Activate')}
      </button>
    </div>
  );
}

/** Champ texte enregistré à la sortie du champ, comme les écrans MBA : pas de bouton par champ, pas de
 *  sauvegarde à chaque frappe. */
function Champ({ label, aide, valeur, multi, onSave, testId, busy }: {
  label: string; aide?: string; valeur: string; multi?: boolean; testId: string; busy: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(valeur);
  useEffect(() => { setV(valeur); }, [valeur]);
  const commun = {
    'data-testid': testId,
    className: inputCls,
    value: v,
    disabled: busy,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => { if (v !== valeur) onSave(v); },
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-ink-700">{label}</label>
      {multi ? <textarea rows={4} {...commun} /> : <input {...commun} />}
      {aide && <p className="text-xs leading-relaxed text-ink-500">{aide}</p>}
    </div>
  );
}

function OngletIdentite({ agent, busy, onSave }: { agent: AgentComplet; busy: boolean; onSave: (p: PatchAgent) => void }) {
  const t = useT();
  const c = agent.contenu;
  return (
    <div className={`${cardCls} flex flex-col gap-4`}>
      <Champ
        testId="agent-label" busy={busy} label={t('Nom interne', 'Internal name')}
        aide={t('Ce que VOUS voyez dans la liste et dans le builder. Le contact ne le voit jamais.', 'What YOU see in the list and in the builder. The contact never sees it.')}
        valeur={agent.label} onSave={(v) => onSave({ label: v })}
      />
      <Champ
        testId="agent-nom" busy={busy} label={t('Nom donné au contact', 'Name given to the contact')}
        aide={t('Laissé vide, l’agent ne se donne aucun nom.', 'Left empty, the agent gives itself no name.')}
        valeur={c.nom} onSave={(v) => onSave({ contenu: { ...c, nom: v } })}
      />
      <Champ
        testId="agent-ton" busy={busy} multi label={t('Ton', 'Tone')}
        aide={t('Vouvoiement, phrases courtes, pas d’emoji… écrivez-le comme vous le diriez à une nouvelle recrue.', 'Formal, short sentences, no emoji… write it as you would tell a new hire.')}
        valeur={c.ton} onSave={(v) => onSave({ contenu: { ...c, ton: v } })}
      />
      <Champ
        testId="agent-personnalite" busy={busy} multi label={t('Personnalité', 'Personality')}
        valeur={c.personnalite} onSave={(v) => onSave({ contenu: { ...c, personnalite: v } })}
      />
      <Champ
        testId="agent-mention" busy={busy} multi label={t('Mention d’IA', 'AI disclosure')}
        aide={t(
          'Obligatoire : la loi impose d’annoncer que l’interlocuteur parle à une IA. Cette phrase part au premier message et ne peut pas être vide.',
          'Mandatory: the law requires telling the contact they are talking to an AI. This sentence goes out with the first message and cannot be empty.',
        )}
        valeur={agent.mentionIa} onSave={(v) => onSave({ mentionIa: v })}
      />
    </div>
  );
}

function OngletObjectif({ agent, busy, onSave }: { agent: AgentComplet; busy: boolean; onSave: (p: PatchAgent) => void }) {
  const t = useT();
  const c = agent.contenu;
  const majSorties = (sorties: SortieAgent[]) => onSave({ contenu: { ...c, sorties } });
  return (
    <div className="flex flex-col gap-4">
      <div className={`${cardCls} flex flex-col gap-4`}>
        <Champ
          testId="agent-objectif" busy={busy} multi label={t('Objectif de l’agent', 'The agent’s objective')}
          aide={t('Ce qu’il est là pour faire, en une ou deux phrases. C’est le champ qui pèse le plus sur ce qu’il répondra.', 'What it is there to do, in a sentence or two. This is the field that weighs most on what it answers.')}
          valeur={c.objectif} onSave={(v) => onSave({ contenu: { ...c, objectif: v } })}
        />
        <Champ
          testId="agent-transferts" busy={busy} multi label={t('Quand passer la main à un humain', 'When to hand over to a human')}
          aide={t('En français, comme vous le diriez. Par exemple : dès qu’on parle d’un remboursement, ou si le contact s’énerve.', 'In plain words. For example: as soon as a refund comes up, or if the contact gets upset.')}
          valeur={c.reglesTransfert} onSave={(v) => onSave({ contenu: { ...c, reglesTransfert: v } })}
        />
      </div>
      <div className={`${cardCls} flex flex-col gap-3`}>
        <div>
          <p className="text-sm font-medium text-ink-700">{t('Règles d’arrêt', 'Stop rules')}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            {t(
              'Chacune devient une SORTIE du bloc agent dans le builder : c’est là que vous branchez la suite du parcours. L’agent choisit celle qui correspond à ce qu’il vient de faire.',
              'Each becomes an OUTPUT of the agent block in the builder: that is where you connect what happens next. The agent picks the one matching what it just did.',
            )}
          </p>
        </div>
        <CodeSortieInput sorties={c.sorties} busy={busy} onChange={majSorties} />
      </div>
    </div>
  );
}

function OngletPerimetre({ agent, busy, onSave }: { agent: AgentComplet; busy: boolean; onSave: (p: PatchAgent) => void }) {
  const t = useT();
  return (
    <div className={`${cardCls} flex flex-col gap-4`}>
      <Nombre
        testId="agent-max-tours" busy={busy} label={t('Tours maximum', 'Maximum turns')} min={1} max={20}
        aide={t('Au-delà, l’agent sort par « Plafond atteint ». Un garde-fou, pas un réglage de confort.', 'Beyond this, the agent leaves through “Cap reached”. A guardrail, not a comfort setting.')}
        valeur={agent.maxTours} onSave={(v) => onSave({ maxTours: v })}
      />
      <Nombre
        testId="agent-max-outils" busy={busy} label={t('Appels d’outils maximum', 'Maximum tool calls')} min={0} max={60}
        valeur={agent.maxAppelsOutils} onSave={(v) => onSave({ maxAppelsOutils: v })}
      />
      <Nombre
        testId="agent-inactivite" busy={busy} label={t('Inactivité, en minutes', 'Inactivity, in minutes')} min={1} max={1440}
        aide={t('Sans réponse du contact pendant ce temps, le parcours sort par « Pas de réponse ».', 'With no reply from the contact for that long, the journey leaves through “No reply”.')}
        valeur={agent.inactiviteMinutes} onSave={(v) => onSave({ inactiviteMinutes: v })}
      />
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-ink-700">{t('Contact inconnu du mini-CRM', 'Contact unknown to the mini-CRM')}</label>
        <select
          data-testid="agent-contact-inconnu"
          className={`${inputCls} bg-white`}
          value={agent.contactInconnu}
          disabled={busy}
          onChange={(e) => onSave({ contactInconnu: e.target.value as AgentComplet['contactInconnu'] })}
        >
          <option value="aucun_outil">{t('Aucun outil', 'No tool')}</option>
          <option value="lecture_seule">{t('Outils de lecture seulement', 'Read-only tools')}</option>
          <option value="tous">{t('Tous les outils', 'All tools')}</option>
        </select>
        <p className="text-xs leading-relaxed text-ink-500">
          {t(
            'Ce que l’agent a le droit de faire quand il ne sait pas à qui il parle. « Aucun outil » est le plus prudent.',
            'What the agent may do when it does not know who it is talking to. “No tool” is the safest.',
          )}
        </p>
      </div>
    </div>
  );
}

function OngletModele({ agent, busy, onSave }: { agent: AgentComplet; busy: boolean; onSave: (p: PatchAgent) => void }) {
  const t = useT();
  return (
    <div className={`${cardCls} flex flex-col gap-4`}>
      <Champ
        testId="agent-modele" busy={busy} label={t('Modèle', 'Model')}
        aide={t('Le moteur qui fait parler l’agent. À changer seulement si vous savez pourquoi.', 'The engine that makes the agent talk. Change it only if you know why.')}
        valeur={agent.modele} onSave={(v) => onSave({ modele: v })}
      />
      <Nombre
        testId="agent-budget" busy={busy} label={t('Budget par conversation, en micro-euros', 'Budget per conversation, in micro-euros')} min={1} max={100_000_000}
        aide={t('Épuisé, l’agent sort par « Plafond atteint ». 30 000 micro-euros valent 3 centimes.', 'Once spent, the agent leaves through “Cap reached”. 30,000 micro-euros is 3 cents.')}
        valeur={agent.budgetMicroEur} onSave={(v) => onSave({ budgetMicroEur: v })}
      />
    </div>
  );
}

function Nombre({ label, aide, valeur, min, max, onSave, testId, busy }: {
  label: string; aide?: string; valeur: number; min: number; max: number; testId: string; busy: boolean;
  onSave: (v: number) => void;
}) {
  const t = useT();
  const [v, setV] = useState(String(valeur));
  useEffect(() => { setV(String(valeur)); }, [valeur]);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-ink-700">{label}</label>
      <input
        data-testid={testId}
        type="number"
        min={min}
        max={max}
        className={`${inputCls} max-w-[12rem]`}
        value={v}
        disabled={busy}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          // Bornes rejouées ICI, en plus du serveur : un nombre hors bornes serait refusé en 400, et l'écran
          // afficherait une erreur technique pour une saisie que le champ savait déjà mauvaise.
          if (!Number.isInteger(n) || n < min || n > max) { setV(String(valeur)); return; }
          if (n !== valeur) onSave(n);
        }}
      />
      {/* Les bornes sont DITES : le champ remet la valeur précédente quand la saisie sort des clous, et un
          nombre qui disparaît sans explication se lit comme un bug de l'écran. */}
      <p className="text-xs leading-relaxed text-ink-500">{aide ? `${aide} ` : ''}{t('Entre', 'Between')} {min} {t('et', 'and')} {max}.</p>
    </div>
  );
}
