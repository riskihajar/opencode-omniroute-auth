import {
  getStripOpenCodeSystemPromptStatus,
  setStripOpenCodeSystemPromptStatus,
  toggleStripOpenCodeSystemPromptStatus,
} from './opencode-config.js';

type TuiCommand = {
  id?: string;
  title: string;
  description?: string;
  category?: string;
  value: string;
  slash?: {
    name: string;
  };
  onSelect?: () => void | Promise<void>;
};

type TuiApi = {
  command?: {
    register?: (commands: () => TuiCommand[] | Promise<TuiCommand[]>) => () => void;
  };
  lifecycle?: {
    onDispose?: (callback: () => void) => void;
  };
  slots?: {
    register?: (plugin: unknown) => string;
  };
  ui?: {
    toast?: (input: { message: string; variant?: 'info' | 'success' | 'warning' | 'error' }) => void;
  };
};

let renderStatusElement: (label: string) => unknown = (label) => label;
let getLiveStatusLabel: () => string = getStatusLabelFromConfig;
let setLiveStatus: (enabled: boolean) => void = () => {};

export async function tui(api: TuiApi): Promise<void> {
  const disposers: Array<() => void> = [];
  await loadOpenTuiRenderer();

  const unregisterCommands = api.command?.register?.(() => [
    {
      title: 'Toggle OpenCode prompt stripping',
      description: `Currently ${getStatusLabel()}. Switch whether OmniRoute forwards the OpenCode system prompt.`,
      category: 'OmniRoute',
      value: 'omniroute-system-prompt-toggle',
      slash: {
        name: 'omniroute-system-prompt-toggle',
      },
      onSelect: () => {
        const next = toggleStripOpenCodeSystemPromptStatus();
        setLiveStatus(next);
        showToast(api, next);
      },
    },
    {
      title: 'Enable OpenCode prompt stripping',
      description: 'Strip the OpenCode system prompt before OmniRoute requests.',
      category: 'OmniRoute',
      value: 'omniroute-system-prompt-on',
      slash: {
        name: 'omniroute-system-prompt-on',
      },
      onSelect: () => {
        const next = setStripOpenCodeSystemPromptStatus(true);
        setLiveStatus(next);
        showToast(api, next);
      },
    },
    {
      title: 'Disable OpenCode prompt stripping',
      description: 'Forward the OpenCode system prompt normally.',
      category: 'OmniRoute',
      value: 'omniroute-system-prompt-off',
      slash: {
        name: 'omniroute-system-prompt-off',
      },
      onSelect: () => {
        const next = setStripOpenCodeSystemPromptStatus(false);
        setLiveStatus(next);
        showToast(api, next);
      },
    },
  ]);
  if (unregisterCommands) {
    disposers.push(unregisterCommands);
  }

  api.slots?.register?.({
    slots: {
      home_footer: renderStatusLine,
      sidebar_footer: renderStatusLine,
    },
  });

  api.lifecycle?.onDispose?.(() => {
    for (const dispose of disposers) {
      dispose();
    }
  });
}

function renderStatusLine(): unknown {
  return renderStatusElement(`OpenCode prompt strip ${getStatusLabel()}`);
}

function getStatusLabel(): string {
  return getLiveStatusLabel();
}

function getStatusLabelFromConfig(): string {
  return getStripOpenCodeSystemPromptStatus() ? 'ON' : 'OFF';
}

function showToast(api: TuiApi, enabled: boolean): void {
  api.ui?.toast?.({
    message: `OpenCode system prompt stripping ${enabled ? 'enabled' : 'disabled'}`,
    variant: 'success',
  });
}

async function loadOpenTuiRenderer(): Promise<void> {
  if (!('Bun' in globalThis)) {
    return;
  }

  const { createElement, insert } = await import('@opentui/solid');
  const { createSignal } = await import('solid-js');
  const [enabled, setEnabled] = createSignal(getStripOpenCodeSystemPromptStatus());

  getLiveStatusLabel = () => (enabled() ? 'ON' : 'OFF');
  setLiveStatus = setEnabled;
  renderStatusElement = () => {
    const element = createElement('text');
    insert(element, () => `OpenCode prompt strip ${enabled() ? 'ON' : 'OFF'}`);
    return element;
  };
}
