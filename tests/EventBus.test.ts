import { describe, expect, it, vi } from "vitest";
import {
  createMockApp,
  createMockElement,
  createMockTFile,
} from "./__mocks__/obsidian";
import { EventBus, FileSupportEventBus } from "../src/core/EventBus";
import { createDefaultFileTypeConfigs } from "../src/core/FileTypeRegistry";
import { createDefaultSettings } from "../src/settings/PluginSettings";

describe("EventBus", () => {
  it("supports typed pub/sub across core plugin events", async () => {
    const bus = new FileSupportEventBus();
    const app = createMockApp() as any;
    const logFile = createMockTFile("logs/server.log") as any;
    const logConfig = createDefaultFileTypeConfigs().log;
    const containerEl = createMockElement("div") as HTMLElement;

    const openSpy = vi.fn();
    const embedSpy = vi.fn();
    const treeSpy = vi.fn();
    const resolveSpy = vi.fn();
    const extractSpy = vi.fn();
    const configSpy = vi.fn();

    bus.on("file:open", openSpy);
    bus.on("file:embed", embedSpy);
    bus.on("tree:decorate", treeSpy);
    bus.on("metadata:resolve", resolveSpy);
    bus.on("metadata:extract", extractSpy);
    bus.on("config:updated", configSpy);

    await bus.emit("file:open", {
      app,
      file: logFile,
      config: logConfig,
      containerEl,
      mode: "readonly",
    });

    await bus.emit("file:embed", {
      app,
      file: logFile,
      config: logConfig,
      containerEl,
      mode: "readonly",
    });

    await bus.emit("tree:decorate", {
      app,
      containerEl,
      filePaths: ["logs/server.log"],
    });

    await bus.emit("metadata:resolve", {
      app,
      targetFile: logFile,
    });

    await bus.emit("metadata:extract", {
      app,
      targetFile: logFile,
      companionFile: createMockTFile("logs/server.md") as any,
      config: logConfig,
    });

    await bus.emit("config:updated", {
      settings: createDefaultSettings(),
      changedExtensions: ["log"],
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(treeSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(configSpy).toHaveBeenCalledTimes(1);
    expect(configSpy.mock.calls[0][0].changedExtensions).toEqual(["log"]);
  });

  it("executes global and event-scoped middlewares in registration order before listeners", async () => {
    const bus = new EventBus();
    const order: string[] = [];

    bus.use(async (event, _payload, next) => {
      order.push(`global:before:${event}`);
      await next();
      order.push(`global:after:${event}`);
    });

    bus.use("metadata:resolve", async (payload, next) => {
      order.push("mw1:before");
      await new Promise((r) => setTimeout(r, 5));
      payload.pair = {
        targetFile: payload.targetFile,
        companionFile: null,
        expectedCompanionPath: "logs/app.md",
        usedFallbackName: false,
      };
      await next();
      order.push("mw1:after");
    });

    bus.use("metadata:resolve", async (_payload, next) => {
      order.push("mw2:before");
      await next();
      order.push("mw2:after");
    });

    bus.on("metadata:resolve", (payload) => {
      order.push(`listener:${payload.pair?.expectedCompanionPath}`);
    });

    const result = await bus.emit("metadata:resolve", {
      app: createMockApp() as any,
      targetFile: createMockTFile("logs/app.log") as any,
    });

    expect(result.pair?.expectedCompanionPath).toBe("logs/app.md");
    expect(order).toEqual([
      "global:before:metadata:resolve",
      "mw1:before",
      "mw2:before",
      "listener:logs/app.md",
      "mw2:after",
      "mw1:after",
      "global:after:metadata:resolve",
    ]);
  });

  it("short-circuits downstream middlewares and listeners when next() is not called", async () => {
    const bus = new EventBus();
    const downstreamMw = vi.fn(async (_payload, next) => {
      await next();
    });
    const listener = vi.fn();

    bus.use("file:open", async (_payload, _next) => {
      // Intentionally do not call next()
    });
    bus.use("file:open", downstreamMw);
    bus.on("file:open", listener);

    await bus.emit("file:open", {
      app: createMockApp() as any,
      file: createMockTFile("main.c") as any,
      config: createDefaultFileTypeConfigs().c,
      containerEl: createMockElement("div") as HTMLElement,
      mode: "editable",
    });

    expect(downstreamMw).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects if a middleware calls next() multiple times", async () => {
    const bus = new EventBus();

    bus.use("config:updated", async (_payload, next) => {
      await next();
      await next();
    });

    await expect(
      bus.emit("config:updated", { settings: createDefaultSettings() })
    ).rejects.toThrow(/next\(\) called multiple times/);
  });

  it("supports once(), off(), unsubscribe functions, and clear()", async () => {
    const bus = new EventBus();
    const onceHandler = vi.fn();
    const regularHandler = vi.fn();
    const mwSpy = vi.fn(async (_payload, next) => {
      await next();
    });

    bus.once("config:updated", onceHandler);
    const unsubListener = bus.on("config:updated", regularHandler);
    const unsubMw = bus.use("config:updated", mwSpy);

    expect(bus.listenerCount("config:updated")).toBe(2);
    expect(bus.middlewareCount("config:updated")).toBe(1);

    await bus.emit("config:updated", { settings: createDefaultSettings() });

    expect(onceHandler).toHaveBeenCalledTimes(1);
    expect(regularHandler).toHaveBeenCalledTimes(1);
    expect(mwSpy).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount("config:updated")).toBe(1);

    unsubListener();
    unsubMw();

    expect(bus.listenerCount("config:updated")).toBe(0);
    expect(bus.middlewareCount("config:updated")).toBe(0);

    await bus.emit("config:updated", { settings: createDefaultSettings() });

    expect(regularHandler).toHaveBeenCalledTimes(1);
    expect(mwSpy).toHaveBeenCalledTimes(1);

    bus.on("tree:decorate", () => {});
    bus.clear();
    expect(bus.listenerCount("tree:decorate")).toBe(0);
  });
});
