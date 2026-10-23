import type { Chanx } from './app';
import { internals } from './app';
import type { AsyncAPIOptions } from './asyncapi';

/** Options for `asyncapiHandler()`: the document's, plus where to serve it. */
export interface AsyncAPIServeOptions extends AsyncAPIOptions {
  /** The docs page's path; the document is served at it plus `.json` and `.yaml`. Defaults to `/asyncapi`. */
  path?: string;
}

/** A Fetch handler for the AsyncAPI document; `undefined` for a path it does not serve. */
export type AsyncAPIHandler = (request: Request) => Promise<Response | undefined>;

/**
 * Serve the AsyncAPI document as chanx does: a docs page at `/asyncapi`, the document at
 * `/asyncapi.json` and `/asyncapi.yaml`. The server's host and protocol default to the
 * request's. YAML needs the `yaml` package.
 *
 * ```ts
 * const asyncapi = asyncapiHandler(chanx, { title: 'Chat API' });
 * app.get('/asyncapi*', async (c, next) => (await asyncapi(c.req.raw)) ?? next());
 * ```
 */
export function asyncapiHandler(
  chanx: Chanx,
  { path = '/asyncapi', ...options }: AsyncAPIServeOptions = {},
): AsyncAPIHandler {
  const logger = internals.get(chanx)?.logger ?? console;
  const formats: Record<string, Format> = {
    [path]: 'html',
    [`${path}.json`]: 'json',
    [`${path}.yaml`]: 'yaml',
  };

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    const url = new URL(request.url);
    const format = formats[url.pathname];
    if (!format) return undefined;
    try {
      const document = chanx.asyncapi({
        serverUrl: url.host,
        serverProtocol: url.protocol === 'https:' ? 'wss' : 'ws',
        ...options,
      });
      if (format === 'json') return Response.json(document);
      if (format === 'html') return html(docsPage(document.info.title, document));
      const yaml = await import('yaml').catch(() => undefined);
      if (!yaml) {
        return Response.json(
          { error: 'YAML format not available. Please install yaml: npm install yaml' },
          { status: 400 },
        );
      }
      return new Response(yaml.stringify(document), {
        headers: { 'content-type': 'application/x-yaml' },
      });
    } catch (error) {
      logger.error('chanx: generating the AsyncAPI document failed', error);
      const message = `Failed to generate schema: ${String((error as Error)?.message ?? error)}`;
      return format === 'html'
        ? html(errorPage(message), 500)
        : Response.json({ error: message }, { status: 500 });
    }
  };
}

type Format = 'html' | 'json' | 'yaml';

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const COMPONENT = 'https://unpkg.com/@asyncapi/react-component@latest';

function docsPage(title: string, document: object): string {
  // Inside <script>, "</script>" in a description would end the script early.
  const schema = JSON.stringify(document).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html>
  <head>
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${COMPONENT}/styles/default.min.css">
  </head>
  <body>
    <div id="asyncapi"></div>
    <script src="${COMPONENT}/browser/standalone/index.js"></script>
    <script>
      AsyncApiStandalone.render(
        { schema: ${schema}, config: { show: { sidebar: true } } },
        document.getElementById('asyncapi'),
      );
    </script>
  </body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
  <head><title>AsyncAPI Schema</title></head>
  <body>
    <div style="padding: 2rem; margin: 2rem; border: 1px solid #fcc; border-radius: 8px; background: #fee; color: #c33">
      <h3>Error</h3>
      <p>${escapeHtml(message)}</p>
    </div>
  </body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
