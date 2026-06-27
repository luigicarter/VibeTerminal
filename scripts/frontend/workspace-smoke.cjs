const assert = require("assert");
const fs = require("fs");
const path = require("path");

const appPath = path.join(__dirname, "..", "..", "frontend", "App.tsx");
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");

const appSource = fs.readFileSync(appPath, "utf8");
const stylesSource = fs.readFileSync(stylesPath, "utf8");

assert(
  !appSource.includes("window.vibe?.app.getCwd().then") &&
    !appSource.includes("setWorkspaces([workspace])"),
  "empty installs should not create a project from the app cwd"
);

assert(
  appSource.includes("function loadActiveView(workspaces: ProjectWorkspace[]): AppView") &&
    appSource.includes('return "multi";'),
  "empty workspace state should open in multi mode"
);

assert(
  appSource.includes("function removeWorkspace(workspaceId: string)") &&
    appSource.includes("window.vibe?.terminal.kill(session.id)") &&
    appSource.includes("setWorkspaces(nextWorkspaces)") &&
    appSource.includes("setActiveWorkspaceId(nextActiveWorkspace?.id ?? null)"),
  "folder removal should clear state and kill its terminal sessions"
);

assert(
  appSource.includes('className="workspace-remove-button"') &&
    appSource.includes("aria-label={`Remove ${workspace.name}`}"),
  "folder rows should expose an accessible remove button"
);

assert(
  stylesSource.includes(".workspace-row") &&
    stylesSource.includes(".workspace-remove-button"),
  "folder remove controls should be styled"
);

console.log("workspace smoke passed");
