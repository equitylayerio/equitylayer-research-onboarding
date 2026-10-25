import { readFile } from "node:fs/promises";

// Read fixed, trusted assets. Private records and credentials never enter HTML.
export async function loadWorkspaceAssets() {
  const [html, state, app, css, font, diagnostics, session] = await Promise.all([
    readFile(new URL("./ui/workspace.html", import.meta.url), "utf8"),
    readFile(new URL("./ui/workspace-state.mjs", import.meta.url), "utf8"),
    readFile(new URL("./ui/workspace.js", import.meta.url), "utf8"),
    readFile(new URL("./ui/workspace.css", import.meta.url), "utf8"),
    readFile(new URL("./assets/InterVariable.woff2", import.meta.url)),
    readFile(new URL("./execution-diagnostics.mjs", import.meta.url), "utf8"),
    readFile(new URL("./ui/session-preparation.mjs", import.meta.url), "utf8"),
  ]);
  const browserState = state.replace(/^import \{ executionFailureSummary \} from "\.\.\/execution-diagnostics\.mjs";\n/, "");
  const browserSession = session.replace(/^import \{ WorkspaceRequestError, emptyPage, mergePage \} from "\.\/workspace-state\.mjs";\n/, "");
  return { html, js: `${diagnostics.replace(/^export /gm, "")}\n${browserState.replace(/^export /gm, "")}\n${browserSession.replace(/^export /gm, "")}\n${app}`, css, font };
}
