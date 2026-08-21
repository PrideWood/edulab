import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACCESS_COOKIE, verifyAccessCookie } from "@/lib/access-code";
import { AccessCodeForm } from "./access-code-form";

export const metadata: Metadata = {
  title: "访问验证｜EduLab",
};

function safeReturnPath(value: string | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const parameters = await searchParams;
  const nextPath = safeReturnPath(parameters.next);
  const configuredCode = process.env.ACCESS_CODE;
  if (configuredCode && await verifyAccessCookie((await cookies()).get(ACCESS_COOKIE)?.value, configuredCode)) {
    redirect(nextPath);
  }
  return <AccessCodeForm configured={Boolean(configuredCode)} nextPath={nextPath} />;
}
