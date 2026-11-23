/* Structured-data builders shared by the static presentation pages.
 *
 * `data/chains.json` and `lib/site.ts` remain the single source for identity;
 * this module only assembles the schema.org nodes the pages emit. The output is
 * build-time content, never user input. */
import { SITE_NAME, SITE_ORIGIN } from './site.js';

export interface Crumb {
  name: string;
  /** Root-relative path; omit for a non-link intermediate crumb. */
  path?: string;
}

export function breadcrumbList(crumbs: readonly Crumb[]): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      ...(crumb.path ? { item: new URL(crumb.path, SITE_ORIGIN).href } : {}),
    })),
  };
}

const WEBSITE = {
  '@type': 'WebSite',
  '@id': `${SITE_ORIGIN}/#website`,
  url: `${SITE_ORIGIN}/`,
  name: SITE_NAME,
  inLanguage: 'en',
  publisher: {
    '@type': 'Organization',
    name: SITE_NAME,
    url: `${SITE_ORIGIN}/`,
    logo: { '@type': 'ImageObject', url: `${SITE_ORIGIN}/favicon.png` },
  },
};

export interface PageNode {
  url: string;
  name: string;
  description: string;
}

/** A plain `WebPage` node tied to the site, for pages that are not articles. */
export function webPageNode({ url, name, description }: PageNode): Record<string, unknown> {
  return {
    '@type': 'WebPage',
    '@id': `${url}#page`,
    url,
    name,
    description,
    inLanguage: 'en',
    isPartOf: WEBSITE,
  };
}
