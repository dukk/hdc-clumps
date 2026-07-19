import { describe, expect, it } from "vitest";

import {
  DEFAULT_BACKUP_VERIFY_WINDOW_DAYS,
  backupVerifyEnabledFromConfig,
  backupVerifyWindowDaysFromConfig,
  latestVzdumpTasksByVmid,
  maxBackupAgeHoursForSchedule,
  maxScheduleGapDays,
  verifyBackupJobFreshness,
} from "./proxmox-backup-verify.mjs";

describe("backupVerifyEnabledFromConfig", () => {
  it("defaults to enabled", () => {
    expect(backupVerifyEnabledFromConfig({})).toBe(true);
    expect(backupVerifyEnabledFromConfig({ provision: {} })).toBe(true);
    expect(backupVerifyEnabledFromConfig({ provision: { backups: {} } })).toBe(true);
  });

  it("respects provision.backups.verify.enabled false", () => {
    expect(
      backupVerifyEnabledFromConfig({ provision: { backups: { verify: { enabled: false } } } }),
    ).toBe(false);
    expect(
      backupVerifyEnabledFromConfig({ provision: { backups: { verify: { enabled: 0 } } } }),
    ).toBe(false);
    expect(
      backupVerifyEnabledFromConfig({ provision: { backups: { verify: { enabled: true } } } }),
    ).toBe(true);
  });
});

describe("backupVerifyWindowDaysFromConfig", () => {
  it("defaults when unset or invalid", () => {
    expect(backupVerifyWindowDaysFromConfig({})).toBe(DEFAULT_BACKUP_VERIFY_WINDOW_DAYS);
    expect(
      backupVerifyWindowDaysFromConfig({
        provision: { backups: { verify: { window_days: -1 } } },
      }),
    ).toBe(DEFAULT_BACKUP_VERIFY_WINDOW_DAYS);
  });

  it("reads provision.backups.verify.window_days", () => {
    expect(
      backupVerifyWindowDaysFromConfig({
        provision: { backups: { verify: { window_days: 14 } } },
      }),
    ).toBe(14);
  });
});

describe("maxScheduleGapDays", () => {
  it("single weekday means weekly", () => {
    expect(maxScheduleGapDays(["sun"])).toBe(7);
  });

  it("two weekdays uses the longest forward gap", () => {
    // mon -> thu = 3 days, thu -> mon (wrap) = 4 days
    expect(maxScheduleGapDays(["mon", "thu"])).toBe(4);
  });

  it("every day means gap 1", () => {
    expect(maxScheduleGapDays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).toBe(1);
  });

  it("unknown tokens fall back to weekly", () => {
    expect(maxScheduleGapDays(["bogus"])).toBe(7);
    expect(maxScheduleGapDays([])).toBe(7);
  });
});

describe("maxBackupAgeHoursForSchedule", () => {
  it("hourly allows 3h", () => {
    expect(maxBackupAgeHoursForSchedule("hourly")).toBe(3);
  });

  it("daily time-only allows 26h", () => {
    expect(maxBackupAgeHoursForSchedule("daily")).toBe(26);
    expect(maxBackupAgeHoursForSchedule("03:00")).toBe(26);
  });

  it("weekly weekday allows 8 days", () => {
    expect(maxBackupAgeHoursForSchedule("sun 03:00")).toBe(7 * 24 + 24);
  });

  it("multi-day schedule uses longest gap plus slack", () => {
    expect(maxBackupAgeHoursForSchedule("mon,thu 03:00")).toBe(4 * 24 + 24);
  });

  it("unknown format assumes weekly cadence", () => {
    expect(maxBackupAgeHoursForSchedule("")).toBe(8 * 24);
    expect(maxBackupAgeHoursForSchedule("*/2:30")).toBe(8 * 24);
  });
});

describe("latestVzdumpTasksByVmid", () => {
  it("keeps the newest finished task per vmid and ignores non-vzdump", () => {
    const tasks = [
      { type: "vzdump", id: "101", starttime: 100, endtime: 200, status: "OK", node: "n1", upid: "UPID:a" },
      { type: "vzdump", id: "101", starttime: 300, endtime: 400, status: "some error", node: "n1", upid: "UPID:b" },
      { type: "aptupdate", id: "101", starttime: 900, endtime: 950, status: "OK", node: "n1", upid: "UPID:c" },
      { type: "vzdump", id: "202", starttime: 500, endtime: 600, status: "OK", node: "n2", upid: "UPID:d" },
    ];
    const byVmid = latestVzdumpTasksByVmid(tasks);
    expect(byVmid.size).toBe(2);
    expect(byVmid.get(101)?.status).toBe("some error");
    expect(byVmid.get(101)?.endtime).toBe(400);
    expect(byVmid.get(202)?.endtime).toBe(600);
  });

  it("marks tasks without endtime as running", () => {
    const byVmid = latestVzdumpTasksByVmid([
      { type: "vzdump", id: "101", starttime: 100, status: "", node: "n1", upid: "UPID:a" },
    ]);
    expect(byVmid.get(101)?.running).toBe(true);
    expect(byVmid.get(101)?.endtime).toBeNull();
  });

  it("skips rows without a numeric vmid", () => {
    const byVmid = latestVzdumpTasksByVmid([
      { type: "vzdump", id: "", starttime: 100, endtime: 200, status: "OK" },
      { type: "vzdump", starttime: 100, endtime: 200, status: "OK" },
    ]);
    expect(byVmid.size).toBe(0);
  });
});

describe("verifyBackupJobFreshness", () => {
  const nowSec = 1_000_000;

  /** @param {Record<string, unknown>[]} tasks */
  function tasksMap(tasks) {
    return latestVzdumpTasksByVmid(tasks);
  }

  it("passes a fresh successful daily run", () => {
    const jobs = [{ id: "hdc-backup-daily", enabled: 1, schedule: "03:00", vmid: "101" }];
    const tasksByVmid = tasksMap([
      { type: "vzdump", id: "101", starttime: nowSec - 7200, endtime: nowSec - 3600, status: "OK" },
    ]);
    const { ok, rows } = verifyBackupJobFreshness({ jobs, tasksByVmid, jobIdPrefix: "hdc-backup", nowSec });
    expect(ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].ageHours).toBe(1);
  });

  it("flags a stale run past the schedule max age", () => {
    const jobs = [{ id: "hdc-backup-daily", enabled: 1, schedule: "03:00", vmid: "101" }];
    const tasksByVmid = tasksMap([
      {
        type: "vzdump",
        id: "101",
        starttime: nowSec - 40 * 3600,
        endtime: nowSec - 39 * 3600,
        status: "OK",
      },
    ]);
    const { ok, rows } = verifyBackupJobFreshness({ jobs, tasksByVmid, jobIdPrefix: "hdc-backup", nowSec });
    expect(ok).toBe(false);
    expect(rows[0].status).toBe("stale");
    expect(rows[0].error).toContain("39h old");
  });

  it("flags a failed last run", () => {
    const jobs = [{ id: "hdc-backup-daily", enabled: 1, schedule: "03:00", vmid: "101" }];
    const tasksByVmid = tasksMap([
      {
        type: "vzdump",
        id: "101",
        starttime: nowSec - 7200,
        endtime: nowSec - 3600,
        status: "job errors",
      },
    ]);
    const { ok, rows } = verifyBackupJobFreshness({ jobs, tasksByVmid, jobIdPrefix: "hdc-backup", nowSec });
    expect(ok).toBe(false);
    expect(rows[0].status).toBe("failed");
  });

  it("treats WARNINGS exitstatus as success", () => {
    const jobs = [{ id: "hdc-backup-daily", enabled: 1, schedule: "03:00", vmid: "101" }];
    const tasksByVmid = tasksMap([
      {
        type: "vzdump",
        id: "101",
        starttime: nowSec - 7200,
        endtime: nowSec - 3600,
        status: "WARNINGS: 1",
      },
    ]);
    const { ok, rows } = verifyBackupJobFreshness({ jobs, tasksByVmid, jobIdPrefix: "hdc-backup", nowSec });
    expect(ok).toBe(true);
    expect(rows[0].status).toBe("ok");
  });

  it("flags a job with no run at all", () => {
    const jobs = [{ id: "hdc-backup-weekly", enabled: 1, schedule: "sun 03:00", vmid: "101,102" }];
    const tasksByVmid = tasksMap([
      { type: "vzdump", id: "101", starttime: nowSec - 7200, endtime: nowSec - 3600, status: "OK" },
    ]);
    const { ok, rows } = verifyBackupJobFreshness({ jobs, tasksByVmid, jobIdPrefix: "hdc-backup", nowSec });
    expect(ok).toBe(false);
    expect(rows[0].status).toBe("never");
    expect(rows[0].error).toContain("102");
  });

  it("reports running when the latest task has not finished", () => {
    const jobs = [{ id: "hdc-backup-daily", enabled: 1, schedule: "03:00", vmid: "101" }];
    const tasksByVmid = tasksMap([
      { type: "vzdump", id: "101", starttime: nowSec - 600, status: "" },
    ]);
    const { ok, rows } = verifyBackupJobFreshness({ jobs, tasksByVmid, jobIdPrefix: "hdc-backup", nowSec });
    expect(ok).toBe(true);
    expect(rows[0].status).toBe("running");
  });

  it("skips disabled jobs and jobs outside the prefix", () => {
    const jobs = [
      { id: "hdc-backup-daily", enabled: 0, schedule: "03:00", vmid: "101" },
      { id: "manual-job", enabled: 1, schedule: "03:00", vmid: "102" },
    ];
    const { ok, rows } = verifyBackupJobFreshness({
      jobs,
      tasksByVmid: new Map(),
      jobIdPrefix: "hdc-backup",
      nowSec,
    });
    expect(ok).toBe(true);
    expect(rows).toHaveLength(0);
  });
});
