import { timingSafeEqual, createHash } from "node:crypto";
import { getSharedModelConnection, getSharedModelSummary } from "@/lib/shared-model";
import { runDeepSeekChat, DeepSeekError } from "@/lib/deepseek";
import { query } from "@/db";
import { sqlClientSync } from "@/lib/sql-study-control";
export const runtime = "nodejs";
export const maxDuration = 120;

// Disabled in production. A new per-launch capability protects this loopback
// development bridge; provider/database credentials never leave EduLab.
function allowed(request: Request) {
  const secret = process.env.SQL_LOCAL_BRIDGE_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const host = request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");
  return process.env.NODE_ENV === "development" && Boolean(secret && secret.length >= 32)
    && /^127\.0\.0\.1:\d+$/.test(host) && !origin
    && Buffer.byteLength(supplied) === Buffer.byteLength(secret!)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(secret!));
}
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  if (!allowed(request)) return Response.json({error:"Not available"},{status:403});
  try { return Response.json({ok:true,model:await getSharedModelSummary()},{headers}); }
  catch { return Response.json({error:"EduLab共享连接暂不可用"},{status:503,headers}); }
}
function validModelContent(role: string, content: unknown) {
  if (typeof content === "string") return content.length <= 30000;
  if (role !== "user" || !Array.isArray(content) || content.length < 1 || content.length > 2) return false;
  let images = 0;
  return content.every(p => {
    if (p?.type === "text") return typeof p.text === "string" && p.text.length <= 4000;
    if (p?.type !== "image_url" || ++images > 1 || typeof p.image_url?.url !== "string") return false;
    return p.image_url.url.length <= 400000 && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(p.image_url.url);
  });
}
export async function POST(request: Request) {
  if (!allowed(request)) return Response.json({error:"Not available"},{status:403});
  try {
    if (Number(request.headers.get("content-length") || 0) > 20_000_000)
      return Response.json({error:"Payload too large"},{status:413,headers});
    const input = await request.json();
    if (input.action === "study_sync") {
      if (typeof input.device_id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.device_id))
        return Response.json({error:"Invalid device"},{status:400,headers});
      return Response.json(await sqlClientSync(input.device_id),{headers});
    }
    if (input.action === "backup_status") {
      if (typeof input.upload_id !== "string" || input.upload_id.length > 200)
        return Response.json({error:"Invalid upload id"},{status:400,headers});
      const result = await query<{sha256:string;participant_name:string;class_code:string;revision:string}>(
        "SELECT sha256,participant_name,class_code,revision::text FROM edulab_local_backup.snapshots WHERE upload_id=$1 AND archive->>'study_schema'='sql-teachable-mvp/1'", [input.upload_id]);
      return Response.json({ok:true,stored:result.rows[0] ?? null},{headers});
    }
    if (input.action === "backup") {
      if (typeof input.canonical !== 'string' || input.canonical.length > 20_000_000)
        return Response.json({error:"Invalid canonical archive"},{status:400,headers});
      const a = JSON.parse(input.canonical);
      if (!a || a.study_schema !== "sql-teachable-mvp/1" || a.schema_version !== "edulab-light/1"
        || a.source_app !== "student-light" || !Array.isArray(a.conversations))
        return Response.json({error:"Invalid SQL archive"},{status:400,headers});
      // Hash is verified again by the existing append-only ingestion function.
      const text = input.canonical;
      const digest = createHash("sha256").update(text).digest("hex");
      if (digest !== input.sha256) return Response.json({error:"Invalid checksum"},{status:400,headers});
      const result = await query<{receipt: unknown}>(
        "SELECT edulab_local_backup.ingest($1::text,$2::text,$3::text,$4::text) AS receipt",
        [input.upload_id, digest, text, input.archive.exported_at]);
      return Response.json(result.rows[0].receipt,{headers});
    }
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 30
      || input.messages.some((m: {role?: string;content?: unknown}) => !["system","user","assistant"].includes(m.role ?? "")
        || !validModelContent(m.role ?? "", m.content)))
      return Response.json({error:"Invalid model input"},{status:400,headers});
    const shared = await getSharedModelConnection();
    const hasImages = input.messages.some((m: {content: unknown}) => Array.isArray(m.content) && m.content.some((p: {type?: string}) => p.type === "image_url"));
    if (hasImages && !["deepseek-flash", "deepseek-v4-flash-vision-exp"].includes(shared.config.model))
      return Response.json({error:"当前共享模型不支持图片，请教师选择支持图片的 deepseek-flash。"},{status:400,headers});
    const reply = await runDeepSeekChat({token:shared.token,baseUrl:shared.baseUrl,
      directModel:{...shared.config,thinking:false,maxTokens:1600,systemPrompt:""},
      messages:input.messages,jsonOutput:true,signal:AbortSignal.timeout(75_000)});
    return Response.json({choices:[{finish_reason:"stop",message:{content:reply.answer}}]}, {headers});
  } catch(error) {
    return Response.json({error:error instanceof DeepSeekError ? error.message : "EduLab本机转接未完成，请检查模型或备份服务。"}, {status:502,headers});
  }
}
