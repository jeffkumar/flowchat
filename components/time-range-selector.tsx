"use client";

import { useState, useEffect } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { TimeRangeOption } from "@/lib/types";
import { cn } from "@/lib/utils";

type TimeRangeSelectorProps = {
  availableTimeRanges: TimeRangeOption[];
  selectedTimeRange: TimeRangeOption | null;
  defaultTimeRange?: TimeRangeOption;
  onSelectionChange: (timeRange: TimeRangeOption) => void;
  questionId?: string;
  className?: string;
};

export function TimeRangeSelector({
  availableTimeRanges,
  selectedTimeRange,
  defaultTimeRange,
  onSelectionChange,
  questionId,
  className,
}: TimeRangeSelectorProps) {
  const [localSelected, setLocalSelected] = useState<TimeRangeOption | null>(
    selectedTimeRange ?? defaultTimeRange ?? null
  );
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [showCustomInputs, setShowCustomInputs] = useState(false);

  useEffect(() => {
    if (selectedTimeRange) {
      setLocalSelected(selectedTimeRange);
      if (selectedTimeRange.type === "custom") {
        setShowCustomInputs(true);
        setCustomStartDate(selectedTimeRange.date_start ?? "");
        setCustomEndDate(selectedTimeRange.date_end ?? "");
      }
    } else if (defaultTimeRange) {
      setLocalSelected(defaultTimeRange);
    }
  }, [selectedTimeRange, defaultTimeRange]);

  const handlePresetSelect = (timeRange: TimeRangeOption) => {
    if (timeRange.type === "custom") {
      setShowCustomInputs(true);
      setLocalSelected(timeRange);
    } else {
      setShowCustomInputs(false);
      setLocalSelected(timeRange);
    }
  };

  const handleApply = () => {
    if (localSelected?.type === "custom") {
      if (customStartDate && customEndDate) {
        onSelectionChange({
          type: "custom",
          label: `${customStartDate} to ${customEndDate}`,
          date_start: customStartDate,
          date_end: customEndDate,
        });
      }
    } else if (localSelected) {
      onSelectionChange(localSelected);
    }
  };

  const presetRanges = availableTimeRanges.filter((r) => r.type === "preset");
  const customRange = availableTimeRanges.find((r) => r.type === "custom");

  if (availableTimeRanges.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Select time period</h3>
          <p className="text-xs text-muted-foreground">
            Choose a time range for your finance query
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {presetRanges.map((timeRange) => {
          const isSelected = localSelected?.label === timeRange.label && localSelected?.type === "preset";
          return (
            <button
              key={timeRange.label}
              type="button"
              onClick={() => handlePresetSelect(timeRange)}
              className={cn(
                "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
                "hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                isSelected
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background"
              )}
            >
              {isSelected ? (
                <Check className="h-4 w-4" />
              ) : (
                <div className="h-4 w-4 rounded border" />
              )}
              <span>{timeRange.label}</span>
            </button>
          );
        })}
        {customRange && (
          <button
            type="button"
            onClick={() => handlePresetSelect(customRange)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
              "hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
              localSelected?.type === "custom"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background"
            )}
          >
            {localSelected?.type === "custom" ? (
              <Check className="h-4 w-4" />
            ) : (
              <div className="h-4 w-4 rounded border" />
            )}
            <span>{customRange.label}</span>
          </button>
        )}
      </div>

      {showCustomInputs && (
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="custom-start-date">
              Start date
            </label>
            <Input
              id="custom-start-date"
              type="date"
              value={customStartDate}
              onChange={(e) => setCustomStartDate(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="custom-end-date">
              End date
            </label>
            <Input
              id="custom-end-date"
              type="date"
              value={customEndDate}
              onChange={(e) => setCustomEndDate(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {localSelected ? (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {localSelected.type === "custom" && customStartDate && customEndDate
                ? `${customStartDate} to ${customEndDate}`
                : localSelected.label}
            </Badge>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            No time period selected
          </div>
        )}
        <Button
          size="sm"
          onClick={handleApply}
          className="h-8"
          disabled={
            !localSelected ||
            (localSelected.type === "custom" && (!customStartDate || !customEndDate))
          }
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
