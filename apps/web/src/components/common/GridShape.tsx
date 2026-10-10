import Image from "next/image";
import { withBase } from "@/lib/base-path";

export default function GridShape() {
  return (
    <>
      <div aria-hidden="true" className="absolute end-0 top-0 -z-1 w-full max-w-[250px] xl:max-w-[450px]">
        <Image width={540} height={254} src={withBase("/images/shape/grid-01.svg")} alt="" />
      </div>
      <div aria-hidden="true" className="absolute start-0 bottom-0 -z-1 w-full max-w-[250px] rotate-180 xl:max-w-[450px]">
        <Image width={540} height={254} src={withBase("/images/shape/grid-01.svg")} alt="" />
      </div>
    </>
  );
}
