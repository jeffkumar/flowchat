"use client";

import { useMemo, useState } from "react";

type ChartKind = "pie" | "bar";

export type ChartPayloadV1 = {
  version: 1;
  title: string;
  breakdown: "category" | "month" | "merchant" | "description";
  unit: "USD";
  rows: Array<{ label: string; value: number; count?: number }>;
};

export function safeParseChartPayload(content: string): ChartPayloadV1 | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Partial<ChartPayloadV1>;
    if (p.version !== 1) return null;
    if (typeof p.title !== "string") return null;
    if (
      p.breakdown !== "category" &&
      p.breakdown !== "month" &&
      p.breakdown !== "merchant" &&
      p.breakdown !== "description"
    ) {
      return null;
    }
    if (p.unit !== "USD") return null;
    if (!Array.isArray(p.rows)) return null;
    const rows = p.rows
      .filter((r) => r && typeof r === "object")
      .map((r) => r as { label?: unknown; value?: unknown; count?: unknown })
      .filter(
        (r) =>
          typeof r.label === "string" &&
          typeof r.value === "number" &&
          Number.isFinite(r.value)
      )
      .map((r) => ({
        label: String(r.label).slice(0, 120),
        value: Number(r.value),
        count: typeof r.count === "number" && Number.isFinite(r.count) ? r.count : undefined,
      }));
    return { version: 1, title: p.title, breakdown: p.breakdown, unit: "USD", rows };
  } catch {
    return null;
  }
}

function sum(values: number[]) {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

function formatUsd(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return `$${rounded.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatMonthLabel(label: string): string {
  const m = label.match(/^(\d{4})-(\d{2})$/);
  if (!m) return label;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return label;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ] as const;
  return `${months[month - 1]} ${String(year)}`;
}

function colorVar(index: number) {
  const i = (index % 5) + 1;
  return `var(--chart-${String(i)})`;
}

function polarToCartesian(cx: number, cy: number, r: number, angleRad: number) {
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function arcPath({
  cx,
  cy,
  r,
  startAngle,
  endAngle,
}: {
  cx: number;
  cy: number;
  r: number;
  startAngle: number;
  endAngle: number;
}) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y} Z`;
}

export function ChartViewer({
  payload,
}: {
  payload: ChartPayloadV1;
}) {
  const [kind, setKind] = useState<ChartKind>("pie");

  const allRows = useMemo(() => {
    return payload.rows
      .map((r) => ({ ...r, value: Math.max(0, r.value) }))
      .filter((r) => r.value > 0);
  }, [payload.rows]);

  const total = useMemo(() => sum(allRows.map((r) => r.value)), [allRows]);

  const rows = useMemo(() => {
    const sorted = allRows.slice().sort((a, b) => b.value - a.value);
    const maxShown = 11;
    const top = sorted.slice(0, maxShown);
    const topSum = sum(top.map((r) => r.value));
    const remainder = Math.max(0, total - topSum);
    const hasMore = sorted.length > maxShown;
    if (hasMore && remainder > 0.009) {
      return [...top, { label: "Other", value: remainder }];
    }
    return sorted.slice(0, 12);
  }, [allRows, total]);

  const maxValue = useMemo(() => Math.max(1, ...rows.map((r) => r.value)), [rows]);
  const displayLabel = (label: string) =>
    payload.breakdown === "month" ? formatMonthLabel(label) : label;

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Total: {formatUsd(total)}</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="rounded-md border bg-background px-2 py-1 text-xs"
            onClick={() => setKind("pie")}
            type="button"
          >
            Pie
          </button>
          <button
            className="rounded-md border bg-background px-2 py-1 text-xs"
            onClick={() => setKind("bar")}
            type="button"
          >
            Bar
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 rounded-md border bg-muted p-3 text-sm text-muted-foreground">
          No data to chart.
        </div>
      ) : kind === "pie" ? (
        <div className="mt-4 grid gap-4 md:grid-cols-[240px_1fr]">
          <div className="flex items-center justify-center">
            <svg aria-label="Pie chart" height={220} role="img" viewBox="0 0 220 220" width={220}>
              <title>{payload.title}</title>
              {(() => {
                const cx = 110;
                const cy = 110;
                const r = 95;
                let a = -Math.PI / 2;
                return rows.map((row, idx) => {
                  const frac = total > 0 ? row.value / total : 0;
                  const next = a + frac * Math.PI * 2;
                  const path = arcPath({ cx, cy, r, startAngle: a, endAngle: next });
                  a = next;
                  return (
                    <path
                      d={path}
                      fill={colorVar(idx)}
                      key={`${row.label}-${String(idx)}`}
                      stroke="var(--border)"
                      strokeWidth={1}
                    />
                  );
                });
              })()}
            </svg>
          </div>

          <div className="min-w-0">
            <div className="space-y-2">
              {rows.map((row, idx) => {
                const pct = total > 0 ? Math.round((row.value / total) * 100) : 0;
                return (
                  <div
                    className="flex items-center justify-between gap-3"
                    key={`${row.label}-${String(idx)}`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ backgroundColor: colorVar(idx) }}
                      />
                      <span className="truncate text-sm">{displayLabel(row.label)}</span>
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground">
                      {formatUsd(row.value)} ({pct}%)
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {rows.map((row, idx) => {
            const wPct = Math.round((row.value / maxValue) * 100);
            return (
              <div
                className="grid grid-cols-[1fr_90px] items-center gap-3"
                key={`${row.label}-${String(idx)}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-sm">{displayLabel(row.label)}</div>
                    <div className="shrink-0 text-xs text-muted-foreground">{formatUsd(row.value)}</div>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full"
                      style={{ width: `${String(wPct)}%`, backgroundColor: colorVar(idx) }}
                    />
                  </div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {total > 0 ? `${String(Math.round((row.value / total) * 100))}%` : "0%"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

