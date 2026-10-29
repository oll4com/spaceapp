import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MONITORING_ALWAYS_ASK_KINDS, MONITORING_COLLECTOR_DEFAULTS, MONITORING_COLLECTOR_NETWORK, NOTIFICATION_SOURCES, NEEDS_YOU_KINDS, monitoringActionBeginSchema, monitoringActionFinishSchema, PANE_TYPES, defaultMonitoringCopilotPaneMetadata, monitoringCollectorUrlSchema, monitoringCopilotPaneMetadataSchema,
  monitoringGuardianKey, monitoringGuardianLevel, monitoringLogQuerySchema, monitoringPromQuerySchema, monitoringSeverityOf, paneModeSchema,
  resolveMonitoringCopilotPaneMetadata, roomPaneBatchItemSchema
} from "../src/index.js";

describe("Monitoring Copilot contracts", () => {
  it("is a pane mode and a notification source whose defaults point at the collector CT and keep Telegram with the collector", () => {
    expect(paneModeSchema.parse("MONITORING_COPILOT")).toBe("MONITORING_COPILOT");
    expect(NOTIFICATION_SOURCES).toContain("MONITORING_COPILOT");
    expect(PANE_TYPES.find((type) => type.typeId === "monitoring")?.mode).toBe("MONITORING_COPILOT");
    expect(roomPaneBatchItemSchema.parse({ mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" }).mode).toBe("MONITORING_COPILOT");
    const settings = defaultMonitoringCopilotPaneMetadata().settings;
    expect(settings).toMatchObject({ paused: false, autonomy: "ASSIST", collector: MONITORING_COLLECTOR_DEFAULTS });
    expect(settings.notifications).toEqual({ critical: true, warning: true, guardian: true, telegram: false });
    expect(resolveMonitoringCopilotPaneMetadata(null)).toEqual(defaultMonitoringCopilotPaneMetadata());
    expect(monitoringCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { unknown: true } }).success).toBe(false);
  });

  it("accepts only a collector on the private bridge over plain HTTP with a port", () => {
    for (const ok of ["http://192.0.2.210:9093", "http://192.0.2.202:3100", "http://192.0.2.1:9100"]) expect(monitoringCollectorUrlSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["https://192.0.2.210:9093", "http://192.0.2.210", "http://192.0.2.255:80", "http://192.0.2.0:80", "http://10.101.0.3:9090",
      "http://example.com:9090", "http://192.0.2.210:9093/api", "http://user@192.0.2.210:9093", "http://169.254.169.254:80", "http://127.0.0.1:9090"]) {
      expect(monitoringCollectorUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  // EXP-001: the public export rewrites plain addresses but not a regex-escaped copy, so the network lives in one plain string.
  it("builds the collector pattern from the one plain network string, so the public export rewrites both alike", () => {
    expect(monitoringCollectorUrlSchema.safeParse(`http://${MONITORING_COLLECTOR_NETWORK}210:9093`).success).toBe(true);
    for (const url of Object.values(MONITORING_COLLECTOR_DEFAULTS)) expect(monitoringCollectorUrlSchema.safeParse(url).success, url).toBe(true);
    expect(readFileSync(new URL("../src/monitoring-copilot.ts", import.meta.url), "utf8")).not.toMatch(/\d+\\\.\d+\\\.\d+\\\./);
  });

  it("maps severities and classifies guardian messages", () => {
    expect(monitoringSeverityOf("critical")).toBe("CRITICAL");
    expect(monitoringSeverityOf("Warning")).toBe("WARNING");
    expect(monitoringSeverityOf(undefined)).toBe("INFO");
    expect(monitoringGuardianLevel("BACKUP ALERT on pve 2026-10-25T13:00:02+02:00:")).toBe("ALERT");
    expect(monitoringGuardianLevel("BACKUP ALERT: Proxmox vzdump FAILED on pve VM 100")).toBe("ALERT");
    expect(monitoringGuardianLevel("OVPN DOWN (openwrt-th) reason=stale_last_ref")).toBe("ALERT");
    expect(monitoringGuardianLevel("OVPN UP (office-mikrotik) reason=client_present")).toBe("RECOVERY");
    expect(monitoringGuardianLevel("MIKROTIK WAN UP: 5 script,info MainWAN")).toBe("RECOVERY");
    expect(monitoringGuardianLevel("AI Guardian BulkGate SMS: new recovered event(s): 2")).toBe("RECOVERY");
    expect(monitoringGuardianLevel("AI Guardian REPORT: host post-boot summary host=pve")).toBe("INFO");
    // Repeats of one kind of message share a key (digits and dates fold); different kinds do not.
    expect(monitoringGuardianKey("[2026-10-25T13:00:02+02:00] BACKUP ALERT on pve 2026-10-25T13:00:02+02:00:"))
      .toBe(monitoringGuardianKey("[2026-10-25T13:30:02+02:00] BACKUP ALERT on pve 2026-10-25T13:30:02+02:00:"));
    expect(monitoringGuardianKey("OVPN DOWN (office-mikrotik)")).not.toBe(monitoringGuardianKey("OVPN UP (office-mikrotik)"));
  });

  it("bounds queries and never lets a log query return raw lines", () => {
    expect(monitoringPromQuerySchema.parse({ query: "up == 0", range: { minutes: 60, stepSeconds: 60 } }).range).toEqual({ minutes: 60, stepSeconds: 60 });
    expect(monitoringPromQuerySchema.safeParse({ query: "up", range: { minutes: 1440, stepSeconds: 15 } }).success).toBe(false);
    expect(monitoringPromQuerySchema.safeParse({ query: "up", range: { minutes: 2000, stepSeconds: 3600 } }).success).toBe(false);
    expect(monitoringLogQuerySchema.parse({ query: 'sum(count_over_time({job="vm100_web"} |= "dv5.example.invalid" [5m]))' }).query).toContain("count_over_time");
    expect(monitoringLogQuerySchema.safeParse({ query: '{job="vm100_web"} |= "dv5.example.invalid"' }).success).toBe(false);
    // Parser stages would carry line text out as label values.
    expect(monitoringLogQuerySchema.safeParse({ query: 'sum by (msg) (count_over_time({job="vm100_web"} | regexp "(?P<msg>.*)" [5m]))' }).success).toBe(false);
    expect(monitoringLogQuerySchema.safeParse({ query: 'sum by (path) (count_over_time({job="vm100_web"} | json [5m]))' }).success).toBe(false);
    expect(monitoringLogQuerySchema.safeParse({ query: 'sum(count_over_time({job="vm100_web"} |~ "HTTP/1.1\\" 5.." [5m]))' }).success).toBe(true);
  });

  it("names every self-healing change: where, which alerts, what, how to undo it; reboots, deletes and free-form commands always ask", () => {
    expect(monitoringActionBeginSchema.parse({ target: "qm:100", kind: "GUEST_START", summary: "Start public-host", commands: "ssh pve qm start 100" }))
      .toMatchObject({ alertIds: [], backup: "", rollback: "" });
    for (const target of ["pve", "local", "pct:210", "vm100", "olla-gr.web"]) expect(monitoringActionBeginSchema.shape.target.safeParse(target).success, target).toBe(true);
    for (const target of ["root@pve", "qm:1", "pve; reboot", "-oProxyCommand=x", ""]) expect(monitoringActionBeginSchema.shape.target.safeParse(target).success, target).toBe(false);
    expect(monitoringActionBeginSchema.safeParse({ target: "pve", kind: "REBOOT", summary: "x", commands: "x" }).success).toBe(false);
    expect(monitoringActionFinishSchema.safeParse({ status: "RUNNING", verification: "x" }).success).toBe(false);
    expect([...MONITORING_ALWAYS_ASK_KINDS]).toEqual(["HOST_REBOOT", "DATA_DELETE", "OTHER"]);
    expect(NEEDS_YOU_KINDS.test("MONITORING_REVIEW")).toBe(true);
    expect(NEEDS_YOU_KINDS.test("MONITORING_ACTION_FAILED")).toBe(false);
  });
});
