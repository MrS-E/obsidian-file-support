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

export class Component {
  private _loaded: boolean = false;
  private _children: Component[] = [];
  private _callbacks: Array<() => any> = [];

  load(): void {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
    for (const child of this._children) {
      child.load();
    }
  }

  onload(): void {}

  unload(): void {
    if (!this._loaded) {
      // Still run onunload and callbacks even if load() wasn't explicitly called
      this.onunload();
    } else {
      this._loaded = false;
      this.onunload();
    }
    for (const child of [...this._children]) {
      child.unload();
    }
    this._children = [];
    for (const cb of this._callbacks.splice(0)) {
      try {
        cb();
      } catch {
        // Ignore cleanup callback errors
      }
    }
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    this._children.push(component);
    if (this._loaded) {
      component.load();
    }
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const idx = this._children.indexOf(component);
    if (idx !== -1) {
      this._children.splice(idx, 1);
      component.unload();
    }
    return component;
  }

  register(cb: () => any): void {
    this._callbacks.push(cb);
  }

  registerEvent(_eventRef: any): void {}

  registerDomEvent(
    el: any,
    type: string,
    callback: any,
    options?: any
  ): void {
    if (el && typeof el.addEventListener === "function") {
      el.addEventListener(type, callback, options);
      this.register(() => el.removeEventListener?.(type, callback, options));
    }
  }

  registerInterval(id: number): number {
    return id;
  }
}

export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}

export class Plugin extends Component {
  app: App;
  manifest: any;
  private _data: any = {};
  _views: Record<string, (leaf: WorkspaceLeaf) => any> = {};
  _registeredExtensions: Array<{ extensions: string[]; viewType: string }> = [];
  _postProcessors: any[] = [];
  _editorExtensions: any[] = [];

  constructor(app?: App, manifest?: any) {
    super();
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
  registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => any): void {
    this._views[type] = viewCreator;
  }
  registerExtensions(extensions: string[], viewType: string): void {
    this._registeredExtensions.push({ extensions: [...extensions], viewType });
  }
  registerMarkdownPostProcessor(postProcessor: any, _sortOrder?: number): any {
    this._postProcessors.push(postProcessor);
    return postProcessor;
  }
  registerEditorExtension(extension: any): void {
    this._editorExtensions.push(extension);
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
    removeChild(child: any) {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
      }
      return child;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    setAttribute(name: string, val: string) {
      attributes[name] = val;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    removeAttribute(name: string) {
      delete attributes[name];
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
  openFile = async (_file: TFile) => {};
}

export class ItemView extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  contentEl: any;
  _actions: Array<{ icon: string; title: string; callback: (evt: any) => any; el: any }> = [];

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = new App();
    this.contentEl = createMockElement("div");
  }

  getViewType(): string {
    return "";
  }

  getDisplayText(): string {
    return "";
  }

  getIcon(): string {
    return "document";
  }

  addAction(icon: string, title: string, callback: (evt: MouseEvent) => any): any {
    const actionEl = createMockElement("a");
    actionEl.setAttribute("aria-label", title);
    actionEl.setAttribute("data-icon", icon);
    actionEl.addEventListener("click", callback);
    this._actions.push({ icon, title, callback, el: actionEl });
    return actionEl;
  }
}

export class FileView extends ItemView {
  allowNoFile: boolean = false;
  file: TFile | null = null;
  navigation: boolean = true;

  canAcceptExtension(_extension: string): boolean {
    return true;
  }
}

export class TextFileView extends FileView {
  data: string = "";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.file = file;
    const content = await this.app.vault.read(file);
    this.setViewData(content, true);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.clear();
  }

  async save(_clear?: boolean): Promise<void> {
    if (this.file) {
      await this.app.vault.modify(this.file, this.getViewData());
    }
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
}

export function setIcon(parent: any, iconId: string): void {
  if (parent && typeof parent.setAttribute === "function") {
    parent.setAttribute("data-icon", iconId);
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

export function createMockLeaf(): any {
  return new WorkspaceLeaf();
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
