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
  const started=Date.now();let attempts=0,stage="data";
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
    stage="model_config";
    const shared = await getSharedModelConnection();
    const hasImages = input.messages.some((m: {content: unknown}) => Array.isArray(m.content) && m.content.some((p: {type?: string}) => p.type === "image_url"));
    if (hasImages && !["deepseek-flash", "deepseek-v4-flash-vision-exp"].includes(shared.config.model))
      return Response.json({error:"当前共享模型不支持图片，请教师选择支持图片的 deepseek-flash。"},{status:400,headers});
    stage="model";
    const signal=AbortSignal.timeout(90_000);
    // Retry only completed blank JSON generations or explicit temporary HTTP refusals.
    // Partial/interrupted streams and ambiguous network failures are never replayed automatically.
    while(true){
      attempts++;
      try {
        const reply=await runDeepSeekChat({token:shared.token,baseUrl:shared.baseUrl,
          directModel:{...shared.config,thinking:false,maxTokens:Math.min(8192,Math.max(2048,shared.config.maxTokens??4096)),systemPrompt:""},
          messages:input.messages,jsonOutput:true,signal});
        return Response.json({choices:[{finish_reason:"stop",message:{content:reply.answer}}],
          diagnostics:{policy:"sql-json-recovery/1",attempts,elapsed_ms:Date.now()-started}}, {headers});
      }catch(error){
        const retry=error instanceof DeepSeekError&&(error.code==="EMPTY_ANSWER"||/^DEEPSEEK_HTTP_(429|500|502|503|504)$/.test(error.code));
        if(signal.aborted)throw signal.reason;
        if(!retry||attempts>=3)throw error;
        console.warn("sql.model.retry",{code:error.code,attempt:attempts});
        await new Promise(resolve=>setTimeout(resolve,attempts*700));
      }
    }
  } catch(error) {
    const failure=sqlFailure(error,stage);
    console.warn("sql.bridge.failure",{code:failure.code,status:failure.status,attempts,elapsed_ms:Date.now()-started});
    return Response.json({error:failure.message,code:failure.code,attempts,elapsed_ms:Date.now()-started}, {status:failure.status,headers});
  }
}
function sqlFailure(error:unknown,stage:string){
  if(error instanceof DeepSeekError){
    const messages:Record<string,string>={EMPTY_ANSWER:"模型连续返回空内容，已自动尝试3次，请稍后重发。",STREAM_INTERRUPTED:"模型回复途中断，未自动重复请求，请稍后重发。",DEEPSEEK_HTTP_401:"模型密钥无效或已过期，请教师检查共享连接。",DEEPSEEK_HTTP_402:"模型API余额不足，请教师检查API账户余额。",DEEPSEEK_HTTP_429:"模型请求繁忙或达到并发限制，请稍后重发。"};
    return {code:error.code,status:error.status>=400&&error.status<=599?error.status:502,message:messages[error.code]??error.message};
  }
  const name=error&&typeof error==="object"&&"name" in error?String(error.name):"";
  if(name==="TimeoutError"||name==="AbortError")return {code:"MODEL_TIMEOUT",status:504,message:"模型响应超时，请稍后重发。"};
  if(stage==="model")return {code:"MODEL_NETWORK_ERROR",status:503,message:"模型连接暂时中断，请稍后重发。"};
  if(stage==="model_config")return {code:"MODEL_CONFIG_UNAVAILABLE",status:503,message:"共享模型配置暂时未能读取，请稍后重发或联系教师。"};
  return {code:"BRIDGE_DATA_ERROR",status:502,message:"EduLab本机同步未完成，请检查备份服务。"};
}
