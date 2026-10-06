'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listUserFields } from '@/lib/api';
import { listRequetes } from '@/lib/api-agent-requetes';
import type { TypeOutilMba } from '@/lib/api-mba-outils';
import { textesDuType, type ConsommateurOutil } from '@/lib/mba-outils';
import { IconeOutil } from '@/components/IconeOutil';
import { useT } from '@/lib/i18n';

/** Les types proposés, dans l'ordre du croquis de Julien (2026-09-21). */
export const TYPES_PROPOSES: readonly TypeOutilMba[] = ['tag', 'champ', 'bloc', 'scenario', 'connecteur'];

/**
 * « QUEL OUTIL AJOUTER ? » (spec 2026-09-21-outils-maison-mba, § 9.4).
 *
 * 🔴 « APPELER UN CONNECTEUR API » EST GRISÉ, PAS CACHÉ, quand l'espace n'a déclaré aucun appel : un client qui
 * débute doit apprendre que ça existe, et où le déclarer (arbitrage du 2026-09-21). Même traitement pour
 * « Enregistrer une information » quand le mini-CRM n'a aucun champ.
 *
 * ⚠️ UNE LECTURE RATÉE N'EST PAS « AUCUN » : elle le dit, et propose de relire, au lieu d'envoyer le client
 * déclarer ce qu'il a déjà.
 */
type Compte = number | null | 'erreur';
export function ChoixTypeOutil({ tenantId, onChoisir, onAnnuler, mcpDisponibles, onChoisirMcp, pour = 'mba' }: {
  tenantId: string; onChoisir: (type: TypeOutilMba) => void; onAnnuler: () => void;
  /** Combien d'outils MCP enregistrés l'agent n'a pas encore. Lu par la liste de l'onglet. */
  mcpDisponibles: number;
  onChoisirMcp: () => void;
  /**
   * Qui reçoit l'outil (RC4) : l'agent de Meta, ou un agent IA, dont l'onglet Outils reprend cette grille. Seuls les
   * MOTS des cartes changent (`textesDuType`) ; les cartes, leur ordre et leurs liens sont les mêmes.
   */
  pour?: ConsommateurOutil;
}) {
  const t = useT();
  const [appels, setAppels] = useState<Compte>(null);
  const [champs, setChamps] = useState<Compte>(null);
  const [essai, setEssai] = useState(0);
  useEffect(() => {
    let vivant = true;
    setAppels(null);
    setChamps(null);
    listRequetes(tenantId)
      .then((r) => { if (vivant) setAppels(Array.isArray(r?.requetes) ? r.requetes.length : 0); })
      .catch(() => { if (vivant) setAppels('erreur'); });
    listUserFields(tenantId)
      .then((r) => { if (vivant) setChamps(Array.isArray(r?.fields) ? r.fields.length : 0); })
      .catch(() => { if (vivant) setChamps('erreur'); });
    return () => { vivant = false; };
  }, [tenantId, essai]);
  const compteDe = (type: TypeOutilMba): Compte | undefined =>
    type === 'connecteur' ? appels : type === 'champ' ? champs : undefined;
  const LIENS: Partial<Record<TypeOutilMba, { href: string; texte: readonly [string, string] }>> = {
    connecteur: { href: '/connecteurs', texte: ['Aucun appel déclaré : Tools > Connecteurs API', 'No call declared: Tools > API connectors'] },
    champ: { href: '/fields', texte: ['Aucun champ déclaré : Contenu > Bibliothèque > Champs', 'No field declared: Content > Library > Fields'] },
  };
  return (
    <section className="rounded-carte border border-ink-200 bg-white p-4" data-testid="mba-types">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-900">{t('Quel outil ajouter ?', 'Which tool to add?')}</p>
        <button type="button" data-testid="mba-types-annuler" onClick={onAnnuler} className="text-xs text-ink-500 hover:underline">
          {t('Annuler', 'Cancel')}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TYPES_PROPOSES.map((type) => {
          const x = textesDuType(type, pour);
          const compte = compteDe(type);
          const indisponible = compte === 0;
          const enAttente = compte === null;
          const illisible = compte === 'erreur';
          const lien = LIENS[type];
          return (
            <div key={type}
              className={`rounded-carte border p-4 ${indisponible ? 'border-ink-100 opacity-60' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50'}`}>
              <button type="button" disabled={indisponible || enAttente || illisible} data-testid={`mba-type-${type}`}
                onClick={() => onChoisir(type)} className="block w-full text-left disabled:cursor-not-allowed">
                {/* ⚠️ L'ICÔNE EST DANS LA MÊME LIGNE QUE LE TITRE, pas au-dessus : c'est la ligne qu'on
                    relit quand on cherche le bon outil, et c'est la même paire qu'on retrouvera dans la
                    liste des outils déployés. */}
                <span className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <IconeOutil signe={x.signe} className="text-ink-400" />
                  <span className="min-w-0 truncate">{t(x.titre[0], x.titre[1])}</span>
                </span>
                <span className="mt-1 block text-xs text-ink-500">{t(x.aide[0], x.aide[1])}</span>
              </button>
              {indisponible && lien && (
                <Link href={lien.href} data-testid={`mba-type-${type}-lien`} className="mt-2 block text-xs text-brand-600 underline">
                  {t(lien.texte[0], lien.texte[1])}
                </Link>
              )}
              {illisible && (
                <button type="button" data-testid={`mba-type-${type}-relire`} onClick={() => setEssai((n) => n + 1)}
                  className="mt-2 block text-xs text-danger underline hover:text-danger-700">
                  {t('Lecture impossible : réessayer', 'Could not read: retry')}
                </button>
              )}
            </div>
          );
        })}
        {/* 🔴 LA SIXIÈME CASE (Julien, 2026-10-02 : « il faut qu'on ait la capacité de rajouter un MCP via une case quand
            tu cliques sur Ajouter un outil »). Elle n'est pas un `TypeOutilMba` : un outil MCP ne se crée pas ici, il
            vient d'un serveur déclaré et enregistré dans Tools > Connecteurs MCP ; la case ouvre la liste de ceux que
            l'agent de Meta n'a pas encore. Grisée avec le lien, comme les autres, quand il n'y en a aucun. */}
        <div className={`rounded-carte border p-4 ${mcpDisponibles === 0 ? 'border-ink-100 opacity-60' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50'}`}>
          <button type="button" disabled={mcpDisponibles === 0} data-testid="mba-type-mcp"
            onClick={onChoisirMcp} className="block w-full text-left disabled:cursor-not-allowed">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <IconeOutil signe="connecteur" className="text-ink-400" />
              <span className="min-w-0 truncate">{t('Appeler un outil MCP', 'Call an MCP tool')}</span>
            </span>
            <span className="mt-1 block text-xs text-ink-500">
              {t('Un outil d’un serveur enregistré dans Connecteurs MCP', 'A tool from a server registered in MCP connectors')}
            </span>
          </button>
          {mcpDisponibles === 0 && (
            <Link href="/connecteurs-mcp" data-testid="mba-type-mcp-lien" className="mt-2 block text-xs text-brand-600 underline">
              {t('Aucun outil MCP à ajouter : Tools > Connecteurs MCP', 'No MCP tool to add: Tools > MCP connectors')}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
