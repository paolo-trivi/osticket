// Le SVG sono compilate in componenti React da @svgr/webpack (vedi next.config.ts)
declare module "*.svg" {
  import type * as React from "react";
  const SvgComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement> & { title?: string }>;
  export default SvgComponent;
}
