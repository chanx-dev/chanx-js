import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createMarkdownRenderer, defineLoader } from 'vitepress';

const packages = ['server', 'client', 'codegen', 'layers', 'nestjs'] as const;
type Package = (typeof packages)[number];

export type Changelogs = Record<Package | 'lockstep', string>;

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const changelogOf = (name: Package) => `${repoRoot}packages/${name}/CHANGELOG.md`;
// Releases up to 2.0.0 went out together, before each package had its own changelog.
const lockstepChangelog = `${repoRoot}CHANGELOG.md`;

declare const data: Changelogs;
export { data };

// Changesets writes and owns these files, so the page reads them rather than copying them,
// and a package's first changelog shows up here without a docs change.
export default defineLoader({
  watch: [...packages.map(changelogOf), lockstepChangelog],
  async load(): Promise<Changelogs> {
    const md = await createMarkdownRenderer(
      fileURLToPath(new URL('../', import.meta.url)),
    );
    const render = (markdown: string) => md.render(underPageHeading(markdown));

    const entries = await Promise.all(
      packages.map(async (name) => {
        const markdown = await readFile(changelogOf(name), 'utf-8').catch(() => null);
        const html = markdown
          ? render(markdown)
          : '<p>No changes since 2.0.0, its first release in step with chanx 2.</p>';
        return [name, html] as const;
      }),
    );
    const lockstep = render(await readFile(lockstepChangelog, 'utf-8'));
    return { ...Object.fromEntries(entries), lockstep } as Changelogs;
  },
});

/** Drop the file's own title and intro, and nest its headings under the page's `##`. */
function underPageHeading(markdown: string): string {
  const body = markdown.slice(markdown.search(/^## /m));
  return body.replace(/^(#{2,5}) /gm, '#$1 ');
}
