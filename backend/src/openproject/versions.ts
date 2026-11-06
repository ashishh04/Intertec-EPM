import { idFromHref, linkOf, type OpFilter } from './client.js';
import type { HalLink } from './types.js';

/**
 * A work package's version — an EPM sprint — whichever way the instance keeps it.
 *
 * OpenProject 17 lets a work package have several target versions, and does so
 * by default (the `work_package_multiple_versions` setting). With that on, a
 * work package has no `version` link at all: it has `targetVersions`, an array,
 * and its schema offers only that. With it off, `version` is still there and
 * names the first target version. Before 17 there is only `version`.
 *
 * EPM keeps one sprint per task: the `version` link where there is one, else
 * the first target version — the one `version` itself would name. Read only
 * from `version`, every task showed no sprint and every sprint had no work.
 */

type Links = Record<string, HalLink | HalLink[] | undefined> | undefined;

/** The work package's version link: `version`, else the first of `targetVersions`. */
export function versionLinkOf(links: Links): HalLink | undefined {
  return linkOf(links, 'version') ?? linkOf(links, 'targetVersions');
}

/** `"3"` for a work package in version 3; undefined for one in none. */
export function versionIdOf(links: Links): string | undefined {
  return idFromHref(versionLinkOf(links)?.href);
}

export function versionTitleOf(links: Links): string | undefined {
  return versionLinkOf(links)?.title;
}

/**
 * The `_links` that put a work package in exactly one version, or in none.
 *
 * Both names are sent, saying the same thing. 17 always reads `targetVersions`
 * and reads `version` only while a work package may have one version: with
 * several allowed the property does not exist, so a write through it alone was
 * ignored without a word. Before 17 only `version` is read. Either way the set
 * becomes this one version, which is what writing `version` does on 17 too.
 */
export function versionLinks(versionId: string | null): { version: HalLink; targetVersions: HalLink[] } {
  const href = versionId === null ? null : `/api/v3/versions/${versionId}`;
  return { version: { href }, targetVersions: href === null ? [] : [{ href }] };
}

/**
 * Work packages in any of these versions.
 *
 * `version` on every release EPM meets: 17 lists the filter as `targetVersion`
 * while several versions are allowed, and still takes `version` as that one;
 * before 17 `version` is all there is. A work package with several target
 * versions matches on any of them, so where a task must count in its one
 * sprint only, the caller checks `versionIdOf` as well.
 */
export function versionFilter(versionIds: string[]): OpFilter {
  return { field: 'version', operator: '=', values: versionIds };
}
