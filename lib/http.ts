import { NextResponse } from "next/server";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  console.error(error);
  return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。" } }, { status: 500 });
}
