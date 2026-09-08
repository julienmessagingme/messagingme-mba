'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { cardCls, inputCls, inputClsAuto } from '@/lib/ui';
import { formatDate } from '@/lib/day';
import { JOURS_AVANT_ALERTE, MAX_CORPS_FICHE, MAX_TITRE_FICHE, joursDepuis, sourcePerimee } from '@/lib/agent-connaissance';
import { MbaNotice } from '@/components/MbaNotice';
import {
  apercuImport, createFiche, deleteFiche, importerSource, listFiches, patchFiche,
  type ApercuImport, type FicheConnaissance,
} from '@/lib/api-agent-knowledge';

/**
 * L'onglet BASE DE CONNAISSANCE d'un agent IA.
 *
 * 🔴 CE QUE CET ÉCRAN PILOTE VRAIMENT. Ces fiches ne sont pas de la documentation : elles sont la SEULE
 * source que l'agent a le droit d'utiliser. Le mécanisme anti-hallucination est un seuil dans notre code, pas
 * une consigne au modèle : si aucune fiche ne couvre la question, l'agent ne devine pas, il sort du bloc par
 * « Aucune source ». Une base vide ne fait donc pas un agent bavard mais un agent qui transfère tout, et
 * l'écran doit le dire, sans quoi le client cherchera l'erreur dans ses réglages.
 *
 * Le reste de l'écran suit le patron des panneaux MBA : enregistrement à la SORTIE du champ, erreurs
 * annoncées dans un bandeau, aucune boîte de dialogue maison.
 */
export function AgentConnaissance({ tenantId, agentId }: { tenantId: string; agentId: string }) {
  const t = useT();
  const [fiches, setFiches] = useState<FicheConnaissance[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [bilan, setBilan] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      setFiches(await listFiches(tenantId, agentId));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    }
  }, [tenantId, agentId, t]);
  useEffect(() => { void charger(); }, [charger]);

  /** Enveloppe commune : un seul geste à la fois, l'erreur est ANNONCÉE, la liste est relue après coup. */
  async function agir(travail: () => Promise<string | null>) {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    setBilan(null);
    try {
      setBilan(await travail());
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Opération impossible', 'Operation failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t(
          'L’agent ne répond QUE d’après ces fiches. Sur une question qu’aucune ne couvre, il n’invente pas : il sort du bloc par « Aucune source ». Une base vide fait donc un agent qui transfère tout.',
          'The agent only answers from these entries. On a question none of them covers, it does not make things up: it leaves the block through “No source”. So an empty base makes an agent that hands everything over.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="kb-erreur">{erreur}</MbaNotice>}
      {bilan && <MbaNotice kind="success" testid="kb-bilan">{bilan}</MbaNotice>}

      <ImportSource
        tenantId={tenantId}
        agentId={agentId}
        busy={busy}
        onErreur={setErreur}
        onImport={(url, pages) => agir(async () => {
        const r = await importerSource(tenantId, agentId, url, pages);
        const ecrites = r.retirees > 0
          ? t(
            `${r.ecrites} fiche(s) écrite(s), ${r.retirees} remplacée(s) pour cette adresse.`,
            `${r.ecrites} entry(ies) written, ${r.retirees} replaced for this address.`,
          )
          : t(`${r.ecrites} fiche(s) écrite(s).`, `${r.ecrites} entry(ies) written.`);
        // Le plafond est DIT quand il mord : une page tronquée en silence laisserait croire que tout son
        // contenu est devenu une source, et l'agent transférerait sur des questions que la page couvrait.
        return r.ecrites >= r.plafond
          ? `${ecrites} ${t(
            `Le plafond de ${r.plafond} fiches par page est atteint : la suite de la page n’a PAS été lue. Découpez-la, ou complétez à la main.`,
            `The cap of ${r.plafond} entries per page was reached: the rest of the page was NOT read. Split it, or fill in by hand.`,
          )}`
          : ecrites;
      })} />

      <AjoutManuel busy={busy} onAdd={(titre, corps) => agir(async () => {
        await createFiche(tenantId, agentId, { titre, corps });
        return null;
      })} />

      <div className="flex flex-col gap-3">
        {fiches === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}
        {fiches?.length === 0 && (
          <p data-testid="kb-vide" className="text-sm text-ink-500">
            {t('Aucune fiche. Lisez une page de votre site, ou écrivez la première à la main.', 'No entry yet. Read a page of your site, or write the first one by hand.')}
          </p>
        )}
        {(fiches ?? []).map((f) => (
          <Fiche
            key={f.id}
            fiche={f}
            busy={busy}
            onSave={(patch) => agir(async () => { await patchFiche(tenantId, agentId, f.id, patch); return null; })}
            onDelete={() => agir(async () => { await deleteFiche(tenantId, agentId, f.id); return null; })}
          />
        ))}
      </div>
    </div>
  );
}

/** Lecture d'une page du site du client. Le prix de la relecture est DIT avant le clic, pas après. */
function ImportSource({ tenantId, agentId, busy, onImport, onErreur }: {
  tenantId: string; agentId: string; busy: boolean;
  onImport: (url: string, pages: string[]) => void;
  onErreur: (message: string) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [apercu, setApercu] = useState<ApercuImport | null>(null);
  const [occupe, setOccupe] = useState(false);
  const propre = url.trim();

  async function voir(): Promise<void> {
    if (propre === '') return;
    setOccupe(true);
    setApercu(null);
    try {
      setApercu(await apercuImport(tenantId, agentId, propre));
    } catch (e) {
      onErreur(e instanceof Error ? e.message : t('Lecture impossible', 'Read failed'));
    } finally {
      setOccupe(false);
    }
  }
  return (
    <div className={`${cardCls} flex flex-col gap-3`}>
      <div>
        <p className="text-sm font-medium text-ink-700">{t('Lire une page de votre site', 'Read a page of your site')}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          {t(
            'On lit la page une fois et on en fait des fiches, découpées sur ses titres. L’agent ne relit pas votre site à chaque question : c’est plus rapide, moins cher, et surtout vous pouvez corriger une mauvaise réponse ici même.',
            'We read the page once and turn it into entries, split on its headings. The agent does not re-read your site on every question: it is faster, cheaper, and above all you can fix a bad answer right here.',
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          data-testid="kb-url"
          className={`${inputCls} max-w-md`}
          value={url}
          disabled={busy || occupe}
          onChange={(e) => { setUrl(e.target.value); setApercu(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && propre !== '') void voir(); }}
          placeholder="https://votre-site.fr/tarifs"
        />
        <button
          data-testid="kb-importer"
          disabled={busy || occupe || propre === ''}
          onClick={() => void voir()}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
        >
          {occupe ? t('Lecture…', 'Reading…') : t('Voir ce qui sera importé', 'See what will be imported')}
        </button>
      </div>

      {/* 🔴 L'APERÇU N'ÉCRIT RIEN, et c'est tout son intérêt. Cinquante pages écrites d'un coup, ce sont
          cinquante jeux de fiches à relire ou supprimer une par une si la portée était mauvaise. */}
      {apercu !== null && (
        <div className="rounded-xl border border-ink-200 p-3" data-testid="kb-apercu">
          <p className="text-sm font-medium text-ink-700">
            {apercu.portee === 'page'
              ? t('Cette page seule', 'This page only')
              : t(`Ce site : ${apercu.pages.length} page(s) lisible(s)`, `This site: ${apercu.pages.length} readable page(s)`)}
          </p>
          {/* ⚠️ Le plafond est DIT quand il mord : « 50 pages » n'est pas « tout le site », et le taire
              laisserait croire à une base complète alors qu'il en manque la moitié. */}
          {apercu.plafondAtteint && (
            <p className="mt-1 text-xs text-amber-800" data-testid="kb-apercu-plafond">
              {t(
                'Le plafond de pages est atteint : il en manque. Importez d’abord celles-ci, puis donnez une adresse plus précise pour le reste.',
                'The page cap was reached: some are missing. Import these first, then give a more precise address for the rest.',
              )}
            </p>
          )}
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs">
            {apercu.pages.map((p) => (
              <li key={p.url} className="flex justify-between gap-3">
                <span className="truncate text-ink-600">{p.url}</span>
                <span className="shrink-0 tabular-nums text-ink-400">
                  {t(`${p.fiches} fiche(s), ${p.caracteres} car.`, `${p.fiches} entry(ies), ${p.caracteres} chars`)}
                </span>
              </li>
            ))}
          </ul>
          {apercu.ecartees.length > 0 && (
            <p className="mt-2 text-xs text-ink-400" data-testid="kb-apercu-ecartees">
              {t(`${apercu.ecartees.length} adresse(s) écartée(s) : `, `${apercu.ecartees.length} address(es) skipped: `)}
              {apercu.ecartees.slice(0, 3).map((e) => e.raison).join(', ')}
            </p>
          )}
          <button
            data-testid="kb-confirmer"
            disabled={busy || apercu.pages.length === 0}
            onClick={() => { onImport(apercu.url, apercu.pages.map((p) => p.url)); setApercu(null); setUrl(''); }}
            className="mt-3 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {t(`Importer ces ${apercu.pages.length} page(s)`, `Import these ${apercu.pages.length} page(s)`)}
          </button>
        </div>
      )}
      <p className="text-xs leading-relaxed text-amber-800">
        {t(
          'Relire la même adresse REMPLACE les fiches qu’elle avait déjà produites : vos corrections sur celles-là seront perdues. Les fiches venues d’ailleurs, et celles que vous avez écrites à la main, ne bougent pas.',
          'Re-reading the same address REPLACES the entries it had already produced: your fixes on those will be lost. Entries from other sources, and the ones you wrote by hand, are untouched.',
        )}
      </p>
    </div>
  );
}

/** Une fiche écrite à la main : le chemin le plus court quand le client n'a pas de page pour ça. */
function AjoutManuel({ busy, onAdd }: { busy: boolean; onAdd: (titre: string, corps: string) => void }) {
  const t = useT();
  const [titre, setTitre] = useState('');
  const [corps, setCorps] = useState('');
  const pret = !busy && titre.trim() !== '' && corps.trim() !== '';
  return (
    <div className={`${cardCls} flex flex-col gap-2`}>
      <p className="text-sm font-medium text-ink-700">{t('Écrire une fiche à la main', 'Write an entry by hand')}</p>
      <input
        data-testid="kb-nouveau-titre"
        maxLength={MAX_TITRE_FICHE}
        className={inputCls}
        value={titre}
        disabled={busy}
        onChange={(e) => setTitre(e.target.value)}
        placeholder={t('La question ou le sujet, par exemple « Les horaires de la piscine »', 'The question or topic, e.g. “Pool opening hours”')}
      />
      <textarea
        data-testid="kb-nouveau-corps"
        rows={3}
        maxLength={MAX_CORPS_FICHE}
        className={inputCls}
        value={corps}
        disabled={busy}
        onChange={(e) => setCorps(e.target.value)}
        placeholder={t('La réponse, telle que vous voudriez la lire.', 'The answer, as you would want to read it.')}
      />
      <div>
        <button
          data-testid="kb-ajouter"
          disabled={!pret}
          onClick={() => { onAdd(titre.trim(), corps.trim()); setTitre(''); setCorps(''); }}
          className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
        >
          {t('Ajouter la fiche', 'Add entry')}
        </button>
      </div>
    </div>
  );
}

/** Une fiche, éditable sur place. Enregistrement à la sortie du champ, comme le reste de l'écran. */
function Fiche({ fiche, busy, onSave, onDelete }: {
  fiche: FicheConnaissance;
  busy: boolean;
  onSave: (patch: { titre?: string; corps?: string }) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [titre, setTitre] = useState(fiche.titre);
  const [corps, setCorps] = useState(fiche.corps);
  useEffect(() => { setTitre(fiche.titre); }, [fiche.titre]);
  useEffect(() => { setCorps(fiche.corps); }, [fiche.corps]);

  return (
    <div data-testid={`kb-fiche-${fiche.id}`} className={`${cardCls} flex flex-col gap-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid={`kb-titre-${fiche.id}`}
          maxLength={MAX_TITRE_FICHE}
          className={`${inputClsAuto} flex-1 font-medium`}
          value={titre}
          disabled={busy}
          onChange={(e) => setTitre(e.target.value)}
          onBlur={() => { if (titre.trim() !== '' && titre !== fiche.titre) onSave({ titre }); }}
        />
        <button
          data-testid={`kb-supprimer-${fiche.id}`}
          disabled={busy}
          onClick={onDelete}
          title={t('Supprimer cette fiche', 'Delete this entry')}
          className="shrink-0 rounded px-2 py-1 text-sm text-coral hover:bg-red-50 disabled:opacity-40"
        >
          ✕
        </button>
      </div>
      <textarea
        data-testid={`kb-corps-${fiche.id}`}
        rows={4}
        maxLength={MAX_CORPS_FICHE}
        className={inputCls}
        value={corps}
        disabled={busy}
        onChange={(e) => setCorps(e.target.value)}
        onBlur={() => { if (corps.trim() !== '' && corps !== fiche.corps) onSave({ corps }); }}
      />
      <Provenance fiche={fiche} />
    </div>
  );
}

/** D'où vient la fiche, et depuis quand. C'est la parade au contenu périmé : elle ne sert à rien si on ne la
 *  regarde pas, donc elle est sous CHAQUE fiche, pas dans un écran de réglage. */
function Provenance({ fiche }: { fiche: FicheConnaissance }) {
  const t = useT();
  const { locale } = useLocale();
  // `Date.now()` au rendu et non au module : une console laissée ouverte une nuit ne doit pas garder l'âge
  // de la veille. `useMemo` sur la fiche pour ne pas recalculer à chaque frappe dans le champ voisin.
  const jours = useMemo(() => joursDepuis(fiche.derniereLectureAt, Date.now()), [fiche.derniereLectureAt]);
  // L'ALERTE se calcule sur `updatedAt`, la DATE AFFICHÉE sur la lecture de la source. Les deux disent des
  // choses différentes : « lue le 3 janvier » est la provenance, et corriger une fiche à la main est bien une
  // vérification humaine. Sans cette distinction, l'écran continuerait de réclamer une relecture d'une fiche
  // que quelqu'un vient de relire, et l'avertissement finirait par ne plus rien vouloir dire.
  const perimee = useMemo(() => sourcePerimee(fiche.updatedAt, Date.now()), [fiche.updatedAt]);

  if (fiche.sourceUrl === null) {
    return <p className="text-xs text-ink-500">{t('Écrite à la main.', 'Written by hand.')}</p>;
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
      <span className="truncate">{t('Lue sur', 'Read from')} <span className="font-mono">{fiche.sourceUrl}</span></span>
      {fiche.derniereLectureAt && (
        <span data-testid={`kb-lue-${fiche.id}`}>
          {t('le', 'on')} {formatDate(fiche.derniereLectureAt, locale, { day: 'numeric', month: 'long', year: 'numeric' })}
          {jours !== null && ` (${jours} ${t('jours', 'days')})`}
        </span>
      )}
      {perimee && (
        <span data-testid={`kb-perimee-${fiche.id}`} className="rounded-full bg-gold/20 px-2 py-0.5 font-medium text-ink-800">
          {t(`À relire : plus de ${JOURS_AVANT_ALERTE} jours`, `Worth re-reading: over ${JOURS_AVANT_ALERTE} days`)}
        </span>
      )}
    </p>
  );
}
