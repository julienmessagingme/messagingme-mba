'use client';

import { useState } from 'react';
import { WorkflowBuilder } from '@/components/WorkflowBuilder';
import { createWorkflow } from '@/lib/api/scenarios';
import { inputCls } from '@/lib/ui';
import type { CanalEtage } from '@/lib/campagne-chaine';
import { Bouton } from '@/components/Bouton';

/**
 * CRÉER UN SCÉNARIO SANS QUITTER SA CAMPAGNE.
 *
 * 🔴 C'EST L'ÉDITEUR DE L'ONGLET SCÉNARIO, MONTÉ AILLEURS. Aucune version allégée, aucun second éditeur :
 * `WorkflowBuilder` n'a besoin que d'un espace, d'un identifiant et d'un graphe de départ, il charge tout
 * le reste lui-même. Un éditeur « simplifié » aurait été un deuxième endroit où corriger chaque règle.
 *
 * 🔴 LE NOM EST DEMANDÉ AVANT, parce que le scénario doit EXISTER avant son graphe : `WorkflowBuilder`
 * enregistre en continu sur un identifiant, il n'a pas de mode « pas encore créé ». C'est aussi ce que fait
 * le parcours normal de l'onglet Scénario.
 *
 * 🔴 ET LA PUBLICATION EST GARDÉE PAR LE CANAL DE L'ÉTAGE (`canalExige`). Un scénario qui n'ouvre pas sur le
 * bon canal fait refuser la campagne ENTIÈRE par Meta, pas un destinataire : le dire au moment de publier
 * évite de construire tout un parcours avant de l'apprendre au récapitulatif.
 *
 * ⚠️ LE BROUILLON DE LA CAMPAGNE SURVIT : on n'a pas quitté la page, la fenêtre se superpose. C'est la
 * raison d'être de ce composant plutôt qu'un lien vers `/workflows`.
 *
 * ⚠️ LES BLOCS E-MAIL NE SONT PAS PROPOSÉS ICI, faute de capacité correspondante dans `CapacitesEspace`
 * (l'assistant sait si l'espace a un agent RCS et l'agent de Meta, pas s'il a un expéditeur e-mail). Ce
 * n'est pas gênant pour l'usage visé : un scénario créé depuis une campagne doit OUVRIR par un modèle ou
 * un message RCS, l'e-mail ne peut de toute façon pas être son premier bloc. L'onglet Scénario, lui, les
 * propose.
 */
export function CreationScenarioEnLigne({
  tenantId,
  canal,
  onCree,
  rcsEnabled = false,
  mbaEnabled = false,
}: {
  tenantId: string;
  /** Le canal de l'étage : ce que le scénario devra savoir ouvrir pour être publiable d'ici. */
  canal: CanalEtage;
  /** Appelé avec l'identifiant du scénario PUBLIÉ, pour que l'étage le sélectionne. */
  onCree: (workflowId: string) => void;
  rcsEnabled?: boolean;
  mbaEnabled?: boolean;
}) {
  const [etape, setEtape] = useState<'ferme' | 'nom' | 'editeur'>('ferme');
  const [nom, setNom] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [cree, setCree] = useState<{ id: string; name: string } | null>(null);

  async function creer(): Promise<void> {
    const propre = nom.trim();
    // Sans nom, on ne crée RIEN : un scénario « sans titre » est introuvable trois jours plus tard dans une
    // liste, et c'est cette liste qui sert à le retrouver.
    if (propre === '' || enCours) return;
    setEnCours(true);
    setErreur(null);
    try {
      const w = await createWorkflow(tenantId, propre);
      setCree({ id: w.id, name: w.name });
      setEtape('editeur');
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Création impossible.');
    } finally {
      setEnCours(false);
    }
  }

  function fermer(): void {
    setEtape('ferme');
    setNom('');
    setCree(null);
    setErreur(null);
  }

  return (
    <>
      <button
        type="button"
        data-testid="creer-scenario"
        onClick={() => { setEtape('nom'); }}
        className="text-xs font-medium text-brand-600 hover:underline"
      >
        {/* ⚠️ LE « ＋ » ALIGNE LES TROIS CRÉATIONS À LA VOLÉE (2026-09-24). Julien a demandé de pouvoir créer
            un scénario depuis une campagne alors que c'était déjà le cas depuis le 2026-09-14 : le bouton
            existait mais ne se voyait pas, entre un menu déroulant et le reste du formulaire. Les deux
            autres portes du même genre (« ＋ Créer un nouveau modèle », « ＋ Créer un nouveau message ») le
            portent déjà, et trois affordances identiques se repèrent mieux qu'une seule isolée. */}
        ＋ Créer un scénario
      </button>

      {etape === 'nom' && (
        <div className="mt-2 space-y-2 rounded-lg border border-ink-200 bg-ink-50 p-3" data-testid="creer-scenario-nom">
          <label className="block text-xs font-medium text-ink-900" htmlFor="nouveau-scenario">
            Nom du scénario
          </label>
          <input
            id="nouveau-scenario"
            data-testid="creer-scenario-champ"
            className={inputCls}
            value={nom}
            onChange={(e) => setNom(e.target.value)}
            placeholder="Relance panier abandonné"
          />
          <div className="flex gap-2">
            <Bouton taille="petite" enCours={enCours}
              type="button"
              data-testid="creer-scenario-valider"
              onClick={() => { void creer(); }}
              disabled={nom.trim() === '' || enCours}
            >
              {enCours ? 'Création…' : 'Ouvrir l’éditeur'}
            </Bouton>
            <Bouton variante="secondaire" taille="petite" type="button" onClick={fermer}>
              Annuler
            </Bouton>
          </div>
          {erreur !== null && <p className="text-xs text-danger-700" data-testid="creer-scenario-erreur">{erreur}</p>}
        </div>
      )}

      {etape === 'editeur' && cree !== null && (
        /**
         * ⚠️ ENVIRON TROIS QUARTS DE L'ÉCRAN, et des bornes en `min()` plutôt qu'une taille fixe : l'éditeur
         * doit respirer en 13 pouces, où la fenêtre de la campagne est déjà étroite.
         */
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" data-testid="fenetre-scenario">
          <div className="flex h-[min(85vh,48rem)] w-[min(92vw,80rem)] flex-col overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-mm-lg">
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
              <span className="truncate text-sm font-semibold text-ink-900">{cree.name}</span>
              <button
                type="button"
                onClick={fermer}
                data-testid="fenetre-scenario-fermer"
                aria-label="Fermer"
                className="text-ink-400 hover:text-ink-900"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <WorkflowBuilder
                tenantId={tenantId}
                workflowId={cree.id}
                initialGraph={{ nodes: [], edges: [] }}
                mbaEnabled={mbaEnabled}
                rcsEnabled={rcsEnabled}
                /**
                 * 🔴 UN ÉTAGE E-MAIL N'A PAS DE SCÉNARIO (aucun canal d'ouverture n'est l'e-mail), donc ce
                 * composant n'y est jamais monté. La conversion est là pour que le type reste honnête plutôt
                 * que pour couvrir un cas atteignable.
                 */
                canalExige={canal === 'email' ? 'whatsapp' : canal}
                onPublie={() => {
                  onCree(cree.id);
                  fermer();
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
