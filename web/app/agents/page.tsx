'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { MbaNotice } from '@/components/MbaNotice';
import { MbaTabs } from '@/components/MbaTabs';
import { useT, useLocale } from '@/lib/i18n';
import { cardCls, inputCls, kickerCls } from '@/lib/ui';
import {
  createAgent, deleteAgent, getAgent, getSoldeAgent, listAgents, patchAgent,
  type AgentComplet, type AgentResume, type PatchAgent, type SortieAgent,
} from '@/lib/api-agent';
import { eurosDepuisMicro, SOLDE_BAS_MICRO_EUR } from '@/lib/agent-solde';
import { CodeSortieInput } from '@/components/AgentSorties';
import { AgentConnaissance } from '@/components/AgentConnaissance';
import { AgentOutils } from '@/components/AgentOutils';
import { AgentConstruction } from '@/components/AgentConstruction';
import { AgentTest } from '@/components/AgentTest';
import { appliquerProposition, manquesDe, type ManqueFiche } from '@/lib/api-agent-setup';
import { ApiError } from '@/lib/http';
import { consommationAgent, type ConsommationAgent } from '@/lib/api-agent';

/**
 * Écran de réglage d'un agent IA, calqué sur celui de l'agent Meta : une liste, puis une fiche à onglets.
 *
 * 🔴 CE QUE « ACTIVÉ » VEUT DIRE ICI, et ce n'est pas ce qu'on croit. Un agent actif n'est pas un agent qui
 * « répond à tout » : c'est un agent PROPOSABLE dans un scénario. Il ne parle que là où le client a posé un
 * bloc agent et l'y a désigné. C'est pour ça que l'activation vit sur la fiche, agent par agent, et non sur
 * un interrupteur d'accueil comme l'agent de Meta, qui lui est unique par workspace.
 */

type Onglet = 'construction' | 'identite' | 'objectif' | 'connaissance' | 'outils' | 'perimetre' | 'modele' | 'tester';

const ONGLETS: Onglet[] = ['construction', 'identite', 'objectif', 'connaissance', 'outils', 'perimetre', 'modele', 'tester'];
// 🔴 « Construire en parlant » EST l'entrée par défaut, pas « Identité et ton ». Julien, 2026-08-31 : « je
// voudrais que la fenêtre Construire en parlant apparaisse en premier ». L'ordre des onglets le disait déjà,
// mais le défaut ouvrait le formulaire : on tombait sur des champs vides à remplir seul, alors que tout
// l'intérêt de cet écran est qu'on n'a pas à savoir quoi y écrire.
const ONGLET_PAR_DEFAUT: Onglet = 'construction';
const lireOnglet = (v: string | null): Onglet => (ONGLETS as string[]).includes(v ?? '') ? (v as Onglet) : ONGLET_PAR_DEFAUT;

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
  // Ce qui manque pour ACTIVER, tel que le serveur le rend en 422. Séparé du message d'erreur : ce n'est pas
  // une panne, c'est une liste de choses à faire, et chacune pointe l'onglet où elle se fait.
  const [manques, setManques] = useState<ManqueFiche[]>([]);
  // Le solde prépayé du workspace. `null` = aucun solde sur cette instance, on n'affiche rien plutôt que
  // d'annoncer « 0 € » à un client dont le compte n'est simplement pas branché.
  const [solde, setSolde] = useState<number | null>(null);

  const charger = useCallback(async () => {
    // `tous: true` : c'est l'écran qui CRÉE les agents, il doit voir ses propres brouillons. Le builder, lui,
    // n'appelle jamais avec ce drapeau.
    try {
      setAgents(await listAgents(tenantId, { tous: true }));
      setSolde(await getSoldeAgent(tenantId));
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

  /**
   * Supprime un agent, DEPUIS SA FICHE OU DEPUIS LA LISTE.
   *
   * Julien, 2026-08-31 : « il faut pouvoir supprimer un agent (quand on appuie sur other AI agent) ». Le
   * bouton n'existait que sur la fiche ouverte : jeter un agent d'essai supposait d'entrer dedans d'abord.
   * La fonction prend donc son sujet en paramètre plutôt que de lire `ouvert`, ce qui la rend utilisable des
   * deux endroits sans la dupliquer.
   */
  async function supprimer(cible: { id: string; label: string }) {
    if (busy) return;
    // Confirmation NATIVE : la suppression emporte les conversations, les outils et la base de connaissance
    // de cet agent, et le repo n'a pas de boîte de dialogue maison.
    if (!window.confirm(t(
      `Supprimer « ${cible.label} » ? Ses conversations, ses outils et sa base de connaissance partent avec lui, et les blocs de scénario qui l'utilisent cesseront de répondre.`,
      `Delete “${cible.label}”? Its conversations, tools and knowledge base go with it, and the scenario blocks using it will stop answering.`,
    ))) return;
    setBusy(true);
    setErreur(null);
    try {
      await deleteAgent(tenantId, cible.id);
      // On ne referme la fiche QUE si c'est celle qu'on vient de supprimer : depuis la liste, il n'y a rien
      // d'ouvert, et forcer une navigation ferait clignoter l'écran pour rien.
      if (ouvert?.id === cible.id) {
        setOuvert(null);
        aller(null, ONGLET_PAR_DEFAUT);
      }
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
    setManques([]);
    try {
      // Le verrou de version accompagne TOUT patch de fiche : sans lui, deux surfaces qui écrivent la même
      // clé se recouvrent en silence. Le serveur refuse en 409, et le message dit de recharger.
      const avecVerrou = patch.contenu ? { ...patch, ficheVersionAttendue: ouvert.ficheVersion } : patch;
      setOuvert(await patchAgent(tenantId, ouvert.id, avecVerrou));
      await charger();
    } catch (err) {
      // 422 sur une activation : l'agent est incomplet. On montre la LISTE, pas « agent incomplet », qui
      // serait un refus sans mode d'emploi.
      const liste = err instanceof ApiError && err.status === 422 ? manquesDe(err.corps) : [];
      if (liste.length > 0) setManques(liste);
      else setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save'));
    } finally {
      setBusy(false);
    }
  }

  if (ouvert) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button onClick={() => { setOuvert(null); aller(null, ONGLET_PAR_DEFAUT); void charger(); }} className="text-sm text-brand-600 hover:underline">
            ← {t('Retour aux agents', 'Back to agents')}
          </button>
          <div className="flex items-center gap-2">
            <Activation agent={ouvert} busy={busy} onChange={(status) => void enregistrer({ status })} />
            <button
              data-testid="agent-supprimer"
              disabled={busy}
              onClick={() => void supprimer(ouvert)}
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
        {manques.length > 0 && (
          <MbaNotice kind="warning" testid="agent-manques">
            <span className="font-medium">{t('Cet agent ne peut pas encore être activé :', 'This agent cannot be activated yet:')}</span>
            <span className="mt-1 block">
              {manques.map((m) => (
                <button
                  key={m.message}
                  data-testid={`agent-manque-${m.onglet}`}
                  onClick={() => aller(ouvert.id, m.onglet)}
                  className="block text-left underline decoration-dotted hover:decoration-solid"
                >
                  {m.message}
                </button>
              ))}
            </span>
          </MbaNotice>
        )}
        <MbaTabs
          active={onglet}
          onSelect={(k) => aller(ouvert.id, lireOnglet(k))}
          tabs={[
            { key: 'construction', label: t('Construire en parlant', 'Build by talking') },
            { key: 'identite', label: t('Identité et ton', 'Identity and tone') },
            { key: 'objectif', label: t('Objectif et transferts', 'Objective and handovers') },
            { key: 'connaissance', label: t('Base de connaissance', 'Knowledge base') },
            { key: 'outils', label: t('Outils', 'Tools') },
            { key: 'perimetre', label: t('Périmètre et garde-fous', 'Scope and guardrails') },
            { key: 'modele', label: t('Modèle', 'Model') },
            { key: 'tester', label: t('Tester', 'Test') },
          ]}
        />
        {/* La conversation n'ecrit RIEN toute seule : elle rend une proposition, et c'est cet ecran qui
            l'applique, par les memes routes que le formulaire et avec le meme verrou de version. */}
        {onglet === 'construction' && (
          <AgentConstruction
            tenantId={tenantId}
            agentId={ouvert.id}
            onApplique={async (p) => {
              try {
                await appliquerProposition(tenantId, ouvert.id, p, ouvert.ficheVersion);
              } finally {
                // Relu MÊME en cas d'échec, et c'est le point : un échec partiel (la fiche écrite, un outil
                // refusé) laisse le numéro de version périmé en mémoire, et un second essai se ferait alors
                // refuser en 409 pour une raison qui n'a rien à voir avec la cause réelle.
                setOuvert(await getAgent(tenantId, ouvert.id));
                await charger();
              }
            }}
          />
        )}
        {onglet === 'identite' && <OngletIdentite agent={ouvert} busy={busy} onSave={enregistrer} />}
        {onglet === 'objectif' && <OngletObjectif agent={ouvert} busy={busy} onSave={enregistrer} />}
        {/* La connaissance vit dans SA table, pas dans la fiche jsonb : ce panneau a donc ses propres appels
            et son propre verrou d'ecriture, il ne passe pas par `enregistrer`. */}
        {onglet === 'connaissance' && <AgentConnaissance tenantId={tenantId} agentId={ouvert.id} />}
        {/* Les outils vivent dans LEUR table, avec leur propre consentement humain : ce panneau ne passe pas
            non plus par `enregistrer`, qui n'ecrit que la fiche. */}
        {onglet === 'outils' && <AgentOutils tenantId={tenantId} agentId={ouvert.id} />}
        {onglet === 'perimetre' && <OngletPerimetre agent={ouvert} busy={busy} onSave={enregistrer} />}
        {onglet === 'modele' && <OngletModele agent={ouvert} tenantId={tenantId} busy={busy} onSave={enregistrer} />}
        {/* Le bac a sable fait tourner le VRAI cerveau, sans session ni run : il n ecrit rien, il ne passe
            donc pas non plus par `enregistrer`. */}
        {onglet === 'tester' && <AgentTest tenantId={tenantId} agentId={ouvert.id} />}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      {solde !== null && <Solde microEur={solde} />}
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
        {/* Une LIGNE, pas un bouton : la suppression vit ici, et un bouton dans un bouton n'est pas du HTML
            valide (le navigateur défait l'imbrication, et le clic devient imprévisible). */}
        {(agents ?? []).map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-lg border border-ink-200 pr-2 hover:bg-ink-50"
          >
            <button
              data-testid={`agent-ligne-${a.id}`}
              onClick={() => aller(a.id, ONGLET_PAR_DEFAUT)}
              className="flex flex-1 items-center justify-between gap-3 px-3 py-2 text-left"
            >
              <span className="truncate text-sm font-medium text-ink-800">{a.label}</span>
              <Pastille status={a.status} />
            </button>
            <button
              data-testid={`agent-supprimer-${a.id}`}
              disabled={busy}
              onClick={() => void supprimer({ id: a.id, label: a.label })}
              title={t('Supprimer cet agent', 'Delete this agent')}
              aria-label={t(`Supprimer ${a.label}`, `Delete ${a.label}`)}
              className="shrink-0 rounded-lg border border-ink-300 px-2 py-1 text-xs text-coral hover:bg-red-50 disabled:opacity-40"
            >
              {t('Supprimer', 'Delete')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Le solde prépayé du workspace.
 *
 * 🔴 IL EST SUR LA LISTE, PAS DANS UN ONGLET. Un solde qu'il faut aller chercher ne prévient personne : ce
 * qu'on veut, c'est qu'un client le voie descendre sans le demander, et qu'il sache pourquoi ses agents se
 * sont tus le jour où ils se taisent.
 */
function Solde({ microEur }: { microEur: number }) {
  const t = useT();
  const euros = eurosDepuisMicro(microEur);
  if (microEur <= 0) {
    return (
      <MbaNotice kind="error" testid="agent-solde-vide">
        {t(
          'Votre crédit est épuisé : vos agents ne répondent plus et sortent par « Plafond atteint ». Contactez-nous pour recharger.',
          'Your credit is used up: your agents no longer answer and leave through “Cap reached”. Contact us to top up.',
        )}
      </MbaNotice>
    );
  }
  if (microEur < SOLDE_BAS_MICRO_EUR) {
    return (
      <MbaNotice kind="warning" testid="agent-solde-bas">
        {t(
          `Crédit restant : ${euros} €. C’est bas : au bout, vos agents cesseront de répondre.`,
          `Credit left: €${euros}. That is low: once it runs out, your agents will stop answering.`,
        )}
      </MbaNotice>
    );
  }
  return (
    <p data-testid="agent-solde" className="text-sm text-ink-500">
      {t(`Crédit restant : ${euros} €`, `Credit left: €${euros}`)}
    </p>
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

function OngletModele({ agent, tenantId, busy, onSave }: {
  agent: AgentComplet; tenantId: string; busy: boolean; onSave: (p: PatchAgent) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [conso, setConso] = useState<ConsommationAgent | null>(null);
  const [consoLue, setConsoLue] = useState(false);

  useEffect(() => {
    let vivant = true;
    // ⚠️ La mesure ne peut pas faire tomber l'écran de réglage : en cas d'échec on la laisse à `null`, et le
    // bloc ne s'affiche pas. Un zéro se lirait « cet agent n'a rien consommé », ce qui est une information
    // FAUSSE présentée comme une mesure.
    void consommationAgent(tenantId, agent.id)
      .then((c) => { if (vivant) setConso(c); })
      .catch(() => { if (vivant) setConso(null); })
      .finally(() => { if (vivant) setConsoLue(true); });
    return () => { vivant = false; };
  }, [tenantId, agent.id]);

  const nb = (n: number): string => n.toLocaleString(locale === 'en' ? 'en-US' : 'fr-FR');

  return (
    <div className={`${cardCls} flex flex-col gap-4`}>
      <Champ
        testId="agent-modele" busy={busy} label={t('Modèle', 'Model')}
        aide={t('Le moteur qui fait parler l’agent. À changer seulement si vous savez pourquoi.', 'The engine that makes the agent talk. Change it only if you know why.')}
        valeur={agent.modele} onSave={(v) => onSave({ modele: v })}
      />

      {/* 🔴 CE QUE L'AGENT A CONSOMMÉ, PAS UN BUDGET À RÉGLER. Cet onglet portait un champ « budget par
          conversation en micro-euros » : un plafond, là où on vient voir ce que le robot a coûté. Le
          plafond existe toujours et protège toujours d'une boucle qui s'emballe, il n'est simplement plus
          proposé au réglage ici. */}
      {consoLue && conso !== null && (
        <div className="rounded-xl border border-ink-200 p-4" data-testid="agent-consommation">
          <p className="text-sm font-medium text-ink-700">
            {t(`Consommation sur ${conso.jours} jours`, `Usage over ${conso.jours} days`)}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { k: 'conversations', v: nb(conso.sessions), l: t('conversations', 'conversations') },
              { k: 'entree', v: nb(conso.tokensEntree), l: t('tokens en entrée', 'input tokens') },
              { k: 'sortie', v: nb(conso.tokensSortie), l: t('tokens en sortie', 'output tokens') },
              // Les micro-euros sont l'unité de STOCKAGE, pas une unité de lecture : on montre des euros.
              { k: 'cout', v: `${(conso.coutMicroEur / 1_000_000).toFixed(2)} €`, l: t('coût estimé', 'estimated cost') },
            ].map((x) => (
              <div key={x.k} data-testid={`agent-conso-${x.k}`}>
                <dd className="text-lg font-semibold tabular-nums text-ink-800">{x.v}</dd>
                <dt className="text-xs text-ink-400">{x.l}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-ink-400">
            {t(
              'Compté sur les conversations de cet agent. Une conversation encore en cours y figure déjà, avec ce qu’elle a consommé jusqu’ici.',
              'Counted over this agent’s conversations. An ongoing conversation already appears, with what it has used so far.',
            )}
          </p>
        </div>
      )}
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
