export class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null = null;
  vault: any = null;

  constructor(path: string = "") {
    this.path = path;
    const parts = path.split("/");
    this.name = parts[parts.length - 1] ?? "";
  }
}

export class TFile extends TAbstractFile {
  stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  basename: string;
  extension: string;

  constructor(path: string = "") {
    super(path);
    const dotIndex = this.name.lastIndexOf(".");
    if (dotIndex > 0) {
      this.basename = this.name.slice(0, dotIndex);
      this.extension = this.name.slice(dotIndex + 1);
    } else {
      this.basename = this.name;
      this.extension = "";
    }
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "" || this.path === "/";
  }
}

export class Plugin {
  app: App;
  manifest: any;
  private _data: any = {};

  constructor(app?: App, manifest?: any) {
    this.app = app ?? new App();
    this.manifest = manifest ?? { id: "obsidian-file-support", name: "File Support", version: "0.1.0" };
  }

  async loadData(): Promise<any> {
    return this._data;
  }

  async saveData(data: any): Promise<void> {
    this._data = data;
  }

  addSettingTab(_settingTab: PluginSettingTab): void {}
  addCommand(_command: any): any {
    return _command;
  }
  registerView(_type: string, _viewCreator: any): void {}
  registerExtensions(_extensions: string[], _viewType: string): void {}
  registerEvent(_eventRef: any): void {}
  registerDomEvent(_el: any, _type: string, _callback: any, _options?: any): void {}
  registerMarkdownPostProcessor(_postProcessor: any, _sortOrder?: number): any {
    return _postProcessor;
  }
}

export class PluginSettingTab {
  app: App;
  plugin: any;
  containerEl: any;

  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createMockElement("div");
  }

  display(): void {}
  hide(): void {}
}

export function createMockElement(tag: string = "div"): any {
  const classes = new Set<string>();
  const children: any[] = [];
  const listeners: Record<string, Function[]> = {};
  const attributes: Record<string, string> = {};

  const el: any = {
    tagName: tag.toUpperCase(),
    textContent: "",
    innerHTML: "",
    value: "",
    children,
    style: {},
    dataset: {},
    classList: {
      add: (...cls: string[]) => cls.forEach((c) => classes.add(c)),
      remove: (...cls: string[]) => cls.forEach((c) => classes.delete(c)),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(c)) {
            classes.delete(c);
            return false;
          }
          classes.add(c);
          return true;
        }
        if (force) classes.add(c);
        else classes.delete(c);
        return force;
      },
    },
    empty() {
      children.length = 0;
      if (Array.isArray(el._settings)) {
        el._settings.length = 0;
      }
      el.textContent = "";
      el.innerHTML = "";
    },
    createEl(childTag: string, opts?: any) {
      const child = createMockElement(childTag);
      if (opts?.text) child.textContent = opts.text;
      if (opts?.cls) {
        const clsList = Array.isArray(opts.cls) ? opts.cls : String(opts.cls).split(/\s+/);
        clsList.filter(Boolean).forEach((c: string) => child.classList.add(c));
      }
      if (opts?.attr) {
        Object.entries(opts.attr).forEach(([k, v]) => child.setAttribute(k, String(v)));
      }
      children.push(child);
      return child;
    },
    createDiv(opts?: any) {
      return el.createEl("div", opts);
    },
    createSpan(opts?: any) {
      return el.createEl("span", opts);
    },
    appendChild(child: any) {
      children.push(child);
      return child;
    },
    setAttribute(name: string, val: string) {
      attributes[name] = val;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    addEventListener(type: string, fn: Function) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener(type: string, fn: Function) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatchEvent(evt: any) {
      const fns = listeners[evt.type] ?? [];
      fns.forEach((fn) => fn(evt));
    },
  };
  return el;
}

export class Setting {
  settingEl: any;
  nameEl: any;
  descEl: any;
  controlEl: any;
  components: any[] = [];

  constructor(containerEl: any) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.settingEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
    if (!containerEl._settings) containerEl._settings = [];
    containerEl._settings.push(this);
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }

  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }

  addText(cb: (component: any) => any): this {
    const inputEl = createMockElement("input");
    let onChangeFn: ((value: string) => any) | undefined;
    const component = {
      inputEl,
      value: "",
      placeholder: "",
      setPlaceholder(p: string) {
        this.placeholder = p;
        return this;
      },
      setValue(v: string) {
        this.value = v;
        inputEl.value = v;
        return this;
      },
      getValue() {
        return this.value;
      },
      onChange(fn: (value: string) => any) {
        onChangeFn = fn;
        return this;
      },
      triggerChange(v: string) {
        this.value = v;
        inputEl.value = v;
        return onChangeFn?.(v);
      },
    };
    this.components.push({ type: "text", component });
    cb(component);
    return this;
  }

  addToggle(cb: (component: any) => any): this {
    let onChangeFn: ((value: boolean) => any) | undefined;
    const component = {
      value: false,
      setValue(v: boolean) {
        this.value = v;
        return this;
      },
      getValue() {
        return this.value;
      },
      setTooltip(_t: string) {
        return this;
      },
      onChange(fn: (value: boolean) => any) {
        onChangeFn = fn;
        return this;
      },
      triggerChange(v: boolean) {
        this.value = v;
        return onChangeFn?.(v);
      },
    };
    this.components.push({ type: "toggle", component });
    cb(component);
    return this;
  }

  addDropdown(cb: (component: any) => any): this {
    let onChangeFn: ((value: string) => any) | undefined;
    const options: Record<string, string> = {};
    const component = {
      value: "",
      options,
      addOption(val: string, display: string) {
        options[val] = display;
        return this;
      },
      addOptions(opts: Record<string, string>) {
        Object.assign(options, opts);
        return this;
      },
      setValue(v: string) {
        this.value = v;
        return this;
      },
      getValue() {
        return this.value;
      },
      onChange(fn: (value: string) => any) {
        onChangeFn = fn;
        return this;
      },
      triggerChange(v: string) {
        this.value = v;
        return onChangeFn?.(v);
      },
    };
    this.components.push({ type: "dropdown", component });
    cb(component);
    return this;
  }

  addButton(cb: (component: any) => any): this {
    let onClickFn: (() => any) | undefined;
    const buttonEl = createMockElement("button");
    const component = {
      buttonEl,
      buttonText: "",
      icon: "",
      setButtonText(t: string) {
        this.buttonText = t;
        buttonEl.textContent = t;
        return this;
      },
      setIcon(i: string) {
        this.icon = i;
        return this;
      },
      setTooltip(_t: string) {
        return this;
      },
      setCta() {
        return this;
      },
      setWarning() {
        return this;
      },
      onClick(fn: () => any) {
        onClickFn = fn;
        return this;
      },
      triggerClick() {
        return onClickFn?.();
      },
    };
    this.components.push({ type: "button", component });
    cb(component);
    return this;
  }

  addExtraButton(cb: (component: any) => any): this {
    let onClickFn: (() => any) | undefined;
    const extraSettingsEl = createMockElement("div");
    const component = {
      extraSettingsEl,
      icon: "",
      setIcon(i: string) {
        this.icon = i;
        return this;
      },
      setTooltip(_t: string) {
        return this;
      },
      onClick(fn: () => any) {
        onClickFn = fn;
        return this;
      },
      triggerClick() {
        return onClickFn?.();
      },
    };
    this.components.push({ type: "extraButton", component });
    cb(component);
    return this;
  }
}

export class WorkspaceLeaf {
  view: any = null;
}

export class TextFileView {
  app: App;
  leaf: WorkspaceLeaf;
  file: TFile | null = null;
  data: string = "";
  contentEl: any;

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = new App();
    this.contentEl = createMockElement("div");
  }

  getViewData(): string {
    return this.data;
  }

  setViewData(data: string, _clear: boolean): void {
    this.data = data;
  }

  clear(): void {
    this.data = "";
  }

  requestSave(): void {}

  addAction(_icon: string, _title: string, _callback: (evt: MouseEvent) => any): any {
    return createMockElement("a");
  }
}

export class Notice {
  static instances: Notice[] = [];
  message: string;

  static clear(): void {
    Notice.instances = [];
  }

  constructor(message: string) {
    this.message = message;
    Notice.instances.push(this);
  }
}

export class App {
  vault: any = {
    getAbstractFileByPath: (_path: string) => null,
    read: async (_file: TFile) => "",
    modify: async (_file: TFile, _data: string) => {},
    create: async (path: string, _data: string) => new TFile(path),
    rename: async (_file: TAbstractFile, _newPath: string) => {},
    on: () => ({}),
  };
  metadataCache: any = {
    getFileCache: (_file: TFile) => null,
    getFirstLinkpathDest: (_linkpath: string, _sourcePath: string) => null,
    on: () => ({}),
  };
  fileManager: any = {
    processFrontMatter: async (_file: TFile, _fn: (fm: Record<string, any>) => void) => {},
    renameFile: async (_file: TAbstractFile, _newPath: string) => {},
  };
  workspace: any = {
    getLeavesOfType: (_type: string) => [],
    getLeaf: (_newLeaf?: boolean) => new WorkspaceLeaf(),
    on: () => ({}),
    onLayoutReady: (cb: () => void) => cb(),
  };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function createMockTFile(path: string): TFile {
  return new TFile(path);
}

export function createMockApp(): App {
  return new App();
}

export function createMockManifest(): any {
  return {
    id: "obsidian-file-support",
    name: "File Support",
    version: "0.1.0",
    minAppVersion: "1.5.0",
    description: "File Support test manifest",
    author: "Test",
  };
}
