import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';

test('renders the build-only glassy operator workspace shell', () => {
  render(<App />);

  expect(screen.getByText('polypore v0.1.0')).toBeInTheDocument();
  expect(screen.getByText('workspace')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /git branch main/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^help$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /\/handoff/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^settings$/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /hide chat panel|show chat panel/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /\/compact/i })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /run preview/i })).toBeInTheDocument();
  expect(screen.getByText('preview setup')).toBeInTheDocument();
});

test('git branch header opens a compact git actions menu', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /git branch main/i }));

  expect(screen.getByRole('menu', { name: /git actions/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /commit/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^pull$/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^push$/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /show log/i })).toBeInTheDocument();
});

test('topbar workspace and mode controls open custom dropdown menus', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /workspace build/i }));
  expect(screen.getByRole('menu', { name: /workspace presets/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: /build 7 panels/i })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitem', { name: /save current workspace/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /reset workspace/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /manage workspaces/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /permission mode default/i }));
  expect(screen.getByRole('menu', { name: /permission mode options/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: /auto run trusted actions/i }));
  expect(screen.getByRole('button', { name: /permission mode auto/i })).toBeInTheDocument();
});

test('tool cards navigate to the agent view with skills, tasks, and formation', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /shell npm run build completed successfully ok/i }));

  expect(screen.getByText('skills')).toBeInTheDocument();
  expect(screen.getByText('tasks')).toBeInTheDocument();
  expect(screen.getByText('formation')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /overseer running task conductor overseer settings/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /cybersecurity waiting review scope cybersecurity settings/i })).toBeInTheDocument();
  expect(screen.getByText('4 agents')).toBeInTheDocument();
  expect(screen.getByText('1 running')).toBeInTheDocument();
  expect(screen.getByText('replace mock docking with real dockview layout persistence')).toBeInTheDocument();
});

test('a new skill can be drafted from the skills pane', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /ai agent/i }));
  fireEvent.click(screen.getByRole('button', { name: /\+ skill/i }));
  fireEvent.change(screen.getByPlaceholderText('skill name'), { target: { value: 'repo-mapper' } });
  fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

  expect(screen.getByText('repo-mapper')).toBeInTheDocument();
  expect(screen.getByText('new local skill draft')).toBeInTheDocument();
});

test('creates and switches between multiple chat tabs', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /open new chat tab/i }));
  expect(screen.getByRole('button', { name: /cd codex/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /cs cursor/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /cl claude/i }));

  expect(screen.getByRole('tab', { name: /claude 1/i })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByPlaceholderText('message claude...')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('message claude...'), { target: { value: 'compare the plan' } });
  fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

  expect(screen.getByText('compare the plan')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /codex 1/i }));

  expect(screen.getByPlaceholderText('message codex...')).toBeInTheDocument();
  expect(screen.queryByText('compare the plan')).not.toBeInTheDocument();
});

test('composer tools open skills files knowledge and prompts', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /open composer tools/i }));

  expect(screen.getByRole('dialog', { name: /composer tools/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^skills$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^files$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^knowledge$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^prompts$/i })).toBeInTheDocument();
});

test('opens the terminal as a main tab', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /\$ terminal/i }));

  expect(screen.getByRole('region', { name: /bash terminal/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/terminal command/i)).toBeInTheDocument();
  expect(screen.getByText(/compiled successfully/i)).toBeInTheDocument();
});

test('preview config can run targets inside or outside the window', () => {
  render(<App />);

  expect(screen.getByText('preview setup')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /site localhost or hosted URL/i })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByDisplayValue('npm start')).toBeInTheDocument();
  expect(screen.getByDisplayValue('http://localhost:3000')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('radio', { name: /cli terminal process output/i }));
  expect(screen.getByText('working directory')).toBeInTheDocument();
  expect(screen.getByDisplayValue('npm run dev')).toBeInTheDocument();
  expect(screen.getByDisplayValue('.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));

  expect(screen.queryByText('preview setup')).not.toBeInTheDocument();
  expect(screen.getByText('embedded output')).toBeInTheDocument();
  expect(screen.getByText('active project output')).toBeInTheDocument();
  expect(screen.getByText('cli runtime via npm run dev')).toBeInTheDocument();
  expect(screen.queryByRole('complementary', { name: /preview logs/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^logs$/i }));
  expect(screen.getByRole('complementary', { name: /preview logs/i })).toBeInTheDocument();
  expect(screen.getByText(/> \$ npm run dev/i)).toBeInTheDocument();
  expect(screen.getByText(/> cli output attached to preview/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
  expect(screen.queryByRole('complementary', { name: /preview logs/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^setup$/i }));
  expect(screen.getByText('preview setup')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /run outside window/i }));

  expect(screen.getAllByText('opened outside')).toHaveLength(2);
  expect(screen.getByText('external preview running')).toBeInTheDocument();
  expect(screen.getByText(/cli runtime opened externally via npm run dev/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^open$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^restart$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /run in window/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^logs$/i }));
  expect(screen.getByRole('complementary', { name: /preview logs/i })).toBeInTheDocument();
  expect(screen.getByText(/> \$ npm run dev/i)).toBeInTheDocument();
});

test('opens memory as context and knowledge base panel', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /kb memory/i }));

  expect(screen.getByText('loaded context')).toBeInTheDocument();
  expect(screen.getByText('recommend handoff at 80%')).toBeInTheDocument();
  expect(screen.queryByText('excluded: node_modules/**')).not.toBeInTheDocument();
  expect(screen.queryByText('rules: lowercase ui copy')).not.toBeInTheDocument();
  expect(screen.getByText('drop files here to load context')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /write handoff/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^compress$/i })).toBeInTheDocument();
  expect(screen.getByText('knowledge base')).toBeInTheDocument();
  expect(screen.getByText('selected note')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /load note/i })).toBeInTheDocument();
  expect(screen.getByText('agents')).toBeInTheDocument();
  expect(screen.getByText('formation roles')).toBeInTheDocument();
  expect(screen.getByText('[[ui direction]]')).toBeInTheDocument();
});

test('editor tab exposes a persistent file directory sidebar', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /\{\} editor/i }));

  expect(screen.getByRole('complementary', { name: /select file/i })).toBeInTheDocument();
  expect(screen.getByText('search files...')).toBeInTheDocument();
  expect(screen.getAllByText('app.tsx').length).toBeGreaterThan(1);
  expect(screen.getByRole('tab', { name: /app.tsx modified x/i })).toBeInTheDocument();
  expect(screen.getByText('1 error in app.tsx')).toBeInTheDocument();

  fireEvent.click(screen.getAllByText('types.ts')[0]);
  expect(screen.getAllByText('src/core/types.ts').length).toBeGreaterThan(1);
  expect(screen.getByText('1 error in types.ts')).toBeInTheDocument();

  fireEvent.click(screen.getByText('search files...'));
  expect(screen.getByRole('dialog', { name: /quick open/i })).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('type a file name'), { target: { value: 'readme' } });
  fireEvent.click(screen.getByRole('button', { name: /README.md README.md A/i }));
  expect(screen.getAllByText('README.md').length).toBeGreaterThan(0);
  expect(screen.getByText('no problems in README.md')).toBeInTheDocument();
});

test('verify panel exposes problems, checks, and a fix queue with add+send controls', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /vf verify/i }));

  expect(screen.getByText('problems')).toBeInTheDocument();
  expect(screen.getByText('checks')).toBeInTheDocument();
  expect(screen.getByText('queue')).toBeInTheDocument();
  expect(screen.getByText(/missing 'phase-reporting'/i)).toBeInTheDocument();
  expect(screen.getByText('typecheck')).toBeInTheDocument();
  expect(screen.queryByText('tools')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /send to chat/i })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^create \+$/i })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: /queue all/i })).toHaveLength(2);
  expect(screen.getByText(/drag problems and checks here/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /queue typecheck/i }));
  expect(screen.queryByRole('button', { name: /run typecheck/i })).not.toBeInTheDocument();
});

test('a custom problem can be added via the + add control', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /vf verify/i }));

  const addButtons = screen.getAllByRole('button', { name: /^create \+$/i });
  fireEvent.click(addButtons[0]);

  const input = screen.getByPlaceholderText('problem to enqueue');
  fireEvent.change(input, { target: { value: 'rename ambiguous variable' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

  expect(screen.getByText('rename ambiguous variable')).toBeInTheDocument();
});

test('every panel exposes a help control that opens a scoped manual', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /open manual for preview/i }));

  expect(screen.getByRole('dialog', { name: /manual for preview/i })).toBeInTheDocument();
  expect(screen.getByText('manual · preview')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /close manual/i }));
  expect(screen.queryByRole('dialog', { name: /manual for preview/i })).not.toBeInTheDocument();

  expect(screen.getByRole('button', { name: /open manual for chat/i })).toBeInTheDocument();
});

test('every panel exposes a settings gear that opens a scoped settings dialog', () => {
  render(<App />);

  const previewGear = screen.getByRole('button', { name: /open settings for preview/i });
  fireEvent.click(previewGear);

  expect(screen.getByRole('dialog', { name: /settings for preview/i })).toBeInTheDocument();
  expect(screen.getByText('settings · preview')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /close settings/i }));
  expect(screen.queryByRole('dialog', { name: /settings for preview/i })).not.toBeInTheDocument();

  expect(screen.getByRole('button', { name: /open settings for chat/i })).toBeInTheDocument();
});

test('history fuses into the diff tab with restore and revert affordances', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /\+- diff/i }));

  expect(screen.getByText('changed files')).toBeInTheDocument();
  expect(screen.getByText('agent snapshots')).toBeInTheDocument();
  expect(screen.getByText('working tree vs HEAD')).toBeInTheDocument();
  expect(screen.getByText('HEAD')).toBeInTheDocument();
  expect(screen.getAllByText('working tree').length).toBeGreaterThan(1);
  expect(screen.getByRole('button', { name: /working tree/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^branch$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /agent task/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /compare/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /fork from here/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /revert\.\.\./i })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: /src\/workspaces\/presets\.ts/i }));
  expect(screen.getAllByText('src/workspaces/presets.ts').length).toBeGreaterThan(1);

  fireEvent.click(screen.getByRole('button', { name: /^compare$/i }));
  expect(screen.getByRole('dialog', { name: /compare refs/i })).toBeInTheDocument();
  expect(screen.getByText('base')).toBeInTheDocument();
  expect(screen.getByText('target')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /agent · phase-change/i }));
  expect(screen.getAllByText('restore point snapshot vs working tree').length).toBeGreaterThan(0);
  expect(screen.getByText(/agent snapshot selected/i)).toBeInTheDocument();
  expect(screen.getByText('snapshot')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /revert\.\.\./i }));
  expect(screen.getByRole('dialog', { name: /confirm revert/i })).toBeInTheDocument();
});

test('a new tab can be added and closed via the browser-style controls', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /open new tab/i }));
  const popoverChoice = screen.getAllByRole('button', { name: /\$ terminal/i });
  fireEvent.click(popoverChoice[popoverChoice.length - 1]);

  const terminalTabs = screen.getAllByRole('tab', { name: /\$ terminal/i });
  expect(terminalTabs.length).toBeGreaterThanOrEqual(2);

  const newTab = terminalTabs[terminalTabs.length - 1];
  expect(newTab).toHaveAttribute('aria-selected', 'true');

  const closeButtons = screen.getAllByRole('button', { name: /close terminal/i });
  fireEvent.click(closeButtons[closeButtons.length - 1]);

  expect(screen.getAllByRole('tab', { name: /\$ terminal/i }).length).toBe(terminalTabs.length - 1);
});
