# vibeTerminal

vibeTerminal is a Windows desktop app for keeping local terminals and coding
agents in one organized workspace.

Open a project folder, add the terminal or agent panes you need, and arrange
them side by side on a tiled board. It is meant for working across several
local sessions without losing track of which folder, agent, or terminal belongs
to which task.

## Download

| Platform | Download | Notes |
| --- | --- | --- |
| Windows x64 | [vibeTerminal-Setup-0.1.46.exe](https://github.com/luigicarter/VibeTerminal/releases/download/v0.1.46/vibeTerminal-Setup-0.1.46.exe) | Standard Windows installer. |
| All releases | [GitHub Releases](https://github.com/luigicarter/VibeTerminal/releases) | Older versions and release assets. |

Install the app, then launch `vibeTerminal` from the Start Menu or desktop
shortcut. No separate developer setup is required to use the installed app.

## What You Can Do

- Run multiple local terminal panes in one desktop window.
- Open project folders and keep each folder's sessions grouped together.
- Use Multi mode for a free board of terminals and agents from different
  folders.
- Launch panes for Terminal, Codex, Claude, and OpenCode.
- Drag, resize, maximize, duplicate, restart, and close panes.
- See status pills for running, waiting, done, and failed sessions.
- Use sidebar attention dots when an agent finishes, waits for input, or fails.
- Track Git line changes for opened project folders.
- Resume supported agent threads when a pane is restarted.
- Check for app updates without interrupting running sessions.

## Quick Start

1. Install and open vibeTerminal.
2. Click `Open Folder` and choose a project folder.
3. Click `Terminal` to open a regular shell in that folder.
4. Click an agent button, such as `Codex` or `Claude`, to start that agent in
   the same folder.
5. Drag pane headers to move panes around the board.
6. Drag pane edges or corners to resize panes.
7. Use `Multi mode` when you want one board that can hold sessions from
   different folders.

In a project view, new panes start in that project's folder. In Multi mode, the
app asks which folder to use each time you add a new pane.

## Pane Controls

Each pane has a small toolbar:

- `Add matching pane` opens another pane of the same type.
- `Duplicate pane` copies the pane type and folder into a new pane.
- `Restart terminal` stops and relaunches that pane.
- `Maximize pane` expands the pane; `Restore pane` returns it to the board.
- `Close pane` stops and removes the pane.

Right-click inside a terminal for `Copy` and `Paste`.

## Agent Setup

Regular terminal panes work out of the box.

Agent panes use the command-line tools already installed on your machine. If you
want to use an agent button, install that provider's CLI and make sure the
command works in PowerShell:

- `codex`
- `claude`
- `opencode`

If a tool is not installed or is not on your PATH, the pane will open but the
shell will report that the command was not found.

Other CLIs can be run from a regular terminal pane.

## Updates

vibeTerminal checks for updates when it starts. You can also click `Check for
update` in the top bar.

When an update is available, vibeTerminal shows a small overlay. Click `Update`
to download it, then click `Restart` when your sessions are in a good place. The
app does not auto-download, auto-restart, or interrupt running terminals.
On Windows, the update installer runs silently during that restart and then
relaunches vibeTerminal.

## Notes

- Closing a folder in the sidebar only removes it from vibeTerminal and closes
  its panes. It does not delete your project files.
- The Git summary only appears for folders that are Git repositories.
- Windows may show a SmartScreen warning for early unsigned builds.
- Developer and release documentation lives in `docs/`.
