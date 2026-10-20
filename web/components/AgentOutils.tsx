'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { MbaNotice } from '@/components/MbaNotice';
import { ChoixAppel, ModificationAppel } from '@/components/AgentConnecteurs';
import { ChoixTypeOutil } from '@/components/mba-outils/ChoixTypeOutil';
import { FormulaireOutilAgent } from '@/components/agent-outils/FormulaireOutilAgent';
import { LigneOutilAgent } from '@/components/agent-outils/LigneOutilAgent';
import { AutonomieOutil, ReglagesOutil, type PatchReglages } from '@/components/agent-outils/ReglagesOutil';
import { ToujoursLa } from '@/components/agent-outils/ToujoursLa';
import { HANDLER_DU_TYPE, cibleDeLOutil, estToujoursLa, typeDuHandler, type CibleSaisieAgent, type TypeACible } from '@/lib/agent-outils';
import { estEnLigne, listWorkflows } from '@/lib/api';
import { listRequetes } from '@/lib/api-agent-requetes';
import { listerBlocsMba } from '@/lib/api-mba-outils';
import {
  activerOutil, ajouterOutil, autonomieOutil, getOutilsOffrables, listOutils, patchOutil, rattacherOutil, retirerOutil,
  type ModeleOutil, type OutilAgent, type OutilBibliotheque,
} from '@/lib/api-agent-tools';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';

type Mode =
  | { vue: 'liste' } | { vue: 'choix' } | { vue: 'mcp' } | { vue: 'connecteur' }
  | { vue: 'form'; type: TypeACible };
type Traduire = (fr: string, en?: string) => string;

/** Les noms qui servent à dire ce qu'un outil vise : scénarios en ligne, blocs, appels. Lus au mieux. */
interface Noms {
  scenarios: Map<string, string>;
  blocs: Map<string, string>;
  appels: Map<string, string>;
}

/** Ce que vise un outil, en mots (le parent a les noms ; la ligne ne lit rien). */
function libelleCible(o: OutilAgent, noms: Noms, t: Traduire): string {
  if (o.origin === 'http') {
    const libelle = noms.appels.get(o.requestId ?? '');
    return libelle ? t(`Appel : ${libelle}`, `Call: ${libelle}`) : t('Appel de Connecteurs API', 'Call from API connectors');
  }
  if (o.origin === 'mcp') return t(`Outil MCP : ${o.name}`, `MCP tool: ${o.name}`);
  const c: CibleSaisieAgent | null = cibleDeLOutil(o.binding);
  if (c === null) return o.name;
  switch (c.type) {
    case 'tag': return c.tag ? t(`Tag : ${c.tag}`, `Tag: ${c.tag}`) : t('Tag à choisir', 'Tag to pick');
    case 'champ':
      if (!c.champ) return t('Champ à choisir', 'Field to pick');
      return c.valeurs.length > 0 ? t(`Champ : ${c.champ} (${c.valeurs.join(', ')})`, `Field: ${c.champ} (${c.valeurs.join(', ')})`) : t(`Champ : ${c.champ}`, `Field: ${c.champ}`);
    case 'bloc': {
      const scenario = noms.scenarios.get(c.workflowId) ?? t('scénario supprimé ou dépublié', 'deleted or unpublished scenario');
      const bloc = noms.blocs.get(c.code) ?? c.code;
      return t(`Bloc « ${bloc} » du scénario ${scenario}`, `Block “${bloc}” of scenario ${scenario}`);
    }
    case 'scenario': {
      const nom = noms.scenarios.get(c.workflowId);
      return nom ? t(`Scénario : ${nom}`, `Scenario: ${nom}`) : t('Scénario supprimé ou dépublié', 'Deleted or unpublished scenario');
    }
    case 'action': {
      const n = c.champs.length;
      const champs = n === 0 ? '' : t(` (${n} champ${n > 1 ? 's' : ''})`, ` (${n} field${n > 1 ? 's' : ''})`);
      return c.nom ? t(`Action : ${c.nom}${champs}`, `Action: ${c.nom}${champs}`) : t('Action à nommer', 'Action to name');
    }
    case 'enchainement': {
      const n = c.etapes.length;
      const questions = c.etapes.filter((e) => e.type === 'demander').length;
      const dernier = c.etapes[n - 1];
      const fin = dernier?.type === 'scenario'
        ? t(`, puis scénario ${noms.scenarios.get(dernier.workflowId) ?? '(supprimé ou dépublié)'}`, `, then scenario ${noms.scenarios.get(dernier.workflowId) ?? '(deleted or unpublished)'}`)
        : dernier?.type === 'transferer' ? t(', puis « À traiter »', ', then “To handle”') : '';
      return t(`${n} étape${n > 1 ? 's' : ''}, dont ${questions} question${questions > 1 ? 's' : ''}${fin}`,
        `${n} step${n > 1 ? 's' : ''}, ${questions} question${questions > 1 ? 's' : ''}${fin}`);
    }
    case 'qualification': {
      const n = c.etapes.length;
      return t(`${n} question${n > 1 ? 's' : ''}, puis « À traiter »`, `${n} question${n > 1 ? 's' : ''}, then “To handle”`);
    }
  }
}

/**
 * L'onglet OUTILS d'un agent IA, présenté comme celui de l'agent de Meta (RC4, décision de Julien du 2026-10-06).
 *
 *  - **« Toujours là »** en tête : les gestes propres à l'agent IA (terminer, passer à l'équipe, chercher dans la
 *    connaissance, lire la fiche, marquer urgent), avec les mêmes commandes que la liste (`ActionsOutil`) : Activer
 *    ou Désactiver, Modifier pour leurs réglages, et la croix qui supprime.
 *  - **« Ajouter un outil »** ouvre la grille « Quel outil ajouter ? » de l'agent de Meta (`ChoixTypeOutil`, ses six
 *    cartes) : un tag, une information, un bloc ou un scénario FIXÉS par l'administrateur, un appel de Connecteurs API,
 *    un outil MCP ; plus « Déclencher une action », propre à l'agent IA (plan du 2026-10-13).
 *  - **La liste des outils posés**, au format des lignes de l'agent de Meta, connecteurs API et outils MCP compris :
 *    les sections « Vos systèmes » et « Vos serveurs MCP » ont disparu en tant que sections.
 *
 * 🔴 CE QUE CET ÉCRAN ACCORDE, et qui ne change pas : un outil actif est exposé au modèle et exécutable par lui, donc par
 * un texte qu'un contact influence. Poser et ACTIVER restent deux gestes (« Activer » sur une ligne de « Toujours là » les
 * enchaîne à la main du client), et l'autonomie sur une action irréversible en reste un troisième.
 *
 * ⚠️ `onChange` EXISTE PARCE QUE LE BANDEAU D'AVERTISSEMENT VIT AILLEURS : ce panneau écrit dans SA table, et la page
 * relit ses manques quand on le lui dit (Julien, 2026-09-11).
 */
export function AgentOutils({ tenantId, agentId, onChange }: { tenantId: string; agentId: string; onChange?: () => void }) {
  const t = useT();
  const confirmer = useConfirmation();
  const [vue, setVue] = useState<{ outils: OutilAgent[]; catalogue: ModeleOutil[] } | null>(null);
  const [offrables, setOffrables] = useState<OutilBibliotheque[]>([]);
  const [noms, setNoms] = useState<Noms>({ scenarios: new Map(), blocs: new Map(), appels: new Map() });
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ vue: 'liste' });
  /** L'outil dont le panneau (réglages ou modification) est ouvert. Un seul à la fois. */
  const [ouvert, setOuvert] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      /**
       * 🔴 DEUX LECTURES : ce que CET agent utilise (`listOutils`, jointure interne sur les consommateurs) et ce que le
       * serveur permet de lui AJOUTER (`offrables`, la règle unique du 2026-10-02), d'où viennent les outils MCP
       * importés mais pas encore donnés. ⚠️ La seconde est BEST-EFFORT, avec `?? []` : un corps vide ne lève pas.
       */
      const [v, offerts] = await Promise.all([
        listOutils(tenantId, agentId),
        getOutilsOffrables(tenantId, agentId).then((r) => r.outils ?? []).catch(() => []),
      ]);
      setVue(v);
      setOffrables(offerts);
      // Les noms de ce que visent les outils : au mieux. Un nom qui manque se dit « supprimé », jamais une panne.
      const blocsVises = [...new Set(v.outils.flatMap((o) => {
        const c = cibleDeLOutil(o.binding);
        return c?.type === 'bloc' && c.workflowId !== '' ? [c.workflowId] : [];
      }))];
      const [scenarios, appels, ...blocs] = await Promise.all([
        listWorkflows(tenantId).then((r) => (Array.isArray(r?.workflows) ? r.workflows : []).filter(estEnLigne)).catch(() => []),
        v.outils.some((o) => o.origin === 'http')
          ? listRequetes(tenantId).then((r) => (Array.isArray(r?.requetes) ? r.requetes : [])).catch(() => []) : Promise.resolve([]),
        ...blocsVises.map((wf) => listerBlocsMba(tenantId, wf).then((r) => (Array.isArray(r?.blocs) ? r.blocs : [])).catch(() => [])),
      ]);
      setNoms({
        scenarios: new Map(scenarios.map((w) => [w.id, w.name])),
        appels: new Map(appels.map((r) => [r.id, r.label])),
        blocs: new Map(blocs.flat().map((b) => [b.code, b.nom])),
      });
    } catch (err) {
      setErreur(erreurDeChargement(err, t));
    }
  }, [tenantId, agentId, t]);
  useEffect(() => { void charger(); }, [charger]);

  async function agir(travail: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    try {
      await travail();
      await charger();
      // Le bandeau de la page se calcule sur CET inventaire : sans ce rappel, il annonce l'état d'avant.
      onChange?.();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Opération impossible', 'Operation failed'));
      // Ce qui a pu réussir avant l'échec (un outil posé, pas encore actif) se voit tout de suite.
      await charger();
    } finally {
      setBusy(false);
    }
  }

  /** Après un enregistrement d'un formulaire : la liste relue, le formulaire refermé, et la suite manquée dite. */
  const apresEnregistrement = async (suite?: string): Promise<void> => {
    setMode({ vue: 'liste' });
    setOuvert(null);
    await charger();
    onChange?.();
    if (suite) setErreur(suite);
  };

  const retirer = async (o: OutilAgent): Promise<void> => {
    // Une ACTION appartient à cet agent (0157) : la retirer la SUPPRIME, réglages compris. Un connecteur part s'il ne
    // sert plus à personne ; un outil MCP reste branchable par les autres agents.
    // Un geste de « Toujours là » supprimé garde sa ligne : « Activer » le repose, avec les réglages par défaut. Lu sur
    // la section réellement affichée : un doublon du même geste vit dans la liste, et sa suppression n'a rien à remettre.
    const toujoursLa = dansToujoursLa.has(o.id);
    // « Retirer » quand l'outil survit ailleurs (un outil MCP, un connecteur qui sert à d'autres agents), « Supprimer »
    // quand il disparaît avec ses réglages.
    const detache = o.origin === 'mcp' || o.origin === 'http';
    const message = o.origin === 'mcp'
      ? t(`Retirer « ${o.title} » de cet agent ? Il reste disponible pour vos autres agents.`, `Remove “${o.title}” from this agent? It stays available to your other agents.`)
      : o.origin === 'http'
        ? t(`Retirer « ${o.name} » de cet agent ? Ses réglages seront supprimés s’il ne sert à aucun autre agent.`, `Remove “${o.name}” from this agent? Its settings are deleted if no other agent uses it.`)
        : toujoursLa
          ? t(`Supprimer « ${o.title} » ? Ses réglages seront supprimés ; « Activer » le remettra avec ceux par défaut.`, `Delete “${o.title}”? Its settings will be deleted; “Activate” brings it back with the defaults.`)
          : t(`Retirer « ${o.title} » de cet agent ? L’action et ses réglages seront supprimés.`, `Remove “${o.title}” from this agent? The action and its settings will be deleted.`);
    const titre = detache ? t('Retirer l’outil', 'Remove the tool') : t('Supprimer l’outil', 'Delete the tool');
    if (!(await confirmer({ titre, message, confirmer: detache ? t('Retirer', 'Remove') : t('Supprimer', 'Delete') }))) return;
    await agir(async () => {
      await retirerOutil(tenantId, agentId, o.id);
      if (ouvert === o.id) setOuvert(null);
    });
  };

  const reglages = (o: OutilAgent) => (
    <ReglagesOutil
      outil={o}
      modele={vue?.catalogue.find((m) => m.handler === String(o.binding.handler ?? ''))}
      busy={busy}
      onSave={(patch: PatchReglages) => agir(async () => { await patchOutil(tenantId, agentId, o.id, patch); })}
      onAutonomie={(v) => agir(async () => { await autonomieOutil(tenantId, agentId, o.id, v); })}
    />
  );

  /** Le panneau ouvert sous la ligne d'un outil : le formulaire qui l'a posé, ou ses réglages. */
  const panneau = (o: OutilAgent) => {
    const type = o.origin === 'mba' ? typeDuHandler(String(o.binding.handler ?? '')) : null;
    if (type !== null) {
      return (
        <FormulaireOutilAgent key={o.id} tenantId={tenantId} agentId={agentId} type={type} outil={o}
          modele={vue?.catalogue.find((m) => m.handler === String(o.binding.handler ?? ''))} busy={busy}
          onFini={apresEnregistrement} onAnnuler={() => setOuvert(null)}
          onGestes={(gestes) => agir(async () => { await patchOutil(tenantId, agentId, o.id, { gestes }); })}
          onAutonomie={(v) => agir(async () => { await autonomieOutil(tenantId, agentId, o.id, v); })} />
      );
    }
    if (o.origin === 'http') {
      // Un appel en DELETE est irréversible : sans la case, il était refusé à chaque appel sans geste pour l'autoriser.
      return (
        <div className="flex flex-col gap-3">
          {o.risk === 'irreversible' && (
            <AutonomieOutil id={o.id} coche={o.autonome} busy={busy}
              onChange={(v) => agir(async () => { await autonomieOutil(tenantId, agentId, o.id, v); })} />
          )}
          <ModificationAppel tenantId={tenantId} agentId={agentId} outil={o} onChange={() => apresEnregistrement()} />
        </div>
      );
    }
    return reglages(o);
  };

  const outils = vue?.outils ?? [];
  const catalogue = vue?.catalogue ?? [];
  // Les outils de « Toujours là » : le premier posé de chaque geste. Les autres (et un doublon éventuel) vont à la liste.
  const dansToujoursLa = new Set(
    [...new Set(outils.filter((o) => o.origin === 'mba' && estToujoursLa(String(o.binding.handler ?? ''))).map((o) => String(o.binding.handler)))]
      .map((h) => outils.find((o) => o.origin === 'mba' && String(o.binding.handler ?? '') === h)!.id),
  );
  const liste = outils.filter((o) => !dansToujoursLa.has(o.id));
  // Les outils MCP que le serveur permet d'ajouter (règle unique du 2026-10-02) : montrés sans refiltrer.
  const mcpARattacher = offrables.filter((o) => o.origin === 'mcp');

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t('Un outil n’existe pour l’agent qu’une fois activé ici.', 'A tool only exists for the agent once activated here.')}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="outils-erreur">{erreur}</MbaNotice>}
      {vue === null && erreur === null && <Squelette forme="lignes" />}

      {vue !== null && (
        <ToujoursLa
          outils={outils} catalogue={catalogue} busy={busy} ouvert={ouvert} reglages={reglages}
          onModifier={(o) => setOuvert((v) => (v === o.id ? null : o.id))}
          onRetirer={(o) => { void retirer(o); }}
          onBasculer={(handler, outil, valeur) => agir(async () => {
            // Activer : poser l'outil s'il manque (inactif, comme toujours), PUIS l'activer au nom de qui active.
            const cible = outil ?? await ajouterOutil(tenantId, agentId, handler);
            await activerOutil(tenantId, agentId, cible.id, valeur);
          })}
        />
      )}

      {vue !== null && (
        <section className="flex flex-col gap-3" data-testid="outils-poses">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">{t('Ses outils', 'Its tools')}</h3>
              <p className="text-xs text-ink-500">
                {t('Ce que l’agent peut faire de plus, chaque outil sur ce que vous avez choisi. Un outil naît « Inactif » : activez-le pour que l’agent s’en serve.',
                  'What else the agent can do, each tool on what you picked. A tool starts “Inactive”: activate it for the agent to use it.')}
              </p>
            </div>
            {mode.vue === 'liste' && (
              <Bouton type="button" data-testid="agent-outils-ajouter" disabled={busy} onClick={() => { setOuvert(null); setMode({ vue: 'choix' }); }}>
                <Icone nom="ajouter" />{t('Ajouter un outil', 'Add a tool')}
              </Bouton>
            )}
          </div>

          {mode.vue === 'choix' && (
            <ChoixTypeOutil pour="agent" tenantId={tenantId} onAnnuler={() => setMode({ vue: 'liste' })}
              onChoisir={(type) => setMode(type === 'connecteur' ? { vue: 'connecteur' } : { vue: 'form', type })}
              mcpDisponibles={mcpARattacher.length} onChoisirMcp={() => setMode({ vue: 'mcp' })}
              onChoisirAction={() => setMode({ vue: 'form', type: 'action' })}
              /* La carte n'apparaît que si l'API la connaît : la console part au push, l'API à son déploiement, et une
                 carte servie avant aurait posé un outil que la route refuse (« outil inconnu »). */
              {...(catalogue.some((m) => m.handler === HANDLER_DU_TYPE.enchainement)
                ? { onChoisirEnchainement: () => setMode({ vue: 'form', type: 'enchainement' }) } : {})}
              {...(catalogue.some((m) => m.handler === HANDLER_DU_TYPE.qualification)
                ? { onChoisirQualification: () => setMode({ vue: 'form', type: 'qualification' }) } : {})} />
          )}

          {mode.vue === 'mcp' && (
            <section className="rounded-carte border border-ink-200 bg-white p-4" data-testid="agent-outils-mcp">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-ink-900">{t('Quel outil MCP ajouter ?', 'Which MCP tool to add?')}</p>
                <button type="button" data-testid="agent-outils-mcp-annuler" onClick={() => setMode({ vue: 'liste' })}
                  className="text-xs text-ink-500 hover:underline">{t('Annuler', 'Cancel')}</button>
              </div>
              <p className="mb-3 text-xs text-ink-500">
                {t('Importés dans Tools > Connecteurs MCP et partagés par vos agents. Leurs paramètres se règlent là-bas.',
                  'Imported in Tools > MCP connectors and shared by your agents. Their parameters are set over there.')}
              </p>
              {mcpARattacher.length === 0 ? (
                <p className="text-xs text-ink-500">{t('Aucun outil MCP à ajouter.', 'No MCP tool to add.')}</p>
              ) : (
                <ul data-testid="mcp-a-rattacher" className="divide-y divide-ink-100 rounded-carte border border-ink-200">
                  {mcpARattacher.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-ink-900">
                      <span className="min-w-0 truncate">{o.title} <code className="text-xs text-ink-500">{o.name}</code></span>
                      <Bouton taille="petite" type="button" data-testid={`mcp-rattacher-${o.id}`} disabled={busy}
                        onClick={() => { void agir(async () => { await rattacherOutil(tenantId, agentId, o.id, true); setMode({ vue: 'liste' }); }); }}>
                        <Icone nom="ajouter" />{t('Ajouter', 'Add')}
                      </Bouton>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {mode.vue === 'connecteur' && (
            <ChoixAppel tenantId={tenantId} agentId={agentId} outils={outils}
              onAnnuler={() => setMode({ vue: 'liste' })} onChange={() => apresEnregistrement()} />
          )}

          {mode.vue === 'form' && (
            <FormulaireOutilAgent key={`nouveau-${mode.type}`} tenantId={tenantId} agentId={agentId} type={mode.type} outil={null}
              modele={catalogue.find((m) => m.handler === HANDLER_DU_TYPE[mode.type])}
              busy={busy} onFini={apresEnregistrement} onAnnuler={() => setMode({ vue: 'liste' })}
              onGestes={() => {}} onAutonomie={() => {}} />
          )}

          {liste.length === 0 ? (
            <p data-testid="outils-vide" className="text-sm text-ink-500">
              {t('Aucun autre outil : « Ajouter un outil » propose un tag, une information, un bloc, un scénario, une action, un connecteur API ou un outil MCP.',
                'No other tool: “Add a tool” offers a tag, a detail, a block, a scenario, an action, an API connector or an MCP tool.')}
            </p>
          ) : (
            <ul className="divide-y divide-ink-100 rounded-carte border border-ink-200 bg-white">
              {liste.map((o) => (
                <LigneOutilAgent key={o.id} o={o} cible={libelleCible(o, noms, t)} busy={busy} ouvert={ouvert === o.id}
                  onActiver={(v) => { void agir(async () => { await activerOutil(tenantId, agentId, o.id, v); }); }}
                  onModifier={() => { setMode({ vue: 'liste' }); setOuvert((v) => (v === o.id ? null : o.id)); }}
                  onRetirer={() => { void retirer(o); }}>
                  {panneau(o)}
                </LigneOutilAgent>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
