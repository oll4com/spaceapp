import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MONITORING_ALWAYS_ASK_KINDS, NOTIFICATION_SOURCES, NEEDS_YOU_KINDS, monitoringActionBeginSchema, monitoringActionFinishSchema, PANE_TYPES, defaultMonitoringCopilotPaneMetadata, monitoringCollectorDefaults, monitoringCollectorUrlAllowed, monitoringCollectorUrlSchema, monitoringCopilotPaneMetadataSchema,
  monitoringGuardianKey, monitoringGuardianLevel, monitoringGuardianRecovers, monitoringGuardianSubject, monitoringLogQuerySchema, monitoringPromQuerySchema, monitoringSeverityOf, paneModeSchema,
  parseMonitoringCollectorNetwork, resolveMonitoringCopilotPaneMetadata, roomPaneBatchItemSchema
} from "../src/index.js";

describe("Monitoring Copilot contracts", () => {
  it("is a pane mode and a notification source whose collector is unset until the installation or its Setup names one, and keeps Telegram with the collector", () => {
    expect(paneModeSchema.parse("MONITORING_COPILOT")).toBe("MONITORING_COPILOT");
    expect(NOTIFICATION_SOURCES).toContain("MONITORING_COPILOT");
    expect(PANE_TYPES.find((type) => type.typeId === "monitoring")?.mode).toBe("MONITORING_COPILOT");
    expect(roomPaneBatchItemSchema.parse({ mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" }).mode).toBe("MONITORING_COPILOT");
    const settings = defaultMonitoringCopilotPaneMetadata().settings;
    expect(settings).toMatchObject({ paused: false, autonomy: "ASSIST", collector: { prometheusUrl: "", alertmanagerUrl: "", lokiUrl: "" } });
    expect(settings.notifications).toEqual({ critical: true, warning: true, guardian: true, telegram: false });
    expect(resolveMonitoringCopilotPaneMetadata(null)).toEqual(defaultMonitoringCopilotPaneMetadata());
    expect(monitoringCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { unknown: true } }).success).toBe(false);
  });

  it("accepts only a collector on a private network over plain HTTP with a port", () => {
    for (const ok of ["http://10.20.30.210:9093", "http://172.20.0.5:3100", "http://192.168.50.10:9090", "http://10.20.30.1:65535"]) expect(monitoringCollectorUrlSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["https://10.20.30.210:9093", "http://10.20.30.210", "http://10.20.30.255:80", "http://10.20.30.0:80", "http://172.32.0.5:9090", "http://192.0.2.10:9090",
      "http://example.com:9090", "http://10.20.30.210:9093/api", "http://user@10.20.30.210:9093", "http://169.254.169.254:80", "http://127.0.0.1:9090",
      "http://010.20.30.1:9090", "http://10.20.30.1:70000", ""]) {
      expect(monitoringCollectorUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  // MON-001: which network and which addresses are the installation's configuration; the contract names none of ours, so a public
  // install reaches a collector on its own network (the export had turned the old fixed network into 192.0.2.x, which nothing serves).
  it("narrows to the configured network and names no network of ours", () => {
    expect(monitoringCollectorUrlAllowed("http://192.168.50.10:9093", null)).toBe(true);
    expect(monitoringCollectorUrlAllowed("http://10.20.30.40:9093", "10.20.30.0/24")).toBe(true);
    expect(monitoringCollectorUrlAllowed("http://10.20.31.40:9093", "10.20.30.0/24")).toBe(false);
    expect(monitoringCollectorUrlAllowed("http://10.20.31.40:9093", "10.20.0.0/16")).toBe(true);
    expect(monitoringCollectorUrlAllowed("http://8.8.8.8:9093", "0.0.0.0/0")).toBe(false);
    expect(monitoringCollectorUrlAllowed("http://10.20.30.40:9093", "not a network")).toBe(false);
    expect(parseMonitoringCollectorNetwork("10.20.30.7/24")).toEqual({ first: ((10 * 256 + 20) * 256 + 30) * 256, size: 256 });
    expect(parseMonitoringCollectorNetwork("10.20.30.0/33")).toBeNull();
    expect(monitoringCollectorDefaults("192.168.50.10")).toEqual({ prometheusUrl: "http://192.168.50.10:9090", alertmanagerUrl: "http://192.168.50.10:9093", lokiUrl: "http://192.168.50.10:3100" });
    expect(monitoringCopilotPaneMetadataSchema.parse({ version: 1, settings: { collector: { alertmanagerUrl: "http://192.168.50.10:9093" } } }).settings.collector)
      .toEqual({ prometheusUrl: "", alertmanagerUrl: "http://192.168.50.10:9093", lokiUrl: "" });
    expect(readFileSync(new URL("../src/monitoring-copilot.ts", import.meta.url), "utf8")).not.toMatch(/192\.0\.2\./);
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
    // Each vzdump run's UPID is no part of the key (plan clipboard:ctqx7SPqkWR2 step 3).
    expect(monitoringGuardianKey("BACKUP ALERT: Proxmox vzdump FAILED on pve VM 101 (UPID:pve:0037D1A9:03C3F238:6AE679FC:vzdump:101:root@pam:) status=unexpected status"))
      .toBe("backup alert: proxmox vzdump failed on pve vm n status unexpected status");
    expect(monitoringGuardianKey("BACKUP ALERT: Proxmox vzdump FAILED on pve VM 101 (UPID:pve:0015C9B6:02CF8036:6AE40834:vzdump:101:root@pam:) status=unexpected status"))
      .toBe("backup alert: proxmox vzdump failed on pve vm n status unexpected status");
  });

  it("matches a guardian recovery to the alert it ends, worded differently (operator 2/11)", () => {
    // Real head lines of pve's guardian_notify.log (Loki, 30/10-2/11).
    expect(monitoringGuardianSubject("OVPN DOWN (openwrt-th) reason=stale_last_ref ping_tun=0 ping_lan=0")).toEqual(["ovpn", "openwrt-th"]);
    expect(monitoringGuardianRecovers("OVPN UP (openwrt-th) reason=client_present_last_ref_fresh ping_tun=1 ping_lan=1", "OVPN DOWN (openwrt-th) reason=stale_last_ref ping_tun=0 ping_lan=0")).toBe(true);
    expect(monitoringGuardianRecovers("OVPN UP (openwrt-th) reason=client_present_last_ref_fresh ping_tun=1 ping_lan=1", "OVPN DOWN (office-mikrotik) reason=degraded_client_present ping_tun=0 ping_mkt=0")).toBe(false);
    expect(monitoringGuardianRecovers("[tg_log_only] AI Guardian RECOVERY: dc01 lag monitor healthy again. prev=office_path_spike",
      "AI Guardian ALERT: dc01 lag recurrence detected. mode=office_path_spike cam_a=tun-cam cam_b=lan-cam")).toBe(true);
    expect(monitoringGuardianRecovers("MIKROTIK WAN UP: 10:22:40 script,info WAN1_UP 1.2.3.4", "MIKROTIK WAN DOWN: 10:22:33 script,warning WAN1_DOWN 1.2.3.4")).toBe(true);
    expect(monitoringGuardianRecovers("MIKROTIK WAN UP: 10:22:40 script,info WAN1_UP 1.2.3.4", "MIKROTIK WAN DOWN: 10:22:33 script,warning MainWAN_Down 8.8.8.8 is Down")).toBe(false);
    expect(monitoringGuardianRecovers("AI Guardian RECOVERY: host memory pressure normal. host=pve", "AI Guardian ALERT: host memory pressure serious. host=pve reasons=psi_memory_full_avg10=12.5")).toBe(true);
    expect(monitoringGuardianRecovers("AI Guardian RECOVERY: host memory pressure normal. host=pve", "AI Guardian ALERT: host memory controller exhausted reclaimable slack. host=pve")).toBe(false);
    // A recovery naming nothing ends nothing.
    expect(monitoringGuardianRecovers("AI Guardian RECOVERY", "AI Guardian ALERT")).toBe(false);
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
