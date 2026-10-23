import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLinkLine,
  buildTitle,
  composeMemoContent,
  findCheckbox,
  hash,
  parseCheckboxes,
  setCheckbox,
  stripFooter,
  stripLinkLine,
  taskDeepLink,
  toPlainText,
} from '../src/markdown.ts';

const FALLBACK = 'Memos-Aufgaben vom 22.10.2026, 07:54';

// Real-world memos (shapes as returned by the Memos API).
const ARCANE = `- [ ] Über das Konzept von Arcane-S3-Backup nochmal nachdenken

**Status quo**
- Arcane braucht einen S3 Bucket, um Backups zu schreiben
- "garage" ist unser S3 Service

#homelab #backups`;

const GYM = `#gym
- Beuger + Strecker
  - Ich mache offenbar schon eine Übung für Strecker
  - [ ] Beuger-Übung hinzufügen

#physio
### Übungen auf der Matte
- Plank`;

const ABREISE = `## Vor Abreise

- [ ] Müll rausbringen
- [ ] Küche aufräumen
- [ ] Lüften
- [ ] Fenster schließen`;

const CARRERA = `#CarreraServer

## Viewer
- [ ] Viewer braucht noch ein Spalten Widget, damit in einer Spalte mehrere Widgets nebeneinander angezeigt werden können
- [ ] Wofür braucht es "Widgets untereinander anordnen" bei der Spaltenkonfig?
- [ ] Ist es nicht sinnvoller ein Karussel-Widget zu erstellen statt dies zu einer Option von Spalten zu machen?


## Rennsetup
- [x] Das Widgets "Session-Steuerung" und "Prüfungen" sollten nicht auf den Tab "Rennleitung" verweisen.
`;

test('cascade: single open checkbox wins', () => {
  assert.equal(
    buildTitle(ARCANE, ['homelab', 'backups'], 'cascade', FALLBACK),
    'Über das Konzept von Arcane-S3-Backup nochmal nachdenken',
  );
  assert.equal(
    buildTitle(GYM, ['gym', 'physio'], 'cascade', FALLBACK),
    'Beuger-Übung hinzufügen',
  );
});

test('cascade: text before the first checkbox, tag-prefixed', () => {
  assert.equal(buildTitle(ABREISE, [], 'cascade', FALLBACK), 'Vor Abreise');
  assert.equal(
    buildTitle(CARRERA, ['CarreraServer'], 'cascade', FALLBACK),
    'CarreraServer – Viewer',
  );
});

test('cascade: generic fallback without text before the checkboxes', () => {
  assert.equal(buildTitle('- [ ] a\n- [ ] b', [], 'cascade', FALLBACK), FALLBACK);
  assert.equal(
    buildTitle('#todo\n\n- [ ] a\n- [ ] b', ['todo'], 'cascade', FALLBACK),
    FALLBACK,
  );
});

test('cascade: tag prefix is skipped when the text already contains it', () => {
  assert.equal(
    buildTitle(
      '## Garage aufräumen\n- [ ] a\n- [ ] b #garage',
      ['garage'],
      'cascade',
      FALLBACK,
    ),
    'Garage aufräumen',
  );
});

test('firstOpen and generic modes', () => {
  assert.equal(buildTitle(ABREISE, [], 'firstOpen', FALLBACK), 'Müll rausbringen (+3)');
  assert.equal(buildTitle(ABREISE, [], 'generic', FALLBACK), FALLBACK);
});

test('long titles are truncated', () => {
  const title = buildTitle(`- [ ] ${'x'.repeat(300)}`, [], 'cascade', FALLBACK);
  assert.equal(title.length, 120);
  assert.ok(title.endsWith('…'));
});

test('parseCheckboxes skips code fences and reads state', () => {
  const content = '- [ ] a\n```\n- [ ] in code\n```\n* [x] b\n1. [X] c';
  assert.deepEqual(
    parseCheckboxes(content).map((c) => [c.index, c.line, c.checked, c.text]),
    [
      [0, 0, false, 'a'],
      [1, 4, true, 'b'],
      [2, 5, true, 'c'],
    ],
  );
});

test('setCheckbox toggles exactly one checkbox', () => {
  const checked = setCheckbox(ABREISE, 1, true);
  assert.match(checked, /- \[x\] Küche aufräumen/);
  assert.equal(parseCheckboxes(checked).filter((c) => c.checked).length, 1);
  assert.equal(setCheckbox(checked, 1, false), ABREISE);
  assert.equal(setCheckbox(ABREISE, 99, true), ABREISE);
});

test('findCheckbox matches by text, index only breaks ties', () => {
  const moved = '- [ ] neu\n' + ABREISE;
  assert.equal(findCheckbox(moved, 'Lüften', 2)?.index, 3);
  assert.equal(findCheckbox('- [ ] a\n- [ ] a', 'a', 1)?.index, 1);
  assert.equal(findCheckbox(ABREISE, 'gibt es nicht', 0), undefined);
});

test('toPlainText strips markdown, markers and tags', () => {
  assert.equal(toPlainText('## **Fett** und [Link](http://x) #tag'), 'Fett und Link');
  assert.equal(toPlainText('  - [ ] `code` _kursiv_'), 'code kursiv');
});

test('footer round trip', () => {
  const content = composeMemoContent('Meine Notiz\n', 'Task *A*', 'superprod');
  assert.equal(content, 'Meine Notiz\n\n---\n*SP-Task: Task A* #superprod');
  assert.equal(stripFooter(content), 'Meine Notiz');
  assert.equal(stripFooter(composeMemoContent('x', 'T')), 'x');
  // Content without footer stays as is.
  assert.equal(stripFooter('a\n\n---\nb'), 'a\n\n---\nb');
});

test('link line round trip and compose ignores it', () => {
  const notes = appendLinkLine('Notiz', 'https://m/memos/abc');
  assert.equal(stripLinkLine(notes), 'Notiz');
  assert.equal(
    composeMemoContent(notes, 'T', 't'),
    composeMemoContent('Notiz', 'T', 't'),
  );
});

test('hash is stable and content-sensitive', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
});

test('task deep link and linked footer title', () => {
  assert.equal(
    taskDeepLink('https://sp.example.com/', { id: 'T-1', projectId: 'INBOX_PROJECT' }),
    'https://sp.example.com/#/project/INBOX_PROJECT/tasks?focusItem=T-1&isFromSearch=true',
  );
  assert.equal(
    taskDeepLink('https://sp.example.com/#/tag/TODAY/tasks', {
      id: 'x',
      projectId: null,
    }),
    'https://sp.example.com/#/tag/TODAY/tasks?focusItem=x&isFromSearch=true',
  );
  assert.equal(taskDeepLink('', { id: 'x' }), '');

  const url = taskDeepLink('https://sp.example.com', { id: 'T-1', projectId: 'P' });
  const content = composeMemoContent('Notiz', 'Plan [A]', 'superprod', url);
  assert.equal(content, `Notiz\n\n---\n*SP-Task: [Plan \\[A\\]](${url})* #superprod`);
  assert.equal(stripFooter(content), 'Notiz');
});
