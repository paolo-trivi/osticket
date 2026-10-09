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
 * Eventi per giorno (OverviewReport::getPlotData) come grafico a linee spezzate: i conteggi sono
 * interi, una curva smussata suggerirebbe valori intermedi che non esistono.
 */
export default function EventsChart({ days, series }: { days: string[]; series: { name: string; data: number[] }[] }) {
  const locale = useLocale();
  const { theme } = useTheme();

  const options = useMemo<ApexOptions>(() => {
    const short = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", timeZone: "UTC" });
    const long = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    const label = (v: string | number | undefined) => {
      const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayMs(v) : NaN;
      return Number.isNaN(d) ? String(v ?? "") : short.format(d).replace(/\.$/, "");
    };
    const ticks = (n: number) => Math.max(1, Math.min(days.length - 1, n));
    return {
      chart: { type: "line", toolbar: { show: false }, zoom: { enabled: false }, fontFamily: "inherit", background: "transparent" },
      theme: { mode: theme === "dark" ? "dark" : "light" },
      colors: ["#f68d29", "#12b76a", "#465fff", "#f04438", "#7a5af8", "#0ba5ec", "#fb6514"],
      stroke: { curve: "straight", width: 2 },
      markers: { size: days.length > 45 ? 0 : 3, strokeWidth: 0, hover: { size: 5 } },
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
      responsive: [{ breakpoint: 640, options: { xaxis: { tickAmount: ticks(4) }, markers: { size: 0 }, legend: { fontSize: "11px" } } }],
    };
  }, [days, locale, theme]);

  return <ReactApexChart options={options} series={series} type="line" height={310} />;
}
