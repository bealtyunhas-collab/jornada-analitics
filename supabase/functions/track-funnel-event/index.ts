// Supabase Edge Function: POST /functions/v1/track-funnel-event
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANALYTICS_ALLOWED_ORIGINS, ANALYTICS_RATE_PEPPER.
// Public, anonymous events are UNTRUSTED signals; payment confirmation uses a separate authenticated webhook.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EVENTS = new Set([
  "quiz_view", "quiz_start", "quiz_question_view", "quiz_completed",
  "result_view", "loading_view", "growth_view", "vsl_view",
  "vsl_playing", "offer_view", "checkout_click",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-zA-Z0-9_-]{16,128}$/;
const DEVICE = new Set(["mobile", "tablet", "desktop", "unknown"]);
const ALLOWED_META = new Set(["question_type", "offer_variant", "player_state"]);
const allowedOrigins = (Deno.env.get("ANALYTICS_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const dbUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const pepper = Deno.env.get("ANALYTICS_RATE_PEPPER");

function response(status: number, data: unknown, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      ...(origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" } : {}),
    },
  });
}
function optionalText(x: unknown, max: number): string | null | undefined {
  if (x == null || x === "") return null;
  if (typeof x !== "string" || x.length > max || /[\u0000-\u001f]/.test(x)) return undefined;
  return x;
}
async function hash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
Deno.serve(async (req) => {
  if (!dbUrl || !serviceKey || !pepper || allowedOrigins.length === 0) return response(503, { error: "not_configured" });
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) return response(403, { error: "origin_not_allowed" });
  if (req.method === "OPTIONS") return response(204, {}, origin);
  if (req.method !== "POST") return response(405, { error: "method_not_allowed" }, origin);
  if (!(req.headers.get("content-type") || "").toLowerCase().includes("application/json")) return response(415, { error: "content_type" }, origin);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 4096) return response(413, { error: "too_large" }, origin);
  let payload: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return response(413, { error: "too_large" }, origin);
    const obj: unknown = JSON.parse(raw);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw Error("invalid");
    payload = obj as Record<string, unknown>;
  } catch { return response(400, { error: "invalid_json" }, origin); }

  const allowedFields = new Set(["event_id", "visitor_id", "session_id", "event_name", "step_id", "step_index", "utm_source", "utm_medium", "utm_campaign", "utm_content", "device_type", "metadata"]);
  if (Object.keys(payload).some((key) => !allowedFields.has(key))) return response(400, { error: "unexpected_field" }, origin);
  if (typeof payload.event_id !== "string" || !UUID.test(payload.event_id) ||
      typeof payload.visitor_id !== "string" || !TOKEN.test(payload.visitor_id) ||
      typeof payload.session_id !== "string" || !TOKEN.test(payload.session_id) ||
      !EVENTS.has(String(payload.event_name))) return response(400, { error: "invalid_event" }, origin);

  const stepId = optionalText(payload.step_id, 64);
  const utmSource = optionalText(payload.utm_source, 120);
  const utmMedium = optionalText(payload.utm_medium, 120);
  const utmCampaign = optionalText(payload.utm_campaign, 160);
  const utmContent = optionalText(payload.utm_content, 160);
  const stepIndex = payload.step_index == null ? null : payload.step_index;
  const device = payload.device_type ?? "unknown";
  if ([stepId, utmSource, utmMedium, utmCampaign, utmContent].includes(undefined) ||
      (stepIndex !== null && (!Number.isInteger(stepIndex) || (stepIndex as number) < 0 || (stepIndex as number) > 100)) ||
      !DEVICE.has(String(device))) return response(400, { error: "invalid_property" }, origin);

  const metadata = payload.metadata ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      Object.keys(metadata).some((key) => !ALLOWED_META.has(key)) ||
      Object.values(metadata).some((v) => typeof v !== "string" || v.length > 60)) {
    return response(400, { error: "invalid_metadata" }, origin);
  }
  // Browser-supplied visitor identifiers and Origin can be spoofed. Rate-limits are
  // abuse mitigation, not proof of authenticity. Do not treat events as payments.
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rateKey = await hash(pepper + ":" + ip + ":" + payload.visitor_id);
  const client = createClient(dbUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc("ingest_funnel_event", {
    p_event_id: payload.event_id, p_visitor_id: payload.visitor_id, p_session_id: payload.session_id,
    p_event_name: payload.event_name, p_step_id: stepId, p_step_index: stepIndex,
    p_utm_source: utmSource, p_utm_medium: utmMedium,
    p_utm_campaign: utmCampaign, p_utm_content: utmContent,
    p_device_type: device, p_metadata: metadata, p_rate_key: rateKey,
  });
  if (error) {
    console.error("analytics_ingestion_error", error.code);
    return response(500, { error: "ingestion_failed" }, origin);
  }
  if (data === "rate_limited") return response(429, { error: data }, origin);
  if (data === "invalid") return response(400, { error: data }, origin);
  return response(data === "created" ? 201 : 200, { status: data }, origin);
});
