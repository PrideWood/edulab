import Image from "next/image";

export function BrandLogo({ size = 34 }: { size?: number }) {
  return <Image className="brand-logo" src="/logo.png" alt="" width={size} height={size} unoptimized />;
}
