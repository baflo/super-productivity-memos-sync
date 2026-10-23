# Memos plugin

Connects Super Productivity with [Memos](https://usememos.com) (self-hosted or cloud).

1. **Issue provider:** memos with task-list checkboxes (what Memos shows under
   "Tasks") can be added as tasks. The whole memo becomes the task notes, and
   the task links to the memo.
2. **Note sync:** task notes are mirrored to one memo per task, both ways.
   Optionally in their own space and/or under their own tag. Tasks imported
   from Memos and checkbox subtasks are left out, so no memo appears twice.

## Setup

1. Build: `npm install && npm run build` in this folder, then zip the content
   of `dist/` and upload it under **Settings → Plugins**.
2. Plugin settings (gear icon of the plugin):
   - **Memos URL**, e.g. `https://memos.home.lan`. Use a host name, because
     Super Productivity blocks `localhost` and private IP addresses for plugin
     providers. A host name that resolves to a LAN address is fine. It does not
     resolve DNS.
   - Note sync on/off, space, tag, visibility, pull interval, and what happens
     to the memo when its task is deleted (default: nothing).
3. Plugin menu → **Memos: Set access token**. Create the token in Memos under
   Settings → My account → Access tokens. It is stored on this device only.
4. Issue providers → add **Memos**. Optional per provider: filter tag, filter
   space, title mode.

## Task titles

| Mode                | Title                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smart (default)     | single open checkbox → its text; otherwise the line before the first checkbox, prefixed with the first tag (`CarreraServer – Viewer`); otherwise `Memos tasks from <date>` |
| First open checkbox | `Müll rausbringen (+3)`                                                                                                                                                    |
| Generic             | `Memos tasks from <date>`                                                                                                                                                  |

A task is never completed automatically because its checkboxes are all
checked. The title is set on import only. Switch on title sync in the
provider's sync settings if you want it to follow the memo.

## Checkboxes as subtasks

Task context menu → **Memos: Checkboxes as subtasks…** (only on tasks imported
from Memos). Completing such a subtask checks the box in Memos. Checking the
box in Memos completes the subtask on the next poll.

## Note sync details

- Each memo ends with a footer `--- *SP-Task: <title>* #<tag>`, which is
  removed again when the memo is pulled into the notes.
- The memo link is added to the task as a link attachment.
- **Pushes:** debounced, 3 s after a change to the notes or title.
- **Pulls:** on window focus, at the configured interval, and from the menu
  entry **Memos: Sync all task notes now**.
- **Conflicts** (both sides changed): the newer side wins. The older version is
  kept as a comment on the memo.

## Network

- The issue provider uses Super Productivity's plugin HTTP helper.
- The note sync and the checkbox subtasks run from hooks and menus. There, the
  plugin API only offers `PluginAPI.request` with hosts fixed in the manifest,
  so they use `fetch`.
- In the desktop app this needs nothing more. In the web version, the Memos
  server must allow CORS for the app's origin.

## Development

```bash
npm test          # unit tests (node --test)
npm run typecheck
npm run build
```
