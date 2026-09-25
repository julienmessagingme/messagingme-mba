'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { useT } from '@/lib/i18n';
import { OUTILS_MCP } from '@/lib/mcp-outils';
import { listApiKeys } from '@/lib/api';
import { BASE } from '@/lib/http';
import type { Session } from '@/lib/session';

/**
 * L'espace a-t-il une clé UTILISABLE pour MCP ?
 *
 * `null` = on ne sait pas encore, ou la liste n'a pas pu être lue. Les deux se traitent pareil, et c'est
 * volontaire : une vérification qui échoue ne doit surtout pas afficher « vous n'avez aucune clé », qui
 * enverrait quelqu'un en créer une seconde alors qu'il en a déjà une. Ne rien dire vaut mieux que dire faux.
 */
type EtatCle = null | 'aucune' | 'ok';

/**
 * L'écran d'où un intégrateur part : l'adresse du serveur MCP, la commande à copier, ce que chaque outil
 * fait, et ce que le serveur ne fait volontairement PAS.
 *
 * Le catalogue vient de `lib/mcp-outils.ts` et non d'un appel réseau : ce n'est pas un état du client,
 * c'est une documentation, et la lire exigerait déjà une clé, que cette page sert justement à créer. Un
 * test du serveur (`tests/mcp-doc-parite.test.ts`) garde cette liste alignée sur le catalogue réel, sinon
 * elle promettrait un jour un outil retiré, ou tairait un outil ajouté.
 *
 * 🔴 ELLE EST PUBLIQUE (décision de Julien du 2026-09-25), comme la documentation de l'API, et elle en prend le
 * cadre (`CadreDoc`, refonte du 2026-09-25) : qui peut ouvrir cet écran de la console l'a dans la console, tout
 * autre visiteur la lit dans `CadrePublic`. Sans session, la vérification des clés ne tourne pas : elle lit une
 * donnée d'espace, et il n'y a pas d'espace. Son adresse est publiée sur la vitrine : elle ne bouge pas.
 */
export default function McpPage() {
  return <CadreDoc page="mcp">{(session) => <McpInner session={session} />}</CadreDoc>;
}

const CARTE = 'rounded-2xl border border-ink-200 bg-white p-5 shadow-sm';

function McpInner({ session }: { session: Session | null }) {
  const t = useT();
  const [copie, setCopie] = useState(false);
  const [etatCle, setEtatCle] = useState<EtatCle>(null);
  const tenantId = session?.tenantId;

  // La commande affichée ne peut pas marcher sans une clé portant un droit `mcp:*`. La copier puis se
  // heurter à un 401 est un aller-retour de support garanti, alors que la réponse tient en une phrase.
  // Sans espace (lecture publique), on se tait : cf. EtatCle.
  useEffect(() => {
    if (!tenantId) return;
    let vivant = true;
    listApiKeys(tenantId)
      .then(({ keys }) => {
        if (!vivant) return;
        // Une clé RÉVOQUÉE reste dans la liste : elle ne compte pas. Sans ce filtre, l'avertissement se
        // tairait pour un espace dont la seule clé MCP vient justement d'être coupée.
        const utilisable = keys.some((k) => k.revokedAt === null && k.scopes.some((s) => s.startsWith('mcp:')));
        setEtatCle(utilisable ? 'ok' : 'aucune');
      })
      .catch(() => { /* on ne sait pas : on se tait, cf. EtatCle */ });
    return () => { vivant = false; };
  }, [tenantId]);
  // 🔴 L'ADRESSE EST CELLE DE L'API PUBLIQUE (`BASE`, la même source que la documentation de l'API), parce
  // que c'est l'API qui sert `/mcp`, pas la console. Elle suivait le domaine de la console : sur la console
  // hébergée chez Vercel, `/mcp` rend 404 (mesuré le 2026-09-25, quand `api.` et `mba.` rendent 401), donc
  // la commande copiée depuis `engageme.` était morte. Repli sur le domaine de la page quand `BASE` est
  // relative : l'ancienne console du VPS, dont le proxy sert `/mcp`, et le serveur local des tests.
  const origine = BASE.startsWith('http') ? BASE : typeof window !== 'undefined' ? window.location.origin : 'https://mba.messagingme.app';
  const commande = `claude mcp add --transport http mba ${origine}/mcp --header "Authorization: Bearer VOTRE_CLE"`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">{t('Serveur MCP', 'MCP server')}</h1>
        <p className="text-sm text-ink-500">
          {t(
            'Branche un assistant (Claude, ou tout client compatible MCP) sur cet espace, sans développer d’intégration.',
            'Connect an assistant (Claude, or any MCP-compatible client) to this workspace, with no integration to build.',
          )}
        </p>
      </div>

      <div className={CARTE}>
        <h2 className="text-sm font-semibold tracking-tight text-ink-900">{t('Adresse', 'Endpoint')}</h2>
        <p className="mt-1 font-mono text-sm text-ink-800" data-testid="mcp-adresse">{origine}/mcp</p>
        <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-ink-400">{t('Commande à copier', 'Command to copy')}</h3>
        <div className="mt-1 flex items-start gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-ink-50 px-3 py-2 font-mono text-xs text-ink-800">{commande}</code>
          <button
            type="button"
            data-testid="mcp-copier"
            onClick={() => {
              // Échec silencieux : sans permission presse-papier, la commande reste sélectionnable à la main.
              void navigator.clipboard?.writeText(commande).then(() => { setCopie(true); setTimeout(() => setCopie(false), 2000); }).catch(() => {});
            }}
            className="shrink-0 rounded-lg border border-ink-200 px-3 py-2 text-xs font-semibold text-ink-600 transition hover:bg-ink-50"
          >
            {copie ? t('Copié', 'Copied') : t('Copier', 'Copy')}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-400">
          {t('Remplace VOTRE_CLE par une clé d’API portant un droit MCP.', 'Replace VOTRE_CLE with an API key holding an MCP scope.')}{' '}
          <Link href="/developers/keys" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
            {t('Créer une clé', 'Create a key')}
          </Link>
        </p>

        {/* L'avertissement ne s'affiche QUE sur une certitude (`aucune`). Tant qu'on ne sait pas, ou si la
            liste n'a pas pu être lue, on se tait : annoncer « aucune clé » à quelqu'un qui en a une l'enverrait
            en créer une seconde, et ce serait notre faute. */}
        {etatCle === 'aucune' && (
          <div data-testid="mcp-sans-cle" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {t(
              'Cet espace n’a aucune clé d’API portant un droit MCP : la commande ci-dessus sera refusée telle quelle.',
              'This workspace has no API key with an MCP scope: the command above will be rejected as is.',
            )}{' '}
            <Link href="/developers/keys" className="font-semibold underline underline-offset-2">
              {t('Créer une clé avec « MCP : lire »', 'Create a key with "MCP: read"')}
            </Link>
          </div>
        )}
      </div>

      <div className={CARTE}>
        <h2 className="text-sm font-semibold tracking-tight text-ink-900">{t('Ce que l’assistant peut faire', 'What the assistant can do')}</h2>
        <p className="mt-0.5 text-xs text-ink-400">
          {t(
            'Chaque outil dépend du droit porté par la clé : une clé « lecture » ne voit même pas les outils qui écrivent.',
            'Each tool depends on the key’s scope: a read-only key does not even see the tools that write.',
          )}
        </p>
        {/* Les noms d'outils, en police fixe, ne se coupent pas : sur mobile, le tableau défile dans son cadre
            plutôt que de faire déborder la page entière (vu par l'e2e de la CI, 16 px). */}
        <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-ink-100 text-ink-400">
              <th className="px-2 py-2 font-medium">{t('Outil', 'Tool')}</th>
              <th className="px-2 py-2 font-medium">{t('Droit', 'Scope')}</th>
              <th className="px-2 py-2 font-medium">{t('Ce qu’il fait', 'What it does')}</th>
            </tr>
          </thead>
          <tbody>
            {OUTILS_MCP.map((o) => (
              <tr key={o.nom} className="border-b border-ink-50">
                <td className="px-2 py-2 font-mono text-ink-800">{o.nom}</td>
                <td className="px-2 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${o.scope === 'mcp:write' ? 'bg-violet/10 text-violet' : 'bg-ink-100 text-ink-600'}`}>{o.scope}</span>
                </td>
                <td className="px-2 py-2 text-ink-600">{t(...o.quoi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className={CARTE}>
        <h2 className="text-sm font-semibold tracking-tight text-ink-900">{t('Ce qu’il ne fait pas', 'What it does not do')}</h2>
        <ul className="mt-2 space-y-2 text-sm text-ink-600">
          <li>
            <strong className="text-ink-800">{t('Pas d’envoi de template, pas de campagne.', 'No template sending, no campaigns.')}</strong>{' '}
            {t(
              'Un assistant peut répondre dans une conversation ouverte, pas lancer un envoi de masse. C’est délibéré : votre numéro est noté par Meta.',
              'An assistant can reply inside an open conversation, not launch a mass send. This is deliberate: Meta rates your number.',
            )}
          </li>
          <li>
            <strong className="text-ink-800">{t('Hors de la fenêtre de 24 h, rien ne part.', 'Outside the 24 h window, nothing is sent.')}</strong>{' '}
            {t(
              'Si le contact n’a pas écrit récemment, WhatsApp interdit le message libre et l’outil refuse, avec la raison.',
              'If the contact has not written recently, WhatsApp forbids free-form messages and the tool refuses, with the reason.',
            )}
          </li>
          <li>
            <strong className="text-ink-800">{t('Les automations ne se déclenchent pas.', 'Automations are not triggered.')}</strong>{' '}
            {t(
              'Un tag posé par un assistant classe le contact ; il ne réveille pas les automations qui écoutent ce tag.',
              'A tag set by an assistant classifies the contact; it does not wake the automations listening for that tag.',
            )}
          </li>
          <li>
            <strong className="text-ink-800">{t('L’accès passe par une clé, pas par un compte.', 'Access goes through a key, not an account.')}</strong>{' '}
            {t(
              'La clé porte l’espace et les droits. Pour couper un assistant, révoquez sa clé dans « Clés d’API ».',
              'The key carries the workspace and the scopes. To cut an assistant off, revoke its key under "API keys".',
            )}
          </li>
        </ul>
      </div>
    </div>
  );
}
