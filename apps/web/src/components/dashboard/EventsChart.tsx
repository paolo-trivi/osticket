"use client";

import type { ApexOptions } from "apexcharts";
import { useLocale } from "next-intl";
import dynamic from "next/dynamic";
import { useMemo } from "react";

import { useTheme } from "@/context/ThemeContext";

const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

/** Giorno yyyy-mm-dd come istante UTC: le etichette si formattano in UTC, senza slittamenti di fuso. */
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * Colore fisso per tipo di evento (tabella `event`), tutti diversi: la stessa serie ha sempre lo stesso
 * colore qualunque siano gli eventi presenti nel periodo.
 */
const EVENT_COLORS: Record<string, string> = {
  created: "#465fff",
  closed: "#12b76a",
  reopened: "#f79009",
  assigned: "#7a5af8",
  released: "#98a2b3",
  transferred: "#0ba5ec",
  referred: "#ee46bc",
  overdue: "#f04438",
  edited: "#15b79e",
  viewed: "#eaaa08",
  error: "#c01048",
  collab: "#fb6514",
  resent: "#2d31a6",
  deleted: "#93370d",
  merged: "#d444f1",
  linked: "#66c61c",
  unlinked: "#0e7090",
  login: "#6172f3",
  logout: "#475467",
  message: "#099250",
  note: "#b54708",
};
/** colori per eventi non previsti, diversi da quelli già usati */
const EXTRA_COLORS = ["#4e5ba6", "#a15c07", "#3e4784", "#dd2590", "#107569", "#6941c6"];

function seriesColors(keys: string[]): string[] {
  const used = new Set(keys.map((k) => EVENT_COLORS[k]).filter(Boolean));
  const spare = EXTRA_COLORS.filter((c) => !used.has(c));
  return keys.map((k, i) => EVENT_COLORS[k] ?? spare.shift() ?? `hsl(${(i * 137) % 360} 65% 50%)`);
}

/**
 * Eventi per giorno (OverviewReport::getPlotData) come grafico a linee spezzate: i conteggi sono
 * interi, una curva smussata suggerirebbe valori intermedi che non esistono.
 */
export default function EventsChart({ days, series }: { days: string[]; series: { key: string; name: string; data: number[] }[] }) {
  const locale = useLocale();
  const { theme } = useTheme();
  const keys = useMemo(() => series.map((s) => s.key), [series]);

  const options = useMemo<ApexOptions>(() => {
    const short = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", timeZone: "UTC" });
    const long = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    const label = (v: string | number | undefined) => {
      const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayMs(v) : NaN;
      return Number.isNaN(d) ? String(v ?? "") : short.format(d).replace(/\.$/, "");
    };
    const ticks = (n: number) => Math.max(1, Math.min(days.length - 1, n));
    const markerSize = (maxDays: number) => (days.length > maxDays ? 0 : 3);
    return {
      chart: { type: "line", toolbar: { show: false }, zoom: { enabled: false }, fontFamily: "inherit", background: "transparent" },
      theme: { mode: theme === "dark" ? "dark" : "light" },
      colors: seriesColors(keys),
      stroke: { curve: "straight", width: 2 },
      // marcatori sui punti se i giorni sono pochi: con un giorno solo la linea non si vedrebbe
      markers: { size: markerSize(45), strokeWidth: 0, hover: { size: 5 } },
      dataLabels: { enabled: false },
      xaxis: {
        categories: days,
        type: "category",
        tickAmount: ticks(8),
        tickPlacement: "on",
        labels: { rotate: 0, hideOverlappingLabels: true, trim: false, formatter: label },
        axisTicks: { show: false },
        tooltip: { enabled: false },
      },
      yaxis: { min: 0, forceNiceScale: true, labels: { formatter: (v: number) => String(Math.round(v)) } },
      legend: { position: "top", horizontalAlign: "left" },
      grid: { xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } } },
      tooltip: {
        shared: true,
        intersect: false,
        theme: theme === "dark" ? "dark" : "light",
        x: {
          formatter: (_v: number, o?: { dataPointIndex?: number }) => {
            const d = days[o?.dataPointIndex ?? -1];
            return d ? long.format(dayMs(d)) : "";
          },
        },
      },
      // Telefono: meno etichette sull'asse X, così restano leggibili senza sovrapporsi
      responsive: [
        {
          breakpoint: 640,
          options: {
            xaxis: { tickAmount: ticks(4) },
            markers: { size: markerSize(14) },
            legend: { fontSize: "11px" },
          },
        },
      ],
    };
  }, [days, keys, locale, theme]);

  return <ReactApexChart options={options} series={series.map((s) => ({ name: s.name, data: s.data }))} type="line" height={310} />;
}
