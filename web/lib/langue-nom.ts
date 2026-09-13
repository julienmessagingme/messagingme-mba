import type { Locale } from './locale';

/**
 * NOMMER UNE LANGUE, dans la langue de la console.
 *
 * 🔴 CE MODULE EXISTE POUR UN SEUL LIBELLE, ET C'EST UNE RÈGLE DU LOT : le bouton de traduction
 * NOMME sa cible (« Traduire en espagnol »), jamais « Traduire » tout court. L'opérateur voit où part
 * sa phrase AVANT de valider, ce qui est la seule protection qui reste quand la langue du contact a
 * été mal apprise (un « ok » ou un emoji peuvent la fausser une fois).
 *
 * ⚠️ `Intl.DisplayNames` PLUTÔT QU'UNE TABLE. Une table à tenir à la main serait fausse au premier
 * contact qui écrit dans une langue qu'on n'y a pas mise, et c'est précisément le cas que cette
 * fonctionnalité sert. Le navigateur, lui, connaît toutes les langues, dans les deux locales.
 */

/**
 * La langue par DÉFAUT d'un envoi, tant qu'on n'a rien appris du contact.
 *
 * 🔴 L'AUTRE LANGUE DE LA CONSOLE, jamais l'anglais en dur, et la nuance compte : « Traduire en
 * anglais » proposé à un opérateur qui écrit DÉJÀ en anglais est un bouton qui ne fait rien. Un
 * opérateur français se voit donc proposer l'anglais, un opérateur anglais le français. Ce n'est
 * qu'un défaut proposé, pas une supposition sur le contact : le bouton le NOMME, donc il ne ment pas.
 */
export function langueSortanteParDefaut(locale: Locale): string {
  return locale === 'en' ? 'fr' : 'en';
}

/**
 * Le nom d'une langue dans la locale de la console. Replie sur le code lui-même quand le navigateur
 * ne sait pas le nommer.
 *
 * ⚠️ `Intl.DisplayNames.of` LÈVE sur un code mal formé (`RangeError`), et cette valeur vient de la
 * base : elle a été écrite par un modèle. Un libellé de bouton n'est pas une raison de casser l'écran
 * de l'Inbox, donc l'échec rend le code brut, qui reste lisible.
 */
export function nomDeLangue(code: string, locale: Locale): string {
  const brut = code.trim();
  if (brut === '') return '';
  try {
    const noms = new Intl.DisplayNames([locale], { type: 'language' });
    // `of` peut aussi rendre `undefined` sur une langue inconnue du navigateur, sans lever.
    return noms.of(brut.replace('_', '-')) ?? brut;
  } catch {
    return brut;
  }
}
