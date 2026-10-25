import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bookmark,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  File,
  RotateCcw,
  Sparkles,
  X
} from "../ui-theme/app-icons.js";
import { api, type MemoryCalendarRecord, type MemoryCalendarResponse } from "../../api.js";
import "./memory-calendar.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function formatDisplayDate(dateStr: string): string {
  try {
    const parts = dateStr.split("-").map(Number);
    const y = parts[0] ?? 2026;
    const m = parts[1] ?? 1;
    const d = parts[2] ?? 1;
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC"
    });
  } catch {
    return dateStr;
  }
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
  } catch {
    return "";
  }
}

function getHeatLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (max <= 1) return 4;
  if (max <= 4) return Math.min(4, count);
  const ratio = count / max;
  if (ratio < 0.15) return 1;
  if (ratio < 0.40) return 2;
  if (ratio < 0.70) return 3;
  return 4;
}

export function MemoryCalendarView({
  onSelectNode,
  selectedNodeId,
  onCloseDetail
}: {
  onSelectNode: (nodeId: string) => void;
  selectedNodeId: string | null;
  onCloseDetail: () => void;
}) {
  const now = useMemo(() => new Date(), []);
  const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const todayKey = `${currentMonthKey}-${String(now.getUTCDate()).padStart(2, "0")}`;

  const [viewMode, setViewMode] = useState<"month" | "year">("month");
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthKey);
  const [selectedYear, setSelectedYear] = useState<number>(now.getUTCFullYear());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [data, setData] = useState<MemoryCalendarResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCalendar = useCallback((month?: string, year?: number, date?: string) => {
    setLoading(true);
    setError(null);
    void api.memoryCalendar({ month, year, date })
      .then((res) => {
        setData(res.data);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load memory calendar.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchCalendar(selectedMonth, selectedYear, selectedDate || undefined);
  }, [fetchCalendar, selectedMonth, selectedYear, selectedDate]);

  // Navigate month
  const handlePrevMonth = () => {
    const parts = selectedMonth.split("-").map(Number);
    const y = parts[0] ?? 2026;
    const m = parts[1] ?? 1;
    const prevDate = new Date(Date.UTC(y, m - 2, 1));
    const nextKey = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, "0")}`;
    setSelectedMonth(nextKey);
    setSelectedYear(prevDate.getUTCFullYear());
  };

  const handleNextMonth = () => {
    const parts = selectedMonth.split("-").map(Number);
    const y = parts[0] ?? 2026;
    const m = parts[1] ?? 1;
    const nextDate = new Date(Date.UTC(y, m, 1));
    const nextKey = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}`;
    setSelectedMonth(nextKey);
    setSelectedYear(nextDate.getUTCFullYear());
  };

  const handleResetCurrentMonth = () => {
    setSelectedMonth(currentMonthKey);
    setSelectedYear(now.getUTCFullYear());
    setSelectedDate(null);
  };

  // Navigate year
  const handlePrevYear = () => {
    setSelectedYear((prev) => prev - 1);
  };

  const handleNextYear = () => {
    setSelectedYear((prev) => prev + 1);
  };

  // Month days calculation
  const monthCalendarData = useMemo(() => {
    const parts = selectedMonth.split("-").map(Number);
    const y = parts[0] ?? 2026;
    const m = parts[1] ?? 1;
    const totalDays = new Date(Date.UTC(y, m, 0)).getDate();
    // Monday as first day: 0 = Mon, ..., 6 = Sun
    const firstDayIndex = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    return {
      year: y,
      month: m,
      monthName: MONTH_NAMES[m - 1] ?? "",
      totalDays,
      firstDayIndex
    };
  }, [selectedMonth]);

  // Month-scoped maximum daily count for balanced local contrast
  const monthMax = useMemo(() => {
    if (!data?.heatMap) return 1;
    let max = 0;
    for (let d = 1; d <= monthCalendarData.totalDays; d++) {
      const key = `${monthCalendarData.year}-${String(monthCalendarData.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const c = data.heatMap[key]?.count ?? 0;
      if (c > max) max = c;
    }
    return max > 0 ? max : (data?.stats.maxDailyCount ?? 1);
  }, [data, monthCalendarData]);

  // Year-scoped maximum daily count
  const yearMax = useMemo(() => {
    if (!data?.heatMap) return 1;
    let max = 0;
    const prefix = `${selectedYear}-`;
    for (const [key, info] of Object.entries(data.heatMap)) {
      if (key.startsWith(prefix) && info.count > max) {
        max = info.count;
      }
    }
    return max > 0 ? max : (data?.stats.maxDailyCount ?? 1);
  }, [data, selectedYear]);

  // Selected date records
  const dayRecords = useMemo(() => {
    if (!selectedDate || !data) return [];
    return data.records.filter((r) => r.createdAt.startsWith(selectedDate));
  }, [selectedDate, data]);

  // Find busiest day in current selected year
  const busiestDay = useMemo(() => {
    if (!data?.heatMap) return null;
    let max = 0;
    let maxDate = "";
    const prefix = `${selectedYear}-`;
    for (const [date, info] of Object.entries(data.heatMap)) {
      if (date.startsWith(prefix) && info.count > max) {
        max = info.count;
        maxDate = date;
      }
    }
    return maxDate ? { date: maxDate, count: max } : null;
  }, [data, selectedYear]);

  return (
    <div className="memory-calendar-workspace" data-view-mode={viewMode} data-drawer-open={Boolean(selectedDate)}>
      {/* Top calendar toolbar */}
      <div className="memory-calendar-toolbar">
        <div className="memory-calendar-view-picker" role="group" aria-label="Calendar view switcher">
          <button
            type="button"
            className={`memory-calendar-view-btn ${viewMode === "month" ? "is-active" : ""}`}
            aria-pressed={viewMode === "month"}
            onClick={() => setViewMode("month")}
          >
            Month
          </button>
          <button
            type="button"
            className={`memory-calendar-view-btn ${viewMode === "year" ? "is-active" : ""}`}
            aria-pressed={viewMode === "year"}
            onClick={() => setViewMode("year")}
          >
            Year
          </button>
        </div>

        {viewMode === "month" ? (
          <div className="memory-calendar-nav">
            <button
              type="button"
              className="memory-cal-nav-btn"
              aria-label="Previous month"
              onClick={handlePrevMonth}
            >
              <ChevronLeft aria-hidden="true" />
            </button>

            <label className="memory-calendar-month-select-label">
              <CalendarIcon aria-hidden="true" />
              <select
                aria-label="Select month"
                value={selectedMonth}
                onChange={(e) => {
                  setSelectedMonth(e.currentTarget.value);
                  const y = Number(e.currentTarget.value.slice(0, 4));
                  if (y) setSelectedYear(y);
                }}
              >
                {data?.availableMonths.map((m) => {
                  const [yStr, mStr] = m.split("-");
                  const name = MONTH_NAMES[Number(mStr) - 1] ?? m;
                  return (
                    <option key={m} value={m}>
                      {name} {yStr}
                    </option>
                  );
                })}
              </select>
            </label>

            <button
              type="button"
              className="memory-cal-nav-btn"
              aria-label="Next month"
              onClick={handleNextMonth}
            >
              <ChevronRight aria-hidden="true" />
            </button>

            {selectedMonth !== currentMonthKey ? (
              <button
                type="button"
                className="memory-cal-reset-btn"
                title="Jump to current month"
                onClick={handleResetCurrentMonth}
              >
                <RotateCcw aria-hidden="true" /> Current Month
              </button>
            ) : null}
          </div>
        ) : (
          <div className="memory-calendar-nav">
            <button
              type="button"
              className="memory-cal-nav-btn"
              aria-label="Previous year"
              onClick={handlePrevYear}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span className="memory-calendar-year-title">{selectedYear}</span>
            <button
              type="button"
              className="memory-cal-nav-btn"
              aria-label="Next year"
              onClick={handleNextYear}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Legend */}
        <div className="memory-calendar-legend" aria-label="Heatmap intensity legend">
          <span className="legend-label">Less</span>
          <span className="legend-cell level-0" title="0 memories" />
          <span className="legend-cell level-1" title="1-4 memories" />
          <span className="legend-cell level-2" title="5-11 memories" />
          <span className="legend-cell level-3" title="12-24 memories" />
          <span className="legend-cell level-4" title="25+ memories" />
          <span className="legend-label">More</span>
        </div>
      </div>

      {error ? (
        <div className="memory-calendar-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => fetchCalendar(selectedMonth, selectedYear, selectedDate || undefined)}>
            Retry
          </button>
        </div>
      ) : null}

      {/* Main body area */}
      <div className="memory-calendar-content">
        {/* Month View */}
        {viewMode === "month" ? (
          <div className="memory-calendar-month-stage">
            <div className="memory-calendar-month-header">
              <h2>
                {monthCalendarData.monthName} <span>{monthCalendarData.year}</span>
              </h2>
              <div className="memory-calendar-month-meta">
                <span>{data?.records.length ?? 0} memories in this view</span>
              </div>
            </div>

            <div className="memory-calendar-grid" role="grid" aria-label={`Calendar for ${monthCalendarData.monthName} ${monthCalendarData.year}`}>
              <div className="memory-calendar-weekdays" role="row">
                {WEEKDAYS.map((day) => (
                  <div key={day} className="memory-calendar-weekday" role="columnheader">
                    {day}
                  </div>
                ))}
              </div>

              <div className="memory-calendar-days">
                {/* Leading blanks */}
                {Array.from({ length: monthCalendarData.firstDayIndex }).map((_, idx) => (
                  <div key={`blank-${idx}`} className="memory-calendar-day is-blank" aria-hidden="true" />
                ))}

                {/* Actual month days */}
                {Array.from({ length: monthCalendarData.totalDays }).map((_, idx) => {
                  const dayNum = idx + 1;
                  const dateKey = `${monthCalendarData.year}-${String(monthCalendarData.month).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
                  const count = data?.heatMap[dateKey]?.count ?? 0;
                  const level = getHeatLevel(count, monthMax);
                  const isToday = dateKey === todayKey;
                  const isSelected = dateKey === selectedDate;

                  return (
                    <button
                      key={dateKey}
                      type="button"
                      role="gridcell"
                      className={`memory-calendar-day level-${level} ${isToday ? "is-today" : ""} ${isSelected ? "is-selected" : ""}`}
                      aria-label={`${dateKey}: ${count} memories`}
                      aria-selected={isSelected}
                      onClick={() => {
                        setSelectedDate(dateKey === selectedDate ? null : dateKey);
                        onCloseDetail();
                      }}
                    >
                      <span className="day-number">{dayNum}</span>
                      {count > 0 ? (
                        <span className="day-count-badge" title={`${count} memories`}>
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          /* Year View: 12 months matrix */
          <div className="memory-calendar-year-stage">
            <div className="memory-calendar-year-stats-banner">
              <div className="year-stat-card">
                <span className="stat-label">YEAR MEMORIES</span>
                <strong className="stat-value">{data?.stats.yearMemories.toLocaleString() ?? 0}</strong>
                <small>recorded in {selectedYear}</small>
              </div>
              <div className="year-stat-card">
                <span className="stat-label">ACTIVE DAYS</span>
                <strong className="stat-value">{data?.stats.activeDays.toLocaleString() ?? 0}</strong>
                <small>days with knowledge</small>
              </div>
              <div className="year-stat-card">
                <span className="stat-label">BUSIEST DAY</span>
                <strong className="stat-value">
                  {busiestDay ? `${busiestDay.count} items` : "—"}
                </strong>
                <small>{busiestDay ? formatDisplayDate(busiestDay.date) : "No activity"}</small>
              </div>
              <div className="year-stat-card">
                <span className="stat-label">TOTAL ARCHIVE</span>
                <strong className="stat-value">{data?.stats.totalMemories.toLocaleString() ?? 0}</strong>
                <small>across all history</small>
              </div>
            </div>

            <div className="memory-calendar-year-grid">
              {MONTH_NAMES.map((mName, mIdx) => {
                const monthNum = mIdx + 1;
                const mKey = `${selectedYear}-${String(monthNum).padStart(2, "0")}`;
                const totalDays = new Date(Date.UTC(selectedYear, monthNum, 0)).getDate();
                const firstDayIndex = (new Date(Date.UTC(selectedYear, mIdx, 1)).getUTCDay() + 6) % 7;

                // Monthly count
                let monthCount = 0;
                for (let d = 1; d <= totalDays; d++) {
                  const dKey = `${mKey}-${String(d).padStart(2, "0")}`;
                  monthCount += data?.heatMap[dKey]?.count ?? 0;
                }

                return (
                  <div key={mKey} className="memory-year-month-card">
                    <button
                      type="button"
                      className="memory-year-month-title-btn"
                      title={`Jump to ${mName} in Month view`}
                      onClick={() => {
                        setSelectedMonth(mKey);
                        setViewMode("month");
                      }}
                    >
                      <span>{mName}</span>
                      <small>{monthCount} memories</small>
                    </button>

                    <div className="memory-year-mini-weekdays">
                      {["M", "T", "W", "T", "F", "S", "S"].map((w, wi) => (
                        <span key={wi}>{w}</span>
                      ))}
                    </div>

                    <div className="memory-year-mini-grid">
                      {Array.from({ length: firstDayIndex }).map((_, bIdx) => (
                        <span key={`mini-b-${bIdx}`} className="mini-cell is-blank" />
                      ))}
                      {Array.from({ length: totalDays }).map((_, dIdx) => {
                        const dayNum = dIdx + 1;
                        const dateKey = `${mKey}-${String(dayNum).padStart(2, "0")}`;
                        const count = data?.heatMap[dateKey]?.count ?? 0;
                        const level = getHeatLevel(count, yearMax);
                        const isSelected = dateKey === selectedDate;

                        return (
                          <button
                            key={dateKey}
                            type="button"
                            className={`mini-cell level-${level} ${isSelected ? "is-selected" : ""}`}
                            title={`${dateKey}: ${count} memories`}
                            aria-label={`${dateKey}: ${count} memories`}
                            onClick={() => {
                              setSelectedDate(dateKey === selectedDate ? null : dateKey);
                              onCloseDetail();
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Day Memories Inspector Drawer */}
        {selectedDate ? (
          <aside className="memory-calendar-drawer" aria-label={`Memories for ${selectedDate}`}>
            <div className="memory-calendar-drawer-header">
              <div>
                <span className="memory-drawer-eyebrow">
                  <Sparkles aria-hidden="true" /> DAY INSPECTOR
                </span>
                <h3>{formatDisplayDate(selectedDate)}</h3>
                <p>
                  {dayRecords.length} {dayRecords.length === 1 ? "memory" : "memories"} recorded
                </p>
              </div>
              <button
                type="button"
                className="memory-drawer-close-btn"
                aria-label="Close day inspector"
                onClick={() => {
                  setSelectedDate(null);
                  onCloseDetail();
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="memory-calendar-drawer-body">
              {loading && !dayRecords.length ? (
                <div className="memory-drawer-loading" role="status">
                  Loading day memories…
                </div>
              ) : null}

              {!loading && dayRecords.length === 0 ? (
                <div className="memory-drawer-empty">
                  <Clock3 aria-hidden="true" />
                  <h4>No memories on this date</h4>
                  <p>No canonical history or fact entries were recorded on {selectedDate}.</p>
                </div>
              ) : null}

              <div className="memory-drawer-list">
                {dayRecords.map((item) => (
                  <article key={item.id} className="memory-drawer-card">
                    <div className="card-top">
                      <span className="card-time">
                        <Clock3 aria-hidden="true" />
                        {formatTime(item.createdAt)}
                      </span>
                      {item.sourcePath ? (
                        <span className="card-source" title={item.sourcePath}>
                          <File aria-hidden="true" />
                          {item.sourcePath.split("/").pop()}
                        </span>
                      ) : null}
                    </div>

                    <h4 className="card-title">{item.title}</h4>

                    {item.excerpt ? <p className="card-excerpt">{item.excerpt}</p> : null}

                    {item.tags?.length || item.topics?.length ? (
                      <div className="card-tags">
                        {item.tags.map((tag) => (
                          <span key={tag} className="tag-pill">
                            <Bookmark aria-hidden="true" />
                            {tag}
                          </span>
                        ))}
                        {item.topics.map((topic) => (
                          <span key={topic} className="topic-pill">
                            #{topic}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="card-actions">
                      <button
                        type="button"
                        className={`card-inspect-btn ${selectedNodeId === item.id ? "is-inspecting" : ""}`}
                        onClick={() => onSelectNode(item.id)}
                      >
                        {selectedNodeId === item.id ? "Viewing Details" : "Inspect Details"} <ExternalLink aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
