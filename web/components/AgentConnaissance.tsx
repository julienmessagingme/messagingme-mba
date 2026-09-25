'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { cardCls, inputCls, inputClsAuto } from '@/lib/ui';
import { formatDate } from '@/lib/day';
import { JOURS_AVANT_ALERTE, MAX_CORPS_FICHE, MAX_TITRE_FICHE, joursDepuis, sourcePerimee } from '@/lib/agent-connaissance';
import { MbaNotice } from '@/components/MbaNotice';
import {
  apercuImport, createFiche, deleteFiche, importerDocument, importerSource, listFiches, patchFiche,
  supprimerFiches,
  type ApercuImport, type FicheConnaissance,
} from '@/lib/api-agent-knowledge';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';

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
/**
 * ⚠️ `onChange` pour la MÊME raison que `AgentOutils` : deux des trois avertissements de la page se
 * calculent sur le nombre de fiches (« la base est vide », et « la base est remplie mais l'outil de
 * recherche n'est pas actif »). Sans ce rappel, remplir la base laisse « la base est vide » à l'écran.
 */
export function AgentConnaissance({ tenantId, agentId, onChange, urlSuggeree }: {
  tenantId: string; agentId: string; onChange?: () => void;
  /** L'adresse que le client a donnée à l'assistant de construction. `null` quand il n'en a donné aucune. */
  urlSuggeree?: string | null;
}) {
  const t = useT();
  const [fiches, setFiches] = useState<FicheConnaissance[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  /** Les fiches cochées, pour la suppression en masse. Vidée après chaque action : une sélection qui survit
   *  à une suppression désigne des fiches qui n'existent plus. */
  const [coches, setCoches] = useState<Set<string>>(new Set());
  /** La fiche dépliée, s'il y en a une. Une seule à la fois : c'est un tableau qu'on parcourt, pas un
   *  formulaire géant. */
  const [ouverte, setOuverte] = useState<string | null>(null);
  const [bilan, setBilan] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      setFiches(await listFiches(tenantId, agentId));
    } catch (err) {
      setErreur(erreurDeChargement(err, t));
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
      // Le bandeau de la page se calcule sur CE nombre de fiches : sans ce rappel, il annonce l'état d'avant.
      onChange?.();
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
          'L’agent ne répond que d’après ces fiches. Sur une question qu’aucune ne couvre, il sort du bloc par « Aucune source » : une base vide fait donc un agent qui transfère tout.',
          'The agent only answers from these entries. On a question none of them covers, it leaves the block through “No source”: an empty base makes an agent that hands everything over.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="kb-erreur">{erreur}</MbaNotice>}
      {bilan && <MbaNotice kind="success" testid="kb-bilan">{bilan}</MbaNotice>}

      <ImportSource
        tenantId={tenantId}
        agentId={agentId}
        busy={busy}
        onErreur={setErreur}
        urlSuggeree={urlSuggeree}
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
            `Le plafond de ${r.plafond} fiches par page est atteint : la suite de la page n’a pas été lue. Découpez-la, ou complétez à la main.`,
            `The cap of ${r.plafond} entries per page was reached: the rest of the page was not read. Split it, or fill in by hand.`,
          )}`
          : ecrites;
      })} />

      <ImportDocument busy={busy} onDeposer={(nom, dataUrl) => agir(async () => {
        const r = await importerDocument(tenantId, agentId, nom, dataUrl);
        return r.retirees > 0
          ? t(
            `${r.ecrites} fiche(s) écrite(s) depuis « ${r.nom} », ${r.retirees} remplacée(s).`,
            `${r.ecrites} entry(ies) written from “${r.nom}”, ${r.retirees} replaced.`,
          )
          : t(`${r.ecrites} fiche(s) écrite(s) depuis « ${r.nom} ».`, `${r.ecrites} entry(ies) written from “${r.nom}”.`);
      })} />

      <AjoutManuel busy={busy} onAdd={(titre, corps) => agir(async () => {
        await createFiche(tenantId, agentId, { titre, corps });
        return null;
      })} />

      <div className="flex flex-col gap-3">
        {fiches === null && <Squelette forme="lignes" />}
        {fiches?.length === 0 && (
          <p data-testid="kb-vide" className="text-sm text-ink-500">
            {t('Aucune fiche : lisez une page de votre site, ou écrivez la première à la main.', 'No entry yet: read a page of your site, or write the first one by hand.')}
          </p>
        )}

        {/* 🔴 UN TABLEAU, PAS UNE PILE DE CARTES. À dix fiches une liste dépliée se lit ; à cinquante, venues
            d'un site entier ou d'un PDF de quarante pages, elle devient un mur qu'on ne relit jamais. On voit
            donc TOUT d'un coup d'œil (titre, provenance, taille), on ouvre ce qu'on veut corriger, et on peut
            en cocher plusieurs pour les retirer d'un geste. */}
        {fiches !== null && fiches.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink-500">
                <input
                  type="checkbox"
                  data-testid="kb-tout-cocher"
                  checked={coches.size === fiches.length && fiches.length > 0}
                  onChange={(e) => setCoches(e.target.checked ? new Set(fiches.map((f) => f.id)) : new Set())}
                />
                {t(`${fiches.length} fiche(s)`, `${fiches.length} entry(ies)`)}
              </label>
              {coches.size > 0 && (
                <button
                  data-testid="kb-supprimer-selection"
                  disabled={busy}
                  onClick={() => agir(async () => {
                    const r = await supprimerFiches(tenantId, agentId, [...coches]);
                    setCoches(new Set());
                    // Le compte RÉEL, pas celui de la demande : une fiche déjà retirée par un collègue ne
                    // doit pas être annoncée comme supprimée par ce clic.
                    return t(`${r.supprimees} fiche(s) supprimée(s).`, `${r.supprimees} entry(ies) deleted.`);
                  })}
                  className="rounded-controle bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {t(`Supprimer les ${coches.size} fiches cochées`, `Delete the ${coches.size} selected entries`)}
                </button>
              )}
            </div>

            <div className="overflow-x-auto rounded-carte border border-ink-200">
              <table className="w-full text-sm" data-testid="kb-tableau">
                <thead className="bg-ink-50 text-left text-xs text-ink-500">
                  <tr>
                    <th className="w-8 p-2" />
                    <th className="p-2 font-medium">{t('Fiche', 'Entry')}</th>
                    <th className="p-2 font-medium">{t('Provenance', 'Source')}</th>
                    <th className="w-20 p-2 text-right font-medium">{t('Taille', 'Size')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {fiches.map((f) => (
                    <LigneFiche
                      key={f.id}
                      fiche={f}
                      busy={busy}
                      coche={coches.has(f.id)}
                      ouverte={ouverte === f.id}
                      onCocher={(v) => setCoches((s2) => {
                        const n = new Set(s2);
                        if (v) n.add(f.id); else n.delete(f.id);
                        return n;
                      })}
                      onOuvrir={() => setOuverte((o) => (o === f.id ? null : f.id))}
                      onSave={(patch) => agir(async () => { await patchFiche(tenantId, agentId, f.id, patch); return null; })}
                      onDelete={() => agir(async () => { await deleteFiche(tenantId, agentId, f.id); return null; })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Lecture d'une page du site du client. Le prix de la relecture est DIT avant le clic, pas après. */
function ImportSource({ tenantId, agentId, busy, onImport, onErreur, urlSuggeree }: {
  tenantId: string; agentId: string; busy: boolean;
  onImport: (url: string, pages: string[]) => void;
  onErreur: (message: string) => void;
  /** L'adresse que le client a donnée à l'assistant de construction, ou `null`. */
  urlSuggeree?: string | null;
}) {
  const t = useT();
  const [url, setUrl] = useState('');
  /**
   * 🔴 L'ADRESSE DONNÉE À L'ASSISTANT ARRIVE ICI, ET C'EST TOUT LE CORRECTIF DU 2026-09-18. L'entretien
   * demandait « d'où viennent ses réponses de fond », insistait pour obtenir l'adresse EXACTE, et cette
   * réponse n'allait nulle part : cet écran restait vide et il fallait la recoller à la main. Julien :
   * « le bot m'a demandé l'adresse du site web mais je ne retrouve rien dans l'onglet base de connaissance ».
   *
   * ⚠️ UN EFFET, PAS UNE VALEUR INITIALE : la suggestion arrive d'un appel réseau, donc APRÈS le premier
   * rendu, et un `useState(urlSuggeree)` la manquerait une fois sur deux.
   *
   * ⚠️ ET ELLE N'ÉCRASE JAMAIS UNE SAISIE : si le client a déjà tapé quelque chose, c'est lui qui a raison.
   *
   * 🔴 « A DÉJÀ TAPÉ » NE SUFFISAIT PAS (2026-09-22). Un client qui a cliqué dans le champ et tape au moment où
   * la suggestion arrive le trouvait encore vide au moment du test : la suggestion s'y posait, et sa saisie
   * s'ajoutait DERRIÈRE (`https://ganprevoyance.frhttps://autre-site.fr/page`). Attrapé par le e2e en CI,
   * mesuré ensuite à 4 échecs sur 40. Dès que le champ a reçu le focus, la suggestion ne le remplit plus ;
   * le bandeau au-dessus continue de la montrer.
   */
  const touche = useRef(false);
  useEffect(() => {
    if (urlSuggeree) setUrl((actuel) => (actuel === '' && !touche.current ? urlSuggeree : actuel));
  }, [urlSuggeree]);
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
        <p className="text-sm font-medium text-ink-900">{t('Lire une page de votre site', 'Read a page of your site')}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          {t(
            'On lit la page une fois et on en fait des fiches, découpées sur ses titres. L’agent ne relit pas votre site à chaque question : c’est plus rapide, moins cher, et surtout vous pouvez corriger une mauvaise réponse ici même.',
            'We read the page once and turn it into entries, split on its headings. The agent does not re-read your site on every question: it is faster, cheaper, and above all you can fix a bad answer right here.',
          )}
        </p>
      </div>
      {urlSuggeree && (
        <p data-testid="kb-url-suggeree" className="rounded-controle border border-brand-200 bg-brand-50 px-3 py-2 text-xs leading-relaxed text-ink-900">
          {t(
            'L’assistant de construction a noté cette adresse pendant votre entretien. Relisez-la, puis voyez ce qui sera importé : rien n’est écrit avant que vous ne l’ayez vu.',
            'The setup assistant noted this address during your interview. Check it, then see what will be imported: nothing is written before you have seen it.',
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          data-testid="kb-url"
          className={`${inputCls} max-w-md`}
          value={url}
          disabled={busy || occupe}
          onFocus={() => { touche.current = true; }}
          onChange={(e) => { setUrl(e.target.value); setApercu(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && propre !== '') void voir(); }}
          placeholder="https://votre-site.fr/tarifs"
        />
        <Bouton enCours={occupe}
          data-testid="kb-importer"
          disabled={busy || occupe || propre === ''}
          onClick={() => void voir()}
        >
          {occupe ? t('Lecture…', 'Reading…') : t('Voir ce qui sera importé', 'See what will be imported')}
        </Bouton>
      </div>

      {/* 🔴 L'APERÇU N'ÉCRIT RIEN, et c'est tout son intérêt. Cinquante pages écrites d'un coup, ce sont
          cinquante jeux de fiches à relire ou supprimer une par une si la portée était mauvaise. */}
      {apercu !== null && (
        <div className="rounded-carte border border-ink-200 p-3" data-testid="kb-apercu">
          <p className="text-sm font-medium text-ink-900">
            {apercu.portee === 'page'
              ? t('Cette page seule', 'This page only')
              : t(`Ce site : ${apercu.pages.length} page(s) lisible(s)`, `This site: ${apercu.pages.length} readable page(s)`)}
          </p>
          {/* ⚠️ Le plafond est DIT quand il mord : « 50 pages » n'est pas « tout le site », et le taire
              laisserait croire à une base complète alors qu'il en manque la moitié. */}
          {apercu.plafondAtteint && (
            <p className="mt-1 text-xs text-alerte-800" data-testid="kb-apercu-plafond">
              {t(
                'Le plafond de pages est atteint : il en manque. Importez d’abord celles-ci, puis donnez une adresse plus précise pour le reste.',
                'The page cap was reached: some are missing. Import these first, then give a more precise address for the rest.',
              )}
            </p>
          )}
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs">
            {apercu.pages.map((p) => (
              <li key={p.url} className="flex justify-between gap-3">
                <span className="truncate text-ink-500">{p.url}</span>
                <span className="shrink-0 tabular-nums text-ink-500">
                  {t(`${p.fiches} fiche(s), ${p.caracteres} car.`, `${p.fiches} entry(ies), ${p.caracteres} chars`)}
                </span>
              </li>
            ))}
          </ul>
          {apercu.ecartees.length > 0 && (
            <p className="mt-2 text-xs text-ink-500" data-testid="kb-apercu-ecartees">
              {t(`${apercu.ecartees.length} adresse(s) écartée(s) : `, `${apercu.ecartees.length} address(es) skipped: `)}
              {apercu.ecartees.slice(0, 3).map((e) => e.raison).join(', ')}
            </p>
          )}
          <Bouton
            data-testid="kb-confirmer"
            disabled={busy || apercu.pages.length === 0}
            onClick={() => { onImport(apercu.url, apercu.pages.map((p) => p.url)); setApercu(null); setUrl(''); }}
            className="mt-3"
          >
            {t(`Importer ces ${apercu.pages.length} page(s)`, `Import these ${apercu.pages.length} page(s)`)}
          </Bouton>
        </div>
      )}
      <p className="text-xs leading-relaxed text-alerte-800">
        {t(
          'Relire la même adresse remplace les fiches qu’elle avait déjà produites : vos corrections sur celles-là seront perdues. Les fiches venues d’ailleurs, et celles que vous avez écrites à la main, ne bougent pas.',
          'Re-reading the same address replaces the entries it had already produced: your fixes on those will be lost. Entries from other sources, and the ones you wrote by hand, are untouched.',
        )}
      </p>
    </div>
  );
}

/** Une fiche écrite à la main : le chemin le plus court quand le client n'a pas de page pour ça. */
/**
 * Dépôt d'un document : texte, CSV, PDF ou Word.
 *
 * 🔴 RIEN N'EST RÉÉCRIT DERRIÈRE CE BOUTON. La reconnaissance par SIGNATURE, l'extraction et le découpage
 * existaient déjà, écrits pour la conversation de construction : ils n'étaient joignables que de là. Le
 * même moteur sert les deux chemins, donc un PDF joint en parlant au robot produit exactement les mêmes
 * fiches que déposé ici.
 *
 * ⚠️ Les IMAGES ne passent pas par ici : les lire demande un modèle de vision que cette route n'a pas. Le
 * dire est plus honnête que d'échouer sans expliquer, et la conversation, elle, sait le faire.
 */
function ImportDocument({ busy, onDeposer }: { busy: boolean; onDeposer: (nom: string, dataUrl: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={`${cardCls} flex flex-col gap-3`}>
      <div>
        <p className="text-sm font-medium text-ink-900">{t('Déposer un document', 'Upload a document')}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          {t(
            'Un PDF, un Word, un fichier texte ou CSV de questions-réponses, découpé en fiches sur ses titres. Le type se reconnaît au contenu du fichier, pas à son extension.',
            'A PDF, a Word file, a text or CSV of questions and answers, split into entries on its headings. The type is recognised from the file content, not its extension.',
          )}
        </p>
      </div>
      <div>
        <Bouton variante="secondaire"
          type="button"
          data-testid="kb-document"
          disabled={busy}
          onClick={() => ref.current?.click()}
        >
          {t('Choisir un fichier', 'Choose a file')}
        </Bouton>
        <input
          ref={ref}
          type="file"
          data-testid="kb-document-fichier"
          accept=".txt,.csv,.md,.pdf,.doc,.docx,text/plain,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Remis à zéro : sans ça, redéposer LE MÊME fichier après une erreur n'émet aucun événement.
            e.target.value = '';
            if (!f) return;
            const lecteur = new FileReader();
            lecteur.onload = () => onDeposer(f.name, String(lecteur.result ?? ''));
            lecteur.readAsDataURL(f);
          }}
        />
      </div>
      <p className="text-xs leading-relaxed text-alerte-800">
        {t(
          'Redéposer le même fichier remplace les fiches qu’il avait déjà produites : vos corrections sur celles-là seront perdues. Les autres ne bougent pas.',
          'Re-uploading the same file replaces the entries it had already produced: your fixes on those will be lost. The others are untouched.',
        )}
      </p>
    </div>
  );
}

function AjoutManuel({ busy, onAdd }: { busy: boolean; onAdd: (titre: string, corps: string) => void }) {
  const t = useT();
  const [titre, setTitre] = useState('');
  const [corps, setCorps] = useState('');
  const pret = !busy && titre.trim() !== '' && corps.trim() !== '';
  return (
    <div className={`${cardCls} flex flex-col gap-2`}>
      <p className="text-sm font-medium text-ink-900">{t('Écrire une fiche à la main', 'Write an entry by hand')}</p>
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
        <Bouton variante="secondaire"
          data-testid="kb-ajouter"
          disabled={!pret}
          onClick={() => { onAdd(titre.trim(), corps.trim()); setTitre(''); setCorps(''); }}
        >
          {t('Ajouter la fiche', 'Add entry')}
        </Bouton>
      </div>
    </div>
  );
}

/**
 * Le DÉTAIL d'une ligne du tableau : la fiche éditable, dépliée sous sa ligne. Enregistrement à la sortie du
 * champ, comme le reste de l'écran.
 *
 * ⚠️ Ce qu'un lecteur doit voir d'un coup d'œil (titre, provenance, alerte de péremption) vit dans la LIGNE,
 * pas ici : un avertissement qu'il faut déplier pour voir n'avertit personne.
 */
/**
 * Une LIGNE du tableau : ce qu'on voit sans ouvrir, et le détail quand on ouvre.
 *
 * 🔴 LA PROVENANCE EST UNE COLONNE, pas une note en bas de fiche. C'est la question que Julien pose en
 * premier devant une base qu'il n'a pas remplie à la main : « est-ce parce qu'on a crawlé le site ? ». Sans
 * elle, une fiche issue d'un PDF et une fiche tapée à la main se ressemblent exactement, et on ne sait ni
 * laquelle relire ni laquelle un réimport va remplacer.
 */
function LigneFiche({ fiche, busy, coche, ouverte, onCocher, onOuvrir, onSave, onDelete }: {
  fiche: FicheConnaissance;
  busy: boolean;
  coche: boolean;
  ouverte: boolean;
  onCocher: (v: boolean) => void;
  onOuvrir: () => void;
  onSave: (patch: { titre?: string; corps?: string }) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const src = fiche.source;
  // Même règle que dans le détail, et pour la même raison : l'alerte se calcule sur `updatedAt`, parce que
  // corriger une fiche à la main EST une vérification humaine. Sans ça l'écran réclamerait la relecture
  // d'une fiche que quelqu'un vient de relire, et l'avertissement finirait par ne plus rien vouloir dire.
  const perimee = useMemo(() => sourcePerimee(fiche.updatedAt, Date.now()), [fiche.updatedAt]);
  return (
    <>
      <tr className={coche ? 'bg-brand-50' : undefined} data-testid={`kb-ligne-${fiche.id}`}>
        <td className="p-2 align-top">
          <input
            type="checkbox"
            data-testid={`kb-cocher-${fiche.id}`}
            checked={coche}
            disabled={busy}
            onChange={(e) => onCocher(e.target.checked)}
          />
        </td>
        <td className="p-2">
          <button
            type="button"
            data-testid={`kb-ouvrir-${fiche.id}`}
            onClick={onOuvrir}
            className="text-left font-medium text-ink-900 hover:underline"
          >
            {fiche.titre}
          </button>
          {!ouverte && (
            // Les deux premières lignes suffisent à reconnaître une fiche ; le reste s'ouvre.
            <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">{fiche.corps}</p>
          )}
        </td>
        <td className="p-2 align-top text-xs" data-testid={`kb-provenance-${fiche.id}`}>
          {src.type === 'page' && (
            <span className="text-ink-500" title={src.url}>
              {t('Page web', 'Web page')}
              <span className="ml-1 block max-w-[16rem] truncate text-ink-500">{src.url}</span>
            </span>
          )}
          {src.type === 'document' && (
            <span className="text-ink-500">
              {t('Document', 'Document')}
              <span className="ml-1 block max-w-[16rem] truncate text-ink-500">{src.nom}</span>
            </span>
          )}
          {src.type === 'manuel' && <span className="text-ink-500">{t('Écrite à la main', 'Written by hand')}</span>}
          {/* La date de LECTURE de la source, qui est de la provenance elle aussi : « lue le 3 janvier » dit
              d'où vient le contenu, là où `updatedAt` dit quand un humain y a touché. Les deux ne se
              confondent pas, et c'est la première qui a sa place ici. */}
          {fiche.derniereLectureAt !== null && (
            <span className="block text-ink-500" data-testid={`kb-lue-${fiche.id}`}>
              {t('lue le', 'read on')}{' '}
              {formatDate(fiche.derniereLectureAt, locale, { day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
          )}
          {/* 🔴 L'ALERTE « À RELIRE » VIT DANS LA LIGNE, PAS DANS LE DÉTAIL. Le passage au tableau l'avait
              repliée derrière un clic : elle ne se serait plus jamais vue, alors que le cadrage en fait la
              parade au défaut le PLUS COURANT du marché, le contenu périmé. Un avertissement qu'il faut
              ouvrir pour voir n'avertit personne. */}
          {perimee && (
            <span
              data-testid={`kb-perimee-${fiche.id}`}
              className="mt-1 inline-block rounded-full bg-alerte-100 px-2 py-0.5 font-medium text-ink-900"
            >
              {t(`À relire : plus de ${JOURS_AVANT_ALERTE} jours`, `Worth re-reading: over ${JOURS_AVANT_ALERTE} days`)}
            </span>
          )}
        </td>
        <td className="p-2 text-right align-top text-xs tabular-nums text-ink-500">
          {t(`${fiche.corps.length} car.`, `${fiche.corps.length} chars`)}
        </td>
      </tr>
      {ouverte && (
        <tr>
          <td colSpan={4} className="bg-ink-50/50 p-2">
            <Fiche fiche={fiche} busy={busy} onSave={onSave} onDelete={onDelete} />
          </td>
        </tr>
      )}
    </>
  );
}

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
          className="shrink-0 rounded-controle px-2 py-1 text-sm text-danger hover:bg-danger-50 disabled:opacity-40"
        ><Icone nom="fermer" taille="petite" /></button>
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
        <span data-testid={`kb-perimee-${fiche.id}`} className="rounded-full bg-alerte-100 px-2 py-0.5 font-medium text-ink-900">
          {t(`À relire : plus de ${JOURS_AVANT_ALERTE} jours`, `Worth re-reading: over ${JOURS_AVANT_ALERTE} days`)}
        </span>
      )}
    </p>
  );
}
