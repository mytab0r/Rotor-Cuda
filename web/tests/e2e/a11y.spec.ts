import AxeBuilder from '@axe-core/playwright';
import { expect, openRoute, test } from './fixtures';
import { ROUTES } from './routes.data';

/* Axe on every route in every project. Critical and serious findings fail the
 * gate. No page-level allowlist: an accepted finding needs a filed issue and
 * an explicit, commented exclusion in this file, because a silent allowlist
 * is how accessibility rot starts. */

test.describe('accessibility', () => {
  for (const route of ROUTES) {
    test(`${route.path} has no critical or serious axe violations`, async ({ page }, testInfo) => {
      await openRoute(page, route.path);

      const results = await new AxeBuilder({ page }).analyze();
      await testInfo.attach('axe-results.json', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
      });

      const blocking = results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      );
      const summary = blocking
        .map((violation) => {
          const nodes = violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n');
          return `${violation.impact} ${violation.id}: ${violation.help}\n${nodes}`;
        })
        .join('\n');

      expect(blocking, `axe critical/serious violations:\n${summary}`).toEqual([]);
    });
  }
});
