declare module "virtual:configuration-content" {
  export function mount(host: {
    element: HTMLElement;
    active: () => boolean;
    memory: () => HTMLElement;
    chat: () => HTMLElement;
    browser: () => HTMLElement;
    configuredReasoningEffort: typeof import("../../src/agent-options.ts").configuredReasoningEffort;
    reasoningOverride: typeof import("../../src/agent-options.ts").reasoningOverride;
    settings: (state: import("./settings-editor.tsx").SettingsEditorState) => void;
  }): {
    transport: import('./workspace-transport.ts').WorkspaceTransport;
    activate: (language: string) => void;
    language: (language: string) => void;
    workspace: () => Promise<void>;
  };
}
