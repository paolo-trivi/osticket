"use client";

import type { ApexOptions } from "apexcharts";
import dynamic from "next/dynamic";

const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

/** Eventi per giorno (OverviewReport::getPlotData) come grafico a linee. */
export default function EventsChart({ days, series }: { days: string[]; series: { name: string; data: number[] }[] }) {
  const options: ApexOptions = {
    chart: { type: "area", height: 310, toolbar: { show: false }, fontFamily: "inherit" },
    colors: ["#f68d29", "#12b76a", "#465fff", "#f04438", "#7a5af8", "#0ba5ec", "#fb6514"],
    stroke: { curve: "smooth", width: 2 },
    fill: { type: "gradient", gradient: { opacityFrom: 0.35, opacityTo: 0 } },
    dataLabels: { enabled: false },
    xaxis: { categories: days, type: "category", tickAmount: 8, labels: { rotate: 0 } },
    legend: { position: "top", horizontalAlign: "left" },
    grid: { yaxis: { lines: { show: true } } },
    tooltip: { shared: true },
  };
  return <ReactApexChart options={options} series={series} type="area" height={310} />;
}
